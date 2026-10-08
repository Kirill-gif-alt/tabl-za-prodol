// js\rms-view.js - extracted from script.js, logic unchanged.
// Globals on purpose: no bundler; onclick and other files call by name.

let rmsVirtualHandle = null;

function createRmsView(c) {
    c.innerHTML = `
        <div class="rms-page table-page">
            <div class="table-page-hero rms-hero">
                <div class="table-page-hero-main">
                    <div class="rms-hero-head">
                        <h2 class="rms-hero-title">RMS · Сводка по рейсам</h2>
                        <div id="rms-toolbar-stats" class="rms-hero-stats"></div>
                    </div>
                    <p class="rms-hero-note">ЗПК = загрузка / (AU снимка − спец.брони). Pickup и выручка — только окно файла 14д. Без файла — «—», не ноль.</p>
                </div>
            </div>
            <div id="rms-problem-strip" class="rms-problem-strip" hidden></div>
            <div class="table-page-body view-zoom-host">
                <div class="table-controls-wrap">
                    <div class="table-controls-bar rms-controls-bar">
                        <div class="table-filter-group rms-filter-group">
                            <button type="button" id="rms-conditions-btn" onclick="openRmsConditionsModal()" class="filter-btn rms-conditions-open-btn">
                                Условия<span id="rms-cond-badge" class="rms-cond-badge"></span>
                            </button>
                        </div>
                        <div class="table-sort-wrap">
                            <span class="table-sort-label">Период</span>
                            <select id="rms-days-filter" onchange="renderRmsWatchlist()" class="table-sort-select">
                                <option value="7">7 дней</option>
                                <option value="14">14 дней</option>
                                <option value="30" selected>30 дней</option>
                            </select>
                        </div>
                        <div class="table-sort-wrap">
                            <span class="table-sort-label">Тип рейса</span>
                            <select id="rms-route-type-filter" onchange="renderRmsWatchlist()" class="table-sort-select">
                                <option value="all">Все</option>
                                <option value="krai">Краевые</option>
                                <option value="interregional">Межрегиональные</option>
                            </select>
                        </div>
                        <div class="table-sort-wrap">
                            <span class="table-sort-label">Показать</span>
                            <select id="rms-alert-filter" onchange="renderRmsWatchlist()" class="table-sort-select">
                                <option value="all">Все рейсы</option>
                                <option value="alerts">Только предупреждения</option>
                            </select>
                        </div>
                        <div class="table-controls-spacer"></div>
                        <button type="button" onclick="exportRmsToExcel()" class="filter-btn rms-export-btn">
                            📥 Экспорт
                        </button>
                    </div>
                </div>
                <div id="rms-active-hint" class="rms-active-hint" style="display:none"></div>
                <div id="rms-watchlist" class="table-wrapper rms-wrapper" data-zoom-target="rms"></div>
            </div>
        </div>
    `;
    applyViewZoom('rms');
    renderRmsWatchlist();
}

function renderRmsProblemStrip(flights) {
    const strip = document.getElementById('rms-problem-strip');
    if (!strip) return;
    const problems = flights.filter(f => f.alertLevel >= 2).slice(0, 10);
    if (!problems.length) {
        strip.hidden = true;
        strip.innerHTML = '';
        return;
    }
    strip.hidden = false;
    strip.innerHTML = `<span class="rms-problem-label">Сверху проблемные</span>`
        + problems.map(f => {
            const code = f.orig || f.base;
            const delta = f.delta === null ? 'Δ —' : `Δ ${f.delta > 0 ? '+' : ''}${f.delta}`;
            return `<button type="button" class="rms-problem-chip" data-rms-base="${escAttr(f.base)}" data-rms-date="${escAttr(f.date)}" data-rms-orig="${escAttr(code)}">
                <strong>${escHtml(code)}</strong> ${escHtml(f.date)} · ${f.dtd}д · ${f.pct}% · ${escHtml(delta)}
            </button>`;
        }).join('');
}

function getRmsRenderSig() {
    const days = document.getElementById('rms-days-filter')?.value || '30';
    const route = document.getElementById('rms-route-type-filter')?.value || 'all';
    const alert = document.getElementById('rms-alert-filter')?.value || 'all';
    const cond = (typeof rmsActiveConditions !== 'undefined' && Array.isArray(rmsActiveConditions))
        ? rmsActiveConditions.map(c => `${c.field}${c.op}${c.value}`).join(';')
        : '';
    return `${typeof getMetricsCacheSignature === 'function' ? getMetricsCacheSignature() : ''}|${days}|${route}|${alert}|${cond}`;
}

