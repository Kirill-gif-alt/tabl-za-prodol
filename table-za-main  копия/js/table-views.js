// js\table-views.js - extracted from script.js, logic unchanged.
// Globals on purpose: no bundler; onclick and other files call by name.

function anyPairLegExtraCols() {
    return !!(pairColVisibility.avgFare || pairColVisibility.lastFare
        || pairColVisibility.revenue || pairColVisibility.legSubsidy || pairColVisibility.expenses);
}

function countPairLegExtraCols() {
    let n = 0;
    if (pairColVisibility.avgFare) n++;
    if (pairColVisibility.lastFare) n++;
    if (pairColVisibility.revenue) n++;
    if (pairColVisibility.legSubsidy) n++;
    if (pairColVisibility.expenses) n++;
    return n;
}

function buildPairColTogglesHtml() {
    const items = [
        { key: 'avgFare', label: 'Ср. тариф' },
        { key: 'lastFare', label: 'Последний тариф' },
        { key: 'revenue', label: 'Выручка' },
        { key: 'legSubsidy', label: 'Субсидия' },
        { key: 'expenses', label: 'Себестоимость' },
        { key: 'totalRevenue', label: 'Общая выручка' },
        { key: 'subsidy', label: 'Субсидия на рейсе' },
        { key: 'totalExpenses', label: 'Общие расходы' },
        { key: 'finResult', label: 'Фин. рез' }
    ];
    return `<div class="pair-col-toggles">
        ${items.map(it => `
            <label class="data-hide-flew-label data-ctrl-sm pair-col-toggle"${it.title ? ` title="${escAttr(it.title)}"` : ''}>
                <input type="checkbox" data-pair-col="${it.key}"${pairColVisibility[it.key] ? ' checked' : ''}>
                ${escHtml(it.label)}
            </label>`).join('')}
    </div>`;
}

function buildTableFilterPanel(base, foundCount, totalCount, hasExpectedLoad = true, opts = {}) {
    const showFlightTools = opts.showFlightTools !== false;
    const showPairCols = !!opts.showPairCols;
    const showSpecToggle = !!opts.showSpecBookingsToggle;
    const pair = base ? getFlightPair(base) : null;
    const returnLabel = pair && base === pair.outbound ? (pair.inbound || 'Обратный') : (pair?.outbound || 'Обратный');
    return `
        <div class="table-controls-bar">
            <div class="table-filter-group">
                <button data-status="all" class="filter-btn ${tableFilterStatus==='all'?'filter-btn-active':''}">Все</button>
                <button data-status="open" class="filter-btn ${tableFilterStatus==='open'?'filter-btn-active filter-btn-open':''}">Открытые</button>
                <button data-status="closed" class="filter-btn ${tableFilterStatus==='closed'?'filter-btn-active filter-btn-muted':''}">Закрытые / улетевшие</button>
                <button data-status="full" class="filter-btn ${tableFilterStatus==='full'?'filter-btn-active filter-btn-warn':''}">Полные 100%</button>
                <button data-status="attention" class="filter-btn ${tableFilterStatus==='attention'?'filter-btn-active filter-btn-alert':''}">⚠ Внимание</button>
            </div>

            <div class="table-sort-wrap">
                <span class="table-sort-label">Сортировка</span>
                <select id="table-sort-select" class="table-sort-select">
                    <option value="date-asc" ${tableSort.by==='date' && tableSort.dir==='asc' ? 'selected' : ''}>Дата ↑</option>
                    <option value="date-desc" ${tableSort.by==='date' && tableSort.dir==='desc' ? 'selected' : ''}>Дата ↓</option>
                    <option value="load-desc" ${tableSort.by==='load' && tableSort.dir==='desc' ? 'selected' : ''}>Загрузка % ↓</option>
                    ${hasExpectedLoad ? `<option value="delta-asc" ${tableSort.by==='delta' && tableSort.dir==='asc' ? 'selected' : ''}>Δ прогноз ↑ (худшие)</option>` : ''}
                    <option value="sales-desc" ${tableSort.by==='sales' && tableSort.dir==='desc' ? 'selected' : ''}>Продажи сегодня ↓</option>
                    <option value="avgfare-desc" ${tableSort.by==='avgfare' && tableSort.dir==='desc' ? 'selected' : ''}>Средний тариф ↓</option>
                </select>
            </div>
            ${showFlightTools ? `
            <div class="table-flight-tools">
                <input type="text" id="table-flight-search" class="table-flight-search" placeholder="№ рейса, напр. 101"
                       value="${escAttr(tableFlightSearchQuery)}" title="Поиск по номеру рейса">
                <button type="button" class="btn-secondary table-return-flight-btn" id="table-return-flight-btn">⇄ ${escHtml(returnLabel)}</button>
            </div>` : ''}
            ${showSpecToggle ? `
            <label class="data-hide-flew-label data-ctrl-sm">
                <input type="checkbox" id="show-spec-bookings-toggle"${showSpecBookings ? ' checked' : ''}> Спец. брони
            </label>` : ''}
            ${showPairCols ? buildPairColTogglesHtml() : ''}
            <div class="table-controls-spacer"></div>
            <div class="table-found-count">Найдено: <strong>${foundCount}</strong> / ${totalCount}</div>
        </div>
    `;
}

function bindTableExpandToggle(tableContainer, rerender) {
    if (!tableContainer) return;
    const btn = tableContainer.querySelector('.table-cols-toggle-btn');
    if (!btn) return;
    btn.onclick = (e) => {
        e.stopPropagation();
        tableExtraColsExpanded = !tableExtraColsExpanded;
        if (typeof SessionStore !== 'undefined') SessionStore.saveUiSession();
        rerender();
    };
}

function bindTableControls(cont, base, targetDate, rerenderFn) {
    const render = rerenderFn || (() => actuallyRenderTable(base, targetDate));

    cont.querySelectorAll('.filter-btn').forEach(btn => {
        btn.onclick = () => {
            tableFilterStatus = btn.dataset.status;
            if (typeof SessionStore !== 'undefined') SessionStore.saveUiSession();
            render();
        };
    });

    const sortSelect = cont.querySelector('#table-sort-select');
    if (sortSelect) {
        sortSelect.onchange = () => {
            const val = sortSelect.value;
            if (val === 'date-asc') { tableSort = { by: 'date', dir: 'asc' }; }
            else if (val === 'date-desc') { tableSort = { by: 'date', dir: 'desc' }; }
            else if (val === 'load-desc') { tableSort = { by: 'load', dir: 'desc' }; }
            else if (val === 'delta-asc') { tableSort = { by: 'delta', dir: 'asc' }; }
            else if (val === 'sales-desc') { tableSort = { by: 'sales', dir: 'desc' }; }
            else if (val === 'avgfare-desc') { tableSort = { by: 'avgfare', dir: 'desc' }; }
            if (typeof SessionStore !== 'undefined') SessionStore.saveUiSession();
            render();
        };
    }

    cont.querySelectorAll('[data-pair-col]').forEach((cb) => {
        if (cb.dataset.bound) return;
        cb.dataset.bound = '1';
        cb.addEventListener('change', () => {
            const key = cb.getAttribute('data-pair-col');
            if (!key || !(key in pairColVisibility)) return;
            pairColVisibility[key] = !!cb.checked;
            if (typeof SessionStore !== 'undefined') SessionStore.saveUiSession();
            render();
        });
    });

    const specToggle = cont.querySelector('#show-spec-bookings-toggle');
    if (specToggle && !specToggle.dataset.bound) {
        specToggle.dataset.bound = '1';
        specToggle.checked = !!showSpecBookings;
        specToggle.addEventListener('change', () => {
            showSpecBookings = !!specToggle.checked;
            if (typeof SessionStore !== 'undefined') SessionStore.saveUiSession();
            render();
        });
    }

    const searchInput = cont.querySelector('#table-flight-search');
    if (searchInput && !searchInput.dataset.bound) {
        searchInput.dataset.bound = '1';
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                tableFlightSearchQuery = searchInput.value.trim();
                switchToTableFlightBySearch(tableFlightSearchQuery);
            }
        });
        searchInput.addEventListener('change', () => {
            tableFlightSearchQuery = searchInput.value.trim();
        });
    }
    const retBtn = cont.querySelector('#table-return-flight-btn');
    if (retBtn && !retBtn.dataset.bound) {
        retBtn.dataset.bound = '1';
        retBtn.addEventListener('click', () => toggleReturnFlight());
    }
}

