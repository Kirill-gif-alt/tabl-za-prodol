// js\data-board-view.js - extracted from script.js, logic unchanged.
// Globals on purpose: no bundler; onclick and other files call by name.

function invalidateDataBoardCache() {
    dataBoardRenderCache = { sig: '', html: '', stats: '' };
    const track = document.getElementById('data-board-track');
    if (track) delete track.dataset.renderSig;
}

function getDataBoardCacheSignature() {
    const hl = typeof DataBoardFilters !== 'undefined' ? DataBoardFilters.signature() : '';
    return `${getMetricsCacheSignature()}|${dataRouteTypeFilter}|${dataSort}|${dataHideFlew ? 1 : 0}|${dataSearchQuery}|${dataShowSpecBookings ? 1 : 0}|${dataShowLocalTimes ? 1 : 0}|h${hl}`;
}

function getDataBoardLegColCount() {
    let n = 3; // крес. · загр. · зпк
    if (dataShowSpecBookings) n += 1;
    if (dataShowLocalTimes) n += 2;
    return n;
}

function getEntryAvgZpk(entry) {
    const pcts = [];
    if (entry.outRow && !isDataLegClosed(entry.outRow)) {
        const z = getDataLegMetrics(entry.outRow).zpk;
        if (z !== null) pcts.push(z);
    }
    if (entry.inRow && !isDataLegClosed(entry.inRow)) {
        const z = getDataLegMetrics(entry.inRow).zpk;
        if (z !== null) pcts.push(z);
    }
    return pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : -1;
}

function getDataPairEntries(pair, todayStart) {
    const outRows = getRowsForPairLeg(pair.outbound);
    const inRows = getRowsForPairLeg(pair.inbound);
    let entries = buildPairTableEntries(outRows, inRows);
    if (!entries.length) return [];

    if (dataHideFlew) {
        entries = entries.filter(entry => {
            const legs = [entry.outRow, entry.inRow].filter(Boolean);
            if (!legs.length) return false;
            return legs.some(row => !isDataLegFlew(row, todayStart));
        });
    }

    if (dataSort === 'date-desc') {
        entries.sort((a, b) => comparePairEntriesByDateThenDep(a, b, 'desc'));
    } else if (dataSort === 'date-asc') {
        entries.sort((a, b) => comparePairEntriesByDateThenDep(a, b, 'asc'));
    } else if (dataSort === 'zpk-desc' || dataSort === 'zpk-asc') {
        const dir = dataSort === 'zpk-desc' ? -1 : 1;
        entries.sort((a, b) => {
            const za = getEntryAvgZpk(a);
            const zb = getEntryAvgZpk(b);
            if (za < 0 && zb < 0) return comparePairEntriesByDateThenDep(a, b, 'asc');
            if (za < 0) return 1;
            if (zb < 0) return -1;
            const dz = dir * (za - zb);
            return dz !== 0 ? dz : comparePairEntriesByDateThenDep(a, b, 'asc');
        });
    } else {
        // маршрут / по умолчанию — внутри пары: дата, затем время вылета
        entries.sort((a, b) => comparePairEntriesByDateThenDep(a, b, 'asc'));
    }

    return entries;
}

function sortDataRoutePairs(pairs, todayStart) {
    if (dataSort === 'route-desc') {
        return pairs.slice().sort((a, b) =>
            parseInt(b.outbound.replace('KV-', ''), 10) - parseInt(a.outbound.replace('KV-', ''), 10)
        );
    }
    if (dataSort === 'zpk-desc' || dataSort === 'zpk-asc') {
        const dir = dataSort === 'zpk-desc' ? -1 : 1;
        // один проход: иначе sort() вызывает getDataPairEntries O(n²) раз
        const score = new Map();
        pairs.forEach((p) => {
            const entries = getDataPairEntries(p, todayStart);
            const vals = entries.map(getEntryAvgZpk).filter(v => v >= 0);
            const avg = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : -1;
            score.set(p, avg);
        });
        return pairs.slice().sort((a, b) => {
            const avgA = score.get(a);
            const avgB = score.get(b);
            if (avgA < 0 && avgB < 0) {
                return parseInt(a.outbound.replace('KV-', ''), 10) - parseInt(b.outbound.replace('KV-', ''), 10);
            }
            if (avgA < 0) return 1;
            if (avgB < 0) return -1;
            const dz = dir * (avgA - avgB);
            return dz !== 0
                ? dz
                : parseInt(a.outbound.replace('KV-', ''), 10) - parseInt(b.outbound.replace('KV-', ''), 10);
        });
    }
    return pairs;
}

