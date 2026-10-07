// App core: shared state, tabs, boot. Domain code lives in sibling js files.


let allData = [];
let salesMap = {};
let closedFlights = new Set();
let groupedData = {};
let currentFlight = null;
let salesDetails = {};
let currentTab = 'main';
let lastSelectedDate = null;
let lastSalesUpdate = null;

let expectedLoadData = {};
let showExpectedLoadColumn = false;

// Фильтры и сортировка таблицы рейса (сбрасываются при смене рейса)
let tableSort = { by: 'date', dir: 'asc' }; // date | load | sales | avgfare
let tableFilterStatus = 'all'; // all | open | closed | full
/** @deprecated оставлено для миграции сессии; экономическая таблица использует pairColVisibility */
let tableExtraColsExpanded = false;
/** Видимость доп. столбцов экономической таблицы (галочки на панели) */
let pairColVisibility = {
    avgFare: false,
    lastFare: false,
    revenue: false,
    legSubsidy: false,     // субсидия туда / обратно (между выручкой и себестоимостью)
    expenses: false,       // себестоимость на направление
    totalRevenue: false,
    subsidy: false,        // субсидия на рейсе (между общей выручкой и общими расходами)
    totalExpenses: false,
    finResult: false       // фин. рез — последний столбец
};

// Избранные рейсы — отдельно для каждого профиля (localStorage)
let pinnedFlights = new Set();

function getPinnedStorageKey() {
    const id = (typeof ProfileAuth !== 'undefined' && ProfileAuth.getCurrentProfile()?.id) || 'guest';
    return `krasavia_pinned_${id}`;
}

function loadPinnedFlights() {
    try {
        pinnedFlights = new Set(JSON.parse(localStorage.getItem(getPinnedStorageKey()) || '[]'));
    } catch {
        pinnedFlights = new Set();
    }
}

let flightOpenMode = 'table';

function getFlightOpenModeStorageKey() {
    const id = (typeof ProfileAuth !== 'undefined' && ProfileAuth.getCurrentProfile()?.id) || 'guest';
    return `krasavia_open_mode_${id}`;
}

function loadFlightOpenMode() {
    try {
        const saved = localStorage.getItem(getFlightOpenModeStorageKey());
        flightOpenMode = saved === 'pair' ? 'pair' : 'table';
    } catch {
        flightOpenMode = 'table';
    }
    if (typeof updateFlightOpenModeUI === 'function') updateFlightOpenModeUI();
}

function saveFlightOpenMode() {
    try {
        localStorage.setItem(getFlightOpenModeStorageKey(), flightOpenMode);
    } catch { /* ignore */ }
}

function setFlightOpenMode(mode, persist = true) {
    if (mode !== 'table' && mode !== 'pair') return;
    flightOpenMode = mode;
    if (persist) saveFlightOpenMode();
    updateFlightOpenModeUI();
}

function updateFlightOpenModeUI() {
    const wrap = document.getElementById('flight-open-mode');
    if (!wrap) return;

    const canTable = typeof ProfileAuth === 'undefined' || ProfileAuth.canAccessTab('table');
    const canPair = typeof ProfileAuth === 'undefined' || ProfileAuth.canAccessTab('pair');

    if (!canTable && !canPair) {
        wrap.style.display = 'none';
        return;
    }
    wrap.style.display = '';

    const btnTable = document.getElementById('flight-open-mode-table');
    const btnPair = document.getElementById('flight-open-mode-pair');
    if (btnTable) btnTable.style.display = canTable ? '' : 'none';
    if (btnPair) btnPair.style.display = canPair ? '' : 'none';

        if (flightOpenMode === 'pair' && !canPair) {
        flightOpenMode = canTable ? 'table' : 'pair';
        saveFlightOpenMode();
    } else if (flightOpenMode === 'table' && !canTable) {
        flightOpenMode = 'pair';
        saveFlightOpenMode();
    }

    btnTable?.classList.toggle('active', flightOpenMode === 'table');
    btnPair?.classList.toggle('active', flightOpenMode === 'pair');
}

function resolveFlightOpenTab() {
    let mode = flightOpenMode;
    if (typeof ProfileAuth !== 'undefined') {
        const canTable = ProfileAuth.canAccessTab('table');
        const canPair = ProfileAuth.canAccessTab('pair');
        if (mode === 'pair' && !canPair) mode = canTable ? 'table' : null;
        if (mode === 'table' && !canTable) mode = canPair ? 'pair' : null;
        if (!mode) return ProfileAuth.getFirstAllowedTab() || 'main';
    }
    return mode === 'pair' ? 'pair' : 'table';
}

