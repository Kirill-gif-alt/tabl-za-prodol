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
        if (panel) panel.classList.add('is-hidden');
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
    if (sub) {
        sub.textContent = `${getFlightDirection(salesFlight)} (${salesFlight}) · вылет ${flyDate}`;
    }

    highlightSalesRow(flyDate, salesFlight);
    buildFlightSalesReportFor(flightBase, flyDate, null, salesFlight);

    requestAnimationFrame(() => {
        panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
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
        return typeof getFlightRowForDate === 'function' && !!getFlightRowForDate(baseFlight, dt, code);
    };
    if (hasData(canonical)) return canonical;
    for (const w of [-7, 7, -14, 14, -21, 21]) {
        const dt = shiftDateStr(flyDateStr, -364 + w);
        if (hasData(dt)) return dt;
    }
    return canonical;
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
        dates.push({ date: dtStr, code: salesCode });
    });
    return dates;
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
    const thisCurve = buildOnHandByDtd(flyDateStr, code);
    const asOf = typeof getDaysUntil === 'function' ? getDaysUntil(flyDateStr) : null;
    const axisMin = asOf === null ? 0 : Math.max(0, asOf);
    const lookback = Math.min(180, Math.max(1, parseInt(period, 10) || 30));
    const hi = Math.min(180, axisMin + lookback);
    const dtds = [];
    for (let t = hi; t >= axisMin; t--) dtds.push(t);

    const thisData = dtds.map(t => {
        if (thisCurve.onHand[t] != null) return thisCurve.onHand[t];
        if (t > thisCurve.maxDtd) return 0;
        return thisCurve.total;
    });

    const swlyDate = resolveSwlyDate(baseFlight, flyDateStr, code);
    const swlyHasSales = !!(swlyDate && getFlightSalesList(swlyDate, code).length);
    let refData = null;
    let refLabel = '';
    let caption = 'Кривая 14д: накоплено билетов к моменту «N дней до вылета» (окно файла Tickets_SALE_Last14Days, не полный pickup −21).';
    const dowName = typeof getDayOfWeek === 'function' ? getDayOfWeek(flyDateStr) : '';

    if (swlyHasSales) {
        const swlyCurve = buildOnHandByDtd(swlyDate, code);
        refData = dtds.map(t => {
            if (swlyCurve.onHand[t] != null) return swlyCurve.onHand[t];
            if (t > swlyCurve.maxDtd) return null;
            return swlyCurve.total;
        });
        refLabel = `Год назад, тот же день недели (${swlyDate})`;
        caption = `Серая линия — как продавался этот рейс год назад в тот же день недели (${dowName} ${swlyDate}), не то же календарное число.`;
    } else {
        const cohort = collectSameWeekdayCohort(baseFlight, flyDateStr, code);
        if (cohort.length) {
            const curves = cohort.map(c => buildOnHandByDtd(c.date, c.code));
            refData = dtds.map(t => {
                let sum = 0, n = 0;
                curves.forEach(c => {
                    if (c.onHand[t] != null) { sum += c.onHand[t]; n++; }
                });
                return n ? Math.round(sum / n) : null;
            });
            const prep = weekdayRuPrep(dowName);
            refLabel = `Средняя загрузка по ${prep}, ${code} (${cohort.length} вылетов)`;
            caption = `Серая линия — средняя кривая продаж по ${prep} рейса ${code} (взято ${cohort.length} других вылетов из загруженных данных). Это не «тот же день прошлого года»: такого вылета в файле продаж нет.`;
        } else {
            caption = 'Серая норма не построена: в файле нет других вылетов этого рейса в тот же день недели. Синяя линия — загрузка этого рейса.';
        }
    }

    const nowVal = thisData.length ? thisData[thisData.length - 1] : thisCurve.total;
    const refVal = refData && refData.length ? refData[refData.length - 1] : null;
    let verdict = `На ${axisMin} дн. до вылета продано ${nowVal}`;
    let verdictCls = 'booking-curve-verdict-neutral';
    if (refVal != null && !isNaN(refVal)) {
        const delta = nowVal - refVal;
        if (delta > 0) {
            verdict += ` · норма ${refVal} (+${delta}, опережаем)`;
            verdictCls = 'booking-curve-verdict-up';
        } else if (delta < 0) {
            verdict += ` · норма ${refVal} (${delta}, отстаём)`;
            verdictCls = 'booking-curve-verdict-down';
        } else {
            verdict += ` · норма ${refVal} (как в базе)`;
        }
    }

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

    return { dtds, thisData, refData, refLabel, caption, verdict, verdictCls, expectedData };
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