function getDataRoutePairs(todayStart) {
    const seen = new Set();
    const pairs = [];
    const q = (dataSearchQuery || '').trim().toLowerCase();

    getValidFlightBases().forEach(base => {
        const { outbound, inbound } = resolvePairForSelection(base);
        const key = `${outbound}|${inbound}`;
        if (seen.has(key)) return;
        seen.add(key);
        if (dataRouteTypeFilter !== 'all' && typeof getFlightRouteType === 'function'
            && getFlightRouteType(outbound) !== dataRouteTypeFilter) return;

        const outDir = getFlightDirection(outbound);
        const inDir = getFlightDirection(inbound);
        if (q) {
            const hay = `${outbound} ${inbound} ${outDir} ${inDir}`.toLowerCase();
            const tokens = q.split(/[\s,;/|–—]+/).map(t => t.trim()).filter(t => t.length >= 2);
            const ok = tokens.length
                ? tokens.every(t => hay.includes(t))
                : hay.includes(q);
            if (!ok) return;
        }

        pairs.push({ outbound, inbound, outDir, inDir });
    });

    let sorted = pairs.sort((a, b) =>
        parseInt(a.outbound.replace('KV-', ''), 10) - parseInt(b.outbound.replace('KV-', ''), 10)
    );
    if (todayStart) sorted = sortDataRoutePairs(sorted, todayStart);
    return sorted;
}

function getDataLegMetrics(row) {
    if (!row) return { seats: null, load: null, zpk: null, bookings: null };
    const sold = parseInt(row[6] || 0, 10) || 0;
    // AV SSP Seg = спец. брони; кресла в продаже = всего − спец. брони
    const avs = typeof getSpecBookings === 'function' ? getSpecBookings(row) : (parseInt(row[8] || 0, 10) || 0);
    const seats = typeof getSeatsOnSale === 'function' ? getSeatsOnSale(row) : Math.max(0, (parseInt(row[5] || 0, 10) || 0) - avs);
    const denom = seats;
    let zpk = null;
    if (sold >= 1 && denom > 0) {
        zpk = Math.round(sold / denom * 100);
    }
    return { seats, load: sold, zpk, bookings: avs };
}

function isDataLegClosed(row) {
    if (!row) return false;
    return closedFlights.has(getSalesLookupKey(row));
}

function isDataLegFlew(row, todayStart) {
    if (!row || !todayStart) return false;
    const fd = parseLocalDate(row[1]);
    return !!(fd && fd < todayStart);
}

