// «Сегодня» — стартовая страница: главное за день одним экраном.
//  • строка-вывод: сколько ждёт решения, ошибок тарифов, пропусков справочника;
//  • три ключевые цифры: загрузка вылетов на 7 дней, продано сегодня, вылетов на 7 дней;
//  • полоса дней (14 дней): загрузка и число решений по каждому дню; клик — вылеты этого дня;
//  • таблица: «Ждут решения» / «Ошибки тарифов» / «Вылеты дня»;
//  • справа — выбранный рейс: цифры, вывод, график продаж против нормы и плана, отметка за сегодня.
// Считает лениво и только при открытии страницы; подсказки — те же, что в УП и сводке (SalesAdvice).
window.TodayView = (function () {
    const DAYS = 14;
    let tab = 'advice';         // advice | errors | day
    let pickDay = '';           // выбранный день полосы (ДД.ММ.ГГГГ)
    let selected = null;        // { code, date }
    let advice = [];
    let adviceSig = '';
    let building = null;

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
        return [typeof dataEpoch === 'number' ? dataEpoch : 0, today(), typeof allData !== 'undefined' && allData ? allData.length : 0].join('|');
    }

    async function buildAdvice() {
        if (!canTab('sales') || typeof SalesAdvice === 'undefined') { advice = []; return; }
        const s = sig();
        if (adviceSig === s) return;
        if (building) return building;
        building = (async () => {
            advice = await SalesAdvice.scanAll(salesDepartures());
            adviceSig = s;
        })().finally(() => { building = null; });
        return building;
    }

    function pending() {
        const t = today();
        const inSales = salesDepartures();
        return advice.filter(a => inSales.has(a.code + '|' + a.date)
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
        if (canTab('sales')) parts.push(p ? `${p} вылет(ов) ждут решения` : 'все вылеты на 20 дней в норме или уже отмечены');
        if (typeof FlightChecks !== 'undefined' && FlightChecks.enabled()) parts.push(errs ? `${errs} рейс(ов) с ошибкой тарифа` : 'ошибок тарифов нет');
        if (gaps) parts.push(`в справочнике ${gaps} пропуск(ов)`);
        return parts.length ? parts.join(', ') + '.' : '';
    }

    // ---------- полоса дней ----------

    function dayStripHtml(pend) {
        const byDay = new Map();
        pend.forEach(a => byDay.set(a.date, (byDay.get(a.date) || 0) + 1));
        const cells = [];
        for (let i = 0; i < DAYS; i++) {
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
            cells.push(`
                <button type="button" class="td-day${pickDay === date && tab === 'day' ? ' td-day-on' : ''}${wk ? ' td-day-wk' : ''}" data-td-day="${esc(date)}" title="${esc(date)}: ${deps.length} вылет(ов)${lf != null ? `, загрузка ${lf}%` : ''}${dec ? `, ждут решения: ${dec}` : ''}">
                    <span class="td-dow">${esc(i === 0 ? 'сегодня' : i === 1 ? 'завтра' : dow)}</span>
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
        const adv = item.adv !== undefined ? item.adv : (typeof SalesAdvice !== 'undefined' ? SalesAdvice.forDeparture(item.code, item.date) : null);
        const ref = adv && adv.refs ? adv.refs.map(x => x.value).join(' / ') : '—';
        const on = selected && selected.code === item.code && selected.date === item.date;
        return `
            <tr class="td-row${on ? ' td-row-on' : ''}" data-td-code="${esc(item.code)}" data-td-date="${esc(item.date)}">
                <td><strong>${esc(item.code)}</strong></td>
                <td>${esc(typeof getFlightDirection === 'function' ? getFlightDirection(item.code) : '')}<div class="td-muted">${esc(ac)}</div></td>
                <td class="td-nowrap">${esc(item.date.slice(0, 5))}<div class="td-muted">${dtd == null ? '' : dtd === 0 ? 'сегодня' : dtd + ' дн.'}</div></td>
                <td>${loadCell(sold, seats)}</td>
                <td class="td-nowrap">${esc(ref)}</td>
                <td>${extraCell != null ? extraCell : (adv && adv.status ? `<span class="td-pill td-pill-${adv.status}">${LABEL[adv.status]}</span>` : '<span class="td-pill">в норме</span>')}</td>
            </tr>`;
    }

    function tableHtml(pend, errs) {
        let rows = '';
        let empty = '';
        let head = '<th>Рейс</th><th>Маршрут</th><th>Вылет</th><th>Загрузка</th><th>Обычно / план</th><th>Подсказка</th>';
        if (tab === 'advice') {
            const order = { down: 0, attn: 1, up: 2 };
            const list = pend.slice().sort((a, b) => order[a.status] - order[b.status] || a.dtd - b.dtd);
            rows = list.slice(0, 200).map(a => rowHtml({ code: a.code, date: a.date, adv: a })).join('');
            empty = canTab('sales') ? 'Все вылеты на 20 дней в норме или уже отмечены сегодня.' : 'Нет доступа к «Управлению продажами».';
        } else if (tab === 'errors') {
            head = '<th>Рейс</th><th>Маршрут</th><th>Вылет</th><th>Загрузка</th><th>Обычно / план</th><th>Ошибка</th>';
            rows = errs.map(e => rowHtml({ code: e.code, date: e.date }, `<span class="td-err">${esc(e.items.map(i => i.title).join(', '))}</span>`)).join('');
            empty = 'Ошибок тарифов нет.';
        } else {
            const date = pickDay || today();
            rows = departuresOn(date).map(d => rowHtml(d)).join('');
            empty = `На ${date} вылетов нет.`;
        }
        return `<div class="td-table-wrap">${rows ? `<table class="td-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>` : `<p class="td-empty">${esc(empty)}</p>`}</div>`;
    }

    // ---------- справа: выбранный рейс ----------

    // График без библиотек: продано (сплошная), норма (серая), план (пунктир), в одной шкале.
    function chartSvg(series) {
        const W = 320;
        const H = 150;
        const lines = [series.thisData, series.refData, series.expectedData].filter(Boolean);
        const max = Math.max(1, ...lines.flat().filter(v => v != null));
        const n = series.dtds.length;
        const x = (i) => (n <= 1 ? 0 : (i / (n - 1)) * (W - 8) + 4);
        const y = (v) => H - 6 - (v / max) * (H - 16);
        const path = (vals) => {
            let d = '';
            vals.forEach((v, i) => { if (v == null) return; d += (d ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); });
            return d;
        };
        const sold = path(series.thisData);
        return `<svg class="td-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Продажи против нормы и плана">
            ${[0.25, 0.5, 0.75].map(f => `<line x1="0" x2="${W}" y1="${(H - 6 - f * (H - 16)).toFixed(1)}" y2="${(H - 6 - f * (H - 16)).toFixed(1)}" class="td-grid"/>`).join('')}
            ${sold ? `<path d="${sold} L${x(n - 1).toFixed(1)} ${H - 6} L${x(0).toFixed(1)} ${H - 6} Z" class="td-area"/>` : ''}
            ${series.refData ? `<path d="${path(series.refData)}" class="td-line-ref"/>` : ''}
            ${series.expectedData ? `<path d="${path(series.expectedData)}" class="td-line-exp"/>` : ''}
            ${sold ? `<path d="${sold}" class="td-line-sold"/>` : ''}
        </svg>
        <div class="td-legend"><span class="td-lg-sold">продано</span>${series.refData ? `<span class="td-lg-ref">${esc(series.refLabel || 'норма')}</span>` : ''}${series.expectedData ? '<span class="td-lg-exp">план</span>' : ''}<span class="td-muted">${series.dtds.length ? `за ${series.dtds[0]} дн. до вылета → сегодня` : ''}</span></div>`;
    }

    function inspectorHtml() {
        if (!selected) {
            return `<div class="td-insp-empty"><div class="td-insp-ico">✈</div><p>Выберите рейс в таблице — здесь будут его продажи, вывод и отметка на сегодня.</p></div>`;
        }
        const { code, date } = selected;
        const r = rowFor(code, date);
        if (!r) return '<p class="td-empty">Нет данных по этому вылету.</p>';
        const base = getBaseFlight(code);
        const seats = getSeatsOnSale(r);
        const sold = getSoldFromRow(r);
        const ac = typeof getAircraftType === 'function' ? getAircraftType(r[4]) : '';
        const dtd = daysUntil(date);
        const list = typeof getFlightSalesList === 'function' ? getFlightSalesList(date, code) : [];
        const paid = list.filter(s => Number(s.fare) > 0);
        const avg = paid.length ? paid.reduce((s, x) => s + Number(x.fare), 0) / paid.length : null;
        let series = null;
        try { series = buildFlightDtdBookingSeries(base, date, code, 30, r[4]); } catch (e) { series = null; }
        const refVal = series && series.refData ? series.refData[series.refData.length - 1] : null;
        const expVal = series && series.expectedData ? series.expectedData[series.expectedData.length - 1] : null;
        const adv = typeof SalesAdvice !== 'undefined' ? SalesAdvice.forDeparture(code, date) : null;
        const modeKey = typeof FlightChecks !== 'undefined' && FlightChecks.modeFor ? FlightChecks.modeFor(code, date, r) : null;
        const mode = modeKey === 'subsidy' ? { label: 'субсидия' } : modeKey === 'commercial' ? { label: 'коммерция' } : null;
        const advText = adv && adv.status
            ? `<div class="td-say td-say-${adv.status}">${esc(adv.text)}. Подсказка: <strong>${esc(LABEL[adv.status])}</strong>.</div>` : '';
        const links = [
            canTab('table') ? '<button type="button" class="td-link" data-td-open="table">Динамика продаж</button>' : '',
            canTab('pair') ? '<button type="button" class="td-link" data-td-open="pair">Экономика</button>' : '',
            canTab('pkz') ? '<button type="button" class="td-link" data-td-open="pkz">ПКЗ</button>' : '',
            canTab('sales') ? '<button type="button" class="td-link" data-td-open="sales">В УП</button>' : ''
        ].join('');
        return `
            <div class="td-crumb">Выбранный рейс</div>
            <h2 class="td-insp-title">${esc(code)} · ${esc(date)}</h2>
            <div class="td-insp-sub">${esc(getFlightDirection(code))} · ${esc(ac)} · ${dtd == null ? '' : dtd === 0 ? 'сегодня' : dtd < 0 ? 'улетел' : 'через ' + dtd + ' дн.'}${mode && mode.label ? ' · ' + esc(mode.label) : ''}</div>
            <div class="td-kv">
                <div><span>Продано</span><b>${fmt(sold)} из ${fmt(seats)}</b></div>
                <div><span>Средний тариф</span><b>${avg != null ? fmt(avg) + ' ₽' : '—'}</b></div>
                <div><span>Обычно к этому дню</span><b class="${refVal != null && sold < refVal ? 'td-neg' : ''}">${refVal != null ? fmt(refVal) : '—'}</b></div>
                <div><span>По плану</span><b class="${expVal != null && sold < expVal ? 'td-neg' : ''}">${expVal != null ? fmt(expVal) : '—'}</b></div>
            </div>
            ${series ? chartSvg(series) : ''}
            ${advText}
            ${typeof PriceMarks !== 'undefined' ? `<div class="td-marks">${PriceMarks.buttonsHtml(code, date)}</div>` : ''}
            <div class="td-links">${links}</div>`;
    }

    // ---------- сборка ----------

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
        if (!selected && tab === 'advice' && pend.length) {
            const order = { down: 0, attn: 1, up: 2 };
            const first = pend.slice().sort((a, b) => order[a.status] - order[b.status] || a.dtd - b.dtd)[0];
            selected = { code: first.code, date: first.date };
        }
        const dt = parseLocalDate(today());
        const longDate = dt ? dt.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : today();
        const tabs = [
            canTab('sales') ? { id: 'advice', label: `Ждут решения · ${pend.length}` } : null,
            typeof FlightChecks !== 'undefined' && FlightChecks.enabled() ? { id: 'errors', label: `Ошибки тарифов · ${errs.length}` } : null,
            { id: 'day', label: `Вылеты ${pickDay && pickDay !== today() ? pickDay.slice(0, 5) : 'сегодня'}` }
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
                    <div class="td-tabs" role="tablist">${tabs.map(t => `<button type="button" role="tab" class="td-tab${t.id === tab ? ' td-tab-on' : ''}" data-td-tab="${t.id}">${esc(t.label)}</button>`).join('')}</div>
                    ${tableHtml(pend, errs)}
                </section>
                <aside class="td-insp" id="td-insp">${inspectorHtml()}</aside>
            </div>`;
    }

    function renderInspector() {
        const box = document.getElementById('td-insp');
        if (box) box.innerHTML = inspectorHtml();
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
        const op = t.closest('[data-td-open]');
        if (op && selected) {
            const to = op.dataset.tdOpen;
            if (to === 'sales' && typeof openSalesManagementFor === 'function') { openSalesManagementFor(selected.code, selected.date); return; }
            if (typeof currentFlight !== 'undefined') currentFlight = getBaseFlight(selected.code);
            if (typeof lastSelectedDate !== 'undefined') lastSelectedDate = selected.date;
            switchMainTab(to);
            return;
        }
        const row = t.closest('[data-td-code]');
        if (row && !t.closest('button')) {
            selected = { code: row.dataset.tdCode, date: row.dataset.tdDate };
            renderInspector();
            if (typeof FlightCard !== 'undefined' && FlightCard.isOpen && FlightCard.isOpen()) FlightCard.maybeOpen(selected.code, selected.date);
        }
    }

    function create(panel) {
        panel.innerHTML = '<div class="td-page" id="td-page"></div>';
        panel.querySelector('#td-page').addEventListener('click', onClick);
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
