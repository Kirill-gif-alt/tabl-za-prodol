// «Сегодня» — стартовая страница: главное за день одним экраном.
//  • строка-вывод: сколько ждёт решения, ошибок тарифов, пропусков справочника;
//  • ключевые цифры: загрузка вылетов на 7 дней, продано сегодня, отклонение от обычного, итог решений за 30 дней;
//  • полоса дней (сегодня и столько дней вперёд, сколько выбрано в «Вперёд на»): загрузка и число решений;
//    клик — вылеты этого дня;
//  • таблица: «Ждут решения» / «Ошибки тарифов» / «Вылеты дня»; клик по строке — карточка рейса
//    (если она показана кнопкой ▤), «Открыть» — рейс в «Управлении продажами» или «Динамике продаж».
// Считает лениво и только при открытии страницы; подсказки — те же, что в УП и сводке (SalesAdvice).
window.TodayView = (function () {
    let tab = 'advice';         // advice | errors | day
    let pickDay = '';           // выбранный день полосы (ДД.ММ.ГГГГ)
    let selected = null;        // { code, date }
    let advice = [];
    let adviceSig = '';
    let building = null;
    // «К обычному»: на сколько пассажиров вылеты ближайших 7 дней выше или ниже нормы «к этому дню».
    let normTile = { sig: '', data: null };
    let normBuilding = false;
    // «Решения за 30 дней»: только готовые зафиксированные итоги (DecisionMoney.get), без пересчёта.
    let decTile = { sig: '', data: null, loading: false };
    // Сколько дней вперёд смотреть «Ждут решения» — выбирает сам пользователь, запоминается на профиль.
    const AHEAD_OPTIONS = [3, 5, 7, 10, 15, 20, 30];
    const AHEAD_KEY = 'krasavia_today_ahead_';
    function aheadKey() {
        const p = typeof ProfileAuth !== 'undefined' && ProfileAuth.getCurrentProfile ? ProfileAuth.getCurrentProfile() : null;
        return AHEAD_KEY + (p ? p.id : 'guest');
    }
    function aheadDays() {
        let v = 0;
        try { v = parseInt(localStorage.getItem(aheadKey()), 10); } catch (e) { /* ignore */ }
        return AHEAD_OPTIONS.includes(v) ? v : (typeof SalesAdvice !== 'undefined' ? SalesAdvice.DAYS_AHEAD : 15);
    }
    function setAheadDays(v) {
        try { localStorage.setItem(aheadKey(), String(v)); } catch (e) { /* ignore */ }
    }

    function esc(v) {
        return typeof escHtml === 'function' ? escHtml(v) : String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function canTab(t) {
        return typeof ProfileAuth === 'undefined' || ProfileAuth.canAccessTab(t);
    }

    function hasData() {
        return typeof groupedData !== 'undefined' && groupedData && Object.keys(groupedData).length > 0;
    }

    function today() {
        return typeof getTodayDate === 'function' ? getTodayDate() : '';
    }

    function shift(dateStr, n) {
        const d = parseLocalDate(dateStr);
        if (!d) return '';
        d.setDate(d.getDate() + n);
        return formatDateRu(d);
    }

    function signed(n) {
        const v = Math.round(Number(n) || 0);
        return (v > 0 ? '+' : (v < 0 ? '−' : '')) + Math.abs(v).toLocaleString('ru-RU');
    }

    function signedRub(n) {
        return signed(n) + ' ₽';
    }

    function fmt(n) {
        return Math.round(Number(n) || 0).toLocaleString('ru-RU');
    }

    // Все вылеты (по строкам «загрузки таб») на дату.
    // Строки данных раскладываются по датам один раз на загрузку данных: вызывается десятки раз за отрисовку.
    let rowsByDate = null;
    let rowsByDateKey = null;
    function rowsOnDate(date) {
        const key = typeof dataEpoch === 'number' ? dataEpoch : 0;
        if (!rowsByDate || rowsByDateKey !== key || rowsByDate.src !== groupedData) {
            const map = new Map();
            Object.keys(groupedData || {}).forEach(base => {
                (groupedData[base] || []).forEach(r => {
                    if (!r) return;
                    let list = map.get(r[1]);
                    if (!list) map.set(r[1], list = []);
                    list.push([base, r]);
                });
            });
            map.src = groupedData;
            rowsByDate = map;
            rowsByDateKey = key;
        }
        return rowsByDate.get(date) || [];
    }

    function departuresOn(date) {
        const out = [];
        const seen = new Set();
        rowsOnDate(date).forEach(([base, r]) => {
            const code = cleanFlight(r[0]);
            if (seen.has(code)) return;
            seen.add(code);
            const seats = typeof getSeatsOnSale === 'function' ? getSeatsOnSale(r) : 0;
            const sold = typeof getSoldFromRow === 'function' ? getSoldFromRow(r) : 0;
            out.push({ code, base, date, row: r, seats, sold });
        });
        return out.sort((a, b) => String(a.row[11] || '').localeCompare(String(b.row[11] || '')) || (parseInt(a.code.slice(3), 10) - parseInt(b.code.slice(3), 10)));
    }

    // Список УП кэшируется в SalesManagement: набор вылетов пересобираем, только когда сменился сам список.
    let depCache = { list: null, set: new Set() };
    function salesDepartures() {
        if (typeof SalesManagement === 'undefined' || !SalesManagement.listFlights) return new Set();
        try {
            const list = SalesManagement.listFlights();
            if (depCache.list === list) return depCache.set;
            const set = new Set();
            list.forEach(f => (f.departures || []).forEach(d => set.add(d.code + '|' + d.date)));
            depCache = { list, set };
            return set;
        } catch (e) { return new Set(); }
    }

    // Подсказки посчитаны под нынешние данные и окно дней (иначе «0 ждут решения» — это ещё не итог).
    function adviceReady() {
        return typeof SalesAdvice === 'undefined' || adviceSig === sig();
    }

    function sig() {
        return [typeof dataEpoch === 'number' ? dataEpoch : 0, today(), typeof allData !== 'undefined' && allData ? allData.length : 0, aheadDays(),
            typeof analyticsRevision === 'function' ? analyticsRevision() : '', typeof Params !== 'undefined' ? Params.revision() : 0].join('|');
    }

    async function buildAdvice() {
        if (!canTab('sales') || typeof SalesAdvice === 'undefined') { advice = []; return; }
        const s = sig();
        if (adviceSig === s) return;
        // Идёт расчёт для другого окна дней — дождаться и пересчитать под нынешний выбор.
        if (building) return building.then(() => buildAdvice());
        building = (async () => {
            advice = await SalesAdvice.scanAll(salesDepartures(), aheadDays(), 'today');
            adviceSig = s;
        })().finally(() => { building = null; });
        return building;
    }

    // Норма считается порциями после подсказок; пока не готова — в плитке «—».
    async function buildNorm() {
        if (typeof SalesAdvice === 'undefined' || !hasData()) return;
        const s = sig();
        if (normTile.sig === s || normBuilding) return;
        normBuilding = true;
        try {
            const list = [];
            for (let i = 0; i < 7; i++) departuresOn(shift(today(), i)).forEach(d => list.push(d));
            let diff = 0;
            let n = 0;
            for (let i = 0; i < list.length; i++) {
                const d = list[i];
                const closed = typeof closedFlights !== 'undefined' && typeof getSalesLookupKey === 'function' && closedFlights.has(getSalesLookupKey(d.row));
                if (!closed) {
                    const nm = SalesAdvice.norms(d.code, d.date);
                    if (nm && nm.ref != null) { diff += nm.sold - nm.ref; n++; }
                }
                if (i % 20 === 19) await new Promise(r => setTimeout(r, 0));
            }
            normTile = { sig: s, data: { diff, n, total: list.length } };
        } finally { normBuilding = false; }
    }

    function monthOfDate(dateStr) {
        const d = parseLocalDate(dateStr);
        return d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` : '';
    }

    function decSig() {
        return [typeof dataEpoch === 'number' ? dataEpoch : 0, today(),
            typeof SalesManagement !== 'undefined' && SalesManagement.markRevision ? SalesManagement.markRevision() : '',
            typeof DecisionMoney !== 'undefined' ? DecisionMoney.revision() : 0].join('|');
    }

    // Решения «снизить/повысить» за 30 дней и их готовые итоги. Плитка скрыта, если готовых итогов нет.
    function buildDecisions() {
        if (!canTab('sales') || typeof DecisionMoney === 'undefined' || typeof SalesManagement === 'undefined' || !SalesManagement.allMarks) return;
        const s = decSig();
        if (decTile.sig === s || decTile.loading) return;
        const t0 = parseLocalDate(today());
        const seen = new Set();
        const list = [];
        SalesManagement.allMarks().forEach(m => {
            if (m.status !== 'down' && m.status !== 'up') return;
            const d = parseLocalDate(m.check);
            const ago = d && t0 ? Math.round((t0 - d) / 86400000) : null;
            if (ago == null || ago < 0 || ago > 30) return;
            const k = DecisionMoney.keyOf(m);
            if (seen.has(k)) return;
            seen.add(k);
            list.push({ key: k, month: monthOfDate(m.check) });
        });
        decTile.loading = true;
        DecisionMoney.ensureMonths([...new Set(list.map(x => x.month).filter(Boolean))]).catch(() => {}).then(() => {
            const pos = ['worked', 'lean_pos', 'weak_pos'];
            const neg = ['failed', 'lean_neg', 'weak_neg'];
            let better = 0;
            let worse = 0;
            let sum = 0;
            let ready = 0;
            list.forEach(x => {
                const e = DecisionMoney.get(x.key);
                if (!e || e.v !== DecisionMoney.METHOD_VERSION || e.stage !== 'final') return;
                ready++;
                sum += e.delta || 0;
                if (pos.includes(e.verdict)) better++;
                else if (neg.includes(e.verdict)) worse++;
            });
            decTile = { sig: s, loading: false, data: ready ? { better, worse, sum, ready, total: list.length } : null };
            if (typeof currentTab !== 'undefined' && currentTab === 'today') render();
        });
    }

    function pending() {
        const t = today();
        const inSales = salesDepartures();
        const days = aheadDays();
        return advice.filter(a => inSales.has(a.code + '|' + a.date)
            && (typeof SalesAdvice === 'undefined' || SalesAdvice.inWindow(a.date, days))
            && !(typeof SalesManagement !== 'undefined' && SalesManagement.getMarks(a.code, a.date, t).length));
    }

    function fareErrors() {
        if (typeof FlightChecks === 'undefined' || !FlightChecks.enabled()) return [];
        const map = new Map();
        FlightChecks.list().filter(i => i.state !== 'Улетел').forEach(i => {
            const k = i.code + '|' + i.date;
            if (!map.has(k)) map.set(k, { code: i.code, date: i.date, items: [] });
            map.get(k).items.push(i);
        });
        return [...map.values()];
    }

    function rowFor(code, date) {
        const base = typeof getBaseFlight === 'function' ? getBaseFlight(code) : code;
        return typeof getFlightRowForDate === 'function' ? getFlightRowForDate(base, date, code) : null;
    }

    function daysUntil(date) {
        return typeof getDaysUntil === 'function' ? getDaysUntil(date) : null;
    }

    // ---------- шапка: строка-вывод и цифры ----------

    function kpis() {
        let sold = 0;
        let seats = 0;
        let n = 0;
        for (let i = 0; i < 7; i++) {
            departuresOn(shift(today(), i)).forEach(d => { sold += d.sold; seats += d.seats; n++; });
        }
        const k = typeof getGlobalKPIs === 'function' ? getGlobalKPIs() : {};
        return { lf: seats ? Math.round(sold / seats * 100) : null, sold, seats, n, todaySales: Number(k.todaySales) || 0, todayRevenue: Number(k.todayRevenue) || 0 };
    }

    function leadText(p, errs, gaps) {
        const parts = [];
        if (canTab('sales')) parts.push(!adviceReady() ? 'подсказки по вылетам считаются…' : p ? `${p} ${pluralRu(p, 'вылет ждёт', 'вылета ждут', 'вылетов ждут')} решения` : `все вылеты на ${aheadDays()} дн. в норме или уже отмечены`);
        if (typeof FlightChecks !== 'undefined' && FlightChecks.enabled()) parts.push(errs ? `${errs} ${pluralRu(errs, 'рейс', 'рейса', 'рейсов')} с ошибкой тарифа` : 'ошибок тарифов нет');
        if (gaps) parts.push(`в справочнике ${gaps} ${pluralRu(gaps, 'пропуск', 'пропуска', 'пропусков')}`);
        return parts.length ? parts.join(', ') + '.' : '';
    }

    // ---------- полоса дней ----------

    function dayStripHtml(pend) {
        const byDay = new Map();
        pend.forEach(a => byDay.set(a.date, (byDay.get(a.date) || 0) + 1));
        const cells = [];
        const days = aheadDays() + 1;
        for (let i = 0; i < days; i++) {
            const date = shift(today(), i);
            const deps = departuresOn(date);
            const sold = deps.reduce((s, d) => s + d.sold, 0);
            const seats = deps.reduce((s, d) => s + d.seats, 0);
            const lf = seats ? Math.round(sold / seats * 100) : null;
            const dt = parseLocalDate(date);
            const dow = dt && typeof DAYS_RU !== 'undefined' ? DAYS_RU[dt.getDay()] : '';
            const wk = dt && (dt.getDay() === 0 || dt.getDay() === 6);
            const dec = byDay.get(date) || 0;
            const cls = lf == null ? '' : lf >= 85 ? 'td-hi' : lf >= 60 ? 'td-mid' : lf >= 40 ? 'td-low' : 'td-bad';
            const calEv = typeof CalendarEvents !== 'undefined' ? CalendarEvents.on(date)[0] : null;
            const calName = calEv ? CalendarEvents.label(date) : '';
            cells.push(`
                <button type="button" class="td-day${pickDay === date && tab === 'day' ? ' td-day-on' : ''}${wk ? ' td-day-wk' : ''}" data-td-day="${esc(date)}" title="${esc(date)}${calName ? ' · ' + esc(calName) : ''}: ${deps.length} ${pluralRu(deps.length, 'вылет', 'вылета', 'вылетов')}${lf != null ? `, загрузка ${lf}%` : ''}${dec ? `, ждут решения: ${dec}` : ''}">
                    <span class="td-dow">${calEv ? `<span class="cal-dot cal-dot-${esc(calEv.type)}"></span>` : ''}${esc(i === 0 ? 'сегодня' : i === 1 ? 'завтра' : dow)}</span>
                    <span class="td-date">${esc(date.slice(0, 5))}</span>
                    <span class="td-bar"><i class="${cls}" style="width:${lf || 0}%"></i></span>
                    <span class="td-meta">${lf != null ? lf + '%' : '—'} · ${deps.length}</span>
                    ${dec ? `<span class="td-dec">${dec} ${pluralRu(dec, 'решение', 'решения', 'решений')}</span>` : '<span class="td-dec td-dec-none">&nbsp;</span>'}
                </button>`);
        }
        return `<div class="td-days">${cells.join('')}</div>`;
    }

    // ---------- таблица ----------

    const LABEL = { down: '▼ снизить', up: '▲ повысить', attn: '! внимание' };

    function loadCell(sold, seats) {
        const lf = seats ? Math.round(sold / seats * 100) : 0;
        return `<div class="td-lf"><span class="td-lf-bar"><i style="width:${Math.min(100, lf)}%"></i></span><span>${fmt(sold)}/${fmt(seats)}</span></div>`;
    }

    function rowHtml(item, extraCell) {
        const r = item.row || rowFor(item.code, item.date);
        const seats = r && typeof getSeatsOnSale === 'function' ? getSeatsOnSale(r) : 0;
        const sold = r && typeof getSoldFromRow === 'function' ? getSoldFromRow(r) : 0;
        const ac = r && typeof getAircraftType === 'function' ? getAircraftType(r[4]) : '';
        const dtd = daysUntil(item.date);
        const adv = item.adv !== undefined ? item.adv : (typeof SalesAdvice !== 'undefined' ? SalesAdvice.forDeparture(item.code, item.date, aheadDays(), 'today') : null);
        const ref = adv && adv.refs ? adv.refs.map(x => x.value).join(' / ') : '—';
        const on = selected && selected.code === item.code && selected.date === item.date;
        const fc = typeof FlightInsights !== 'undefined' ? FlightInsights.forecast(item.code, item.date) : null;
        const fcCls = fc && fc.source !== 'flown' ? (fc.soldOutDtd != null && fc.load < fc.seats ? ' td-fc-up' : (fc.lf < 60 ? ' td-fc-down' : '')) : '';
        const grp = typeof FlightInsights !== 'undefined' ? FlightInsights.groupSeats(item.code, item.date) : 0;
        return `
            <tr class="td-row${on ? ' td-row-on' : ''}" data-td-code="${esc(item.code)}" data-td-date="${esc(item.date)}">
                <td><strong>${esc(item.code)}</strong>${grp ? `<span class="grp-badge" title="В группах ${grp} чел.">Г ${grp}</span>` : ''}</td>
                <td>${esc(typeof getFlightDirection === 'function' ? getFlightDirection(item.code) : '')}<div class="td-muted">${esc(ac)}</div></td>
                <td class="td-nowrap">${esc(item.date.slice(0, 5))}<div class="td-muted">${dtd == null ? '' : dtd === 0 ? 'сегодня' : dtd + ' дн.'}</div></td>
                <td>${loadCell(sold, seats)}</td>
                <td class="td-nowrap${fcCls}" title="${esc(fc ? FlightInsights.forecastText(fc) : 'Мало истории для прогноза')}">${fc && fc.source !== 'flown' ? esc(FlightInsights.forecastShort(fc)) : '—'}</td>
                <td class="td-nowrap">${esc(ref)}</td>
                ${item.showMoney ? `<td class="td-nowrap td-money" title="${esc(typeof SalesAdvice !== 'undefined' ? SalesAdvice.moneyTitle(item.money) : '')}">${item.money ? fmt(item.money.rub) : '—'}</td>` : ''}
                <td>${extraCell != null ? extraCell : (adv && adv.status ? `<span class="td-pill td-pill-${adv.status}">${LABEL[adv.status]}</span>` : '<span class="td-pill">в норме</span>')}</td>
                <td class="td-go-cell">${openable(item.code, item.date) ? '<button type="button" class="td-go" data-td-go title="Открыть рейс в «Управлении продажами» (если он там есть) или в «Динамике продаж»">Открыть</button>' : ''}</td>
            </tr>`;
    }

    function depMinutes(row) {
        const t = typeof getDepTime === 'function' ? getDepTime(row) : (row && row[11]);
        return typeof timeToMinutes === 'function' && t ? timeToMinutes(t) : 9999;
    }

    function byDepTime(a, b) {
        return depMinutes(a.row) - depMinutes(b.row) || (parseInt(a.code.slice(3), 10) || 0) - (parseInt(b.code.slice(3), 10) || 0);
    }

    function openable(code, date) {
        return canTab('table') || (canTab('sales') && inSalesList(code, date));
    }

    function inSalesList(code, date) {
        return salesDepartures().has(code + '|' + date);
    }

    function openFlight(code, date) {
        if (canTab('sales') && inSalesList(code, date) && typeof openSalesManagementFor === 'function') {
            openSalesManagementFor(code, date);
            return;
        }
        if (!canTab('table')) return;
        if (typeof currentFlight !== 'undefined') currentFlight = getBaseFlight(code);
        if (typeof lastSelectedDate !== 'undefined') lastSelectedDate = date;
        switchMainTab('table');
        if (typeof FlightCard !== 'undefined') FlightCard.maybeOpen(code, date);
    }

    function tableHtml(pend, errs) {
        let rows = '';
        let empty = '';
        let head = '<th>Рейс</th><th>Маршрут</th><th>Вылет</th><th>Загрузка</th><th title="Прогноз загрузки к вылету (тот же, что в карточке и RMS); в скобках — пределы, в которые попадают 8 вылетов из 10">Прогноз</th><th>Обычно / план</th><th>Подсказка</th><th></th>';
        if (tab === 'advice') {
            const order = { down: 0, attn: 1, up: 2 };
            // Сверху то, где больше денег; без суммы (нет прогноза или тарифа) — в конце, по виду подсказки.
            const rub = (a) => (a.money ? a.money.rub : -1);
            const list = pend.slice().sort((a, b) => rub(b) - rub(a) || order[a.status] - order[b.status] || a.dtd - b.dtd);
            head = head.replace('<th>Подсказка</th>', '<th title="Сколько денег под вылетом. ▼ и !: пустые места по прогнозу × средний тариф. ▲: места, ещё доступные в продаже × последний тариф. Без прогноза или тарифа — «—»">Деньги, ₽</th><th>Подсказка</th>');
            rows = list.slice(0, 200).map(a => rowHtml({ code: a.code, date: a.date, adv: a, money: a.money || null, showMoney: true })).join('');
            empty = canTab('sales') ? (!adviceReady() ? 'Считаю подсказки по вылетам…' : `Все вылеты на ${aheadDays()} дн. в норме или уже отмечены сегодня.`) : 'Нет доступа к «Управлению продажами».';
        } else if (tab === 'errors') {
            head = '<th>Рейс</th><th>Маршрут</th><th>Вылет</th><th>Загрузка</th><th title="Прогноз загрузки к вылету (тот же, что в карточке и RMS); в скобках — пределы, в которые попадают 8 вылетов из 10">Прогноз</th><th>Обычно / план</th><th>Ошибка</th><th></th>';
            rows = errs.map(e => rowHtml({ code: e.code, date: e.date }, `<span class="td-err">${esc(e.items.map(i => i.title).join(', '))}</span>`)).join('');
            empty = 'Ошибок тарифов нет.';
        } else {
            const date = pickDay || today();
            rows = departuresOn(date).sort(byDepTime).map(d => rowHtml(d)).join('');
            empty = `На ${date} вылетов нет.`;
        }
        return `<div class="td-table-wrap">${rows ? `<table class="td-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>` : `<p class="td-empty">${esc(empty)}</p>`}</div>`;
    }

    function render() {
        const root = document.getElementById('td-page');
        if (!root) return;
        if (!hasData()) {
            root.innerHTML = `<div class="td-wrap"><div class="td-main"><div class="td-today-date">${esc(today())}</div>
                <p class="td-lead">Данных пока нет. Нажмите «Загрузить» или «Последние» вверху.</p></div></div>`;
            return;
        }
        const pend = pending();
        const errs = fareErrors();
        const gaps = typeof ReferenceView !== 'undefined' && ReferenceView.completenessCount ? ReferenceView.completenessCount() : 0;
        const k = kpis();
        const stale = typeof getStaleSalesInfo === 'function' ? getStaleSalesInfo() : null;
        const norm = normTile.sig === sig() ? normTile.data : null;
        const dec = decTile.data;
        const dt = parseLocalDate(today());
        const longDate = dt ? dt.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : today();
        const tabs = [
            canTab('sales') ? { id: 'advice', label: `Ждут решения · ${pend.length}` } : null,
            typeof FlightChecks !== 'undefined' && FlightChecks.enabled() ? { id: 'errors', label: `Ошибки тарифов · ${errs.length}` } : null,
            { id: 'day', label: `Вылеты ${pickDay && pickDay !== today() ? pickDay.slice(0, 5) : 'сегодня'} · ${departuresOn(pickDay || today()).length}` }
        ].filter(Boolean);
        if (!tabs.some(t => t.id === tab)) tab = tabs[0].id;
        root.innerHTML = `
            <div class="td-wrap">
                <section class="td-main">
                    <div class="td-today-date">Сегодня · ${esc(longDate)}</div>
                    <p class="td-lead">${esc(leadText(pend.length, errs.length, gaps))}${gaps ? ' <button type="button" class="td-link" data-td-gaps>Открыть справочник</button>' : ''}</p>
                    ${stale ? `<p class="td-stale">Решения по данным от ${esc(stale.label)} устарели: файл продаж не обновлялся ${stale.days} ${pluralRu(stale.days, 'день', 'дня', 'дней')}. Загрузите свежие данные.</p>` : ''}
                    <div class="td-stats${dec ? ' td-stats-4' : ''}">
                        <div class="td-stat"><span>Загрузка вылетов, 7 дней</span><b>${k.lf != null ? k.lf + '%' : '—'}</b><em>${fmt(k.sold)} из ${fmt(k.seats)} мест · ${fmt(k.n)} ${pluralRu(k.n, 'вылет', 'вылета', 'вылетов')}</em></div>
                        <div class="td-stat"><span>Продано сегодня</span>${stale ? `<b>—</b><em>нет свежих данных (от ${esc(stale.label)})</em>` : `<b>${fmt(k.todaySales)}</b><em>${fmt(Math.round(k.todayRevenue / 1000))} тыс. ₽</em>`}</div>
                        <div class="td-stat" title="Продано на вылеты ближайших 7 дней минус сколько обычно продавали к этому дню (по тем же рейсам и дням недели)"><span>К обычному</span>${norm ? `<b>${signed(norm.diff)} пасс.</b><em>по ${norm.n} из ${norm.total} вылетов, 7 дней</em>` : `<b>—</b><em>${normBuilding ? 'считаю…' : 'нет нормы'}</em>`}</div>
                        ${dec ? `<div class="td-stat" title="Итоги решений «снизить» и «повысить» за 30 дней, которые уже посчитаны и зафиксированы. Подробно: Отчёты → Решения"><span>Решения за 30 дн.</span><b>${signedRub(dec.sum)}</b><em>лучше ${dec.better}, хуже ${dec.worse} · итог есть у ${dec.ready} из ${dec.total}</em></div>` : ''}
                    </div>
                    ${dayStripHtml(pend)}
                    <div class="td-tabs" role="tablist">${tabs.map(t => `<button type="button" role="tab" class="td-tab${t.id === tab ? ' td-tab-on' : ''}" data-td-tab="${t.id}">${esc(t.label)}</button>`).join('')}
                        ${canTab('sales') ? `<label class="td-ahead" title="Сколько дней вперёд показывать в полосе дней">Вперёд на
                            <select data-td-ahead>${[...new Set(AHEAD_OPTIONS.concat(aheadDays()))].sort((x, y) => x - y).map(n => `<option value="${n}"${n === aheadDays() ? ' selected' : ''}>${n} дн.</option>`).join('')}</select></label>` : ''}</div>
                    ${tableHtml(pend, errs)}
                </section>
            </div>`;
    }

    function markSelectedRow() {
        document.querySelectorAll('#td-page .td-row').forEach(tr => {
            tr.classList.toggle('td-row-on', !!(selected && tr.dataset.tdCode === selected.code && tr.dataset.tdDate === selected.date));
        });
    }

    function onClick(e) {
        const t = e.target;
        const tb = t.closest('[data-td-tab]');
        if (tb) { tab = tb.dataset.tdTab; render(); return; }
        const day = t.closest('[data-td-day]');
        if (day) { pickDay = day.dataset.tdDay; tab = 'day'; render(); return; }
        if (t.closest('[data-td-gaps]')) {
            if (typeof ReportsView !== 'undefined') ReportsView.showSubtab('refs');
            if (typeof ReferenceView !== 'undefined') ReferenceView.openSection('check');
            switchMainTab('reports');
            return;
        }
        const row = t.closest('[data-td-code]');
        if (!row) return;
        selected = { code: row.dataset.tdCode, date: row.dataset.tdDate };
        markSelectedRow();
        if (t.closest('[data-td-go]')) { openFlight(selected.code, selected.date); return; }
        if (t.closest('button')) return;
        if (typeof FlightCard !== 'undefined' && FlightCard.isOpen && FlightCard.isOpen()) FlightCard.maybeOpen(selected.code, selected.date);
    }

    function create(panel) {
        panel.innerHTML = '<div class="td-page" id="td-page"></div>';
        const page = panel.querySelector('#td-page');
        page.addEventListener('click', onClick);
        page.addEventListener('change', (e) => {
            const sel = e.target.closest('[data-td-ahead]');
            if (!sel) return;
            setAheadDays(parseInt(sel.value, 10));
            tab = 'advice';
            selected = null;
            render();
            buildAdvice().then(() => { render(); return buildNorm(); }).then(render).catch(err => console.warn('TodayView', err));
        });
        render();
        buildAdvice().then(() => { render(); return buildNorm(); }).then(render).catch(e => console.warn('TodayView', e));
        buildDecisions();
    }

    function refresh() {
        if (!document.getElementById('td-page')) return;
        render();
        if (adviceSig !== sig()) buildAdvice().then(() => { render(); return buildNorm(); }).then(render).catch(() => {});
        else if (normTile.sig !== sig()) buildNorm().then(render).catch(() => {});
        buildDecisions();
    }

    // Отметка поставлена — счётчики и подсказки на странице обновляются.
    document.addEventListener('krasavia:mark', () => {
        if (typeof currentTab !== 'undefined' && currentTab === 'today') render();
    });

    return { create, refresh };
})();

function createTodayView(panel) {
    TodayView.create(panel);
}
