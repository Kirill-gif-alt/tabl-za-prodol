// js\rms-view.js - вкладка RMS.
// Globals on purpose: no bundler; onclick and other files call by name.

let rmsVirtualHandle = null;
// Фильтры RMS живут здесь, а не только в выпадающих списках: вкладка строится позже восстановления сессии.
let rmsUiFilters = { days: '30', route: 'all', alert: 'all' };

function rmsFilterChanged(el) {
    const key = { 'rms-days-filter': 'days', 'rms-route-type-filter': 'route', 'rms-alert-filter': 'alert' }[el.id];
    if (key) rmsUiFilters[key] = el.value;
    if (typeof SessionStore !== 'undefined') SessionStore.saveUiSession();
    renderRmsWatchlist();
}

function rmsSel(key, v) { return rmsUiFilters[key] === v ? ' selected' : ''; }

// Пояснение под шапкой: коротко на странице, полностью — по значку «?».
const RMS_NOTE_SHORT = 'Занято — какая часть мест, открытых в продаже, уже продана. Клик по строке — карточка рейса, двойной клик — подробности.';
const RMS_NOTE_FULL = 'Занято = проданные места ÷ (места по снимку − специальные брони). '
    + 'Тариф, деньги и продажи за 1–2 дня берутся из файла продаж за 14 дней: если его нет, они не показываются, а не заменяются нулём. '
    + 'Двойной клик по строке открывает под ней подробности: тариф, деньги, остаток мест, продано за 1–2 дня и сегодня.';

function toggleRmsHelp() {
    const full = document.getElementById('rms-help-full');
    const btn = document.getElementById('rms-help-btn');
    if (!full || !btn) return;
    full.hidden = !full.hidden;
    btn.setAttribute('aria-expanded', full.hidden ? 'false' : 'true');
}