function renderDataLegCells(row, legCls, options = {}) {
    const isOut = legCls === 'pair-leg-out';
    const block = isOut ? 'data-block-out' : 'data-block-in';
    const showBook = !!dataShowSpecBookings;
    const showTimes = !!dataShowLocalTimes;
    const emptyDash = (extra = '') => `<td class="${legCls} ${block} font-semibold${extra}">—</td>`;
    const emptyBook = showBook ? emptyDash() : '';
    if (!row) {
        if (isOut) {
            const emptyTimes = showTimes ? `${emptyDash()}${emptyDash()}` : '';
            return `${emptyTimes}${emptyDash()}${emptyBook}${emptyDash()}${emptyDash(' pair-split-end')}`;
        }
        if (showTimes) {
            return `${emptyDash(' pair-split-start')}${emptyDash()}${emptyDash()}${emptyBook}${emptyDash()}${emptyDash()}`;
        }
        return `${emptyDash(' pair-split-start')}${emptyBook}${emptyDash()}${emptyDash()}`;
    }
    const m = getDataLegMetrics(row);
    const closed = isDataLegClosed(row);
    // серый блок ноги, если закрыта (даже когда второе направление открыто)
    const closedCls = closed ? ' data-leg-closed' : '';
    const flewCls = (!closed && options.flew) ? ' data-leg-flew' : '';
    // Блок: жёлтый только если ЗПК ≥ 100% (и не улетевший / не закрытый)
    const fullCls = (options.allowYellow && !closed && !options.flew && m.zpk !== null && m.zpk >= 100) ? ' data-block-zpk-full' : '';
    const customColor = (!fullCls && !closed && !options.flew && options.customColor) ? options.customColor : '';
    const hlCls = customColor ? ' data-block-custom-hl' : '';
    const hlStyle = customColor ? ` style="--hl:${escAttr(customColor)}"` : '';
    const zpkVal = closed
        ? '<span class="closed-text">ЗАКРЫТ</span>'
        : (m.zpk !== null ? `${m.zpk}%` : '—');
    const splitEnd = isOut ? ' pair-split-end' : '';
    const splitStart = !isOut ? ' pair-split-start' : '';
    const cellBase = `pair-leg-cell ${legCls} ${block} font-semibold${closedCls}${flewCls}`;
    const dep = typeof getDepTime === 'function' ? getDepTime(row) : '';
    const arr = typeof getArrTime === 'function' ? getArrTime(row) : '';
    // порядок: [вр. вылета · вр. прилета] · крес. · [спец. брони] · загр. · зпк
    const timesCells = showTimes
        ? `<td class="${cellBase}${splitStart}${fullCls}${hlCls}"${hlStyle}>${dep ? escHtml(dep) : '—'}</td>
           <td class="${cellBase}${fullCls}${hlCls}"${hlStyle}>${arr ? escHtml(arr) : '—'}</td>`
        : '';
    const seatsSplit = showTimes ? '' : splitStart;
    const bookCell = showBook
        ? `<td class="${cellBase} data-col-bookings${fullCls}${hlCls}"${hlStyle}>${m.bookings != null ? formatNum(m.bookings) : '—'}</td>`
        : '';
    return `
        ${timesCells}
        <td class="${cellBase}${seatsSplit}${fullCls}${hlCls}"${hlStyle}>${formatNum(m.seats)}</td>
        ${bookCell}
        <td class="${cellBase}${fullCls}${hlCls}"${hlStyle}>${formatNum(m.load)}</td>
        <td class="${cellBase}${splitEnd}${fullCls}${hlCls}"${hlStyle}>${zpkVal}</td>`;
}

let _dataBoardRowAcc = 0;

