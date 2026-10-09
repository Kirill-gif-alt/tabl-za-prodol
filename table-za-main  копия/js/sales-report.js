// js\sales-report.js - extracted from script.js, logic unchanged.
// Globals on purpose: no bundler; onclick and other files call by name.

function closeTableSalesPanel() {
    const ids = ['table-sales-panel', 'pair-sales-panel', 'pkz-detail-panel'];
    let anyOpen = document.body.classList.contains('pkz-detail-open');
    if (!anyOpen) {
        anyOpen = ids.some((id) => {
            const el = document.getElementById(id);
            return el && !el.classList.contains('is-hidden');
        });
    }
    if (!anyOpen) return;
    ids.forEach(id => {
        const panel = document.getElementById(id);
        if (panel) {
            panel.classList.add('is-hidden');
            panel.parentElement?.classList.remove('sd-open');
        }
    });
    document.body.classList.remove('pkz-detail-open');
    destroyChartsByPrefix('report-');
    const result = document.getElementById('sales-chart-result');
    if (result) result.innerHTML = '';
    const pairResult = document.getElementById('pair-sales-chart-result');
    if (pairResult) pairResult.innerHTML = '';
    const pkzResult = document.getElementById('pkz-detail-result');
    if (pkzResult) pkzResult.innerHTML = '';
    highlightSalesRow(null);
}

function highlightSalesRow(flyDate, flightCode) {
    ['table-container', 'pair-table-container', 'pkz-table-container'].forEach(id => {
        const cont = document.getElementById(id);
        if (!cont) return;
        cont.querySelectorAll('.table-row-sales-active').forEach(r => r.classList.remove('table-row-sales-active'));
        if (!flyDate) return;
        let row = null;
        if (flightCode) {
            row = cont.querySelector(`tr[data-date="${CSS.escape(flyDate)}"][data-flight-code="${CSS.escape(flightCode)}"]`);
        }
        if (!row) row = cont.querySelector(`tr[data-date="${CSS.escape(flyDate)}"]`);
        if (row) row.classList.add('table-row-sales-active');
    });
}

function openSalesReportForFlight(flightBase, flyDate, flightCode) {
    if (!flightBase || !flyDate) return;
    if (currentTab === 'pkz') {
        openPkzReportForFlight(flightBase, flyDate, flightCode);
        return;
    }
    // На графплане / данных / RMS — не уводим на другую вкладку
    if (currentTab !== 'table' && currentTab !== 'pair') {
        currentFlight = cleanFlight(flightCode || flightBase) || flightBase;
        lastSelectedDate = flyDate;
        if (typeof SessionStore !== 'undefined') SessionStore.saveUiSession();
        return;
    }
    if (typeof ProfileAuth !== 'undefined' && !ProfileAuth.guardPermission('sales_detail', 'Детализация продаж недоступна')) return;
    const salesFlight = cleanFlight(flightCode || flightBase) || flightBase;

    const isPair = currentTab === 'pair';
    const panel = document.getElementById(isPair ? 'pair-sales-panel' : 'table-sales-panel');
    const sub = document.getElementById(isPair ? 'pair-sales-panel-sub' : 'table-sales-panel-sub');
    if (!panel) return;
    hideSelectionStatusBar();
    document.body.classList.add('pkz-detail-open');
    panel.classList.remove('is-hidden');
    openSideDetail(panel);
    if (sub) {
        sub.textContent = `${getFlightDirection(salesFlight)} (${salesFlight}) · вылет ${flyDate}`;
    }

    highlightSalesRow(flyDate, salesFlight);
    buildFlightSalesReportFor(flightBase, flyDate, null, salesFlight);

    requestAnimationFrame(() => {
        panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
}

// Детализация справа от таблицы: таблица остаётся на всю высоту, граница перетаскивается.
const SIDE_DETAIL_KEY = 'krasavia_side_detail_px';

function openSideDetail(panel) {
    const body = panel && panel.parentElement;
    if (!body) return;
    body.classList.add('sd-open');
    let saved = 0;
    try { saved = parseInt(localStorage.getItem(SIDE_DETAIL_KEY), 10) || 0; } catch (e) { /* ignore */ }
    if (saved) body.style.setProperty('--sd-panel', saved + 'px');
    if (!body.querySelector(':scope > .sd-splitter')) {
        const split = document.createElement('div');
        split.className = 'sd-splitter';
        split.title = 'Потяните, чтобы изменить ширину';
        body.insertBefore(split, panel);
        split.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            split.setPointerCapture(e.pointerId);
            const rect = body.getBoundingClientRect();
            const move = (ev) => {
                const px = Math.round(Math.min(Math.max(rect.right - ev.clientX, 420), rect.width - 360));
                body.style.setProperty('--sd-panel', px + 'px');
            };
            const up = () => {
                split.removeEventListener('pointermove', move);
                split.removeEventListener('pointerup', up);
                const px = parseInt(getComputedStyle(body).getPropertyValue('--sd-panel'), 10);
                try { if (px) localStorage.setItem(SIDE_DETAIL_KEY, String(px)); } catch (err) { /* ignore */ }
                if (typeof Chart !== 'undefined') Object.values(Chart.instances || {}).forEach(ch => { try { ch.resize(); } catch (er) { /* ignore */ } });
            };
            split.addEventListener('pointermove', move);
            split.addEventListener('pointerup', up);
        });
    }
}

