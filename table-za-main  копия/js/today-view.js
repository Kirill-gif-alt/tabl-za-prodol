// Сегодня - стартовая страница: плитки, полоса дней и таблица
// считается лениво, при открытии страницы; подсказки те же, что в УП и SalesAdvice
window.TodayView = (function () {
    let tab = 'advice';         // advice | errors | day
    let filter = 'all';         // отбор "Ждут отметки": all | up | down | attn (attn - из attention.js)
    let picked = new Set();     // рейсы с галочкой, ключ "рейс|дата"
    let visibleKeys = new Set(); // рейсы, которые можно отметить среди показанных
    let stickKey = '';          // только что отмеченный рейс, держим в списке до "Следующий рейс"
    let onlyNew = false;        // отбор "Только новые": сигнал появился сегодня (signal-news.js)
    let detailKey = '';         // рейс|дата с открытыми подробностями (двойной клик)
    let pickDay = '';           // выбранный день полосы (ДД.ММ.ГГГГ)
    let selected = null;        // { code, date }
    let advice = [];
    let adviceSig = '';
    let building = null;
    // к обычному: на сколько пассажиров вылеты на 7 дней выше или ниже нормы "к этому дню"
    let normTile = { sig: '', data: null };
    let normBuilding = null;    // промис текущего расчета или null
    // решения за 30 дней: только готовые итоги из DecisionMoney.get, без пересчета
    let decTile = { sig: '', data: null, loading: false };
    // сколько дней вперед смотреть "Ждут решения", выбирает пользователь, запоминается в профиле
    const AHEAD_OPTIONS = [3, 5, 7, 10, 15, 20, 30];
    const AHEAD_KEY = 'krasavia_today_ahead_';
    function aheadKey() {
        const p = typeof ProfileAuth !== 'undefined' && ProfileAuth.getCurrentProfile ? ProfileAuth.getCurrentProfile() : null;
        return AHEAD_KEY + (p ? p.id : 'guest');
    }
    function aheadDays() {
        if (CustomPeriod.on('today')) return CustomPeriod.aheadDays('today');   // свой период: до выбранной даты
        let v = 0;
        try { v = parseInt(localStorage.getItem(aheadKey()), 10); } catch (e) { /* ignore */ }
        return AHEAD_OPTIONS.includes(v) ? v : (typeof SalesAdvice !== 'undefined' ? SalesAdvice.DAYS_AHEAD : 15);
    }
    function setAheadDays(v) {
        try { localStorage.setItem(aheadKey(), String(v)); } catch (e) { /* ignore */ }
    }

    // сортировка: самые денежные | самые срочные | по дате, хранится в профиле
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

    function esc(v) { return escHtml(v); }

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

    const NUM_RU = new Intl.NumberFormat('ru-RU');   // как toLocaleString('ru-RU'), но форматтер один на все числа
    function fmt(n) {
        return NUM_RU.format(Math.round(Number(n) || 0));
    }

    // вылеты на дату по строкам загрузки таб
    // раскладка по датам один раз на загрузку (функция зовется десятки раз за отрисовку)
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
        const byCode = new Map();
        rowsOnDate(date).forEach(([base, r]) => {
            const code = cleanFlight(r[0]);
            // вылет с посадками: одна строка на номер, основной (сквозной) участок, не участок ушедший в чужой рейс
            const cur = byCode.get(code);
            if (cur && !(cur.row.segShare && !r.segShare)) return;
            byCode.set(code, { code, base, date, row: r });
        });
        byCode.forEach(d => {
            d.seats = typeof getSeatsOnSale === 'function' ? getSeatsOnSale(d.row) : 0;
            d.sold = typeof getSoldFromRow === 'function' ? getSoldFromRow(d.row) : 0;
            out.push(d);
        });
        return out.sort((a, b) => String(a.row[11] || '').localeCompare(String(b.row[11] || '')) || (parseInt(a.code.slice(3), 10) - parseInt(b.code.slice(3), 10)));
    }

    // кэш вылетов УП пересобираем, только если сменился список (SalesManagement)
    // в одной отрисовке берем готовый набор (зовется на каждую строку)
    let depCache = { list: null, set: new Set() };
    let depNow = null;
    function salesDepartures() {
        if (depNow) return depNow;
        if (typeof SalesManagement === 'undefined' || !SalesManagement.listFlights) return new Set();
        try {
            const list = SalesManagement.listFlights();
            if (depCache.list !== list) {
                const set = new Set();
                list.forEach(f => (f.departures || []).forEach(d => set.add(d.code + '|' + d.date)));
                depCache = { list, set };
            }
            depNow = depCache.set;
            Promise.resolve().then(() => { depNow = null; });
            return depNow;
        } catch (e) { return new Set(); }
    }

    // сигналы за сегодня идут в "новое со вчера" (signal-news.js): советы и снимок дня, когда все посчитано
    function announceSignals() {
        if (typeof SignalNews === 'undefined') return;
        const withAdvice = canTab('sales') && hintsOn() && adviceReady();
        SignalNews.setAdvice(withAdvice ? advice : [], withAdvice ? aheadDays() : 0);
        const salesReady = typeof hasSalesFileLoaded === 'function' ? hasSalesFileLoaded() : true;
        // снимок пишем только по свежим данным, со старым файлом сигналы будут вчерашние
        if (hasData() && salesReady && !(typeof getStaleSalesInfo === 'function' && getStaleSalesInfo()) && (withAdvice || !canTab('sales') || !hintsOn())) SignalNews.record();
    }

    // подсказки под текущие данные и окно, иначе "0 ждут решения" еще не итог
    function adviceReady() {
        return typeof SalesAdvice === 'undefined' || adviceSig === sig();
    }

    // цифры показываем сразу, если хоть раз считали, без мигания при пересчете
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
        // идет расчет для другого окна дней: дождаться и пересчитать под текущий выбор
        if (building) return building.then(() => buildAdvice());
        building = (async () => {
            advice = await SalesAdvice.scanAll(salesDepartures(), aheadDays(), 'today');
            adviceSig = s;
        })().finally(() => { building = null; });
        return building;
    }

    // норма считается порциями после подсказок, пока не готова - прочерк в плитке
    // данные могли смениться во время расчета, тогда считаем еще раз (иначе плитка висит на "считаю...")
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

    // решения снизить/повысить за 30 дней с готовыми итогами; без итогов плитку прячем
    function buildDecisions() {
        if (!canTab('sales') || typeof DecisionMoney === 'undefined' || typeof SalesManagement === 'undefined' || !SalesManagement.allMarks) return;
        const s = decSig();
        if (decTile.sig === s || decTile.loading) return;
        const t0 = parseLocalDate(today());
        const seen = new Map();
        const list = [];
        SalesManagement.allMarks().forEach(m => {
            if (m.status !== 'down' && m.status !== 'up') return;
            const d = parseLocalDate(m.check);
            const ago = d && t0 ? Math.round((t0 - d) / 86400000) : null;
            if (ago == null || ago < 0 || ago > 30) return;
            const k = DecisionMoney.keyOf(m);
            if (seen.has(k)) { const x0 = seen.get(k); if (String(m.updatedAt || '') > String(x0.at || '')) x0.at = m.updatedAt; return; }
            const x = { key: k, month: monthOfDate(m.check), flight: m.flight, dep: m.dep, check: m.check, status: m.status, at: m.updatedAt || '' };
            seen.set(k, x);
            list.push(x);
        });
        // противоположные решения на одной ячейке: в итог только последнее, как в отчете
        if (typeof PriceMarks !== 'undefined' && PriceMarks.markOverlaps) PriceMarks.markOverlaps(list);
        decTile.loading = true;
        DecisionMoney.ensureMonths([...new Set(list.map(x => x.month).filter(Boolean))]).catch(() => {}).then(() => {
            const pos = ['worked', 'lean_pos', 'weak_pos'];
            const neg = ['failed', 'lean_neg', 'weak_neg'];
            let better = 0;
            let worse = 0;
            let sum = 0;
            let ready = 0;
            list.forEach(x => {
                if (x.overlap) return;
                const e = DecisionMoney.get(x.key);
                if (!e || e.v !== DecisionMoney.METHOD_VERSION || e.stage !== 'final') return;
                ready++;
                sum += (e.delta || 0) + (e.corr || 0);      // как "Общий итог" в отчете: с поправкой на шум и сдвиг
                if (pos.includes(e.verdict)) better++;
                else if (neg.includes(e.verdict)) worse++;
            });
            decTile = { sig: s, loading: false, data: ready ? { better, worse, sum, ready, total: list.length } : null };
            if (typeof currentTab !== 'undefined' && currentTab === 'today') render();
            if (decSig() !== s) buildDecisions();      // отметки сменились, пока считали: пересчитать
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

    // внимание: вылеты по общему правилу (attention.js), как в шапке и RMS "Срочно" + "Присмотреться"
    // горизонт 30 дней, не от "Вперёд на"; отмеченные сегодня тоже в списке, как в шапке
    let attnMemo = { list: null, items: [] };
    function attnItems() {
        if (typeof Attention === 'undefined') return [];
        if (attnMemo.list === Attention.list() && attnMemo.items.length === Attention.count()) return attnMemo.items;
        // строка RMS - участок рейса: у вылета с посадкой две строки, берем строку самого участка
        const items = Attention.list().map(m => {
            const row = (groupedData[m.base] || []).find(r => r && typeof getMetricsStorageKey === 'function' && getMetricsStorageKey(r) === m.rowKey) || null;
            return { code: m.orig, date: m.date, dtd: m.dtd, status: 'attn', row, seg: m.segShare ? m.route : '', money: typeof getRmsMoney === 'function' ? getRmsMoney(m) : null, m };
        });
        attnMemo = { list: Attention.list(), items };
        return items;
    }

    // что показано во вкладке по плитке (без "Только новые")
    function adviceShown(pend) {
        const list = filter === 'attn' ? attnItems() : (filter === 'all' ? pend : pend.filter(a => a.status === filter));
        // держим отмеченный рейс в списке, иначе "Следующий рейс" пропадет вместе со строкой
        if (stickKey && stickKey === detailKey && filter !== 'attn' && !list.some(a => a.code + '|' + a.date === stickKey)) {
            const st = advice.find(a => a.code + '|' + a.date === stickKey);
            if (st && (filter === 'all' || st.status === filter)) return list.concat([st]);
        }
        return list;
    }

    function isNewRow(code, date) {
        return typeof SignalNews !== 'undefined' && SignalNews.isNew(code, date);
    }

    function attnCell(it) {
        const reason = it.m && it.m.alertReason ? (typeof rmsReasonShort === 'function' ? rmsReasonShort(it.m.alertReason) : it.m.alertReason) : '';
        return `<span class="td-pill td-pill-attn">Внимание</span>${reason ? `<div class="td-muted">${esc(reason)}</div>` : ''}`;
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

    function isClosedDep(d) {
        return typeof closedFlights !== 'undefined' && typeof getSalesLookupKey === 'function' && closedFlights.has(getSalesLookupKey(d.row));
    }

    function kpis() {
        let sold = 0;
        let seats = 0;
        let n = 0;
        for (let i = 0; i < 7; i++) {
            // закрытые рейсы не считаем, как "Занято в среднем" на RMS
            departuresOn(shift(today(), i)).forEach(d => {
                if (isClosedDep(d)) return;
                sold += d.sold; seats += d.seats; n++;
            });
        }
        const k = typeof getGlobalKPIs === 'function' ? getGlobalKPIs() : {};
        // нет файла продаж: "0 продано" было бы неправдой, в шапке и RMS прочерк
        const salesReady = typeof hasSalesFileLoaded === 'function' ? hasSalesFileLoaded() : true;
        return { lf: seats ? Math.round(sold / seats * 100) : null, sold, seats, n, salesReady, todaySales: Number(k.todaySales) || 0, todayRevenue: Number(k.todayRevenue) || 0, todayOutside: Number(k.todayOutside) || 0 };
    }

    // подсказки выключены в параметрах расчетов: "в норме" писать нельзя, проверки не было
    function hintsOn() {
        return typeof SalesAdvice === 'undefined' || typeof PV === 'undefined' || PV.HINT_TODAY === 1;
    }

    function dayStripHtml(pend) {
        const byDay = new Map();
        pend.forEach(a => byDay.set(a.date, (byDay.get(a.date) || 0) + 1));
        const cells = [];
        const days = aheadDays() + 1;
        // число "к отметке" только если подсказки посчитаны, иначе число вылетов дня
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

    // сегодняшняя отметка, если стоит: рейс проверен
    function markNoteHtml(code, date) {
        const mk = typeof PriceMarks !== 'undefined' ? PriceMarks.todayMark(code, date) : null;
        return mk && SalesManagement.STATUSES[mk.status] ? `<div class="td-muted">Отмечено: ${esc(SalesManagement.STATUSES[mk.status].short)}</div>` : '';
    }

    function rowHtml(item, extraCell) {
        const r = item.row || rowFor(item.code, item.date);
        const seats = r && typeof getSeatsOnSale === 'function' ? getSeatsOnSale(r) : 0;
        const sold = r && typeof getSoldFromRow === 'function' ? getSoldFromRow(r) : 0;
        const ac = r && typeof getAircraftType === 'function' ? getAircraftType(r[4]) : '';
        const dtd = daysUntil(item.date);
        const adv = item.adv !== undefined ? item.adv : (typeof SalesAdvice !== 'undefined' ? SalesAdvice.forDeparture(item.code, item.date, aheadDays(), 'today') : null);
        // если есть только план, не подписывать его как "обычно"
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
        const pickable = bulkOn() && canPickRow(item.code, item.date);
        if (pickable) visibleKeys.add(key);
        return `
            <tr class="td-row${on ? ' td-row-on' : ''}${pickable && picked.has(key) ? ' td-row-pick' : ''}" data-td-code="${esc(item.code)}" data-td-date="${esc(item.date)}">
                ${bulkOn() ? `<td class="td-chk">${pickable ? `<input type="checkbox" data-td-pick aria-label="Выбрать рейс ${esc(item.code)}"${picked.has(key) ? ' checked' : ''}>` : ''}</td>` : ''}
                <td class="td-code"><strong>${esc(item.code)}</strong>${isNewRow(item.code, item.date) ? '<span class="td-new">новое</span>' : ''}${grp ? `<span class="grp-badge" title="В группах ${grp} чел.">Г ${grp}</span>` : ''}</td>
                <td>${esc(typeof getFlightDirection === 'function' ? getFlightDirection(item.code) : '')}<div class="td-muted">${esc(ac)}${item.seg ? ' · ' + esc(item.seg) : ''}</div></td>
                <td class="td-nowrap">${esc(item.date.slice(0, 5))}${typeof DelayedFlights !== 'undefined' ? DelayedFlights.tag(item.code, item.date) : ''}<div class="td-muted">${esc(inDaysText(dtd))}</div></td>
                <td>${loadCell(sold, seats)}</td>
                <td class="td-nowrap" title="${esc(fc ? FlightInsights.forecastText(fc) : 'Мало истории для прогноза')}">${fcOk ? `<b class="td-fc-n${fcCls}">${fmt(fc.final)}</b>${fcRange}` : '—'}</td>
                <td class="td-nowrap" title="Сколько пассажиров обычно продают к этому дню; цветом — насколько нынешние продажи выше или ниже">${refCell}</td>
                ${item.showMoney ? `<td class="td-nowrap td-money" title="${esc(typeof SalesAdvice !== 'undefined' ? SalesAdvice.moneyTitle(item.money) : '')}">${item.money ? fmt(item.money.rub) : '—'}</td>` : ''}
                <td>${extraCell != null ? extraCell : pillHtml(adv)}${markNoteHtml(item.code, item.date)}</td>
                <td class="td-go-cell">${openable(item.code, item.date) ? '<button type="button" class="td-go" data-td-go title="Открыть рейс в «Управлении продажами» (если он там есть) или в «Динамике продаж»">Открыть</button>' : ''}</td>
            </tr>${detailKey === key ? detailRowHtml(item.code, item.date, (item.showMoney ? 9 : 8) + (bulkOn() ? 1 : 0)) : ''}`;
    }

    // подробности под строкой, считаем по запросу из готовых кэшей
    function detailRowHtml(code, date, cols) {
        const lines = [];
        const adv = typeof SalesAdvice !== 'undefined' ? SalesAdvice.forDeparture(code, date, aheadDays(), 'today') : null;
        if (adv) {
            lines.push(['Подсказка', adv.text]);
            lines.push(['Порог', `подсказка появляется, когда продажи отличаются от обычного или плана не меньше чем на ${adv.threshold} ${pluralRu(adv.threshold, 'пассажира', 'пассажира', 'пассажиров')}`]);
            if (adv.money) lines.push(['Стоимость пустых мест', SalesAdvice.moneyTitle(adv.money)]);
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
        // отметка и "Следующий рейс" только у тех, кто может ставить отметки; кнопки те же, что в RMS (PriceMarks)
        const act = canPickRow(code, date, true) ? `<div class="td-detail-act">${PriceMarks.buttonsHtml(code, date)}<button type="button" class="td-next" data-td-next>Следующий рейс ›</button></div>` : '';
        return `<tr class="td-detail" data-td-detail="${esc(code + '|' + date)}"><td colspan="${cols}"><dl class="td-detail-list">${lines.map(l => `<div><dt>${esc(l[0])}</dt><dd>${esc(l[1])}</dd></div>`).join('')}</dl>${act}</td></tr>`;
    }

    function depMinutes(row) {
        const t = typeof getDepTime === 'function' ? getDepTime(row) : (row && row[11]);
        return typeof timeToMinutes === 'function' && t ? timeToMinutes(t) : 9999;
    }

    function byDepTime(a, b) {
        return depMinutes(a.row) - depMinutes(b.row) || (parseInt(a.code.slice(3), 10) || 0) - (parseInt(b.code.slice(3), 10) || 0);
    }

    // отметки при праве edit_sales_mgmt и доступе к вкладке продаж
    function bulkOn() {
        return canTab('sales') && typeof PriceMarks !== 'undefined' && PriceMarks.canMark();
    }

    // отмечаем только вылет из УП, еще не улетевший и без отметки за сегодня
    function canPickRow(code, date, withMark) {
        if (!bulkOn() || !inSalesList(code, date)) return false;
        const d = daysUntil(date);
        if (d == null || d < 0) return false;
        return withMark || !(typeof SalesManagement !== 'undefined' && SalesManagement.getMarks(code, date, today()).length);
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

    // самые денежные: где больше денег, без суммы в конце, по виду подсказки
    // самые срочные: чей вылет ближе; по дате: по дате и времени вылета
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
        visibleKeys = new Set();
        let rows = '';
        let empty = '';
        let more = '';
        const headHead = '<th>Рейс</th><th>Маршрут</th><th>Вылет</th><th>Продано из мест</th>'
            + `<th title="${HEAD_TIP_FC}">Ждём к вылету</th><th title="${HEAD_TIP_USUAL}">К этой дате обычно</th>`;
        let head = headHead + '<th>Что сделать</th><th></th>';
        if (tab === 'advice') {
            const attnMode = filter === 'attn';
            const shown0 = adviceShown(pend);
            const shown = onlyNew ? shown0.filter(a => isNewRow(a.code, a.date)) : shown0;
            const list = sortedAdvice(shown, sortBy());
            head = headHead + '<th class="td-th-r" title="Сколько стоят места, которые пока не проданы. ▼ и ●: пустые места по прогнозу × средний тариф. ▲: места, ещё доступные в продаже × последний тариф. Без прогноза или тарифа — «—»">Стоимость пустых мест, ₽</th><th>Что сделать</th><th></th>';
            if (list.length > 200) more = `<p class="td-empty">Показаны первые 200 из ${list.length}.</p>`;
            rows = list.slice(0, 200).map(a => attnMode
                ? rowHtml({ code: a.code, date: a.date, row: a.row, seg: a.seg, money: a.money || null, showMoney: true }, attnCell(a))
                : rowHtml({ code: a.code, date: a.date, adv: a, money: a.money || null, showMoney: true })).join('');
            empty = onlyNew ? 'Новых сигналов нет: всё, что сейчас в списке, было и в прошлый раз.' : filter === 'attn' ? `Вылетов, которые требуют внимания, на ${Attention.HORIZON} дней вперёд нет.`
                : !canTab('sales') ? 'Нет доступа к «Управлению продажами».' : !hintsOn() ? 'Подсказки на этой странице выключены в «Параметрах расчётов».' : !adviceReady() ? 'Считаю подсказки по вылетам…'
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
        // выбор только среди показанных строк: что пропало из списка, уходит из выбора
        picked = new Set([...picked].filter(k => visibleKeys.has(k)));
        const chkTh = bulkOn() ? `<th class="td-th-chk"><input type="checkbox" data-td-pick-all aria-label="Выбрать все показанные"${visibleKeys.size && picked.size === visibleKeys.size ? ' checked' : ''}></th>` : '';
        return `${bulkOn() ? `<div class="td-bulk" id="td-bulk"${picked.size ? '' : ' hidden'}>${bulkBarInner()}</div>` : ''}<div class="td-table-wrap">${rows ? `<table class="td-table"><thead><tr>${chkTh}${head}</tr></thead><tbody>${rows}</tbody></table>` : `<p class="td-empty">${esc(empty)}</p>`}${more}</div>`;
    }

    function bulkBarInner() {
        return `<span>Выбрано <b>${picked.size}</b></span><span class="td-bulk-sep">·</span>`
            + '<button type="button" class="td-bulk-btn" data-td-bulk-keep>Проверено без изменений</button><span class="td-bulk-sep">·</span>'
            + '<button type="button" class="td-bulk-link" data-td-bulk-clear>Снять выбор</button>';
    }

    // обновляем панель действий, галочку и подсветку без перерисовки страницы
    function syncBulk() {
        const bar = document.getElementById('td-bulk');
        if (bar) { bar.hidden = !picked.size; bar.innerHTML = bulkBarInner(); }
        const all = document.querySelector('#td-page [data-td-pick-all]');
        if (all) {
            all.checked = visibleKeys.size > 0 && picked.size === visibleKeys.size;
            all.indeterminate = picked.size > 0 && picked.size < visibleKeys.size;
        }
        document.querySelectorAll('#td-page tr.td-row').forEach(tr => {
            const k = tr.dataset.tdCode + '|' + tr.dataset.tdDate;
            const cb = tr.querySelector('[data-td-pick]');
            if (cb) cb.checked = picked.has(k);
            tr.classList.toggle('td-row-pick', picked.has(k));
        });
    }

    // то же, что ручная отметка: PriceMarks -> SalesManagement.putMark
    function bulkKeep() {
        const keys = [...picked].filter(k => visibleKeys.has(k));
        if (!keys.length || !bulkOn()) return;
        if (keys.length > 20 && !window.confirm(`Отметить ${keys.length} ${pluralRu(keys.length, 'рейс', 'рейса', 'рейсов')} «Без изменений»?`)) return;
        picked = new Set();
        const n = PriceMarks.setMany(keys.map(k => { const p = k.split('|'); return { code: p[0], date: p[1] }; }), 'keep');
        if (typeof showToast === 'function') showToast(n ? `Отмечено «Без изменений»: ${n}` : 'Отметки не поставлены', n ? 'success' : 'error');
        if (typeof updateHeaderStatus === 'function') updateHeaderStatus();   // счетчик ☀ в шапке
        if (!n) render();      // при успехе страницу уже обновило событие отметки
    }

    // следующий рейс: подробности следующей строки в текущем порядке списка
    function nextFlight() {
        const cur = document.querySelector('#td-page tr.td-detail');
        let tr = cur ? cur.previousElementSibling : null;
        let nx = cur ? cur.nextElementSibling : null;
        while (nx && !nx.classList.contains('td-row')) nx = nx.nextElementSibling;
        if (!tr || !nx) { if (typeof showToast === 'function') showToast('Дальше рейсов в списке нет', 'error'); return; }
        const nk = nx.dataset.tdCode + '|' + nx.dataset.tdDate;
        stickKey = '';
        detailKey = nk;
        render();
        const det = document.querySelector(`#td-page tr.td-detail[data-td-detail="${CSS.escape(nk)}"]`);
        const row = det && det.previousElementSibling;
        if (row && row.scrollIntoView) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }

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
        let upPass = 0;
        pend.forEach(a => {
            if (a.status === 'up') {
                up++;
                const u = a.refs ? a.refs.find(x => x.label.indexOf('обычно') === 0) : null;
                if (u) upPass += u.d;
            } else if (a.status === 'down') down++;
        });
        const n = (v) => !hints ? '—' : !ready ? '…' : String(v);
        const off = !hints ? 'подсказки выключены' : !ready ? 'считаю…' : '';
        const days = aheadDays();
        const tiles = [];
        if (sales) {
            tiles.push(bigTile('td-big-red', 'Ждут вашей отметки', n(pend.length),
                off || `вылеты на ${days} ${pluralRu(days, 'день', 'дня', 'дней')} вперёд`,
                { filter: 'all', on: tab === 'advice' && filter === 'all', title: 'Вылеты, по которым ещё нет сегодняшней отметки. Нажмите — показать их все' }));
            if (typeof Attention !== 'undefined') {
                const al = Attention.list();
                const crit = al.filter(m => Attention.level(m) >= 3).length;
                tiles.push(bigTile('td-big-gray', 'Требуют внимания', String(al.length),
                    `на ${Attention.HORIZON} дней вперёд${crit ? ` · срочно ${crit}` : ''}`,
                    { filter: 'attn', on: tab === 'advice' && filter === 'attn' }));
            }
            tiles.push(bigTile('td-big-green', 'Можно повысить цену', n(up),
                off || `продаётся лучше обычного${upPass > 0 ? ` · +${fmt(upPass)} пасс. к обычному` : ''}`,
                { filter: 'up', on: tab === 'advice' && filter === 'up', title: 'Нажмите — показать только вылеты, где можно повысить цену' }));
            tiles.push(bigTile('td-big-amber', 'Стоит снизить цену', n(down),
                off || 'продаётся хуже обычного',
                { filter: 'down', on: tab === 'advice' && filter === 'down', title: 'Нажмите — показать только вылеты, где стоит снизить цену' }));
        }
        if (checks || gaps) {
            const gapsNote = gaps ? `${gaps} ${pluralRu(gaps, 'пропуск', 'пропуска', 'пропусков')} в справочнике${typeof ProfileAuth === 'undefined' || ProfileAuth.canAccessTab('reports') ? ' · <span class="td-link" role="link" tabindex="0" data-td-gaps>открыть справочник</span>' : ''}` : 'пропусков в справочнике нет';
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
                        ${tab === 'advice' && filter !== 'all' ? `<button type="button" class="td-filter-chip" data-td-filter="all" title="Показать все вылеты, ждущие отметки">Только «${filter === 'up' ? 'Повысить цену' : filter === 'attn' ? 'Внимание' : 'Снизить цену'}» ✕</button>` : ''}
                        <span class="td-tools">
                        ${tab === 'advice' && typeof SignalNews !== 'undefined' && SignalNews.hasBaseline() ? `<button type="button" class="td-filter-chip${onlyNew ? ' td-filter-chip-on' : ''}" data-td-new aria-pressed="${onlyNew ? 'true' : 'false'}">Только новые · ${adviceShown(pend).filter(a => isNewRow(a.code, a.date)).length}</button>` : ''}
                        ${tab === 'advice' ? `<label class="td-ahead" title="В каком порядке показывать вылеты">Сначала:
                            <select data-td-sort>${SORT_OPTIONS.map(o => `<option value="${o[0]}"${o[0] === sortCur ? ' selected' : ''}>${o[1]}</option>`).join('')}</select></label>` : ''}
                        ${canTab('sales') ? `<label class="td-ahead" title="Сколько дней вперёд показывать в полосе дней и в списке">Вперёд на:
                            <select data-td-ahead>${[...new Set(AHEAD_OPTIONS.concat(CustomPeriod.on('today') ? [] : ahead))].sort((x, y) => x - y).map(n => `<option value="${n}"${n === ahead && !CustomPeriod.on('today') ? ' selected' : ''}>${n} ${pluralRu(n, 'день', 'дня', 'дней')}</option>`).join('')}<option value="custom"${CustomPeriod.on('today') ? ' selected' : ''}>Свой период</option></select></label>${CustomPeriod.inputsHtml('today', true)}` : ''}
                        </span></div>
                    ${tableHtml(pend, errs)}
                    <p class="td-foot">Двойной клик по строке — подробности: расчёт подсказки и прогноза, стоимость пустых мест.</p>
                </section>
            </div>`;
    }

    function markSelectedRow() {
        document.querySelectorAll('#td-page .td-row').forEach(tr => {
            tr.classList.toggle('td-row-on', !!(selected && tr.dataset.tdCode === selected.code && tr.dataset.tdDate === selected.date));
        });
    }

    // подробности: один рейс за раз, повторный двойной клик закрывает
    function onDblClick(e) {
        const row = e.target.closest('tr.td-row');
        if (!row || e.target.closest('button, select, a, input, td.td-chk')) return;
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
            // то же, что кнопка "Загрузить" в шапке, право проверяется внутри
            if (typeof autoLoadLatestFiles === 'function') autoLoadLatestFiles();
            return;
        }
        if (t.closest('[data-td-decisions]')) {
            // тот же период, что в плитке: 30 дней, вид "В рублях"
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
        // плитки отбирают строки таблицы; повторный клик по включенной сбрасывает
        if (t.closest('[data-td-new]')) { onlyNew = !onlyNew; render(); return; }
        if (t.closest('[data-td-next]')) { nextFlight(); return; }
        if (t.closest('[data-td-bulk-keep]')) { bulkKeep(); return; }
        if (t.closest('[data-td-bulk-clear]')) { picked = new Set(); syncBulk(); return; }
        if (t.closest('[data-td-pick-all]')) {
            picked = t.closest('[data-td-pick-all]').checked ? new Set(visibleKeys) : new Set();
            syncBulk();
            return;
        }
        const chkCell = t.closest('td.td-chk');
        if (chkCell) {
            const cb = chkCell.querySelector('[data-td-pick]');
            if (cb) {
                if (t !== cb) cb.checked = !cb.checked;
                const k = cb.closest('tr').dataset.tdCode + '|' + cb.closest('tr').dataset.tdDate;
                if (cb.checked) picked.add(k); else picked.delete(k);
                syncBulk();
            }
            return;
        }
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
            const cpIn = e.target.closest('[data-cp-id]');
            if (!sel && !cpIn) return;
            if (cpIn) CustomPeriod.handleChange(cpIn);
            else if (sel.value === 'custom') { if (!CustomPeriod.on('today')) CustomPeriod.toggle('today', true); }
            else { CustomPeriod.set('today', { on: false }); setAheadDays(parseInt(sel.value, 10)); }
            tab = 'advice';
            selected = null;
            detailKey = '';
            render();
            buildAdvice().then(() => { announceSignals(); render(); return buildNorm(); }).then(render).catch(err => console.warn('TodayView', err));
        });
        render();
        buildAdvice().then(() => { announceSignals(); render(); return buildNorm(); }).then(render).catch(e => console.warn('TodayView', e));
        buildDecisions();
        if (typeof SignalNews !== 'undefined') SignalNews.loadShared(() => { if (document.getElementById('td-page')) render(); });
    }

    function refresh() {
        if (!document.getElementById('td-page')) return;
        render();
        if (adviceSig !== sig()) buildAdvice().then(() => { announceSignals(); render(); return buildNorm(); }).then(render).catch(() => {});
        else if (normTile.sig !== sig()) buildNorm().then(render).catch(() => {});
        buildDecisions();
    }

    // после отметки обновляем счетчики и подсказки
    document.addEventListener('krasavia:mark', (e) => {
        const d = (e && e.detail) || {};
        if (detailKey && d.code && d.code + '|' + d.date === detailKey) stickKey = detailKey;
        if (typeof currentTab !== 'undefined' && currentTab === 'today') render();
    });

    // фоновый расчет сигналов для снимка дня (signals-days.json); если "Сегодня" открыта, считает она
    function backgroundSignals() {
        if (document.getElementById('td-page') || !hasData()) return Promise.resolve();
        // архив и параметры подгружаются в фоне и меняют подпись, ждем, пока устоится
        return (async () => {
            for (let i = 0; i < 5; i++) {
                await buildAdvice();
                if (adviceReady() || document.getElementById('td-page')) break;
                await new Promise(r => setTimeout(r, 4000));
            }
            if (!document.getElementById('td-page')) announceSignals();
        })();
    }

    return { create, refresh, aheadDays, backgroundSignals };
})();

function createTodayView(panel) {
    TodayView.create(panel);
}
