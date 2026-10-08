// Сохранение handle папки «Загрузка» (без автообновления продаж)
window.SalesSync = (function () {
    const IDB_NAME = 'krasavia_data_fs';
    const IDB_STORE = 'handles';
    const DATA_HANDLE_KEY = 'zagruzka_root';

    let dataRootHandle = null;

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

    async function saveDataFolderHandle(handle) {
        if (!handle) return;
        const db = await openIdb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.objectStore(IDB_STORE).put(handle, DATA_HANDLE_KEY);
        });
        dataRootHandle = handle;
    }

    async function restoreDataFolderHandle() {
        if (dataRootHandle) return dataRootHandle;
        try {
            const db = await openIdb();
            const handle = await new Promise((resolve) => {
                const tx = db.transaction(IDB_STORE, 'readonly');
                const req = tx.objectStore(IDB_STORE).get(DATA_HANDLE_KEY);
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => resolve(null);
            });
            if (!handle) return null;
            const perm = await handle.queryPermission({ mode: 'readwrite' });
            if (perm === 'granted') {
                dataRootHandle = handle;
                return handle;
            }
            const readPerm = await handle.queryPermission({ mode: 'read' });
            if (readPerm === 'granted') {
                dataRootHandle = handle;
                return handle;
            }
            if (perm === 'prompt' || readPerm === 'prompt') {
                const reqPerm = await handle.requestPermission({ mode: 'readwrite' });
                if (reqPerm === 'granted') {
                    dataRootHandle = handle;
                    return handle;
                }
                const reqRead = await handle.requestPermission({ mode: 'read' });
                if (reqRead === 'granted') {
                    dataRootHandle = handle;
                    return handle;
                }
            }
        } catch (e) {
            console.warn('restoreDataFolderHandle', e);
        }
        return null;
    }

    async function initAfterLogin() {
        await restoreDataFolderHandle();
        if (typeof salesAggregatesFresh === 'function' && salesAggregatesFresh()) return;
        if (typeof rebuildSalesAggregatesFromDetails === 'function') {
            rebuildSalesAggregatesFromDetails();
        }
    }

    return {
        saveDataFolderHandle,
        restoreDataFolderHandle,
        getDataRootHandle: () => dataRootHandle,
        initAfterLogin
    };
})();
