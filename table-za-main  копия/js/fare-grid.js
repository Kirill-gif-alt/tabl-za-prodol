// Сетка тарифов направления («Отчёты» → «Справочник» → «Сетка тарифов»).
// Код тарифа: первая буква — класс бронирования, дальше — семейство и условия: VLHOW = класс V, семейство LH, OW.
// У одного класса бывает несколько семейств с разной ценой: лайт (LH) дешевле стандарта (ST), оптимум (OP) — дороже.
// Цена класса для ценового советника — самое дешёвое из «лайт / стандарт» (что есть), оптимум — надбавка к классу.
// Сетка собирается из продаж (самый частый взрослый тариф кода), правки хранятся в shared/fare-grid.json — для всех.
window.FareGrid = (function () {
    const FILE = 'fare-grid.json';
    const FAMILY = { lite: 'Лайт', standard: 'Стандарт', optimum: 'Оптимум', other: 'Другое' };
    const AUTO_FAMILY = { LH: 'lite', LT: 'lite', ST: 'standard', OP: 'optimum' };   // по продажам: LH < ST < OP у одного класса

    let store = { version: 1, routes: {} };
    let rev = 0;
    let memo = { sig: '', grids: new Map() };

    function esc(v) { return typeof escHtml === 'function' ? escHtml(v) : String(v == null ? '' : v); }

    function canEdit() {
        if (typeof ProfileAuth === 'undefined') return true;
        const p = ProfileAuth.getCurrentProfile();
        return !!(p && p.isAdmin) || ProfileAuth.hasPermission('edit_fare_refs');
    }

    function base(code) { return typeof getBaseFlight === 'function' ? getBaseFlight(cleanFlight(code)) : cleanFlight(code); }

    function direction(code) {
        return String(typeof getFlightDirection === 'function' ? getFlightDirection(base(code)) || '' : '').replace(/\s+/g, ' ').trim() || base(code);
    }

    // Код без детских/служебных хвостов: «KSTOW/CN20» → «KSTOW», «JOPOWIDB» → «JOPOW».
    function cleanCode(b) {
        return String(b || '').toUpperCase().split('/')[0].replace(/IDB$/, '').trim();
    }

    function familyAuto(code) {
        return AUTO_FAMILY[code.slice(1, 3)] || 'other';
    }

    function isAdult(s) {
        const b = String(s.basicFareStr || '').toUpperCase();
        return (s.adjustedFare || s.fare || 0) > 0 && !/\/(CN|IN|ID|WO|DA)\d*/.test(b) && !/IDB$/.test(b.split('/')[0]);
    }

    function sig() {
        return [typeof dataEpoch === 'number' ? dataEpoch : 0, rev].join('|');
    }

    // Все направления с продажами: { dir: Set(рейсов) }.
    function directions() {
        const out = new Map();
        Object.keys(typeof groupedData !== 'undefined' && groupedData ? groupedData : {}).forEach(b => {
            (groupedData[b] || []).forEach(r => {
                const fl = cleanFlight(r[0]);
                const d = direction(fl);
                if (!out.has(d)) out.set(d, new Set());
                out.get(d).add(fl);
            });
        });
        return out;
    }

    // Сетка направления: [{ code, cls, family, fare, n, source: 'ref'|'auto', off }], по возрастанию тарифа.
    function grid(dir) {
        if (memo.sig !== sig()) memo = { sig: sig(), grids: new Map() };
        if (memo.grids.has(dir)) return memo.grids.get(dir);
        const flights = directions().get(dir) || new Set();
        const by = Object.create(null);
        Object.keys(typeof salesDetails !== 'undefined' && salesDetails ? salesDetails : {}).forEach(k => {
            if (!flights.has(k.slice(k.indexOf('|') + 1))) return;
            (salesDetails[k] || []).forEach(s => {
                if (!isAdult(s)) return;
                const code = cleanCode(s.basicFareStr);
                if (!/^[A-Z]/.test(code)) return;
                const f = Math.round(s.adjustedFare || s.fare);
                const c = by[code] || (by[code] = Object.create(null));
                c[f] = (c[f] || 0) + 1;
            });
        });
        const saved = (store.routes && store.routes[dir]) || {};
        const rows = [];
        const codes = new Set(Object.keys(by).concat(Object.keys(saved)));
        codes.forEach(code => {
            const counts = by[code] || {};
            const n = Object.values(counts).reduce((a, b) => a + b, 0);
            const auto = n ? Number(Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0]) : null;   // самый частый тариф
            const sv = saved[code] || null;
            const fare = sv && sv.fare > 0 ? sv.fare : auto;
            if (!(fare > 0)) return;
            rows.push({ code, cls: code.charAt(0), family: (sv && sv.family) || familyAuto(code), fare, autoFare: auto, n, source: sv ? 'ref' : 'auto', off: !!(sv && sv.off) });
        });
        rows.sort((a, b) => a.fare - b.fare || a.code.localeCompare(b.code));
        memo.grids.set(dir, rows);
        return rows;
    }

    // Лестница классов для советника: класс → цена (лайт, иначе стандарт, иначе самый дешёвый код класса).
    function ladderFor(code) {
        const rows = grid(direction(code)).filter(r => !r.off && r.n >= (typeof PV !== 'undefined' ? PV.PA_MIN_CLASS_TICKETS : 3) || (r.source === 'ref' && !r.off));
        const byCls = Object.create(null);
        rows.forEach(r => { (byCls[r.cls] || (byCls[r.cls] = [])).push(r); });
        const ladder = Object.keys(byCls).map(cls => {
            const list = byCls[cls];
            const pick = list.find(r => r.family === 'lite') || list.find(r => r.family === 'standard') || list.slice().sort((a, b) => a.fare - b.fare)[0];
            const opt = list.find(r => r.family === 'optimum');
            return { cls, price: pick.fare, code: pick.code, family: pick.family, optimum: opt ? opt.fare : null };
        });
        ladder.sort((a, b) => a.price - b.price);
        return ladder;
    }

    async function load() {
        if (typeof SharedStorage === 'undefined') return;
        const r = await SharedStorage.readJsonFileStrict(FILE).catch(() => ({ ok: false }));
        if (r.ok && r.data && typeof r.data === 'object') { store = { version: 1, routes: r.data.routes || {} }; rev++; }
    }

    async function saveRoute(dir, entries) {
        if (!canEdit()) return false;
        // Свежая копия файла: правки других направлений не теряются.
        const r = typeof SharedStorage !== 'undefined' ? await SharedStorage.readJsonFileStrict(FILE).catch(() => ({ ok: false })) : { ok: true, data: null };
        if (!r.ok) return false;
        const routes = (r.data && r.data.routes) || {};
        routes[dir] = entries;
        const by = typeof ProfileAuth !== 'undefined' ? (ProfileAuth.getCurrentProfile() || {}).name || '' : '';
        const ok = await SharedStorage.writeJsonFile(FILE, { version: 1, updatedAt: new Date().toISOString(), by, routes });
        if (ok) { store = { version: 1, routes }; rev++; }
        return ok;
    }

    // ---------- раздел справочника ----------
    let current = '';

    function sectionHtml() {
        const dirs = [...directions().keys()].sort((a, b) => a.localeCompare(b, 'ru'));
        if (!dirs.length) return '<p class="rp-note">Загрузите данные — сетка собирается из продаж.</p>';
        if (!current || !dirs.includes(current)) current = dirs[0];
        const rows = grid(current);
        const edit = canEdit();
        const famSel = (r) => edit ? `<select data-fg-family="${esc(r.code)}">${Object.keys(FAMILY).map(f => `<option value="${f}"${r.family === f ? ' selected' : ''}>${FAMILY[f]}</option>`).join('')}</select>` : esc(FAMILY[r.family]);
        const body = rows.map(r => `<tr${r.off ? ' class="norm-row-out"' : ''}>
            <td><strong>${esc(r.cls)}</strong></td><td>${esc(r.code)}</td><td>${famSel(r)}</td>
            <td>${edit ? `<input type="number" min="0" step="1" data-fg-fare="${esc(r.code)}" value="${r.fare}" style="width:110px">` : `${r.fare.toLocaleString('ru-RU')} ₽`}${r.autoFare != null && r.autoFare !== r.fare ? `<div class="rp-muted">по продажам ${r.autoFare.toLocaleString('ru-RU')} ₽</div>` : ''}</td>
            <td>${r.n || '—'}</td>
            <td>${edit ? `<label><input type="checkbox" data-fg-off="${esc(r.code)}"${r.off ? ' checked' : ''}> не продаётся</label>` : (r.off ? 'не продаётся' : '')}</td>
            <td class="rp-muted">${r.source === 'ref' ? 'справочник' : 'по продажам'}</td></tr>`).join('');
        const lad = ladderFor([...(directions().get(current) || [])][0] || current);
        return `<section class="rp-card">
            <div class="rp-card-head"><h3 class="rp-card-title">Сетка тарифов</h3></div>
            <p class="rp-card-text">Класс — первая буква кода. У одного класса бывают семейства: лайт, стандарт и дороже — оптимум. Ценовой советник считает ценой класса лайт (если есть) или стандарт. Сетка собрана из продаж (самый частый взрослый тариф кода); поправьте семейство или тариф и сохраните — действует у всех.</p>
            <div class="ref-toolbar"><label>Направление <select id="fg-dir">${dirs.map(d => `<option${d === current ? ' selected' : ''}>${esc(d)}</option>`).join('')}</select></label>
                ${edit ? '<button type="button" class="btn-primary rp-btn" id="fg-save">Сохранить сетку направления</button><button type="button" class="btn-secondary rp-btn" id="fg-reset">Вернуть как в продажах</button>' : ''}</div>
            <div class="rp-scroll"><table class="rp-table"><thead><tr><th>Класс</th><th>Код</th><th>Семейство</th><th>Тариф</th><th>Билетов</th><th></th><th>Источник</th></tr></thead><tbody>${body || '<tr><td colspan="7">Нет продаж по направлению</td></tr>'}</tbody></table></div>
            <p class="rp-note">Лестница для советника (класс — цена): ${lad.map(l => `${esc(l.cls)} ${l.price.toLocaleString('ru-RU')} ₽${l.optimum ? ` (оптимум ${l.optimum.toLocaleString('ru-RU')})` : ''}`).join(' · ') || '—'}</p>
        </section>`;
    }

    function handleChange(el, rerender) {
        if (el.id === 'fg-dir') { current = el.value; rerender(); return true; }
        return false;
    }

    async function handleClick(btn, rerender) {
        if (btn.id !== 'fg-save' && btn.id !== 'fg-reset') return false;
        if (btn.id === 'fg-reset') {
            if (!confirm('Убрать правки сетки этого направления и вернуть тарифы по продажам?')) return true;
            const ok = await saveRoute(current, {});
            if (typeof showToast === 'function') showToast(ok ? 'Сетка направления — по продажам' : 'Не удалось записать', ok ? 'success' : 'error');
            rerender();
            return true;
        }
        const entries = {};
        document.querySelectorAll('[data-fg-fare]').forEach(inp => {
            const code = inp.dataset.fgFare;
            const fam = document.querySelector(`[data-fg-family="${CSS.escape(code)}"]`);
            const off = document.querySelector(`[data-fg-off="${CSS.escape(code)}"]`);
            entries[code] = { fare: Math.max(0, Math.round(Number(inp.value) || 0)), family: fam ? fam.value : familyAuto(code), off: !!(off && off.checked) };
        });
        const ok = await saveRoute(current, entries);
        if (typeof showToast === 'function') showToast(ok ? 'Сетка тарифов сохранена' : 'Не удалось записать сетку', ok ? 'success' : 'error');
        rerender();
        return true;
    }

    return { grid, ladderFor, load, sectionHtml, handleClick, handleChange, canEdit, revision: () => rev, FAMILY };
})();
