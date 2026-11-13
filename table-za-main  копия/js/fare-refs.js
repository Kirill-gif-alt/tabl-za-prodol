// предельный тариф на субсидированных рейсах: дороже - ошибка (flight-checks.js), дешевле можно
// детский предел необязателен, без него детский сверяем со взрослым; mode: 'exclude' - рейс не считается субсидированным
// хранится в shared/subsidy-fares.json и копией в браузере; правит тот, у кого право edit_fare_refs
window.FareRefs = (function () {
    const FILE = 'subsidy-fares.json';
    const LOCAL_KEY = 'krasavia_subsidy_fares_v1';
    const MAX_ENTRIES = 500;
    // записи по умолчанию, без правки админом; сейчас их нет
    const DEFAULT_ENTRIES = [];

    let cache = null;
    let rev = 0;
    let sawRemote = false;

    // только базовый номер: доп. рейс (KV-301, KV-355...) - тот же рейс под другим номером
    function cleanCode(v) {
        let code = typeof cleanFlight === 'function' ? cleanFlight(v) : String(v || '').trim();
        if (typeof getBaseFlight === 'function' && /^KV-\d{1,6}$/.test(code)) code = getBaseFlight(code);
        return /^KV-\d{1,6}$/.test(code) ? code : '';
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
            // у тарифа нет периодов, даты берём из "Периодов субсидии"
            from: '',
            to: '',
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
        const out = { version: 1, updatedAt: src && src.updatedAt ? String(src.updatedAt) : null, entries, deleted };
        if (src && src.restoredAt) out.restoredAt = String(src.restoredAt);
        return out;
    }

    // файл восстановлен из копии (restoredAt): записи браузера старше этого момента не возвращаем
    function newerThan(st, since) {
        if (!since) return st;
        const ok = (t) => String(t || '') >= String(since);
        const deleted = {};
        Object.keys(st.deleted || {}).forEach(id => { if (ok(st.deleted[id])) deleted[id] = st.deleted[id]; });
        return { ...st, entries: st.entries.filter(e => ok(e.updatedAt)), deleted };
    }

    // слияние двух копий: по каждой записи берём свежую, удалённые (deleted: id -> время) не воскресают
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
        const out = { version: 1, updatedAt: updatedAt || null, entries: entries.slice(0, MAX_ENTRIES), deleted };
        const rs = a.restoredAt || b.restoredAt;
        if (rs) out.restoredAt = String(a.restoredAt && b.restoredAt && b.restoredAt > a.restoredAt ? b.restoredAt : rs);
        return out;
    }

    function defaultsStore() {
        return normalizeStore({ entries: DEFAULT_ENTRIES });
    }

    // Текущий справочник; до первой загрузки - только записи по умолчанию.
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
        const local = newerThan(readLocal(), remote && remote.restoredAt);
        const before = JSON.stringify(store().entries);
        cache = mergeStores(mergeStores(remote || normalizeStore(null), local), defaultsStore());
        // версия растёт, только если справочник поменялся, иначе таблицы зря перерисуются
        if (JSON.stringify(cache.entries) !== before) rev++;
        return cache;
    }

    // правка: перечитать общий файл, применить одно действие, записать; так правки двух людей не затрут друг друга
    // файл перечитывается перед записью и проверяется после (SharedStorage.updateJsonFile)
    async function apply(mutate) {
        let next = null;
        const build = (data) => {
            const remote = data ? normalizeStore(data) : null;
            if (remote && (remote.entries.length || Object.keys(remote.deleted).length)) sawRemote = true;
            const base = mergeStores(mergeStores(remote || normalizeStore(null), newerThan(store(), remote && remote.restoredAt)), defaultsStore());
            const entries = base.entries.map(e => ({ ...e, flights: e.flights.slice() }));
            const deleted = { ...base.deleted };
            mutate(entries, deleted);
            next = { version: 1, updatedAt: new Date().toISOString(), entries: entries.slice(0, MAX_ENTRIES), deleted };
            if (base.restoredAt) next.restoredAt = base.restoredAt;
            return next;
        };
        let shared = false;
        if (typeof SharedStorage !== 'undefined' && typeof SharedStorage.updateJsonFile === 'function') {
            const res = await SharedStorage.updateJsonFile(FILE, build);
            // общий файл читался раньше, сейчас нет - не пишем, иначе затрём чужие записи
            if (res.readFailed && sawRemote) return { ok: false, error: 'Не удалось прочитать общий справочник — попробуйте ещё раз' };
            shared = !!res.ok;
        }
        if (!next) build(null);
        cache = next;
        rev++;
        try { localStorage.setItem(LOCAL_KEY, JSON.stringify(cache)); } catch (e) { /* ignore */ }
        return { ok: true, shared };
    }

    function canEdit() {
        return typeof ProfileAuth !== 'undefined' && ProfileAuth.hasPermission('edit_fare_refs');
    }

    // Видеть справочник (и суммы пределов в проверке) - с правом просмотра или правки.
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
        const res = await apply((entries, deleted) => putOne(entries, deleted, n));
        return res.ok ? { ok: true, shared: res.shared, entry: n } : res;
    }

    // один предел на рейс: старые записи этого рейса заменяем новой
    function putOne(entries, deleted, n) {
        const now = new Date().toISOString();
        for (let i = entries.length - 1; i >= 0; i--) {
            const e = entries[i];
            if (e.id !== n.id && e.flights.some(f => n.flights.indexOf(f) !== -1)) {
                const rest = e.flights.filter(f => n.flights.indexOf(f) === -1);
                if (rest.length) entries[i] = { ...e, flights: rest, updatedAt: now };
                else { entries.splice(i, 1); deleted[e.id] = now; }
            }
        }
        const i = entries.findIndex(e => e.id === n.id);
        if (i === -1) entries.push(n);
        else entries[i] = n;
        delete deleted[n.id];
    }

    // Загрузка из Excel: много записей одной записью файла.
    async function upsertMany(list) {
        if (!canEdit()) return { ok: false, error: 'Нет права менять тарифы' };
        const now = new Date().toISOString();
        const ready = (list || []).map(e => normalizeEntry({ ...e, mode: 'limit', updatedAt: now, by: authorName() })).filter(Boolean);
        if (!ready.length) return { ok: true, count: 0 };
        const res = await apply((entries, deleted) => ready.forEach(n => putOne(entries, deleted, n)));
        if (res.ok && !res.shared && typeof showToast === 'function') showToast('Не удалось сохранить в общий файл — записи только на этом компьютере', 'error');
        return res.ok ? { ok: true, shared: res.shared, count: ready.length } : res;
    }

    async function remove(id) {
        if (!canEdit()) return { ok: false, error: 'Нет права менять справочник' };
        return apply((entries, deleted) => {
            const i = entries.findIndex(e => e.id === id);
            if (i !== -1) entries.splice(i, 1);
            deleted[id] = new Date().toISOString();
        });
    }

    // запись для рейса по базовому номеру, даты не смотрим: проверка и так идёт по датам из "Периодов субсидии"
    // если записей несколько - берём самую свежую
    function find(code, mode) {
        const fl = cleanCode(code);
        if (!fl) return null;
        let best = null;
        store().entries.forEach(e => {
            if (e.mode !== mode || e.flights.indexOf(fl) === -1) return;
            if (!best || String(e.updatedAt || '') > String(best.updatedAt || '')) best = e;
        });
        return best;
    }

    // Предельный тариф для рейса на дату.
    function match(code, date) {
        return find(code, 'limit');
    }

    // Исключение: рейс на эту дату не считается субсидированным.
    function isExcluded(code, date) {
        return find(code, 'exclude');
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
        upsertMany,
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
