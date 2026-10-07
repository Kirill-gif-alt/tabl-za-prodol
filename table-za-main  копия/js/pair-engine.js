// js\pair-engine.js - extracted from script.js, logic unchanged.
// Globals on purpose: no bundler; onclick and other files call by name.

function getFlightPair(base) {
    const n = parseInt(String(base || '').replace('KV-', ''), 10) || 0;
    if (!n) return { outbound: base, inbound: null };
    const outboundN = n % 2 === 1 ? n : n - 1;
    const inboundN = outboundN + 1;
    return { outbound: 'KV-' + outboundN, inbound: 'KV-' + inboundN };
}

function getActualFlightsInBucket(bucket) {
    const set = new Set();
    (groupedData[bucket] || []).forEach(row => {
        const f = cleanFlight(row[0]);
        if (f && isValidFlightBase(f)) set.add(f);
    });
    return [...set].sort((a, b) => parseInt(a.replace('KV-', ''), 10) - parseInt(b.replace('KV-', ''), 10));
}

function getAvailablePairsForBase(selectedBase) {
    const bucket = getBaseFlight(selectedBase);
    const actuals = getActualFlightsInBucket(bucket);
    const seen = new Set();
    const pairs = [];
    actuals.forEach(f => {
        const p = getFlightPair(f);
        if (!seen.has(p.outbound)) {
            seen.add(p.outbound);
            pairs.push(p);
        }
    });
    return pairs.sort((a, b) =>
        parseInt(a.outbound.replace('KV-', ''), 10) - parseInt(b.outbound.replace('KV-', ''), 10)
    );
}

function resolvePairForSelection(selectedBase) {
    const preferred = getFlightPair(selectedBase);
    const available = getAvailablePairsForBase(selectedBase);
    if (!available.length) return preferred;

    const hit = available.find(p => p.outbound === preferred.outbound || p.inbound === preferred.inbound);
    if (hit) return hit;

    const selN = parseInt(String(selectedBase).replace('KV-', ''), 10) || 0;
    return available.slice().sort((a, b) => {
        const da = Math.abs(parseInt(a.outbound.replace('KV-', ''), 10) - selN);
        const db = Math.abs(parseInt(b.outbound.replace('KV-', ''), 10) - selN);
        return da - db;
    })[0];
}

function isOutboundFlightCode(flightCode) {
    const n = parseInt(cleanFlight(flightCode).replace('KV-', ''), 10);
    return n % 2 === 1;
}

function getRowsForPairLeg(flightCode) {
    if (!flightCode) return [];
    const bucket = getBaseFlight(flightCode);
    const wantOutbound = isOutboundFlightCode(flightCode);
    return (groupedData[bucket] || []).filter(row => {
        if (!row[1] || !row[0]) return false;
        const n = parseInt(cleanFlight(row[0]).replace('KV-', ''), 10);
        return wantOutbound ? (n % 2 === 1) : (n % 2 === 0);
    });
}

function filterPairLegRows(rows, todayStart) {
    if (tableFilterStatus === 'all') return rows;
    return rows.filter(row => flightRowMatchesStatusFilter(row, todayStart));
}

/** Дата в ячейке: одна дата или «11.08/12.08» при переходящих сутках туда/обратно */
function formatPairDateLabel(outRow, inRow, fallbackDate) {
    const outDate = outRow?.[1] || '';
    const inDate = inRow?.[1] || '';
    if (outDate && inDate && outDate !== inDate) {
        // короткий вид: DD.MM / DD.MM.YYYY или DD.MM/DD.MM если год один
        const short = (d) => {
            const p = String(d).split('.');
            return p.length === 3 ? `${p[0]}.${p[1]}` : d;
        };
        const yo = outDate.split('.')[2];
        const yi = inDate.split('.')[2];
        if (yo && yi && yo === yi) {
            return `${short(outDate)}/${short(inDate)}.${yo}`;
        }
        return `${outDate}/${inDate}`;
    }
    return outDate || inDate || fallbackDate || '';
}