function renderDataRouteTableRows(pair, todayStart) {
    const entries = getDataPairEntries(pair, todayStart);
    if (!entries.length) return '';
    _dataBoardRowAcc += entries.length;

    return entries.map(entry => {
        const outM = getDataLegMetrics(entry.outRow);
        const inM = getDataLegMetrics(entry.inRow);
        const fd = parseLocalDate(entry.date);
        const flewOut = isDataLegFlew(entry.outRow, todayStart);
        const flewIn = isDataLegFlew(entry.inRow, todayStart);
        const closedOut = isDataLegClosed(entry.outRow);
        const closedIn = isDataLegClosed(entry.inRow);
        const bothClosed = closedOut && closedIn;
        const bothFlew = (!entry.outRow || flewOut) && (!entry.inRow || flewIn)
            && !!(entry.outRow || entry.inRow);
        const zebra = (getWeekNumber(fd) % 2 === 0) ? 'week-even' : 'week-odd';
        let rowCls = 'data-row-clickable ' + zebra;
        if (bothClosed) rowCls = 'data-row-clickable closed-flight data-row-both-closed';
        else if (bothFlew) rowCls = 'data-row-clickable flew-flight';

        const openPcts = [];
        if (entry.outRow && !closedOut && outM.zpk !== null) openPcts.push(outM.zpk);
        if (entry.inRow && !closedIn && inM.zpk !== null) openPcts.push(inM.zpk);
        const avgPctOpen = openPcts.length
            ? Math.round(openPcts.reduce((a, b) => a + b, 0) / openPcts.length)
            : null;

        const yellowOut = !flewOut && !closedOut && outM.zpk !== null && outM.zpk >= 100;
        const yellowIn = !flewIn && !closedIn && inM.zpk !== null && inM.zpk >= 100;
        const yellowAvg = !bothFlew && !bothClosed && avgPctOpen !== null && avgPctOpen >= 100;

        let customOut = '';
        let customIn = '';
        if (!bothClosed && typeof DataBoardFilters !== 'undefined') {
            if (entry.outRow && !closedOut && !flewOut && !yellowOut) {
                const h = DataBoardFilters.highlightForLeg(entry.outRow);
                if (h) customOut = h.color;
            }
            if (entry.inRow && !closedIn && !flewIn && !yellowIn) {
                const h = DataBoardFilters.highlightForLeg(entry.inRow);
                if (h) customIn = h.color;
            }
        }

        const avgHtml = bothClosed
            ? '<span class="closed-text">ЗАКРЫТ</span>'
            : (avgPctOpen !== null ? `${avgPctOpen}%` : '—');
        const dateCell = buildPairRowDateCell(entry.date, entry.outRow, entry.inRow, pair.outbound, pair.inbound);
        const clickDate = (!flewOut && entry.outRow)
            ? entry.outRow[1]
            : ((!flewIn && entry.inRow) ? entry.inRow[1] : entry.date);

        const checkCls = typeof FlightChecks !== 'undefined' ? FlightChecks.rowClass([entry.outRow, entry.inRow]) : '';
        // Для клика по своей половине строки: «туда» открывает свой рейс, «обратно» — обратный.
        const legAttrs = (entry.outRow ? ` data-out-code="${escAttr(cleanFlight(entry.outRow[0]))}" data-out-date="${escAttr(entry.outRow[1])}"` : '')
            + (entry.inRow ? ` data-in-code="${escAttr(cleanFlight(entry.inRow[0]))}" data-in-date="${escAttr(entry.inRow[1])}"` : '');
        return `<tr class="${rowCls}${checkCls}" data-outbound="${escAttr(pair.outbound)}" data-date="${escAttr(clickDate)}"${legAttrs} tabindex="0">
            <td class="col-date data-block-info font-semibold">${dateCell}</td>
            <td class="font-medium data-block-info">${escHtml(formatPairDayOfWeek(entry.outRow, entry.inRow, entry.date))}</td>
            ${renderDataLegCells(entry.outRow, 'pair-leg-out', { allowYellow: yellowOut, customColor: customOut, flew: flewOut })}
            ${renderDataLegCells(entry.inRow, 'pair-leg-in', { allowYellow: yellowIn, customColor: customIn, flew: flewIn })}
            <td class="font-bold data-board-avg-cell data-block-avg pair-split-start${yellowAvg ? ' data-block-zpk-full' : ''}">${avgHtml}</td>
        </tr>`;
    }).join('');
}

