// «Сегодня» — стартовая страница: главное за день одним экраном.
//  • заголовок с загрузкой вылетов на 7 дней, одна плашка про старые данные (с кнопкой «Загрузить свежие данные»);
//  • четыре крупные плитки: ждут отметки / можно повысить цену / стоит снизить цену / ошибки в тарифах —
//    клик по плитке отбирает строки таблицы; ниже строка поменьше: продано сегодня, к обычному, решения за 30 дней;
//  • полоса дней (сегодня и столько дней вперёд, сколько выбрано в «Вперёд на»): число вылетов к отметке; клик — вылеты этого дня;
//  • таблица: «Ждут отметки» / «Ошибки тарифов» / «Вылеты дня»; сортировка; клик по строке — карточка рейса
//    (если она показана кнопкой ▤), двойной клик — подробности под строкой, «Открыть» — рейс в «Управлении продажами» или «Динамике продаж».
// Считает лениво и только при открытии страницы; подсказки — те же, что в УП и сводке (SalesAdvice).
window.TodayView = (function () {
    let tab = 'advice';         // advice | errors | day
    let filter = 'all';         // отбор «Ждут отметки» плиткой: all | up | down
    let detailKey = '';         // рейс|дата, у которого открыты подробности (двойной клик)
    let pickDay = '';           // выбранный день полосы (ДД.ММ.ГГГГ)
    let selected = null;        // { code, date }
    let advice = [];
    let adviceSig = '';
    let building = null;
    // «К обычному»: на сколько пассажиров вылеты ближайших 7 дней выше или ниже нормы «к этому дню».
    let normTile = { sig: '', data: null };
    let normBuilding = null;    // идущий расчёт (обещание) или null
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

    // «Сначала»: самые денежные | самые срочные | по дате. Запоминается на профиль.
    const SORT_OPTIONS = [['money', 'самые денежные'], ['urgent', 'самые срочные'], ['date', 'по дате']];
    const SORT_KEY = 'krasavia_today_sort_';
    function sortBy() {
        let v = '';
        try { v = localStorage.getItem(aheadKey().replace(AHEAD_KEY, SORT_KEY)) || ''; } catch (e) { /* ignore */ }
        return SORT_OPTIONS.some(o => o[0] === v) ? v : 'money';
    }
    function setSortBy(v) {
        try { localStorage.setItem(aheadKey().replace(AHEAD_KEY, SORT_KEY), v); } catch (e) { /* ignore */ }
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

    // Хоть раз посчитано: цифры в плитках и полосе дней показываем сразу, не мигая «…» при пересчёте.
    function adviceBuilt() {
        return typeof SalesAdvice === 'undefined' || adviceSig !== '';
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
    // Данные могли смениться, пока шёл расчёт: тогда считаем ещё раз под новую подпись (иначе плитка застревала на «считаю…»).
    function buildNorm() {
        if (typeof SalesAdvice === 'undefined' || !hasData()) return Promise.resolve();
        if (normBuilding) return normBuilding;
        if (normTile.sig === sig()) return Promise.resolve();
        normBuilding = (async () => {
            for (let pass = 0; pass < 3; pass++) {
                const s = sig();
                if (normTile.sig === s) break;
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
            }
        })().finally(() => { normBuilding = null; });
        return normBuilding;
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
                sum += (e.delta || 0) + (e.corr || 0);      // как «Общий итог» в Отчётах → Решения: с поправкой на шум и сдвиг
                if (pos.includes(e.verdict)) better++;
                else if (neg.includes(e.verdict)) worse++;
            });
            decTile = { sig: s, loading: false, data: ready ? { better, worse, sum, ready, total: list.length } : null };
            if (typeof currentTab !== 'undefined' && currentTab === 'today') render();
            if (decSig() !== s) buildDecisions();      // отметки или итоги сменились, пока считали — пересчитать
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
        // Файл продаж не загружен — «0 продано» было бы неправдой (в шапке и в RMS там «—»).
        const salesReady = typeof hasSalesFileLoaded === 'function' ? hasSalesFileLoaded() : true;
        return { lf: seats ? Math.round(sold / seats * 100) : null, sold, seats, n, salesReady, todaySales: Number(k.todaySales) || 0, todayRevenue: Number(k.todayRevenue) || 0, todayOutside: Number(k.todayOutside) || 0 };
    }

    // Подсказки на этой странице выключены в «Параметрах расчётов» — «в норме» писать нельзя: ничего не проверялось.
    function hintsOn() {
        return typeof SalesAdvice === 'undefined' || typeof PV === 'undefined' || PV.HINT_TODAY === 1;
    }

    // ---------- полоса дней ----------

    function dayStripHtml(pend) {
        const byDay = new Map();
        pend.forEach(a => byDay.set(a.date, (byDay.get(a.date) || 0) + 1));
        const cells = [];
        const days = aheadDays() + 1;
        // Число «к отметке» — только если подсказки посчитаны и доступны; иначе число вылетов дня.
        const marks = canTab('sales') && hintsOn();
        const ready = adviceBuilt();
        for (let i = 0; i < days; i++) {
            const date = shift(today(), i);
            const deps = departuresOn(date);
            let sold = 0;
            let seats = 0;
            deps.forEach(d => { sold += d.sold; seats += d.seats; });
            const lf = seats ? Math.round(sold / seats * 100) : null;
            const dt = parseLocalDate(date);
            const dow = dt && typeof DAYS_RU !== 'undefined' ? DAYS_RU[dt.getDay()] : '';
            const wk = dt && (dt.getDay() === 0 || dt.getDay() === 6);
            const dec = byDay.get(date) || 0;
            const cls = lf == null ? '' : lf >= 85 ? 'td-hi' : lf >= 60 ? 'td-mid' : lf >= 40 ? 'td-low' : 'td-bad';
            const calEv = typeof CalendarEvents !== 'undefined' ? CalendarEvents.on(date)[0] : null;
            const calName = calEv ? CalendarEvents.label(date) : '';
            const level = !marks || !ready ? '' : dec >= 4 ? ' td-day-hi' : dec ? ' td-day-lo' : ' td-day-zero';
            const num = marks ? (ready ? dec : '…') : deps.length;
            const cap = marks ? 'к отметке' : pluralRu(deps.length, 'вылет', 'вылета', 'вылетов');
            cells.push(`
                <button type="button" class="td-day${level}${i === 0 ? ' td-day-today' : ''}${pickDay === date && tab === 'day' ? ' td-day-on' : ''}${wk ? ' td-day-wk' : ''}" data-td-day="${esc(date)}" title="${esc(date)}${calName ? ' · ' + esc(calName) : ''}: ${deps.length} ${pluralRu(deps.length, 'вылет', 'вылета', 'вылетов')}${lf != null ? `, загрузка ${lf}%` : ''}${dec ? `, ждут отметки: ${dec}` : ''}">
                    <span class="td-dow">${calEv ? `<span class="cal-dot cal-dot-${esc(calEv.type)}"></span>` : ''}${esc(i === 0 ? 'сегодня' : i === 1 ? 'завтра' : dow)}</span>
                    <span class="td-date">${esc(date.slice(0, 5))}</span>
                    <span class="td-num">${num}</span>
                    <span class="td-cap">${esc(cap)}</span>
                    <span class="td-bar"><i class="${cls}" style="width:${lf || 0}%"></i></span>
                </button>`);
        }
        return `<div class="td-days-card">
            <div class="td-days-head"><b>Ближайшие ${days} ${pluralRu(days, 'день', 'дня', 'дней')}${marks ? ' — сколько рейсов ждут отметки' : ''}</b><span class="td-muted">нажмите на день — покажу только его вылеты</span></div>
            <div class="td-days">${cells.join('')}</div></div>`;
    }

    // ---------- таблица ----------

    const LABEL = { down: '▼ Снизить цену', up: '▲ Повысить цену', attn: '● Внимание' };

    function lfCls(lf) {
        return lf >= 60 ? 'td-lf-hi' : lf >= 30 ? 'td-lf-mid' : 'td-lf-lo';
    }

    function loadCell(sold, seats) {
        const lf = seats ? Math.round(sold / seats * 100) : 0;
        return `<div class="td-sold"><span class="td-sold-n"><b>${fmt(sold)}</b> из ${fmt(seats)}</span><span class="td-lf-bar" title="Занято ${lf}%"><i class="${lfCls(lf)}" style="width:${Math.min(100, lf)}%"></i></span></div>`;
    }

    function diffHtml(d) {
        const v = Math.round(Number(d) || 0);
        return `<span class="${v > 0 ? 'td-pos' : v < 0 ? 'td-neg' : 'td-muted'}">${signed(v)}</span>`;
    }

    function inDaysText(dtd) {
        return dtd == null ? '' : dtd < 0 ? 'вылетел' : dtd === 0 ? 'сегодня' : dtd === 1 ? 'завтра' : `через ${dtd} ${pluralRu(dtd, 'день', 'дня', 'дней')}`;
    }

    function pillHtml(adv) {
        if (adv && adv.status) return `<span class="td-pill td-pill-${adv.status}" title="${esc(adv.text || '')}">${LABEL[adv.status]}</span>`;
        if (adv) return '<span class="td-pill">В норме</span>';
        return `<span class="td-muted" title="${esc(hintsOn() ? 'Подсказки нет: вылет сегодня или вне окна, рейс закрыт, либо нет нормы и плана' : 'Подсказки выключены в «Параметрах расчётов»')}">—</span>`;
    }

    function rowHtml(item, extraCell) {
        const r = item.row || rowFor(item.code, item.date);
        const seats = r && typeof getSeatsOnSale === 'function' ? getSeatsOnSale(r) : 0;
        const sold = r && typeof getSoldFromRow === 'function' ? getSoldFromRow(r) : 0;
        const ac = r && typeof getAircraftType === 'function' ? getAircraftType(r[4]) : '';
        const dtd = daysUntil(item.date);
        const adv = item.adv !== undefined ? item.adv : (typeof SalesAdvice !== 'undefined' ? SalesAdvice.forDeparture(item.code, item.date, aheadDays(), 'today') : null);
        // «К этой дате обычно»: если есть только план, одно число не должно читаться как «обычно».
        const refUsual = adv && adv.refs ? adv.refs.find(x => x.label.indexOf('обычно') === 0) : null;
        const refPlan = adv && adv.refs ? adv.refs.find(x => x.label.indexOf('по плану') === 0) : null;
        let refCell = '—';
        if (refUsual) {
            refCell = `<span class="td-usual-n">${fmt(refUsual.value)}</span> ${diffHtml(refUsual.d)}${refPlan ? `<div class="td-muted">по плану ${fmt(refPlan.value)} ${diffHtml(refPlan.d)}</div>` : ''}`;
        } else if (refPlan) {
            refCell = `<span class="td-usual-n">${fmt(refPlan.value)}</span> ${diffHtml(refPlan.d)}<div class="td-muted">по плану</div>`;
        }
        const on = selected && selected.code === item.code && selected.date === item.date;
        const fc = typeof FlightInsights !== 'undefined' ? FlightInsights.forecast(item.code, item.date) : null;
        const fcOk = fc && fc.source !== 'flown';
        const fcCls = fcOk ? (fc.soldOutDtd != null && fc.load < fc.seats ? ' td-fc-up' : (fc.lf < 60 ? ' td-fc-down' : '')) : '';
        const fcRange = fcOk && fc.lo != null && fc.hi != null && fc.lo !== fc.hi ? ` <span class="td-muted">от ${fmt(fc.lo)} до ${fmt(fc.hi)}</span>` : '';
        const grp = typeof FlightInsights !== 'undefined' ? FlightInsights.groupSeats(item.code, item.date) : 0;
        const key = item.code + '|' + item.date;
        return `
            <tr class="td-row${on ? ' td-row-on' : ''}" data-td-code="${esc(item.code)}" data-td-date="${esc(item.date)}">
                <td class="td-code"><strong>${esc(item.code)}</strong>${grp ? `<span class="grp-badge" title="В группах ${grp} чел.">Г ${grp}</span>` : ''}</td>
                <td>${esc(typeof getFlightDirection === 'function' ? getFlightDirection(item.code) : '')}<div class="td-muted">${esc(ac)}</div></td>
                <td class="td-nowrap">${esc(item.date.slice(0, 5))}<div class="td-muted">${esc(inDaysText(dtd))}</div></td>
                <td>${loadCell(sold, seats)}</td>
                <td class="td-nowrap" title="${esc(fc ? FlightInsights.forecastText(fc) : 'Мало истории для прогноза')}">${fcOk ? `<b class="td-fc-n${fcCls}">${fmt(fc.final)}</b>${fcRange}` : '—'}</td>
                <td class="td-nowrap" title="Сколько пассажиров обычно продают к этому дню; цветом — насколько нынешние продажи выше или ниже">${refCell}</td>
                ${item.showMoney ? `<td class="td-nowrap td-money" title="${esc(typeof SalesAdvice !== 'undefined' ? SalesAdvice.moneyTitle(item.money) : '')}">${item.money ? fmt(item.money.rub) : '—'}</td>` : ''}
                <td>${extraCell != null ? extraCell : pillHtml(adv)}</td>
                <td class="td-go-cell">${openable(item.code, item.date) ? '<button type="button" class="td-go" data-td-go title="Открыть рейс в «Управлении продажами» (если он там есть) или в «Динамике продаж»">Открыть</button>' : ''}</td>
            </tr>${detailKey === key ? detailRowHtml(item.code, item.date, item.showMoney ? 9 : 8) : ''}`;
    }

    // Подробности под строкой (двойной клик): то, что раньше пряталось в подсказках. Считается только по запросу, из готовых кэшей.
    function detailRowHtml(code, date, cols) {
        const lines = [];
        const adv = typeof SalesAdvice !== 'undefined' ? SalesAdvice.forDeparture(code, date, aheadDays(), 'today') : null;
        if (adv) {
            lines.push(['Подсказка', adv.text]);
            lines.push(['Порог', `подсказка появляется, когда продажи отличаются от обычного или плана не меньше чем на ${adv.threshold} ${pluralRu(adv.threshold, 'пассажира', 'пассажира', 'пассажиров')}`]);
            if (adv.money) lines.push(['Деньги под вылетом', SalesAdvice.moneyTitle(adv.money)]);
        }
        const fc = typeof FlightInsights !== 'undefined' ? FlightInsights.forecast(code, date) : null;
        if (fc && fc.source !== 'flown') lines.push(['Прогноз', FlightInsights.forecastText(fc)]);
        const grp = typeof FlightInsights !== 'undefined' ? FlightInsights.groupSeats(code, date) : 0;
        if (grp) lines.push(['Группы', `в группах ${grp} чел.`]);
        if (typeof FlightChecks !== 'undefined' && FlightChecks.enabled()) {
            FlightChecks.list().filter(i => i.code === code && i.date === date && i.state !== 'Улетел')
                .forEach(i => lines.push(['Ошибка тарифа', `${i.title}: ${i.detail}`]));
        }
        if (!lines.length) lines.push(['', 'Подробностей нет: по этому вылету мало данных.']);
        return `<tr class="td-detail" data-td-detail="${esc(code + '|' + date)}"><td colspan="${cols}"><dl class="td-detail-list">${lines.map(l => `<div><dt>${esc(l[0])}</dt><dd>${esc(l[1])}</dd></div>`).join('')}</dl></td></tr>`;
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

    // Порядок «Ждут отметки»: самые денежные — где больше денег (без суммы — в конце, по виду подсказки);
    // самые срочные — чей вылет ближе; по дате — по дате и времени вылета.
    function sortedAdvice(list, by) {
        const order = { down: 0, attn: 1, up: 2 };
        const rub = (a) => (a.money ? a.money.rub : -1);
        const num = (a) => parseInt(a.code.slice(3), 10) || 0;
        if (by === 'urgent') return list.slice().sort((a, b) => a.dtd - b.dtd || rub(b) - rub(a) || order[a.status] - order[b.status] || num(a) - num(b));
        if (by === 'date') {
            const key = new Map(list.map(a => {
                const d = parseLocalDate(a.date);
                return [a, [d ? d.getTime() : 0, depMinutes(rowFor(a.code, a.date))]];
            }));
            return list.slice().sort((a, b) => key.get(a)[0] - key.get(b)[0] || key.get(a)[1] - key.get(b)[1] || num(a) - num(b));
        }
        return list.slice().sort((a, b) => rub(b) - rub(a) || order[a.status] - order[b.status] || a.dtd - b.dtd);
    }

    const HEAD_TIP_FC = 'Сколько пассажиров ждём к вылету (тот же прогноз, что в карточке и RMS); «от … до …» — пределы, в которые попадают 8 вылетов из 10';
    const HEAD_TIP_USUAL = 'Сколько обычно продают к этой дате; цветом — насколько нынешние продажи выше (+) или ниже (−)';

    function tableHtml(pend, errs) {
        let rows = '';
        let empty = '';
        let more = '';
        const headHead = '<th>Рейс</th><th>Маршрут</th><th>Вылет</th><th>Продано из мест</th>'
            + `<th title="${HEAD_TIP_FC}">Ждём к вылету</th><th title="${HEAD_TIP_USUAL}">К этой дате обычно</th>`;
        let head = headHead + '<th>Что сделать</th><th></th>';
        if (tab === 'advice') {
            const shown = filter === 'all' ? pend : pend.filter(a => a.status === filter);
            const list = sortedAdvice(shown, sortBy());
            head = headHead + '<th class="td-th-r" title="Сколько денег под вылетом. ▼ и ●: пустые места по прогнозу × средний тариф. ▲: места, ещё доступные в продаже × последний тариф. Без прогноза или тарифа — «—»">Деньги, ₽</th><th>Что сделать</th><th></th>';
            if (list.length > 200) more = `<p class="td-empty">Показаны первые 200 из ${list.length}.</p>`;
            rows = list.slice(0, 200).map(a => rowHtml({ code: a.code, date: a.date, adv: a, money: a.money || null, showMoney: true })).join('');
            empty = !canTab('sales') ? 'Нет доступа к «Управлению продажами».' : !hintsOn() ? 'Подсказки на этой странице выключены в «Параметрах расчётов».' : !adviceReady() ? 'Считаю подсказки по вылетам…'
                : filter !== 'all' ? `Среди вылетов на ${aheadDays()} дн. нет таких, где стоит «${filter === 'up' ? 'повысить цену' : 'снизить цену'}».` : `Все вылеты на ${aheadDays()} дн. в норме или уже отмечены сегодня.`;
        } else if (tab === 'errors') {
            head = headHead + '<th>Что не так</th><th></th>';
            rows = errs.map(e => rowHtml({ code: e.code, date: e.date }, `<span class="td-err">${esc(e.items.map(i => i.title).join(', '))}</span>`)).join('');
            empty = 'Ошибок тарифов нет.';
        } else {
            const date = pickDay || today();
            rows = departuresOn(date).sort(byDepTime).map(d => rowHtml(d)).join('');
            empty = `На ${date} вылетов нет.`;
        }
        return `<div class="td-table-wrap">${rows ? `<table class="td-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>` : `<p class="td-empty">${esc(empty)}</p>`}${more}</div>`;
    }

    // ---------- плитки ----------

    function bigTile(cls, label, value, note, opts) {
        const o = opts || {};
        const act = o.filter ? ` data-td-filter="${o.filter}" role="button" tabindex="0" aria-pressed="${o.on ? 'true' : 'false'}"` : '';
        return `<div class="td-big ${cls}${o.filter ? ' td-big-act' : ''}${o.on ? ' td-big-on' : ''}"${act}${o.title ? ` title="${esc(o.title)}"` : ''}>
            <span class="td-big-label">${esc(label)}</span><b class="td-big-n">${value}</b><em class="td-big-note">${note}</em></div>`;
    }

    function bigTilesHtml(pend, errs, gaps) {
        const sales = canTab('sales');
        const checks = typeof FlightChecks !== 'undefined' && FlightChecks.enabled();
        const ready = adviceBuilt();
        const hints = hintsOn();
        let up = 0;
        let down = 0;
        let attn = 0;
        let upPass = 0;
        pend.forEach(a => {
            if (a.status === 'up') {
                up++;
                const u = a.refs ? a.refs.find(x => x.label.indexOf('обычно') === 0) : null;
                if (u) upPass += u.d;
            } else if (a.status === 'down') down++;
            else attn++;
        });
        const n = (v) => !hints ? '—' : !ready ? '…' : String(v);
        const off = !hints ? 'подсказки выключены' : !ready ? 'считаю…' : '';
        const days = aheadDays();
        const tiles = [];
        if (sales) {
            tiles.push(bigTile('td-big-red', 'Ждут вашей отметки', n(pend.length),
                off || `вылеты на ${days} ${pluralRu(days, 'день', 'дня', 'дней')} вперёд${attn ? ` · из них «Внимание»: ${attn}` : ''}`,
                { filter: 'all', on: tab === 'advice' && filter === 'all', title: 'Вылеты, по которым ещё нет сегодняшней отметки. Нажмите — показать их все' }));
            tiles.push(bigTile('td-big-green', 'Можно повысить цену', n(up),
                off || `продаётся лучше обычного${upPass > 0 ? ` · +${fmt(upPass)} пасс. к обычному` : ''}`,
                { filter: 'up', on: tab === 'advice' && filter === 'up', title: 'Нажмите — показать только вылеты, где можно повысить цену' }));
            tiles.push(bigTile('td-big-amber', 'Стоит снизить цену', n(down),
                off || 'продаётся хуже обычного',
                { filter: 'down', on: tab === 'advice' && filter === 'down', title: 'Нажмите — показать только вылеты, где стоит снизить цену' }));
        }
        if (checks || gaps) {
            const gapsNote = gaps ? `${gaps} ${pluralRu(gaps, 'пропуск', 'пропуска', 'пропусков')} в справочнике · <span class="td-link" role="link" tabindex="0" data-td-gaps>открыть справочник</span>` : 'пропусков в справочнике нет';
            tiles.push(bigTile('td-big-blue', 'Ошибки в тарифах', checks ? String(errs.length) : '—',
                checks ? gapsNote : `проверка тарифов выключена · ${gapsNote}`,
                checks ? { filter: 'errors', on: tab === 'errors', title: 'Нажмите — показать рейсы с ошибкой тарифа' } : {}));
        }
        return tiles.length ? `<div class="td-bigs">${tiles.join('')}</div>` : '';
    }

    function smallTilesHtml(k, stale, norm, dec) {
        return `<div class="td-stats${dec ? ' td-stats-3' : ''}">
            <div class="td-stat"${k.salesReady && !stale && k.todayOutside ? ` title="Из них вне загрузки (чартеры, доп. номера): ${fmt(k.todayOutside)}"` : ''}><span>Продано сегодня</span>${!k.salesReady ? '<b>—</b><em>файл продаж не загружен</em>' : stale ? `<b>—</b><em>нет свежих данных (от ${esc(stale.label)})</em>` : `<b>${fmt(k.todaySales)}</b><em>${fmt(Math.round(k.todayRevenue / 1000))} тыс. ₽</em>`}</div>
            <div class="td-stat" title="Продано на вылеты ближайших 7 дней минус сколько обычно продавали к этому дню (по тем же рейсам и дням недели)"><span>К обычному</span>${norm ? `<b>${signed(norm.diff)} пасс.</b><em>по ${norm.n} из ${norm.total} вылетов, 7 дней</em>` : `<b>—</b><em>${normBuilding ? 'считаю…' : 'нет нормы'}</em>`}</div>
            ${dec ? `<div class="td-stat td-stat-link" data-td-decisions role="button" tabindex="0" title="Общий итог решений «снизить» и «повысить» за 30 дней по тем, у кого итог уже зафиксирован, — как «Общий итог по оценённым» в Отчётах → Решения при периоде 30 дней. Остальные отчёт досчитает при открытии, тогда цифра в отчёте может отличаться. Нажмите, чтобы открыть."><span>Решения за 30 дн.</span><b>${signedRub(dec.sum)}</b><em>лучше ${dec.better}, хуже ${dec.worse} · итог есть у ${dec.ready} из ${dec.total}</em></div>` : ''}
        </div>`;
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
        const longDate = dt ? dt.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).replace(/\s*г\.$/, '') : today();
        const tabs = [
            canTab('sales') ? { id: 'advice', label: `Ждут отметки · ${hintsOn() ? pend.length : '—'}` } : null,
            typeof FlightChecks !== 'undefined' && FlightChecks.enabled() ? { id: 'errors', label: `Ошибки тарифов · ${errs.length}` } : null,
            { id: 'day', label: `Вылеты ${pickDay && pickDay !== today() ? pickDay.slice(0, 5) : 'сегодня'} · ${departuresOn(pickDay || today()).length}` }
        ].filter(Boolean);
        if (!tabs.some(t => t.id === tab)) tab = tabs[0].id;
        if (tab !== 'advice') filter = 'all';
        const canLoad = typeof ProfileAuth === 'undefined' || ProfileAuth.hasPermission('load_data');
        const ahead = aheadDays();
        const sortCur = sortBy();
        root.innerHTML = `
            <div class="td-wrap">
                <section class="td-main">
                    <div class="td-head">
                        <div class="td-today-date">Сегодня · ${esc(longDate)}</div>
                        <span class="td-head-load" title="Продано на вылеты ближайших 7 дней из мест в продаже">Загрузка вылетов на 7 дней: <b>${k.lf != null ? k.lf + '%' : '—'}</b> · ${fmt(k.sold)} из ${fmt(k.seats)} мест</span>
                    </div>
                    ${stale ? `<div class="td-stale" role="status"><span>Данные продаж старые: последняя загрузка ${esc(stale.label)}, ${stale.days} ${pluralRu(stale.days, 'день', 'дня', 'дней')} назад. Решения ниже могут быть неверными.</span>${canLoad ? '<button type="button" class="td-stale-btn" data-td-load title="То же, что кнопка «Загрузить» вверху">Загрузить свежие данные</button>' : ''}</div>` : ''}
                    ${bigTilesHtml(pend, errs, gaps)}
                    ${smallTilesHtml(k, stale, norm, dec)}
                    ${dayStripHtml(pend)}
                    <div class="td-tabs" role="tablist">${tabs.map(t => `<button type="button" role="tab" class="td-tab${t.id === tab ? ' td-tab-on' : ''}" data-td-tab="${t.id}">${esc(t.label)}</button>`).join('')}
                        ${tab === 'advice' && filter !== 'all' ? `<button type="button" class="td-filter-chip" data-td-filter="all" title="Показать все вылеты, ждущие отметки">Только «${filter === 'up' ? 'Повысить цену' : 'Снизить цену'}» ✕</button>` : ''}
                        <span class="td-tools">
                        ${tab === 'advice' ? `<label class="td-ahead" title="В каком порядке показывать вылеты">Сначала:
                            <select data-td-sort>${SORT_OPTIONS.map(o => `<option value="${o[0]}"${o[0] === sortCur ? ' selected' : ''}>${o[1]}</option>`).join('')}</select></label>` : ''}
                        ${canTab('sales') ? `<label class="td-ahead" title="Сколько дней вперёд показывать в полосе дней и в списке">Вперёд на:
                            <select data-td-ahead>${[...new Set(AHEAD_OPTIONS.concat(ahead))].sort((x, y) => x - y).map(n => `<option value="${n}"${n === ahead ? ' selected' : ''}>${n} ${pluralRu(n, 'день', 'дня', 'дней')}</option>`).join('')}</select></label>` : ''}
                        </span></div>
                    ${tableHtml(pend, errs)}
                    <p class="td-foot">Двойной клик по строке — подробности: расчёт подсказки и прогноза, деньги под вылетом.</p>
                </section>
            </div>`;
    }

    function markSelectedRow() {
        document.querySelectorAll('#td-page .td-row').forEach(tr => {
            tr.classList.toggle('td-row-on', !!(selected && tr.dataset.tdCode === selected.code && tr.dataset.tdDate === selected.date));
        });
    }

    // Подробности под строкой: открыть у одного рейса, повторный двойной клик — закрыть.
    function onDblClick(e) {
        const row = e.target.closest('tr.td-row');
        if (!row || e.target.closest('button, select, a')) return;
        const key = row.dataset.tdCode + '|' + row.dataset.tdDate;
        const sel = window.getSelection ? window.getSelection() : null;
        if (sel && sel.removeAllRanges) sel.removeAllRanges();
        document.querySelectorAll('#td-page tr.td-detail').forEach(d => d.remove());
        if (detailKey === key) { detailKey = ''; return; }
        detailKey = key;
        row.insertAdjacentHTML('afterend', detailRowHtml(row.dataset.tdCode, row.dataset.tdDate, row.cells.length));
    }

    function onKey(e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const el = e.target.closest('[role="button"], [role="link"]');
        if (!el || !el.closest('#td-page')) return;
        e.preventDefault();
        el.click();
    }

    function onClick(e) {
        const t = e.target;
        const tb = t.closest('[data-td-tab]');
        if (tb) { tab = tb.dataset.tdTab; filter = 'all'; render(); return; }
        const day = t.closest('[data-td-day]');
        if (day) { pickDay = day.dataset.tdDay; tab = 'day'; filter = 'all'; render(); return; }
        if (t.closest('[data-td-load]')) {
            // Тот же вызов, что у кнопки «Загрузить» в шапке (право проверяется внутри).
            if (typeof autoLoadLatestFiles === 'function') autoLoadLatestFiles();
            return;
        }
        if (t.closest('[data-td-decisions]')) {
            // Тот же период, что в плитке: 30 дней, вкладка «В рублях».
            if (typeof DecisionsReport !== 'undefined') { DecisionsReport.setPeriod(30); DecisionsReport.setView('money'); }
            if (typeof DecisionsTickets !== 'undefined') DecisionsTickets.setPeriod(30);
            if (typeof ReportsView !== 'undefined') ReportsView.showSubtab('decisions');
            switchMainTab('reports');
            return;
        }
        if (t.closest('[data-td-gaps]')) {
            if (typeof ReportsView !== 'undefined') ReportsView.showSubtab('refs');
            if (typeof ReferenceView !== 'undefined') ReferenceView.openSection('check');
            switchMainTab('reports');
            return;
        }
        // Плитки «ждут отметки / повысить / снизить / ошибки» отбирают строки таблицы; повторный клик по включённой — сброс.
        const ft = t.closest('[data-td-filter]');
        if (ft) {
            const f = ft.dataset.tdFilter;
            if (f === 'errors') {
                tab = tab === 'errors' ? (canTab('sales') ? 'advice' : 'day') : 'errors';
                filter = 'all';
            } else {
                const wasOn = tab === 'advice' && filter === f;
                tab = 'advice';
                filter = f === 'all' || wasOn ? 'all' : f;
            }
            render();
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
        page.addEventListener('dblclick', onDblClick);
        page.addEventListener('keydown', onKey);
        page.addEventListener('change', (e) => {
            const so = e.target.closest('[data-td-sort]');
            if (so) { setSortBy(so.value); render(); return; }
            const sel = e.target.closest('[data-td-ahead]');
            if (!sel) return;
            setAheadDays(parseInt(sel.value, 10));
            tab = 'advice';
            selected = null;
            detailKey = '';
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

    return { create, refresh, aheadDays };
})();

function createTodayView(panel) {
    TodayView.create(panel);
}
