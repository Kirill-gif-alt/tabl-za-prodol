// Справочник субсидированных тарифов: предельный тариф на субсидированных рейсах.
// Билет дороже предела — ошибка (проверка в flight-checks.js). Дешевле — можно, в том числе детские.
// Детский предел необязателен: если не задан, детский билет сравнивается со взрослым пределом.
// Вторая разновидность записи — исключение (mode: 'exclude'): рейс не считается субсидированным
// и не проверяется. KV-247/248 исключены в самой проверке (flight-checks.js) и здесь не хранятся.
// Хранится в shared/subsidy-fares.json (видят все ПК) и копией в браузере. Правит тот, у кого право
// edit_fare_refs (у админа есть всегда, другим он выдаёт в «Управлении профилями»).
window.FareRefs = (function () {
    const FILE = 'subsidy-fares.json';
    const LOCAL_KEY = 'krasavia_subsidy_fares_v1';
    const MAX_ENTRIES = 500;
    // Записи, которые есть в справочнике без правки админом. Сейчас таких нет.
    const DEFAULT_ENTRIES = [];

    let cache = null;
    let rev = 0;
    let sawRemote = false;

    function cleanCode(v) {
        const code = typeof cleanFlight === 'function' ? cleanFlight(v) : String(v || '').trim();
        return /^KV-\d{1,6}$/.test(code) ? code : '';
    }

    function cleanDate(v) {
        const d = typeof normalizeDate === 'function' ? normalizeDate(v) : String(v || '');
        return d && typeof parseLocalDate === 'function' && parseLocalDate(d) ? d : '';
    }

    function cleanText(v, max) {
        const raw = typeof Security !== 'undefined' && Security.sanitizeTextInput
            ? Security.sanitizeTextInput(v, max)
            : String(v == null ? '' : v).replace(/[\u0000-\u001F]/g, '').trim().slice(0, max);
        return raw;
    }

    function cleanMoney(v) {
        if (v === '' || v == null) return null;
        const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/\s/g, '').replace(',', '.'));
        return isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
    }

    function newId() {
        const bytes = new Uint8Array(6);
        try { crypto.getRandomValues(bytes); } catch (e) { for (let i = 0; i < 6; i++) bytes[i] = Math.floor(Math.random() * 256); }
        return 'f' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    }

    function normalizeEntry(e) {
        if (!e || typeof e !== 'object') return null;
        const flights = [];
        (Array.isArray(e.flights) ? e.flights : []).forEach(f => {
            const code = cleanCode(f);
            if (code && flights.indexOf(code) === -1) flights.push(code);
        });
        const mode = e.mode === 'exclude' ? 'exclude' : 'limit';
        const adult = mode === 'limit' ? cleanMoney(e.adult) : null;
        if (!flights.length) return null;
        if (mode === 'limit' && (adult == null || adult <= 0)) return null;
        return {
            id: /^[a-z0-9]{4,24}$/i.test(String(e.id || '')) ? String(e.id) : newId(),
            mode,
            flights,
            fareCode: mode === 'limit' ? cleanText(e.fareCode, 30).toUpperCase() : '',
            adult,
            child: mode === 'limit' ? cleanMoney(e.child) : null,
            from: cleanDate(e.from),
            to: cleanDate(e.to),
            note: cleanText(e.note, 200),
            updatedAt: String(e.updatedAt || ''),
            by: cleanText(e.by, 80)
        };
    }

    function normalizeStore(src) {
        const entries = [];
        (src && Array.isArray(src.entries) ? src.entries : []).slice(0, MAX_ENTRIES).forEach(e => {
            const n = normalizeEntry(e);
            if (n) entries.push(n);
        });
        const deleted = {};
        const raw = src && src.deleted && typeof src.deleted === 'object' ? src.deleted : {};
        Object.keys(raw).slice(0, 2000).forEach(id => {
            if (/^[a-z0-9]{4,24}$/i.test(id) && raw[id]) deleted[id] = String(raw[id]);
        });
        return { version: 1, updatedAt: src && src.updatedAt ? String(src.updatedAt) : null, entries, deleted };
    }

    // Слияние двух копий: по каждой записи — самая свежая, удалённые (deleted: id → время) не возвращаются.
    function mergeStores(a, b) {
        const deleted = { ...(a.deleted || {}) };
        Object.keys(b.deleted || {}).forEach(id => {
            if (!deleted[id] || String(b.deleted[id]) > String(deleted[id])) deleted[id] = b.deleted[id];
        });
        const byId = new Map();
        a.entries.concat(b.entries).forEach(e => {
            const prev = byId.get(e.id);
            if (!prev || String(e.updatedAt || '') > String(prev.updatedAt || '')) byId.set(e.id, e);
        });
        const entries = [...byId.values()].filter(e => !(deleted[e.id] && String(deleted[e.id]) >= String(e.updatedAt || '')));
        const updatedAt = String(a.updatedAt || '') >= String(b.updatedAt || '') ? a.updatedAt : b.updatedAt;
        return { version: 1, updatedAt: updatedAt || null, entries: entries.slice(0, MAX_ENTRIES), deleted };
    }

    function defaultsStore() {
        return normalizeStore({ entries: DEFAULT_ENTRIES });
    }

    // Текущий справочник; до первой загрузки — только записи по умолчанию.
    function store() {
        if (!cache) cache = mergeStores(normalizeStore(null), defaultsStore());
        return cache;
    }

    function readLocal() {
        try { return normalizeStore(JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null')); } catch (e) { return normalizeStore(null); }
    }

    async function readRemote() {
        if (typeof SharedStorage === 'undefined' || typeof SharedStorage.readJsonFile !== 'function') return null;
        try {
            const data = await SharedStorage.readJsonFile(FILE);
            return data ? normalizeStore(data) : null;
        } catch (e) {
            return null;
        }
    }

    async function load() {
        const remote = await readRemote();
        if (remote && (remote.entries.length || Object.keys(remote.deleted).length)) sawRemote = true;
        const local = readLocal();
        const before = JSON.stringify(store().entries);
        cache = mergeStores(mergeStores(remote || normalizeStore(null), local), defaultsStore());
        // Версия растёт, только если справочник правда поменялся: иначе таблицы зря перерисуются.
        if (JSON.stringify(cache.entries) !== before) rev++;
        return cache;
    }

    // Изменение: перечитать общий файл, применить одно действие, записать. Так правки двух людей не затирают друг друга.
    async function apply(mutate) {
        const remote = await readRemote();
        // Общий файл раньше читался, а сейчас нет — не записываем, иначе можно затереть чужие записи.
        if (!remote && sawRemote) return { ok: false, error: 'Не удалось прочитать общий справочник — попробуйте ещё раз' };
        if (remote && (remote.entries.length || Object.keys(remote.deleted).length)) sawRemote = true;
        const base = mergeStores(mergeStores(remote || normalizeStore(null), store()), defaultsStore());
        const entries = base.entries.map(e => ({ ...e, flights: e.flights.slice() }));
        const deleted = { ...base.deleted };
        mutate(entries, deleted);
        cache = { version: 1, updatedAt: new Date().toISOString(), entries: entries.slice(0, MAX_ENTRIES), deleted };
        rev++;
        try { localStorage.setItem(LOCAL_KEY, JSON.stringify(cache)); } catch (e) { /* ignore */ }
        let shared = false;
        if (typeof SharedStorage !== 'undefined' && typeof SharedStorage.writeJsonFile === 'function') {
            shared = await SharedStorage.writeJsonFile(FILE, cache);
        }
        return { ok: true, shared: !!shared };
    }

    function canEdit() {
        return typeof ProfileAuth !== 'undefined' && ProfileAuth.hasPermission('edit_fare_refs');
    }

    // Видеть справочник (и суммы пределов в проверке) — с правом просмотра или правки.
    function canView() {
        return canEdit() || (typeof ProfileAuth !== 'undefined' && ProfileAuth.hasPermission('view_fare_refs'));
    }

    function authorName() {
        const p = typeof ProfileAuth !== 'undefined' && ProfileAuth.getCurrentProfile ? ProfileAuth.getCurrentProfile() : null;
        return p ? String(p.name || p.id || '') : '';
    }

    async function upsert(entry) {
        if (!canEdit()) return { ok: false, error: 'Нет права менять справочник' };
        const n = normalizeEntry({ ...entry, updatedAt: new Date().toISOString(), by: authorName() });
        if (!n) {
            return { ok: false, error: entry && entry.mode === 'exclude' ? 'Укажите рейс' : 'Укажите рейс и предельный тариф больше 0' };
        }
        if (n.from && n.to && typeof compareDateStr === 'function' && compareDateStr(n.from, n.to) > 0) {
            return { ok: false, error: 'Дата «с» позже даты «по»' };
        }
        const res = await apply((entries, deleted) => {
            const i = entries.findIndex(e => e.id === n.id);
            if (i === -1) entries.push(n);
            else entries[i] = n;
            delete deleted[n.id];
        });
        return res.ok ? { ok: true, shared: res.shared, entry: n } : res;
    }

    async function remove(id) {
        if (!canEdit()) return { ok: false, error: 'Нет права менять справочник' };
        return apply((entries, deleted) => {
            const i = entries.findIndex(e => e.id === id);
            if (i !== -1) entries.splice(i, 1);
            deleted[id] = new Date().toISOString();
        });
    }

    function dateIn(entry, date) {
        if (typeof compareDateStr !== 'function') return true;
        if (entry.from && compareDateStr(date, entry.from) < 0) return false;
        if (entry.to && compareDateStr(date, entry.to) > 0) return false;
        return true;
    }

    // Запись для рейса на дату. Если подходят несколько — берётся с самым поздним началом действия.
    function find(code, date, mode) {
        const fl = cleanCode(code);
        if (!fl || !date) return null;
        let best = null;
        store().entries.forEach(e => {
            if (e.mode !== mode || e.flights.indexOf(fl) === -1 || !dateIn(e, date)) return;
            if (!best) { best = e; return; }
            const a = e.from || '';
            const b = best.from || '';
            if (a && (!b || (typeof compareDateStr === 'function' && compareDateStr(a, b) > 0))) best = e;
        });
        return best;
    }

    // Предельный тариф для рейса на дату.
    function match(code, date) {
        return find(code, date, 'limit');
    }

    // Исключение: рейс на эту дату не считается субсидированным.
    function isExcluded(code, date) {
        return find(code, date, 'exclude');
    }

    function list() {
        return store().entries.slice().sort((a, b) => {
            const na = parseInt(String(a.flights[0]).slice(3), 10) || 0;
            const nb = parseInt(String(b.flights[0]).slice(3), 10) || 0;
            if (na !== nb) return na - nb;
            return String(a.from || '').localeCompare(String(b.from || ''));
        });
    }

    return {
        canView,
        load,
        list,
        match,
        isExcluded,
        upsert,
        remove,
        canEdit,
        revision: () => rev,
        updatedAt: () => store().updatedAt
    };
})();