function buildFlightSalesReportFor(baseFlight, flyDateStr, resultId, flightCode) {
    const hostId = resultId || (currentTab === 'pair' ? 'pair-sales-chart-result' : 'sales-chart-result');
    const resultDiv = document.getElementById(hostId);
    if (!resultDiv || !baseFlight || !flyDateStr) return;

    const salesFlight = cleanFlight(flightCode || baseFlight) || baseFlight;
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

    const commentBlock = buildFlightCommentBlockHtml(salesFlight, flyDateStr);
    const dtdCurve = buildFlightDtdBookingSeries(baseFlight, flyDateStr, salesFlight, period, aircraftCode);

    resultDiv.innerHTML = `
        ${commentBlock}
        <div class="sales-meta-line">
            Загрузка: <strong>${formatNum(loadPax)}</strong> / ${formatNum(seats)} кресел
            ${finalExpectedLoad !== null ? ` · Ожидаемая: <strong>${Math.ceil(finalExpectedLoad)}</strong>` : ''}
        </div>
        <div class="booking-curve-verdict ${dtdCurve.verdictCls}">${escHtml(dtdCurve.verdict)}</div>

        <div class="sales-kpi-row">
            <div class="kpi-card kpi-emerald">
                <div class="kpi-label">Всего продано</div>
                <div class="kpi-value">${totalTickets}</div>
            </div>
            <div class="kpi-card kpi-blue">
                <div class="kpi-label">Выручка</div>
                <div class="kpi-value">${Math.round(totalRevenue).toLocaleString('ru-RU')} ₽</div>
            </div>
            <div class="kpi-card kpi-purple">
                <div class="kpi-label">Средний тариф</div>
                <div class="kpi-value">${overallAvg} ₽</div>
            </div>
        </div>

        <div class="sales-period-bar">
            <span class="sales-period-label">Период:</span>
            <button type="button" class="filter-btn sales-period-btn ${period === 7 ? 'filter-btn-active' : ''}" data-period="7">7</button>
            <button type="button" class="filter-btn sales-period-btn ${period === 14 ? 'filter-btn-active' : ''}" data-period="14">14</button>
            <button type="button" class="filter-btn sales-period-btn ${period === 30 ? 'filter-btn-active' : ''}" data-period="30">30</button>
            <button type="button" class="filter-btn sales-period-btn ${period === 90 ? 'filter-btn-active' : ''}" data-period="90">90</button>
            <label class="sales-period-custom-wrap">
                <span>дней</span>
                <input type="number" id="sales-period-custom" class="sales-period-custom" min="1" max="400" value="${period}" />
                <button type="button" class="filter-btn sales-period-apply" id="sales-period-apply">OK</button>
            </label>

        </div>

        <div class="sales-charts-grid">
            <div class="sales-chart-card">
                <div class="sales-chart-head">
                    <h5>Продажи по дням</h5>
                    <button type="button" onclick="expandReportChart('report-daily-sales', 'Продажи по дням')"
                            class="chart-expand-btn">⛶</button>
                </div>
                <div class="chart-scroll-x"><div class="chart-container sales-chart-canvas" style="min-width:${Math.max(280, allDates.length * 14)}px"><canvas id="report-daily-sales"></canvas></div></div>
            </div>
            <div class="sales-chart-card">
                <div class="sales-chart-head">
                    <div>
                        <h5>Кривая бронирования (дни до вылета)</h5>
                        <p class="sales-chart-sub">${escHtml(dtdCurve.caption)}</p>
                    </div>
                    <button type="button" onclick="expandReportChart('report-booking-curve', 'Кривая бронирования по дням до вылета')"
                            class="chart-expand-btn">⛶</button>
                </div>
                <div class="chart-scroll-x"><div class="chart-container sales-chart-canvas" style="min-width:${Math.max(280, dtdCurve.dtds.length * 14)}px"><canvas id="report-booking-curve"></canvas></div></div>
            </div>
        </div>

        <div class="report-table-scroll">
            <table class="report-data-table sales-detail-table">
                <thead>
                    <tr>
                        <th class="col-date">Дата покупки</th>
                        <th>День</th>
                        <th>Билетов</th>
                        <th>Средний тариф</th>
                    </tr>
                </thead>
                <tbody>
                    ${sortedDealDates.length ? sortedDealDates.map(dealDate => {
                        const data = salesByDealDate[dealDate];
                        const avg = data.count > 0 ? Math.round(data.totalFare / data.count) : 0;
                        return `<tr>
                            <td class="col-date">${escHtml(dealDate)}</td>
                            <td>${escHtml(getDayOfWeek(dealDate))}</td>
                            <td><strong>${data.count}</strong></td>
                            <td>${avg} ₽</td>
                        </tr>`;
                    }).join('') : '<tr><td colspan="4">Нет продаж</td></tr>'}
                </tbody>
            </table>
        </div>
    `;

    bindFlightCommentBox(resultDiv);
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

        const n = cumulativeData.length;
        // Адаптивные подписи: при длинном периоде — каждый N-й день, чтобы не каша
        const tickStep = n <= 12 ? 1 : n <= 24 ? 2 : n <= 45 ? 3 : n <= 90 ? 5 : 7;
        const xTickOpts = {
            maxRotation: n > 20 ? 90 : 45,
            minRotation: n > 20 ? 90 : 0,
            autoSkip: false,
            font: { size: n > 40 ? 8 : 9 },
            callback: function (val, idx) {
                if (idx === 0 || idx === n - 1 || idx % tickStep === 0) {
                    return cumulativeData[idx]?.label || '';
                }
                return '';
            }
        };
        const labels = cumulativeData.map(d => d.label);

        const dailySalesConfig = {
            type: 'bar',
            data: {
                labels,
                datasets: [{
                    label: 'Билетов / день',
                    data: cumulativeData.map(d => d.daily),
                    backgroundColor: cumulativeData.map(d => d.daily > 0 ? 'rgba(16, 185, 129, 0.8)' : 'rgba(203, 213, 225, 0.45)'),
                    borderColor: cumulativeData.map(d => d.daily > 0 ? '#047857' : '#94a3b8'),
                    borderWidth: 1.5,
                    borderRadius: 2,
                    borderSkipped: false,
                    maxBarThickness: n > 60 ? 8 : 18
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            title: (items) => {
                                const idx = items[0]?.dataIndex;
                                if (idx === undefined) return '';
                                const pt = cumulativeData[idx];
                                return `${pt.date} (${getDayOfWeek(pt.date)})`;
                            },
                            label: (item) => `Продаж: ${item.raw}`
                        }
                    }
                },
                scales: {
                    y: { beginAtZero: true, ticks: { stepSize: 1, color: '#334155' }, grid: { color: 'rgba(148,163,184,0.25)' } },
                    x: { ticks: { ...xTickOpts, color: '#334155' }, grid: { display: false } }
                }
            }
        };
        reportChartExpandConfigs['report-daily-sales'] = dailySalesConfig;
        createManagedChart('report-daily-sales', dailySalesConfig);

        const dtdN = dtdCurve.dtds.length;
        const dtdTickStep = dtdN <= 12 ? 1 : dtdN <= 24 ? 2 : dtdN <= 45 ? 3 : dtdN <= 90 ? 5 : 7;
        const dtdLabels = dtdCurve.dtds.map(t => t + 'д');
        const dtdDatasets = [{
            label: 'Загрузка рейса',
            data: dtdCurve.thisData,
            borderColor: '#1d4ed8',
            backgroundColor: 'rgba(29, 78, 216, 0.08)',
            fill: true,
            tension: 0.15,
            pointRadius: dtdN > 60 ? 0 : (dtdN > 30 ? 1.5 : 3),
            pointHoverRadius: 4,
            spanGaps: true,
            borderWidth: 2
        }];
        if (dtdCurve.refData) {
            dtdDatasets.push({
                label: dtdCurve.refLabel,
                data: dtdCurve.refData,
                borderColor: '#64748b',
                borderDash: [5, 4],
                backgroundColor: 'transparent',
                fill: false,
                tension: 0.15,
                pointRadius: 0,
                pointHoverRadius: 3,
                spanGaps: true,
                borderWidth: 2
            });
        }
        if (dtdCurve.expectedData) {
            dtdDatasets.push({
                label: 'Ожидаемая загрузка',
                data: dtdCurve.expectedData,
                borderColor: '#d97706',
                borderDash: [6, 4],
                backgroundColor: 'transparent',
                fill: false,
                tension: 0.15,
                pointRadius: 0,
                pointHoverRadius: 3,
                spanGaps: true,
                borderWidth: 2
            });
        }

        const bookingCurveConfig = {
            type: 'line',
            data: { labels: dtdLabels, datasets: dtdDatasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: {
                        display: true,
                        labels: { color: '#0f172a', boxWidth: 12, font: { size: 11 } }
                    },
                    tooltip: {
                        callbacks: {
                            title: (items) => {
                                const idx = items[0]?.dataIndex;
                                if (idx === undefined) return '';
                                const t = dtdCurve.dtds[idx];
                                return `${t} дн. до вылета`;
                            }
                        }
                    }
                },
                scales: {
                    y: { beginAtZero: true, ticks: { color: '#334155' }, grid: { color: 'rgba(148,163,184,0.25)' } },
                    x: {
                        ticks: {
                            maxRotation: dtdN > 20 ? 90 : 0,
                            minRotation: 0,
                            autoSkip: false,
                            font: { size: dtdN > 40 ? 8 : 9 },
                            color: '#334155',
                            callback: function (val, idx) {
                                if (idx === 0 || idx === dtdN - 1 || idx % dtdTickStep === 0) {
                                    return dtdLabels[idx] || '';
                                }
                                return '';
                            }
                        },
                        grid: { display: false }
                    }
                }
            }
        };
        reportChartExpandConfigs['report-booking-curve'] = bookingCurveConfig;
        createManagedChart('report-booking-curve', bookingCurveConfig);
    }, 80);
}