/** День недели: «Пт» или «Пт/Сб» при переходящих сутках */
function formatPairDayOfWeek(outRow, inRow, fallbackDate) {
    const outDate = outRow?.[1] || '';
    const inDate = inRow?.[1] || '';
    if (outDate && inDate && outDate !== inDate) {
        const dOut = getDayOfWeek(outDate);
        const dIn = getDayOfWeek(inDate);
        if (dOut && dIn) return `${dOut}/${dIn}`;
        return dOut || dIn || '—';
    }
    const d = outDate || inDate || fallbackDate || '';
    return d ? getDayOfWeek(d) : '—';
}

function pairFlightNumHtml(row, pairCode, dirCls) {
    if (!row || !pairCode) return '';
    const orig = cleanFlight(row[0]);
    if (!orig || orig === pairCode) return '';
    const num = orig.replace(/^KV-/, '');
    const extraCls = dirCls === 'pair-flight-out' ? 'pair-dop-out' : 'pair-dop-in';
    return `<span class="pair-flight-no ${dirCls} pair-dop-tag ${extraCls}" title="${escAttr(orig)}">${escHtml(num)}</span>`;
}

function buildPairRowDateCell(date, outRow, inRow, outbound, inbound) {
    const label = formatPairDateLabel(outRow, inRow, date);
    const overnight = !!(outRow?.[1] && inRow?.[1] && outRow[1] !== inRow[1]);
    const flags = typeof FlightChecks !== 'undefined'
        ? [outRow, inRow].map(r => FlightChecks.flagForRow(r)).join('')
        : '';
    const dateHtml = `<span class="pair-date-val${overnight ? ' pair-date-overnight' : ''}">${escHtml(label)}</span>${flags}`;
    const nums = [
        pairFlightNumHtml(outRow, outbound, 'pair-flight-out'),
        pairFlightNumHtml(inRow, inbound, 'pair-flight-in')
    ].filter(Boolean);
    if (!nums.length) return dateHtml;
    return `<span class="pair-date-line">${dateHtml}<span class="pair-flight-nos">${nums.join('<span class="pair-flight-nos-sep">/</span>')}</span></span>`;
}

function buildPairSegmentCell(outRow, inRow, routeCounts) {
    const pick = [outRow, inRow].find(r => r && shouldShowRouteForRow(r, routeCounts));
    if (!pick) return '';
    const route = getRouteFromRow(pick);
    return `<span class="segment-cell"><span class="segment-route">${escHtml(formatRouteDisplay(route))}</span></span>`;
}

function flightRowMatchesStatusFilter(row, todayStart) {
    if (!row) return false;
    const date = row[1];
    const total = parseInt(row[5] || 0), free = parseInt(row[6] || 0), avs = parseInt(row[8] || 0);
    const k = getSalesLookupKey(row);
    const closed = closedFlights.has(k);
    const fd = parseLocalDate(date);
    const flew = fd ? fd < todayStart : false;
    const denom = total - avs;
    const pct = (total > 0 && denom > 0) ? Math.round(free / denom * 100) : 0;
    const rowBase = cleanFlight(row[0]);

    if (tableFilterStatus === 'closed') return closed || flew;
    if (tableFilterStatus === 'open') return !closed && !flew;
    if (tableFilterStatus === 'full') return pct >= 100 && !closed && !flew;
    if (tableFilterStatus === 'attention') return isFlightNeedsAttention(row, rowBase);
    return true;
}

function getTableSortValue(row, base) {
    const date = row[1];
    const total = parseInt(row[5] || 0), free = parseInt(row[6] || 0), avs = parseInt(row[8] || 0);
    const s = getSalesMapForRow(row);
    const denom = total - avs;
    const pct = (total > 0 && denom > 0) ? Math.round(free / denom * 100) : 0;

    if (tableSort.by === 'load') return pct;
    if (tableSort.by === 'sales') return s.today;
    if (tableSort.by === 'avgfare') return getSalesAggForKey(resolveSalesKey(row)).avg;
    if (tableSort.by === 'delta') return getRowDelta(row, base);
    return parseLocalDate(date)?.getTime() || 0;
}


