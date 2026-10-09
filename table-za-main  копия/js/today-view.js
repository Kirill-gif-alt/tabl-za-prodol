// «Сегодня» — стартовая страница: главное за день одним экраном.
//  • строка-вывод: сколько ждёт решения, ошибок тарифов, пропусков справочника;
//  • три ключевые цифры: загрузка вылетов на 7 дней, продано сегодня, вылетов на 7 дней;
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

    function fmt(n) {
        return Math.round(Number(n) || 0).toLocaleString('ru-RU');
    }

    // Все вылеты (по строкам «загрузки таб») на дату.
    function departuresOn(date) {
        const out = [];
        const seen = new Set();
        Object.keys(groupedData || {}).forEach(base => {
            (groupedData[base] || []).forEach(r => {
                if (!r || r[1] !== date) return;
                const code = cleanFlight(r[0]);
                if (seen.has(code)) return;
                seen.add(code);
                const seats = typeof getSeatsOnSale === 'function' ? getSeatsOnSale(r) : 0;
                const sold = typeof getSoldFromRow === 'function' ? getSoldFromRow(r) : 0;
                out.push({ code, base, date, row: r, seats, sold });
            });
        });
        return out.sort((a, b) => String(a.row[11] || '').localeCompare(String(b.row[11] || '')) || (parseInt(a.code.slice(3), 10) - parseInt(b.code.slice(3), 10)));
    }

    function salesDepartures() {
        const set = new Set();
        if (typeof SalesManagement === 'undefined' || !SalesManagement.listFlights) return set;
        try { SalesManagement.listFlights().forEach(f => (f.departures || []).forEach(d => set.add(d.code + '|' + d.date))); } catch (e) { /* ignore */ }
        return set;
    }

    function sig() {
        return [typeof dataEpoch === 'number' ? dataEpoch : 0, today(), typeof allData !== 'undefined' && allData ? allData.length : 0, aheadDays()].join('|');
    }

    async function buildAdvice() {
        if (!canTab('sales') || typeof SalesAdvice === 'undefined') { advice = []; return; }
        const s = sig();
        if (adviceSig === s) return;
        // Идёт расчёт для другого окна дней — дождаться и пересчитать под нынешний выбор.
        if (building) return building.then(() => buildAdvice());
        building = (async () => {
            advice = await SalesAdvice.scanAll(salesDepartures(), null, aheadDays());
            adviceSig = s;
        })().finally(() => { building = null; });
        return building;
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
        if (canTab('sales')) parts.push(p ? `${p} вылет(ов) ждут решения` : `все вылеты на ${aheadDays()} дн. в норме или уже отмечены`);
        if (typeof FlightChecks !== 'undefined' && FlightChecks.enabled()) parts.push(errs ? `${errs} рейс(ов) с ошибкой тарифа` : 'ошибок тарифов нет');
        if (gaps) parts.push(`в справочнике ${gaps} пропуск(ов)`);
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
                <button type="button" class="td-day${pickDay === date && tab === 'day' ? ' td-day-on' : ''}${wk ? ' td-day-wk' : ''}" data-td-day="${esc(date)}" title="${esc(date)}${calName ? ' · ' + esc(calName) : ''}: ${deps.length} вылет(ов)${lf != null ? `, загрузка ${lf}%` : ''}${dec ? `, ждут решения: ${dec}` : ''}">
                    <span class="td-dow">${calEv ? `<span class="cal-dot cal-dot-${esc(calEv.type)}"></span>` : ''}${esc(i === 0 ? 'сегодня' : i === 1 ? 'завтра' : dow)}</span>
                    <span class="td-date">${esc(date.slice(0, 5))}</span>
                    <span class="td-bar"><i class="${cls}" style="width:${lf || 0}%"></i></span>
                    <span class="td-meta">${lf != null ? lf + '%' : '—'} · ${deps.length}</span>
                    ${dec ? `<span class="td-dec">${dec} реш.</span>` : '<span class="td-dec td-dec-none">&nbsp;</span>'}
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
        const adv = item.adv !== undefined ? item.adv : (typeof SalesAdvice !== 'undefined' ? SalesAdvice.forDeparture(item.code, item.date, aheadDays()) : null);
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
        let head = '<th>Рейс</th><th>Маршрут</th><th>Вылет</th><th>Загрузка</th><th title="Прогноз загрузки к вылету; в скобках — разброс">Прогноз</th><th>Обычно / план</th><th>Подсказка</th><th></th>';
        if (tab === 'advice') {
            const order = { down: 0, attn: 1, up: 2 };
            const list = pend.slice().sort((a, b) => order[a.status] - order[b.status] || a.dtd - b.dtd);
            rows = list.slice(0, 200).map(a => rowHtml({ code: a.code, date: a.date, adv: a })).join('');
            empty = canTab('sales') ? `Все вылеты на ${aheadDays()} дн. в норме или уже отмечены сегодня.` : 'Нет доступа к «Управлению продажами».';
        } else if (tab === 'errors') {
            head = '<th>Рейс</th><th>Маршрут</th><th>Вылет</th><th>Загрузка</th><th title="Прогноз загрузки к вылету; в скобках — разброс">Прогноз</th><th>Обычно / план</th><th>Ошибка</th><th></th>';
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
                    <div class="td-stats">
                        <div class="td-stat"><span>Загрузка вылетов, 7 дней</span><b>${k.lf != null ? k.lf + '%' : '—'}</b><em>${fmt(k.sold)} из ${fmt(k.seats)} мест</em></div>
                        <div class="td-stat"><span>Продано сегодня</span><b>${fmt(k.todaySales)}</b><em>${fmt(Math.round(k.todayRevenue / 1000))} тыс. ₽</em></div>
                        <div class="td-stat"><span>Вылетов за 7 дней</span><b>${fmt(k.n)}</b><em>${esc(shift(today(), 0).slice(0, 5))} – ${esc(shift(today(), 6).slice(0, 5))}</em></div>
                    </div>
                    ${dayStripHtml(pend)}
                    <div class="td-tabs" role="tablist">${tabs.map(t => `<button type="button" role="tab" class="td-tab${t.id === tab ? ' td-tab-on' : ''}" data-td-tab="${t.id}">${esc(t.label)}</button>`).join('')}
                        ${canTab('sales') ? `<label class="td-ahead" title="За сколько дней вперёд искать вылеты, где стоит повысить или снизить тариф">Вперёд на
                            <select data-td-ahead>${AHEAD_OPTIONS.map(n => `<option value="${n}"${n === aheadDays() ? ' selected' : ''}>${n} дн.</option>`).join('')}</select></label>` : ''}</div>
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
            buildAdvice().then(render).catch(err => console.warn('TodayView', err));
        });
        render();
        buildAdvice().then(render).catch(e => console.warn('TodayView', e));
    }

    function refresh() {
        if (!document.getElementById('td-page')) return;
        render();
        if (adviceSig !== sig()) buildAdvice().then(render).catch(() => {});
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