function renderRmsWatchlist() {
    const container = document.getElementById('rms-watchlist');
    const stats = document.getElementById('rms-toolbar-stats');
    if (!container) return;
    const sig = getRmsRenderSig();
    if (container.dataset.renderSig === sig && container.childElementCount > 0) return;
    if (rmsVirtualHandle) {
        rmsVirtualHandle.destroy();
        rmsVirtualHandle = null;
    }

    if (!Object.keys(groupedData).length) {
        renderTableEmptyState(container, 'Загрузите данные', '', '📂');
        if (stats) stats.innerHTML = '';
        updateRmsConditionsBadge();
        renderRmsProblemStrip([]);
        return;
    }

    const flights = getRmsFilteredFlights();
    const kpi = getGlobalKPIs();
    const alertCnt = flights.filter(f => f.alertLevel >= 2).length;
    const avgLoad = flights.length ? Math.round(flights.reduce((a, f) => a + f.pct, 0) / flights.length) : 0;
    const salesReady = typeof hasSalesFileLoaded === 'function' ? hasSalesFileLoaded() : !!(dataLoadStatus && dataLoadStatus.sales);
    const expectedReady = typeof hasExpectedFileLoaded === 'function' ? hasExpectedFileLoaded() : Object.keys(expectedLoadData || {}).length > 0;

    if (stats) {
        stats.innerHTML = `
            <span class="rms-hero-badge">Открытых: <strong>${flights.length}</strong></span>
            <span class="rms-hero-badge rms-hero-badge-warn">Предупр.: <strong>${alertCnt}</strong></span>
            <span class="rms-hero-badge">Продажи 14д: <strong>${salesReady ? kpi.todaySales : '—'}</strong></span>
            <span class="rms-hero-badge">Ср. ЗПК: <strong>${avgLoad}%</strong></span>
        `;
    }
    updateRmsConditionsBadge();
    renderRmsProblemStrip(flights);

    const condCount = getActiveRmsConditions().length;
    if (!flights.length) {
        renderTableEmptyState(
            container,
            condCount ? 'Нет рейсов по условиям' : 'Нет рейсов по фильтрам',
            ''
        );
        return;
    }

    const hasExpected = expectedReady || showExpectedLoadColumn;
    const rmsRouteCounts = countRmsRoutesByDateBase(flights);
    const rowHtmls = flights.map(f => {
        const showRoute = f.route && shouldShowRmsRoute(f, rmsRouteCounts);
        const expectedCells = hasExpected ? `
            <td>${f.evR !== null ? f.evR : '—'}</td>
            <td>${f.delta !== null ? `<span class="${f.deltaCls}">${f.delta > 0 ? '+' : ''}${f.delta}</span>` : '—'}</td>
        ` : '';
        const fd = parseLocalDate(f.date);
        const zebra = (getWeekNumber(fd) % 2 === 0) ? 'week-even' : 'week-odd';
        const alertCls = f.alertLevel >= 3 ? 'rms-row-crit' : (f.alertLevel >= 2 ? 'rms-row-warn' : '');
        const flightCode = f.orig || f.base;
        const flightDir = getFlightDirection(flightCode);
        const routeType = typeof getFlightRouteType === 'function' ? getFlightRouteType(flightCode) : 'unknown';
        const routeTypeLabel = typeof getFlightRouteTypeLabel === 'function' ? getFlightRouteTypeLabel(flightCode) : '';
        const routeTypeCls = routeType === 'krai' ? 'rms-route-krai' : (routeType === 'interregional' ? 'rms-route-inter' : 'rms-route-unknown');
        const pickupTxt = (f.pickup === null || f.pickup === undefined || !salesReady) ? '—' : f.pickup;
        const todayTxt = salesReady ? (f.s.today || 0) : '—';
        const remainTxt = f.remainder != null ? f.remainder : '—';
        return `
            <tr class="rms-row ${zebra} ${alertCls}" data-rms-base="${escAttr(f.base)}" data-rms-date="${escAttr(f.date)}" data-rms-orig="${escAttr(flightCode)}" tabindex="0">
                <td class="rms-col-alert">${f.alertLevel >= 2 ? `<span class="rms-alert-badge rms-alert-badge-${f.alertLevel}">${f.alertLevel >= 3 ? 'КРИТ' : '!'}</span>` : ''}</td>
                <td class="rms-col-flight">
                    <div class="rms-flight-code">${escHtml(flightCode)}${routeTypeLabel ? `<span class="rms-route-badge ${routeTypeCls}">${escHtml(routeTypeLabel)}</span>` : ''}</div>
                    <div class="rms-flight-name">${escHtml(flightDir)}</div>
                    ${showRoute ? `<div class="rms-flight-route">${escHtml(formatRouteDisplay(f.route))}</div>` : ''}
                </td>
                <td class="rms-col-date col-date font-semibold">${escHtml(f.date)}${typeof FlightChecks !== 'undefined' && FlightChecks.modeBadge ? FlightChecks.modeBadge(flightCode, f.date) : ''}</td>
                <td class="rms-col-dtd font-bold ${f.dtd <= 3 ? 'dtd-urgent' : ''}">${f.dtd}</td>
                <td class="rms-col-load font-semibold"><span class="${f.pct >= 75 ? 'occupancy-high' : 'occupancy-med'}">${f.pct}%</span> <span class="rms-load-sub">${f.free} пасс.</span></td>
                <td class="rms-col-remain font-semibold">${remainTxt}</td>
                ${expectedCells}
                <td class="rms-col-pickup font-semibold">${pickupTxt}</td>
                <td class="rms-col-today font-bold ${salesReady && f.s.today ? 'rms-today-hot' : ''}">${todayTxt}</td>
                <td class="rms-col-fare font-semibold">${salesReady && f.avg ? formatRub(f.avg) : '—'}</td>
                <td class="rms-col-reason">${escHtml(f.alertReason) || '—'}</td>
            </tr>
        `;
    });

    container.innerHTML = `
        <table class="data-table rms-table w-full">
            <thead>
                <tr>
                    <th class="rms-col-alert"></th>
                    <th class="rms-col-flight">Рейс</th>
                    <th class="rms-col-date col-date">Дата</th>
                    <th class="rms-col-dtd" title="Дней до вылета">DTD</th>
                    <th class="rms-col-load" title="Загрузка / (AU снимка − спец.брони)">ЗПК</th>
                    <th class="rms-col-remain" title="AU − загрузка − спец.брони">Остаток</th>
                    ${hasExpected ? '<th class="rms-col-forecast" title="Ожидаемая загрузка.xlsx">Ожидаемая</th><th class="rms-col-delta">Δ к ожидаемой</th>' : ''}
                    <th class="rms-col-pickup" title="Билеты сегодня+вчера из файла 14д">Pickup 1–2д</th>
                    <th class="rms-col-today" title="Билеты с DEALDATE=сегодня из файла 14д">Сегодня (файл 14д)</th>
                    <th class="rms-col-fare" title="Среднее по билетам файла 14д">Ср. тариф 14д</th>
                    <th class="rms-col-reason">Причина</th>
                </tr>
            </thead>
            <tbody id="rms-tbody"></tbody>
        </table>
    `;
    const tbody = container.querySelector('#rms-tbody');
    if (typeof TableVirtual !== 'undefined' && rowHtmls.length > 80) {
        rmsVirtualHandle = TableVirtual.bind({
            scrollEl: container,
            tbody,
            rows: rowHtmls,
            rowHeight: 48
        });
    } else if (tbody) {
        tbody.innerHTML = rowHtmls.join('');
    }
    container.dataset.renderSig = sig;
    bindRmsWatchlistClicks(container);
    const strip = document.getElementById('rms-problem-strip');
    if (strip && !strip.dataset.bound) {
        strip.dataset.bound = '1';
        strip.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-rms-base][data-rms-date]');
            if (!btn) return;
            openFlightFromRms(btn.dataset.rmsBase, btn.dataset.rmsDate, btn.dataset.rmsOrig);
        });
    }
}

function bindRmsWatchlistClicks(container) {
    if (!container || container._rmsClickBound) return;
    container._rmsClickBound = true;
    const open = (tr) => {
        if (!tr) return;
        openFlightFromRms(tr.dataset.rmsBase, tr.dataset.rmsDate, tr.dataset.rmsOrig);
    };
    container.addEventListener('click', (e) => {
        open(e.target.closest('tr[data-rms-base][data-rms-date]'));
    });
    container.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const tr = e.target.closest('tr[data-rms-base][data-rms-date]');
        if (!tr) return;
        e.preventDefault();
        open(tr);
    });
}
