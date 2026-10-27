// Общие ручные правки: субсидия и ПКЗ из NAV (shared + локально)
window.SharedOverrides = (function () {
    const SUB_FILE = 'subsidy-overrides.json';
    const NAV_FILE = 'pkz-nav.json';
    const SUB_LOCAL = 'krasavia_subsidy_ov_v1';
    const NAV_LOCAL = 'krasavia_pkz_nav_v1';

    let subsidy = {};
    let pkzNav = {};
    // Растёт при каждой загрузке и правке субсидии: по нему проверки рейсов понимают, что пора пересчитать.
    let subsidyRev = 0;
    let navRev = 0;

    function cleanCode(flight) {
        return typeof cleanFlight === 'function' ? cleanFlight(flight) : String(flight || '');
    }

    function subKey(flight, date) {
        const fl = cleanCode(flight);
        const d = String(date || '').trim();
        return fl && d ? `${fl}|${d}` : '';
    }

    function navKey(date, flight) {
        const fl = cleanCode(flight);
        const d = String(date || '').trim();
        return fl && d ? `${d}|${fl}` : '';
    }

    function parseNum(v) {
        if (v === '' || v === null || v === undefined) return null;
        if (typeof v === 'object' && v && 'v' in v) return parseNum(v.v);
        const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.'));
        return isNaN(n) ? null : n;
    }

    function entryOf(v, author) {
        const n = parseNum(v);
        if (n === null) return null;
        return {
            v: n,
            at: new Date().toISOString(),
            by: author || (typeof ProfileAuth !== 'undefined' ? ProfileAuth.getCurrentProfile()?.name : '') || ''
        };
    }

    function tombstone() {
        return {
            v: null,
            at: new Date().toISOString(),
            by: (typeof ProfileAuth !== 'undefined' ? ProfileAuth.getCurrentProfile()?.name : '') || ''
        };
    }

    function present(entry) {
        return entry != null && parseNum(entry) !== null;
    }

    function valueOf(entry) {
        if (entry == null) return null;
        if (typeof entry === 'number') return entry;
        return parseNum(entry);
    }

    function mergeKeyMaps(a, b) {
        const out = { ...(a || {}) };
        Object.keys(b || {}).forEach((k) => {
            const be = b[k];
            const ae = out[k];
            const bt = be && be.at ? Date.parse(be.at) : 0;
            const at = ae && ae.at ? Date.parse(ae.at) : 0;
            if (!ae || bt >= at) out[k] = be;
        });
        return out;
    }

    // Файл мог быть восстановлен из резервной копии (restoredAt): правки старше этого момента, оставшиеся
    // в кэше браузера, не должны вернуть ошибочные значения обратно.
    function newerThan(map, since) {
        if (!since) return map;
        const out = {};
        Object.keys(map || {}).forEach((k) => {
            const e = map[k];
            if (e && String(e.at || '') >= String(since)) out[k] = e;
        });
        return out;
    }

    async function readRemote(filename) {
        if (typeof SharedStorage === 'undefined' || !SharedStorage.readJsonFile) return null;
        try {
            return await SharedStorage.readJsonFile(filename);
        } catch {
            return null;
        }
    }

    async function readDataRoot(filename) {
        if (typeof SalesSync === 'undefined' || !SalesSync.getDataRootHandle) return null;
        const root = SalesSync.getDataRootHandle() || await SalesSync.restoreDataFolderHandle?.();
        if (!root) return null;
        try {
            const dir = await root.getDirectoryHandle('_cache');
            const fh = await dir.getFileHandle(filename);
            const text = await (await fh.getFile()).text();
            return text.trim() ? JSON.parse(text) : null;
        } catch {
            return null;
        }
    }

    function readLocal(key) {
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return null;
            const o = JSON.parse(raw);
            if (o && typeof o === 'object' && o.values) return o;
            if (o && typeof o === 'object' && !o.values) {
                const values = {};
                Object.keys(o).forEach((k) => {
                    const n = parseNum(o[k]);
                    if (n !== null) values[k] = { v: n, at: '', by: '' };
                });
                return { values };
            }
        } catch { /* ignore */ }
        return null;
    }

    // Правки, не попавшие в общий файл (нет связи, папка закрыта на запись), хранятся на этом компьютере
    // с пометкой unsynced и дописываются сами: сначала через 15 с, затем реже (до 2 мин).
    const RETRY_FIRST_MS = 15000;
    const RETRY_MAX_MS = 120000;
    const retries = {};   // имя файла → { timer, ms }

    function scheduleRetry(filename, localKey, getValues, ms) {
        const st = retries[filename] || (retries[filename] = { timer: null, ms: RETRY_FIRST_MS });
        if (st.timer) return;
        st.timer = setTimeout(async () => {
            st.timer = null;
            const ok = await persist(filename, localKey, getValues(), true);
            if (ok) {
                st.ms = RETRY_FIRST_MS;
                if (typeof showToast === 'function') showToast('Правки записаны в общую папку');
            } else {
                st.ms = Math.min(st.ms * 3, RETRY_MAX_MS);
                scheduleRetry(filename, localKey, getValues);
            }
        }, ms || st.ms);
    }

    // quiet — повторная запись в фоне: сообщение об ошибке уже было показано.
    async function persist(filename, localKey, values, quiet) {
        // Перед записью сливаем с общим файлом: правки других ПК, сделанные после нашей загрузки, не теряются.
        // Запись идёт «только если файл не менялся с прочтения»; если его успели изменить — читаем и сливаем заново.
        const saveLocal = (p, unsynced) => {
            try {
                localStorage.setItem(localKey, JSON.stringify(Object.assign({}, p, { unsynced: !!unsynced })));
            } catch { /* ignore */ }
        };
        let payload = { version: 1, updatedAt: new Date().toISOString(), values };
        saveLocal(payload, true);   // на этом компьютере правка сохранена сразу, что бы ни случилось с общим файлом
        let res = { ok: false, readFailed: true };
        if (typeof SharedStorage !== 'undefined' && SharedStorage.updateJsonFile) {
            res = await SharedStorage.updateJsonFile(filename, (cur) => {
                const since = cur && cur.restoredAt ? String(cur.restoredAt) : '';
                const next = {
                    version: 1,
                    updatedAt: new Date().toISOString(),
                    values: mergeKeyMaps(cur && cur.values, newerThan(values, since))
                };
                if (since) next.restoredAt = since;
                return next;
            }).catch(() => ({ ok: false, readFailed: true }));
        }
        const shared = !!(res.ok && res.data && res.data.values);
        if (shared) {
            // Файл восстановлен из копии — устаревшие правки из памяти убираем, остальное берём из файла.
            if (res.data.restoredAt) Object.keys(values).forEach(k => { if (!(k in res.data.values)) delete values[k]; });
            Object.keys(res.data.values).forEach(k => { values[k] = res.data.values[k]; });   // заодно видим чужие правки
            payload = res.data;
            saveLocal(payload, false);
        } else {
            if (!quiet && typeof showToast === 'function') {
                showToast(res.readFailed
                    ? 'Общий файл недоступен — правка видна только на этом компьютере, запись повторится сама'
                    : (res.conflict
                        ? 'Правка не записана: файл часто меняют другие. Запись повторится сама'
                        : 'Правка не записана в общую папку — видна только на этом компьютере, запись повторится сама'), 'error');
            }
            if (!quiet) scheduleRetry(filename, localKey, () => (filename === SUB_FILE ? subsidy : pkzNav));
        }
        if (typeof SalesSync !== 'undefined') {
            try {
                const root = SalesSync.getDataRootHandle() || await SalesSync.restoreDataFolderHandle?.();
                if (root) {
                    const dir = await root.getDirectoryHandle('_cache', { create: true });
                    const fh = await dir.getFileHandle(filename, { create: true });
                    const w = await fh.createWritable();
                    await w.write(JSON.stringify(payload));
                    await w.close();
                }
            } catch { /* ignore */ }
        }
        return shared;
    }

    async function loadOne(filename, localKey) {
        const remote = await readRemote(filename);
        const disk = await readDataRoot(filename);
        const local = readLocal(localKey);
        let values = {};
        const since = remote && remote.restoredAt ? String(remote.restoredAt) : '';
        [local, disk, remote].forEach((pack) => {
            if (pack && pack.values) values = mergeKeyMaps(values, pack === remote ? pack.values : newerThan(pack.values, since));
        });
        return values;
    }

    async function load() {
        subsidy = await loadOne(SUB_FILE, SUB_LOCAL);
        pkzNav = await loadOne(NAV_FILE, NAV_LOCAL);
        subsidyRev++;
        navRev++;
        // Прошлый сеанс не успел записать правки в общий файл — дописываем сейчас.
        const pend = (key) => { const l = readLocal(key); return !!(l && l.unsynced); };
        if (pend(SUB_LOCAL)) scheduleRetry(SUB_FILE, SUB_LOCAL, () => subsidy, 1500);
        if (pend(NAV_LOCAL)) scheduleRetry(NAV_FILE, NAV_LOCAL, () => pkzNav, 1500);
        return true;
    }

    function hasSubsidy(flight, date) {
        const k = subKey(flight, date);
        return !!(k && present(subsidy[k]));
    }

    function getSubsidy(flight, date) {
        const k = subKey(flight, date);
        if (!k || !present(subsidy[k])) return null;
        return valueOf(subsidy[k]);
    }

    function canWrite(perm) {
        return typeof ProfileAuth !== 'undefined' && ProfileAuth.hasPermission(perm);
    }

    async function setSubsidy(flight, date, value) {
        if (!canWrite('edit_subsidy')) return false;
        const k = subKey(flight, date);
        if (!k) return false;
        // Очистка — запись «пусто» со временем: иначе старое значение вернётся из копии на другом ПК.
        const rec = value === '' || value === null || value === undefined ? null : entryOf(value);
        subsidy[k] = rec || tombstone();
        subsidyRev++;
        await persist(SUB_FILE, SUB_LOCAL, subsidy);
        return true;
    }

    // Все значения ПКЗ из NAV для справочника: [{ date, flight, value, at, by }].
    function listPkzNav() {
        return Object.keys(pkzNav).map(k => {
            const e = pkzNav[k];
            if (!present(e)) return null;
            const [date, flight] = k.split('|');
            return { date, flight, value: valueOf(e), at: e && e.at || '', by: e && e.by || '' };
        }).filter(Boolean);
    }

    function getPkzNav(date, flight) {
        const k = navKey(date, flight);
        if (!k || !present(pkzNav[k])) return null;
        return valueOf(pkzNav[k]);
    }

    async function setPkzNav(date, flight, value) {
        if (!canWrite('edit_pkz_nav')) return false;
        const k = navKey(date, flight);
        if (!k) return false;
        // Очистка — запись «пусто» со временем: иначе старое значение вернётся из копии на другом ПК.
        const rec = value === '' || value === null || value === undefined ? null : entryOf(value);
        pkzNav[k] = rec || tombstone();
        navRev++;
        await persist(NAV_FILE, NAV_LOCAL, pkzNav);
        return true;
    }

    return {
        load,
        subsidyRevision: () => subsidyRev,
        navRevision: () => navRev,
        hasSubsidy,
        getSubsidy,
        setSubsidy,
        getPkzNav,
        setPkzNav,
        listPkzNav
    };
})();