function initFlightOpenModeUI() {
    const btnTable = document.getElementById('flight-open-mode-table');
    const btnPair = document.getElementById('flight-open-mode-pair');
    if (btnTable && !btnTable.dataset.bound) {
        btnTable.dataset.bound = '1';
        btnTable.addEventListener('click', () => setFlightOpenMode('table'));
    }
    if (btnPair && !btnPair.dataset.bound) {
        btnPair.dataset.bound = '1';
        btnPair.addEventListener('click', () => setFlightOpenMode('pair'));
    }
}


let dataRouteTypeFilter = 'all';
let dataSort = 'route-asc';
let dataHideFlew = false;
let dataSearchQuery = '';
let dataSearchTimer = null;
let dataBoardRenderCache = { sig: '', html: '', stats: '' };
let dataBoardRenderGen = 0;

const TAB_HOST_CLASSES = {
    main: 'content-area',
    table: 'content-area',
    pkz: 'content-area',
    pair: 'content-area',
    costs: 'content-area content-costs',
    rms: 'content-area content-rms',
    data: 'content-area content-data',
    sales: 'content-area content-sales',
    home: 'content-area content-home',
    stats: 'content-area content-stats'
};
const tabPanels = {};
const tabPanelsBuilt = {};
const tabPanelState = {
    table: { flight: null, date: null, sig: '' },
    pkz: { flight: null, date: null, sig: '' },
    pair: { flight: null, date: null, sig: '' }
};


function getDeltaFromExpected(actualLoad, expectedLoad) {
    if (expectedLoad === null || expectedLoad === undefined) return { delta: null, cls: '' };
    const delta = Math.round(actualLoad - expectedLoad);
    let cls = 'delta-green';
    if (delta < -5) cls = 'delta-red';
    else if (delta < 0) cls = 'delta-yellow';
    return { delta, cls };
}

function getFlightRowForDate(baseFlight, flyDateStr, flightCode) {
    const rows = groupedData[baseFlight] || [];
    if (flightCode) {
        const code = cleanFlight(flightCode);
        return rows.find(r => r[1] === flyDateStr && cleanFlight(r[0]) === code) || null;
    }
    return rows.find(r => r[1] === flyDateStr && cleanFlight(r[0]) === baseFlight)
        || rows.find(r => r[1] === flyDateStr)
        || null;
}

function getPkzContextForFlight(baseFlight, flyDateStr, flightCode) {
    const code = flightCode ? cleanFlight(flightCode) : baseFlight;
    const flightRow = getFlightRowForDate(baseFlight, flyDateStr, code);
    if (!flightRow || typeof getPkzFlightDetails !== 'function') return null;

    const bucketRows = groupedData[baseFlight] || [];
    const firstSalesByKey = buildFirstSalesRowByKey(bucketRows);
    const showSales = shouldAttachSalesToRowCached(flightRow, firstSalesByKey);
    const salesList = showSales ? getSalesDetailsForRow(flightRow) : [];
    const details = getPkzFlightDetails(flightRow, code, { salesList, showSales });
    if (!details) return null;

    return { flightRow, details, salesList, showSales };
}

function appendPkzAdjustPanel(resultDiv, baseFlight, flyDateStr, flightCode) {
    if (!resultDiv || typeof buildPkzAdjustPanelHtml !== 'function') return '';
    const ctx = getPkzContextForFlight(baseFlight, flyDateStr, flightCode);
    if (!ctx) return '';
    const code = flightCode ? cleanFlight(flightCode) : baseFlight;
    const navKg = typeof getPkzNavValue === 'function' ? getPkzNavValue(flyDateStr, code) : null;
    const html = buildPkzAdjustPanelHtml(ctx.details, {
        date: flyDateStr,
        flightCode: code,
        navKg
    });
    if (html) {
        resultDiv.insertAdjacentHTML('afterbegin', html);
        if (typeof bindPkzAdjustPanel === 'function') bindPkzAdjustPanel(resultDiv);
    }
    return html;
}