function buildDataRouteCardHtml(pair, todayStart) {
    const bodyRows = renderDataRouteTableRows(pair, todayStart);
    if (!bodyRows) return '';

    const typeLabel = typeof getFlightRouteTypeLabel === 'function' ? getFlightRouteTypeLabel(pair.outbound) : '';
    const typeCls = typeof getFlightRouteType === 'function'
        ? (getFlightRouteType(pair.outbound) === 'krai' ? 'data-type-krai' : 'data-type-inter')
        : '';
    const legCols = getDataBoardLegColCount();
    const timeThOut = dataShowLocalTimes
        ? `<th class="pair-sub-out data-col-time">Вр. вылета</th>
           <th class="pair-sub-out data-col-time">Вр. прилета</th>`
        : '';
    const timeThIn = dataShowLocalTimes
        ? `<th class="pair-sub-in data-col-time pair-split-start">Вр. вылета</th>
           <th class="pair-sub-in data-col-time">Вр. прилета</th>`
        : '';
    const bookThOut = dataShowSpecBookings
        ? `<th class="pair-sub-out data-col-bookings">Спец. брони</th>`
        : '';
    const bookThIn = dataShowSpecBookings
        ? `<th class="pair-sub-in data-col-bookings">Спец. брони</th>`
        : '';
    const seatsThOutSplit = dataShowLocalTimes ? '' : '';
    const seatsThInSplit = dataShowLocalTimes ? '' : ' pair-split-start';
    const tableMods = [
        dataShowSpecBookings ? 'data-board-with-bookings' : '',
        dataShowLocalTimes ? 'data-board-with-times' : ''
    ].filter(Boolean).join(' ');

    return `
        <div class="data-route-block ${typeCls}">
            <div class="data-route-table-wrap table-wrapper">
                <table class="data-table pair-table data-board-table w-full${tableMods ? ` ${tableMods}` : ''}">
                    <caption class="data-board-caption">
                        <div class="data-board-caption-inner">
                            <div class="data-board-caption-routes">
                                <span class="data-board-cap-out">${escHtml(pair.outDir)}</span>
                                <span class="data-board-cap-sep">⇄</span>
                                <span class="data-board-cap-in">${escHtml(pair.inDir)}</span>
                            </div>
                            ${typeLabel ? `<span class="data-board-cap-badge">${escHtml(typeLabel)}</span>` : ''}
                        </div>
                    </caption>
                    <thead>
                        <tr class="pair-head-main data-board-head-main">
                            <th rowspan="2" class="data-board-th-date col-date">
                                <span class="data-board-th-label">Дата</span>
                                <span class="data-board-th-sub">рейса</span>
                            </th>
                            <th rowspan="2" class="data-board-th-dow">
                                <span class="data-board-th-label">День</span>
                            </th>
                            <th colspan="${legCols}" class="pair-dir-head pair-dir-out data-board-dir-head">
                                <span class="data-board-dir-arrow">→</span>
                                <span class="data-board-dir-side">Туда</span>
                                <span class="data-board-dir-code">${escHtml(pair.outbound)}</span>
                            </th>
                            <th colspan="${legCols}" class="pair-dir-head pair-dir-in data-board-dir-head pair-split-start">
                                <span class="data-board-dir-arrow">←</span>
                                <span class="data-board-dir-side">Обратно</span>
                                <span class="data-board-dir-code">${escHtml(pair.inbound)}</span>
                            </th>
                            <th rowspan="2" class="data-board-avg-head pair-split-start">
                                <span class="data-board-th-label">Ср.</span>
                                <span class="data-board-th-sub">ЗПК</span>
                            </th>
                        </tr>
                        <tr class="pair-head-sub data-board-head-sub">
                            ${timeThOut}
                            <th class="pair-sub-out${seatsThOutSplit}" title="AU снимка − спец.брони">Крес.</th>
                            ${bookThOut}
                            <th class="pair-sub-out" title="sold из снимка, не свободные места">Загр.</th>
                            <th class="pair-sub-out pair-split-end" title="sold / (AU − спец.брони)">ЗПК</th>
                            ${timeThIn}
                            <th class="pair-sub-in${seatsThInSplit}" title="AU снимка − спец.брони">Крес.</th>
                            ${bookThIn}
                            <th class="pair-sub-in" title="sold из снимка, не свободные места">Загр.</th>
                            <th class="pair-sub-in" title="sold / (AU − спец.брони)">ЗПК</th>
                        </tr>
                    </thead>
                    <tbody>${bodyRows}</tbody>
                </table>
            </div>
        </div>`;
}

function buildDataBoardHtml(pairs, todayStart) {
    _dataBoardRowAcc = 0;
    const cards = pairs.map(pair => buildDataRouteCardHtml(pair, todayStart)).filter(Boolean);
    if (!cards.length) return { html: '', rowCount: 0 };
    return { html: cards.join(''), rowCount: _dataBoardRowAcc };
}

function syncDataBoardToolbar() {
    const filterEl = document.getElementById('data-route-type-filter');
    if (filterEl && filterEl.value !== dataRouteTypeFilter) filterEl.value = dataRouteTypeFilter;
    const sortEl = document.getElementById('data-sort-select');
    if (sortEl && sortEl.value !== dataSort) sortEl.value = dataSort;
    const hideEl = document.getElementById('data-hide-flew');
    if (hideEl) hideEl.checked = dataHideFlew;
    const bookEl = document.getElementById('data-show-spec-bookings');
    if (bookEl) bookEl.checked = dataShowSpecBookings;
    const timesEl = document.getElementById('data-show-local-times');
    if (timesEl) timesEl.checked = dataShowLocalTimes;
    const searchEl = document.getElementById('data-search-input');
    if (searchEl && searchEl.value !== dataSearchQuery) searchEl.value = dataSearchQuery;
}

let dataBoardSuppressClick = false;

