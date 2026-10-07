// Сохранение сессии (localStorage) и снимка данных (IndexedDB) — работает при открытии index.html с диска
window.SessionStore = (function () {
    const UI_KEY = 'krasavia_ui_session';
    const IDB_NAME = 'krasavia_rms';
    const IDB_STORE = 'snapshots';
    const SNAPSHOT_KEY = 'latest';
    const SNAPSHOT_DEBOUNCE_MS = 2500;

    let lastSavedSignature = '';
    let snapshotTimer = null;
    let snapshotAnnounce = false;
    let snapshotSaving = false;
    let snapshotQueued = false;

    function openDb() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(IDB_NAME, 1);
            req.onerror = () => reject(req.error);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(IDB_STORE)) {
                    db.createObjectStore(IDB_STORE);
                }
            };
            req.onsuccess = () => resolve(req.result);
        });
    }

    let uiSessionSaveTimer = null;

    function saveUiSessionNow() {
        try {
            const payload = {
                currentTab: typeof currentTab !== 'undefined' ? currentTab : 'main',
                currentFlight: typeof currentFlight !== 'undefined' ? currentFlight : null,
                lastSelectedDate: typeof lastSelectedDate !== 'undefined' ? lastSelectedDate : null,
                tableSort: typeof tableSort !== 'undefined' ? tableSort : { by: 'date', dir: 'asc' },
                tableFilterStatus: typeof tableFilterStatus !== 'undefined' ? tableFilterStatus : 'all',
                tableExtraColsExpanded: !!tableExtraColsExpanded,
                pairColVisibility: typeof pairColVisibility !== 'undefined' ? { ...pairColVisibility } : null,
                dataShowSpecBookings: typeof dataShowSpecBookings !== 'undefined' ? !!dataShowSpecBookings : false,
                dataShowLocalTimes: typeof dataShowLocalTimes !== 'undefined' ? !!dataShowLocalTimes : false,
                showSpecBookings: typeof showSpecBookings !== 'undefined' ? !!showSpecBookings : false,
                rmsConditions: typeof rmsActiveConditions !== 'undefined' ? rmsActiveConditions : [],
                rmsRouteTypeFilter: document.getElementById('rms-route-type-filter')?.value || 'all',
                dataRouteTypeFilter: typeof dataRouteTypeFilter !== 'undefined' ? dataRouteTypeFilter : 'all',
                dataSort: typeof dataSort !== 'undefined' ? dataSort : 'route-asc',
                dataHideFlew: typeof dataHideFlew !== 'undefined' ? !!dataHideFlew : false,
                dataSearchQuery: typeof dataSearchQuery !== 'undefined' ? dataSearchQuery : '',
                dataHlRules: typeof DataBoardFilters !== 'undefined' ? DataBoardFilters.toSession() : null
            };
            localStorage.setItem(UI_KEY, JSON.stringify(payload));
        } catch (e) {
            console.warn('saveUiSession', e);
        }
    }

    /** debounce: не писать localStorage на каждый чих UI */
    function saveUiSession() {
        if (uiSessionSaveTimer) clearTimeout(uiSessionSaveTimer);
        uiSessionSaveTimer = setTimeout(saveUiSessionNow, 120);
    }

    function restoreUiSession() {
        try {
            const raw = localStorage.getItem(UI_KEY);
            if (!raw) return false;
            const s = JSON.parse(raw);
            if (s.currentTab) {
                const tab = s.currentTab === 'report' ? 'table' : s.currentTab;
                currentTab = (tab === 'ml') ? 'main' : tab;
            }
            if (s.currentFlight && typeof isValidFlightBase === 'function' && isValidFlightBase(s.currentFlight)) {
                currentFlight = s.currentFlight;
            }
            if (s.lastSelectedDate) {
                const d = String(s.lastSelectedDate).trim();
                if (typeof Security !== 'undefined') {
                    if (Security.isFlightDate(d)) lastSelectedDate = d;
                } else {
                    lastSelectedDate = s.lastSelectedDate;
                }
            }
            if (s.tableSort) tableSort = s.tableSort;
            if (s.tableFilterStatus) tableFilterStatus = s.tableFilterStatus;
            if (typeof s.tableExtraColsExpanded === 'boolean') tableExtraColsExpanded = s.tableExtraColsExpanded;
            if (s.pairColVisibility && typeof pairColVisibility !== 'undefined' && typeof s.pairColVisibility === 'object') {
                Object.keys(pairColVisibility).forEach((k) => {
                    if (typeof s.pairColVisibility[k] === 'boolean') pairColVisibility[k] = s.pairColVisibility[k];
                });
                // старое expenses = один суммарный столбец → теперь totalExpenses
                if (typeof s.pairColVisibility.totalExpenses !== 'boolean'
                    && typeof s.pairColVisibility.expenses === 'boolean'
                    && !('expenses' in s.pairColVisibility && 'totalExpenses' in s.pairColVisibility)) {
                    // если в снимке только старый ключ expenses — переносим в общие
                    // (новый expenses по ноге по умолчанию выкл.)
                }
                if (s.pairColVisibility.totalExpenses === undefined
                    && s.pairColVisibility.expenses === true
                    && s.pairColVisibility._expensesIsLeg !== true) {
                    // эвристика: старые сессии держали expenses как «общие»
                    pairColVisibility.totalExpenses = true;
                    pairColVisibility.expenses = false;
                }
            } else if (s.tableExtraColsExpanded && typeof pairColVisibility !== 'undefined') {
                // миграция со старого «плюсика»: все доп. столбцы включены
                pairColVisibility.avgFare = true;
                pairColVisibility.lastFare = true;
                pairColVisibility.revenue = true;
                pairColVisibility.totalRevenue = true;
            }
            if (Array.isArray(s.rmsConditions) && typeof normalizeRmsConditions === 'function') {
                rmsActiveConditions = normalizeRmsConditions(s.rmsConditions);
            }
            if (s.rmsRouteTypeFilter) {
                const el = document.getElementById('rms-route-type-filter');
                if (el) el.value = s.rmsRouteTypeFilter;
            }
            if (s.dataRouteTypeFilter && typeof dataRouteTypeFilter !== 'undefined') {
                dataRouteTypeFilter = s.dataRouteTypeFilter;
                const el = document.getElementById('data-route-type-filter');
                if (el) el.value = s.dataRouteTypeFilter;
            }
            if (s.dataSort && typeof dataSort !== 'undefined') {
                dataSort = s.dataSort;
                const el = document.getElementById('data-sort-select');
                if (el) el.value = s.dataSort;
            }
            if (typeof s.dataShowSpecBookings === 'boolean' && typeof dataShowSpecBookings !== 'undefined') {
                dataShowSpecBookings = s.dataShowSpecBookings;
            }
            if (typeof s.dataShowLocalTimes === 'boolean' && typeof dataShowLocalTimes !== 'undefined') {
                dataShowLocalTimes = s.dataShowLocalTimes;
            }
            if (typeof s.showSpecBookings === 'boolean' && typeof showSpecBookings !== 'undefined') {
                showSpecBookings = s.showSpecBookings;
            }
            if (typeof s.dataHideFlew === 'boolean' && typeof dataHideFlew !== 'undefined') {
                dataHideFlew = s.dataHideFlew;
                const el = document.getElementById('data-hide-flew');
                if (el) el.checked = s.dataHideFlew;
            }
            if (typeof s.dataSearchQuery === 'string' && typeof dataSearchQuery !== 'undefined') {
                dataSearchQuery = typeof Security !== 'undefined'
                    ? Security.sanitizeTextInput(s.dataSearchQuery, 120)
                    : s.dataSearchQuery;
                const el = document.getElementById('data-search-input');
                if (el) el.value = s.dataSearchQuery;
            }
            if (Array.isArray(s.dataHlRules) && typeof DataBoardFilters !== 'undefined') {
                DataBoardFilters.restore(s.dataHlRules);
            }
            if (typeof invalidateDataBoardCache === 'function') invalidateDataBoardCache();

            return true;
        } catch (e) {
            console.warn('restoreUiSession', e);
            return false;
        }
    }

    async function hasSnapshot() {
        try {
            const db = await openDb();
            return new Promise((resolve) => {
                const tx = db.transaction(IDB_STORE, 'readonly');
                const req = tx.objectStore(IDB_STORE).get(SNAPSHOT_KEY);
                req.onsuccess = () => resolve(!!req.result);
                req.onerror = () => resolve(false);
            });
        } catch {
            return false;
        }
    }

    function getSnapshotSignature() {
        return [
            allData?.length || 0,
            Object.keys(salesMap || {}).length,
            Object.keys(salesDetails || {}).length,
            closedFlights?.size || 0,
            Object.keys(expectedLoadData || {}).length,
            Object.keys(typeof baggageWeightsData !== 'undefined' ? baggageWeightsData : {}).length,
            typeof RouteCosts !== 'undefined' && RouteCosts.loaded ? 1 : 0,
            lastSalesUpdate ? lastSalesUpdate.getTime() : 0
        ].join('|');
    }

    function buildSnapshotPayload() {
        if (!Object.keys(groupedData || {}).length) return null;
        return {
            version: 1,
            savedAt: Date.now(),
            allData,
            salesMap,
            salesDetails: typeof Security !== 'undefined' ? Security.stripSalesPii(salesDetails) : salesDetails,
            closedFlights: [...closedFlights],
            expectedLoadData,
            baggageWeightsData: typeof baggageWeightsData !== 'undefined' ? baggageWeightsData : {},
            childrenByFlightDate: typeof childrenByFlightDate !== 'undefined' ? childrenByFlightDate : {},
            routeCosts: typeof RouteCosts !== 'undefined' ? RouteCosts.toSnapshot() : null,
            dataLoadStatus,
            lastSalesUpdate: lastSalesUpdate ? lastSalesUpdate.toISOString() : null
        };
    }

    async function saveLocalSnapshot(force = false) {
        const signature = getSnapshotSignature();
        if (!force && signature && signature === lastSavedSignature) return true;

        await new Promise(r => setTimeout(r, 0));
        const payload = buildSnapshotPayload();
        if (!payload) return false;
        try {
            const db = await openDb();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(IDB_STORE, 'readwrite');
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
                tx.objectStore(IDB_STORE).put(payload, SNAPSHOT_KEY);
            });
            localStorage.setItem('krasavia_snapshot_at', String(payload.savedAt));
            lastSavedSignature = signature;
            updateRestoreButtonVisibility(true);
            return true;
        } catch (e) {
            console.error('saveLocalSnapshot', e);
            if (typeof showToast === 'function') {
                showToast('Не удалось сохранить снимок данных (мало места в браузере)', 'error');
            }
            return false;
        }
    }

    async function publishSharedSnapshot(announce) {
        if (typeof ProfileAuth === 'undefined' || !ProfileAuth.hasPermission('share_data')) return false;
        if (typeof SharedStorage === 'undefined') return false;
        const ok = await SharedStorage.saveSnapshot(announce);
        if (ok && announce && typeof ActivityLog !== 'undefined') {
            const flightCount = Object.keys(groupedData || {}).length;
            ActivityLog.log('data_share', `Рейсов: ${flightCount}`);
        }
        return ok;
    }

    async function saveSnapshot(announceShared) {
        const ok = await saveLocalSnapshot();
        if (ok) {
            publishSharedSnapshot(announceShared).catch(e => console.warn('publishSharedSnapshot', e));
        }
        return ok;
    }

    function scheduleSnapshotSave(announceShared = false) {
        if (announceShared) snapshotAnnounce = true;
        if (snapshotTimer) clearTimeout(snapshotTimer);
        snapshotTimer = setTimeout(() => {
            snapshotTimer = null;
            const announce = snapshotAnnounce;
            snapshotAnnounce = false;
            runQueuedSnapshotSave(announce).catch(e => console.warn('scheduleSnapshotSave', e));
        }, SNAPSHOT_DEBOUNCE_MS);
    }

    async function runQueuedSnapshotSave(announceShared) {
        if (snapshotSaving) {
            snapshotQueued = true;
            if (announceShared) snapshotAnnounce = true;
            return false;
        }
        snapshotSaving = true;
        try {
            return await saveSnapshot(announceShared);
        } finally {
            snapshotSaving = false;
            if (snapshotQueued) {
                snapshotQueued = false;
                const announce = snapshotAnnounce;
                snapshotAnnounce = false;
                runQueuedSnapshotSave(announce).catch(e => console.warn('runQueuedSnapshotSave', e));
            }
        }
    }

    async function flushSnapshotSave(announceShared = false) {
        if (snapshotTimer) {
            clearTimeout(snapshotTimer);
            snapshotTimer = null;
        }
        if (announceShared) snapshotAnnounce = true;
        const announce = snapshotAnnounce;
        snapshotAnnounce = false;
        return runQueuedSnapshotSave(announce);
    }

    async function loadSnapshot() {
        try {
            const db = await openDb();
            const snap = await new Promise((resolve) => {
                const tx = db.transaction(IDB_STORE, 'readonly');
                const req = tx.objectStore(IDB_STORE).get(SNAPSHOT_KEY);
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => resolve(null);
            });
            if (snap && typeof Security !== 'undefined' && !Security.validateSnapshotPayload(snap)) return null;
            return snap;
        } catch {
            return null;
        }
    }

    function applySnapshot(snap) {
        if (typeof Security !== 'undefined' && !Security.validateSnapshotPayload(snap)) {
            console.warn('applySnapshot: invalid or oversized snapshot rejected');
            return false;
        }
        allData = snap.allData || [];
        salesMap = snap.salesMap || {};
        const rawDetails = snap.salesDetails || {};
        const canSeePii = typeof ProfileAuth === 'undefined'
            || (ProfileAuth.hasPermission('sales_detail') && ProfileAuth.hasPermission('load_data'));
        salesDetails = canSeePii
            ? rawDetails
            : (typeof Security !== 'undefined' ? Security.redactSalesDetails(rawDetails) : {});
        closedFlights = new Set(snap.closedFlights || []);
        expectedLoadData = snap.expectedLoadData || {};
        if (typeof baggageWeightsData !== 'undefined') {
            baggageWeightsData = snap.baggageWeightsData || {};
        }
        if (typeof childrenByFlightDate !== 'undefined') {
            childrenByFlightDate = snap.childrenByFlightDate || {};
        }
        if (typeof RouteCosts !== 'undefined') {
            RouteCosts.applySnapshot(snap.routeCosts || null);
        }
        dataLoadStatus = snap.dataLoadStatus || { availability: false, closed: false, sales: false, expected: false, weights: false, children: false, costs: false, subsidy: false };
        lastSalesUpdate = snap.lastSalesUpdate ? new Date(snap.lastSalesUpdate) : null;
        CACHED_TODAY = null;
        CACHED_YESTERDAY = null;
        processData();
        // Пересчёт продаж «сегодня/вчера/7/14/30» по актуальной дате (не по дате снимка)
        if (typeof rebuildSalesAggregatesFromDetails === 'function') {
            rebuildSalesAggregatesFromDetails();
        } else {
            invalidateMetricsCache();
            updateHeaderWithLastUpdate();
            updateHeaderStatus();
        }
        return true;
    }

    function updateRestoreButtonVisibility(visible) {
        const btn = document.getElementById('restore-data-btn');
        if (btn) btn.style.display = visible ? '' : 'none';
    }

    function renderOpenViews() {
        if (typeof switchMainTab === 'function') switchMainTab(currentTab || 'main');
    }

    async function restoreLastData(silent) {
        const snap = await loadSnapshot();
        if (!snap) {
            if (!silent && typeof showToast === 'function') showToast('Нет сохраненных данных', 'error');
            return false;
        }
        if (!applySnapshot(snap)) {
            if (!silent && typeof showToast === 'function') showToast('Снимок данных повреждён или слишком большой', 'error');
            return false;
        }
        restoreUiSession();
        renderOpenViews();
        if (!silent && typeof showToast === 'function') {
            const when = snap.savedAt ? new Date(snap.savedAt).toLocaleString('ru-RU') : '';
            showToast('Загружены последние данные' + (when ? ' (' + when + ')' : ''));
        }
        if (!silent && typeof ActivityLog !== 'undefined') {
            ActivityLog.log('data_restore', 'Последние данные');
        }
        return true;
    }

    async function pickNewestSnapshot(sharedSnap, localSnap) {
        if (sharedSnap?.savedAt && localSnap?.savedAt) {
            return sharedSnap.savedAt >= localSnap.savedAt ? sharedSnap : localSnap;
        }
        return sharedSnap?.savedAt ? sharedSnap : (localSnap || null);
    }

    async function initOnStartup() {
        const useSpinner = typeof showLoading === 'function' && typeof hideLoading === 'function';
        if (useSpinner) showLoading('Загрузка данных с диска...');
        try {
            restoreUiSession();

            let snap = null;
            let needsLocalCopy = false;
            if (typeof SharedStorage !== 'undefined') {
                await SharedStorage.init();
                const sharedSnap = await SharedStorage.loadSnapshot();
                const localSnap = await loadSnapshot();
                snap = await pickNewestSnapshot(sharedSnap, localSnap);
                if (snap && sharedSnap?.savedAt && (!localSnap?.savedAt || sharedSnap.savedAt > localSnap.savedAt)) {
                    needsLocalCopy = snap.savedAt === sharedSnap.savedAt;
                }
            } else {
                snap = await loadSnapshot();
            }

            const exists = !!snap;
            updateRestoreButtonVisibility(exists);

            if (exists) {
                if (!applySnapshot(snap)) {
                    updateRestoreButtonVisibility(false);
                } else {
                    restoreUiSession();
                    renderOpenViews();
                    if (needsLocalCopy) {
                        saveLocalSnapshot(true).catch(e => console.warn('saveLocalSnapshot', e));
                    }
                }
            } else if (typeof switchMainTab === 'function') {
                switchMainTab(currentTab || 'main');
            }
        } finally {
            if (useSpinner) hideLoading();
        }
    }

    if (typeof window !== 'undefined') {
        window.addEventListener('beforeunload', () => {
            if (uiSessionSaveTimer) {
                clearTimeout(uiSessionSaveTimer);
                uiSessionSaveTimer = null;
                saveUiSessionNow();
            }
            if (snapshotTimer || snapshotSaving || snapshotQueued) {
                flushSnapshotSave(false).catch(() => {});
            }
        });
    }

    return {
        saveUiSession,
        restoreUiSession,
        hasSnapshot,
        saveSnapshot,
        scheduleSnapshotSave,
        flushSnapshotSave,
        saveLocalSnapshot,
        publishSharedSnapshot,
        loadSnapshot,
        applySnapshot,
        restoreLastData,
        initOnStartup,
        updateRestoreButtonVisibility
    };
})();

function restoreLastData() {
    if (typeof ProfileAuth !== 'undefined' && !ProfileAuth.hasPermission('load_data')) {
        if (typeof showToast === 'function') showToast('Загрузка данных недоступна для вашего профиля', 'error');
        return Promise.resolve(false);
    }
    return SessionStore.restoreLastData(false);
}