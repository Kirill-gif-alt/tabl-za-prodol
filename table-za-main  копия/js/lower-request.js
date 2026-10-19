// Вкладка «Запрос на понижение» (только администратор). В «Управлении продажами» администратор отмечает рейсы галочкой —
// они попадают сюда, сгруппированные по направлениям. Цифры считаются сами (загрузка, дни до вылета, тариф сейчас,
// ожидаемая и аналогичные дни с отклонениями); «Просим согласовать» (места и тариф) и любую ячейку можно править.
// Таблицу можно скопировать (в письмо) или выгрузить в Excel. Хранится в shared/lower-requests.json — одна на всех администраторов.
window.LowerRequest = (function () {
    const FILE = 'lower-requests.json';
    const WD = ['ВС', 'ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ'];
    const COLS = [['date', 'Дата'], ['load', 'Загрузка'], ['dtd', 'Дней до вылета'], ['fare', 'Тариф сейчас'], ['exp', 'Ожидаемая (откл.)'], ['sim', 'Аналогичные дни (откл.)'], ['ask', 'Просим согласовать']];

    let store = { version: 1, items: {} };
    let loaded = false;
    let host = null;

    function esc(v) { return typeof escHtml === 'function' ? escHtml(v) : String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
    function isAdmin() { return typeof ProfileAuth !== 'undefined' && !!(ProfileAuth.getCurrentProfile() || {}).isAdmin; }
    function keyOf(code, date) { return `${code}|${date}`; }
    function toast(m, t) { if (typeof showToast === 'function') showToast(m, t); }
    const fmtN = (n) => (n == null ? '—' : Math.round(n).toLocaleString('ru-RU'));
    const sgn = (d) => (d > 0 ? `+${d}` : (d < 0 ? `−${Math.abs(d)}` : '0'));

    function placesWord(n) {
        const a = n % 10, b = n % 100;
        return a === 1 && b !== 11 ? 'место' : (a >= 2 && a <= 4 && (b < 12 || b > 14) ? 'места' : 'мест');
    }

    // ---------- хранение ----------

    async function load() {
        if (typeof SharedStorage === 'undefined') { loaded = true; return; }
        const r = await SharedStorage.readJsonFileStrict(FILE).catch(() => ({ ok: false }));
        if (r.ok && r.data && typeof r.data === 'object' && r.data.items && typeof r.data.items === 'object') store = { version: 1, items: r.data.items };
        loaded = true;
    }

    async function save(mutate) {
        // Свежая копия файла перед записью: правки другого администратора не теряются.
        if (typeof SharedStorage !== 'undefined') {
            const r = await SharedStorage.readJsonFileStrict(FILE).catch(() => ({ ok: false }));
            if (r.ok && r.data && r.data.items) store = { version: 1, items: r.data.items };
        }
        mutate(store.items);
        const by = (typeof ProfileAuth !== 'undefined' && (ProfileAuth.getCurrentProfile() || {}).name) || '';
        const ok = typeof SharedStorage !== 'undefined' ? await SharedStorage.writeJsonFile(FILE, { version: 1, updatedAt: new Date().toISOString(), by, items: store.items }) : false;
        if (!ok) toast('Запрос сохранён только здесь: нет доступа к общей папке', 'error');
        return ok;
    }

    function has(code, date) {
        const it = store.items[keyOf(code, date)];
        return !!(it && !it.deleted);
    }

    async function toggle(code, date, on) {
        if (!isAdmin()) return false;
        const key = keyOf(code, date);
        const at = new Date().toISOString();
        await save(items => {
            if (on) items[key] = { ...(items[key] && !items[key].deleted ? items[key] : {}), code, date, at };
            else delete items[key];
        });
        if (host && !host.hidden) render();
        return true;
    }

    // ---------- цифры по вылету ----------

    function dirOf(code) {
        const d = typeof getFlightDirection === 'function' ? String(getFlightDirection(typeof getBaseFlight === 'function' ? getBaseFlight(code) : code) || '') : '';
        return d.replace(/\s*[—–-]\s*/g, ' – ').replace(/\s+/g, ' ').trim() || code;
    }

    function ladderOf(code, date) {
        try { return typeof FareGrid !== 'undefined' ? FareGrid.ladderFor(code, date) : []; } catch (e) { return []; }
    }

    // Автоматические значения строки.
    function autoOf(code, date) {
        const n = typeof SalesAdvice !== 'undefined' ? SalesAdvice.norms(code, date) : null;
        const ladder = ladderOf(code, date);
        let open = null;
        try { open = typeof PriceAdvisor !== 'undefined' ? PriceAdvisor.currentPrice(code, date) : null; } catch (e) { open = null; }
        let price = null;
        let cls = open ? open.cls : '';
        if (open) {
            const idx = (open.classes || [open.cls]).map(c => ladder.findIndex(l => l.cls === c)).filter(i => i >= 0);
            if (idx.length) { const l = ladder[Math.max(...idx)]; price = l.price; cls = l.cls; } else price = open.price;
        }
        const d = typeof parseLocalDate === 'function' ? parseLocalDate(date) : null;
        const ds = d ? `${date.slice(0, 6)}${date.slice(8)} ${WD[d.getDay()]}` : date;
        const sold = n ? n.sold : null;
        const seats = n ? n.seats : null;
        return {
            date: ds,
            load: n && seats ? `${sold}/${seats} (${Math.round(sold / seats * 100)}%)` : '—',
            dtd: n && n.dtd != null ? String(n.dtd) : '—',
            fare: price != null ? fmtN(price) : '—',
            fareCls: cls,
            exp: n && n.exp != null ? `${n.exp} (${sgn(sold - n.exp)})` : '—',
            sim: n && n.ref != null ? `${n.ref} (${sgn(sold - n.ref)})` : '—',
            ladder, dtdNum: n ? n.dtd : null
        };
    }

    function askText(it, auto) {
        const p = Number(it.places);
        if (!(p > 0)) return '';
        const l = auto.ladder.find(x => x.cls === it.cls);
        return `${p} ${placesWord(p)}${it.cls ? `, тариф ${it.cls}${l ? ` (${fmtN(l.price)})` : ''}` : ''}`;
    }

    function rowsOf() {
        const out = [];
        Object.keys(store.items).forEach(k => {
            const it = store.items[k];
            if (!it || it.deleted) return;
            const auto = autoOf(it.code, it.date);
            if (auto.dtdNum != null && auto.dtdNum < 1) return;   // улетевшие и сегодняшние не показываем
            const d = typeof parseLocalDate === 'function' ? parseLocalDate(it.date) : null;
            out.push({ key: k, it, auto, dir: dirOf(it.code), ts: d ? d.getTime() : 0 });
        });
        out.sort((a, b) => a.dir.localeCompare(b.dir, 'ru') || a.ts - b.ts);
        return out;
    }

    function cellVal(row, col) {
        const o = row.it.over && row.it.over[col];
        if (o != null) return o;
        if (col === 'ask') return askText(row.it, row.auto);
        return row.auto[col];
    }

    // ---------- отображение ----------

    function groupsOf(rows) {
        const g = [];
        rows.forEach(r => { let x = g.find(y => y.dir === r.dir); if (!x) { x = { dir: r.dir, rows: [] }; g.push(x); } x.rows.push(r); });
        return g;
    }

    function rowHtml(r) {
        const over = r.it.over || {};
        const cell = (col) => `<td><input class="lr-in${over[col] != null ? ' lr-over' : ''}" data-lr-cell="${col}" data-lr-key="${esc(r.key)}" value="${esc(cellVal(r, col))}"></td>`;
        const clsOpts = ['<option value="">—</option>'].concat(r.auto.ladder.map(l => `<option value="${esc(l.cls)}"${r.it.cls === l.cls ? ' selected' : ''}>${esc(l.cls)} (${fmtN(l.price)})</option>`)).join('');
        return `<tr data-lr-row="${esc(r.key)}">
            <td class="lr-first"><button type="button" class="lr-del" data-lr-del="${esc(r.key)}" title="Убрать из запроса">✕</button>
                <input class="lr-in${over.date != null ? ' lr-over' : ''}" data-lr-cell="date" data-lr-key="${esc(r.key)}" value="${esc(cellVal(r, 'date'))}"><div class="lr-code">${esc(r.it.code)}</div></td>
            ${cell('load')}${cell('dtd')}${cell('fare')}${cell('exp')}${cell('sim')}
            <td class="lr-ask"><span class="lr-ask-ctl"><input type="number" min="0" step="1" class="lr-num" data-lr-places="${esc(r.key)}" value="${r.it.places != null ? esc(r.it.places) : ''}" placeholder="мест"> <select class="lr-sel" data-lr-cls="${esc(r.key)}" title="Тариф, о котором просим">${clsOpts}</select></span>
                <input class="lr-in${over.ask != null ? ' lr-over' : ''}" data-lr-cell="ask" data-lr-key="${esc(r.key)}" value="${esc(cellVal(r, 'ask'))}" placeholder="текст вручную"></td>
        </tr>`;
    }

    function render() {
        if (!host) return;
        if (!isAdmin()) { host.innerHTML = '<p class="rp-note">Вкладка доступна только администратору.</p>'; return; }
        if (!loaded) { host.innerHTML = '<p class="rp-note">Загружаю…</p>'; load().then(render); return; }
        const rows = rowsOf();
        const groups = groupsOf(rows);
        const hidden = Object.values(store.items).filter(it => it && !it.deleted).length - rows.length;
        host.innerHTML = `
            <section class="rp-card lr-card">
                <div class="rp-card-head"><h3 class="rp-card-title">Запрос на понижение</h3>
                    <span class="lr-actions">
                        <button type="button" class="filter-btn" data-lr-copy ${rows.length ? '' : 'disabled'}>Скопировать для письма</button>
                        <button type="button" class="filter-btn" data-lr-xlsx ${rows.length ? '' : 'disabled'}>Выгрузить в Excel</button>
                        <button type="button" class="filter-btn rp-danger" data-lr-clear ${rows.length ? '' : 'disabled'}>Очистить</button>
                    </span></div>
                <p class="rp-card-text">Рейсы сюда попадают из «Управления продажами»: отметьте галочкой слева от номера рейса. Цифры считаются сами,
                    места и тариф впишите сами; любую ячейку можно поправить (исправленные выделены, пустая ячейка возвращает расчёт).
                    ${hidden > 0 ? `<span class="rp-muted">Улетевших и сегодняшних вылетов в списке не показано: ${hidden}.</span>` : ''}</p>
                ${groups.length ? groups.map(g => `<div class="lr-group"><h4 class="lr-dir">${esc(g.dir)}</h4>
                    <div class="rp-scroll"><table class="rp-table lr-table"><thead><tr>${COLS.map(c => `<th>${esc(c[1])}</th>`).join('')}</tr></thead>
                    <tbody>${g.rows.map(rowHtml).join('')}</tbody></table></div></div>`).join('') : '<p class="rp-note">Пока нет рейсов. Откройте «Управление продажами» и отметьте нужные вылеты галочкой у номера рейса.</p>'}
            </section>`;
    }

    function patch(key, fn) {
        return save(items => { const it = items[key]; if (it && !it.deleted) { fn(it); it.at = new Date().toISOString(); } });
    }

    function onChange(e) {
        const t = e.target;
        if (t.dataset.lrCell) {
            const key = t.dataset.lrKey;
            const col = t.dataset.lrCell;
            const row = rowsOf().find(r => r.key === key);
            if (!row) return;
            const v = t.value.trim();
            const auto = col === 'ask' ? askText(row.it, row.auto) : String(row.auto[col]);
            patch(key, it => {
                it.over = it.over || {};
                if (!v || v === auto) delete it.over[col]; else it.over[col] = v;
                if (!Object.keys(it.over).length) delete it.over;
            }).then(render);
        } else if (t.dataset.lrPlaces != null) {
            patch(t.dataset.lrPlaces, it => { it.places = t.value === '' ? null : Math.max(0, parseInt(t.value, 10) || 0); if (it.over) delete it.over.ask; }).then(render);
        } else if (t.dataset.lrCls != null) {
            patch(t.dataset.lrCls, it => { it.cls = t.value; if (it.over) delete it.over.ask; }).then(render);
        }
    }

    // Текст и HTML для письма: заголовок направления и таблица, как в образце.
    function tablesFor(rows) {
        const groups = groupsOf(rows);
        const text = groups.map(g => `${g.dir}\n${COLS.map(c => c[1]).join('\t')}\n${g.rows.map(r => COLS.map(c => cellVal(r, c[0])).join('\t')).join('\n')}`).join('\n\n');
        const css = 'border:1px solid #d0d5dd;border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px';
        const tdc = 'border:1px solid #d0d5dd;padding:6px 10px;vertical-align:top';
        const html = groups.map(g => `<p style="font-family:Arial,sans-serif;font-weight:bold;margin:14px 0 6px">${esc(g.dir)}</p>
            <table style="${css}"><thead><tr>${COLS.map(c => `<th style="${tdc};background:#f2f4f7;text-align:left">${esc(c[1])}</th>`).join('')}</tr></thead>
            <tbody>${g.rows.map(r => `<tr>${COLS.map(c => `<td style="${tdc}">${esc(cellVal(r, c[0]))}</td>`).join('')}</tr>`).join('')}</tbody></table>`).join('');
        return { text, html };
    }

    async function copy() {
        const { text, html } = tablesFor(rowsOf());
        try {
            if (navigator.clipboard && window.ClipboardItem) {
                await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]);
            } else {
                await navigator.clipboard.writeText(text);
            }
            toast('Таблицы скопированы — вставьте в письмо');
        } catch (e) {
            console.warn(e);
            toast('Не удалось скопировать: разрешите доступ к буферу обмена', 'error');
        }
    }

    async function exportXlsx() {
        if (typeof loadPlainXlsx !== 'function' || !(await loadPlainXlsx())) { toast('Библиотека Excel не загружена', 'error'); return; }
        const aoa = [];
        groupsOf(rowsOf()).forEach(g => {
            aoa.push([g.dir]);
            aoa.push(COLS.map(c => c[1]));
            g.rows.forEach(r => aoa.push(COLS.map(c => cellVal(r, c[0]))));
            aoa.push([]);
        });
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        ws['!cols'] = [{ wch: 14 }, { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 20 }, { wch: 24 }, { wch: 28 }];
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Запрос на понижение');
        const d = new Date();
        XLSX.writeFile(wb, `Запрос на понижение_${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}.xlsx`);
        if (typeof ActivityLog !== 'undefined') ActivityLog.log('export', 'Запрос на понижение');
    }

    function createView(panel) {
        host = panel;
        panel.classList.add('lr-panel');
        panel.addEventListener('change', onChange);
        panel.addEventListener('click', (e) => {
            const del = e.target.closest('[data-lr-del]');
            if (del) { const [c, d] = del.dataset.lrDel.split('|'); toggle(c, d, false); return; }
            if (e.target.closest('[data-lr-copy]')) { copy(); return; }
            if (e.target.closest('[data-lr-xlsx]')) { exportXlsx().catch(err => { console.error(err); toast('Ошибка выгрузки', 'error'); }); return; }
            if (e.target.closest('[data-lr-clear]')) {
                if (!window.confirm('Убрать все рейсы из запроса на понижение?')) return;
                save(items => { Object.keys(items).forEach(k => delete items[k]); }).then(render);
            }
        });
        render();
    }

    function refresh() { if (host) render(); }

    // Отметки подгружаются заранее, чтобы галочки в «Управлении продажами» стояли сразу.
    function ensureLoaded() { return loaded ? Promise.resolve() : load(); }

    return { createView, refresh, toggle, has, ensureLoaded, isAdmin };
})();