function openPkzReportForFlight(flightBase, flyDate, flightCode) {
    if (!flightBase || !flyDate) return;
    const code = cleanFlight(flightCode || flightBase) || flightBase;
    // Только на вкладке ПКЗ открываем панель; иначе просто запоминаем рейс
    if (currentTab !== 'pkz') {
        currentFlight = code;
        lastSelectedDate = flyDate;
        if (typeof SessionStore !== 'undefined') SessionStore.saveUiSession();
        return;
    }
    const panel = document.getElementById('pkz-detail-panel');
    const sub = document.getElementById('pkz-detail-panel-sub');
    const result = document.getElementById('pkz-detail-result');
    if (!panel || !result) return;
    hideSelectionStatusBar();
    panel.classList.remove('is-hidden');
    document.body.classList.add('pkz-detail-open');
    if (sub) sub.textContent = `${getFlightDirection(code)} (${code}) · вылет ${flyDate}`;
    highlightSalesRow(flyDate, code);
    result.innerHTML = '';
    appendPkzAdjustPanel(result, flightBase, flyDate, code);
    if (!result.innerHTML.trim()) {
        result.innerHTML = `<div class="sales-empty-state">Недостаточно данных для расчёта КЗ (нет загрузки или даты вне горизонта 10 дней).</div>`;
    }
    requestAnimationFrame(() => {
        hideSelectionStatusBar();
        panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
}

function formatChartDateLabel(dateStr, compact = false) {
    const d = parseLocalDate(dateStr);
    if (!d) return String(dateStr || '').slice(0, 5);
    const day = d.getDate().toString().padStart(2, '0');
    const mon = (d.getMonth() + 1).toString().padStart(2, '0');
    if (compact) return `${day}.${mon}`;
    const dow = DAYS_RU[d.getDay()];
    return `${day}.${mon} ${dow}`;
}

function shiftDateStr(dateStr, days) {
    const src = parseLocalDate(dateStr);
    if (!src) return null;
    const d = new Date(src.getTime());
    d.setDate(d.getDate() + days);
    return formatDateRu(d);
}

function sameWeekdayLastYearDate(flyDateStr) {
    return shiftDateStr(flyDateStr, -364);
}

function getFlightSalesList(flyDateStr, flightCode) {
    const code = cleanFlight(flightCode);
    if (!code || !flyDateStr || typeof salesDetails === 'undefined') return [];
    return salesDetails[`${flyDateStr}|${code}`] || [];
}

function buildOnHandByDtd(flyDateStr, flightCode) {
    const flyDt = parseLocalDate(flyDateStr);
    const list = getFlightSalesList(flyDateStr, flightCode);
    const counts = Object.create(null);
    let maxD = 0;
    if (!flyDt) return { onHand: {}, maxDtd: 0, total: 0 };
    for (let i = 0; i < list.length; i++) {
        const deal = parseLocalDate(list[i].dealDate);
        if (!deal) continue;
        const dtd = Math.round((flyDt.getTime() - deal.getTime()) / 86400000);
        if (dtd < 0) continue;
        counts[dtd] = (counts[dtd] || 0) + 1;
        if (dtd > maxD) maxD = dtd;
    }
    const onHand = Object.create(null);
    let run = 0;
    for (let t = maxD; t >= 0; t--) {
        run += counts[t] || 0;
        onHand[t] = run;
    }
    return { onHand, maxDtd: maxD, total: run };
}

function resolveSwlyDate(baseFlight, flyDateStr, flightCode) {
    const code = cleanFlight(flightCode || baseFlight);
    const canonical = sameWeekdayLastYearDate(flyDateStr);
    const hasData = (dt) => {
        if (!dt) return false;
        if (getFlightSalesList(dt, code).length) return true;
        if (typeof SalesArchive !== 'undefined' && SalesArchive.curveFor(dt, code)) return true;
        return typeof getFlightRowForDate === 'function' && !!getFlightRowForDate(baseFlight, dt, code);
    };
    if (hasData(canonical)) return canonical;
    for (const w of [-7, 7, -14, 14, -21, 21]) {
        const dt = shiftDateStr(flyDateStr, -364 + w);
        if (hasData(dt)) return dt;
    }
    return canonical;
}

// ---------- Норма продаж: тот же рейс, тот же день недели ----------
// Норма — средний темп продаж других вылетов этого рейса в тот же день недели (серая линия).
// • На каждом «дне до вылета» t учитываются только вылеты, у которых этот день уже прошёл:
//   улетевшие — целиком, будущие — только до даты среза продаж. Раньше будущий вылет входил
//   с «продано на сегодня» как с итогом и занижал норму у дня вылета.
// • Продажи считаются в доле от кресел и пересчитываются на кресла этого вылета, поэтому
//   ATR-42, ATR-72 и Як-42 можно усреднять вместе.
// • Берутся вылеты в пределах ±8 недель (без смешивания сезонов); если на сегодняшний день
//   до вылета так набирается меньше 2 вылетов — весь период данных.
const WEEKDAY_NORM_WINDOW_DAYS = 56;
const WEEKDAY_NORM_MIN_N = 2;
let salesCutoffCache = { ref: null, sig: '', time: 0 };

// Дата среза продаж: последний день, за который есть сделки (не дата на часах компьютера).
function salesDataCutoffTime() {
    const ref = typeof salesDetails !== 'undefined' ? salesDetails : null;
    // Объект продаж заполняется постепенно (при загрузке CSV) — поэтому в ключе и число рейсов, и время файла.
    const sig = `${Object.keys(ref || {}).length}|${typeof lastSalesUpdate !== 'undefined' && lastSalesUpdate ? new Date(lastSalesUpdate).getTime() : 0}|${typeof window !== 'undefined' && window.ingestQuiet ? 1 : 0}`;
    if (salesCutoffCache.ref === ref && salesCutoffCache.sig === sig && salesCutoffCache.time) return salesCutoffCache.time;
    let max = 0;
    Object.keys(ref || {}).forEach(k => {
        const list = ref[k] || [];
        for (let i = 0; i < list.length; i++) {
            const d = parseLocalDate(list[i].dealDate);
            if (d && d.getTime() > max) max = d.getTime();
        }
    });
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const time = max && max < today.getTime() ? max : today.getTime();
    salesCutoffCache = { ref, sig, time };
    return time;
}

// С какого «дня до вылета» продажи по вылету уже известны (0 — вылет состоялся).
function observedFromDtd(flyDateStr) {
    const fd = parseLocalDate(flyDateStr);
    if (!fd) return 0;
    return Math.max(0, Math.round((fd.getTime() - salesDataCutoffTime()) / 86400000));
}

function collectSameWeekdayCohort(baseFlight, flyDateStr, flightCode) {
    const flyDt = parseLocalDate(flyDateStr);
    if (!flyDt) return [];
    const dow = flyDt.getDay();
    const code = cleanFlight(flightCode || baseFlight);
    const base = typeof getBaseFlight === 'function' ? getBaseFlight(code) : (baseFlight || code);
    const rows = (typeof groupedData !== 'undefined' && (groupedData[base] || groupedData[baseFlight])) || [];
    const dates = [];
    const seen = new Set();
    rows.forEach(row => {
        const dtStr = row[1];
        if (!dtStr || dtStr === flyDateStr || seen.has(dtStr)) return;
        const dt = parseLocalDate(dtStr);
        if (!dt || dt.getDay() !== dow) return;
        const orig = cleanFlight(row[0]);
        const salesCode = getFlightSalesList(dtStr, orig).length ? orig : code;
        if (!getFlightSalesList(dtStr, salesCode).length) return;
        seen.add(dtStr);
        dates.push({
            date: dtStr,
            code: salesCode,
            seats: typeof getSeatsOnSale === 'function' ? getSeatsOnSale(row) : 0,
            aircraft: typeof getAircraftType === 'function' ? getAircraftType(row[4]) : '',
            load: parseInt(row[6] || 0, 10) || 0,
            observedFrom: observedFromDtd(dtStr),
            dayGap: Math.round(Math.abs(dt.getTime() - flyDt.getTime()) / 86400000)
        });
    });
    // Улетевшие вылеты, которых уже нет в файлах, — из архива (sales-archive.js).
    if (typeof SalesArchive !== 'undefined') {
        SalesArchive.departuresFor(code).forEach(a => {
            if (a.date === flyDateStr || seen.has(a.date) || !(a.seats > 0)) return;
            const dt = parseLocalDate(a.date);
            if (!dt || dt.getDay() !== dow) return;
            seen.add(a.date);
            dates.push({
                date: a.date,
                code,
                seats: a.seats,
                aircraft: a.aircraft,
                load: a.sold,
                observedFrom: 0,
                archived: true,
                dayGap: Math.round(Math.abs(dt.getTime() - flyDt.getTime()) / 86400000)
            });
        });
    }
    return dates;
}

// Загрузка (файл «загрузка таб») точнее файла продаж: в продажах бывают незакрытые возвраты и обмены.
// Кривую продаж масштабируем так, чтобы она кончалась на загрузке; форма (когда покупали) остаётся.
function anchorCurveToLoad(curve, load) {
    if (!curve || !(load > 0) || !(curve.total > 0) || curve.total === load) return curve;
    const k = load / curve.total;
    const onHand = Object.create(null);
    Object.keys(curve.onHand).forEach(t => { onHand[t] = Math.round(curve.onHand[t] * k); });
    return { onHand, maxDtd: curve.maxDtd, total: load, salesTotal: curve.total, anchored: true };
}

// Кривая продаж вылета: из текущего файла продаж, а если вылет уже выпал из него — из архива.
function departureCurve(dateStr, code) {
    if (getFlightSalesList(dateStr, code).length) return buildOnHandByDtd(dateStr, code);
    const archived = typeof SalesArchive !== 'undefined' ? SalesArchive.curveFor(dateStr, code) : null;
    return archived || buildOnHandByDtd(dateStr, code);
}

// Норма по когорте на каждом дне до вылета: среднее, разброс и число вылетов.
function weekdayNormSeries(cohort, dtds, targetSeats) {
    const curves = cohort.filter(c => c.seats > 0).map(c => ({ ...c, curve: anchorCurveToLoad(departureCurve(c.date, c.code), c.load) }));
    const avgSeats = curves.length ? curves.reduce((a, c) => a + c.seats, 0) / curves.length : 0;
    const scale = targetSeats > 0 ? targetSeats : avgSeats;
    const points = dtds.map(t => {
        const lfs = [];
        curves.forEach(c => {
            const v = weekdayNormValueAt(c, t);
            // Не больше 100%: билетов бывает больше кресел из-за возвратов и обменов.
            if (v != null) lfs.push(Math.min(1, v / c.seats));
        });
        if (lfs.length < WEEKDAY_NORM_MIN_N || !scale) return { n: lfs.length, value: null, lo: null, hi: null, lf: null };
        const mean = lfs.reduce((a, b) => a + b, 0) / lfs.length;
        return {
            n: lfs.length,
            value: Math.round(mean * scale),
            lo: Math.round(Math.min.apply(null, lfs) * scale),
            hi: Math.round(Math.max.apply(null, lfs) * scale),
            lf: Math.round(mean * 100)
        };
    });
    return { points, curves };
}

// Сколько билетов было продано на вылете за t дней до вылета; null — этот день ещё не наступил.
function weekdayNormValueAt(c, t) {
    if (t < c.observedFrom) return null;
    const oh = c.curve.onHand[t];
    if (oh != null) return oh;
    return t > c.curve.maxDtd ? 0 : c.curve.total;
}

function weekdayRuPrep(dowShort) {
    const map = {
        Вс: 'воскресеньям', Пн: 'понедельникам', Вт: 'вторникам', Ср: 'средам',
        Чт: 'четвергам', Пт: 'пятницам', Сб: 'субботам'
    };
    return map[dowShort] || String(dowShort || 'этим дням недели');
}

function buildFlightDtdBookingSeries(baseFlight, flyDateStr, flightCode, period, aircraftCode) {
    const code = cleanFlight(flightCode || baseFlight);
    const ownRow = typeof getFlightRowForDate === 'function' ? getFlightRowForDate(baseFlight, flyDateStr, code) : null;
    const ownLoad = ownRow ? (typeof getSoldFromRow === 'function' ? getSoldFromRow(ownRow) : (parseInt(ownRow[6], 10) || 0)) : 0;
    const thisCurve = anchorCurveToLoad(buildOnHandByDtd(flyDateStr, code), ownLoad);
    const asOf = typeof getDaysUntil === 'function' ? getDaysUntil(flyDateStr) : null;
    // Ось кончается на последнем дне, за который есть продажи (дата среза), а не на дате компьютера.
    const axisMin = Math.max(asOf === null ? 0 : Math.max(0, asOf), observedFromDtd(flyDateStr));
    const lookback = Math.min(180, Math.max(1, parseInt(period, 10) || 30));
    const hi = Math.min(180, axisMin + lookback);
    const dtds = [];
    for (let t = hi; t >= axisMin; t--) dtds.push(t);

    const thisData = dtds.map(t => {
        if (thisCurve.onHand[t] != null) return thisCurve.onHand[t];
        if (t > thisCurve.maxDtd) return 0;
        return thisCurve.total;
    });

    if (typeof SalesArchive !== 'undefined') SalesArchive.ensureMonth(sameWeekdayLastYearDate(flyDateStr));
    const swlyDate = resolveSwlyDate(baseFlight, flyDateStr, code);
    const swlyHasSales = !!(swlyDate && (getFlightSalesList(swlyDate, code).length
        || (typeof SalesArchive !== 'undefined' && SalesArchive.curveFor(swlyDate, code))));
    let refData = null;
    let refBand = null;
    let normInfo = null;
    let refLabel = '';
    let caption = 'Кривая 14д: накоплено билетов к моменту «N дней до вылета» (окно файла Tickets_SALE_Last14Days, не полный pickup −21).';
    const dowName = typeof getDayOfWeek === 'function' ? getDayOfWeek(flyDateStr) : '';

    if (swlyHasSales) {
        const swlyRow = typeof getFlightRowForDate === 'function' ? getFlightRowForDate(baseFlight, swlyDate, code) : null;
        const swlyCurve = anchorCurveToLoad(departureCurve(swlyDate, code), swlyRow ? (parseInt(swlyRow[6], 10) || 0) : 0);
        refData = dtds.map(t => {
            if (swlyCurve.onHand[t] != null) return swlyCurve.onHand[t];
            if (t > swlyCurve.maxDtd) return null;
            return swlyCurve.total;
        });
        refLabel = `Год назад, тот же день недели (${swlyDate})`;
        caption = `Серая линия — как продавался этот рейс год назад в тот же день недели (${dowName} ${swlyDate}), не то же календарное число.`;
    } else {
        const cohortAll = collectSameWeekdayCohort(baseFlight, flyDateStr, code);
        const targetRow = typeof getFlightRowForDate === 'function' ? getFlightRowForDate(baseFlight, flyDateStr, code) : null;
        const targetSeats = targetRow && typeof getSeatsOnSale === 'function' ? getSeatsOnSale(targetRow) : 0;
        const near = cohortAll.filter(c => c.dayGap <= WEEKDAY_NORM_WINDOW_DAYS);
        let norm = weekdayNormSeries(near, dtds, targetSeats);
        let windowed = true;
        const last = norm.points[norm.points.length - 1];
        if (!last || last.value == null) {
            const wide = weekdayNormSeries(cohortAll, dtds, targetSeats);
            const wideLast = wide.points[wide.points.length - 1];
            if (wideLast && wideLast.value != null) { norm = wide; windowed = false; }
        }
        const prep = weekdayRuPrep(dowName);
        if (norm.points.some(p => p.value != null)) {
            refData = norm.points.map(p => p.value);
            refBand = { lo: norm.points.map(p => p.lo), hi: norm.points.map(p => p.hi), n: norm.points.map(p => p.n), lf: norm.points.map(p => p.lf) };
            const nowN = last && last.value != null && windowed ? last.n : norm.points[norm.points.length - 1].n;
            refLabel = `Норма по ${prep}, ${code}`;
            caption = `Серая линия — норма: средний темп продаж по ${prep} рейса ${code}`
                + `${windowed ? ' (вылеты ±8 недель)' : ' (весь период данных)'}, в пересчёте на ${targetSeats ? targetSeats + ' кресел этого вылета' : 'кресла'}.`
                + ` На каждом дне до вылета учтены только вылеты, у которых этот день уже прошёл`
                + ` — на ${axisMin} дн. до вылета это ${nowN}. Заливка — разброс между вылетами.`;
            normInfo = { prep, windowed, curves: norm.curves, asOfDtd: axisMin, targetSeats };
        } else if (cohortAll.length) {
            caption = `Серая норма не построена: среди ${cohortAll.length} других вылетов по ${prep} меньше ${WEEKDAY_NORM_MIN_N} таких, у которых этот день до вылета уже прошёл. Норма появится, когда накопится история.`;
        } else {
            caption = 'Серая норма не построена: в файле нет других вылетов этого рейса в тот же день недели. Синяя линия — загрузка этого рейса.';
        }
    }

    const nowVal = thisData.length ? thisData[thisData.length - 1] : thisCurve.total;

    let expectedData = null;
    if (typeof getExpectedLoad === 'function' && typeof getCapacityFromAircraft === 'function') {
        const cap = getCapacityFromAircraft(typeof getAircraftType === 'function' ? getAircraftType(aircraftCode) : aircraftCode);
        const wk = typeof getWeekForExpectedLoad === 'function' ? getWeekForExpectedLoad(flyDateStr) : 1;
        const pts = dtds.map(t => {
            const ev = getExpectedLoad(cap, baseFlight, t, wk);
            return ev !== null ? Math.ceil(ev) : null;
        });
        if (pts.some(v => v !== null)) expectedData = pts;
    }

    // Вывод простыми словами: сколько продано и сравнение с обычным темпом и с планом (файл ожидаемой).
    //   Продано 4 · за 18 дн. до вылета
    //   Обычно к этому дню 11 — на 7 меньше
    //   По плану 5 — на 1 меньше
    const refVal = refData && refData.length ? refData[refData.length - 1] : null;
    const expVal = expectedData && expectedData.length ? expectedData[expectedData.length - 1] : null;
    const diffText = (d) => (d > 0 ? `на ${d} больше` : (d < 0 ? `на ${Math.abs(d)} меньше` : 'столько же'));
    const diffCls = (d) => (d > 0 ? 'vd-up' : (d < 0 ? 'vd-down' : ''));
    const lines = [];
    let mainDelta = null;
    if (refVal != null && !isNaN(refVal)) {
        const d = nowVal - refVal;
        const nNote = refBand ? `по ${refBand.n[refBand.n.length - 1]} прошлым вылетам в этот день недели` : 'по прошлым вылетам';
        lines.push({ label: 'Обычно к этому дню', value: refVal, d, title: `Норма ${nNote}` });
        mainDelta = d;
    }
    if (expVal != null && !isNaN(expVal)) {
        const d = nowVal - expVal;
        lines.push({ label: 'По плану', value: expVal, d, title: 'Из файла ожидаемой загрузки' });
        if (mainDelta == null) mainDelta = d;
    }
    const head = `Продано ${nowVal} · за ${axisMin} дн. до вылета`;
    const verdict = [head].concat(lines.map(l => `${l.label} ${l.value} — ${diffText(l.d)}`)).join('\n');
    const esc = typeof escHtml === 'function' ? escHtml : String;
    const anchorNote = thisCurve.anchored
        ? ` title="По загрузке. В файле продаж ${thisCurve.salesTotal} — разница из-за возвратов или обменов, которых нет в файле продаж"` : '';
    const verdictHtml = `<div class="vd-head"${anchorNote}><strong>Продано ${nowVal}</strong> <span class="vd-muted">· за ${axisMin} дн. до вылета${thisCurve.anchored ? ` · по загрузке (в продажах ${thisCurve.salesTotal})` : ''}</span></div>`
        + lines.map(l => `<div class="vd-line" title="${esc(l.title)}">${esc(l.label)} <strong>${l.value}</strong> — <span class="${diffCls(l.d)}">${diffText(l.d)}</span></div>`).join('');
    const verdictCls = mainDelta == null || mainDelta === 0 ? 'booking-curve-verdict-neutral'
        : (mainDelta > 0 ? 'booking-curve-verdict-up' : 'booking-curve-verdict-down');

    return { dtds, thisData, refData, refBand, normInfo, refLabel, caption, verdict, verdictHtml, verdictCls, expectedData };
}

// Таблица под графиком: из каких вылетов посчитана норма.
function buildWeekdayNormTableHtml(dtdCurve) {
    const info = dtdCurve && dtdCurve.normInfo;
    if (!info || !info.curves.length) return '';
    const t = info.asOfDtd;
    const rows = info.curves.slice().sort((a, b) => (parseLocalDate(a.date) || 0) - (parseLocalDate(b.date) || 0)).map(c => {
        const v = weekdayNormValueAt(c, t);
        const flown = c.observedFrom === 0;
        const state = c.archived ? 'улетел (архив)' : flown ? 'улетел' : `продаётся (до ${c.observedFrom} дн.)`;
        const atT = v == null ? '<span class="norm-muted">ещё не наступило</span>' : `${v} (${Math.round(v / c.seats * 100)}%)`;
        return `<tr class="${v == null ? 'norm-row-out' : ''}">
            <td>${escHtml(c.date)}</td>
            <td>${escHtml(c.aircraft || '—')}</td>
            <td>${c.seats}</td>
            <td>${atT}</td>
            <td>${c.curve.total}${flown ? '' : ' <span class="norm-muted">пока</span>'}</td>
            <td>${escHtml(state)}</td>
        </tr>`;
    }).join('');
    const used = info.curves.filter(c => weekdayNormValueAt(c, t) != null).length;
    return `
        <details class="norm-cohort">
            <summary>Из чего посчитана норма: ${used} из ${info.curves.length} вылетов по ${escHtml(info.prep)}${info.windowed ? ' (±8 недель)' : ''} учтены на ${t} дн. до вылета</summary>
            <div class="report-table-scroll">
                <table class="report-data-table norm-cohort-table">
                    <thead><tr><th>Вылет</th><th>Тип ВС</th><th>Кресел</th><th>Продано за ${t} дн. до вылета</th><th>Всего продано</th><th>Статус</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </details>`;
}

function buildDateRangeInclusive(fromDate, toDate) {
    const out = [];
    if (!fromDate || !toDate) return out;
    const cur = new Date(fromDate);
    cur.setHours(0, 0, 0, 0);
    const end = new Date(toDate);
    end.setHours(0, 0, 0, 0);
    if (cur > end) return out;
    while (cur <= end) {
        out.push(formatDateRu(cur));
        cur.setDate(cur.getDate() + 1);
    }
    return out;
}

function buildFlightCommentBlockHtml(flight, date) {
    const text = typeof FlightComments !== 'undefined' ? FlightComments.get(flight, date) : '';
    return `
        <div class="flight-comment-box" data-comment-flight="${escAttr(flight)}" data-comment-date="${escAttr(date)}">
            <label class="flight-comment-label">Комментарий к рейсу</label>
            <textarea class="flight-comment-input" rows="2">${escHtml(text)}</textarea>
            <div class="flight-comment-actions">
                <button type="button" class="btn-primary flight-comment-save">Сохранить</button>
                <span class="flight-comment-status"></span>
            </div>
        </div>`;
}

function bindFlightCommentBox(root) {
    const box = root?.querySelector('.flight-comment-box');
    if (!box || box.dataset.bound) return;
    box.dataset.bound = '1';
    const btn = box.querySelector('.flight-comment-save');
    const ta = box.querySelector('.flight-comment-input');
    const st = box.querySelector('.flight-comment-status');
    btn?.addEventListener('click', async () => {
        if (typeof FlightComments === 'undefined') return;
        const fl = box.dataset.commentFlight;
        const dt = box.dataset.commentDate;
        const author = typeof ProfileAuth !== 'undefined' ? ProfileAuth.getCurrentProfile()?.name : '';
        await FlightComments.set(fl, dt, ta?.value || '', author);
        if (st) st.textContent = 'Сохранено';
        if (typeof showToast === 'function') showToast('Комментарий сохранён');
        ['table-container', 'pkz-table-container'].forEach(id => {
            FlightComments.markRows(document.getElementById(id));
        });
    });
}

let lastSalesReportArgs = null;

// Перерисовать открытую детализацию продаж (после отметки или догрузки архива).
function refreshOpenSalesReport() {
    const a = lastSalesReportArgs;
    if (!a) return;
    const host = document.getElementById(a.hostId);
    if (!host || !host.isConnected || !host.innerHTML.trim()) return;
    const panel = host.closest('.is-hidden');
    if (panel) return;
    // Сохраняем то, что пользователь мог трогать: набранный комментарий, раскрытые блоки, прокрутку.
    const box = host.querySelector('.sd-comment');
    const ta = host.querySelector('.flight-comment-input');
    const keep = {
        boxOpen: !!(box && !box.hidden),
        text: ta ? ta.value : null,
        focused: !!(ta && document.activeElement === ta),
        details: [...host.querySelectorAll('details')].map(d => d.open),
        scroll: host.scrollTop
    };
    buildFlightSalesReportFor(a.baseFlight, a.flyDateStr, a.resultId, a.flightCode);
    const box2 = host.querySelector('.sd-comment');
    if (box2 && keep.boxOpen) box2.hidden = false;
    const ta2 = host.querySelector('.flight-comment-input');
    if (ta2 && keep.text != null) ta2.value = keep.text;
    if (ta2 && keep.focused) ta2.focus();
    host.querySelectorAll('details').forEach((d, i) => { if (i < keep.details.length) d.open = keep.details[i]; });
    host.scrollTop = keep.scroll;
}

function buildFlightSalesReportFor(baseFlight, flyDateStr, resultId, flightCode) {
    const hostId = resultId || (currentTab === 'pair' ? 'pair-sales-chart-result' : 'sales-chart-result');
    const resultDiv = document.getElementById(hostId);
    if (!resultDiv || !baseFlight || !flyDateStr) return;

    const salesFlight = cleanFlight(flightCode || baseFlight) || baseFlight;
    lastSalesReportArgs = { baseFlight, flyDateStr, resultId, flightCode, hostId };
    destroyChartsByPrefix('report-');

    const salesByDealDate = typeof collectSalesByDealDateForFlightDate === 'function'
        ? collectSalesByDealDateForFlightDate(baseFlight, flyDateStr, salesFlight)
        : {};

    const sortedDealDates = Object.keys(salesByDealDate).sort((a, b) => {
        const da = parseLocalDate(a)?.getTime() || 0;
        const db = parseLocalDate(b)?.getTime() || 0;
        return da - db;
    });

    const flightRow = getFlightRowForDate(baseFlight, flyDateStr, salesFlight);
    const aircraftCode = flightRow ? flightRow[4] : '';
    const loadPax = flightRow ? (parseInt(flightRow[6] || 0, 10) || 0) : 0;
    const seats = flightRow ? getSeatsOnSale(flightRow) : 0;
    const finalExpectedLoad = getExpectedLoadForFlightDate(baseFlight, flyDateStr, aircraftCode);

    let totalTickets = 0, totalRevenue = 0;
    sortedDealDates.forEach(dealDate => {
        totalTickets += salesByDealDate[dealDate].count;
        totalRevenue += salesByDealDate[dealDate].totalFare;
    });
    const overallAvg = totalTickets > 0 ? Math.round(totalRevenue / totalTickets) : 0;

    const period = salesChartPeriodDays || 30;
    const flyParsed = parseLocalDate(flyDateStr);
    const flyDt = flyParsed ? new Date(flyParsed.getTime()) : new Date();
    flyDt.setHours(0, 0, 0, 0);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    let rangeEnd = flyDt < today ? new Date(flyDt.getTime()) : new Date(today.getTime());
    let rangeStart = new Date(rangeEnd);
    rangeStart.setDate(rangeStart.getDate() - (period - 1));
    const saleInWindow = sortedDealDates.some(d => {
        const dt = parseLocalDate(d);
        return dt && dt >= rangeStart && dt <= rangeEnd;
    });
    if (!saleInWindow && sortedDealDates.length) {
        const lastSale = parseLocalDate(sortedDealDates[sortedDealDates.length - 1]);
        const firstSale = parseLocalDate(sortedDealDates[0]);
        if (lastSale) {
            rangeEnd = new Date(lastSale.getTime());
            rangeEnd.setHours(0, 0, 0, 0);
            rangeStart = new Date(rangeEnd);
            rangeStart.setDate(rangeStart.getDate() - (period - 1));
            if (firstSale && firstSale > rangeStart) rangeStart = new Date(firstSale.getTime());
        }
    } else if (sortedDealDates.length) {
        const firstSale = parseLocalDate(sortedDealDates[0]);
        if (firstSale && firstSale < rangeStart && period >= 90) rangeStart = new Date(firstSale.getTime());
    }

    const allDates = buildDateRangeInclusive(rangeStart, rangeEnd);
    let cumulative = 0;
    // seed cumulative before range
    sortedDealDates.forEach(d => {
        const dt = parseLocalDate(d);
        if (dt && dt < rangeStart) cumulative += salesByDealDate[d].count;
    });
    const cumulativeData = allDates.map(dateStr => {
        const daily = salesByDealDate[dateStr]?.count || 0;
        cumulative += daily;
        const dealDt = parseLocalDate(dateStr);
        const dtd = dealDt ? Math.ceil((flyDt - dealDt) / 86400000) : null;
        const cap = getCapacityFromAircraft(getAircraftType(aircraftCode));
        const wk = getWeekForExpectedLoad(flyDateStr);
        const expAtPoint = dtd !== null ? getExpectedLoad(cap, baseFlight, dtd, wk) : null;
        return {
            date: dateStr,
            label: formatChartDateLabel(dateStr, allDates.length > 20),
            cumulative,
            daily,
            dtd,
            expectedAtPoint: expAtPoint !== null ? Math.ceil(expAtPoint) : null
        };
    });

    const dtdCurve = buildFlightDtdBookingSeries(baseFlight, flyDateStr, salesFlight, period, aircraftCode);
    const comment = typeof FlightComments !== 'undefined' ? FlightComments.get(salesFlight, flyDateStr) : '';
    const metricsRow = flightRow && typeof getRowMetrics === 'function' ? getRowMetrics(flightRow, baseFlight) : null;
    const expR = finalExpectedLoad !== null ? Math.ceil(finalExpectedLoad) : null;
    const deltaNow = metricsRow && metricsRow.delta != null ? metricsRow.delta : null;
    const pct = seats > 0 ? Math.round(loadPax / seats * 100) : null;
    const chip = (label, value, extra) => `<span class="sd-kpi"><span class="sd-kpi-label">${label}</span><strong>${value}</strong>${extra || ''}</span>`;
    const periodBtn = (n) => `<button type="button" class="sd-period-btn sales-period-btn${period === n ? ' sd-on' : ''}" data-period="${n}">${n}</button>`;

    // Продажи по тарифам: лестница цен — что продаётся, по какой цене и когда в последний раз.
    const fareRows = (() => {
        const list = typeof getFlightSalesList === 'function' ? getFlightSalesList(flyDateStr, salesFlight) : [];
        const cut = typeof salesDataCutoffTime === 'function' ? salesDataCutoffTime() : Date.now();
        const weekAgo = cut - 6 * 86400000;
        const map = new Map();
        list.forEach(s => {
            const root = String(s.basicFareStr || '').trim().split('/')[0].toUpperCase() || '—';
            const child = /\/(CN|IN|ID)\d/i.test(String(s.basicFareStr || ''));
            const price = Math.round(Number(s.fare) || 0);
            const key = root + '|' + price;
            let f = map.get(key);
            if (!f) map.set(key, f = { root, price, n: 0, child: 0, last: '', lastT: 0, week: 0 });
            f.n++;
            if (child) f.child++;
            const t = parseLocalDate(s.dealDate)?.getTime() || 0;
            if (t >= f.lastT) { f.lastT = t; f.last = s.dealDate; }
            if (t >= weekAgo) f.week++;
        });
        return [...map.values()].sort((a, b) => b.price - a.price || b.n - a.n);
    })();
    const fareTotal = fareRows.reduce((a, f) => a + f.n, 0);
    const fareHtml = fareRows.length ? `
        <div class="sd-block">
            <div class="sd-block-head"><h5>Продажи по тарифам</h5><span class="sd-muted">от дорогих к дешёвым · ${fareTotal} бил.</span></div>
            <div class="report-table-scroll">
                <table class="report-data-table sd-fare-table">
                    <thead><tr><th class="sd-left">Тариф</th><th>Цена</th><th>Билетов</th><th class="sd-left">Доля</th><th>За 7 дней</th><th>Последняя продажа</th></tr></thead>
                    <tbody>${fareRows.map(f => {
                        const share = fareTotal ? Math.round(f.n / fareTotal * 100) : 0;
                        return `<tr class="${f.week ? '' : 'sd-fare-stale'}">
                            <td class="sd-left"><strong>${escHtml(f.root)}</strong>${f.child ? ` <span class="sd-muted">дет. ${f.child}</span>` : ''}</td>
                            <td>${f.price ? formatRub(f.price) : '0 ₽'}</td>
                            <td><strong>${f.n}</strong></td>
                            <td class="sd-left"><span class="sd-bar"><i style="width:${share}%"></i></span> ${share}%</td>
                            <td>${f.week || '—'}</td>
                            <td>${escHtml(f.last || '—')}</td>
                        </tr>`;
                    }).join('')}</tbody>
                </table>
            </div>
        </div>` : '';

    resultDiv.innerHTML = `
        <div class="sd-top">
            <div class="sd-kpis">
                ${chip('Продано', totalTickets)}
                ${chip('Выручка', formatRub(Math.round(totalRevenue)))}
                ${chip('Ср. тариф', overallAvg ? formatRub(overallAvg) : '—')}
                ${chip('Загрузка', `${formatNum(loadPax)}/${formatNum(seats)}`, pct != null ? ` <span class="sd-muted">${pct}%</span>` : '')}
                ${chip('Ожидаемая', expR != null ? expR : '—', deltaNow != null ? ` <span class="${deltaNow < 0 ? 'sd-neg' : 'sd-pos'}">${deltaNow > 0 ? '+' : ''}${deltaNow}</span>` : '')}
            </div>
            <div class="sd-tools">
                <span class="sd-period">${[7, 14, 30, 90].map(periodBtn).join('')}<input type="number" id="sales-period-custom" class="sd-period-input" min="1" max="400" value="${period}" title="Свой период, дней"><button type="button" class="sd-period-btn" id="sales-period-apply">OK</button></span>
                <button type="button" class="sd-comment-btn${comment ? ' sd-has' : ''}" data-sd="comment" title="${comment ? escAttr(comment) : 'Добавить комментарий'}">💬${comment ? ' 1' : ''}</button>
            </div>
        </div>
        <div class="sd-comment" hidden>${buildFlightCommentBlockHtml(salesFlight, flyDateStr)}</div>
        ${comment ? `<div class="sd-comment-text">💬 ${escHtml(comment)}</div>` : ''}
        <div class="sd-verdict-row">
            <div class="booking-curve-verdict ${dtdCurve.verdictCls}">${dtdCurve.verdictHtml}</div>
            ${typeof PriceMarks !== 'undefined' ? PriceMarks.buttonsHtml(salesFlight, flyDateStr) : ''}
        </div>
        <div class="sd-block">
            <div class="sd-block-head">
                <h5>Продажи по дням и накоплено</h5>
                <span class="sd-muted">столбики — билеты за день · синяя — накоплено · серая — ${escHtml(dtdCurve.refLabel || 'норма')} · оранжевая — ожидаемая</span>
                <button type="button" onclick="expandReportChart('report-combined', 'Продажи по дням и накоплено')" class="chart-expand-btn" title="Развернуть">⛶</button>
            </div>
            <div class="chart-scroll-x"><div class="chart-container sd-chart" style="min-width:${Math.max(280, allDates.length * 16)}px"><canvas id="report-combined"></canvas></div></div>
            <details class="sd-howto"><summary>ⓘ Как читать и из чего норма</summary><p class="sales-chart-sub">${escHtml(dtdCurve.caption)}</p>${buildWeekdayNormTableHtml(dtdCurve)}</details>
        </div>
        ${typeof PriceMarks !== 'undefined' ? PriceMarks.decisionsHtml(baseFlight, salesFlight, flyDateStr) : ''}
        ${fareHtml}
        <details class="sd-block sd-collapsed">
            <summary>Продажи по датам покупки</summary>
            <div class="report-table-scroll">
                <table class="report-data-table sales-detail-table">
                    <thead><tr><th class="col-date">Дата покупки</th><th>День</th><th>Билетов</th><th>Средний тариф</th></tr></thead>
                    <tbody>
                        ${sortedDealDates.length ? sortedDealDates.slice().reverse().map(dealDate => {
                            const data = salesByDealDate[dealDate];
                            const avg = data.count > 0 ? Math.round(data.totalFare / data.count) : 0;
                            return `<tr><td class="col-date">${escHtml(dealDate)}</td><td>${escHtml(getDayOfWeek(dealDate))}</td><td><strong>${data.count}</strong></td><td>${formatRub(avg)}</td></tr>`;
                        }).join('') : '<tr><td colspan="4">Нет продаж</td></tr>'}
                    </tbody>
                </table>
            </div>
        </details>
    `;

    bindFlightCommentBox(resultDiv);
    resultDiv.querySelector('[data-sd="comment"]')?.addEventListener('click', () => {
        const box = resultDiv.querySelector('.sd-comment');
        if (!box) return;
        box.hidden = !box.hidden;
        if (!box.hidden) box.querySelector('textarea')?.focus();
    });
    resultDiv.querySelectorAll('.sales-period-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            salesChartPeriodDays = parseInt(btn.dataset.period, 10) || 30;
            buildFlightSalesReportFor(baseFlight, flyDateStr, resultId, flightCode);
        });
    });
    const applyPeriod = () => {
        const inp = resultDiv.querySelector('#sales-period-custom');
        let v = parseInt(inp?.value, 10);
        if (isNaN(v) || v < 1) v = 1;
        if (v > 400) v = 400;
        salesChartPeriodDays = v;
        buildFlightSalesReportFor(baseFlight, flyDateStr, resultId, flightCode);
    };
    resultDiv.querySelector('#sales-period-apply')?.addEventListener('click', applyPeriod);
    resultDiv.querySelector('#sales-period-custom')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); applyPeriod(); }
    });

    setTimeout(() => {
        if (typeof Chart === 'undefined') return;
        // Один график на оси дат: столбики — билеты за день, линии — накоплено, норма и ожидаемая
        // (норма и ожидаемая считаются по «дням до вылета» и переносятся на дату).
        const n = cumulativeData.length;
        const tickStep = n <= 12 ? 1 : n <= 24 ? 2 : n <= 45 ? 3 : n <= 90 ? 5 : 7;
        const labels = cumulativeData.map(d => d.label);
        const fly = parseLocalDate(flyDateStr);
        const byDate = (arr) => cumulativeData.map(pt => {
            if (!arr || !fly) return null;
            const d = parseLocalDate(pt.date);
            const i = d ? dtdCurve.dtds.indexOf(Math.round((fly - d) / 86400000)) : -1;
            return i < 0 ? null : arr[i];
        });
        const datasets = [{
            type: 'line', label: 'Накоплено', data: cumulativeData.map(d => d.cumulative), yAxisID: 'y1',
            borderColor: '#1d4ed8', backgroundColor: 'rgba(29, 78, 216, 0.07)', fill: true, tension: 0.15,
            pointRadius: n > 60 ? 0 : 2, borderWidth: 2.5, order: 1
        }];
        if (dtdCurve.refData && dtdCurve.refBand) {
            datasets.push({ type: 'line', label: 'Разброс нормы', data: byDate(dtdCurve.refBand.hi), yAxisID: 'y1', borderWidth: 0, pointRadius: 0, backgroundColor: 'rgba(100, 116, 139, 0.13)', fill: '+1', spanGaps: true, tension: 0.15, _band: true, order: 3 },
                { type: 'line', label: 'Разброс нормы (низ)', data: byDate(dtdCurve.refBand.lo), yAxisID: 'y1', borderWidth: 0, pointRadius: 0, backgroundColor: 'transparent', fill: false, spanGaps: true, tension: 0.15, _band: true, _hideLegend: true, order: 3 });
        }
        if (dtdCurve.refData) {
            datasets.push({ type: 'line', label: dtdCurve.refLabel || 'Норма', data: byDate(dtdCurve.refData), yAxisID: 'y1', borderColor: '#64748b', borderDash: [5, 4], fill: false, tension: 0.15, pointRadius: 0, borderWidth: 2, spanGaps: true, order: 2 });
        }
        if (dtdCurve.expectedData) {
            datasets.push({ type: 'line', label: 'Ожидаемая', data: byDate(dtdCurve.expectedData), yAxisID: 'y1', borderColor: '#d97706', borderDash: [6, 4], fill: false, tension: 0.15, pointRadius: 0, borderWidth: 2, spanGaps: true, order: 2 });
        }
        const maxDaily = Math.max(1, ...cumulativeData.map(d => d.daily));
        datasets.push({
            type: 'bar', label: 'Билетов за день', data: cumulativeData.map(d => d.daily), yAxisID: 'y',
            backgroundColor: 'rgba(16, 185, 129, 0.55)', borderColor: '#059669', borderWidth: 1, borderRadius: 2,
            maxBarThickness: n > 60 ? 8 : 18, order: 4
        });
        const config = {
            type: 'bar',
            data: { labels, datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { labels: { boxWidth: 12, font: { size: 11 }, color: '#0f172a', filter: (item, data) => !data.datasets[item.datasetIndex]._hideLegend } },
                    priceMarks: {
                        items: typeof PriceMarks !== 'undefined'
                            ? PriceMarks.chartItems(salesFlight, flyDateStr, m => cumulativeData.findIndex(pt => pt.date === m.check))
                            : []
                    },
                    tooltip: {
                        filter: (item) => !item.dataset._band,
                        callbacks: {
                            title: (items) => {
                                const pt = cumulativeData[items[0]?.dataIndex];
                                return pt ? `${pt.date} (${getDayOfWeek(pt.date)}) · ${pt.dtd} дн. до вылета` : '';
                            }
                        }
                    }
                },
                scales: {
                    y1: { position: 'left', beginAtZero: true, title: { display: true, text: 'накоплено' }, ticks: { color: '#334155' }, grid: { color: 'rgba(148,163,184,0.25)' } },
                    // Ось «за день» выше максимума в 3 раза: столбики внизу и не закрывают линии.
                    y: { position: 'right', beginAtZero: true, suggestedMax: maxDaily * 3, title: { display: true, text: 'за день' }, ticks: { stepSize: 1, color: '#64748b' }, grid: { display: false } },
                    x: {
                        ticks: {
                            maxRotation: n > 20 ? 90 : 45, minRotation: n > 20 ? 90 : 0, autoSkip: false,
                            font: { size: n > 40 ? 8 : 9 }, color: '#334155',
                            callback: (val, idx) => (idx === 0 || idx === n - 1 || idx % tickStep === 0) ? (labels[idx] || '') : ''
                        },
                        grid: { display: false }
                    }
                }
            }
        };
        reportChartExpandConfigs['report-combined'] = config;
        createManagedChart('report-combined', config);
    }, 80);
}

// После отметки за сегодня — перерисовать открытую детализацию (кнопки и маркеры).
document.addEventListener('krasavia:mark', () => refreshOpenSalesReport());
