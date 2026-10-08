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

    let cache = { version: 1, updatedAt: null, periods: {}, amounts: {} };
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
        return { from, to, ac, subsidy: num(e.subsidy), costSub: num(e.costSub), costCom: num(e.costCom), at, by: cleanText(e.by, 60) };
    }

    function normStore(data) {
        const out = { version: 1, updatedAt: data && data.updatedAt ? String(data.updatedAt) : null, periods: {}, amounts: {} };
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
            amounts: mergeMaps(a.amounts, b.amounts)
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
    }

    async function load() {
        let remote = null;
        if (typeof SharedStorage !== 'undefined' && SharedStorage.readJsonFileStrict) {
            const r = await SharedStorage.readJsonFileStrict(FILE).catch(() => ({ ok: false }));
            if (r.ok && r.data) remote = normStore(r.data);
        }
        const before = JSON.stringify([cache.periods, cache.amounts]);
        cache = mergeStores(remote || normStore(null), readLocal());
        loaded = true;
        if (JSON.stringify([cache.periods, cache.amounts]) !== before) {
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

    function flightNum(code) {
        return parseInt(String(code || '').replace(/[^0-9]/g, ''), 10) || 0;
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
        if (e.subsidy == null && e.costSub == null && e.costCom == null) return { ok: false, error: 'Укажите хотя бы одну сумму' };
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
                const cur = s.periods[n];
                if (cur && !cur.deleted && !overwrite) return;
                s.periods[n] = { ranges: normRanges(src.periodsByNum[n]), at, by };
                nP++;
            });
            const grouped = {};
            (src.costRows || []).forEach(r => {
                const key = amountKey(r.from, r.to, r.ac);
                if (!key) return;
                const g = grouped[key] || (grouped[key] = { from: r.from, to: r.to, ac: r.ac, subsidy: null, costSub: null, costCom: null });
                if (r.flag === 'да') {
                    g.costSub = r.costPair;
                    if (r.subsidyAmt) g.subsidy = r.subsidyAmt;
                } else {
                    g.costCom = r.costPair;
                }
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
        periods: activePeriods,
        amounts: activeAmounts,
        amountKey,
        canView,
        canEdit,
        revision: () => rev,
        get loaded() { return loaded; }
    };
})();