function selectFlight(base,targetDate=null){
    const flight = String(base || '').trim();
    if (!isValidFlightBase(flight)) return;
    if (targetDate) {
        const d = String(targetDate).trim();
        if (typeof Security !== 'undefined' && !Security.isFlightDate(d)) targetDate = null;
        else targetDate = d;
    }
    if (currentFlight !== flight && typeof closeTableSalesPanel === 'function') closeTableSalesPanel();
    currentFlight=flight;
    lastSelectedDate=targetDate;
    if (typeof SessionStore !== 'undefined') SessionStore.saveUiSession();
    if (typeof ActivityLog !== 'undefined') {
        ActivityLog.log('flight', flight, {
            date: targetDate || null,
            mode: currentTab || 'table'
        });
    }

    // Без перехода между вкладками — работаем только в текущей
    if (currentTab === 'table' && typeof actuallyRenderTable === 'function') {
        actuallyRenderTable(flight, targetDate);
    } else if (currentTab === 'pair' && typeof actuallyRenderPairTable === 'function') {
        actuallyRenderPairTable(flight, targetDate);
    } else if (currentTab === 'pkz' && typeof actuallyRenderPkzTable === 'function') {
        actuallyRenderPkzTable(flight, targetDate);
    }
    // main / data / rms — только запоминаем рейс, вкладку не меняем
}