function getSpecBookings(row) {
    if (!row) return 0;
    const n = parseInt(row[8] || 0, 10);
    return isNaN(n) || n < 0 ? 0 : n;
}

/** AU снимка = поле total файла (row[5]). Не физическая ёмкость ВС. */
function getAuFromRow(row) {
    if (!row) return 0;
    const n = parseInt(row[5] || 0, 10);
    return isNaN(n) || n < 0 ? 0 : n;
}

/** sold / загрузка = поле free файла (row[6]). Это НЕ свободные места. */
function getSoldFromRow(row) {
    if (!row) return 0;
    const n = parseInt(row[6] || 0, 10);
    return isNaN(n) || n < 0 ? 0 : n;
}

/** Кресла в продаже = AU снимка − спец. брони */
function getSeatsOnSale(row) {
    if (!row) return 0;
    return Math.max(0, getAuFromRow(row) - getSpecBookings(row));
}

/** Остаток = AU − sold − avs */
function getSeatRemainder(row) {
    if (!row) return 0;
    return getAuFromRow(row) - getSoldFromRow(row) - getSpecBookings(row);
}

function hasSalesFileLoaded() {
    return !!(typeof dataLoadStatus !== 'undefined' && dataLoadStatus.sales);
}

function hasExpectedFileLoaded() {
    return !!(typeof dataLoadStatus !== 'undefined' && dataLoadStatus.expected)
        || (typeof expectedLoadData !== 'undefined' && Object.keys(expectedLoadData || {}).length > 0);
}

function buildFlightLegMetrics(row, firstSalesByKey, todayStart) {
    if (!row) {
        return {
            empty: true,
            seats: '—', bookings: '—', load: '—', zpk: '—',
            salesToday: '—', salesYest: '—', avg: '—', last: '—', revenue: '—', revenueNum: 0,
            costText: '—', costNum: 0, costTitle: '',
            subsidyAmt: 0, subsidyOneWay: 0, subsidized: false,
            rowCls: 'pair-leg-empty'
        };
    }
    const date = row[1];
    const free = parseInt(row[6] || 0, 10) || 0;
    const avs = getSpecBookings(row);
    const seatsOnSale = getSeatsOnSale(row);
    const showSales = shouldAttachSalesToRowCached(row, firstSalesByKey);
    const s = showSales ? getSalesMapForRow(row) : { today: 0, yesterday: 0 };
    const k = getSalesLookupKey(row);
    const closed = closedFlights.has(k);
    const fd = parseLocalDate(date);
    const flew = fd ? fd < todayStart : false;
    // ЗПК: загрузка / кресла в продаже
    const denom = seatsOnSale;
    const pct = (denom > 0) ? Math.round(free / denom * 100) : null;

    let avg = 0, last = 0, lettr = '';
    if (showSales) {
        const agg = getSalesAggForKey(resolveSalesKey(row));
        avg = agg.avg;
        last = agg.last;
        lettr = agg.lettr;
    }

    let rowCls = (getWeekNumber(fd) % 2 === 0) ? 'week-even' : 'week-odd';
    if (closed) rowCls = 'closed-flight';
    else if (flew) rowCls = 'flew-flight';
    else if (pct != null && pct >= 100) rowCls = 'full-loaded';

    const zpk = (closed || flew)
        ? (closed ? '<span class="closed-text">ЗАКРЫТ</span>' : '<span class="flew-text">УЛЕТЕЛ</span>')
        : (pct == null ? '—' : `<span class="${pct >= 75 ? 'occupancy-high' : 'occupancy-med'}">${pct}%</span>`);

    const revenue = showSales ? getRevenueForRow(row, firstSalesByKey) : 0;

    const flightCode = cleanFlight(row[0]);
    const econ = typeof RouteCosts !== 'undefined' ? RouteCosts.lookup(row, flightCode, date) : null;
    const costNum = econ && econ.unitCost != null ? econ.unitCost : 0;
    const costText = econ && econ.unitCost != null ? formatRub(econ.unitCost) : '—';
    const costTitle = '';

    return {
        empty: false,
        seats: formatNum(seatsOnSale),
        bookings: formatNum(avs),
        load: formatNum(free),
        zpk,
        salesToday: showSales ? formatNum(s.today) : '—',
        salesYest: showSales ? formatNum(s.yesterday) : '—',
        avg: showSales && avg ? formatRub(avg) : (showSales ? '—' : '—'),
        last: showSales && last ? formatRub(last) + (lettr ? ' / ' + lettr : '') : '—',
        revenue: showSales && revenue ? formatRub(revenue) : '—',
        revenueNum: revenue,
        costText,
        costNum,
        costTitle,
        subsidyAmt: econ ? (econ.subsidyAmt || 0) : 0,
        subsidyCalc: econ ? (econ.subsidyOneWay || 0) : 0,
        subsidyOneWay: (typeof SharedOverrides !== 'undefined' && SharedOverrides.hasSubsidy(flightCode, date))
            ? (SharedOverrides.getSubsidy(flightCode, date) || 0)
            : (econ ? (econ.subsidyOneWay || 0) : 0),
        subsidyOverridden: !!(typeof SharedOverrides !== 'undefined' && SharedOverrides.hasSubsidy(flightCode, date)),
        subsidized: (typeof SharedOverrides !== 'undefined' && SharedOverrides.hasSubsidy(flightCode, date))
            ? ((SharedOverrides.getSubsidy(flightCode, date) || 0) !== 0)
            : !!(econ && econ.subsidized),
        rowCls,
        flightBase: flightCode,
        date
    };
}