/** Скрыть плашку «кол-во / сумма / среднее» (например при детализации) */
function hideSelectionStatusBar() {
    document.getElementById('selection-status-bar')?.classList.remove('is-visible');
    if (typeof clearActiveTableSelection === 'function') {
        clearActiveTableSelection();
        return;
    }
    const marked = document.getElementsByClassName('tbl-sel');
    if (!marked.length) return;
    Array.from(marked).forEach((el) => {
        el.classList.remove('tbl-sel', 'tbl-sel-col', 'tbl-sel-row', 'tbl-sel-cell');
    });
}

function getExpectedLoadForFlightDate(baseFlight, flyDateStr, aircraftCode) {
    const ac = getAircraftType(aircraftCode);
    const cap = getCapacityFromAircraft(ac);
    const du = getDaysUntil(flyDateStr);
    const wk = getWeekForExpectedLoad(flyDateStr);
    return getExpectedLoad(cap, baseFlight, du, wk);
}

let dataLoadStatus = { availability: false, closed: false, sales: false, expected: false, weights: false, children: false, costs: false, subsidy: false };
let tableFlightSearchQuery = '';
let salesChartPeriodDays = 30;

function updateHeaderStatus() {
    const statusBar = document.getElementById('data-status-bar');
    const kpiBar = document.getElementById('header-kpi');
    if (statusBar) {
        const ready = !!dataLoadStatus.availability && Object.keys(groupedData || {}).length > 0;
        statusBar.hidden = !ready;
        statusBar.title = '';
        statusBar.textContent = ready ? '✓' : '';
    }
    if (window.ingestQuiet) return;
    if (kpiBar && Object.keys(groupedData).length) {
        const k = getGlobalKPIs();
        const salesReady = typeof hasSalesFileLoaded === 'function' ? hasSalesFileLoaded() : !!(dataLoadStatus && dataLoadStatus.sales);
        const sales = Number(k.todaySales) || 0;
        const revK = Math.round((Number(k.todayRevenue) || 0) / 1000);
        const alerts = Number(k.alertCount) || 0;
        const canRms = typeof ProfileAuth === 'undefined' || ProfileAuth.canAccessTab('rms');
        kpiBar.replaceChildren();
        const item = (strong, rest) => {
            const wrap = document.createElement('span');
            wrap.className = 'header-kpi-item';
            const b = document.createElement('strong');
            b.textContent = String(strong);
            wrap.append(b, document.createTextNode(' ' + rest));
            return wrap;
        };
        kpiBar.append(item(salesReady ? sales : '—', 'продаж'), item(salesReady ? (revK + 'к') : '—', '₽'));
        if (alerts) {
            const al = document.createElement('span');
            al.className = 'header-kpi-alert';
            al.textContent = '⚠ ' + alerts;
            if (canRms) al.addEventListener('click', () => switchMainTab('rms'));
            kpiBar.append(al);
        }
        kpiBar.classList.remove('hidden');
    }
}

function savePinnedFlights() {
    try {
        localStorage.setItem(getPinnedStorageKey(), JSON.stringify([...pinnedFlights]));
    } catch (e) { /* ignore */ }
}

function togglePinFlight(base, event) {
    event.stopImmediatePropagation();
    if (pinnedFlights.has(base)) {
        pinnedFlights.delete(base);
    } else {
        pinnedFlights.add(base);
    }
    savePinnedFlights();
}


let tableHtmlCache = { sig: '', html: '' };

function getExpectedLoad(cap,fl,du,wk){if(du===null||du<0)return null;let k=`${cap}|${fl}|${du}|${wk}`;if(expectedLoadData[k]!==undefined)return expectedLoadData[k];for(let o of[-1,1]){if(expectedLoadData[`${cap}|${fl}|${du+o}|${wk}`]!==undefined)return expectedLoadData[`${cap}|${fl}|${du+o}|${wk}`]}for(let o of[-1,1]){if(expectedLoadData[`${cap}|${fl}|${du}|${wk+o}`]!==undefined)return expectedLoadData[`${cap}|${fl}|${du}|${wk+o}`]}return null}


function emptySalesBucket() {
    return { today: 0, yesterday: 0, day2: 0, d7: 0, d14: 0, d30: 0 };
}

/**
 * Пересчёт salesMap / KPI из salesDetails по текущей дате.
 * Нужен после восстановления снимка: «сегодня/вчера» в snapshot устаревают на следующий день.
 */