function actuallyRenderTable(base,targetDate=null){
    const cont=document.getElementById('table-container');
    const controls=document.getElementById('table-controls');
    const ttl=document.getElementById('selected-flight-title');
    if(!cont||!ttl)return;
    if (tableSort.by === 'dtd') tableSort = { by: 'date', dir: 'asc' };
    const flightCount = groupedData[base]?.length || 0;
    ttl.innerHTML = `
        <span class="table-flight-code">${escHtml(base)}</span>
        <span class="table-flight-route">${escHtml(getFlightDirection(base))}</span>
        <span class="table-flight-badge">${flightCount} вылетов</span>
    `;

    // Сброс фильтров при смене рейса (опционально — можно убрать если хотим сохранять)
    // tableSort = { by: 'date', dir: 'asc' }; tableFilterStatus = 'all';

    showExpectedLoadColumn = false;
    const rb = groupedData[base] || [];
    for (let r of rb) {
        const cap = getCapacityFromAircraft(getAircraftType(r[4]));
        const du = getDaysUntil(r[1]);
        const wk = getWeekForExpectedLoad(r[1]);
        if (getExpectedLoad(cap, base, du, wk) !== null) { showExpectedLoadColumn = true; break; }
    }
    if (!showExpectedLoadColumn && tableSort.by === 'delta') tableSort = { by: 'date', dir: 'asc' };

    // === ФИЛЬТРЫ И СОРТИРОВКА ===
    let rows = [...(groupedData[base] || [])];

    // Убираем битые строки (без даты или номера рейса)
    rows = rows.filter(row => row[1] && row[0]);

    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    rows = rows.filter(row => flightRowMatchesStatusFilter(row, todayStart));
    rows.sort((a, b) => {
        if (tableSort.by === 'date' && typeof compareRowsByDateThenDep === 'function') {
            return compareRowsByDateThenDep(a, b, tableSort.dir);
        }
        const va = getTableSortValue(a, base);
        const vb = getTableSortValue(b, base);
        return tableSort.dir === 'asc' ? va - vb : vb - va;
    });

    const routeCounts = countRowsByDateFlight(rows);
    const hasSegments = Object.values(routeCounts).some(c => c >= 2);
    const firstSalesByKey = buildFirstSalesRowByKey(rows);

    const totalCount = groupedData[base]?.length || 0;
    const sums = rows.length ? sumUniqueSalesForRows(rows) : { tSum: 0, ySum: 0, d2Sum: 0, d7Sum: 0, d14Sum: 0, d30Sum: 0 };
    const filterHTML = buildTableFilterPanel(base, rows.length, totalCount, showExpectedLoadColumn, {
        showFlightTools: true,
        showSpecBookingsToggle: true
    });
    if (controls) controls.innerHTML = filterHTML;
    bindTableControls(controls || cont, base, targetDate, () => actuallyRenderTable(base, targetDate));

    const expectedHead = showExpectedLoadColumn ? '<th>Ожидаемая</th><th>Δ от ожидаемой</th>' : '';
    const showBook = !!showSpecBookings;

    if (!rows.length) {
        if (typeof TableVirtual !== 'undefined') TableVirtual.destroyHandle(cont);
        renderTableEmptyState(cont, 'Нет рейсов по выбранным фильтрам', 'Попробуйте изменить фильтры или статус');
        tableHtmlCache = { sig: '', html: '' };
        return;
    }

    const tableCacheSig = `${base}|${getTableRenderSig()}|${rows.length}|${hasSegments ? 1 : 0}|${showExpectedLoadColumn ? 1 : 0}|${showBook ? 1 : 0}|${sums.tSum}|${sums.ySum}|${sums.d7Sum}|${sums.d30Sum}`;
    const scrollDateIndex = targetDate ? rows.findIndex(r => r[1] === targetDate) : -1;
    if (tableHtmlCache.sig === tableCacheSig && tableHtmlCache.openTable && tableHtmlCache.rows) {
        if (typeof TableVirtual !== 'undefined') {
            TableVirtual.mount({
                container: cont,
                openTable: tableHtmlCache.openTable,
                rows: tableHtmlCache.rows,
                rowHeight: 40,
                scrollIndex: scrollDateIndex
            });
        } else {
            cont.innerHTML = tableHtmlCache.openTable + tableHtmlCache.rows.join('') + '</tbody></table>';
        }
        cont.dataset.renderSig = tableCacheSig;
        addExportButtonToTable(cont, 'table');
        if (typeof SessionStore !== 'undefined') SessionStore.saveUiSession();
        tabPanelState.table = { flight: base, date: targetDate, sig: getTableRenderSig() };
        return;
    }

    const segmentHead = hasSegments ? '<th>Маршрут</th>' : '';
    // дата, день, [маршрут], тип, кресла, [спец. брони], загрузка, [ожидаемая×2]
    const colsBeforeSales = 2 + (hasSegments ? 1 : 0) + 1 + 2 + (showBook ? 1 : 0) + (showExpectedLoadColumn ? 2 : 0);
    // skip ЗПК + Комментарий
    const salesSumRow = buildTableSalesSumRowHtml(colsBeforeSales, sums, 2, false);
    const bookHead = showBook
        ? `<th>Спец. брони</th>`
        : '';

    const expectedHeadHonest = showExpectedLoadColumn ? '<th title="Ожидаемая загрузка.xlsx">Ожидаемая</th><th title="Без файла — «—», не ноль">Δ к ожидаемой</th>' : '';
    const openTable = `<table class="data-table w-full table-sales-visible"><thead><tr>
        <th class="col-date">Дата рейса</th><th>День недели</th>${segmentHead}<th>Тип ВС</th>
        <th title="AU снимка − спец.брони">Кресел в продаже</th>
        ${bookHead}
        <th title="Загрузка из поля free файла. Не свободные места">Загрузка</th>
        ${expectedHeadHonest}
        <th class="col-sales-day" title="DEALDATE=сегодня в файле 14д"><span class="th-sales-ico th-sales-day" aria-hidden="true">①</span> Сегодня</th>
        <th class="col-sales-day"><span class="th-sales-ico th-sales-day" aria-hidden="true">①</span> Вчера</th>
        <th class="col-sales-day"><span class="th-sales-ico th-sales-day" aria-hidden="true">①</span> Позавчера</th>
        <th class="col-sales-cum"><span class="th-sales-ico th-sales-cum" aria-hidden="true">Σ</span> 7 дн.</th>
        <th class="col-sales-cum" title="Выручка/продажи за окно файла Tickets_SALE_Last14Days"><span class="th-sales-ico th-sales-cum" aria-hidden="true">Σ</span> 14 дн. файла</th>
        <th class="col-sales-cum"><span class="th-sales-ico th-sales-cum" aria-hidden="true">Σ</span> Месяц</th>
        <th title="Загрузка / (AU снимка − спец.брони)">ЗПК %</th>
        <th class="col-comment">Комментарий</th>
    </tr>${salesSumRow}</thead><tbody>`;

    const rowHtmls = [];
    rows.forEach(row=>{
        const date=row[1]||'-';
        const free=parseInt(row[6]||0,10)||0;
        const avs=getSpecBookings(row);
        const seatsOnSale=getSeatsOnSale(row);
        const orig=cleanFlight(row[0]);
        const showSales=shouldAttachSalesToRowCached(row, firstSalesByKey);
        const s=showSales ? getSalesMapForRow(row) : emptySalesBucket();
        const k=getSalesLookupKey(row);
        const closed=closedFlights.has(k);
        const extra=orig!==base;
        const route=getRouteFromRow(row);
        const showRoute=shouldShowRouteForRow(row, routeCounts);
        const fd=parseLocalDate(date);
        const flew=fd?fd<todayStart:false;
        const denom = seatsOnSale;
        const pct = (denom > 0) ? Math.round(free / denom * 100) : null;

        let cls=(getWeekNumber(fd)%2===0)?'week-even':'week-odd';
        if(closed)cls='closed-flight';
        else if(flew)cls='flew-flight';
        else if(pct!=null&&pct>=100)cls='full-loaded';

        const hasComment = typeof FlightComments !== 'undefined' && FlightComments.has(orig, date);
        const commentCell = hasComment
            ? `<td class="col-comment font-bold"><span class="comment-mark" aria-label="Есть комментарий">!</span></td>`
            : `<td class="col-comment"><span class="comment-mark-empty">—</span></td>`;

        const status=(closed||flew)?(closed?'<span class="closed-text">ЗАКРЫТ</span>':'<span class="flew-text">УЛЕТЕЛ</span>'):(pct==null?'—':`<span class="${pct>=75?'occupancy-high':'occupancy-med'}">${pct}%</span>`);
        const checkFlag = typeof FlightChecks !== 'undefined' ? FlightChecks.flagForRow(row) : '';
        const dateCell=(extra?`${escHtml(date)} <span class="font-semibold">${escHtml(orig)}</span> <span class="extra-badge ml-1">(ДОП)</span>`:escHtml(date))+checkFlag;
        const segmentCell=hasSegments&&showRoute?`<span class="segment-cell"><span class="segment-route">${escHtml(formatRouteDisplay(route))}</span></span>`:'';
        const ac=getAircraftType(row[4]);
        let expectedCells = '';
        if (showExpectedLoadColumn) {
            const cap=getCapacityFromAircraft(ac);
            const du=getDaysUntil(date);
            const wk=getWeekForExpectedLoad(date);
            const ev=getExpectedLoad(cap,base,du,wk);
            const evR=ev!==null?Math.ceil(ev):null;
            const {delta,cls:deltaCls}=getDeltaFromExpected(free,evR);
            const deltaCell=delta!==null?`<span class="${deltaCls}">${delta>0?'+':''}${delta}</span>`:'—';
            expectedCells = `<td class="font-semibold">${evR!==null?evR:'—'}</td><td class="font-semibold">${deltaCell}</td>`;
        }

        const salesReady = typeof hasSalesFileLoaded === 'function' ? hasSalesFileLoaded() : !!(typeof dataLoadStatus !== 'undefined' && dataLoadStatus.sales);
        const sc = (v) => (showSales && salesReady) ? formatNum(v || 0) : '—';

        rowHtmls.push(`<tr class="${cls}${showRoute ? ' segment-row' : ''}${checkFlag ? ' fc-row-problem' : ''}" data-date="${escAttr(date)}" data-flight-base="${escAttr(base)}" data-flight-code="${escAttr(orig)}" data-route="${showRoute ? escAttr(route) : ''}" style="cursor: pointer;">
            <td class="col-date">${dateCell}</td><td class="font-medium">${escHtml(getDayOfWeek(date))}</td>${hasSegments ? `<td>${segmentCell}</td>` : ''}<td class="font-semibold">${escHtml(ac)}</td>
            <td class="font-semibold">${formatNum(seatsOnSale)}</td>
            ${showBook ? `<td class="font-semibold col-spec-book">${formatNum(avs)}</td>` : ''}
            <td class="font-semibold">${formatNum(free)}</td>
            ${expectedCells}
            <td class="font-semibold">${sc(s.today)}</td>
            <td class="font-semibold">${sc(s.yesterday)}</td>
            <td class="font-semibold">${sc(s.day2)}</td>
            <td class="font-semibold">${sc(s.d7)}</td>
            <td class="font-semibold">${sc(s.d14)}</td>
            <td class="font-semibold">${sc(s.d30)}</td>
            <td class="font-bold">${status}</td>
            ${commentCell}
        </tr>`);
    });
    tableHtmlCache = { sig: tableCacheSig, html: '', openTable, rows: rowHtmls };
    if (typeof TableVirtual !== 'undefined') {
        TableVirtual.mount({
            container: cont,
            openTable,
            rows: rowHtmls,
            rowHeight: 40,
            scrollIndex: scrollDateIndex
        });
    } else {
        cont.innerHTML = openTable + rowHtmls.join('') + '</tbody></table>';
        if (targetDate) {
            setTimeout(() => {
                const tr = cont.querySelector(`tr[data-date="${CSS.escape(targetDate)}"]`);
                if (tr) tr.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 150);
        }
    }
    cont.dataset.renderSig = tableCacheSig;

    addExportButtonToTable(cont, 'table');
    if (typeof FlightComments !== 'undefined') FlightComments.markRows(cont);

    if (typeof SessionStore !== 'undefined') SessionStore.saveUiSession();
    tabPanelState.table = { flight: base, date: targetDate, sig: getTableRenderSig() };
}

function actuallyRenderPairTable(selectedBase, targetDate = null) {
    const cont = document.getElementById('pair-table-container');
    const controls = document.getElementById('pair-table-controls');
    const ttl = document.getElementById('pair-flight-title');
    if (!cont || !ttl) return;

    const { outbound, inbound } = resolvePairForSelection(selectedBase);
    const outDir = getFlightDirection(outbound);
    const inDir = getFlightDirection(inbound);

    ttl.innerHTML = `
        <div class="pair-title-codes">
            <span class="pair-code pair-code-out">${escHtml(outbound)}</span>
            <span class="pair-code-arrow" aria-hidden="true">⇄</span>
            <span class="pair-code pair-code-in">${escHtml(inbound)}</span>
        </div>
        <div class="pair-title-routes">
            <span class="pair-route pair-route-out"><span class="pair-route-label">Туда</span> ${escHtml(outDir)}</span>
            <span class="pair-route pair-route-in"><span class="pair-route-label">Обратно</span> ${escHtml(inDir)}</span>
        </div>
    `;

    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const outRowsAll = getRowsForPairLeg(outbound);
    const inRowsAll = getRowsForPairLeg(inbound);
    const outRows = filterPairLegRows(outRowsAll, todayStart);
    const inRows = filterPairLegRows(inRowsAll, todayStart);
    const allRows = [...outRows, ...inRows];
    const firstSalesByKey = buildFirstSalesRowByKey(allRows);
    const routeCounts = countRowsByDateFlight(allRows);
    const hasSegments = Object.values(routeCounts).some(c => c >= 2);

    const entries = buildPairTableEntries(outRows, inRows);

    entries.sort((a, b) => {
        if (tableSort.by === 'date') {
            return comparePairEntriesByDateThenDep(a, b, tableSort.dir);
        }
        const pickA = a.outRow || a.inRow;
        const pickB = b.outRow || b.inRow;
        const va = pickA ? getTableSortValue(pickA, cleanFlight(pickA[0])) : 0;
        const vb = pickB ? getTableSortValue(pickB, cleanFlight(pickB[0])) : 0;
        return tableSort.dir === 'asc' ? va - vb : vb - va;
    });

    const outVisibleRows = entries.map(e => e.outRow).filter(Boolean);
    const inVisibleRows = entries.map(e => e.inRow).filter(Boolean);
    const totalCount = outRowsAll.length + inRowsAll.length;
    const filterHTML = buildTableFilterPanel(selectedBase, entries.length, totalCount, false, {
        showPairCols: true,
        showSpecBookingsToggle: true
    });
    if (controls) controls.innerHTML = filterHTML;
    bindTableControls(controls || cont, selectedBase, targetDate, () => actuallyRenderPairTable(selectedBase, targetDate));

    if (!entries.length) {
        if (typeof TableVirtual !== 'undefined') TableVirtual.destroyHandle(cont);
        renderTableEmptyState(cont, 'Нет рейсов по выбранным фильтрам', 'Измените фильтры или выберите другой рейс');
        return;
    }

    // сортировка date+dep уже в entries через getDataPairEntries
    const showBook = !!showSpecBookings;
    // base: Места · [Спец. брони] · Загр. · ЗПК
    const legBaseCols = showBook ? 4 : 3;
    const legExtraCols = countPairLegExtraCols();
    const legSpan = legBaseCols + legExtraCols;
    const headRowSpan = 2;
    const showAvg = !!pairColVisibility.avgFare;
    const showLast = !!pairColVisibility.lastFare;
    const showRev = !!pairColVisibility.revenue;
    const showLegSub = !!pairColVisibility.legSubsidy;
    const showExp = !!pairColVisibility.expenses;
    const showTotalRev = !!pairColVisibility.totalRevenue;
    const showSubsidy = !!pairColVisibility.subsidy;
    const showTotalExp = !!pairColVisibility.totalExpenses;
    const showFin = !!pairColVisibility.finResult;
    const anyExtra = anyPairLegExtraCols() || showTotalRev || showSubsidy || showTotalExp || showFin;

    const extraSubOut = [
        showAvg ? '<th class="col-extra pair-sub-out">Ср. тариф</th>' : '',
        showLast ? '<th class="col-extra pair-sub-out">Посл. тариф</th>' : '',
        showRev ? '<th class="col-extra pair-sub-out">Выручка</th>' : '',
        showLegSub ? '<th class="col-extra pair-sub-out pair-subsidy-head">Субсидия</th>' : '',
        showExp ? '<th class="col-extra pair-sub-out pair-expenses-head">Себестоимость</th>' : ''
    ].join('');
    const extraSubIn = [
        showAvg ? '<th class="col-extra pair-sub-in">Ср. тариф</th>' : '',
        showLast ? '<th class="col-extra pair-sub-in">Посл. тариф</th>' : '',
        showRev ? '<th class="col-extra pair-sub-in">Выручка</th>' : '',
        showLegSub ? '<th class="col-extra pair-sub-in pair-subsidy-head">Субсидия</th>' : '',
        showExp ? '<th class="col-extra pair-sub-in pair-expenses-head">Себестоимость</th>' : ''
    ].join('');
    const totalRevHead = showTotalRev
        ? `<th rowspan="${headRowSpan}" class="col-extra pair-total-rev-head">Общая выручка</th>`
        : '';
    const subsidyHead = showSubsidy
        ? `<th rowspan="${headRowSpan}" class="col-extra pair-subsidy-head">Субсидия на рейсе</th>`
        : '';
    const totalExpHead = showTotalExp
        ? `<th rowspan="${headRowSpan}" class="col-extra pair-expenses-head">Общие расходы</th>`
        : '';
    const finHead = showFin
        ? `<th rowspan="${headRowSpan}" class="col-extra pair-fin-head">Фин. рез</th>`
        : '';
    const bookThOut = showBook
        ? `<th class="pair-sub-out col-spec-book">Спец. брони</th>`
        : '';
    const bookThIn = showBook
        ? `<th class="pair-sub-in col-spec-book">Спец. брони</th>`
        : '';

    const segmentHead = hasSegments ? `<th rowspan="${headRowSpan}">Маршрут</th>` : '';

    const openTable = `<table class="data-table pair-table w-full${anyExtra ? ' table-extra-expanded' : ''}">
        <thead>
            <tr class="pair-head-main">
                <th rowspan="${headRowSpan}" class="col-date">Дата</th>
                <th rowspan="${headRowSpan}">День</th>
                ${segmentHead}
                <th rowspan="${headRowSpan}">Тип ВС</th>
                <th colspan="${legSpan}" class="pair-dir-head pair-dir-out">→ Туда · ${escHtml(outbound)}</th>
                <th colspan="${legSpan}" class="pair-dir-head pair-dir-in">← Обратно · ${escHtml(inbound)}</th>
                ${totalRevHead}
                ${subsidyHead}
                ${totalExpHead}
                ${finHead}
            </tr>
            <tr class="pair-head-sub">
                <th class="pair-sub-out">Места</th>
                ${bookThOut}
                <th class="pair-sub-out">Загр.</th>
                <th class="pair-sub-out pair-split-end">ЗПК</th>${extraSubOut}
                <th class="pair-sub-in pair-split-start">Места</th>
                ${bookThIn}
                <th class="pair-sub-in">Загр.</th>
                <th class="pair-sub-in">ЗПК</th>${extraSubIn}
            </tr>
        </thead><tbody>`;

    const rowHtmls = [];
    entries.forEach(entry => {
        const { date, outRow, inRow } = entry;
        const outM = buildFlightLegMetrics(outRow, firstSalesByKey, todayStart);
        const inM = buildFlightLegMetrics(inRow, firstSalesByKey, todayStart);

        const fd = parseLocalDate(date);
        let rowCls = (getWeekNumber(fd) % 2 === 0) ? 'week-even' : 'week-odd';
        const outClosed = outM.rowCls === 'closed-flight';
        const inClosed = inM.rowCls === 'closed-flight';
        const outFlew = outM.rowCls === 'flew-flight';
        const inFlew = inM.rowCls === 'flew-flight';
        const outFull = outM.rowCls === 'full-loaded';
        const inFull = inM.rowCls === 'full-loaded';
        const allClosed = (outM.empty || outClosed) && (inM.empty || inClosed) && (outClosed || inClosed);
        const allFlew = (outM.empty || outFlew) && (inM.empty || inFlew) && (outFlew || inFlew);
        const allFull = (outM.empty || outFull) && (inM.empty || inFull) && (outFull || inFull);
        if (allClosed) rowCls = 'closed-flight';
        else if (allFlew) rowCls = 'flew-flight';
        else if (allFull) rowCls = 'full-loaded';

        const acRow = outRow || inRow;
        const acCell = acRow ? getAircraftType(acRow[4]) : '—';
        const dateCell = buildPairRowDateCell(date, outRow, inRow, outbound, inbound);
        const segmentCell = hasSegments ? buildPairSegmentCell(outRow, inRow, routeCounts) : '';
        const showRoute = (outRow && shouldShowRouteForRow(outRow, routeCounts))
            || (inRow && shouldShowRouteForRow(inRow, routeCounts));

        const legCells = (m, legCls) => {
            if (m.empty) {
                const cols = legBaseCols + legExtraCols;
                const splitCls = legCls === 'pair-leg-in' ? ' pair-split-start' : (legCls === 'pair-leg-out' ? ' pair-split-end' : '');
                return `<td colspan="${cols}" class="pair-leg-empty${splitCls}">—</td>`;
            }
            const splitStart = legCls === 'pair-leg-in' ? ' pair-split-start' : '';
            const legSalesBase = getBaseFlight(m.flightBase);
            // порядок: ср. тариф → посл. тариф → выручка → расходы
            const extras = [];
            if (showAvg) extras.push({ val: m.avg, cls: '' });
            if (showLast) extras.push({ val: m.last, cls: '' });
            if (showRev) extras.push({ val: m.revenue, cls: '' });
            if (showLegSub) {
                const canEdit = typeof ProfileAuth !== 'undefined' && ProfileAuth.hasPermission('edit_subsidy');
                const shown = m.subsidyOneWay ? formatRub(m.subsidyOneWay) : '—';
                extras.push({
                    val: canEdit
                        ? `<input type="number" class="subsidy-edit-input" step="1"
                            data-flight="${escAttr(m.flightBase)}" data-date="${escAttr(m.date)}"
                            value="${m.subsidyOneWay ? escAttr(String(Math.round(m.subsidyOneWay))) : ''}"
                            placeholder="${m.subsidyCalc ? escAttr(String(Math.round(m.subsidyCalc))) : '0'}"
                            aria-label="Субсидия ${escAttr(m.flightBase)} ${escAttr(m.date)}">`
                        : shown,
                    cls: ' pair-subsidy-cell'
                });
            }
            if (showExp) extras.push({ val: m.costText, cls: ' pair-expenses-cell' });
            const attrs = (extra = '') => `class="pair-leg-cell ${legCls} font-semibold${extra}" data-flight-base="${escAttr(legSalesBase)}" data-flight-code="${escAttr(m.flightBase)}" data-date="${escAttr(m.date)}"`;
            const endOnZpk = legCls === 'pair-leg-out' && !extras.length ? ' pair-split-end' : '';
            let cells = `
                <td ${attrs(splitStart)}>${m.seats}</td>
                ${showBook ? `<td ${attrs(' col-spec-book')}>${m.bookings}</td>` : ''}
                <td ${attrs()}>${m.load}</td>
                <td ${attrs(endOnZpk)}>${m.zpk}</td>`;
            extras.forEach((item, i) => {
                const end = legCls === 'pair-leg-out' && i === extras.length - 1 ? ' pair-split-end' : '';
                const titleAttr = item.title ? ` title="${escAttr(item.title)}"` : '';
                cells += `<td class="col-extra pair-leg-cell ${legCls} font-semibold${item.cls || ''}${end}" data-flight-base="${escAttr(legSalesBase)}" data-flight-code="${escAttr(m.flightBase)}" data-date="${escAttr(m.date)}"${titleAttr}>${item.val}</td>`;
            });
            return cells;
        };

        const outRevN = outM.revenueNum || 0;
        const inRevN = inM.revenueNum || 0;
        const totalRevN = outRevN + inRevN;
        const totalExpN = (outM.costNum || 0) + (inM.costNum || 0);
        const outSubOn = !outM.empty && !!outM.subsidized;
        const inSubOn = !inM.empty && !!inM.subsidized;
        const subLegs = (outSubOn ? 1 : 0) + (inSubOn ? 1 : 0);
        // на ногу: (сумма из файла / 2) × 1000; по паре — сумма двух ног
        const pairSubsidyRub = (outM.subsidyOneWay || 0) + (inM.subsidyOneWay || 0);
        const finN = (totalRevN - totalExpN) + pairSubsidyRub;
        const totalRevCell = showTotalRev ? `
            <td class="col-extra pair-total-rev-cell">
                <div class="pair-total-rev-all">${totalRevN ? formatRub(totalRevN) : '—'}</div>
            </td>` : '';
        const subsidyCell = showSubsidy
            ? `<td class="col-extra pair-subsidy-cell">${pairSubsidyRub ? formatRub(pairSubsidyRub) : (subLegs ? '0 ₽' : '—')}</td>`
            : '';
        const totalExpCell = showTotalExp
            ? `<td class="col-extra pair-expenses-cell">${totalExpN ? formatRub(totalExpN) : '—'}</td>`
            : '';
        const finCell = showFin
            ? `<td class="col-extra pair-fin-cell">${formatRubSigned(finN)}</td>`
            : '';

        const rowFlightCode = outM.flightBase || inM.flightBase || '';
        const rowFlightBase = rowFlightCode ? getBaseFlight(rowFlightCode) : selectedBase;
        rowHtmls.push(`<tr class="${rowCls}${showRoute ? ' segment-row' : ''}${typeof FlightChecks !== 'undefined' ? FlightChecks.rowClass([outRow, inRow]) : ''}" data-date="${escAttr(date)}" data-flight-base="${escAttr(rowFlightBase)}" data-flight-code="${escAttr(rowFlightCode)}" style="cursor: pointer;">
            <td class="col-date font-semibold">${dateCell}</td>
            <td class="font-medium">${escHtml(formatPairDayOfWeek(outRow, inRow, date))}</td>
            ${hasSegments ? `<td>${segmentCell}</td>` : ''}
            <td class="font-semibold pair-ac-cell">${escHtml(acCell)}</td>
            ${legCells(outM, 'pair-leg-out')}
            ${legCells(inM, 'pair-leg-in')}
            ${totalRevCell}
            ${subsidyCell}
            ${totalExpCell}
            ${finCell}
        </tr>`);
    });

    const pairScrollIndex = targetDate ? entries.findIndex(e => e.date === targetDate) : -1;
    if (typeof TableVirtual !== 'undefined') {
        TableVirtual.mount({
            container: cont,
            openTable,
            rows: rowHtmls,
            rowHeight: 44,
            scrollIndex: pairScrollIndex,
            onPaint() { bindSubsidyInputs(cont); }
        });
    } else {
        cont.innerHTML = openTable + rowHtmls.join('') + '</tbody></table>';
        bindSubsidyInputs(cont);
        if (targetDate) {
            setTimeout(() => {
                const tr = cont.querySelector(`tr[data-date="${CSS.escape(targetDate)}"]`);
                if (tr) tr.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 150);
        }
    }
    addExportButtonToTable(cont, 'pair');

    if (typeof SessionStore !== 'undefined') SessionStore.saveUiSession();
    tabPanelState.pair = { flight: selectedBase, date: targetDate, sig: getTableRenderSig() };
}

function bindTableRowDelegation(cont) {
    if (!cont || cont._tableDelegationBound) return;
    cont._tableDelegationBound = true;

    const openDetail = (base, date, code) => {
        if (!base || !date) return;
        if (currentTab === 'pkz' || cont.id === 'pkz-table-container') {
            openPkzReportForFlight(base, date, code);
        } else {
            openSalesReportForFlight(base, date, code);
        }
    };

    // Одинарный клик — выделение ячеек; детализация — по двойному клику
    cont.addEventListener('dblclick', (e) => {
        if (e.target.closest('.table-cols-toggle-btn')) return;
        if (e.target.tagName === 'A' || e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;

        const cell = e.target.closest('[data-flight-base][data-date]');
        if (cell && !cell.classList.contains('pair-leg-empty')) {
            openDetail(cell.dataset.flightBase, cell.dataset.date, cell.dataset.flightCode);
            return;
        }

        const row = e.target.closest('tr[data-date][data-flight-base]');
        if (row) openDetail(row.dataset.flightBase, row.dataset.date, row.dataset.flightCode);
    });
}

function createPairTableView(c) {
    c.innerHTML = `
        <div class="table-page pair-page">
            <div class="table-page-hero card pair-hero">
                <div class="table-page-hero-main">
                    <div id="pair-flight-title" class="pair-flight-title"></div>
                </div>
            </div>
            <div class="table-page-body view-zoom-host">
                <div id="pair-table-controls" class="table-controls-wrap"></div>
                <div id="pair-table-container" class="table-wrapper" data-zoom-target="pair"></div>
                <div id="pair-sales-panel" class="table-sales-panel is-hidden">
                    <div class="table-sales-panel-head">
                        <div>
                            <h3 class="table-sales-panel-title">Продажи по рейсу и дате</h3>
                            <p id="pair-sales-panel-sub" class="table-sales-panel-sub"></p>
                        </div>
                        <button type="button" class="table-sales-panel-close" onclick="closeTableSalesPanel()" >✕</button>
                    </div>
                    <div id="pair-sales-chart-result" class="table-sales-panel-body"></div>
                </div>
            </div>
        </div>
    `;
    bindTableRowDelegation(document.getElementById('pair-table-container'));
    applyViewZoom('pair');
    if (currentFlight && isValidFlightBase(currentFlight)) {
        actuallyRenderPairTable(currentFlight, lastSelectedDate);
    } else {
        const bases = getValidFlightBases();
        if (bases.length) actuallyRenderPairTable(bases[0]);
    }
}

function createTableView(c){
    c.innerHTML = `
        <div class="table-page">
            <div class="table-page-hero card">
                <div class="table-page-hero-main">
                    <div id="selected-flight-title" class="selected-flight-title"></div>
                </div>
            </div>
            <div class="table-page-body view-zoom-host">
                <div id="table-controls" class="table-controls-wrap"></div>
                <div id="table-container" class="table-wrapper" data-zoom-target="table"></div>
                <div id="table-sales-panel" class="table-sales-panel is-hidden">
                    <div class="table-sales-panel-head">
                        <div>
                            <h3 class="table-sales-panel-title">Продажи по рейсу и дате</h3>
                            <p id="table-sales-panel-sub" class="table-sales-panel-sub"></p>
                        </div>
                        <button type="button" class="table-sales-panel-close" onclick="closeTableSalesPanel()" >✕</button>
                    </div>
                    <div id="sales-chart-result" class="table-sales-panel-body"></div>
                </div>
            </div>
        </div>
    `;
    bindTableRowDelegation(document.getElementById('table-container'));
    applyViewZoom('table');
    if (currentFlight && isValidFlightBase(currentFlight)) {
        actuallyRenderTable(currentFlight, lastSelectedDate);
    } else {
        const bases = getValidFlightBases();
        if (bases.length) actuallyRenderTable(bases[0]);
    }
}

function createPkzView(c) {
    c.innerHTML = `
        <div class="table-page pkz-page">
            <div class="table-page-hero card">
                <div class="table-page-hero-main">
                    <div id="pkz-flight-title" class="selected-flight-title"></div>
                </div>
            </div>
            <div class="table-page-body view-zoom-host">
                <div id="pkz-table-controls" class="table-controls-wrap"></div>
                <div id="pkz-table-container" class="table-wrapper" data-zoom-target="pkz"></div>
                <div id="pkz-detail-panel" class="table-sales-panel is-hidden">
                    <div class="table-sales-panel-head">
                        <div>
                            <h3 class="table-sales-panel-title">Расчёт КЗ</h3>
                            <p id="pkz-detail-panel-sub" class="table-sales-panel-sub"></p>
                        </div>
                        <button type="button" class="table-sales-panel-close" onclick="closeTableSalesPanel()" >✕</button>
                    </div>
                    <div id="pkz-detail-result" class="table-sales-panel-body"></div>
                </div>
            </div>
        </div>
    `;
    bindTableRowDelegation(document.getElementById('pkz-table-container'));
    applyViewZoom('pkz');
    if (currentFlight && isValidFlightBase(currentFlight)) {
        actuallyRenderPkzTable(currentFlight, lastSelectedDate);
    } else {
        const bases = getValidFlightBases();
        if (bases.length) actuallyRenderPkzTable(bases[0]);
    }
}

/** ПКЗ из NAV — ручной ввод (позже из файла), key: date|flight */
const PKZ_NAV_STORE_KEY = 'krasavia_pkz_nav_v1';

function getPkzNavMap() {
    try {
        const raw = localStorage.getItem(PKZ_NAV_STORE_KEY);
        if (!raw) return {};
        const o = JSON.parse(raw);
        if (o && o.values && typeof o.values === 'object') {
            const flat = {};
            Object.keys(o.values).forEach((k) => {
                const e = o.values[k];
                const n = e && typeof e === 'object' ? e.v : e;
                if (n !== null && n !== undefined && !isNaN(Number(n))) flat[k] = Number(n);
            });
            return flat;
        }
        return o && typeof o === 'object' ? o : {};
    } catch {
        return {};
    }
}

function pkzNavKey(dateStr, flightCode) {
    return `${dateStr}|${cleanFlight(flightCode || '')}`;
}

function getPkzNavValue(dateStr, flightCode) {
    if (typeof SharedOverrides !== 'undefined') {
        const v = SharedOverrides.getPkzNav(dateStr, flightCode);
        if (v !== null && v !== undefined) return v;
    }
    const v = getPkzNavMap()[pkzNavKey(dateStr, flightCode)];
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return isNaN(n) ? null : n;
}

function setPkzNavValue(dateStr, flightCode, value) {
    if (typeof ProfileAuth !== 'undefined' && !ProfileAuth.hasPermission('edit_pkz_nav')) return;
    if (typeof SharedOverrides !== 'undefined') {
        SharedOverrides.setPkzNav(dateStr, flightCode, value);
        return;
    }
    const map = getPkzNavMap();
    const key = pkzNavKey(dateStr, flightCode);
    if (value === '' || value === null || value === undefined) {
        delete map[key];
    } else {
        const n = parseFloat(String(value).replace(/\s/g, '').replace(',', '.'));
        if (isNaN(n)) delete map[key];
        else map[key] = n;
    }
    try {
        localStorage.setItem(PKZ_NAV_STORE_KEY, JSON.stringify(map));
    } catch (e) {
        console.warn('setPkzNavValue', e);
    }
}

function bindSubsidyInputs(cont) {
    if (!cont) return;
    cont.querySelectorAll('.subsidy-edit-input').forEach((inp) => {
        if (inp.dataset.bound) return;
        inp.dataset.bound = '1';
        ['click', 'mousedown', 'dblclick'].forEach((ev) => {
            inp.addEventListener(ev, (e) => e.stopPropagation());
        });
        inp.addEventListener('change', async () => {
            if (typeof SharedOverrides === 'undefined') return;
            if (typeof ProfileAuth !== 'undefined' && !ProfileAuth.hasPermission('edit_subsidy')) return;
            const raw = inp.value.trim();
            await SharedOverrides.setSubsidy(inp.dataset.flight, inp.dataset.date, raw === '' ? '' : raw);
            // Субсидия меняет проверку рейсов: обновить «!» на других вкладках и счётчик в шапке.
            if (typeof FlightChecks !== 'undefined') FlightChecks.refreshViews();
            const host = document.getElementById('pair-table-container');
            const base = currentFlight;
            if (host && base && typeof actuallyRenderPairTable === 'function') {
                actuallyRenderPairTable(base, lastSelectedDate);
            }
        });
    });
}

function formatVacancyKg(navKg, kzKg) {
    if (navKg === null || navKg === undefined || isNaN(navKg)) return '—';
    if (kzKg === null || kzKg === undefined || isNaN(kzKg)) return '—';
    const v = Math.round(navKg - kzKg);
    const sign = v > 0 ? '+' : '';
    return (typeof formatNum === 'function' ? sign + formatNum(v) : sign + String(v)) + ' кг';
}

function bindPkzNavInputs(cont) {
    if (!cont) return;
    cont.querySelectorAll('.pkz-nav-input').forEach((inp) => {
        if (inp.dataset.bound) return;
        inp.dataset.bound = '1';
        // не запускать выделение / открытие карточки
        ['click', 'mousedown', 'dblclick'].forEach((ev) => {
            inp.addEventListener(ev, (e) => e.stopPropagation());
        });

        const syncVacancy = () => {
            const tr = inp.closest('tr');
            const vacEl = tr?.querySelector('[data-pkz-vacancy]');
            if (!vacEl) return;
            const kz = parseFloat(inp.dataset.kzKg);
            const raw = inp.value.trim();
            if (raw === '') {
                vacEl.textContent = '—';
                vacEl.classList.remove('pkz-vacancy-pos', 'pkz-vacancy-neg');
                return;
            }
            const nav = parseFloat(raw.replace(/\s/g, '').replace(',', '.'));
            if (isNaN(nav) || isNaN(kz)) {
                vacEl.textContent = '—';
                vacEl.classList.remove('pkz-vacancy-pos', 'pkz-vacancy-neg');
                return;
            }
            const v = Math.round(nav - kz);
            vacEl.textContent = formatVacancyKg(nav, kz);
            vacEl.classList.toggle('pkz-vacancy-pos', v > 0);
            vacEl.classList.toggle('pkz-vacancy-neg', v < 0);
        };

        inp.addEventListener('input', syncVacancy);
        inp.addEventListener('change', () => {
            if (typeof ProfileAuth !== 'undefined' && !ProfileAuth.hasPermission('edit_pkz_nav')) return;
            setPkzNavValue(inp.dataset.date, inp.dataset.flight, inp.value);
            syncVacancy();
        });
    });
}

function actuallyRenderPkzTable(base, targetDate = null) {
    const cont = document.getElementById('pkz-table-container');
    const controls = document.getElementById('pkz-table-controls');
    const ttl = document.getElementById('pkz-flight-title');
    if (!cont || !ttl) return;
    if (tableSort.by === 'dtd') tableSort = { by: 'date', dir: 'asc' };

    const flightCount = groupedData[base]?.length || 0;
    ttl.innerHTML = `
        <span class="table-flight-code">${escHtml(base)}</span>
        <span class="table-flight-route">${escHtml(getFlightDirection(base))}</span>
        <span class="table-flight-badge">${flightCount} · горизонт ${typeof PKZ_HORIZON_DAYS !== 'undefined' ? PKZ_HORIZON_DAYS : 10} дн.</span>
    `;

    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    let rows = [...(groupedData[base] || [])].filter(row => row[1] && row[0]);
    rows = rows.filter(row => {
        if (!isPkzHorizonDate || !isPkzHorizonDate(row[1])) return false;
        return flightRowMatchesStatusFilter(row, todayStart);
    });
    rows.sort((a, b) => {
        if (tableSort.by === 'date' && typeof compareRowsByDateThenDep === 'function') {
            return compareRowsByDateThenDep(a, b, tableSort.dir);
        }
        const va = getTableSortValue(a, base);
        const vb = getTableSortValue(b, base);
        return tableSort.dir === 'asc' ? va - vb : vb - va;
    });

    const routeCounts = countRowsByDateFlight(rows);
    const hasSegments = Object.values(routeCounts).some(c => c >= 2);
    const totalCount = (groupedData[base] || []).filter(r => r[1] && isPkzHorizonDate?.(r[1])).length;
    const filterHTML = buildTableFilterPanel(base, rows.length, totalCount, false, {
        showFlightTools: true,
        showSpecBookingsToggle: true
    });
    if (controls) controls.innerHTML = filterHTML;
    bindTableControls(controls || cont, base, targetDate, () => actuallyRenderPkzTable(base, targetDate));

    if (!rows.length) {
        if (typeof TableVirtual !== 'undefined') TableVirtual.destroyHandle(cont);
        renderTableEmptyState(cont, 'Нет рейсов на ближайшие 10 дней', '');
        return;
    }

    const showBook = !!showSpecBookings;
    const segmentHead = hasSegments ? '<th>Маршрут</th>' : '';
    const bookHead = showBook
        ? `<th>Спец. брони</th>`
        : '';
    const openTable = `<table class="data-table w-full pkz-table"><thead><tr>
        <th class="col-date">Дата рейса</th><th>День недели</th>${segmentHead}<th>Тип ВС</th>
        <th>Кресел в продаже</th>
        ${bookHead}
        <th>Загрузка</th><th>Взр.</th><th>Детей</th>
        <th>Ср. багаж+р/к</th>
        <th>ПКЗ из NAV</th>
        <th>КЗ расч.</th>
        <th>Вакансия</th>
        <th>ЗПК %</th>
    </tr></thead><tbody>`;

    const rowHtmls = [];
    rows.forEach(row => {
        const date = row[1] || '-';
        const free = parseInt(row[6] || 0, 10) || 0;
        const avs = getSpecBookings(row);
        const seatsOnSale = getSeatsOnSale(row);
        const orig = cleanFlight(row[0]);
        const extra = orig !== base;
        const k = getSalesLookupKey(row);
        const closed = closedFlights.has(k);
        const fd = parseLocalDate(date);
        const flew = fd ? fd < todayStart : false;
        const denom = seatsOnSale;
        const pct = (denom > 0) ? Math.round(free / denom * 100) : 0;
        const route = getRouteFromRow(row);
        const showRoute = shouldShowRouteForRow(row, routeCounts);
        const ac = getAircraftType(row[4]);

        let cls = (getWeekNumber(fd) % 2 === 0) ? 'week-even' : 'week-odd';
        if (closed) cls = 'closed-flight';
        else if (flew) cls = 'flew-flight';
        else if (pct >= 100) cls = 'full-loaded';

        const status = (closed || flew)
            ? (closed ? '<span class="closed-text">ЗАКРЫТ</span>' : '<span class="flew-text">УЛЕТЕЛ</span>')
            : `<span class="${pct >= 75 ? 'occupancy-high' : 'occupancy-med'}">${pct}%</span>`;

        const details = typeof getPkzFlightDetails === 'function'
            ? getPkzFlightDetails(row, orig, { showSales: false })
            : null;
        const adults = details ? details.adults : free;
        const children = details ? details.children : 0;
        const kzKg = details && details.pkzKg != null && !isNaN(details.pkzKg) ? details.pkzKg : null;
        const pkzText = details ? formatPkzKg(details.pkzKg) : '—';
        const bagTotalText = (typeof formatBaggageTimesLoadKg === 'function' && details)
            ? formatBaggageTimesLoadKg(details)
            : (typeof formatAvgBagUnitKg === 'function' && details ? formatAvgBagUnitKg(details) : '—');
        const bagPer = details && details.baggageKg != null && !isNaN(details.baggageKg)
            ? Number(details.baggageKg).toFixed(1)
            : '—';
        const navVal = getPkzNavValue(date, orig);
        const navInputVal = navVal != null ? String(navVal) : '';
        const vacText = formatVacancyKg(navVal, kzKg);
        const vacCls = navVal != null && kzKg != null
            ? (navVal - kzKg > 0 ? ' pkz-vacancy-pos' : (navVal - kzKg < 0 ? ' pkz-vacancy-neg' : ''))
            : '';
        const segmentCell = hasSegments && showRoute
            ? `<span class="segment-cell"><span class="segment-route">${escHtml(formatRouteDisplay(route))}</span></span>` : '';
        const dateCell = extra
            ? `${escHtml(date)} <span class="font-semibold">${escHtml(orig)}</span> <span class="extra-badge ml-1">(ДОП)</span>`
            : escHtml(date);

        rowHtmls.push(`<tr class="${cls}${showRoute ? ' segment-row' : ''}" data-date="${escAttr(date)}" data-flight-base="${escAttr(base)}" data-flight-code="${escAttr(orig)}" style="cursor:pointer;">
            <td class="col-date">${dateCell}</td>
            <td class="font-medium">${escHtml(getDayOfWeek(date))}</td>
            ${hasSegments ? `<td>${segmentCell}</td>` : ''}
            <td class="font-semibold">${escHtml(ac)}</td>
            <td class="font-semibold">${formatNum(seatsOnSale)}</td>
            ${showBook ? `<td class="font-semibold data-col-bookings">${formatNum(avs)}</td>` : ''}
            <td class="font-semibold">${formatNum(free)}</td>
            <td class="font-semibold">${formatNum(adults)}</td>
            <td class="font-semibold">${formatNum(children)}</td>
            <td class="font-semibold">${escHtml(bagTotalText)}</td>
            <td class="pkz-nav-cell" onclick="event.stopPropagation()">
                <input type="number" class="pkz-nav-input" step="1"
                    data-date="${escAttr(date)}" data-flight="${escAttr(orig)}"
                    data-kz-kg="${kzKg != null ? escAttr(String(kzKg)) : ''}"
                    value="${escAttr(navInputVal)}"
                    placeholder="кг"
                    ${(typeof ProfileAuth !== 'undefined' && !ProfileAuth.hasPermission('edit_pkz_nav')) ? 'readonly' : ''}
                    aria-label="ПКЗ из NAV для ${escAttr(orig)} ${escAttr(date)}">
            </td>
            <td class="font-semibold">${escHtml(pkzText)}</td>
            <td class="font-semibold pkz-vacancy-cell${vacCls}" data-pkz-vacancy>${escHtml(vacText)}</td>
            <td class="font-bold">${status}</td>
        </tr>`);
    });
    const pkzScrollIndex = targetDate ? rows.findIndex(r => r[1] === targetDate) : -1;
    if (typeof TableVirtual !== 'undefined') {
        TableVirtual.mount({
            container: cont,
            openTable,
            rows: rowHtmls,
            rowHeight: 42,
            scrollIndex: pkzScrollIndex,
            onPaint() { bindPkzNavInputs(cont); }
        });
    } else {
        cont.innerHTML = openTable + rowHtmls.join('') + '</tbody></table>';
        bindPkzNavInputs(cont);
        if (targetDate) {
            setTimeout(() => {
                const tr = cont.querySelector(`tr[data-date="${CSS.escape(targetDate)}"]`);
                if (tr) tr.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 150);
        }
    }
    addExportButtonToTable(cont, 'pkz');
    tabPanelState.pkz = { flight: base, date: targetDate, sig: getTableRenderSig() };
    if (typeof SessionStore !== 'undefined') SessionStore.saveUiSession();
}
