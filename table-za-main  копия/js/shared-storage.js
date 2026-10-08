// Общие файлы на диске (папка shared/): профили и снимок данных для всех ПК
window.SharedStorage = (function () {
    const IDB_NAME = 'krasavia_shared_fs';
    const IDB_STORE = 'handles';
    const HANDLE_KEY = 'app_root';
    const PROFILES_FILE = 'profiles.json';
    const SNAPSHOT_FILE = 'snapshot.json';
    const ACTIVITY_FILE = 'activity.json';
    const SHARED_DIR = 'shared';
    const ALLOWED_FILES = new Set([
        'profiles.json', 'snapshot.json', 'activity.json', 'flight-comments.json',
        'subsidy-overrides.json', 'pkz-nav.json', 'sales-management.json', 'rms-widget.json',
        'creative-layouts.json', 'subsidy-fares.json'
    ]);

    let rootHandle = null;
    let linkStatus = 'unknown'; // unknown | linked | server | fetch | none
    // Запись через локальный сервер (Start-Krasavia.cmd): не зависит от разрешения браузера на папку,
    // которое Chrome сбрасывает после перезапуска. null — ещё не проверяли.
    let serverWrite = null;

    async function detectServerWrite() {
        if (serverWrite !== null) return serverWrite;
        serverWrite = false;
        if (typeof location === 'undefined' || location.protocol !== 'http:') return serverWrite;
        try {
            const res = await fetch('./__krasavia/caps', { cache: 'no-store' });
            if (res.ok) serverWrite = !!(await res.json()).sharedWrite;
        } catch { serverWrite = false; }
        if (serverWrite && !rootHandle) linkStatus = 'server';
        return serverWrite;
    }

    async function writeViaServer(filename, data) {
        if (!(await detectServerWrite())) return false;
        try {
            const res = await fetch(`./${SHARED_DIR}/${filename}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            return res.ok;
        } catch (e) {
            console.warn('writeViaServer', filename, e);
            return false;
        }
    }

    function supportsFsAccess() {
        return typeof window.showDirectoryPicker === 'function' && window.isSecureContext;
    }

    function openIdb() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(IDB_NAME, 1);
            req.onerror = () => reject(req.error);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
            };
            req.onsuccess = () => resolve(req.result);
        });
    }

    async function saveRootHandle(handle) {
        const db = await openIdb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.objectStore(IDB_STORE).put(handle, HANDLE_KEY);
        });
        rootHandle = handle;
        linkStatus = 'linked';
    }

    async function restoreRootHandle() {
        if (rootHandle) return rootHandle;
        try {
            const db = await openIdb();
            const handle = await new Promise((resolve) => {
                const tx = db.transaction(IDB_STORE, 'readonly');
                const req = tx.objectStore(IDB_STORE).get(HANDLE_KEY);
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => resolve(null);
            });
            if (!handle) return null;
            const perm = await handle.queryPermission({ mode: 'readwrite' });
            if (perm === 'granted') {
                rootHandle = handle;
                linkStatus = 'linked';
                return handle;
            }
            // Без клика пользователя Chrome не даёт вернуть доступ — не пытаемся, чтобы не было ошибки.
            const activated = !navigator.userActivation || navigator.userActivation.isActive;
            if (perm === 'prompt' && activated) {
                const reqPerm = await handle.requestPermission({ mode: 'readwrite' });
                if (reqPerm === 'granted') {
                    rootHandle = handle;
                    linkStatus = 'linked';
                    return handle;
                }
            }
        } catch (e) {
            console.warn('restoreRootHandle', e);
        }
        return null;
    }

    async function linkAppFolder() {
        if (!supportsFsAccess()) {
            return { ok: false, error: 'Браузер не поддерживает запись в папку. Используйте Chrome или Edge.' };
        }
        try {
            const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
            const looksLikeApp = await (async () => {
                try { await handle.getFileHandle('index.html'); return true; } catch { /* no */ }
                try { await handle.getDirectoryHandle('shared'); return true; } catch { /* no */ }
                try { await handle.getDirectoryHandle('js'); return true; } catch { /* no */ }
                return false;
            })();
            if (!looksLikeApp) {
                return { ok: false, error: 'Это не папка приложения (нет index.html / js / shared)' };
            }
            await saveRootHandle(handle);
            return { ok: true };
        } catch (e) {
            if (e?.name === 'AbortError') return { ok: false, error: 'Отменено' };
            return { ok: false, error: e?.message || 'Не удалось подключить папку' };
        }
    }

    function isAllowedSharedFile(filename) {
        return ALLOWED_FILES.has(String(filename || ''));
    }

    async function readViaFetch(filename) {
        if (!isAllowedSharedFile(filename)) return null;
        // file:// — CORS блокирует fetch соседних файлов; не вызываем, чтобы не засорять консоль
        if (typeof location !== 'undefined' && location.protocol === 'file:') return null;
        try {
            const res = await fetch(`./${SHARED_DIR}/${filename}`, { cache: 'no-store' });
            if (!res.ok) return null;
            return await res.json();
        } catch {
            return null;
        }
    }

    async function getSharedDirFromHandle(handle) {
        return handle.getDirectoryHandle(SHARED_DIR, { create: true });
    }

    async function readViaHandle(filename) {
        if (!isAllowedSharedFile(filename)) return null;
        const handle = await restoreRootHandle();
        if (!handle) return null;
        try {
            const sharedDir = await getSharedDirFromHandle(handle);
            const fileHandle = await sharedDir.getFileHandle(filename);
            const file = await fileHandle.getFile();
            const text = await file.text();
            if (!text.trim()) return null;
            return JSON.parse(text);
        } catch (e) {
            if (e?.name !== 'NotFoundError') console.warn('readViaHandle', filename, e);
            return null;
        }
    }

    function pickNewer(a, b, field) {
        if (!a) return b;
        if (!b) return a;
        const ta = a[field] ? new Date(a[field]).getTime() : (typeof a[field] === 'number' ? a[field] : 0);
        const tb = b[field] ? new Date(b[field]).getTime() : (typeof b[field] === 'number' ? b[field] : 0);
        if (!ta && !tb) return b || a;
        if (!ta) return b;
        if (!tb) return a;
        return ta >= tb ? a : b;
    }

    async function readSharedJson(filename, timeField) {
        // Сеть и подключённая папка читаются одновременно, а не по очереди.
        const [fromFetch, fromHandle] = await Promise.all([readViaFetch(filename), readViaHandle(filename)]);
        let result = pickNewer(fromFetch, fromHandle, timeField);

        if (fromFetch && !fromHandle) linkStatus = 'fetch';
        else if (fromHandle) linkStatus = rootHandle ? 'linked' : linkStatus;

        return result;
    }

    async function writeViaHandle(filename, data) {
        if (!isAllowedSharedFile(filename)) return false;
        // Сначала сервер — он всегда может записать; папка браузера — запасной путь.
        if (await writeViaServer(filename, data)) return true;
        const handle = rootHandle || await restoreRootHandle();
        if (!handle) return false;
        try {
            const sharedDir = await getSharedDirFromHandle(handle);
            const fileHandle = await sharedDir.getFileHandle(filename, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(JSON.stringify(data));
            await writable.close();
            return true;
        } catch (e) {
            console.warn('writeViaHandle', filename, e);
            return false;
        }
    }

    async function init() {
        await detectServerWrite();
        await restoreRootHandle();
        return { linked: !!rootHandle || !!serverWrite, fetchMode: linkStatus === 'fetch' };
    }

    async function loadProfiles() {
        const data = await readSharedJson(PROFILES_FILE, 'updatedAt');
        if (data?.profiles?.length) return data.profiles;
        return null;
    }

    async function saveProfiles(profiles, updatedAt, silent) {
        const payload = {
            version: 1,
            updatedAt: updatedAt || new Date().toISOString(),
            profiles: profiles.map(p => ({
                id: p.id,
                name: p.name,
                isAdmin: !!p.isAdmin,
                permissions: [...(p.permissions || [])],
                salt: p.salt,
                hash: p.hash,
                hashVer: p.hashVer === 1 ? 1 : 2,
                showHomeMap: p.showHomeMap === true ? true : (p.showHomeMap === false ? false : undefined),
                showScreenWidgets: p.showScreenWidgets === true ? true : (p.showScreenWidgets === false ? false : undefined),
                features: p.features && typeof p.features === 'object' && Object.keys(p.features).length ? { ...p.features } : undefined,
                salesPermMigrated: p.salesPermMigrated === true ? true : undefined
            }))
        };
        const ok = await writeViaHandle(PROFILES_FILE, payload);
        if (!ok && !silent && typeof showToast === 'function') {
            showToast('Подключите папку приложения, чтобы профили увидели другие ПК', 'error');
        }
        return ok;
    }

    function buildSnapshotPayload(forShared = false) {
        if (!Object.keys(groupedData || {}).length) return null;
        const canSharePii = typeof ProfileAuth !== 'undefined'
            && ProfileAuth.hasPermission('share_data')
            && ProfileAuth.hasPermission('sales_detail');
        const salesDetailsOut = (forShared || !canSharePii)
            ? (typeof Security !== 'undefined' ? Security.stripSalesPii(salesDetails) : {})
            : salesDetails;
        return {
            version: 1,
            savedAt: Date.now(),
            data: {
                allData,
                salesMap,
                salesDetails: salesDetailsOut,
                closedFlights: [...closedFlights],
                expectedLoadData,
                baggageWeightsData: typeof baggageWeightsData !== 'undefined' ? baggageWeightsData : {},
                childrenByFlightDate: typeof childrenByFlightDate !== 'undefined' ? childrenByFlightDate : {},
                routeCosts: typeof RouteCosts !== 'undefined' ? RouteCosts.toSnapshot() : null,
                dataLoadStatus,
                lastSalesUpdate: lastSalesUpdate ? lastSalesUpdate.toISOString() : null
            }
        };
    }

    async function loadSnapshot() {
        const wrapper = await readSharedJson(SNAPSHOT_FILE, 'savedAt');
        if (!wrapper?.data || !wrapper.savedAt) return null;
        const snap = {
            version: wrapper.version || 1,
            savedAt: wrapper.savedAt,
            ...wrapper.data,
            lastSalesUpdate: wrapper.data.lastSalesUpdate || null
        };
        if (typeof Security !== 'undefined' && !Security.validateSnapshotPayload(snap)) return null;
        return snap;
    }

    async function saveSnapshot(announce) {
        const payload = buildSnapshotPayload(true);
        if (!payload) return false;
        const ok = await writeViaHandle(SNAPSHOT_FILE, payload);
        if (announce && ok && typeof showToast === 'function') {
            showToast('Данные опубликованы для всех пользователей');
        } else if (announce && !ok && typeof showToast === 'function') {
            showToast('Подключите папку приложения (⚙ Профили), чтобы данные увидели другие ПК', 'error');
        }
        return ok;
    }

    function isLinked() {
        return !!rootHandle || !!serverWrite || linkStatus === 'fetch';
    }

    function needsLinkPrompt() {
        return supportsFsAccess() && !rootHandle && !serverWrite && linkStatus !== 'fetch';
    }

    function mergeActivityEvents(a, b, max) {
        const limit = max || 800;
        const map = new Map();
        [...(a || []), ...(b || [])].forEach(e => {
            if (e?.id) map.set(e.id, e);
        });
        return [...map.values()]
            .sort((x, y) => new Date(y.ts) - new Date(x.ts))
            .slice(0, limit);
    }

    async function loadActivity() {
        const data = await readSharedJson(ACTIVITY_FILE, 'updatedAt');
        if (!data?.events?.length) return [];
        return data.events;
    }

    async function saveActivity(events) {
        // Без подключённой папки записать нельзя — не качаем файл журнала зря.
        if (!(rootHandle || await detectServerWrite() || await restoreRootHandle())) return false;
        const remote = await loadActivity();
        const merged = mergeActivityEvents(remote, events, 2000);
        const payload = {
            version: 1,
            updatedAt: new Date().toISOString(),
            events: merged
        };
        return writeViaHandle(ACTIVITY_FILE, payload);
    }

    async function readEventsFromFileHandle(fileHandle) {
        try {
            const file = await fileHandle.getFile();
            const text = await file.text();
            if (!text.trim()) return [];
            const data = JSON.parse(text);
            if (Array.isArray(data)) return data;
            if (Array.isArray(data.events)) return data.events;
        } catch { /* ignore */ }
        return [];
    }

    async function loadActivityFromDataRoot(dirHandle) {
        if (!dirHandle) return [];
        let events = [];
        try {
            const cacheDir = await dirHandle.getDirectoryHandle('_cache');
            for await (const [, entry] of cacheDir.entries()) {
                if (entry.kind !== 'file') continue;
                const n = String(entry.name || '').toLowerCase();
                if (!n.startsWith('u_') || !n.endsWith('.json')) continue;
                const pid = n.slice(2, -5);
                const part = (await readEventsFromFileHandle(entry))
                    .filter(e => e && e.profileId && String(e.profileId).toLowerCase() === pid);
                if (part.length) events = mergeActivityEvents(events, part, 2000);
            }
        } catch { /* нет каталога — нормально */ }
        return events;
    }

    async function saveActivityToDataRoot(dirHandle, events) {
        if (!dirHandle) return false;
        const profile = typeof ProfileAuth !== 'undefined' ? ProfileAuth.getCurrentProfile() : null;
        const pid = String(profile?.id || 'x').replace(/[^a-z0-9_]/gi, '').slice(0, 32) || 'x';
        const mine = (events || []).filter(e => !profile || e.profileId === profile.id);
        if (!mine.length) return false;
        try {
            const cacheDir = await dirHandle.getDirectoryHandle('_cache', { create: true });
            const fileHandle = await cacheDir.getFileHandle(`u_${pid}.json`, { create: true });
            const prev = await readEventsFromFileHandle(fileHandle);
            const merged = mergeActivityEvents(prev, mine, 800);
            const writable = await fileHandle.createWritable();
            await writable.write(JSON.stringify({
                updatedAt: new Date().toISOString(),
                events: merged
            }));
            await writable.close();
            return true;
        } catch {
            return false;
        }
    }

    async function ensureWritableLink() {
        if (await detectServerWrite()) return true;
        await restoreRootHandle();
        if (rootHandle) return true;
        if (!supportsFsAccess()) return false;
        try {
            const result = await linkAppFolder();
            return !!result?.ok;
        } catch {
            return false;
        }
    }

    async function readJsonFile(filename) {
        return readSharedJson(filename, 'updatedAt');
    }

    async function writeJsonFile(filename, data) {
        return writeViaHandle(filename, data);
    }

    return {
        init,
        linkAppFolder,
        loadProfiles,
        saveProfiles,
        loadSnapshot,
        saveSnapshot,
        loadActivity,
        saveActivity,
        loadActivityFromDataRoot,
        saveActivityToDataRoot,
        mergeActivityEvents,
        ensureWritableLink,
        isLinked,
        needsLinkPrompt,
        restoreRootHandle,
        readJsonFile,
        writeJsonFile
    };
})();