function rebuildSalesAggregatesFromDetails() {
    const details = salesDetails || {};
    if (!Object.keys(details).length) {
        // Нет детализации — salesMap из снимка оставляем как есть
        if (typeof invalidateMetricsCache === 'function') invalidateMetricsCache();
        if (typeof updateHeaderStatus === 'function') updateHeaderStatus();
        return false;
    }
    const dates = getTodayYesterday();
    const todayStart = dates.todayStart || (() => { const t = new Date(); t.setHours(0, 0, 0, 0); return t; })();
    const nextMap = {};

    if (typeof PerfCache !== 'undefined') PerfCache.resetSalesStats();

    Object.keys(details).forEach(k => {
        const list = details[k];
        if (!Array.isArray(list) || !list.length) return;
        let bucket = nextMap[k];
        if (!bucket) bucket = nextMap[k] = emptySalesBucket();

        list.forEach(sale => {
            const deal = sale?.dealDate;
            if (!deal) return;
            if (deal === dates.today) bucket.today++;
            else if (deal === dates.yesterday) bucket.yesterday++;
            else if (deal === dates.day2) bucket.day2++;

            const daysAgo = daysBetweenDates(deal, todayStart);
            if (daysAgo !== null && daysAgo >= 0) {
                if (daysAgo < 7) bucket.d7++;
                if (daysAgo < 14) bucket.d14++;
                if (daysAgo < 30) bucket.d30++;
            }

            if (typeof PerfCache !== 'undefined') {
                const adj = sale.adjustedFare != null ? sale.adjustedFare : (sale.fare || 0);
                const nf = sale.fare || 0;
                PerfCache.recordSaleStat(k, deal, adj, nf, sale.basicFareStr || '', dates.today, dates.yesterday);
            }
        });
    });

    salesMap = nextMap;
    const hasSales = Object.keys(salesMap).length > 0;
    if (typeof dataLoadStatus !== 'undefined') {
        dataLoadStatus.sales = hasSales || !!dataLoadStatus.sales;
        if (hasSales) dataLoadStatus.sales = true;
    }
    tableHtmlCache = { sig: '', html: '' };
    if (typeof invalidateTabPanelState === 'function') invalidateTabPanelState();
    if (typeof invalidateMetricsCache === 'function') invalidateMetricsCache();
    if (typeof updateHeaderWithLastUpdate === 'function') updateHeaderWithLastUpdate();
    if (typeof updateHeaderStatus === 'function') updateHeaderStatus();
    if (typeof publishRmsWidgetSnapshot === 'function') publishRmsWidgetSnapshot();
    return hasSales;
}


function toggleReturnFlight() {
    if (!currentFlight) return;
    const pair = getFlightPair(currentFlight);
    if (!pair?.inbound || !pair?.outbound) return;
    const next = currentFlight === pair.outbound ? pair.inbound : pair.outbound;
    if (!isValidFlightBase(next) && !groupedData[getBaseFlight(next)]) {
        // still try open if data under base bucket
    }
    const target = (groupedData[getBaseFlight(next)] || []).length ? next
        : ((groupedData[getBaseFlight(pair.outbound)] || []).length ? (currentFlight === pair.outbound ? pair.inbound : pair.outbound) : null);
    if (!target) {
        if (typeof showToast === 'function') showToast('Обратный рейс не найден в данных', 'error');
        return;
    }
    selectFlight(target, lastSelectedDate);
}

function switchToTableFlightBySearch(query) {
    const q = String(query || '').trim().toLowerCase().replace(/[^\d]/g, '');
    if (!q) return;
    const want = 'KV-' + parseInt(q, 10);
    if (!want || want === 'KV-NaN') return;
    const bases = getValidFlightBases();
    const hit = bases.find(b => b === want || b.replace('KV-', '') === q)
        || bases.find(b => getBaseFlight(b) === getBaseFlight(want));
    if (hit) selectFlight(hit, lastSelectedDate);
    else if (typeof showToast === 'function') showToast('Рейс не найден: ' + want, 'error');
}


function updateHeaderWithLastUpdate(){
    const el=document.getElementById('last-update-text');
    if(!el||!lastSalesUpdate)return;
    el.textContent=lastSalesUpdate.toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
    document.getElementById('last-update-info').classList.remove('hidden');
}

