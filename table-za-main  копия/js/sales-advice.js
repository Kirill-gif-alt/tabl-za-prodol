// Подсказка ценового решения по вылету (для «Управления продажами» и утренней сводки).
// Только вылеты в ближайшие дни (окно из параметров расчётов; на «Сегодня» выбирается). Сравнивает продано сейчас с нормой («обычно к этому дню»)
// и с планом (файл ожидаемой загрузки) — те же цифры, что в выводе карточки и детализации:
//   отстаёт от всех доступных ориентиров на порог и больше  → ▼ снизить;
//   опережает все ориентиры на порог и больше             → ▲ повысить;
//   от одного отстаёт, другой опережает на порог           → ! внимание.
// Порог — доля кресел, но не меньше минимума билетов (задаются в параметрах расчётов). Решение всегда принимает человек: это только подсветка.
window.SalesAdvice = (function () {
    let memo = new Map();
    let memoSig = '';

    function sig() {
        const epoch = typeof dataEpoch === 'number' ? dataEpoch : 0;
        const today = typeof getTodayDate === 'function' ? getTodayDate() : '';
        const rows = typeof allData !== 'undefined' && allData ? allData.length : 0;
        return `${epoch}|${today}|${rows}|${typeof analyticsRevision === 'function' ? analyticsRevision() : ''}`;
    }

    function daysUntil(date) {
        return typeof getDaysUntil === 'function' ? getDaysUntil(date) : null;
    }

    // maxDays — своё окно (вкладка «Сегодня»); по умолчанию PV.ADVICE_DAYS_AHEAD (УП и утренняя сводка).
    function inWindow(date, maxDays) {
        const d = daysUntil(date);
        // С завтрашнего дня: в день вылета менять цену уже поздно.
        return d != null && d >= 1 && d <= (maxDays || PV.ADVICE_DAYS_AHEAD);
    }

    function compute(code, date) {
        const base = typeof getBaseFlight === 'function' ? getBaseFlight(code) : code;
        const row = typeof getFlightRowForDate === 'function' ? getFlightRowForDate(base, date, code) : null;
        if (!row || typeof buildFlightDtdBookingSeries !== 'function') return null;
        if (typeof closedFlights !== 'undefined' && typeof getSalesLookupKey === 'function' && closedFlights.has(getSalesLookupKey(row))) return null;
        const seats = typeof getSeatsOnSale === 'function' ? getSeatsOnSale(row) : 0;
        const s = buildFlightDtdBookingSeries(base, date, code, 1, row[4]);
        if (!s || !s.thisData || !s.thisData.length) return null;
        const sold = s.thisData[s.thisData.length - 1];
        const ref = s.refData && s.refData.length ? s.refData[s.refData.length - 1] : null;
        const exp = s.expectedData && s.expectedData.length ? s.expectedData[s.expectedData.length - 1] : null;
        const refs = [];
        // Прошлый год — не ориентир для решения сегодня (спрос, цены и конкуренты другие): только нынешняя норма и план.
        if (ref != null && !isNaN(ref) && !s.refIsLy) refs.push({ label: 'обычно к этому дню', value: Math.round(ref), d: sold - Math.round(ref) });
        if (exp != null && !isNaN(exp)) refs.push({ label: 'по плану', value: exp, d: sold - exp });
        if (!refs.length) return null;
        const T = Math.max(PV.ADVICE_THRESHOLD_MIN, Math.round((seats || 0) * PV.ADVICE_THRESHOLD_PCT / 100));
        const behind = refs.filter(r => r.d <= -T).length;
        const ahead = refs.filter(r => r.d >= T).length;
        let status = null;
        if (behind === refs.length) status = 'down';
        else if (ahead === refs.length) status = 'up';
        else if (behind && ahead) status = 'attn';
        // Прогноз к вылету (тот же, что в карточке и RMS): темп ниже обычного, но вылет доберёт до порога (по умолчанию 80%) — не «снизить»;
        // темп выше, но прогноз ниже 60% — не «повысить». Тогда «внимание»: решать человеку.
        const fc = typeof FlightInsights !== 'undefined' ? FlightInsights.forecast(code, date) : null;
        const fcOk = fc && fc.source !== 'flown' && fc.final != null;
        let conflict = '';
        if (fcOk && status === 'down' && fc.lf >= PV.ADVICE_FC_HIGH) { status = 'attn'; conflict = `темп ниже обычного, но прогноз ${fc.lf}%`; }
        if (fcOk && status === 'up' && fc.lf < PV.ADVICE_FC_LOW) { status = 'attn'; conflict = `темп выше обычного, но прогноз ${fc.lf}%`; }
        // Продажи — на день среза данных: если файл не сегодняшний, «за N дн.» считаем от него и пишем дату данных.
        const dtdNow = daysUntil(date);
        const dtd = typeof observedFromDtd === 'function' && dtdNow != null ? Math.max(dtdNow, observedFromDtd(date)) : dtdNow;
        const lag = dtd != null && dtdNow != null && dtd > dtdNow && typeof salesDataCutoffTime === 'function'
            ? ` (данные на ${formatDateRu(new Date(salesDataCutoffTime()))})` : '';
        const diff = (d) => (d > 0 ? `+${d}` : String(d));
        const text = `Продано ${sold} за ${dtd} дн. до вылета${lag}; ` + refs.map(r => `${r.label} ${r.value} (${diff(r.d)})`).join(', ')
            + (fcOk ? `; прогноз к вылету ${fc.final} из ${fc.seats} (${fc.lf}%)` : '') + (conflict ? ` — ${conflict}` : '');
        return { code, date, base, status, sold, refs, threshold: T, dtd, text, seats, money: status ? money(code, date, status === 'up' ? 'up' : 'down', undefined, row, base) : null };
    }

    // Деньги под вылетом, ₽ (для сортировки и столбца «Деньги»):
    //  down — пустые места по прогнозу × средний тариф вылета (сколько выручки не добираем);
    //  up   — места, которые ещё в продаже, × последний тариф (с чего можно взять больше).
    // Без прогноза или тарифа — null (на экране «—»). avgHint: средний тариф, если он уже известен.
    let moneyMemo = new Map();
    let moneySig = '';
    function money(code, date, kind, avgHint, row0, base0) {
        const s = sig() + '|' + (typeof Params !== 'undefined' ? Params.revision() : 0);
        if (s !== moneySig) { moneyMemo = new Map(); moneySig = s; }
        const key = kind + '|' + code + '|' + date;
        if (moneyMemo.has(key)) return moneyMemo.get(key);
        let res = null;
        try { res = computeMoney(code, date, kind, avgHint, row0, base0); } catch (e) { console.warn('SalesAdvice.money', code, date, e); }
        moneyMemo.set(key, res);
        return res;
    }

    function computeMoney(code, date, kind, avgHint, row0, base0) {
        const fc = typeof FlightInsights !== 'undefined' ? FlightInsights.forecast(code, date) : null;
        if (!fc || fc.source === 'flown' || !(fc.seats > 0) || fc.final == null) return null;
        if (kind === 'up') {
            const cur = typeof PriceAdvisor !== 'undefined' && PriceAdvisor.currentPrice ? PriceAdvisor.currentPrice(code, date) : null;
            const fare = cur ? Number(cur.price) : 0;
            const left = Math.max(0, fc.seats - fc.load);
            if (!(fare > 0)) return null;
            return { kind, seats: left, fare: Math.round(fare), rub: Math.round(left * fare) };
        }
        let fare = Number(avgHint) || 0;
        if (!(fare > 0)) {
            const base = base0 || (typeof getBaseFlight === 'function' ? getBaseFlight(code) : code);
            const row = row0 || (typeof getFlightRowForDate === 'function' ? getFlightRowForDate(base, date, code) : null);
            const m = row && typeof getRowMetrics === 'function' ? getRowMetrics(row, base) : null;
            if (m && m.avg && (typeof hasSalesFileLoaded !== 'function' || hasSalesFileLoaded())) fare = m.avg;
        }
        if (!(fare > 0)) {
            const e = typeof FlightInsights !== 'undefined' ? FlightInsights.economics(code, date) : null;
            if (e && e.fare > 0) fare = e.fare;
        }
        if (!(fare > 0)) return null;
        const empty = Math.max(0, fc.seats - fc.final);
        return { kind, seats: empty, fare: Math.round(fare), rub: Math.round(empty * fare) };
    }

    // Подпись к сумме: из чего она получена.
    function moneyTitle(m) {
        if (!m) return 'Нет прогноза или тарифа: сумму не посчитать';
        const f = (n) => Math.round(n).toLocaleString('ru-RU');
        return m.kind === 'up'
            ? `Места, ещё доступные в продаже: ${m.seats} × последний тариф ${f(m.fare)} ₽`
            : `Пустые места по прогнозу: ${m.seats} × средний тариф ${f(m.fare)} ₽`;
    }

    // Цифры вылета к нынешнему дню: продано, кресла, ожидаемая (файл) и «аналогичные дни» (норма по дню недели).
    // Не зависит от переключателей подсказок — нужна отчёту «Запрос на понижение».
    function norms(code, date) {
        const base = typeof getBaseFlight === 'function' ? getBaseFlight(code) : code;
        const row = typeof getFlightRowForDate === 'function' ? getFlightRowForDate(base, date, code) : null;
        if (!row || typeof buildFlightDtdBookingSeries !== 'function') return null;
        const seats = typeof getSeatsOnSale === 'function' ? getSeatsOnSale(row) : 0;
        const s = buildFlightDtdBookingSeries(base, date, code, 1, row[4]);
        if (!s || !s.thisData || !s.thisData.length) return null;
        const sold = s.thisData[s.thisData.length - 1];
        const ref = s.refData && s.refData.length && !s.refIsLy ? s.refData[s.refData.length - 1] : null;
        const exp = s.expectedData && s.expectedData.length ? s.expectedData[s.expectedData.length - 1] : null;
        return { sold, seats, ref: ref != null && !isNaN(ref) ? Math.round(ref) : null, exp: exp != null && !isNaN(exp) ? Math.round(exp) : null, dtd: daysUntil(date), aircraft: row[4] };
    }

    // Подсказка для вылета или null (нет данных / вне окна / не о чем подсказывать).
    // Где показывать — переключатели в «Настройки» → «Параметры расчётов» → «Подсказки по тарифам»:
    // place = 'today' (страница «Сегодня»), 'sales' («Управление продажами»), 'summary' (утренняя сводка).
    function enabled(place) {
        return place === 'today' ? PV.HINT_TODAY === 1 : (place === 'sales' ? PV.HINT_SALES === 1 : (place === 'summary' ? PV.HINT_SUMMARY === 1 : false));
    }
    function forDeparture(code, date, maxDays, place) {
        if (!enabled(place)) return null;
        if (!code || !date || !inWindow(date, maxDays)) return null;
        const s = sig() + '|' + (typeof Params !== 'undefined' ? Params.revision() : 0);
        if (s !== memoSig) { memo = new Map(); memoSig = s; }
        const key = code + '|' + date;
        if (memo.has(key)) return memo.get(key);
        let res = null;
        try { res = compute(code, date); } catch (e) { console.warn('SalesAdvice', code, date, e); }
        memo.set(key, res);
        return res;
    }

    const LABEL = { down: '▼ снизить', up: '▲ повысить', attn: '! внимание' };

    // Все вылеты в окне (по загруженным данным): [{ code, date, base }].
    function departuresAhead(maxDays) {
        const out = [];
        const seen = new Set();
        Object.keys(typeof groupedData !== 'undefined' && groupedData ? groupedData : {}).forEach(base => {
            (groupedData[base] || []).forEach(r => {
                if (!r || !r[0] || !r[1] || !inWindow(r[1], maxDays)) return;
                const code = typeof cleanFlight === 'function' ? cleanFlight(r[0]) : r[0];
                const k = code + '|' + r[1];
                if (seen.has(k)) return;
                seen.add(k);
                out.push({ code, date: r[1], base });
            });
        });
        return out;
    }

    // Подсказки по всем вылетам окна (для сводки). Считается порциями, чтобы не подвешивать страницу.
    // only — набор «рейс|дата»: считать только эти вылеты (например, из «Управления продажами»).
    async function scanAll(only, maxDays, place) {
        if (!enabled(place)) return [];
        const list = departuresAhead(maxDays).filter(d => !only || only.has(d.code + '|' + d.date));
        const out = [];
        for (let i = 0; i < list.length; i++) {
            const a = forDeparture(list[i].code, list[i].date, maxDays, place);
            if (a && a.status) out.push(a);
            if (i % 25 === 24) await new Promise(r => setTimeout(r, 0));
        }
        return out;
    }

    return { norms, money, moneyTitle, forDeparture, scanAll, inWindow, LABEL, get DAYS_AHEAD() { return PV.ADVICE_DAYS_AHEAD; } };
})();
