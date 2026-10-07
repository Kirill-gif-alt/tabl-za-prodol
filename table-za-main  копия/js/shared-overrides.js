// Общие ручные правки: субсидия и ПКЗ из NAV (shared + локально)
window.SharedOverrides = (function () {
    const SUB_FILE = 'subsidy-overrides.json';
    const NAV_FILE = 'pkz-nav.json';
    const SUB_LOCAL = 'krasavia_subsidy_ov_v1';
    const NAV_LOCAL = 'krasavia_pkz_nav_v1';

    let subsidy = {};
    let pkzNav = {};

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

    async function persist(filename, localKey, values) {
        const payload = {
            version: 1,
            updatedAt: new Date().toISOString(),
            values
        };
        try {
            localStorage.setItem(localKey, JSON.stringify(payload));
        } catch { /* ignore */ }
        if (typeof SharedStorage !== 'undefined' && SharedStorage.writeJsonFile) {
            await SharedStorage.writeJsonFile(filename, payload);
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
    }

    async function loadOne(filename, localKey) {
        const remote = await readRemote(filename);
        const disk = await readDataRoot(filename);
        const local = readLocal(localKey);
        let values = {};
        [local, disk, remote].forEach((pack) => {
            if (pack && pack.values) values = mergeKeyMaps(values, pack.values);
        });
        return values;
    }

    async function load() {
        subsidy = await loadOne(SUB_FILE, SUB_LOCAL);
        pkzNav = await loadOne(NAV_FILE, NAV_LOCAL);
        return true;
    }

    function hasSubsidy(flight, date) {
        const k = subKey(flight, date);
        return !!(k && subsidy[k]);
    }

    function getSubsidy(flight, date) {
        const k = subKey(flight, date);
        if (!k || !subsidy[k]) return null;
        return valueOf(subsidy[k]);
    }

    function canWrite(perm) {
        return typeof ProfileAuth !== 'undefined' && ProfileAuth.hasPermission(perm);
    }

    async function setSubsidy(flight, date, value) {
        if (!canWrite('edit_subsidy')) return false;
        const k = subKey(flight, date);
        if (!k) return false;
        if (value === '' || value === null || value === undefined) {
            delete subsidy[k];
        } else {
            const rec = entryOf(value);
            if (!rec) delete subsidy[k];
            else subsidy[k] = rec;
        }
        await persist(SUB_FILE, SUB_LOCAL, subsidy);
        return true;
    }

    function getPkzNav(date, flight) {
        const k = navKey(date, flight);
        if (!k || !pkzNav[k]) return null;
        return valueOf(pkzNav[k]);
    }

    async function setPkzNav(date, flight, value) {
        if (!canWrite('edit_pkz_nav')) return false;
        const k = navKey(date, flight);
        if (!k) return false;
        if (value === '' || value === null || value === undefined) {
            delete pkzNav[k];
        } else {
            const rec = entryOf(value);
            if (!rec) delete pkzNav[k];
            else pkzNav[k] = rec;
        }
        await persist(NAV_FILE, NAV_LOCAL, pkzNav);
        return true;
    }

    return {
        load,
        hasSubsidy,
        getSubsidy,
        setSubsidy,
        getPkzNav,
        setPkzNav
    };
})();
