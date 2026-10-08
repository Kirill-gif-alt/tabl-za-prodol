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

    // Резервные копии перед перезаписью — та же политика, что в scripts/local-server.py.
    // every — не чаще раза в столько секунд, keep — сколько последних копий хранить.
    const HISTORY_DIR = '_history';
    const HISTORY_POLICY = {
        'snapshot.json': { every: 6 * 3600, keep: 4 },
        'profiles.json': { every: 600, keep: 30 },
        'sales-management.json': { every: 3600, keep: 24 },
        'subsidy-overrides.json': { every: 600, keep: 30 },
        'subsidy-fares.json': { every: 600, keep: 30 },
        'pkz-nav.json': { every: 600, keep: 30 },
        'flight-comments.json': { every: 3600, keep: 24 },
        'creative-layouts.json': { every: 3600, keep: 20 }
    };
    const lastBackupAt = {};
    let serverHistory = false;

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
            if (res.ok) {
                const caps = await res.json();
                serverWrite = !!caps.sharedWrite;
                serverHistory = !!caps.history;
            }
        } catch { serverWrite = false; }
        if (serverWrite && !rootHandle) linkStatus = 'server';
        return serverWrite;
    }

    async function writeViaServer(filename, data, opts) {
        if (!(await detectServerWrite())) return false;
        try {
            const headers = { 'Content-Type': 'application/json' };
            if (opts && opts.forceBackup) headers['X-Krasavia-Backup'] = 'force';
            const res = await fetch(`./${SHARED_DIR}/${filename}`, {
                method: 'PUT',
                headers,
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

    // Исходный текст прочитанного JSON — для снимка: его копию в браузер дешевле хранить строкой.
    const rawTextOf = new WeakMap();

    function parseJsonText(text) {
        if (!text || !text.trim()) return null;
        const data = JSON.parse(text);
        if (data && typeof data === 'object' && text.length > 100000) rawTextOf.set(data, text);
        return data;
    }

    // Архив продаж: shared/history/curves-ГГГГ-ММ.json и slices-ГГГГ-ММ.json (см. sales-archive.js).
    const HISTORY_FILE_RE = /^history\/(curves|slices)-\d{4}-\d{2}\.json$/;
    // Отметки «Управления продажами»: у каждого автора свой файл за месяц — никто не перезаписывает чужое.
    const MARKS_FILE_RE = /^sales-marks\/\d{4}-\d{2}\/[a-z0-9_]{1,40}\.json$/;
    const MARKS_DIR_RE = /^sales-marks\/\d{4}-\d{2}$/;

    function isAllowedSharedFile(filename) {
        const name = String(filename || '');
        return ALLOWED_FILES.has(name) || HISTORY_FILE_RE.test(name) || MARKS_FILE_RE.test(name);
    }

    // Папка и имя файла внутри shared/ (для архива — подпапка history/).
    async function resolveSharedTarget(sharedDir, filename, create) {
        const parts = filename.split('/');
        const name = parts.pop();
        let dir = sharedDir;
        for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: !!create });
        return { dir, name };
    }

    // Чтение с различием «файла нет» и «не удалось прочитать»: писать поверх непрочитанного нельзя.
    // { ok: true, data } — прочитан; { ok: true, data: null } — файла нет; { ok: false } — ошибка/нет доступа.
    async function readJsonFileStrict(filename) {
        if (!isAllowedSharedFile(filename)) return { ok: false };
        if (await detectServerWrite()) {
            try {
                const res = await fetch(`./${SHARED_DIR}/${filename}`, { cache: 'no-store' });
                if (res.status === 404) return { ok: true, data: null };
                if (!res.ok) return { ok: false };
                const text = await res.text();
                return { ok: true, data: text.trim() ? JSON.parse(text) : null };
            } catch (e) {
                return { ok: false };
            }
        }
        const handle = rootHandle || await restoreRootHandle();
        if (!handle) return { ok: false };
        try {
            const sharedDir = await getSharedDirFromHandle(handle);
            let target;
            try {
                target = await resolveSharedTarget(sharedDir, filename, false);
            } catch (e) {
                if (e && e.name === 'NotFoundError') return { ok: true, data: null };
                throw e;
            }
            let file;
            try {
                file = await (await target.dir.getFileHandle(target.name)).getFile();
            } catch (e) {
                if (e && e.name === 'NotFoundError') return { ok: true, data: null };
                throw e;
            }
            const text = await file.text();
            return { ok: true, data: text.trim() ? JSON.parse(text) : null };
        } catch (e) {
            console.warn('readJsonFileStrict', filename, e);
            return { ok: false };
        }
    }

    // Список .json в папке отметок (sales-marks/ГГГГ-ММ). null — нет доступа.
    async function listSharedDir(dir) {
        if (!MARKS_DIR_RE.test(String(dir || ''))) return null;
        if (await detectServerWrite()) {
            try {
                const res = await fetch(`./__krasavia/list?dir=${encodeURIComponent(dir)}`, { cache: 'no-store' });
                if (res.ok) return (await res.json()).files || [];
            } catch (e) { /* попробуем через папку */ }
        }
        const handle = rootHandle || await restoreRootHandle();
        if (!handle) return null;
        try {
            const sharedDir = await getSharedDirFromHandle(handle);
            let folder = sharedDir;
            try {
                for (const part of dir.split('/')) folder = await folder.getDirectoryHandle(part);
            } catch (e) {
                return [];
            }
            const out = [];
            for await (const [name, entry] of folder.entries()) {
                if (entry.kind === 'file' && /^[a-z0-9_]{1,40}\.json$/.test(name)) out.push(name);
            }
            return out;
        } catch (e) {
            console.warn('listSharedDir', dir, e);
            return null;
        }
    }

    async function readViaFetch(filename) {
        if (!isAllowedSharedFile(filename)) return null;
        // file:// — CORS блокирует fetch соседних файлов; не вызываем, чтобы не засорять консоль
        if (typeof location !== 'undefined' && location.protocol === 'file:') return null;
        try {
            const res = await fetch(`./${SHARED_DIR}/${filename}`, { cache: 'no-store' });
            if (!res.ok) return null;
            return parseJsonText(await res.text());
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
            const target = await resolveSharedTarget(sharedDir, filename, false);
            const fileHandle = await target.dir.getFileHandle(target.name);
            const file = await fileHandle.getFile();
            return parseJsonText(await file.text());
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

    function historyStamp(ms) {
        const d = new Date(ms);
        const p = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
    }

    // Версии файла в shared/_history/<имя>/ — от новых к старым.
    async function listHistoryDir(histDir, base, withTimes) {
        const items = [];
        for await (const [name, entry] of histDir.entries()) {
            if (entry.kind !== 'file' || !name.startsWith(base + '__') || !name.endsWith('.json')) continue;
            const item = { id: name, entry };
            if (withTimes) {
                try {
                    const f = await entry.getFile();
                    item.size = f.size;
                    item.lastModified = f.lastModified;
                } catch { /* пропускаем */ }
            }
            items.push(item);
        }
        return items.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    }

    // Копия текущей версии перед перезаписью (запись без сервера). Ошибка копии запись не останавливает.
    async function backupViaHandle(sharedDir, filename, force) {
        const pol = HISTORY_POLICY[filename];
        if (!pol) return;
        const now = Date.now();
        if (!force && lastBackupAt[filename] && now - lastBackupAt[filename] < pol.every * 1000) return;
        try {
            let current;
            try {
                current = await (await sharedDir.getFileHandle(filename)).getFile();
            } catch {
                return; // файла ещё нет — копировать нечего
            }
            const base = filename.slice(0, -5);
            const root = await sharedDir.getDirectoryHandle(HISTORY_DIR, { create: true });
            const histDir = await root.getDirectoryHandle(base, { create: true });
            const items = await listHistoryDir(histDir, base, true);
            const newest = items.reduce((m, it) => Math.max(m, it.lastModified || 0), 0);
            if (!force && newest && now - newest < pol.every * 1000) {
                lastBackupAt[filename] = newest;
                return;
            }
            const name = `${base}__${historyStamp(current.lastModified || now)}.json`;
            if (!items.some(it => it.id === name)) {
                const fh = await histDir.getFileHandle(name, { create: true });
                const w = await fh.createWritable();
                await w.write(current);
                await w.close();
                items.unshift({ id: name });
                items.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
            }
            lastBackupAt[filename] = now;
            for (const old of items.slice(pol.keep)) {
                try { await histDir.removeEntry(old.id); } catch { /* ignore */ }
            }
        } catch (e) {
            console.warn('backupViaHandle', filename, e);
        }
    }

    function historyFileNameOk(filename, id) {
        if (!HISTORY_POLICY[filename]) return false;
        const base = filename.slice(0, -5);
        return new RegExp('^' + base.replace(/[-.]/g, '\\$&') + '__\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2}\\.json$').test(String(id || ''));
    }

    // Список резервных копий: { 'profiles.json': [{ id, size }], ... }.
    async function listHistory() {
        if (await detectServerWrite() && serverHistory) {
            try {
                const res = await fetch('./__krasavia/history', { cache: 'no-store' });
                if (res.ok) return (await res.json()).files || {};
            } catch { /* попробуем через папку */ }
        }
        const handle = rootHandle || await restoreRootHandle();
        if (!handle) return null;
        const out = {};
        try {
            const sharedDir = await getSharedDirFromHandle(handle);
            const root = await sharedDir.getDirectoryHandle(HISTORY_DIR, { create: true });
            for (const filename of Object.keys(HISTORY_POLICY)) {
                const base = filename.slice(0, -5);
                let dir = null;
                try { dir = await root.getDirectoryHandle(base); } catch { /* нет копий */ }
                out[filename] = dir ? (await listHistoryDir(dir, base, true)).map(it => ({ id: it.id, size: it.size || 0 })) : [];
            }
        } catch (e) {
            console.warn('listHistory', e);
            return null;
        }
        return out;
    }

    async function readHistory(filename, id) {
        if (!historyFileNameOk(filename, id)) return null;
        const base = filename.slice(0, -5);
        if (await detectServerWrite() && serverHistory) {
            try {
                const res = await fetch(`./${SHARED_DIR}/${HISTORY_DIR}/${base}/${id}`, { cache: 'no-store' });
                if (res.ok) return JSON.parse(await res.text());
            } catch { /* попробуем через папку */ }
        }
        const handle = rootHandle || await restoreRootHandle();
        if (!handle) return null;
        try {
            const sharedDir = await getSharedDirFromHandle(handle);
            const dir = await (await sharedDir.getDirectoryHandle(HISTORY_DIR)).getDirectoryHandle(base);
            const text = await (await (await dir.getFileHandle(id)).getFile()).text();
            return JSON.parse(text);
        } catch (e) {
            console.warn('readHistory', e);
            return null;
        }
    }

    // Восстановить версию: текущая версия перед этим тоже уходит в копии.
    async function restoreHistory(filename, id) {
        const data = await readHistory(filename, id);
        if (!data || typeof data !== 'object') return { ok: false, error: 'Не удалось прочитать копию' };
        lastBackupAt[filename] = 0;
        const ok = await writeViaHandle(filename, data, { forceBackup: true });
        return ok ? { ok: true, data } : { ok: false, error: 'Не удалось записать файл — подключите общую папку' };
    }

    async function writeViaHandle(filename, data, opts) {
        if (!isAllowedSharedFile(filename)) return false;
        // Сначала сервер — он всегда может записать; папка браузера — запасной путь.
        if (await writeViaServer(filename, data, opts)) return true;
        const handle = rootHandle || await restoreRootHandle();
        if (!handle) return false;
        try {
            const sharedDir = await getSharedDirFromHandle(handle);
            if (opts && opts.forceBackup) lastBackupAt[filename] = 0;
            await backupViaHandle(sharedDir, filename, !!(opts && opts.forceBackup));
            const target = await resolveSharedTarget(sharedDir, filename, true);
            const fileHandle = await target.dir.getFileHandle(target.name, { create: true });
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

    // Общий файл снимка → объект снимка, как его ждёт SessionStore.applySnapshot.
    function snapshotFromWrapper(wrapper) {
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

    async function loadSnapshot() {
        const wrapper = await readSharedJson(SNAPSHOT_FILE, 'savedAt');
        const snap = snapshotFromWrapper(wrapper);
        if (!snap) return null;
        const text = rawTextOf.get(wrapper);
        if (text) Object.defineProperty(snap, 'sharedText', { value: text, enumerable: false });
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

    // Можно ли записать общий файл без вопросов к пользователю (сервер или уже разрешённая папка).
    async function canWrite() {
        if (await detectServerWrite()) return true;
        if (rootHandle) return true;
        try {
            const db = await openIdb();
            const handle = await new Promise((resolve) => {
                const tx = db.transaction(IDB_STORE, 'readonly');
                const req = tx.objectStore(IDB_STORE).get(HANDLE_KEY);
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => resolve(null);
            });
            if (handle && await handle.queryPermission({ mode: 'readwrite' }) === 'granted') {
                rootHandle = handle;
                linkStatus = 'linked';
                return true;
            }
        } catch { /* нет доступа */ }
        return false;
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
        // Не удалось прочитать общий журнал — не пишем, иначе затрём чужие события.
        const read = await readJsonFileStrict(ACTIVITY_FILE);
        if (!read.ok) return false;
        const remote = Array.isArray(read.data?.events) ? read.data.events : [];
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
        snapshotFromWrapper,
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
        readJsonFileStrict,
        listSharedDir,
        writeJsonFile,
        canWrite,
        listHistory,
        readHistory,
        restoreHistory,
        historyFiles: () => Object.keys(HISTORY_POLICY)
    };
})();