function sortRowsByDepTime(rows) {
    return (rows || []).slice().sort((a, b) => {
        if (typeof compareRowsByDateThenDep === 'function') {
            return compareRowsByDateThenDep(a, b, 'asc');
        }
        const da = compareDateStr(a[1], b[1]);
        if (da !== 0) return da;
        const ta = typeof timeToMinutes === 'function' ? timeToMinutes(getDepTime(a)) : 0;
        const tb = typeof timeToMinutes === 'function' ? timeToMinutes(getDepTime(b)) : 0;
        return ta - tb;
    });
}

/** Номер «туда» пары: 111↔112, 153↔154, 311↔312, 353↔354 (нечётный из пары) */
function getPairOutboundNum(flightCodeOrRow) {
    const code = Array.isArray(flightCodeOrRow)
        ? cleanFlight(flightCodeOrRow[0])
        : cleanFlight(flightCodeOrRow);
    const n = parseInt(String(code || '').replace('KV-', ''), 10) || 0;
    if (!n) return 0;
    return n % 2 === 1 ? n : n - 1;
}

/** Тип ВС для склейки туда/обратно (нормализованный) */
function getPairAircraftKey(row) {
    if (!row) return '';
    const ac = typeof getAircraftType === 'function' ? getAircraftType(row[4]) : String(row[4] || '');
    return String(ac || '').trim().toUpperCase() || '-';
}