function openDataBoardFlight(base, date) {
    const flight = String(base || '').trim();
    const flyDate = String(date || '').trim();
    if (typeof Security !== 'undefined') {
        if (!Security.isFlightBase(flight) || !Security.isFlightDate(flyDate)) return;
    } else if (!isValidFlightBase(flight)) {
        return;
    }
    // Остаёмся на «Данных» — только запоминаем выбранный рейс
    currentFlight = typeof getBaseFlight === 'function' ? (getBaseFlight(flight) || flight) : flight;
    lastSelectedDate = flyDate;
    if (typeof SessionStore !== 'undefined') SessionStore.saveUiSession();
    if (typeof FlightCard !== 'undefined') FlightCard.maybeOpen(flight, flyDate);
}

function bindDataBoardInteractions(track) {
    // после cache-hit HTML пересоздаётся, но флаг bound на track остаётся — ок для делегирования
    if (!track || track.dataset.bound) return;
    track.dataset.bound = '1';

    track.addEventListener('click', (e) => {
        if (dataBoardSuppressClick) {
            dataBoardSuppressClick = false;
            return;
        }
        const row = e.target.closest('tr[data-outbound][data-date]');
        if (!row || row.classList.contains('flew-flight')) return;
        const td = e.target.closest('td');
        if (td && td.classList.contains('pair-leg-in') && row.dataset.inCode) {
            openDataBoardFlight(row.dataset.inCode, row.dataset.inDate);
            return;
        }
        if (td && td.classList.contains('pair-leg-out') && row.dataset.outCode) {
            openDataBoardFlight(row.dataset.outCode, row.dataset.outDate);
            return;
        }
        openDataBoardFlight(row.dataset.outbound, row.dataset.date);
    });

    track.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const row = e.target.closest('tr[data-outbound][data-date]');
        if (!row || row.classList.contains('flew-flight')) return;
        e.preventDefault();
        openDataBoardFlight(row.dataset.outbound, row.dataset.date);
    });
}

function onDataBoardFilterChange() {
    invalidateDataBoardCache();
    renderDataBoard();
    if (typeof SessionStore !== 'undefined') SessionStore.saveUiSession();
}

function initDataViewToolbar(root) {
    const searchEl = root.querySelector('#data-search-input');
    if (searchEl && !searchEl.dataset.bound) {
        searchEl.dataset.bound = '1';
        searchEl.value = dataSearchQuery;
        searchEl.addEventListener('input', () => {
            clearTimeout(dataSearchTimer);
            dataSearchTimer = setTimeout(() => {
                const raw = searchEl.value;
                dataSearchQuery = typeof Security !== 'undefined'
                    ? Security.sanitizeTextInput(raw, 80)
                    : String(raw || '').trim().slice(0, 80);
                if (searchEl.value !== dataSearchQuery) searchEl.value = dataSearchQuery;
                onDataBoardFilterChange();
            }, 250);
        });
        searchEl.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                searchEl.value = '';
                dataSearchQuery = '';
                onDataBoardFilterChange();
            }
        });
    }

    const filterEl = root.querySelector('#data-route-type-filter');
    if (filterEl && !filterEl.dataset.bound) {
        filterEl.dataset.bound = '1';
        filterEl.value = dataRouteTypeFilter;
        filterEl.addEventListener('change', () => {
            dataRouteTypeFilter = filterEl.value;
            onDataBoardFilterChange();
        });
    }

    const sortEl = root.querySelector('#data-sort-select');
    if (sortEl && !sortEl.dataset.bound) {
        sortEl.dataset.bound = '1';
        sortEl.value = dataSort;
        sortEl.addEventListener('change', () => {
            dataSort = sortEl.value;
            onDataBoardFilterChange();
        });
    }

    const hideEl = root.querySelector('#data-hide-flew');
    if (hideEl && !hideEl.dataset.bound) {
        hideEl.dataset.bound = '1';
        hideEl.checked = dataHideFlew;
        hideEl.addEventListener('change', () => {
            dataHideFlew = hideEl.checked;
            onDataBoardFilterChange();
        });
    }

    const bookEl = root.querySelector('#data-show-spec-bookings');
    if (bookEl && !bookEl.dataset.bound) {
        bookEl.dataset.bound = '1';
        bookEl.checked = dataShowSpecBookings;
        bookEl.addEventListener('change', () => {
            dataShowSpecBookings = bookEl.checked;
            onDataBoardFilterChange();
        });
    }

    const timesEl = root.querySelector('#data-show-local-times');
    if (timesEl && !timesEl.dataset.bound) {
        timesEl.dataset.bound = '1';
        timesEl.checked = dataShowLocalTimes;
        timesEl.addEventListener('change', () => {
            dataShowLocalTimes = timesEl.checked;
            onDataBoardFilterChange();
        });
    }

    const hlBtn = root.querySelector('#data-hl-btn');
    if (hlBtn && !hlBtn.dataset.bound) {
        hlBtn.dataset.bound = '1';
        hlBtn.addEventListener('click', () => {
            if (typeof DataBoardFilters !== 'undefined') DataBoardFilters.openModal();
        });
    }
    if (typeof DataBoardFilters !== 'undefined') DataBoardFilters.updateBadge();

    const exportBtn = root.querySelector('#data-export-btn');
    if (exportBtn) {
        if (typeof ProfileAuth !== 'undefined' && !ProfileAuth.hasPermission('export_excel')) {
            exportBtn.style.display = 'none';
        } else if (!exportBtn.dataset.bound) {
            exportBtn.dataset.bound = '1';
            exportBtn.addEventListener('click', exportDataBoardToExcel);
        }
    }
}