function ensureTabPanel(tab) {
    const host = document.getElementById('main-content-inner');
    if (!host) return null;
    if (!tabPanels[tab]) {
        const panel = document.createElement('div');
        panel.id = 'tab-panel-' + tab;
        panel.className = 'tab-panel';
        panel.hidden = true;
        host.appendChild(panel);
        tabPanels[tab] = panel;
    }
    return tabPanels[tab];
}

function getTableRenderSig() {
    const pairSig = [
        pairColVisibility.avgFare ? 1 : 0,
        pairColVisibility.lastFare ? 1 : 0,
        pairColVisibility.revenue ? 1 : 0,
        pairColVisibility.legSubsidy ? 1 : 0,
        pairColVisibility.expenses ? 1 : 0,
        pairColVisibility.totalRevenue ? 1 : 0,
        pairColVisibility.subsidy ? 1 : 0,
        pairColVisibility.totalExpenses ? 1 : 0,
        pairColVisibility.finResult ? 1 : 0
    ].join('');
    return `${getMetricsCacheSignature()}|${tableSort.by}|${tableSort.dir}|${tableFilterStatus}|p${pairSig}|b${showSpecBookings ? 1 : 0}`;
}

function invalidateTabPanelState() {
    tabPanelState.table = { flight: null, date: null, sig: '' };
    tabPanelState.pkz = { flight: null, date: null, sig: '' };
    tabPanelState.pair = { flight: null, date: null, sig: '' };
    tableHtmlCache = { sig: '', html: '' };
    ['table-container', 'pair-table-container', 'pkz-table-container'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) delete el.dataset.renderSig;
    });
    // НЕ вызывать invalidateMetricsCache — она сама зовёт invalidateTabPanelState (цикл → stack overflow)
    if (typeof invalidateDataBoardCache === 'function') invalidateDataBoardCache();
    if (typeof invalidateTimelineCache === 'function') invalidateTimelineCache();
}

function refreshTabPanel(tab) {
    if (tab === 'main') {
        const content = document.getElementById('timeline-content');
        const sig = typeof getTimelineCacheSignature === 'function' ? getTimelineCacheSignature() : '';
        if (content && content.dataset.renderSig === sig && content.childElementCount > 0) return;
        if (typeof renderTimeline === 'function') renderTimeline();
        return;
    }
    if (tab === 'data') {
        const track = document.getElementById('data-board-track');
        const sig = typeof getDataBoardCacheSignature === 'function' ? getDataBoardCacheSignature() : '';
        if (track && track.dataset.renderSig === sig && track.childElementCount > 0) {
            if (typeof syncDataBoardToolbar === 'function') syncDataBoardToolbar();
            return;
        }
        renderDataBoard();
        return;
    }
    if (tab === 'rms') {
        if (typeof renderRmsWatchlist === 'function') renderRmsWatchlist();
        return;
    }
    if (tab === 'home') {
        if (typeof NetworkMap !== 'undefined' && NetworkMap.refresh) NetworkMap.refresh();
        return;
    }
    if (tab === 'costs') {
        if (typeof refreshCostCalc === 'function') refreshCostCalc();
        return;
    }
    if (tab === 'sales') {
        if (typeof refreshSalesManagement === 'function') refreshSalesManagement(false, true);
        return;
    }
    if (tab === 'table') {
        const sig = getTableRenderSig();
        const st = tabPanelState.table;
        if (currentFlight && (st.flight !== currentFlight || st.date !== lastSelectedDate || st.sig !== sig)) {
            actuallyRenderTable(currentFlight, lastSelectedDate);
            tabPanelState.table = { flight: currentFlight, date: lastSelectedDate, sig };
        }
        return;
    }
    if (tab === 'pkz') {
        const sig = getTableRenderSig();
        const st = tabPanelState.pkz;
        if (currentFlight && (st.flight !== currentFlight || st.date !== lastSelectedDate || st.sig !== sig)) {
            actuallyRenderPkzTable(currentFlight, lastSelectedDate);
            tabPanelState.pkz = { flight: currentFlight, date: lastSelectedDate, sig };
        }
        return;
    }
    if (tab === 'pair') {
        const sig = getTableRenderSig();
        const st = tabPanelState.pair;
        if (currentFlight && (st.flight !== currentFlight || st.date !== lastSelectedDate || st.sig !== sig)) {
            actuallyRenderPairTable(currentFlight, lastSelectedDate);
            tabPanelState.pair = { flight: currentFlight, date: lastSelectedDate, sig };
        }
    }
}

