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
        try { tableHtmlCache = { sig: '', html: '' }; } catch { /* ignore */ }
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
    // Сигналы учитывают прогноз к вылету: обучилась модель или сменились параметры — пересчитать.
    const ar = typeof analyticsRevision === 'function' ? analyticsRevision() : '';
    const m = metricsSigMemo;
    if (m && m.epoch === dataEpoch && m.all === allData && m.allLen === (allData?.length || 0) && m.sales === salesMap
        && m.weights === weights && m.closed === closedFlights && m.closedSize === closedFlights.size && m.today === today && m.ar === ar) {
        return m.sig;
    }
    const weightsCount = weights ? Object.keys(weights).length : 0;
    const sig = `${dataEpoch}|${allData?.length || 0}|${closedFlights.size}|${Object.keys(salesMap || {}).length}|${weightsCount}|${today}|${ar}`;
    metricsSigMemo = { epoch: dataEpoch, all: allData, allLen: allData?.length || 0, sales: salesMap, weights, closed: closedFlights, closedSize: closedFlights.size, today, ar, sig };
    return sig;
}

function buildMetricsCache() {
    const key = getMetricsCacheSignature();
    if (metricsCache && metricsCacheKey === key) return metricsCache;

    metricsCache = { byBase: {}, byKey: {}, upcoming: null };
    globalKpiCache = null;
    globalKpiCacheKey = '';
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
    // Сигналы зависят от прогноза: если пересчёт вызвала новая модель или архив (данные те же), счётчик в шапке обновляем.
    const ar = typeof analyticsRevision === 'function' ? analyticsRevision() : '';
    if (metricsBuiltAr !== null && metricsBuiltAr !== ar && metricsBuiltEpoch === dataEpoch && typeof updateHeaderStatus === 'function') updateHeaderStatus();
    metricsBuiltAr = ar;
    metricsBuiltEpoch = dataEpoch;
    return metricsCache;
}
let metricsBuiltAr = null;
let metricsBuiltEpoch = -1;

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
    // Продано — на день среза данных; ожидаемую берём на тот же день (данные могут быть не сегодняшние).
    const dtdData = dtd != null && typeof observedFromDtd === 'function' ? Math.max(dtd, observedFromDtd(date)) : dtd;
    const ev = getExpectedLoad(cap, base, dtdData, wk);
    // Файл ожидаемой считает от вместимости ВС; если в продаже кресел меньше, ожидать больше них нельзя
    // (иначе почти полный рейс выглядит «отстающим»).
    const evR = ev !== null ? Math.ceil(seatsOnSale > 0 ? Math.min(ev, seatsOnSale) : ev) : null;
    const { delta, cls: deltaCls } = getDeltaFromExpected(free, evR);
    const salesReady = typeof hasSalesFileLoaded === 'function' ? hasSalesFileLoaded() : !!(typeof dataLoadStatus !== 'undefined' && dataLoadStatus.sales);
    const s = typeof getSalesMapForRow === 'function' ? getSalesMapForRow(row) : (salesMap[k] || { today: 0, yesterday: 0 });
    const pickup = salesReady ? ((s.today || 0) + (s.yesterday || 0)) : null;
    const salesKey = typeof resolveSalesKey === 'function' ? resolveSalesKey(row) : k;
    const avg = getSalesAggForKey(salesKey).avg;

    let alertLevel = 0;
    let alertReason = '';
    if (!closed && !flew && dtd !== null && dtd >= 0) {
        // «Ниже прогноза» — не мельче порога подсказок: 3 пасс. или 5% кресел.
        const belowMin = Math.max(PV.ADVICE_THRESHOLD_MIN, Math.round(seatsOnSale * 0.05));
        if (delta !== null && delta < -PV.RMS_CRIT_DELTA && dtd <= PV.RMS_CRIT_DAYS) {
            alertLevel = 3;
            alertReason = `Отставание −${Math.abs(delta)} пасс., вылет через ${dtd} дн.`;
        } else if (delta !== null && delta <= -belowMin && dtd <= PV.RMS_WARN_DAYS) {
            alertLevel = 2;
            alertReason = `Ниже прогноза на ${Math.abs(delta)} пасс.`;
        } else if (pct != null && pct < PV.RMS_LOW_PCT && dtd <= PV.RMS_LOW_DAYS) {
            alertLevel = 2;
            alertReason = `Низкая загрузка ${pct}%, вылет через ${dtd} дн.`;
        } else if (pct != null && pct >= PV.RMS_FULL_PCT && dtd > 0) {
            alertLevel = 1;
            alertReason = `Почти полный (${pct}%)`;
        } else if (s.today >= PV.RMS_ACTIVE_SALES) {
            alertLevel = 1;
            alertReason = `Активные продажи: +${s.today} сегодня`;
        }
        if (alertLevel >= 2) {
            if (dtd === 0) {
                // В день вылета цену менять поздно: только отметка, без предупреждения.
                alertLevel = 1;
                alertReason += '; вылет сегодня';
            } else if (typeof FlightInsights !== 'undefined') {
                // Прогноз к вылету высокий — отставание от темпа не так страшно: уровень ниже на единицу.
                let fc = null;
                try { fc = FlightInsights.forecast(orig, date); } catch { fc = null; }
                if (fc && fc.source !== 'flown' && fc.final != null && fc.lf >= PV.ADVICE_FC_HIGH) {
                    alertLevel--;
                    alertReason += `; прогноз к вылету ${fc.lf}%`;
                }
            }
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
    const d = getRowMetrics(row, base).delta;
    return d !== null && d !== undefined ? d : 999;
}

function getAllUpcomingFlights(daysAhead = 30) {
    const cache = buildMetricsCache();
    if (cache.upcoming && cache.upcoming.days === daysAhead) return cache.upcoming.list;

    const results = [];
    Object.values(cache.byKey).forEach(m => {
        if (m.closed || m.flew) return;
        if (m.dtd === null || m.dtd < 0 || m.dtd >= daysAhead) return;   // окно: сегодня и ещё N−1 дней, как «7 дней» на «Сегодня»
        results.push(m);
    });
    const sorted = results.sort((a, b) => {
        if (b.alertLevel !== a.alertLevel) return b.alertLevel - a.alertLevel;
        // Проблемные — по деньгам (больше сверху), потом по близости вылета.
        if (a.alertLevel >= 2) {
            const ma = getRmsMoney(a);
            const mb = getRmsMoney(b);
            const d = (mb ? mb.rub : -1) - (ma ? ma.rub : -1);
            if (d) return d;
        }
        if (a.dtd !== b.dtd) return a.dtd - b.dtd;
        if (a.delta !== null && b.delta !== null) return a.delta - b.delta;
        return 0;
    });
    cache.upcoming = { days: daysAhead, list: sorted };
    return sorted;
}

// Деньги по строке RMS: для предупреждений — пустые места по прогнозу × средний тариф;
// для «почти полный» и «активные продажи» — оставшиеся места × последний тариф. Иначе null (на экране «—»).
function getRmsMoney(m) {
    if (m.moneyMemo !== undefined) return m.moneyMemo;
    let res = null;
    if (typeof SalesAdvice !== 'undefined' && SalesAdvice.money) {
        const reason = m.alertReason || '';
        const up = m.alertLevel === 1 && (reason.startsWith('Почти полный') || reason.startsWith('Активные продажи'));
        if (m.alertLevel >= 2 || up) res = SalesAdvice.money(m.orig || m.base, m.date, up ? 'up' : 'down', m.avg || undefined);
    }
    m.moneyMemo = res;
    return res;
}

// Файл продаж старше 1 дня: «продано сегодня» по нему не видно, нули там ничего не значат.
// Возвращает { days, label: 'ДД.ММ' } или null, если файл свежий (или даты файла нет).
function getStaleSalesInfo() {
    if (typeof lastSalesUpdate === 'undefined' || !lastSalesUpdate) return null;
    if (typeof hasSalesFileLoaded === 'function' && !hasSalesFileLoaded()) return null;
    const upd = new Date(lastSalesUpdate);
    const t = parseLocalDate(getTodayDate());
    if (!t || isNaN(upd.getTime())) return null;
    const days = Math.round((t.getTime() - new Date(upd.getFullYear(), upd.getMonth(), upd.getDate()).getTime()) / 86400000);
    if (days < 2) return null;
    return { days, label: `${String(upd.getDate()).padStart(2, '0')}.${String(upd.getMonth() + 1).padStart(2, '0')}` };
}

function getGlobalKPIs() {
    buildMetricsCache();   // ключ ниже берётся после возможного пересчёта (сигналы зависят от прогноза)
    const key = `${getTodayDate()}|${metricsCacheKey}`;
    if (globalKpiCache && globalKpiCacheKey === key) return globalKpiCache;

    const kpi = PerfCache.getTodayKpi();
    const todaySales = kpi.sales;
    const todayRevenue = kpi.revenue;
    const upcoming = getAllUpcomingFlights(30);
    const alerts = upcoming.filter(f => f.alertLevel >= 2);
    const avgFare = todaySales > 0 ? Math.round(todayRevenue / todaySales) : 0;
    // Продажи сегодня по вылетам, которых нет в файле загрузки (чартеры, доп. номера): в сумме по рейсам их не видно.
    let todayOutside = 0;
    try {
        const have = new Set();
        (allData || []).forEach(r => { if (r && r[0] && r[1]) have.add(getSalesLookupKey(r)); });
        Object.keys(salesMap || {}).forEach(sk => { const b = salesMap[sk]; if (b && b.today && !have.has(sk)) todayOutside += b.today; });
    } catch (e) { todayOutside = 0; }
    globalKpiCache = { todaySales, todayRevenue, avgFare, todayOutside, alertCount: alerts.length, openFlights: upcoming.length };
    globalKpiCacheKey = key;
    return globalKpiCache;
}