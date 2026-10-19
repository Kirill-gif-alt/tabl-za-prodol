// Сетка тарифов направления («Отчёты» → «Справочник» → «Сетка тарифов»).
// Код тарифа: первая буква — класс бронирования, дальше — семейство и условия: VLHOW = класс V, семейство LH, OW.
// У одного класса бывает несколько семейств с разной ценой: лайт (LH) дешевле стандарта (ST), оптимум (OP) — дороже.
// Цена класса для ценового советника — самое дешёвое из «лайт / стандарт» (что есть), оптимум — надбавка к классу.
// Главный источник — официальная сетка тарифов (Excel «Тарифы»: маршрут, КБТ, УПТ, тариф ВЗР по периодам действия),
// её загружают в «Справочник» → «Сетка тарифов». Нет официальной сетки по направлению — сетка из продаж.
// Всё хранится в shared/fare-grid.json — для всех.
window.FareGrid = (function () {
    const FILE = 'fare-grid.json';
    const FAMILY = { lite: 'Лайт', standard: 'Стандарт', optimum: 'Оптимум', other: 'Другое' };
    const AUTO_FAMILY = { LH: 'lite', LT: 'lite', ST: 'standard', OP: 'optimum' };   // по продажам: LH < ST < OP у одного класса

    let store = { version: 1, routes: {}, official: null };
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

    // Код без детских/служебных хвостов: «KSTOW/CN20» → «KSTOW» (коды …IDB отсеяны раньше, в isAdult).
    function cleanCode(b) {
        return String(b || '').toUpperCase().split('/')[0].trim();
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

    // ---------- официальная сетка тарифов (Excel) ----------

    function norm(t) { return String(t || '').toLowerCase().replace(/ё/g, 'е').replace(/[\s.]+/g, '').replace(/[—–]/g, '-'); }

    function parseDate(t) {
        const m = String(t || '').match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
        if (!m) return '';
        const y = m[3].length === 2 ? '20' + m[3] : m[3];
        return `${m[1].padStart(2, '0')}.${m[2].padStart(2, '0')}.${y}`;
    }

    // Период действия из шапки таблицы: «Период действия с 02.09.2026 по 20.12.2026» / «Дата начала действия с 07.07.2026».
    function parsePeriod(t) {
        const s0 = String(t || '').replace(/\s+/g, ' ');
        const m = s0.match(/действия\s*с\s*([\d.]+)(?:\s*по\s*([\d.]+))?/i);
        if (!m) return null;
        return { from: parseDate(m[1]), to: m[2] ? parseDate(m[2]) : '' };
    }

    function fareNum(v) {
        if (typeof v === 'number') return v > 0 ? Math.round(v) : null;
        const t = String(v == null ? '' : v).replace(/[\s\u00a0]/g, '').replace(',', '.');
        const n = Number(t);
        return t && isFinite(n) && n > 0 ? Math.round(n) : null;
    }

    // Направления сайта («Красноярск — Абакан»), которые упомянуты в названии маршрута таблицы («Красноярск-Абакан, Абакан-Красноярск»).
    function matchDirections(routeText) {
        const t = norm(routeText);
        const out = new Set();
        Object.values(window.FLIGHT_DIRECTIONS || {}).forEach(d => {
            const parts = String(d).split(/\s+[—–-]\s+/);
            if (parts.length !== 2) return;
            if (t.includes(norm(parts[0]) + '-' + norm(parts[1]))) out.add(String(d).replace(/\s+/g, ' ').trim());
        });
        return [...out];
    }

    // Разбор файла: листы с таблицами «Маршрут | КБТ | УПТ | Тариф ВЗР», несколько таблиц рядом — разные периоды действия.
    // Интерлайн, «по северной прописке», чартеры, льготы, ТНДМР/ЭМР и международные — не сетка RMS, пропускаются.
    const SKIP_SHEET = /интерлайн|чартер|льгот|тндмр|эмр|монгол/i;
    const SKIP_TABLE = /интерлайн|прописк/i;
    function parseWorkbook(lib, wb) {
        const routes = Object.create(null);
        const unmatched = new Set();
        wb.SheetNames.forEach(name => {
            if (SKIP_SHEET.test(name)) return;
            const rows = lib.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' });
            const cell = (r, c) => (rows[r] && rows[r][c] != null ? rows[r][c] : '');
            for (let hr = 0; hr < rows.length; hr++) {
                const kbt = [];
                (rows[hr] || []).forEach((v, c) => { if (String(v).trim() === 'КБТ') kbt.push(c); });
                if (!kbt.length) continue;
                // Строка периодов — ближайшая выше; таблица — от своей ячейки периода до следующей.
                let pr = -1;
                for (let k = hr - 1; k >= Math.max(0, hr - 3); k--) if ((rows[k] || []).some(v => /период|дата начала/i.test(String(v)))) { pr = k; break; }
                const pcs = pr >= 0 ? (rows[pr] || []).map((v, c) => (/период|дата начала/i.test(String(v)) ? c : -1)).filter(c => c >= 0) : [kbt[0]];
                pcs.forEach((pc, ti) => {
                    const next = pcs[ti + 1] != null ? pcs[ti + 1] : Infinity;
                    const cols = kbt.filter(c => c >= pc && c < next);
                    if (!cols.length) return;
                    // Заголовок таблицы — выше строки периодов, в её колонках («Тарифы на Краевых рейсах по Северной прописке»).
                    let title = '';
                    for (let k = (pr >= 0 ? pr : hr) - 1; k >= 0 && !title; k--) {
                        for (let c = Math.max(0, pc - 1); c < Math.min(next, pc + 3); c++) { const v = String(cell(k, c)); if (/тариф/i.test(v) && !/ВЗР/.test(v)) { title = v; break; } }
                    }
                    if (SKIP_TABLE.test(title)) return;
                    const per = parsePeriod(pr >= 0 ? cell(pr, pc) : '') || { from: '', to: '' };
                    let route = '';
                    const byRoute = Object.create(null);
                    for (let r = hr + 1; r < rows.length; r++) {
                        const a = String(cell(r, 0)).trim();
                        const rowText = (rows[r] || []).map(String).join(' ');
                        if (a === 'Маршрут' || /период|дата начала|приказ|тип рейсов/i.test(rowText) && !cols.some(c => /^[A-Z]{3,}/.test(String(cell(r, c))))) break;
                        if (a) route = a.replace(/\s+/g, ' ');
                        if (!route) continue;
                        cols.forEach(c => {
                            const code = String(cell(r, c)).trim().toUpperCase();
                            if (!/^[A-Z][A-Z0-9]{3,8}$/.test(code)) return;
                            const fare = fareNum(cell(r, c + 2));
                            if (fare == null) return;   // «-» — не продаётся
                            (byRoute[route] || (byRoute[route] = [])).push({ code, fare });
                        });
                    }
                    Object.keys(byRoute).forEach(rt => {
                        const dirs = matchDirections(rt);
                        if (!dirs.length) { unmatched.add(rt); return; }
                        dirs.forEach(d => { (routes[d] || (routes[d] = [])).push({ from: per.from, to: per.to, sheet: name, rows: byRoute[rt] }); });
                    });
                });
            }
        });
        return { routes, unmatched: [...unmatched] };
    }

    function ts(d) { const x = typeof parseLocalDate === 'function' ? parseLocalDate(d) : null; return x ? x.getTime() : null; }

    // Период официальной сетки на дату вылета: действующий (последний начавшийся), иначе ближайший.
    function officialFor(dir, date) {
        const list = store.official && store.official.routes && store.official.routes[dir];
        if (!list || !list.length) return null;
        const t = ts(date || (typeof getTodayDate === 'function' ? getTodayDate() : '')) || Date.now();
        const ok = list.filter(p => (!p.from || ts(p.from) <= t) && (!p.to || t <= ts(p.to) + 86399999));
        const pool = ok.length ? ok : list.filter(p => !p.from || ts(p.from) <= t);
        const pick = (pool.length ? pool : list).slice().sort((a, b) => (ts(b.from) || 0) - (ts(a.from) || 0))[0];
        return pick || null;
    }

    // Лестница по официальной сетке: класс → лайт, иначе стандарт, иначе самый дешёвый код; оптимум отдельно.
    function officialLadder(dir, date) {
        const per = officialFor(dir, date);
        if (!per) return null;
        const saved = (store.routes && store.routes[dir]) || {};
        const byCls = Object.create(null);
        per.rows.forEach(x => {
            const sv = saved[x.code];
            if (sv && sv.off) return;
            const fare = sv && sv.fare > 0 ? sv.fare : x.fare;
            const fam = (sv && sv.family) || familyAuto(x.code);
            (byCls[x.code[0]] || (byCls[x.code[0]] = [])).push({ code: x.code, fare, family: fam });
        });
        const ladder = Object.keys(byCls).map(cls => {
            const l = byCls[cls];
            const pick = l.find(r => r.family === 'lite') || l.find(r => r.family === 'standard') || l.slice().sort((a, b) => a.fare - b.fare)[0];
            const opt = l.find(r => r.family === 'optimum');
            return { cls, price: pick.fare, code: pick.code, family: pick.family, optimum: opt ? opt.fare : null };
        });
        ladder.sort((a, b) => a.price - b.price);
        return { ladder, period: per };
    }

    // Лестница классов для советника: официальная сетка на дату вылета, иначе — по продажам
    // (класс → лайт, иначе стандарт, иначе самый дешёвый код класса).
    function ladderFor(code, date) {
        const off = officialLadder(direction(code), date);
        if (off && off.ladder.length >= 2) return off.ladder;
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
        if (r.ok && r.data && typeof r.data === 'object') { store = { version: 1, routes: r.data.routes || {}, official: r.data.official || null }; rev++; }
    }

    async function saveRoute(dir, entries) {
        if (!canEdit()) return false;
        // Свежая копия файла: правки других направлений не теряются.
        const r = typeof SharedStorage !== 'undefined' ? await SharedStorage.readJsonFileStrict(FILE).catch(() => ({ ok: false })) : { ok: true, data: null };
        if (!r.ok) return false;
        const routes = (r.data && r.data.routes) || {};
        routes[dir] = entries;
        const official = (r.data && r.data.official) || null;
        const by = typeof ProfileAuth !== 'undefined' ? (ProfileAuth.getCurrentProfile() || {}).name || '' : '';
        const ok = await SharedStorage.writeJsonFile(FILE, { version: 1, updatedAt: new Date().toISOString(), by, routes, official });
        if (ok) { store = { version: 1, routes, official }; rev++; }
        return ok;
    }

    async function saveOfficial(official) {
        if (!canEdit()) return false;
        const r = typeof SharedStorage !== 'undefined' ? await SharedStorage.readJsonFileStrict(FILE).catch(() => ({ ok: false })) : { ok: true, data: null };
        if (!r.ok) return false;
        const routes = (r.data && r.data.routes) || {};
        const by = typeof ProfileAuth !== 'undefined' ? (ProfileAuth.getCurrentProfile() || {}).name || '' : '';
        const ok = await SharedStorage.writeJsonFile(FILE, { version: 1, updatedAt: new Date().toISOString(), by, routes, official });
        if (ok) { store = { version: 1, routes, official }; rev++; }
        return ok;
    }

    async function importFile(file, rerender) {
        const lib = typeof loadStyledXlsx === 'function' ? await loadStyledXlsx() : (typeof XLSX !== 'undefined' ? XLSX : null);
        if (!lib) { if (typeof showToast === 'function') showToast('Библиотека Excel не загружена', 'error'); return; }
        let wb;
        try { wb = lib.read(await file.arrayBuffer(), { type: 'array' }); } catch (e) { if (typeof showToast === 'function') showToast('Не удалось прочитать файл', 'error'); return; }
        const res = parseWorkbook(lib, wb);
        const nDir = Object.keys(res.routes).length;
        if (!nDir) { if (typeof showToast === 'function') showToast('В файле не нашлось таблиц «Маршрут — КБТ — Тариф ВЗР» по нашим направлениям', 'error'); return; }
        const by = typeof ProfileAuth !== 'undefined' ? (ProfileAuth.getCurrentProfile() || {}).name || '' : '';
        const ok = await saveOfficial({ file: String(file.name || '').slice(0, 120), at: new Date().toISOString(), by, routes: res.routes, unmatched: res.unmatched.slice(0, 50) });
        if (typeof showToast === 'function') showToast(ok ? `Сетка тарифов загружена: ${nDir} направлений` : 'Не удалось записать сетку', ok ? 'success' : 'error');
        if (rerender) rerender();
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
        const anyCode = [...(directions().get(current) || [])][0] || current;
        const lad = ladderFor(anyCode);
        const off = store.official;
        const offDir = officialLadder(current, null);
        const per = offDir ? offDir.period : null;
        const fmtP = (p) => `${p.from ? 'с ' + p.from : ''}${p.to ? ' по ' + p.to : ''}` || 'без срока';
        const offList = off && off.routes && off.routes[current] ? off.routes[current] : [];
        const famCell = (rows, cls, fam) => { const x = rows.find(r => r.code[0] === cls && familyAuto(r.code) === fam); return x ? `${x.fare.toLocaleString('ru-RU')} <span class="rp-muted">${esc(x.code)}</span>` : '—'; };
        const offTable = (p) => {
            const classes = [...new Set(p.rows.map(r => r.code[0]))];
            const cheapest = (c) => Math.min(...p.rows.filter(r => r.code[0] === c).map(r => r.fare));
            classes.sort((a, b) => cheapest(a) - cheapest(b));
            const other = (c) => p.rows.filter(r => r.code[0] === c && familyAuto(r.code) === 'other').map(r => `${r.fare.toLocaleString('ru-RU')} <span class="rp-muted">${esc(r.code)}</span>`).join(', ') || '—';
            return `<div class="rp-scroll"><table class="rp-table"><thead><tr><th>Класс</th><th>Лайт</th><th>Стандарт</th><th>Оптимум</th><th>Другие</th></tr></thead><tbody>${classes.map(c => `<tr><td><strong>${esc(c)}</strong></td><td>${famCell(p.rows, c, 'lite')}</td><td>${famCell(p.rows, c, 'standard')}</td><td>${famCell(p.rows, c, 'optimum')}</td><td>${other(c)}</td></tr>`).join('')}</tbody></table></div>`;
        };
        // Правка периода: тарифы кодов, новые коды (в том числе новая буква), удаление кода.
        const editBlock = (p, i) => !edit ? '' : `<details class="fg-edit"><summary>Изменить тарифы этого периода</summary>
            <div class="rp-scroll"><table class="rp-table"><thead><tr><th>Код (КБТ)</th><th>Тариф ВЗР, ₽</th><th></th></tr></thead><tbody>
            ${p.rows.slice().sort((a, b) => a.fare - b.fare).map(x => `<tr><td>${esc(x.code)}</td><td><input type="number" min="1" step="1" data-fgo-p="${i}" data-fgo-code="${esc(x.code)}" value="${x.fare}" style="width:110px"></td>
                <td><label><input type="checkbox" data-fgo-del="${i}" data-fgo-code="${esc(x.code)}"> убрать</label></td></tr>`).join('')}
            ${[0, 1, 2].map(k => `<tr><td><input type="text" maxlength="9" placeholder="новый код, напр. ULHOW" data-fgo-newcode="${i}" style="width:150px;text-transform:uppercase"></td><td><input type="number" min="1" step="1" placeholder="тариф" data-fgo-newfare="${i}" style="width:110px"></td><td></td></tr>`).join('')}
            </tbody></table></div>
            <button type="button" class="btn-primary rp-btn" id="fg-off-save" data-fgo-save="${i}">Сохранить период</button>
            <span class="rp-muted">Первая буква кода — класс, дальше семейство: LH — лайт, ST — стандарт, OP — оптимум.</span></details>`;
        const offHtml = offList.length
            ? offList.map((p, i) => `<h4 class="rp-subhead">Действует ${esc(fmtP(p))}${p === per ? ' — сейчас' : ''}</h4>${offTable(p)}${editBlock(p, i)}`).join('')
            : '<p class="rp-note">По этому направлению официальной сетки нет — советник берёт уровни из продаж (таблица ниже).</p>';
        const offInfo = off ? `Загружена: ${esc(off.file || 'файл')}${off.at ? `, ${esc(new Date(off.at).toLocaleDateString('ru-RU'))}` : ''}${off.by ? `, ${esc(off.by)}` : ''} · направлений: ${Object.keys(off.routes || {}).length}${off.unmatched && off.unmatched.length ? ` · не сопоставлены с рейсами: ${esc(off.unmatched.slice(0, 6).join('; '))}${off.unmatched.length > 6 ? '…' : ''}` : ''}` : 'Официальная сетка не загружена.';
        return `<section class="rp-card">
            <div class="rp-card-head"><h3 class="rp-card-title">Сетка тарифов</h3></div>
            <p class="rp-card-text"><strong>Официальная сетка.</strong> ${offInfo}
                ${edit ? '<button type="button" class="btn-primary rp-btn" id="fg-upload">Загрузить сетку тарифов (Excel)</button><input type="file" id="fg-file" accept=".xlsx,.xls" hidden>' : ''}</p>
            <div class="ref-toolbar"><label>Направление <select id="fg-dir">${dirs.map(d => `<option${d === current ? ' selected' : ''}>${esc(d)}</option>`).join('')}</select></label></div>
            ${offHtml}
            <p class="rp-note">Лестница для советника сейчас (класс — цена): ${lad.map(l => `${esc(l.cls)} ${l.price.toLocaleString('ru-RU')} ₽${l.optimum ? ` (оптимум ${l.optimum.toLocaleString('ru-RU')})` : ''}`).join(' · ') || '—'}</p>
            <h4 class="rp-subhead">По продажам</h4>
            <p class="rp-card-text">Класс — первая буква кода. У одного класса бывают семейства: лайт, стандарт и дороже — оптимум. Ценовой советник считает ценой класса лайт (если есть) или стандарт. Сетка собрана из продаж (самый частый взрослый тариф кода); поправьте семейство или тариф и сохраните — действует у всех.</p>
            <div class="ref-toolbar">
                ${edit ? '<button type="button" class="btn-primary rp-btn" id="fg-save">Сохранить сетку направления</button><button type="button" class="btn-secondary rp-btn" id="fg-reset">Вернуть как в продажах</button>' : ''}</div>
            <div class="rp-scroll"><table class="rp-table"><thead><tr><th>Класс</th><th>Код</th><th>Семейство</th><th>Тариф</th><th>Билетов</th><th></th><th>Источник</th></tr></thead><tbody>${body || '<tr><td colspan="7">Нет продаж по направлению</td></tr>'}</tbody></table></div>
        </section>`;
    }

    function handleChange(el, rerender) {
        if (el.id === 'fg-dir') { current = el.value; rerender(); return true; }
        return false;
    }

    async function saveOfficialPeriod(i, rerender) {
        const off = store.official;
        const list = off && off.routes && off.routes[current];
        if (!list || !list[i]) return;
        const rows = [];
        const bad = [];
        document.querySelectorAll(`[data-fgo-p="${i}"]`).forEach(inp => {
            const code = inp.dataset.fgoCode;
            const del = document.querySelector(`[data-fgo-del="${i}"][data-fgo-code="${CSS.escape(code)}"]`);
            if (del && del.checked) return;
            const fare = fareNum(inp.value);
            if (fare == null) { bad.push(code); return; }
            rows.push({ code, fare });
        });
        const codes = document.querySelectorAll(`[data-fgo-newcode="${i}"]`);
        const fares = document.querySelectorAll(`[data-fgo-newfare="${i}"]`);
        codes.forEach((c, k) => {
            const code = String(c.value || '').trim().toUpperCase();
            if (!code) return;
            const fare = fareNum(fares[k] && fares[k].value);
            if (!/^[A-Z][A-Z0-9]{3,8}$/.test(code) || fare == null) { bad.push(code || '?'); return; }
            const ex = rows.find(x => x.code === code);
            if (ex) ex.fare = fare; else rows.push({ code, fare });
        });
        if (bad.length) { if (typeof showToast === 'function') showToast(`Проверьте код и тариф: ${bad.join(', ')}`, 'error'); return; }
        const next = JSON.parse(JSON.stringify(off));
        next.routes[current][i].rows = rows;
        next.routes[current][i].edited = { at: new Date().toISOString(), by: typeof ProfileAuth !== 'undefined' ? (ProfileAuth.getCurrentProfile() || {}).name || '' : '' };
        const ok = await saveOfficial(next);
        if (typeof showToast === 'function') showToast(ok ? 'Сетка периода сохранена — действует у всех' : 'Не удалось записать', ok ? 'success' : 'error');
        rerender();
    }

    async function handleClick(btn, rerender) {
        if (btn.id === 'fg-off-save') { await saveOfficialPeriod(Number(btn.dataset.fgoSave), rerender); return true; }
        if (btn.id === 'fg-upload') {
            const input = document.getElementById('fg-file');
            if (!input) return true;
            input.value = '';
            input.onchange = () => { const f = input.files && input.files[0]; if (f) importFile(f, rerender).catch(e => { console.error(e); if (typeof showToast === 'function') showToast('Ошибка загрузки сетки', 'error'); }); };
            input.click();
            return true;
        }
        if (btn.id !== 'fg-save' && btn.id !== 'fg-reset') return false;
        if (btn.id === 'fg-reset') {
            if (!confirm('Убрать правки сетки этого направления и вернуть тарифы по продажам?')) return true;
            const ok = await saveRoute(current, {});
            if (typeof showToast === 'function') showToast(ok ? 'Сетка направления — по продажам' : 'Не удалось записать', ok ? 'success' : 'error');
            rerender();
            return true;
        }
        const entries = {};
        const byCode = new Map(grid(current).map(r => [r.code, r]));
        document.querySelectorAll('[data-fg-fare]').forEach(inp => {
            const code = inp.dataset.fgFare;
            const fam = document.querySelector(`[data-fg-family="${CSS.escape(code)}"]`);
            const off = document.querySelector(`[data-fg-off="${CSS.escape(code)}"]`);
            const e = { fare: Math.max(0, Math.round(Number(inp.value) || 0)), family: fam ? fam.value : familyAuto(code), off: !!(off && off.checked) };
            // В справочник — только правки: строка «как в продажах» остаётся по продажам (и под порогом числа билетов),
            // иначе одно «Сохранить» превратило бы редкие коды (1–2 билета) в ступени лестницы советника.
            const r = byCode.get(code);
            const changed = !r || e.off || e.family !== familyAuto(code) || (r.autoFare == null ? e.fare > 0 : e.fare !== r.autoFare);
            if (changed) entries[code] = e;
        });
        const ok = await saveRoute(current, entries);
        if (typeof showToast === 'function') showToast(ok ? 'Сетка тарифов сохранена' : 'Не удалось записать сетку', ok ? 'success' : 'error');
        rerender();
        return true;
    }

    return { ladderFor, officialLadder, load, sectionHtml, handleClick, handleChange, revision: () => rev };
})();