function renderDataBoard() {
    const track = document.getElementById('data-board-track');
    const stats = document.getElementById('data-board-stats');
    if (!track) return;

    if (!Object.keys(groupedData).length) {
        track.innerHTML = `<div class="data-board-empty">Загрузите данные, чтобы увидеть маршруты</div>`;
        if (stats) stats.textContent = '';
        return;
    }

    const sig = getDataBoardCacheSignature();
    const gen = ++dataBoardRenderGen;
    if (dataBoardRenderCache.sig === sig && track.dataset.renderSig === sig && track.childElementCount > 0) {
        if (stats) stats.textContent = dataBoardRenderCache.stats || '';
        syncDataBoardToolbar();
        applyDataBoardZoom();
        return;
    }
    if (dataBoardRenderCache.sig === sig && dataBoardRenderCache.html) {
        track.innerHTML = dataBoardRenderCache.html;
        track.dataset.renderSig = sig;
        if (stats) stats.textContent = dataBoardRenderCache.stats || '';
        syncDataBoardToolbar();
        bindDataBoardInteractions(track);
        applyDataBoardZoom();
        return;
    }

    track.classList.add('data-board-loading');
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const pairs = getDataRoutePairs(todayStart);
    // Сначала столько маршрутов, сколько видно на экране, остальные — следующими кадрами.
    const FIRST_CHUNK = 4;
    const CHUNK = 12;
    _dataBoardRowAcc = 0;
    track.innerHTML = '';
    track.dataset.renderSig = '';

    const finish = (statsText) => {
        if (gen !== dataBoardRenderGen) return;
        // HTML для повторной вставки снимаем, когда браузер свободен: сериализация тысяч строк заметна.
        dataBoardRenderCache = { sig, html: '', stats: statsText };
        const keep = () => {
            if (dataBoardRenderCache.sig === sig && track.dataset.renderSig === sig) dataBoardRenderCache.html = track.innerHTML;
        };
        if (typeof requestIdleCallback === 'function') requestIdleCallback(keep, { timeout: 5000 });
        else setTimeout(keep, 1500);
        track.dataset.renderSig = sig;
        track.classList.remove('data-board-loading');
        if (stats) stats.textContent = statsText;
        syncDataBoardToolbar();
        bindDataBoardInteractions(track);
        applyDataBoardZoom();
        if (typeof SessionStore !== 'undefined') SessionStore.saveUiSession();
    };

    const paintChunk = (start) => {
        if (gen !== dataBoardRenderGen) return;
        if (start === 0 && !pairs.length) {
            track.innerHTML = `<div class="data-board-empty">Нет маршрутов по выбранному фильтру</div>`;
            finish('0 маршрутов');
            return;
        }
        const end = start + (start === 0 ? FIRST_CHUNK : CHUNK);
        const slice = pairs.slice(start, end);
        const html = slice.map(pair => buildDataRouteCardHtml(pair, todayStart)).filter(Boolean).join('');
        if (html) track.insertAdjacentHTML('beforeend', html);
        if (end < pairs.length) {
            requestAnimationFrame(() => paintChunk(end));
            return;
        }
        finish(`${pairs.length} маршрутов · ${_dataBoardRowAcc} дат`);
    };

    paintChunk(0);
}