function createRmsView(c) {
    c.innerHTML = `
        <div class="rms-page table-page">
            <div class="table-page-hero rms-hero">
                <div class="table-page-hero-main">
                    <div class="rms-hero-head">
                        <h2 class="rms-hero-title">RMS · Сводка по рейсам</h2>
                        <div id="rms-toolbar-stats" class="rms-hero-stats"></div>
                    </div>
                    <p class="rms-hero-note">
                        <span>${RMS_NOTE_SHORT}</span>
                        <button type="button" id="rms-help-btn" class="rms-help" onclick="toggleRmsHelp()" title="${escAttr(RMS_NOTE_FULL)}" aria-label="Пояснение к таблице" aria-expanded="false" aria-controls="rms-help-full">?</button>
                        <span id="rms-cols-note" class="rms-cols-note" role="status" hidden></span>
                    </p>
                    <p id="rms-help-full" class="rms-help-full" hidden>${escHtml(RMS_NOTE_FULL)}</p>
                </div>
            </div>
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
                            <select id="rms-days-filter" aria-label="Период" onchange="rmsFilterChanged(this)" class="table-sort-select">
                                <option value="7"${rmsSel('days', '7')}>7 дней</option>
                                <option value="14"${rmsSel('days', '14')}>14 дней</option>
                                <option value="30"${rmsSel('days', '30')}>30 дней</option>
                            </select>
                        </div>
                        <div class="table-sort-wrap">
                            <span class="table-sort-label">Тип рейса</span>
                            <select id="rms-route-type-filter" aria-label="Тип рейса" onchange="rmsFilterChanged(this)" class="table-sort-select">
                                <option value="all"${rmsSel('route', 'all')}>Все</option>
                                <option value="krai"${rmsSel('route', 'krai')}>Краевые</option>
                                <option value="interregional"${rmsSel('route', 'interregional')}>Межрегиональные</option>
                            </select>
                        </div>
                        <div class="table-sort-wrap">
                            <span class="table-sort-label">Показать</span>
                            <select id="rms-alert-filter" aria-label="Показать" onchange="rmsFilterChanged(this)" class="table-sort-select">
                                <option value="all"${rmsSel('alert', 'all')}>Все рейсы</option>
                                <option value="alerts"${rmsSel('alert', 'alerts')}>Только предупреждения</option>
                            </select>
                        </div>
                        <div class="table-controls-spacer"></div>
                        <button type="button" onclick="exportRmsToExcel()" class="filter-btn rms-export-btn">
                            В Excel
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

// Высота строки, px. Одна на все строки списка (рейс, подробности, заголовок группы): окно прокрутки считает по ней.
// То же число стоит в css/ux-rms.css (--rms-row-h).
const RMS_ROW_H = 38;
// Сколько ждать второго щелчка, прежде чем открыть карточку: двойной клик раскрывает подробности, а не карточку.
const RMS_DBL_MS = 250;

// Состояние показа: раскрытые строки и «остальные» живут между перерисовками (отметка, смена фильтра).
const rmsExpanded = new Set();
let rmsRestOpen = false;
let rmsModel = null;

function rmsGroupHint(id) {
    if (id === 'crit') return `Отстают от ожидаемого больше чем на ${PV.RMS_CRIT_DELTA} пасс., вылет в ближайшие ${PV.RMS_CRIT_DAYS} дн.`;
    if (id === 'warn') return 'Продано меньше ожидаемого или очень мало для своего срока';
    return 'Нет предупреждений о слабых продажах';
}

function rmsDtdText(dtd) {
    if (dtd === null || dtd === undefined) return '';
    return dtd <= 0 ? 'сегодня' : (dtd === 1 ? 'завтра' : `через ${dtd} дн.`);
}

// Одно действие на строку — из того, что сайт уже подсказывает (сигнал RMS, прогноз к вылету, «Деньги»):
//  КРИТ — снизить цену (так же считает столбец «Деньги»);
//  «!» с прогнозом ниже порога «Повысить не советовать» — снизить цену, с прогнозом выше порога — продвигать, без прогноза — проверить;
//  «!», смягчённый высоким прогнозом, — проверить;
//  «почти полный» и «активные продажи» — повысить цену (как в «Деньгах»), остальное — проверить.
function rmsAction(f, fc) {
    const lvl = f.alertLevel;
    if (!lvl) return null;
    const reason = f.alertReason || '';
    const fcOk = !!(fc && fc.source !== 'flown' && fc.lf !== null && fc.lf !== undefined);
    if (lvl >= 3) return { id: 'down', label: 'Снизить цену', title: 'Продано заметно меньше ожидаемого, а вылет близко: подумайте о снижении цены' };
    if (lvl === 2) {
        if (reason.indexOf('прогноз к вылету') >= 0) return { id: 'check', label: 'Проверить', title: 'Отстаёт, но прогноз к вылету высокий: посмотрите карточку рейса' };
        if (!fcOk) return { id: 'check', label: 'Проверить', title: 'Мало истории для прогноза: посмотрите карточку рейса' };
        return fc.lf < PV.ADVICE_FC_LOW
            ? { id: 'down', label: 'Снизить цену', title: `Прогноз к вылету ${fc.lf}%: рейс не доберёт, стоит снижать цену` }
            : { id: 'promo', label: 'Продвигать', title: `Продано меньше ожидаемого, но прогноз к вылету ${fc.lf}%: подтолкните продажи, цену пока можно не менять` };
    }
    if (reason.startsWith('Почти полный') || reason.startsWith('Активные продажи')) {
        return { id: 'up', label: 'Повысить цену', title: 'Места разбирают быстро: можно поднять цену' };
    }
    return { id: 'check', label: 'Проверить', title: 'Посмотрите карточку рейса' };
}

// В строке причина короче: «вылет через N дн.» уже стоит в столбце «Вылет». Полный текст — в подсказке.
function rmsReasonShort(reason) {
    return String(reason).replace(/, вылет через \d+ дн\./, '');
}

function rmsRowHtml(f, ctx) {
    const showRoute = f.route && shouldShowRmsRoute(f, ctx.routeCounts);
    const fd = parseLocalDate(f.date);
    const zebra = (getWeekNumber(fd) % 2 === 0) ? 'week-even' : 'week-odd';
    const alertCls = f.alertLevel >= 3 ? 'rms-row-crit' : (f.alertLevel >= 2 ? 'rms-row-warn' : '');
    const flightCode = f.orig || f.base;
    const flightDir = getFlightDirection(flightCode);
    const routeType = typeof getFlightRouteType === 'function' ? getFlightRouteType(flightCode) : 'unknown';
    const routeTypeLabel = typeof getFlightRouteTypeLabel === 'function' ? getFlightRouteTypeLabel(flightCode) : '';
    const routeTypeCls = routeType === 'krai' ? 'rms-route-krai' : (routeType === 'interregional' ? 'rms-route-inter' : 'rms-route-unknown');
    const fc = typeof FlightInsights !== 'undefined' ? FlightInsights.forecast(flightCode, f.date) : null;
    const fcOn = !!(fc && fc.source !== 'flown');
    const fcCls = fcOn ? (fc.soldOutDtd != null && fc.load < fc.seats ? 'rms-fc-up' : (fc.lf < 60 ? 'rms-fc-down' : '')) : '';
    const fcTitle = fc ? FlightInsights.forecastText(fc) : 'Мало истории для прогноза';
    const grp = typeof FlightInsights !== 'undefined' ? FlightInsights.groupSeats(flightCode, f.date) : 0;
    const act = rmsAction(f, fc);
    const dtdTxt = rmsDtdText(f.dtd);
    const deltaCell = ctx.hasExpected ? `
                <td class="rms-col-delta">${f.delta !== null ? `<div class="rms-delta ${f.deltaCls}">${f.delta > 0 ? '+' : ''}${String(f.delta).replace('-', '−')}</div>${f.evR !== null ? `<div class="rms-sub">ожидали ${f.evR}</div>` : ''}` : '—'}</td>` : '';
    const loadCls = f.pct >= 75 ? 'occupancy-high' : 'occupancy-med';
    const seatsTxt = f.total ? ` из ${f.total}` : '';
    return `
            <tr class="rms-row ${zebra} ${alertCls}" data-rms-base="${escAttr(f.base)}" data-rms-date="${escAttr(f.date)}" data-rms-orig="${escAttr(flightCode)}" data-rms-key="${escAttr(flightCode + '|' + f.date)}" data-pm-row="1" tabindex="0">
                <td class="rms-col-flight">
                    <div class="rms-flight-code">${escHtml(flightCode)}${routeTypeLabel ? `<span class="rms-route-badge ${routeTypeCls}">${escHtml(routeTypeLabel)}</span>` : ''}${grp ? `<span class="grp-badge" title="В группах ${grp} чел. (заказы от ${FlightInsights.GROUP_MIN} билетов)">Г ${grp}</span>` : ''}</div>
                    <div class="rms-flight-name">${escHtml(flightDir)}${showRoute ? `<span class="rms-flight-route"> · ${escHtml(formatRouteDisplay(f.route))}</span>` : ''}</div>
                </td>
                <td class="rms-col-date col-date">
                    <div class="rms-date font-semibold">${escHtml(f.date)}${typeof FlightChecks !== 'undefined' && FlightChecks.modeBadge ? FlightChecks.modeBadge(flightCode, f.date) : ''}</div>
                    <div class="rms-sub"><span class="${f.dtd <= 3 ? 'dtd-urgent rms-dtd' : 'rms-dtd'}">${dtdTxt}</span></div>
                </td>
                <td class="rms-col-load">
                    <div>${f.pct === null || f.pct === undefined ? '<span class="rms-sub">занято —</span>' : `<span class="${loadCls}">занято ${f.pct}%</span>`}</div>
                    <div class="rms-sub rms-load-sub">${f.free}${seatsTxt} пасс.</div>
                </td>
                <td class="rms-col-fc font-semibold ${fcCls}" title="${escAttr(fcTitle)}">${fcOn ? escHtml(FlightInsights.forecastShort(fc)) : '—'}</td>${deltaCell}
                <td class="rms-col-reason"${f.alertReason ? ` title="${escAttr(f.alertReason)}"` : ''}><span class="rms-reason-text">${f.alertReason ? escHtml(rmsReasonShort(f.alertReason)).replace(/(\d) (дн\.|пасс\.)/g, '$1 $2') : '—'}</span></td>
                <td class="rms-col-act">${act ? `<span class="rms-act rms-act-${act.id}" title="${escAttr(act.title)}">${act.label}</span>` : ''}</td>
                ${ctx.markOn ? `<td class="rms-col-mark">${PriceMarks.chipHtml(flightCode, f.date)}</td>` : ''}
            </tr>
        `;
}

// Подробности под строкой: то, что убрано из таблицы. Одна строка той же высоты, что и остальные.
function rmsDetailHtml(f, ctx) {
    const code = f.orig || f.base;
    const mny = typeof getRmsMoney === 'function' ? getRmsMoney(f) : null;
    const item = (label, value, cls, title) => `<span class="rms-detail-item"${title ? ` title="${escAttr(title)}"` : ''}>${label} <b${cls ? ` class="${cls}"` : ''}>${value}</b></span>`;
    const parts = [
        item('Средний тариф', ctx.salesReady && f.avg ? formatRub(f.avg) : '—', '', 'Средний тариф по всем билетам вылета в файле продаж'),
        item('Деньги под вылетом', mny ? `${Math.round(mny.rub).toLocaleString('ru-RU')} ₽` : '—', '', typeof SalesAdvice !== 'undefined' ? SalesAdvice.moneyTitle(mny) : ''),
        item('Остаток мест', f.remainder != null ? f.remainder : '—', '', 'Места по снимку − проданные − специальные брони')
    ];
    if (ctx.hasExpected && f.evR !== null) parts.push(item('Ожидаемая загрузка', f.evR, '', 'Из файла «Ожидаемая загрузка.xlsx»'));
    if (ctx.showPickup) parts.push(item('Продано за 1–2 дня', f.pickup === null || f.pickup === undefined ? '—' : f.pickup, '', 'Билеты за сегодня и вчера из файла продаж за 14 дней'));
    if (ctx.showToday) parts.push(item('Продано сегодня', f.s.today || 0, f.s.today ? 'rms-today-hot' : '', 'Билеты, проданные сегодня, из файла продаж за 14 дней'));
    return `
            <tr class="rms-detail" data-rms-key="${escAttr(code + '|' + f.date)}" title="Двойной клик — свернуть">
                <td colspan="${ctx.colCount}"><div class="rms-detail-line"><span class="rms-detail-code">${escHtml(code)} · ${escHtml(f.date)}</span>${parts.join('')}</div></td>
            </tr>
        `;
}

function rmsGroupHtml(id, count, ctx) {
    const names = { crit: 'Срочно', warn: 'Присмотреться', rest: 'Остальные рейсы' };
    const word = `${count} ${pluralRu(count, 'рейс', 'рейса', 'рейсов')}`;
    let extra = '';
    if (id === 'rest') {
        const open = ctx.restOpen;
        extra = ctx.restForced ? '' : `<button type="button" class="rms-rest-toggle" data-rms-rest="1" aria-expanded="${open ? 'true' : 'false'}">${open ? 'Скрыть остальные' : `Показать остальные ${count}`}</button>`;
    }
    return `
            <tr class="rms-group rms-group-${id}" aria-label="${escAttr(names[id])}">
                <td colspan="${ctx.colCount}"><div class="rms-group-line"><span class="rms-group-title">${names[id]}</span><span class="rms-group-count">${count ? word : 'нет'}</span><span class="rms-group-hint">${escHtml(rmsGroupHint(id))}</span>${extra}</div></td>
            </tr>
        `;
}

// Список строк таблицы: заголовки групп, рейсы и раскрытые подробности. Каждая строка строится лениво — только когда её показывают.
function rmsBuildEntries(m) {
    const ctx = m.ctx;
    const out = [];
    const addFlights = (list) => {
        list.forEach(f => {
            out.push(lazyRow(() => rmsRowHtml(f, ctx)));
            if (rmsExpanded.has((f.orig || f.base) + '|' + f.date)) out.push(lazyRow(() => rmsDetailHtml(f, ctx)));
        });
    };
    out.push(rmsGroupHtml('crit', m.crit.length, ctx));
    addFlights(m.crit);
    out.push(rmsGroupHtml('warn', m.warn.length, ctx));
    addFlights(m.warn);
    if (m.rest.length) {
        out.push(rmsGroupHtml('rest', m.rest.length, ctx));
        if (ctx.restOpen) addFlights(m.rest);
    }
    return out;
}

// Ставит строки в таблицу: окно прокрутки для длинного списка, иначе всё сразу. Прокрутка не сбрасывается.
function rmsMountRows(container) {
    if (!rmsModel || !container) return;
    const tbody = container.querySelector('#rms-tbody');
    if (!tbody) return;
    const ctx = rmsModel.ctx;
    ctx.restForced = rmsModel.crit.length + rmsModel.warn.length === 0;
    ctx.restOpen = rmsRestOpen || ctx.restForced;
    if (rmsVirtualHandle) {
        rmsVirtualHandle.destroy();
        rmsVirtualHandle = null;
    }
    const rows = rmsBuildEntries(rmsModel);
    if (typeof TableVirtual !== 'undefined' && rows.length > 80) {
        rmsVirtualHandle = TableVirtual.bind({ scrollEl: container, tbody, rows, rowHeight: RMS_ROW_H });
    } else {
        tbody.innerHTML = rows.join('');
    }
}

function rmsToggleDetail(key) {
    if (!key) return;
    if (rmsExpanded.has(key)) rmsExpanded.delete(key); else rmsExpanded.add(key);
    rmsMountRows(document.getElementById('rms-watchlist'));
}

function rmsToggleRest() {
    rmsRestOpen = !rmsRestOpen;
    rmsMountRows(document.getElementById('rms-watchlist'));
}

function getRmsRenderSig() {
    const days = document.getElementById('rms-days-filter')?.value || '30';
    const route = document.getElementById('rms-route-type-filter')?.value || 'all';
    const alert = document.getElementById('rms-alert-filter')?.value || 'all';
    const cond = (typeof rmsActiveConditions !== 'undefined' && Array.isArray(rmsActiveConditions))
        ? rmsActiveConditions.map(c => `${c.field}${c.op}${c.value}`).join(';')
        : '';
    const marks = typeof SalesManagement !== 'undefined' && SalesManagement.markRevision ? SalesManagement.markRevision() : 0;
    return `${typeof getMetricsCacheSignature === 'function' ? getMetricsCacheSignature() : ''}|${days}|${route}|${alert}|${cond}|${typeof getTodayDate === 'function' ? getTodayDate() : ''}|pm${marks}|a${typeof analyticsRevision === 'function' ? analyticsRevision() : ''}`;
}

function renderRmsWatchlist() {
    const container = document.getElementById('rms-watchlist');
    const stats = document.getElementById('rms-toolbar-stats');
    const colsNote = document.getElementById('rms-cols-note');
    if (!container) return;
    const sig = getRmsRenderSig();
    if (container.dataset.renderSig === sig && container.childElementCount > 0) return;
    delete container.dataset.renderSig;
    if (colsNote) colsNote.hidden = true;
    if (rmsVirtualHandle) {
        rmsVirtualHandle.destroy();
        rmsVirtualHandle = null;
    }
    rmsModel = null;

    if (!Object.keys(groupedData).length) {
        renderTableEmptyState(container, 'Загрузите данные', '', '📂');
        if (stats) stats.innerHTML = '';
        updateRmsConditionsBadge();
        return;
    }

    const flights = getRmsFilteredFlights();
    const rmsDays = parseInt(document.getElementById('rms-days-filter')?.value || '30', 10) || 30;
    const kpi = getGlobalKPIs();
    const alertCnt = flights.filter(f => f.alertLevel >= 2).length;
    // Средняя загрузка — по местам: сумма проданных / сумма кресел в продаже.
    const seatSum = flights.reduce((a, f) => a + (f.total || 0), 0);
    const avgLoad = seatSum ? Math.round(flights.reduce((a, f) => a + (f.total ? f.free : 0), 0) / seatSum * 100) : null;
    const stale = typeof getStaleSalesInfo === 'function' ? getStaleSalesInfo() : null;
    const salesReady = typeof hasSalesFileLoaded === 'function' ? hasSalesFileLoaded() : !!(dataLoadStatus && dataLoadStatus.sales);
    const expectedReady = typeof hasExpectedFileLoaded === 'function' ? hasExpectedFileLoaded() : Object.keys(expectedLoadData || {}).length > 0;

    const markOn = typeof PriceMarks !== 'undefined' && typeof SalesManagement !== 'undefined';
    const checkedToday = markOn ? flights.filter(f => PriceMarks.todayMark(f.orig || f.base, f.date)).length : 0;
    if (stats) {
        stats.innerHTML = `
            <span class="rms-hero-badge" title="${escAttr(`Вылеты на ${rmsDays} ${pluralRu(rmsDays, 'день', 'дня', 'дней')} вперёд, считая сегодня. Закрытые и улетевшие не входят. Учтены фильтры и условия.`)}">Открытых: <strong>${flights.length}</strong></span>
            ${markOn ? `<span class="rms-hero-badge" title="Рейсов в списке с отметкой «Управления продажами» за сегодня">Проверено сегодня: <strong>${checkedToday}/${flights.length}</strong></span>` : ''}
            <span class="rms-hero-badge rms-hero-badge-warn" title="Рейсы из групп «Срочно» и «Присмотреться» в этом списке. Число ⚠ в шапке сайта считается за 30 дней и без фильтров.">Предупр.: <strong>${alertCnt}</strong></span>
            <span class="rms-hero-badge" title="Все билеты, проданные сегодня, по всей сети: фильтры таблицы не учитываются">Продано сегодня: <strong>${!salesReady ? '—' : (stale ? `нет свежих данных (от ${stale.label})` : kpi.todaySales)}</strong></span>
            <span class="rms-hero-badge" title="Проданные места ÷ места в продаже по всем рейсам списка">Занято в среднем: <strong>${avgLoad === null ? '—' : avgLoad + '%'}</strong></span>
        `;
    }
    updateRmsConditionsBadge();

    const condCount = getActiveRmsConditions().length;
    if (!flights.length) {
        const salesCond = getActiveRmsConditions().some(c => c.field === 'pickup' || c.field === 'salesToday');
        renderTableEmptyState(
            container,
            condCount ? 'Нет рейсов по условиям' : 'Нет рейсов по фильтрам',
            salesCond && (!salesReady || stale) ? (salesReady ? 'Нет свежих данных о продажах — условия по продажам не работают.' : 'Файл продаж не загружен — условия по продажам не работают.') : ''
        );
        return;
    }

    const hasExpected = expectedReady || showExpectedLoadColumn;
    // Продажи за 1–2 дня и за сегодня — в подробностях; без данных их там нет (а не одни «—»). Считается один раз, не по строкам.
    const salesOff = !salesReady || !!stale;
    const showPickup = !salesOff && flights.some(f => f.pickup !== null && f.pickup !== undefined);
    const showToday = !salesOff;
    if (colsNote) {
        const why = salesReady ? 'нет свежих данных' : 'файл продаж не загружен';
        const note = (!showPickup && !showToday) ? `В подробностях строки нет продаж за 1–2 дня и за сегодня: ${why}`
            : (!showPickup ? `В подробностях строки нет продаж за 1–2 дня: ${why}` : '');
        colsNote.textContent = note;
        colsNote.hidden = !note;
    }
    // Порядок внутри групп — как отдаёт расчёт (по деньгам, потом по близости вылета): он не меняется.
    const crit = [], warn = [], rest = [];
    flights.forEach(f => { (f.alertLevel >= 3 ? crit : (f.alertLevel >= 2 ? warn : rest)).push(f); });
    const colCount = 6 + (hasExpected ? 1 : 0) + (markOn ? 1 : 0);
    rmsModel = {
        crit, warn, rest,
        ctx: { hasExpected, salesReady, showPickup, showToday, markOn, colCount, routeCounts: countRmsRoutesByDateBase(flights), restOpen: false, restForced: false }
    };

    container.innerHTML = `
        <table class="data-table rms-table w-full">
            <thead>
                <tr>
                    <th class="rms-col-flight" title="Номер рейса, направление и тип рейса">Рейс</th>
                    <th class="rms-col-date col-date" title="Дата вылета и сколько дней осталось. Буква С — субсидия, К — коммерция">Вылет</th>
                    <th class="rms-col-load" title="Какая часть мест, открытых в продаже, уже продана, и сколько это пассажиров">Занято</th>
                    <th class="rms-col-fc" title="Прогноз загрузки к вылету — тот же, что в карточке рейса: модель прогноза (если она вам доступна), иначе сколько обычно добирают такие же вылеты в тот же день недели; в скобках — пределы, в которые попадают 8 вылетов из 10">Прогноз к вылету</th>
                    ${hasExpected ? '<th class="rms-col-delta" title="Разница с ожидаемой загрузкой из файла «Ожидаемая загрузка.xlsx», пассажиров: минус — продано меньше ожидаемого, плюс — больше">Разница с ожидаемой</th>' : ''}
                    <th class="rms-col-reason" title="Почему рейс попал в предупреждения. Полный текст — в подсказке к строке">Причина</th>
                    <th class="rms-col-act" title="Что сайт подсказывает сделать с ценой. Решение остаётся за вами: отметку ставьте справа">Что сделать</th>
                    ${markOn ? '<th class="rms-col-mark" title="Отметка «Управления продажами» за сегодня: клик по значку или клавиши 1–4 на строке (1 без изменений, 2 внимание, 3 снижение, 4 повышение)">Отметка</th>' : ''}
                </tr>
            </thead>
            <tbody id="rms-tbody"></tbody>
        </table>
    `;
    rmsMountRows(container);
    container.dataset.renderSig = sig;
    bindRmsWatchlistClicks(container);
}

function bindRmsWatchlistClicks(container) {
    if (!container || container._rmsClickBound) return;
    container._rmsClickBound = true;
    let timer = 0;
    const open = (d) => openFlightFromRms(d.rmsBase, d.rmsDate, d.rmsOrig);
    container.addEventListener('click', (e) => {
        if (e.target.closest('[data-rms-rest]')) {
            rmsToggleRest();
            return;
        }
        const tr = e.target.closest('tr.rms-row[data-rms-base][data-rms-date]');
        if (!tr) return;
        if (e.detail > 1) return;   // второй щелчок двойного: карточку не открываем
        const d = { rmsBase: tr.dataset.rmsBase, rmsDate: tr.dataset.rmsDate, rmsOrig: tr.dataset.rmsOrig };
        clearTimeout(timer);
        timer = setTimeout(() => open(d), RMS_DBL_MS);
    });
    container.addEventListener('dblclick', (e) => {
        if (e.target.closest('button, a, input, select')) return;
        const tr = e.target.closest('tr.rms-row[data-rms-key], tr.rms-detail[data-rms-key]');
        if (!tr) return;
        clearTimeout(timer);
        rmsToggleDetail(tr.dataset.rmsKey);
    });
    container.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const tr = e.target.closest('tr.rms-row[data-rms-base][data-rms-date]');
        if (!tr || e.target !== tr) return;
        e.preventDefault();
        clearTimeout(timer);
        openFlightFromRms(tr.dataset.rmsBase, tr.dataset.rmsDate, tr.dataset.rmsOrig);
    });
}

// Отметка поставлена (чип, клавиши 1–4, карточка) — обновить чипы и счётчик, вернуть фокус на строку.
document.addEventListener('krasavia:mark', (e) => {
    if (typeof currentTab === 'undefined' || currentTab !== 'rms') return;
    const container = document.getElementById('rms-watchlist');
    if (!container) return;
    const d = e.detail || {};
    const scroll = container.scrollTop;
    delete container.dataset.renderSig;
    renderRmsWatchlist();
    container.scrollTop = scroll;
    requestAnimationFrame(() => {
        const tr = container.querySelector(`tr[data-rms-orig="${CSS.escape(d.code || '')}"][data-rms-date="${CSS.escape(d.date || '')}"]`);
        if (tr) tr.focus({ preventScroll: true });
    });
});
