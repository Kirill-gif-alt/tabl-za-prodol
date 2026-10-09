// RMS-метрики и кэширование

let metricsCache = null;
let metricsCacheKey = '';
let globalKpiCache = null;
let globalKpiCacheKey = '';
let dataEpoch = 0;

function invalidateMetricsCache() {
    dataEpoch++;
    metricsCache = null;
    metricsCacheKey = '';
    globalKpiCache = null;
    globalKpiCacheKey = '';
    if (typeof invalidateTimelineCache === 'function') invalidateTimelineCache();
    if (typeof invalidateDataBoardCache === 'function') invalidateDataBoardCache();
    // только UI-кэши таблиц (без вызова invalidateMetricsCache обратно)
    if (typeof tabPanelState !== 'undefined' && tabPanelState) {
        tabPanelState.table = { flight: null, date: null, sig: '' };
        tabPanelState.pkz = { flight: null, date: null, sig: '' };
        tabPanelState.pair = { flight: null, date: null, sig: '' };
    }
    if (typeof tableHtmlCache !== 'undefined') {
        try { tableHtmlCache = { sig: '', html: '' }; } catch (_) { /* ignore */ }
    }
    // Данные поменялись — шапка тоже (обновление отложенное и одно на серию вызовов).
    if (typeof updateHeaderStatus === 'function') updateHeaderStatus();
}

function getMetricsStorageKey(row) {
    if (typeof getFlightRowKey === 'function') {
        const k = getFlightRowKey(row);
        if (k) return k;
    }
    return `${row[1]}|${cleanFlight(row[0])}`;
}

// Подпись зовётся на каждую строку таблиц: размеры объектов пересчитываем, только когда сменились
// сами объекты или эпоха данных (любая загрузка/правка вызывает invalidateMetricsCache → dataEpoch++).
let metricsSigMemo = null;
function getMetricsCacheSignature() {
    const weights = typeof baggageWeightsData !== 'undefined' ? baggageWeightsData : null;
    const today = getTodayDate();
    const m = metricsSigMemo;
    if (m && m.epoch === dataEpoch && m.all === allData && m.allLen === (allData?.length || 0) && m.sales === salesMap
        && m.weights === weights && m.closed === closedFlights && m.closedSize === closedFlights.size && m.today === today) {
        return m.sig;
    }
    const weightsCount = weights ? Object.keys(weights).length : 0;
    const sig = `${dataEpoch}|${allData?.length || 0}|${closedFlights.size}|${Object.keys(salesMap || {}).length}|${weightsCount}|${today}`;
    metricsSigMemo = { epoch: dataEpoch, all: allData, allLen: allData?.length || 0, sales: salesMap, weights, closed: closedFlights, closedSize: closedFlights.size, today, sig };
    return sig;
}

function buildMetricsCache() {
    const key = getMetricsCacheSignature();
    if (metricsCache && metricsCacheKey === key) return metricsCache;

    metricsCache = { byBase: {}, byKey: {}, upcoming: null };
    Object.keys(groupedData).filter(isValidFlightBase).forEach(base => {
        let salesToday = 0;
        let alertCount = 0;
        const salesSeen = new Set();
        (groupedData[base] || []).forEach(row => {
            if (!row[1] || !row[0]) return;
            const m = computeRowMetrics(row, base);
            metricsCache.byKey[m.rowKey] = m;
            const sk = typeof resolveSalesKey === 'function'
                ? resolveSalesKey(row)
                : (typeof getSalesLookupKey === 'function' ? getSalesLookupKey(row) : m.k);
            if (!salesSeen.has(sk)) {
                salesSeen.add(sk);
                salesToday += m.s.today;
            }
            if (m.alertLevel >= 2) alertCount++;
        });
        metricsCache.byBase[base] = { salesToday, alertCount };
    });
    metricsCacheKey = key;
    return metricsCache;
}

function getRowMetrics(row, base) {
    const cache = buildMetricsCache();
    const rowKey = getMetricsStorageKey(row);
    return cache.byKey[rowKey] || computeRowMetrics(row, base);
}