function switchMainTab(tab){
    if (tab === 'report') tab = 'table';
    if (tab === 'ml') tab = 'main';
    if (tab === 'agent') tab = 'main';
    if (typeof ProfileAuth !== 'undefined' && !ProfileAuth.canAccessTab(tab)) {
        const fallback = ProfileAuth.getFirstAllowedTab();
        if (fallback && fallback !== tab) {
            switchMainTab(fallback);
            return;
        }
        if (typeof showToast === 'function') showToast('Вкладка недоступна для вашего профиля', 'error');
        return;
    }
    if (tab !== 'home' && typeof NetworkMap !== 'undefined' && NetworkMap.pauseLive) {
        NetworkMap.pauseLive();
    }
    currentTab=tab;
    closeChartExpandModal();
    if (typeof closeTableSalesPanel === 'function') closeTableSalesPanel();
    if (typeof hideSelectionStatusBar === 'function') hideSelectionStatusBar();
    const host = document.getElementById('main-content-inner');
    if (!host) return;

    host.className = TAB_HOST_CLASSES[tab] || 'content-area';
    Object.values(tabPanels).forEach(p => { p.hidden = true; });

    const panel = ensureTabPanel(tab);
    if (!panel) return;
    panel.hidden = false;

    ['tab-home','tab-main','tab-table','tab-pkz','tab-pair','tab-costs','tab-rms','tab-sales','tab-data','tab-stats'].forEach(id=>{
        const b = document.getElementById(id);
        if (!b) return;
        b.classList.remove('tab-active');
        b.setAttribute('aria-selected', 'false');
    });
    const activeBtn = document.getElementById('tab-'+tab);
    if (activeBtn) {
        activeBtn.classList.add('tab-active');
        activeBtn.setAttribute('aria-selected', 'true');
    }

    if (!tabPanelsBuilt[tab]) {
        if (tab === 'main') createMainTimelineView(panel);
        else if (tab === 'table') createTableView(panel);
        else if (tab === 'pkz') createPkzView(panel);
        else if (tab === 'pair') createPairTableView(panel);
        else if (tab === 'costs') createCostCalcView(panel);
        else if (tab === 'rms') createRmsView(panel);
        else if (tab === 'data') createDataView(panel);
        else if (tab === 'sales' && typeof createSalesManagementView === 'function') createSalesManagementView(panel);
        else if (tab === 'home' && typeof NetworkMap !== 'undefined') NetworkMap.createView(panel);
        else if (tab === 'stats') createStatsView(panel);
        else createMainTimelineView(panel);
        tabPanelsBuilt[tab] = true;
    } else {
        requestAnimationFrame(() => {
            if (currentTab === tab) refreshTabPanel(tab);
        });
    }

    requestAnimationFrame(() => {
        if (currentTab === tab) applyViewZoom(tab);
    });
    if (typeof SessionStore !== 'undefined') SessionStore.saveUiSession();
    if (typeof ActivityLog !== 'undefined') {
        const tabLabel = ActivityLog.TAB_LABELS?.[tab] || tab;
        ActivityLog.log('tab', tabLabel, { tab });
    }
}


function openFlightFromRms(base, date, orig) {
    // RMS: не уводим на другую вкладку
    currentFlight = base;
    lastSelectedDate = date || null;
    if (typeof SessionStore !== 'undefined') SessionStore.saveUiSession();
}


function refreshCurrentView(){
    const mc=document.getElementById('main-content-inner');
    if(!mc)return;
    if (typeof refreshTabPanel === 'function') {
        if (currentTab === 'stats' && typeof createStatsView === 'function' && tabPanels.stats) {
            createStatsView(tabPanels.stats);
        } else {
            refreshTabPanel(currentTab);
        }
    } else if(currentTab==='main'){
        if(typeof renderTimeline==='function')renderTimeline();
    }
    else if(currentTab==='rms')renderRmsWatchlist();
    else if(currentTab==='home'&&typeof NetworkMap!=='undefined')NetworkMap.refresh();
    else if(currentTab==='pair'&&currentFlight)actuallyRenderPairTable(currentFlight,lastSelectedDate);
    else if(currentTab==='table'&&currentFlight)actuallyRenderTable(currentFlight,lastSelectedDate);
    else if(currentTab==='pkz'&&currentFlight)actuallyRenderPkzTable(currentFlight,lastSelectedDate);
    else if(currentTab==='data'&&typeof renderDataBoard==='function')renderDataBoard();
    else if(currentTab==='costs'&&typeof refreshCostCalc==='function')refreshCostCalc();
    updateHeaderStatus();
}

function initKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && document.getElementById('chart-expand-modal')?.classList.contains('open')) {
            closeChartExpandModal();
            return;
        }
        if (e.key === 'Escape' && document.getElementById('timeline-order-modal')?.classList.contains('open')) {
            closeTimelineOrderModal();
            return;
        }
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') {
            if (e.key === 'Escape') e.target.blur();
            return;
        }
        // поиск рейсов — в панели таблицы, если есть
        if (e.key === '/') {
            e.preventDefault();
            document.getElementById('table-flight-search')?.focus()
                || document.getElementById('data-search-input')?.focus();
        }
        if (e.key === 'Escape' && document.getElementById('profile-admin-modal')?.classList.contains('open')) {
            if (typeof ProfileAuth !== 'undefined') ProfileAuth.closeAdminPanel?.();
            return;
        }
        if (e.key === 'Escape' && document.getElementById('profile-settings-modal')?.classList.contains('open')) {
            return;
        }
        if (e.key === 'Escape' && typeof collapseAllTimelineDates === 'function'
            && typeof timelineExpandedDates !== 'undefined' && timelineExpandedDates.size
            && typeof currentTab !== 'undefined' && currentTab === 'main') {
            collapseAllTimelineDates();
            return;
        }
        if (e.ctrlKey || e.metaKey) {
            if (e.key === '1' && (!ProfileAuth || ProfileAuth.canAccessTab('main'))) { e.preventDefault(); switchMainTab('main'); }
            if (e.key === '2' && (!ProfileAuth || ProfileAuth.canAccessTab('table'))) { e.preventDefault(); switchMainTab('table'); }
            if (e.key === '3' && (!ProfileAuth || ProfileAuth.canAccessTab('pkz'))) { e.preventDefault(); switchMainTab('pkz'); }
            if (e.key === '4' && (!ProfileAuth || ProfileAuth.canAccessTab('pair'))) { e.preventDefault(); switchMainTab('pair'); }
            if (e.key === '5' && (!ProfileAuth || ProfileAuth.canAccessTab('costs'))) { e.preventDefault(); switchMainTab('costs'); }
            if (e.key === '6' && (!ProfileAuth || ProfileAuth.canAccessTab('data'))) { e.preventDefault(); switchMainTab('data'); }
            if (e.key === '7' && (!ProfileAuth || ProfileAuth.canAccessTab('rms'))) { e.preventDefault(); switchMainTab('rms'); }
            if (e.key === '8' && (!ProfileAuth || ProfileAuth.canAccessTab('sales'))) { e.preventDefault(); switchMainTab('sales'); }
        }
    });
}


window.onload=()=>{
    setTimeout(async ()=>{
        applyChartRuLocale();
        initFlightOpenModeUI();
        initKeyboardShortcuts();
        initSelectionStatusBar();
        bindGlobalZoomControls();

        let loggedIn = true;
        if (typeof ProfileAuth !== 'undefined') {
            loggedIn = await ProfileAuth.init();
        } else {
            document.querySelector('.main-layout')?.classList.remove('app-locked');
            document.getElementById('login-overlay')?.classList.remove('open');
        }

        if (!loggedIn) return;

        if (typeof FlightComments !== 'undefined') {
            await FlightComments.load();
        }
        if (typeof SalesManagement !== 'undefined') {
            await SalesManagement.load();
        }
        if (typeof SharedOverrides !== 'undefined') {
            await SharedOverrides.load();
        }

        if (typeof SessionStore !== 'undefined') {
            await SessionStore.initOnStartup();
        } else {
            switchMainTab(currentTab || 'main');
        }
        if (typeof ProfileAuth !== 'undefined') ProfileAuth.applyPermissions();
        if (typeof ProfileAuth !== 'undefined' && ProfileAuth.canAccessTab('home')) {
            switchMainTab('home');
        }
        if (typeof SalesSync !== 'undefined') {
            await SalesSync.initAfterLogin();
        }
    }, 300);
};
