// Справочник субсидий внутри приложения (вкладка «Отчёты» → «Справочник»): вместо файлов
// «Период субсидии.xlsx» и «Расходы.xlsx». Хранится в shared/subsidy-ref.json (видят все ПК).
//  periods — периоды КОММЕРЦИИ по номеру рейса (как в файле: в эти даты субсидии нет);
//            пустой список — коммерции нет, рейс субсидируется весь год.
//  amounts — по маршруту и типу ВС: субсидия и себестоимость (тыс. ₽ за пару туда-обратно, как в файле).
// Запись справочника важнее файла; если по рейсу/маршруту записи нет — берётся загруженный файл.
// Каждая запись хранит время правки: при записи общий файл перечитывается и сливается по записям.
window.SubsidyRef = (function () {
    const FILE = 'subsidy-ref.json';
    const LOCAL_KEY = 'krasavia_subsidy_ref_v1';

    let cache = { version: 1, updatedAt: null, periods: {}, amounts: {}, pkz: {} };
    let rev = 0;
    let loaded = false;

    function num(v) {
        if (v === '' || v == null) return null;
        const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[\s ]/g, '').replace(',', '.'));
        return isFinite(n) && n >= 0 ? Math.round(n * 1000) / 1000 : null;
    }

    function cleanText(v, max) {
        return String(v == null ? '' : v).replace(/[\u0000-\u001F<>]/g, '').trim().slice(0, max);
    }

    function cleanDate(v) {
        const d = typeof normalizeDate === 'function' ? normalizeDate(v) : String(v || '');
        return d && typeof parseLocalDate === 'function' && parseLocalDate(d) ? d : '';
    }

    function cityKey(name) {
        return String(name || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]/gi, '');
    }

    function acKey(name) {
        return typeof RouteCosts !== 'undefined' && RouteCosts.acKey ? RouteCosts.acKey(name) : cityKey(name);
    }

    // Маршрут без направления: Красноярск—Абакан и Абакан—Красноярск — одна запись.
    function amountKey(from, to, ac) {
        const a = cityKey(from);
        const b = cityKey(to);
        const k = acKey(ac);
        if (!a || !b || !k || a === b) return '';
        return (a < b ? `${a}|${b}` : `${b}|${a}`) + '|' + k;
    }

    function normRanges(list) {
        const out = [];
        (Array.isArray(list) ? list : []).forEach(r => {
            const from = cleanDate(r && r.from);
            const to = cleanDate(r && r.to);
            if (!from || !to) return;
            const swap = typeof compareDateStr === 'function' && compareDateStr(from, to) > 0;
            out.push(swap ? { from: to, to: from } : { from, to });
        });
        if (typeof compareDateStr === 'function') out.sort((a, b) => compareDateStr(a.from, b.from));
        return out.slice(0, 12);
    }

    function normPeriod(e) {
        if (!e || typeof e !== 'object') return null;
        const at = String(e.at || '');
        if (e.deleted) return { deleted: true, at, by: cleanText(e.by, 60) };
        return { ranges: normRanges(e.ranges), at, by: cleanText(e.by, 60) };
    }

    function normAmount(e) {
        if (!e || typeof e !== 'object') return null;
        const at = String(e.at || '');
        if (e.deleted) return { deleted: true, at, by: cleanText(e.by, 60) };
        const from = cleanText(e.from, 60);
        const to = cleanText(e.to, 60);
        const ac = cleanText(e.ac, 30);
        if (!amountKey(from, to, ac)) return null;
        // Себестоимость одна (раньше было две — «при субсидии» и «коммерческая»: берём любую заданную).
        const cost = num(e.cost) != null ? num(e.cost) : (num(e.costCom) != null ? num(e.costCom) : num(e.costSub));
        return { from, to, ac, subsidy: num(e.subsidy), cost, at, by: cleanText(e.by, 60) };
    }

    // Направление «в одну сторону»: «Красноярск — Абакан» ≠ «Абакан — Красноярск».
    function dirKey(label) {
        const parts = String(label || '').split(/\s*[—–→]\s*|\s+-\s+/).map(cityKey).filter(Boolean);
        return parts.length >= 2 ? parts.join('>') : '';
    }

    // ПКЗ из NAV: правило «период + тип ВС + направление → кг», применяется ко всем подходящим вылетам.
    function normPkz(e) {
        if (!e || typeof e !== 'object') return null;
        const at = String(e.at || '');
        if (e.deleted) return { deleted: true, at, by: cleanText(e.by, 60) };
        const from = cleanDate(e.from);
        const to = cleanDate(e.to);
        const direction = cleanText(e.direction, 80);
        const ac = cleanText(e.ac, 30);
        const value = num(e.value);
        if (!from || !to || !dirKey(direction) || value == null) return null;
        const swap = typeof compareDateStr === 'function' && compareDateStr(from, to) > 0;
        return { from: swap ? to : from, to: swap ? from : to, direction, ac, value, at, by: cleanText(e.by, 60) };
    }

    function normStore(data) {
        const out = { version: 1, updatedAt: data && data.updatedAt ? String(data.updatedAt) : null, periods: {}, amounts: {}, pkz: {} };
        if (!data || typeof data !== 'object') return out;
        Object.keys(data.periods || {}).forEach(k => {
            if (!/^\d{1,5}$/.test(k)) return;
            const e = normPeriod(data.periods[k]);
            if (e) out.periods[k] = e;
        });
        Object.keys(data.amounts || {}).forEach(k => {
            const e = normAmount(data.amounts[k]);
            if (!e) return;
            const key = e.deleted ? k : amountKey(e.from, e.to, e.ac);
            if (key) out.amounts[key] = e;
        });
        Object.keys(data.pkz || {}).forEach(k => {
            if (!/^[a-z0-9]{4,24}$/i.test(k)) return;
            const e = normPkz(data.pkz[k]);
            if (e) out.pkz[k] = e;
        });
        return out;
    }

    function mergeMaps(a, b) {
        const out = { ...(a || {}) };
        Object.keys(b || {}).forEach(k => {
            if (!out[k] || String(b[k].at || '') > String(out[k].at || '')) out[k] = b[k];
        });
        return out;
    }

    function mergeStores(a, b) {
        return {
            version: 1,
            updatedAt: [a.updatedAt, b.updatedAt].filter(Boolean).sort().pop() || null,
            periods: mergeMaps(a.periods, b.periods),
            amounts: mergeMaps(a.amounts, b.amounts),
            pkz: mergeMaps(a.pkz, b.pkz)
        };
    }

    function readLocal() {
        try { return normStore(JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null')); } catch (e) { return normStore(null); }
    }

    function saveLocal() {
        try { localStorage.setItem(LOCAL_KEY, JSON.stringify(cache)); } catch (e) { /* ignore */ }
    }

    function push() {
        if (typeof RouteCosts !== 'undefined' && RouteCosts.applyRef) RouteCosts.applyRef(activePeriods(), activeAmounts());
        // Суммы и периоды поменялись — кэши таблиц (экономика, метрики) пересчитываются.
        if (typeof invalidateMetricsCache === 'function') invalidateMetricsCache();
        if (typeof PerfCache !== 'undefined' && PerfCache.reset) PerfCache.reset();
        if (typeof tableHtmlCache !== 'undefined') tableHtmlCache = { sig: '', html: '' };
        pkzMemo = new Map();
    }

    async function load() {
        let remote = null;
        if (typeof SharedStorage !== 'undefined' && SharedStorage.readJsonFileStrict) {
            const r = await SharedStorage.readJsonFileStrict(FILE).catch(() => ({ ok: false }));
            if (r.ok && r.data) remote = normStore(r.data);
        }
        const before = JSON.stringify([cache.periods, cache.amounts, cache.pkz]);
        cache = mergeStores(remote || normStore(null), readLocal());
        loaded = true;
        if (JSON.stringify([cache.periods, cache.amounts, cache.pkz]) !== before) {
            rev++;
            saveLocal();
        }
        push();
        return cache;
    }

    // Правка: перечитать общий файл, слить, применить, записать. Не прочитали — не пишем.
    async function apply(mutate) {
        let remote = normStore(null);
        if (typeof SharedStorage !== 'undefined' && SharedStorage.readJsonFileStrict) {
            const r = await SharedStorage.readJsonFileStrict(FILE).catch(() => ({ ok: false }));
            if (!r.ok) return { ok: false, error: 'Нет доступа к общей папке — изменения не сохранены. Подключите папку и повторите.' };
            if (r.data) remote = normStore(r.data);
        }
        const next = mergeStores(remote, cache);
        mutate(next);
        next.updatedAt = new Date().toISOString();
        cache = next;
        rev++;
        saveLocal();
        push();
        let shared = false;
        if (typeof SharedStorage !== 'undefined' && SharedStorage.writeJsonFile) {
            shared = await SharedStorage.writeJsonFile(FILE, cache);
        }
        if (typeof FlightChecks !== 'undefined' && FlightChecks.refreshViews) FlightChecks.refreshViews();
        return shared ? { ok: true } : { ok: false, error: 'Не удалось записать общий файл справочника' };
    }

    function author() {
        const p = typeof ProfileAuth !== 'undefined' && ProfileAuth.getCurrentProfile ? ProfileAuth.getCurrentProfile() : null;
        return p ? cleanText(p.name || p.id || '', 60) : '';
    }

    function has(perm) {
        return typeof ProfileAuth !== 'undefined' && ProfileAuth.hasPermission(perm);
    }

    function canEdit() { return has('edit_subsidy_ref'); }
    function canView() { return canEdit() || has('view_subsidy_ref'); }

    // Справочник ведётся по базовому номеру: доп. рейс KV-301 = KV-101.
    function flightNum(code) {
        let c = String(code || '');
        if (/^\d+$/.test(c)) c = 'KV-' + c;
        if (typeof getBaseFlight === 'function' && /^KV-\d+$/.test(c)) c = getBaseFlight(c);
        return parseInt(c.replace(/[^0-9]/g, ''), 10) || 0;
    }

    function canEditPkz() { return has('edit_pkz_nav'); }
    function canViewPkz() { return canEditPkz() || has('view_pkz_nav'); }

    function newId() {
        const b = new Uint8Array(6);
        try { crypto.getRandomValues(b); } catch (e) { for (let i = 0; i < 6; i++) b[i] = Math.floor(Math.random() * 256); }
        return 'p' + Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    }

    async function setPkzRule(entry, id) {
        if (!canEditPkz()) return { ok: false, error: 'Нет права менять ПКЗ из NAV' };
        const e = normPkz({ ...entry, at: new Date().toISOString(), by: author() });
        if (!e) return { ok: false, error: 'Укажите период (обе даты), направление и ПКЗ в кг' };
        const key = id && /^[a-z0-9]{4,24}$/i.test(id) ? id : newId();
        return apply(s => { s.pkz[key] = e; });
    }

    // Загрузка из Excel: всё одной записью файла. Каждый раздел — только с правом на него.
    //  periods: { '101': [{from,to}] } — периоды рейса заменяются целиком;
    //  amounts: [{from,to,ac,subsidy,cost}]; pkz: [{from,to,direction,ac,value}] — совпавшее правило обновляется.
    async function applyImport(data) {
        const at = new Date().toISOString();
        const by = author();
        const counts = { periods: 0, amounts: 0, pkz: 0 };
        const periods = canEdit() ? data.periods || {} : {};
        const amounts = canEdit() ? (data.amounts || []).map(e => normAmount({ ...e, at, by })).filter(Boolean) : [];
        const pkz = canEditPkz() ? (data.pkz || []).map(e => normPkz({ ...e, at, by })).filter(Boolean) : [];
        if (!Object.keys(periods).length && !amounts.length && !pkz.length) return { ok: true, counts };
        const res = await apply(s => {
            Object.keys(periods).forEach(n => {
                const b = String(flightNum(n));
                if (b === '0') return;
                s.periods[b] = { ranges: normRanges(periods[n]), at, by };
                counts.periods++;
            });
            amounts.forEach(e => { s.amounts[amountKey(e.from, e.to, e.ac)] = e; counts.amounts++; });
            pkz.forEach(e => {
                const same = Object.keys(s.pkz).find(id => {
                    const r = s.pkz[id];
                    return !r.deleted && r.from === e.from && r.to === e.to && dirKey(r.direction) === dirKey(e.direction)
                        && (r.ac ? acKey(r.ac) : '') === (e.ac ? acKey(e.ac) : '');
                });
                s.pkz[same || newId()] = e;
                counts.pkz++;
            });
        });
        return res.ok ? { ok: true, counts } : res;
    }

    async function removePkzRule(id) {
        if (!canEditPkz()) return { ok: false, error: 'Нет права менять ПКЗ из NAV' };
        const at = new Date().toISOString();
        return apply(s => { s.pkz[id] = { deleted: true, at, by: author() }; });
    }

    function activePkz() {
        const out = {};
        Object.keys(cache.pkz || {}).forEach(k => { if (!cache.pkz[k].deleted) out[k] = cache.pkz[k]; });
        return out;
    }

    // ПКЗ из NAV для вылета: правило, где дата в периоде, направление рейса совпадает (в эту сторону),
    // тип ВС совпадает (или в правиле «любой»). Несколько подходят — точнее по типу ВС, потом более позднее начало.
    let pkzMemo = new Map();
    function pkzFor(date, flightCode, acRaw) {
        const rules = activePkz();
        const ids = Object.keys(rules);
        if (!ids.length || !date || !flightCode) return null;
        const memoKey = date + '|' + flightCode + '|' + (acRaw || '');
        if (pkzMemo.has(memoKey)) return pkzMemo.get(memoKey);
        const base = typeof getBaseFlight === 'function' ? getBaseFlight(flightCode) : flightCode;
        const dir = dirKey(typeof getFlightDirection === 'function' ? getFlightDirection(base) : '');
        const ak = acRaw ? acKey(typeof getAircraftType === 'function' ? getAircraftType(acRaw) : acRaw) : '';
        let best = null;
        ids.forEach(id => {
            const r = rules[id];
            if (!dir || dirKey(r.direction) !== dir) return;
            if (typeof compareDateStr === 'function' && (compareDateStr(date, r.from) < 0 || compareDateStr(date, r.to) > 0)) return;
            const rk = r.ac ? acKey(r.ac) : '';
            if (rk && rk !== ak) return;
            const score = (rk ? 2 : 1);
            if (!best || score > best.score
                || (score === best.score && typeof compareDateStr === 'function' && compareDateStr(r.from, best.r.from) > 0)
                || (score === best.score && r.from === best.r.from && String(r.at) > String(best.r.at))) {
                best = { r, score };
            }
        });
        const v = best ? best.r.value : null;
        if (pkzMemo.size > 20000) pkzMemo.clear();
        pkzMemo.set(memoKey, v);
        return v;
    }

    // Периоды коммерции для рейсов (номера или коды). ranges: [{from,to}] в ДД.ММ.ГГГГ.
    async function setPeriods(flights, ranges) {
        if (!canEdit()) return { ok: false, error: 'Нет права менять справочник' };
        const nums = [...new Set((flights || []).map(flightNum).filter(Boolean))];
        if (!nums.length) return { ok: false, error: 'Укажите рейс' };
        const clean = normRanges(ranges);
        if ((ranges || []).length !== clean.length) return { ok: false, error: 'Заполните обе даты в каждом периоде' };
        const at = new Date().toISOString();
        return apply(s => nums.forEach(n => { s.periods[String(n)] = { ranges: clean, at, by: author() }; }));
    }

    // Убрать запись справочника — снова действует файл (если он загружен).
    async function clearPeriods(flights) {
        if (!canEdit()) return { ok: false, error: 'Нет права менять справочник' };
        const nums = [...new Set((flights || []).map(flightNum).filter(Boolean))];
        const at = new Date().toISOString();
        return apply(s => nums.forEach(n => { s.periods[String(n)] = { deleted: true, at, by: author() }; }));
    }

    async function setAmount(entry, oldKey) {
        if (!canEdit()) return { ok: false, error: 'Нет права менять справочник' };
        const e = normAmount({ ...entry, at: new Date().toISOString(), by: author() });
        if (!e) return { ok: false, error: 'Укажите оба города (разные) и тип ВС' };
        if (e.subsidy == null && e.cost == null) return { ok: false, error: 'Укажите субсидию или себестоимость' };
        const key = amountKey(e.from, e.to, e.ac);
        return apply(s => {
            if (oldKey && oldKey !== key && s.amounts[oldKey]) s.amounts[oldKey] = { deleted: true, at: e.at, by: e.by };
            s.amounts[key] = e;
        });
    }

    async function removeAmount(key) {
        if (!canEdit()) return { ok: false, error: 'Нет права менять справочник' };
        const at = new Date().toISOString();
        return apply(s => { s.amounts[key] = { deleted: true, at, by: author() }; });
    }

    // Перенести в справочник всё, что сейчас загружено из файлов (один раз — после этого файлы можно удалить).
    async function importFromFiles(opts) {
        if (!canEdit()) return { ok: false, error: 'Нет права менять справочник' };
        const src = typeof RouteCosts !== 'undefined' && RouteCosts.fileData ? RouteCosts.fileData() : null;
        if (!src || (!Object.keys(src.periodsByNum || {}).length && !(src.costRows || []).length)) {
            return { ok: false, error: 'Файлы «Период субсидии» и «Расходы» не загружены — переносить нечего' };
        }
        const overwrite = !!(opts && opts.overwrite);
        const at = new Date().toISOString();
        const by = author();
        let nP = 0;
        let nA = 0;
        const res = await apply(s => {
            Object.keys(src.periodsByNum || {}).forEach(n => {
                // Строка доп. рейса (KV-305) идёт под базовым номером, если у базового своей строки нет.
                const b = String(flightNum(n));
                if (b !== String(n) && src.periodsByNum[b]) return;
                const cur = s.periods[b];
                if (cur && !cur.deleted && !overwrite) return;
                s.periods[b] = { ranges: normRanges(src.periodsByNum[n]), at, by };
                nP++;
            });
            const grouped = {};
            (src.costRows || []).forEach(r => {
                const key = amountKey(r.from, r.to, r.ac);
                if (!key) return;
                const g = grouped[key] || (grouped[key] = { from: r.from, to: r.to, ac: r.ac, subsidy: null, cost: null });
                if (r.flag === 'да' && r.subsidyAmt) g.subsidy = r.subsidyAmt;
                if (r.costPair != null && (g.cost == null || r.flag === 'нет')) g.cost = r.costPair;
            });
            Object.keys(grouped).forEach(key => {
                const cur = s.amounts[key];
                if (cur && !cur.deleted && !overwrite) return;
                const e = normAmount({ ...grouped[key], at, by });
                if (e) { s.amounts[key] = e; nA++; }
            });
        });
        return res.ok ? { ok: true, periods: nP, amounts: nA } : res;
    }

    function activePeriods() {
        const out = {};
        Object.keys(cache.periods).forEach(k => { if (!cache.periods[k].deleted) out[k] = cache.periods[k]; });
        return out;
    }

    function activeAmounts() {
        const out = {};
        Object.keys(cache.amounts).forEach(k => { if (!cache.amounts[k].deleted) out[k] = cache.amounts[k]; });
        return out;
    }

    return {
        load,
        setPeriods,
        clearPeriods,
        setAmount,
        removeAmount,
        importFromFiles,
        setPkzRule,
        applyImport,
        removePkzRule,
        pkzRules: activePkz,
        pkzFor,
        dirKey,
        canViewPkz,
        canEditPkz,
        periods: activePeriods,
        amounts: activeAmounts,
        amountKey,
        canView,
        canEdit,
        revision: () => rev,
        get loaded() { return loaded; }
    };
})();