/** Дней между датами DD.MM.YYYY (in − out) */
function daysBetweenFlightDates(outDate, inDate) {
    const a = typeof parseLocalDate === 'function' ? parseLocalDate(outDate) : null;
    const b = typeof parseLocalDate === 'function' ? parseLocalDate(inDate) : null;
    if (!a || !b) return NaN;
    return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/** Сортировка парных строк: дата (туда), затем время вылета */
function comparePairEntriesByDateThenDep(a, b, dir = 'asc') {
    const sign = dir === 'desc' ? -1 : 1;
    const da = compareDateStr(a.date, b.date);
    if (da !== 0) return sign * da;
    const rowA = a.outRow || a.inRow;
    const rowB = b.outRow || b.inRow;
    if (rowA && rowB && typeof compareRowsByDateThenDep === 'function') {
        return compareRowsByDateThenDep(rowA, rowB, dir);
    }
    const ta = typeof timeToMinutes === 'function' ? timeToMinutes(getDepTime(rowA)) : 0;
    const tb = typeof timeToMinutes === 'function' ? timeToMinutes(getDepTime(rowB)) : 0;
    return sign * (ta - tb);
}

/**
 * Стыковка одной пары номеров (111↔112, 311↔312, 353↔354…):
 * — жёстко outN ↔ outN+1;
 * — одинаковый тип ВС;
 * — тот же день или переходящие сутки (обратно на 0…+2 дня);
 * — по времени: исключения ок (например 354 раньше 353 в тот же день).
 */
function matchPairLegsTurnaround(outRows, inRows) {
    const outs = sortRowsByDepTime(outRows || []);
    const ins = sortRowsByDepTime(inRows || []);
    const usedIn = new Set();
    const entries = [];

    outs.forEach((out) => {
        const outDate = out[1];
        const outDep = typeof timeToMinutes === 'function' ? timeToMinutes(getDepTime(out)) : 0;
        const outAc = getPairAircraftKey(out);
        let bestIdx = -1;
        let bestScore = Infinity;

        for (let i = 0; i < ins.length; i++) {
            if (usedIn.has(i)) continue;
            const inn = ins[i];
            // одинаковый тип ВС — обязателен для «туда-обратно»
            if (getPairAircraftKey(inn) !== outAc) continue;
            const dayDiff = daysBetweenFlightDates(outDate, inn[1]);
            // только тот же день или обратный после «туда» (переходящие сутки), не «вчера»
            if (isNaN(dayDiff) || dayDiff < 0 || dayDiff > 2) continue;
            const inDep = typeof timeToMinutes === 'function' ? timeToMinutes(getDepTime(inn)) : 0;
            // приоритет: тот же день → ближайшие сутки;
            // внутри дня — ближайшее время к вылету «туда» (354 раньше 353 тоже допускается)
            const timeGap = Math.abs(inDep - outDep);
            const score = dayDiff * 100000 + timeGap;
            if (score < bestScore) {
                bestScore = score;
                bestIdx = i;
            }
        }

        if (bestIdx >= 0) {
            usedIn.add(bestIdx);
            entries.push({
                sortDate: outDate,
                date: outDate,
                outRow: out,
                inRow: ins[bestIdx]
            });
        } else {
            entries.push({
                sortDate: outDate,
                date: outDate,
                outRow: out,
                inRow: null
            });
        }
    });

    for (let i = 0; i < ins.length; i++) {
        if (usedIn.has(i)) continue;
        const inn = ins[i];
        entries.push({
            sortDate: inn[1],
            date: inn[1],
            outRow: null,
            inRow: inn
        });
    }

    return entries;
}

/**
 * Жёстко: 111↔112, 153↔154, 311↔312, 353↔354…
 * + одинаковый тип ВС; переходящие сутки → одна строка, дата через «/».
 */
function buildPairTableEntries(outRows, inRows) {
    const groups = new Map();

    (outRows || []).forEach((r) => {
        if (!r || !r[1] || !r[0]) return;
        const outN = getPairOutboundNum(r);
        if (!outN) return;
        const n = parseInt(cleanFlight(r[0]).replace('KV-', ''), 10) || 0;
        if (n !== outN) return;
        if (!groups.has(outN)) groups.set(outN, { outs: [], ins: [] });
        groups.get(outN).outs.push(r);
    });
    (inRows || []).forEach((r) => {
        if (!r || !r[1] || !r[0]) return;
        const outN = getPairOutboundNum(r);
        if (!outN) return;
        const n = parseInt(cleanFlight(r[0]).replace('KV-', ''), 10) || 0;
        if (n !== outN + 1) return;
        if (!groups.has(outN)) groups.set(outN, { outs: [], ins: [] });
        groups.get(outN).ins.push(r);
    });

    let entries = [];
    [...groups.keys()].sort((a, b) => a - b).forEach((key) => {
        const g = groups.get(key);
        entries = entries.concat(matchPairLegsTurnaround(g.outs, g.ins));
    });

    entries.sort((a, b) => comparePairEntriesByDateThenDep(a, b, 'asc'));
    return entries;
}

function buildTableSalesSumRowHtml(beforeSalesCols, sums, fareCols = 0, showExpand = false) {
    // sums: { tSum, ySum, d2Sum, d7Sum, d14Sum, d30Sum } or legacy (tSum, ySum numbers)
    let s = sums;
    if (typeof sums === 'number') {
        s = { tSum: arguments[1], ySum: arguments[2], d2Sum: 0, d7Sum: 0, d14Sum: 0, d30Sum: 0 };
        fareCols = arguments[3] || 0;
        showExpand = arguments[4] || false;
        beforeSalesCols = arguments[0];
    }
    s = s || {};
    const salesReady = typeof hasSalesFileLoaded === 'function' ? hasSalesFileLoaded() : !!(typeof dataLoadStatus !== 'undefined' && dataLoadStatus.sales);
    const sn = (v) => salesReady ? formatNum(v || 0) : '—';
    const farePlaceholders = fareCols > 0
        ? Array.from({ length: fareCols }, () => '<th class="col-extra table-head-sum-skip"></th>').join('')
        : '';
    const expandCell = showExpand ? '<th class="table-head-sum-skip col-expand-head"></th>' : '';
    return `<tr class="table-sales-sum-row">
        <th colspan="${beforeSalesCols}" class="table-head-sum-skip"></th>
        <th class="table-head-sum-cell table-head-sum-today"><span class="table-head-sum-label">Σ</span> ${sn(s.tSum)}</th>
        <th class="table-head-sum-cell table-head-sum-yesterday">${sn(s.ySum)}</th>
        <th class="table-head-sum-cell">${sn(s.d2Sum)}</th>
        <th class="table-head-sum-cell">${sn(s.d7Sum)}</th>
        <th class="table-head-sum-cell">${sn(s.d14Sum)}</th>
        <th class="table-head-sum-cell">${sn(s.d30Sum)}</th>
        ${farePlaceholders}
        ${expandCell}
    </tr>`;
}

function buildPairSalesSumRowHtml(outRevSum, inRevSum, totalRevSum, legBaseCols = 3, legExtraCols = 3) {
    const legSumCells = (revSum, subCls) => {
        const skipAvg = `<th class="col-extra table-head-sum-skip ${subCls}"></th>`;
        const skipLast = `<th class="col-extra table-head-sum-skip ${subCls}"></th>`;
        const revCell = `<th class="col-extra table-head-sum-cell ${subCls}">${revSum ? formatRub(revSum) : '—'}</th>`;
        const splitCls = subCls === 'pair-sub-in' ? ' pair-split-start' : (subCls === 'pair-sub-out' ? ' pair-split-end' : '');
        return `
            <th colspan="${legBaseCols}" class="table-head-sum-skip ${subCls}${splitCls}"></th>
            ${skipAvg}
            ${skipLast}
            ${revCell}`;
    };
    const totalRevCell = `<th class="col-extra table-head-sum-cell pair-total-rev-sum-head">${totalRevSum ? formatRub(totalRevSum) : '—'}</th>`;
    return `<tr class="table-sales-sum-row pair-head-sum">
        ${legSumCells(outRevSum, 'pair-sub-out')}
        ${legSumCells(inRevSum, 'pair-sub-in')}
        ${totalRevCell}
    </tr>`;
}