function computeRowMetrics(row, base) {
    const date = row[1];
    const free = typeof getSoldFromRow === 'function' ? getSoldFromRow(row) : (parseInt(row[6] || 0, 10) || 0);
    const avs = typeof getSpecBookings === 'function' ? getSpecBookings(row) : (parseInt(row[8] || 0, 10) || 0);
    const au = typeof getAuFromRow === 'function' ? getAuFromRow(row) : (parseInt(row[5] || 0, 10) || 0);
    // кресла в продаже = AU снимка − спец. брони
    const seatsOnSale = typeof getSeatsOnSale === 'function'
        ? getSeatsOnSale(row)
        : Math.max(0, au - avs);
    const total = seatsOnSale; // для совместимости полей ниже
    const remainder = typeof getSeatRemainder === 'function' ? getSeatRemainder(row) : (au - free - avs);
    const orig = cleanFlight(row[0]);
    const k = typeof getSalesLookupKey === 'function' ? getSalesLookupKey(row) : `${date}|${orig}`;
    const closed = closedFlights.has(k);
    const dtd = getDaysUntil(date);
    const flew = dtd !== null && dtd < 0;
    const denom = seatsOnSale;
    const pct = (denom > 0) ? Math.round(free / denom * 100) : null;
    const ac = getAircraftType(row[4]);
    const cap = getCapacityFromAircraft(ac);
    const wk = getWeekForExpectedLoad(date);
    const ev = getExpectedLoad(cap, base, dtd, wk);
    const evR = ev !== null ? Math.ceil(ev) : null;
    const { delta, cls: deltaCls } = getDeltaFromExpected(free, evR);
    const salesReady = typeof hasSalesFileLoaded === 'function' ? hasSalesFileLoaded() : !!(typeof dataLoadStatus !== 'undefined' && dataLoadStatus.sales);
    const s = typeof getSalesMapForRow === 'function' ? getSalesMapForRow(row) : (salesMap[k] || { today: 0, yesterday: 0 });
    const pickup = salesReady ? ((s.today || 0) + (s.yesterday || 0)) : null;
    let avg = 0;
    const salesKey = typeof resolveSalesKey === 'function' ? resolveSalesKey(row) : k;
    if (typeof getSalesAggForKey === 'function') {
        avg = getSalesAggForKey(salesKey).avg;
    } else {
        const sl = typeof getSalesDetailsForRow === 'function' ? getSalesDetailsForRow(row) : (salesDetails[k] || []);
        if (sl.length) avg = Math.round(sl.reduce((a, x) => a + (x.adjustedFare || x.fare), 0) / sl.length);
    }

    let alertLevel = 0;
    let alertReason = '';
    if (!closed && !flew && dtd !== null && dtd >= 0) {
        if (delta !== null && delta < -5 && dtd <= 14) {
            alertLevel = 3;
            alertReason = `Отставание ${delta} пасс., вылет через ${dtd} дн.`;
        } else if (delta !== null && delta < 0 && dtd <= 21) {
            alertLevel = 2;
            alertReason = `Ниже прогноза на ${Math.abs(delta)} пасс.`;
        } else if (pct != null && pct < 40 && dtd <= 7) {
            alertLevel = 2;
            alertReason = `Низкая загрузка ${pct}%, вылет через ${dtd} дн.`;
        } else if (pct != null && pct >= 95 && dtd > 0) {
            alertLevel = 1;
            alertReason = `Почти полный (${pct}%)`;
        } else if (s.today >= 3) {
            alertLevel = 1;
            alertReason = `Активные продажи: +${s.today} сегодня`;
        }
    }

    const route = typeof getRouteFromRow === 'function' ? getRouteFromRow(row) : '';
    const rowKey = getMetricsStorageKey(row);
    return { date, orig, base, total, free, au, remainder, pct, dtd, closed, flew, evR, delta, deltaCls, s, pickup, avg, ac, alertLevel, alertReason, k, rowKey, route };
}

function isFlightNeedsAttention(row, base) {
    return getRowMetrics(row, base).alertLevel >= 2;
}

function getRowDelta(row, base) {
    const date = row[1];
    const free = parseInt(row[6] || 0);
    const ac = getAircraftType(row[4]);
    const cap = getCapacityFromAircraft(ac);
    const du = getDaysUntil(date);
    const wk = getWeekForExpectedLoad(date);
    const ev = getExpectedLoad(cap, base, du, wk);
    const evR = ev !== null ? Math.ceil(ev) : null;
    const { delta } = getDeltaFromExpected(free, evR);
    return delta !== null ? delta : 999;
}

function getAllUpcomingFlights(daysAhead = 30) {
    const cache = buildMetricsCache();
    if (cache.upcoming && cache.upcoming.days === daysAhead) return cache.upcoming.list;

    const results = [];
    Object.values(cache.byKey).forEach(m => {
        if (m.closed || m.flew) return;
        if (m.dtd === null || m.dtd < 0 || m.dtd > daysAhead) return;
        results.push(m);
    });
    const sorted = results.sort((a, b) => {
        if (b.alertLevel !== a.alertLevel) return b.alertLevel - a.alertLevel;
        if (a.dtd !== b.dtd) return a.dtd - b.dtd;
        if (a.delta !== null && b.delta !== null) return a.delta - b.delta;
        return 0;
    });
    cache.upcoming = { days: daysAhead, list: sorted };
    return sorted;
}

function getGlobalKPIs() {
    const key = `${getTodayDate()}|${metricsCacheKey}`;
    if (globalKpiCache && globalKpiCacheKey === key) return globalKpiCache;

    const today = getTodayDate();
    let todaySales = 0, todayRevenue = 0;
    if (typeof PerfCache !== 'undefined') {
        const kpi = PerfCache.getTodayKpi();
        todaySales = kpi.sales;
        todayRevenue = kpi.revenue;
    } else {
        Object.values(salesDetails).forEach(list => {
            list.forEach(sale => {
                if (sale.dealDate === today) {
                    todaySales++;
                    todayRevenue += (sale.adjustedFare || sale.fare || 0);
                }
            });
        });
    }
    const upcoming = getAllUpcomingFlights(30);
    const alerts = upcoming.filter(f => f.alertLevel >= 2);
    const avgFare = todaySales > 0 ? Math.round(todayRevenue / todaySales) : 0;
    globalKpiCache = { todaySales, todayRevenue, avgFare, alertCount: alerts.length, openFlights: upcoming.length };
    globalKpiCacheKey = key;
    return globalKpiCache;
}