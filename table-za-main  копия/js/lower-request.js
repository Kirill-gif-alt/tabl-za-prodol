// Вкладка «Запрос на понижение» (только администратор). В «Управлении продажами» администратор отмечает рейсы галочкой —
// они попадают сюда, сгруппированные по направлениям. Цифры считаются сами (загрузка, дни до вылета, тариф сейчас,
// ожидаемая и аналогичные дни с отклонениями); «Просим согласовать» (места и тариф) и любую ячейку можно править.
// Таблицу можно скопировать (в письмо) или выгрузить в Excel. Хранится в shared/lower-requests.json — одна на всех администраторов.
window.LowerRequest = (function () {
    const FILE = 'lower-requests.json';
    const WD = ['ВС', 'ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ'];
    const COLS = [['n', '№'], ['date', 'Дата'], ['load', 'Загрузка'], ['dtd', 'Дней до вылета'], ['fare', 'Тариф сейчас'], ['avg', 'Средний тариф'], ['exp', 'Ожидаемая (откл.)'], ['sim', 'Аналогичные дни (откл.)'], ['ask', 'Просим согласовать']];

    let store = { version: 1, items: {} };
    let loaded = false;
    let host = null;

    function esc(v) { return typeof escHtml === 'function' ? escHtml(v) : String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
    function canUse() { return typeof ProfileAuth !== 'undefined' && !!ProfileAuth.canAccessTab('lowreq'); }
    function keyOf(code, date) { return `${code}|${date}`; }
    function toast(m, t) { if (typeof showToast === 'function') showToast(m, t); }
    const fmtN = (n) => (n == null ? '—' : Math.round(n).toLocaleString('ru-RU'));
    const sgn = (d) => (d > 0 ? `+${d}` : (d < 0 ? `−${Math.abs(d)}` : '0'));

    function placesWord(n) {
        const a = n % 10, b = n % 100;
        return a === 1 && b !== 11 ? 'место' : (a >= 2 && a <= 4 && (b < 12 || b > 14) ? 'места' : 'мест');
    }

    // ---------- хранение ----------

    // Возвращает true, если содержимое списка изменилось.
    async function load() {
        if (typeof SharedStorage === 'undefined') { loaded = true; return false; }
        const before = JSON.stringify(store.items);
        const r = await SharedStorage.readJsonFileStrict(FILE).catch(() => ({ ok: false }));
        if (r.ok && r.data && typeof r.data === 'object' && r.data.items && typeof r.data.items === 'object') store = { version: 1, items: { ...r.data.items, ...unsynced } };
        loaded = true;
        rowsMemo = null;
        return JSON.stringify(store.items) !== before;
    }

    // Отметки, которые не удалось записать в общий файл: остаются в списке, пока запись не пройдёт.
    const unsynced = {};

    // Записи идут строго по очереди: иначе две быстрые правки читают один и тот же файл и затирают друг друга.
    let saveChain = Promise.resolve();
    let pending = 0;
    function save(mutate) {
        pending++;
        const run = saveChain.then(() => saveNow(mutate), () => saveNow(mutate)).finally(() => { pending--; });
        saveChain = run.catch(() => {});
        return run;
    }

    async function saveNow(mutate) {
        // Свежая копия файла перед записью: правки другого администратора не теряются.
        // Если за этой записью уже стоят другие правки, читать файл рано: свежую копию возьмёт последняя из них.
        if (typeof SharedStorage !== 'undefined' && pending <= 1) {
            const r = await SharedStorage.readJsonFileStrict(FILE).catch(() => ({ ok: false }));
            if (r.ok && r.data && r.data.items) store = { version: 1, items: r.data.items };
        }
        mutate(store.items);
        rowsMemo = null;
        Object.keys(unsynced).forEach(k => { if (!(k in store.items)) store.items[k] = unsynced[k]; });
        const by = (typeof ProfileAuth !== 'undefined' && (ProfileAuth.getCurrentProfile() || {}).name) || '';
        const ok = typeof SharedStorage !== 'undefined' ? await SharedStorage.writeJsonFile(FILE, { version: 1, updatedAt: new Date().toISOString(), by, items: store.items }) : false;
        Object.keys(unsynced).forEach(k => delete unsynced[k]);
        if (!ok) {
            Object.keys(store.items).forEach(k => { unsynced[k] = store.items[k]; });
            toast('Запрос сохранён только здесь: нет доступа к общей папке', 'error');
        }
        return ok;
    }

    function has(code, date) {
        const it = store.items[keyOf(code, date)];
        return !!(it && !it.deleted);
    }

    async function toggle(code, date, on) {
        if (!canUse()) return false;
        const key = keyOf(code, date);
        const at = new Date().toISOString();
        const apply = items => {
            if (on) items[key] = { ...(items[key] && !items[key].deleted ? items[key] : {}), code, date, at };
            else delete items[key];
        };
        apply(store.items);   // список меняется сразу, запись в общий файл идёт следом
        rowsMemo = null;
        if (host && !host.hidden) render();
        return save(apply);
    }

    // ---------- цифры по вылету ----------

    function dirOf(code) {
        const d = typeof getFlightDirection === 'function' ? String(getFlightDirection(typeof getBaseFlight === 'function' ? getBaseFlight(code) : code) || '') : '';
        return d.replace(/\s*[—–-]\s*/g, ' – ').replace(/\s+/g, ' ').trim() || code;
    }

    // Порядок: пары «туда — обратно» рядом (101, 102; 301, 302), нечётный раньше чётного.
    function orderOf(code) {
        const m = String(code || '').match(/(\d+)\s*$/);
        if (!m) return [1e9, 0, 0];
        const n = Number(m[1]);
        return [Math.floor(((n % 100) + 1) / 2), Math.floor(n / 100), n % 2 ? 0 : 1];
    }

    function ladderOf(code, date) {
        try { return typeof FareGrid !== 'undefined' ? FareGrid.ladderFor(code, date) : []; } catch (e) { return []; }
    }

    // Расчёт строки тяжёлый (нормы, лестница тарифов, цена): считаем один раз, пока не изменились данные и день.
    const autoCache = new Map();
    let autoSig = '';
    function dataSig() {
        const rev = (typeof analyticsRevision === 'function' ? analyticsRevision() : 0) + '|' + (typeof SalesArchive !== 'undefined' ? SalesArchive.revision() : 0);
        return `${rev}|${new Date().toDateString()}`;
    }
    function autoOf(code, date) {
        const sig = dataSig();
        if (sig !== autoSig) { autoCache.clear(); autoSig = sig; rowsMemo = null; }
        const k = keyOf(code, date);
        let v = autoCache.get(k);
        if (!v) { v = computeAuto(code, date); autoCache.set(k, v); }
        return v;
    }

    function computeAuto(code, date) {
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
        let avg = null;
        try {
            const base = typeof getBaseFlight === 'function' ? getBaseFlight(code) : code;
            const row = typeof getFlightRowForDate === 'function' ? getFlightRowForDate(base, date, code) : null;
            const m = row && typeof getRowMetrics === 'function' ? getRowMetrics(row, base) : null;
            if (m && m.avg && (typeof hasSalesFileLoaded !== 'function' || hasSalesFileLoaded())) avg = m.avg;
        } catch (e) { avg = null; }
        const sold = n ? n.sold : null;
        const seats = n ? n.seats : null;
        return {
            date: ds,
            load: n && seats ? `${sold}/${seats} (${Math.round(sold / seats * 100)}%)` : '—',
            dtd: n && n.dtd != null ? String(n.dtd) : '—',
            fare: price != null ? fmtN(price) : '—',
            fareCls: cls,
            avg: avg != null ? fmtN(avg) : '—',
            exp: n && n.exp != null ? `${n.exp} (${sgn(sold - n.exp)})` : '—',
            sim: n && n.ref != null ? `${n.ref} (${sgn(sold - n.ref)})` : '—',
            ladder, dtdNum: n ? n.dtd : null
        };
    }

    // Просьбы по подклассам: [{ places, cls }, …]. Старые записи (places/cls у самого рейса) читаются как одна просьба.
    function asksOf(it) {
        if (Array.isArray(it.asks)) return it.asks;
        return it.places != null || it.cls ? [{ places: it.places, cls: it.cls || '' }] : [];
    }

    function askText(it, auto) {
        const parts = asksOf(it).filter(a => Number(a.places) > 0).map(a => {
            const p = Number(a.places);
            const l = auto.ladder.find(x => x.cls === a.cls);
            return `${p} ${placesWord(p)}${a.cls ? `, тариф ${a.cls}${l ? ` (${fmtN(l.price)})` : ''}` : ''}`;
        });
        return parts.join(' и ');
    }

    let rowsMemo = null;
    function rowsOf() {
        if (rowsMemo) return rowsMemo;
        const out = [];
        Object.keys(store.items).forEach(k => {
            const it = store.items[k];
            if (!it || it.deleted) return;
            const auto = autoOf(it.code, it.date);
            if (auto.dtdNum != null && auto.dtdNum < 1) return;   // улетевшие и сегодняшние не показываем
            const d = typeof parseLocalDate === 'function' ? parseLocalDate(it.date) : null;
            out.push({ key: k, it, auto, dir: dirOf(it.code), ord: orderOf(it.code), ts: d ? d.getTime() : 0 });
        });
        out.sort((a, b) => a.ord[0] - b.ord[0] || a.ord[1] - b.ord[1] || a.ord[2] - b.ord[2] || a.dir.localeCompare(b.dir, 'ru') || a.ts - b.ts);
        rowsMemo = out;
        return out;
    }

    function cellVal(row, col) {
        const o = row.it.over && row.it.over[col];
        if (o != null) return o;
        if (col === 'n') return row.n;
        if (col === 'ask') return askText(row.it, row.auto);
        return row.auto[col];
    }

    // ---------- отображение ----------

    // Одна таблица на все направления: нумерация сквозная.
    function numbered(rows) {
        rows.forEach((r, i) => { r.n = i + 1; });
        return rows;
    }

    // Маршруты идут подряд (строки уже отсортированы): каждому — своя плашка над строками.
    function groupsOf(rows) {
        const g = [];
        rows.forEach(r => { const last = g[g.length - 1]; if (last && last.dir === r.dir) last.rows.push(r); else g.push({ dir: r.dir, rows: [r] }); });
        return g;
    }

    function rowHtml(r) {
        const over = r.it.over || {};
        const cell = (col) => `<td><input class="lr-in${over[col] != null ? ' lr-over' : ''}" data-lr-cell="${col}" data-lr-key="${esc(r.key)}" value="${esc(cellVal(r, col))}"></td>`;
        const clsOpts = (sel) => ['<option value="">—</option>'].concat(r.auto.ladder.map(l => `<option value="${esc(l.cls)}"${sel === l.cls ? ' selected' : ''}>${esc(l.cls)} (${fmtN(l.price)})</option>`)).join('');
        const asks = asksOf(r.it);
        const askRows = (asks.length ? asks : [{ places: null, cls: '' }]).map((a, i) => `<span class="lr-ask-ctl"><input type="number" min="0" step="1" class="lr-num" data-lr-places="${esc(r.key)}" data-i="${i}" value="${a.places != null ? esc(a.places) : ''}" placeholder="мест"> <select class="lr-sel" data-lr-cls="${esc(r.key)}" data-i="${i}" title="Тариф (подкласс), о котором просим">${clsOpts(a.cls)}</select>${i > 0 ? ` <button type="button" class="lr-del2" data-lr-askdel="${esc(r.key)}" data-i="${i}" title="Убрать этот подкласс">✕</button>` : ''}</span>`).join('');
        return `<tr data-lr-row="${esc(r.key)}">
            <td class="lr-n">${r.n}</td>
            <td class="lr-first"><button type="button" class="lr-del" data-lr-del="${esc(r.key)}" title="Убрать из запроса">✕</button>
                <input class="lr-in${over.date != null ? ' lr-over' : ''}" data-lr-cell="date" data-lr-key="${esc(r.key)}" value="${esc(cellVal(r, 'date'))}"></td>
            ${cell('load')}${cell('dtd')}${cell('fare')}${cell('avg')}${cell('exp')}${cell('sim')}
            <td class="lr-ask">${askRows}<button type="button" class="lr-add" data-lr-askadd="${esc(r.key)}" title="Просить места ещё по одному подклассу">＋ ещё подкласс</button>
                <input class="lr-in${over.ask != null ? ' lr-over' : ''}" data-lr-cell="ask" data-lr-key="${esc(r.key)}" value="${esc(cellVal(r, 'ask'))}" placeholder="текст вручную"></td>
        </tr>`;
    }

    function render() {
        if (!host) return;
        if (!canUse()) { host.innerHTML = '<p class="rp-note">Нет доступа к этой вкладке.</p>'; return; }
        if (!loaded) { host.innerHTML = '<p class="rp-note">Загружаю…</p>'; load().then(render); return; }
        const rows = rowsOf();
        numbered(rows);
        const hidden = Object.values(store.items).filter(it => it && !it.deleted).length - rows.length;
        host.innerHTML = `
            <section class="rp-card lr-card">
                <div class="rp-card-head"><h3 class="rp-card-title">Запрос на понижение</h3>
                    <span class="lr-actions">
                        <button type="button" class="filter-btn" data-lr-copy ${rows.length ? '' : 'disabled'}>Скопировать для письма</button>
                        <button type="button" class="filter-btn" data-lr-xlsx ${rows.length ? '' : 'disabled'}>В Excel</button>
                        <button type="button" class="filter-btn rp-danger" data-lr-clear ${rows.length ? '' : 'disabled'}>Очистить</button>
                    </span></div>
                <p class="rp-card-text">Рейсы сюда попадают из «Управления продажами»: отметьте галочкой слева от номера рейса. Цифры считаются сами,
                    места и тариф впишите сами; любую ячейку можно поправить (исправленные выделены, пустая ячейка возвращает расчёт).
                    ${hidden > 0 ? `<span class="rp-muted">Улетевших и сегодняшних вылетов в списке не показано: ${hidden}.</span>` : ''}</p>
                ${rows.length ? `<div class="rp-scroll"><table class="rp-table lr-table"><thead><tr>${COLS.map(c => `<th>${esc(c[1])}</th>`).join('')}</tr></thead>
                    <tbody>${groupsOf(rows).map(g => `<tr class="lr-grp-head"><td colspan="${COLS.length}">${esc(g.dir)} <span class="lr-grp-n">· вылетов: ${g.rows.length}</span></td></tr>${g.rows.map(rowHtml).join('')}`).join('')}</tbody></table></div>` : '<p class="rp-note">Пока нет рейсов. Откройте «Управление продажами» и отметьте нужные вылеты галочкой у номера рейса.</p>'}
            </section>`;
    }

    // Правка рейса применяется сразу: перерисовывается одна строка, запись в файл идёт в фоне.
    function patch(key, fn) {
        const apply = items => { const it = items[key]; if (it && !it.deleted) { fn(it); it.at = new Date().toISOString(); } };
        apply(store.items);
        rowsMemo = null;
        renderRow(key);
        return save(apply);
    }

    function renderRow(key) {
        const act = document.activeElement;
        if (host && act && host.contains(act) && typeof act.blur === 'function') act.blur();   // снятие фокуса может само вызвать правку этой строки
        const tr = host && [...host.querySelectorAll('tr[data-lr-row]')].find(x => x.dataset.lrRow === key);
        const row = rowsOf().find(r => r.key === key);
        if (!tr || !row) { render(); return; }
        row.n = Number(tr.querySelector('.lr-n')?.textContent) || 1;
        const box = document.createElement('tbody');
        box.innerHTML = rowHtml(row);
        if (tr.isConnected) tr.replaceWith(box.firstElementChild);
    }

    // Копия просьб вылета, дополненная пустыми до индекса i включительно.
    function asksCopy(it, i) {
        const a = asksOf(it).map(x => ({ ...x }));
        while (a.length <= i) a.push({ places: null, cls: '' });
        return a;
    }

    function setAsks(it, a) {
        it.asks = a;
        delete it.places; delete it.cls;
        if (it.over) delete it.over.ask;   // место и тариф поменялись — текст собирается заново
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
            });
        } else if (t.dataset.lrPlaces != null) {
            const i = Number(t.dataset.i) || 0;
            patch(t.dataset.lrPlaces, it => { const a = asksCopy(it, i); a[i].places = t.value === '' ? null : Math.max(0, parseInt(t.value, 10) || 0); setAsks(it, a); });
        } else if (t.dataset.lrCls != null) {
            const i = Number(t.dataset.i) || 0;
            patch(t.dataset.lrCls, it => { const a = asksCopy(it, i); a[i].cls = t.value; setAsks(it, a); });
        }
    }

    // Текст и HTML для письма: одна таблица, маршрут — плашкой над своими строками.
    function tablesFor(rows) {
        numbered(rows);
        const groups = groupsOf(rows);
        const text = `${COLS.map(c => c[1]).join('\t')}\n${groups.map(g => `${g.dir}\n${g.rows.map(r => COLS.map(c => cellVal(r, c[0])).join('\t')).join('\n')}`).join('\n')}`;
        const css = 'border:1px solid #d0d5dd;border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px';
        const tdc = 'border:1px solid #d0d5dd;padding:6px 10px;vertical-align:top';
        const band = `${tdc};background:#1e3a5f;color:#ffffff;font-weight:bold;border-top:3px solid #0f172a`;
        const html = `<table style="${css}"><thead><tr>${COLS.map(c => `<th style="${tdc};background:#f2f4f7;text-align:left">${esc(c[1])}</th>`).join('')}</tr></thead>
            <tbody>${groups.map(g => `<tr><td colspan="${COLS.length}" style="${band}">${esc(g.dir)}</td></tr>${g.rows.map(r => `<tr>${COLS.map(c => `<td style="${tdc}">${esc(cellVal(r, c[0]))}</td>`).join('')}</tr>`).join('')}`).join('')}</tbody></table>`;
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
        const aoa = [COLS.map(c => c[1])];
        groupsOf(numbered(rowsOf())).forEach(g => {
            aoa.push([g.dir]);
            g.rows.forEach(r => aoa.push(COLS.map(c => cellVal(r, c[0]))));
        });
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        ws['!cols'] = [{ wch: 5 }, { wch: 14 }, { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 20 }, { wch: 24 }, { wch: 40 }];
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
            const add = e.target.closest('[data-lr-askadd]');
            if (add) { patch(add.dataset.lrAskadd, it => { const a = asksOf(it).map(x => ({ ...x })); if (!a.length) a.push({ places: null, cls: '' }); a.push({ places: null, cls: '' }); setAsks(it, a); });
                return; }
            const adel = e.target.closest('[data-lr-askdel]');
            if (adel) { patch(adel.dataset.lrAskdel, it => { const a = asksOf(it).map(x => ({ ...x })); a.splice(Number(adel.dataset.i), 1); setAsks(it, a); });
                return; }
            const del = e.target.closest('[data-lr-del]');
            if (del) { const [c, d] = del.dataset.lrDel.split('|'); toggle(c, d, false); return; }
            if (e.target.closest('[data-lr-copy]')) { copy(); return; }
            if (e.target.closest('[data-lr-xlsx]')) { exportXlsx().catch(err => { console.error(err); toast('Ошибка выгрузки', 'error'); }); return; }
            if (e.target.closest('[data-lr-clear]')) {
                if (!window.confirm('Убрать все рейсы из запроса на понижение?')) return;
                const wipe = items => { Object.keys(items).forEach(k => delete items[k]); };
                wipe(store.items); rowsMemo = null; render(); save(wipe);
            }
        });
        render();
    }

    function refresh() { if (host && loaded) load().then(changed => { if (changed && !host.hidden) render(); }); }

    // Отметки подгружаются заранее, чтобы галочки в «Управлении продажами» стояли сразу.
    function ensureLoaded() { return loaded ? Promise.resolve() : load(); }

    return { createView, refresh, toggle, has, ensureLoaded, canUse };
})();