function applyDataBoardZoom() {
    VIEW_ZOOM.data = dataBoardZoom;
    applyViewZoom('data');
}

function setDataBoardZoom(delta) {
    setViewZoom('data', delta);
}

function createDataView(c) {
    c.innerHTML = `
        <div class="data-page">
            <div class="table-page-hero data-hero data-hero-compact">
                <div class="data-hero-main-row">
                    <div class="table-page-hero-main">
                        <h2 class="data-hero-title">Данные по маршрутам</h2>
                    </div>
                    <div class="data-hero-toolbar data-hero-toolbar-top-right">
                        <input type="search" id="data-search-input" class="data-search-input data-ctrl-sm" placeholder="Поиск" autocomplete="off">
                        <select id="data-route-type-filter" class="table-sort-select data-ctrl-sm">
                            <option value="all">Все</option>
                            <option value="krai">Краевые</option>
                            <option value="interregional">Межрег.</option>
                        </select>
                        <select id="data-sort-select" class="table-sort-select data-ctrl-sm">
                            <option value="route-asc">Маршрут ↑</option>
                            <option value="route-desc">Маршрут ↓</option>
                            <option value="date-asc">Дата ↑</option>
                            <option value="date-desc">Дата ↓</option>
                            <option value="zpk-desc">ЗПК ↓</option>
                            <option value="zpk-asc">ЗПК ↑</option>
                        </select>
                        <label class="data-hide-flew-label data-ctrl-sm">
                            <input type="checkbox" id="data-hide-flew"> Скрыть улет.
                        </label>
                        <label class="data-hide-flew-label data-ctrl-sm">
                            <input type="checkbox" id="data-show-local-times"${dataShowLocalTimes ? ' checked' : ''}> Время местное
                        </label>
                        <label class="data-hide-flew-label data-ctrl-sm">
                            <input type="checkbox" id="data-show-spec-bookings"${dataShowSpecBookings ? ' checked' : ''}> Спец. брони
                        </label>
                        <button type="button" id="data-hl-btn" class="filter-btn data-ctrl-sm rms-conditions-open-btn">
                            Подсветка <span id="data-hl-badge" class="rms-cond-badge"></span>
                        </button>
                        <button type="button" id="data-export-btn" class="filter-btn data-export-btn data-ctrl-sm">Excel</button>
                        <span id="data-board-stats" class="data-board-stats"></span>
                    </div>
                </div>
            </div>
            <div id="data-board-scroll" class="data-board-scroll">
                <div id="data-board-track" class="data-board-track"></div>
            </div>
        </div>
    `;
    initDataViewToolbar(c);
    renderDataBoard();
    applyViewZoom('data');
    initDataBoardDrag();
}

function initDataBoardDrag() {
    const container = document.getElementById('data-board-scroll');
    if (!container || container.dataset.dragInit) return;
    container.dataset.dragInit = '1';

    const DRAG_THRESHOLD = 6;
    let isDown = false;
    let didDrag = false;
    let startX = 0;
    let scrollLeft = 0;

    container.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        isDown = true;
        didDrag = false;
        startX = e.pageX;
        scrollLeft = container.scrollLeft;
    });

    container.addEventListener('mousemove', (e) => {
        if (!isDown) return;
        const dx = e.pageX - startX;
        if (!didDrag && Math.abs(dx) > DRAG_THRESHOLD) {
            didDrag = true;
            container.classList.add('data-board-dragging');
        }
        if (!didDrag) return;
        e.preventDefault();
        container.scrollLeft = scrollLeft - dx;
    });

    // Подавляем только клик, который придёт сразу после отпускания кнопки над доской.
    // Ушли мышью за край — клика не будет, и следующий настоящий клик терять нельзя.
    const stop = (suppress) => {
        if (didDrag && suppress) dataBoardSuppressClick = true;
        isDown = false;
        didDrag = false;
        container.classList.remove('data-board-dragging');
    };
    container.addEventListener('mouseup', () => stop(true));
    container.addEventListener('mouseleave', () => stop(false));
}
