// Справочник субсидированных тарифов: предельный тариф на субсидированных рейсах.
// Билет дороже предела — ошибка (проверка в flight-checks.js). Дешевле — можно, в том числе детские.
// Детский предел необязателен: если не задан, детский билет сравнивается со взрослым пределом.
// Хранится в shared/subsidy-fares.json (видят все ПК) и копией в браузере. Правит тот, у кого право
// edit_fare_refs (у админа есть всегда, другим он выдаёт в «Управлении профилями»).
window.FareRefs = (function () {
    const FILE = 'subsidy-fares.json';
    const LOCAL_KEY = 'krasavia_subsidy_fares_v1';
    const MAX_ENTRIES = 500;

    let cache = { version: 1, updatedAt: null, entries: [] };
    let rev = 0;

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
        const adult = cleanMoney(e.adult);
        if (!flights.length || adult == null || adult <= 0) return null;
        return {
            id: /^[a-z0-9]{4,24}$/i.test(String(e.id || '')) ? String(e.id) : newId(),
            flights,
            fareCode: cleanText(e.fareCode, 30).toUpperCase(),
            adult,
            child: cleanMoney(e.child),
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
        return { version: 1, updatedAt: src && src.updatedAt ? String(src.updatedAt) : null, entries };
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
        const local = readLocal();
        const before = JSON.stringify(cache.entries);
        if (remote && String(remote.updatedAt || '') >= String(local.updatedAt || '')) cache = remote;
        else cache = local.updatedAt ? local : (remote || local);
        // Версия растёт, только если справочник правда поменялся: иначе таблицы зря перерисуются.
        if (JSON.stringify(cache.entries) !== before) rev++;
        return cache;
    }

    // Изменение: перечитать общий файл, применить одно действие, записать. Так правки двух людей не затирают друг друга.
    async function apply(mutate) {
        const remote = await readRemote();
        const base = remote && String(remote.updatedAt || '') >= String(cache.updatedAt || '') ? remote : cache;
        const entries = base.entries.map(e => ({ ...e, flights: e.flights.slice() }));
        mutate(entries);
        cache = { version: 1, updatedAt: new Date().toISOString(), entries: entries.slice(0, MAX_ENTRIES) };
        rev++;
        try { localStorage.setItem(LOCAL_KEY, JSON.stringify(cache)); } catch (e) { /* ignore */ }
        let ok = false;
        if (typeof SharedStorage !== 'undefined' && typeof SharedStorage.writeJsonFile === 'function') {
            ok = await SharedStorage.writeJsonFile(FILE, cache);
        }
        return ok;
    }

    function canEdit() {
        return typeof ProfileAuth !== 'undefined' && ProfileAuth.hasPermission('edit_fare_refs');
    }

    function authorName() {
        const p = typeof ProfileAuth !== 'undefined' && ProfileAuth.getCurrentProfile ? ProfileAuth.getCurrentProfile() : null;
        return p ? String(p.name || p.id || '') : '';
    }

    async function upsert(entry) {
        if (!canEdit()) return { ok: false, error: 'Нет права менять справочник' };
        const n = normalizeEntry({ ...entry, updatedAt: new Date().toISOString(), by: authorName() });
        if (!n) return { ok: false, error: 'Укажите рейс и предельный тариф больше 0' };
        if (n.from && n.to && typeof compareDateStr === 'function' && compareDateStr(n.from, n.to) > 0) {
            return { ok: false, error: 'Дата «с» позже даты «по»' };
        }
        const shared = await apply(entries => {
            const i = entries.findIndex(e => e.id === n.id);
            if (i === -1) entries.push(n);
            else entries[i] = n;
        });
        return { ok: true, shared, entry: n };
    }

    async function remove(id) {
        if (!canEdit()) return { ok: false, error: 'Нет права менять справочник' };
        const shared = await apply(entries => {
            const i = entries.findIndex(e => e.id === id);
            if (i !== -1) entries.splice(i, 1);
        });
        return { ok: true, shared };
    }

    function dateIn(entry, date) {
        if (typeof compareDateStr !== 'function') return true;
        if (entry.from && compareDateStr(date, entry.from) < 0) return false;
        if (entry.to && compareDateStr(date, entry.to) > 0) return false;
        return true;
    }

    // Запись для рейса на дату. Если подходят несколько — берётся с самым поздним началом действия.
    function match(code, date) {
        const fl = cleanCode(code);
        if (!fl || !date) return null;
        let best = null;
        cache.entries.forEach(e => {
            if (e.flights.indexOf(fl) === -1 || !dateIn(e, date)) return;
            if (!best) { best = e; return; }
            const a = e.from || '';
            const b = best.from || '';
            if (a && (!b || (typeof compareDateStr === 'function' && compareDateStr(a, b) > 0))) best = e;
        });
        return best;
    }

    function list() {
        return cache.entries.slice().sort((a, b) => {
            const na = parseInt(String(a.flights[0]).slice(3), 10) || 0;
            const nb = parseInt(String(b.flights[0]).slice(3), 10) || 0;
            if (na !== nb) return na - nb;
            return String(a.from || '').localeCompare(String(b.from || ''));
        });
    }

    return {
        load,
        list,
        match,
        upsert,
        remove,
        canEdit,
        revision: () => rev,
        updatedAt: () => cache.updatedAt
    };
})();
