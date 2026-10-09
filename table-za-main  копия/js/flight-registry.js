// Справочник рейсов: новые рейсы без правки файлов. Номер туда, маршрут, обратный номер и доп. номера
// (под которыми рейс летает, когда в день два вылета) — в «Отчёты» → «Справочник» → «Рейсы».
// • Встроенные рейсы — из js/routes.js и правил доп. номеров (3xx → 1xx и т. п.); добавленные хранятся
//   в shared/flights.json, общие для всех, правка по записи (at), удалённое не «воскресает».
// • Добавленный рейс сразу работает везде: направление, базовый номер для доп. номеров, пара
//   туда–обратно, тип (краевой / межрегиональный, МВЛ) — если города нет в списках cities.js.
window.FlightRegistry = (function () {
    const FILE = 'flights.json';
    const BUILTIN_DIRS = { ...(window.FLIGHT_DIRECTIONS || {}) };
    const BASE_CFG = window.CITY_CLASSIFICATION || {};
    const TYPES = { auto: 'по городам', krai: 'краевой', interregional: 'межрегиональный', international: 'международный (МВЛ)' };

    let entries = {};     // код туда → { code, from, to, back, extras[], backExtras[], type, deleted, at, by }
    let loaded = false;
    let rev = 0;

    function profileName() {
        const p = typeof ProfileAuth !== 'undefined' && ProfileAuth.getCurrentProfile ? ProfileAuth.getCurrentProfile() : null;
        return p ? String(p.name || p.id || '') : '';
    }

    function canEdit() {
        return typeof ProfileAuth !== 'undefined' && ProfileAuth.hasPermission('edit_flights');
    }

    function code(v) {
        const n = String(v == null ? '' : v).replace(/[^0-9]/g, '');
        return n && n.length <= 4 ? 'KV-' + parseInt(n, 10) : '';
    }

    function codes(text) {
        return String(text || '').split(/[\s,;]+/).map(code).filter(Boolean).filter((c, i, a) => a.indexOf(c) === i);
    }

    function city(v) {
        return String(v || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    }

    function normEntry(e) {
        if (!e || typeof e !== 'object') return null;
        if (e.deleted) return { deleted: true, at: String(e.at || ''), by: String(e.by || '') };
        const c = code(e.code);
        const from = city(e.from);
        const to = city(e.to);
        if (!c || !from || !to) return null;
        const back = code(e.back);
        return {
            code: c,
            from,
            to,
            back: back && back !== c ? back : '',
            extras: (Array.isArray(e.extras) ? e.extras.map(code) : codes(e.extras)).filter(x => x && x !== c && x !== back),
            backExtras: back ? (Array.isArray(e.backExtras) ? e.backExtras.map(code) : codes(e.backExtras)).filter(x => x && x !== c && x !== back) : [],
            type: TYPES[e.type] ? e.type : 'auto',
            at: String(e.at || ''),
            by: String(e.by || '')
        };
    }

    // Действующие добавленные рейсы (без удалённых).
    function list() {
        return Object.keys(entries).map(k => entries[k]).filter(e => e && !e.deleted)
            .sort((a, b) => (parseInt(a.code.slice(3), 10) || 0) - (parseInt(b.code.slice(3), 10) || 0));
    }

    // Применить справочник к глобальным таблицам рейсов (направления, доп. номера, пары, типы).
    function applyAll() {
        const dirs = { ...BUILTIN_DIRS };
        const extraBase = {};
        const pairs = {};
        const types = {};
        const intl = new Set(BASE_CFG.INTERNATIONAL_CITIES || []);
        list().forEach(e => {
            dirs[e.code] = `${e.from} — ${e.to}`;
            extraBase[e.code] = e.code;
            if (e.back) {
                dirs[e.back] = `${e.to} — ${e.from}`;
                extraBase[e.back] = e.back;
                pairs[e.code] = { outbound: e.code, inbound: e.back };
                pairs[e.back] = { outbound: e.code, inbound: e.back };
            }
            e.extras.forEach(x => { extraBase[x] = e.code; });
            e.backExtras.forEach(x => { extraBase[x] = e.back; });
            if (e.type !== 'auto') {
                const t = e.type === 'international' ? 'interregional' : e.type;
                [e.code, e.back].filter(Boolean).forEach(c => { types[c] = t; });
                if (e.type === 'international') { intl.add(e.from); intl.add(e.to); }
            }
        });
        window.FLIGHT_DIRECTIONS = dirs;
        window.FLIGHT_EXTRA_BASE = extraBase;
        window.FLIGHT_PAIR_OVERRIDES = pairs;
        window.FLIGHT_TYPE_OVERRIDES = types;
        // Новый объект — кэши городов (cities.js) сбросятся сами.
        window.CITY_CLASSIFICATION = { ...BASE_CFG, INTERNATIONAL_CITIES: [...intl].filter(c => !(BASE_CFG.HUB_CITIES || []).includes(c)) };
        if (typeof PerfCache !== 'undefined' && PerfCache.clearFlightCaches) PerfCache.clearFlightCaches();
        rev++;
    }

    function mergeInto(target, remote) {
        Object.keys(remote || {}).forEach(id => {
            const e = normEntry(remote[id]);
            if (!e) return;
            if (!target[id] || String(e.at) >= String(target[id].at || '')) target[id] = e;
        });
        return target;
    }

    // После изменения базовых номеров: перегруппировать данные и перерисовать.
    function regroup() {
        if (typeof processData === 'function' && typeof allData !== 'undefined' && allData && allData.length) {
            processData();
            if (typeof invalidateMetricsCache === 'function') invalidateMetricsCache();
            if (typeof invalidateTabPanelState === 'function') invalidateTabPanelState();
        }
    }

    async function load() {
        if (typeof SharedStorage === 'undefined') return;
        const r = await SharedStorage.readJsonFileStrict(FILE).catch(() => ({ ok: false }));
        if (!r.ok) return;
        entries = mergeInto({}, r.data && r.data.flights);
        loaded = true;
        applyAll();
        regroup();
    }

    async function apply(id, entry) {
        if (!canEdit()) return { ok: false, error: 'Нет права менять справочник рейсов' };
        if (typeof SharedStorage === 'undefined') return { ok: false, error: 'Общая папка не подключена' };
        const r = await SharedStorage.readJsonFileStrict(FILE).catch(() => ({ ok: false }));
        if (!r.ok) return { ok: false, error: 'Не удалось прочитать flights.json — изменения не сохранены' };
        const merged = mergeInto({}, r.data && r.data.flights);
        merged[id] = { ...entry, at: new Date().toISOString(), by: profileName() };
        const okWrite = await SharedStorage.writeJsonFile(FILE, { version: 1, updatedAt: new Date().toISOString(), flights: merged });
        if (!okWrite) return { ok: false, error: 'Не удалось записать flights.json' };
        entries = mergeInto({}, merged);
        loaded = true;
        applyAll();
        regroup();
        return { ok: true };
    }

    // Все номера, уже занятые другими рейсами (встроенные и добавленные) — чтобы не задвоить.
    function owner(c, exceptId) {
        const own = list().find(e => e.code !== exceptId && (e.code === c || e.back === c || e.extras.includes(c) || e.backExtras.includes(c)));
        if (own) return own.code;
        if (!list().some(e => e.code === exceptId && (e.code === c || e.back === c)) && BUILTIN_DIRS[c]) return c;
        return '';
    }

    function save(raw, id) {
        const e = normEntry(raw);
        if (!e || e.deleted) return Promise.resolve({ ok: false, error: 'Укажите номер рейса, откуда и куда' });
        const all = [e.code, e.back].concat(e.extras, e.backExtras).filter(Boolean);
        if (new Set(all).size !== all.length) return Promise.resolve({ ok: false, error: 'Номера повторяются' });
        for (const c of all) {
            const o = owner(c, id || e.code);
            // Встроенный рейс можно переопределить своим (тот же номер) — это правка, а не дубль.
            if (o && o !== e.code && o !== e.back && !(BUILTIN_DIRS[c] && (c === e.code || c === e.back))) {
                return Promise.resolve({ ok: false, error: `Номер ${c} уже есть у рейса ${o}` });
            }
        }
        const p = id && id !== e.code ? apply(id, { deleted: true }).then(res => (res.ok ? apply(e.code, e) : res)) : apply(e.code, e);
        return p;
    }

    function remove(id) {
        return apply(id, { deleted: true });
    }

    // Обратный номер по умолчанию: нечётный туда → следующий чётный.
    function suggestBack(c) {
        const n = parseInt(String(code(c)).slice(3), 10) || 0;
        return n ? 'KV-' + (n % 2 === 1 ? n + 1 : n - 1) : '';
    }

    // Встроенные рейсы (routes.js) парами — для списка в справочнике.
    function builtinPairs() {
        const seen = new Set();
        const out = [];
        Object.keys(BUILTIN_DIRS).forEach(c => {
            if (seen.has(c)) return;
            const n = parseInt(c.slice(3), 10) || 0;
            const back = 'KV-' + (n % 2 === 1 ? n + 1 : n - 1);
            const pairCode = n % 2 === 1 ? c : back;
            const pairBack = n % 2 === 1 ? back : c;
            seen.add(pairCode);
            seen.add(pairBack);
            out.push({ code: pairCode, back: BUILTIN_DIRS[pairBack] ? pairBack : '', direction: BUILTIN_DIRS[pairCode] || BUILTIN_DIRS[pairBack] || '' });
        });
        return out.sort((a, b) => (parseInt(a.code.slice(3), 10) || 0) - (parseInt(b.code.slice(3), 10) || 0));
    }

    function isBuiltin(c) {
        return !!BUILTIN_DIRS[c];
    }

    return { TYPES, list, load, save, remove, suggestBack, builtinPairs, isBuiltin, canEdit, codes, isLoaded: () => loaded, revision: () => rev, get: (c) => entries[c] && !entries[c].deleted ? entries[c] : null };
})();
