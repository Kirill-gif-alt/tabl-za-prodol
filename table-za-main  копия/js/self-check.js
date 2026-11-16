// проверка расчётов (Отчёты, Проверки): сайт сверяет одни и те же числа, которые разные вкладки берут из разных функций
// каждая проверка отдельная функция, на выходе { name, checked, bad, examples }; идёт порциями, страницу не вешает
// результат держим в памяти, пока не сменились данные
window.SelfCheck = (function () {
    const KEEP = 3000;   // примеров на проверку в памяти (в Excel идут все они)
    const SHOW = 50;     // примеров на экране

    let state = { sig: '', res: null, running: false, done: 0, total: 0 };
    let openId = '';

    function esc(v) { return escHtml(v); }
    function hasPerm(p) { return typeof ProfileAuth === 'undefined' || ProfileAuth.hasPermission(p); }
    function fmt(n) { return n == null || !isFinite(n) ? '—' : Number(n).toLocaleString('ru-RU', { maximumFractionDigits: 0 }); }

    function canView() {
        if (typeof ProfileAuth === 'undefined' || !ProfileAuth.getCurrentProfile) return false;
        const cur = ProfileAuth.getCurrentProfile();
        return !!(cur && cur.isAdmin);
    }

    function dataSig() {
        const at = typeof lastSalesUpdate !== 'undefined' && lastSalesUpdate ? new Date(lastSalesUpdate).getTime() : 0;
        const epoch = typeof dataEpoch === 'number' ? dataEpoch : 0;
        return [epoch, typeof allData !== 'undefined' && allData ? allData.length : 0, at, getTodayDate()].join('|');
    }

    function hasData() {
        return typeof groupedData !== 'undefined' && groupedData && Object.keys(groupedData).length > 0;
    }

    // число из текста таблицы ("1 234", "—")
    function num(s) {
        if (typeof s === 'number') return s;
        const t = String(s == null ? '' : s).replace(/[\s  ]/g, '').replace('−', '-');
        return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
    }

    function dayNum(str) {
        const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(str || ''));
        return m ? Math.round(Date.UTC(+m[3], +m[2] - 1, +m[1]) / 86400000) : null;
    }

    function newRes(id, name, forms) {
        const r = { id, name, forms, checked: 0, bad: 0, examples: [], note: '' };
        r.add = (flight, date, where, one, other) => {
            r.bad++;
            if (r.examples.length < KEEP) r.examples.push({ flight, date, where, one: one == null ? '—' : one, other: other == null ? '—' : other });
        };
        // сравнение двух чисел; расхождение только если они разные
        r.cmp = (flight, date, where, one, other) => { if (one !== other) r.add(flight, date, where, one, other); };
        return r;
    }

    const pause = () => new Promise(res => setTimeout(res, 4));

    // порция работы не дольше 10 мс, потом отдаём управление и обновляем полосу
    function makeStep(ctx) {
        let t = performance.now();
        return async function step(n) {
            ctx.done += n == null ? 1 : n;
            if (performance.now() - t > 10) {
                paintProgress(ctx);
                await pause();
                t = performance.now();
            }
        };
    }

    function paintProgress(ctx) {
        state.done = ctx.done;
        state.total = ctx.total;
        const bar = document.getElementById('sc-bar-in');
        const txt = document.getElementById('sc-bar-text');
        if (bar) bar.style.width = (ctx.total ? Math.min(100, Math.round(ctx.done / ctx.total * 100)) : 0) + '%';
        if (txt) txt.textContent = `Проверено ${fmt(Math.min(ctx.done, ctx.total))} из ${fmt(ctx.total)}`;
    }

    // ---------- общие данные для проверок ----------

    async function buildCtx(step0) {
        const todayStr = getTodayDate();
        const ctx = {
            todayStr, todayN: dayNum(todayStr), todayStart: parseLocalDate(todayStr),
            bases: [], byBase: {}, firstByBase: {}, rows: [], rowsByKey: new Map(), rowsByDep: new Map(),
            direct: new Map(), done: 0, total: 0
        };
        Object.keys(groupedData || {}).filter(isValidFlightBase).forEach(base => {
            const list = (groupedData[base] || []).filter(r => r && r[0] && r[1]);
            ctx.bases.push(base);
            ctx.byBase[base] = list;
            ctx.firstByBase[base] = buildFirstSalesRowByKey(list);
            list.forEach(row => {
                const code = cleanFlight(row[0]);
                const e = { row, base, code, date: row[1], key: getSalesLookupKey(row) };
                ctx.rows.push(e);
                if (!ctx.rowsByKey.has(e.key)) ctx.rowsByKey.set(e.key, []);
                ctx.rowsByKey.get(e.key).push(e);
                const dk = row[1] + '|' + code;
                if (!ctx.rowsByDep.has(dk)) ctx.rowsByDep.set(dk, []);
                ctx.rowsByDep.get(dk).push(e);
            });
        });
        ctx.keys = Object.keys(salesDetails || {});
        // пересчёт продаж напрямую по датам сделок, без сводных чисел
        for (let i = 0; i < ctx.keys.length; i++) {
            const k = ctx.keys[i];
            const list = salesDetails[k] || [];
            const d = { n: list.length, rev: 0, today: 0, yesterday: 0, day2: 0, d7: 0, d14: 0, d30: 0, neg: 0 };
            list.forEach(s => {
                const f = Number(s && s.fare) || 0;
                d.rev += f;
                if (f < 0) d.neg++;
                const dn = dayNum(s && s.dealDate);
                if (dn == null || ctx.todayN == null) return;
                const ago = ctx.todayN - dn;
                if (ago === 0) d.today++;
                else if (ago === 1) d.yesterday++;
                else if (ago === 2) d.day2++;
                if (ago >= 0 && ago < 7) d.d7++;
                if (ago >= 0 && ago < 14) d.d14++;
                if (ago >= 0 && ago < 30) d.d30++;
            });
            ctx.direct.set(k, d);
            if (i % 400 === 399) await step0();
        }
        ctx.pairs = pairsList();
        return ctx;
    }

    // пары туда-обратно, как в «Загрузке рейсов», но без фильтров экрана
    function pairsList() {
        const seen = new Set();
        const out = [];
        getValidFlightBases().forEach(base => {
            const p = resolvePairForSelection(base);
            const k = p.outbound + '|' + p.inbound;
            if (seen.has(k)) return;
            seen.add(k);
            out.push(p);
        });
        return out;
    }

    function rawSeats(row) {
        const au = Math.max(0, parseInt(row[5] || 0, 10) || 0);
        const avs = Math.max(0, parseInt(row[8] || 0, 10) || 0);
        return Math.max(0, au - avs);
    }
    function rawSold(row) { return Math.max(0, parseInt(row[6] || 0, 10) || 0); }

    // ---------- проверки ----------

    // 1. кресла, продано, загрузка %: все вкладки против файла загрузки
    async function chkLoad(ctx, step) {
        const r = newRes('load', 'Кресла, продано и загрузка: вкладки между собой', ['вылет', 'вылета', 'вылетов']);
        for (const e of ctx.rows) {
            r.checked++;
            const row = e.row;
            const seats = rawSeats(row);
            const sold = rawSold(row);
            const pct = seats > 0 ? Math.round(sold / seats * 100) : null;
            const closed = closedFlights.has(e.key);
            const flew = !!(ctx.todayStart && parseLocalDate(e.date) < ctx.todayStart);
            const put = (tab, what, one, other) => r.cmp(e.code, e.date, `${what}: ${tab} и файл загрузки`, one, other);
            try {
                const m = buildFlightLegMetrics(row, ctx.firstByBase[e.base], ctx.todayStart);
                put('Динамика продаж и Экономическая таблица', 'Кресла', num(m.seats), seats);
                put('Динамика продаж и Экономическая таблица', 'Продано', num(m.load), sold);
                if (!closed && !flew) {
                    const z = /(\d+)%/.exec(String(m.zpk));
                    put('Динамика продаж и Экономическая таблица', 'Загрузка %', z ? +z[1] : null, pct);
                }
            } catch (x) { r.add(e.code, e.date, 'Динамика продаж и Экономическая таблица: ошибка расчёта', String(x && x.message || x), '—'); }
            try {
                const d = getDataLegMetrics(row);
                put('Загрузка рейсов', 'Кресла', d.seats, seats);
                put('Загрузка рейсов', 'Продано', d.load, sold);
                put('Загрузка рейсов', 'Загрузка %', d.zpk, pct);
            } catch (x) { r.add(e.code, e.date, 'Загрузка рейсов: ошибка расчёта', String(x && x.message || x), '—'); }
            try {
                const m = getRowMetrics(row, e.base);
                put('RMS', 'Кресла', m.total, seats);
                put('RMS', 'Продано', m.free, sold);
                put('RMS', 'Загрузка %', m.pct, pct);
            } catch (x) { r.add(e.code, e.date, 'RMS: ошибка расчёта', String(x && x.message || x), '—'); }
            // карточка рейса и «Сегодня» берут сквозной участок и прогноз
            try {
                if (typeof FlightInsights !== 'undefined' && !row.segKey && getFlightRowForDate(getBaseFlight(e.code), e.date, e.code) === row) {
                    const fc = FlightInsights.forecast(e.code, e.date);
                    if (fc && fc.seats != null) {
                        put('Карточка рейса и Сегодня', 'Кресла', fc.seats, seats);
                        put('Карточка рейса и Сегодня', 'Продано', fc.load, sold);
                    }
                }
            } catch (x) { r.add(e.code, e.date, 'Карточка рейса и Сегодня: ошибка расчёта', String(x && x.message || x), '—'); }
            await step();
        }
        return r;
    }

    // 2. билеты и выручка по вылету: сумма по билетам, сводные числа, таблицы
    async function chkTickets(ctx, step) {
        const r = newRes('tickets', 'Билеты и выручка по вылету: по билетам и в сводных числах', ['вылет', 'вылета', 'вылетов']);
        for (const k of ctx.keys) {
            r.checked++;
            const [date, code] = String(k).split('|');
            const code0 = String(code || '').split('~')[0];
            const d = ctx.direct.get(k);
            try {
                const st = PerfCache.getSalesStats(k);
                r.cmp(code0, date, 'Билетов: сводное число и сумма по билетам', st ? st.count : 0, d.n);
                r.cmp(code0, date, 'Выручка, ₽: сводное число и сумма по билетам', st ? Math.round(st.paidSum) : 0, Math.round(d.rev));
            } catch (x) { r.add(code0, date, 'Сводные числа: ошибка расчёта', String(x && x.message || x), '—'); }
            const rows = ctx.rowsByKey.get(k);
            if (rows && rows.length) {
                const list = rows.map(e => e.row);
                const first = buildFirstSalesRowByKey(list);
                const main = first.get(k);
                try {
                    r.cmp(code0, date, 'Выручка, ₽: таблицы и сумма по билетам', Math.round(getRevenueForRow(main, first)), Math.round(d.rev));
                    const m = buildFlightLegMetrics(main, first, ctx.todayStart);
                    r.cmp(code0, date, 'Выручка, ₽: Экономическая таблица и сумма по билетам', Math.round(m.revenueNum || 0), Math.round(d.rev));
                } catch (x) { r.add(code0, date, 'Выручка в таблицах: ошибка расчёта', String(x && x.message || x), '—'); }
            }
            await step();
        }
        return r;
    }

    // 3. за сегодня, вчера, 7, 14, 30 дней: пересчёт по датам сделок против сводных
    async function chkWindows(ctx, step) {
        const r = newRes('windows', 'Продано за сегодня, вчера, 7, 14 и 30 дней: пересчёт по датам продажи', ['вылет', 'вылета', 'вылетов']);
        const FIELDS = [['today', 'сегодня'], ['yesterday', 'вчера'], ['day2', 'позавчера'], ['d7', '7 дней'], ['d14', '14 дней'], ['d30', '30 дней']];
        for (const k of ctx.keys) {
            r.checked++;
            const [date, code] = String(k).split('|');
            const code0 = String(code || '').split('~')[0];
            const d = ctx.direct.get(k);
            const rows = ctx.rowsByKey.get(k);
            let shown = null;
            if (rows && rows.length) {
                const first = buildFirstSalesRowByKey(rows.map(e => e.row));
                try { shown = getSalesMapForRow(first.get(k)); } catch (x) { shown = null; }
            }
            const sm = salesMap[k] || {};
            FIELDS.forEach(([f, label]) => {
                r.cmp(code0, date, `Продано ${label}: сводное число и пересчёт`, sm[f] || 0, d[f]);
                if (shown) r.cmp(code0, date, `Продано ${label}: таблицы и пересчёт`, shown[f] || 0, d[f]);
            });
            await step();
        }
        // всего за сегодня: шапка сайта и пересчёт по всем билетам
        r.checked++;
        let sales = 0;
        let rev = 0;
        ctx.direct.forEach((d, k) => { sales += d.today; });
        ctx.keys.forEach(k => { (salesDetails[k] || []).forEach(s => { if (s && s.dealDate === ctx.todayStr) rev += Number(s.fare) || 0; }); });
        try {
            const kpi = PerfCache.getTodayKpi();
            r.cmp('все', ctx.todayStr, 'Продано за сегодня, всего: шапка и пересчёт', kpi.sales, sales);
            r.cmp('все', ctx.todayStr, 'Выручка за сегодня, ₽: шапка и пересчёт', Math.round(kpi.revenue), Math.round(rev));
            if (typeof getGlobalKPIs === 'function') r.cmp('все', ctx.todayStr, 'Продано за сегодня, всего: итог в шапке и пересчёт', getGlobalKPIs().todaySales, sales);
        } catch (x) { r.add('все', ctx.todayStr, 'Шапка: ошибка расчёта', String(x && x.message || x), '—'); }
        await step();
        return r;
    }

    // 4а. продано больше, чем кресел в продаже
    async function chkOver(ctx, step) {
        const r = newRes('over', 'Продано больше, чем кресел в продаже', ['вылет', 'вылета', 'вылетов']);
        for (const e of ctx.rows) {
            r.checked++;
            const seats = rawSeats(e.row);
            const sold = rawSold(e.row);
            if (sold > seats) r.add(e.code, e.date, 'Продано и кресла в продаже', sold, seats);
            await step();
        }
        return r;
    }

    // 4б. отрицательные числа в загрузке и в продажах
    async function chkNegative(ctx, step) {
        const r = newRes('negative', 'Отрицательные числа в загрузке и продажах', ['значение', 'значения', 'значений']);
        const names = { 5: 'Всего мест в файле', 6: 'Продано в файле', 8: 'Спец. брони в файле' };
        for (const e of ctx.rows) {
            [5, 6, 8].forEach(i => {
                r.checked++;
                const v = parseInt(e.row[i] || 0, 10);
                if (v < 0) r.add(e.code, e.date, names[i], v, 0);
            });
            await step();
        }
        for (const k of ctx.keys) {
            const [date, code] = String(k).split('|');
            const code0 = String(code || '').split('~')[0];
            const d = ctx.direct.get(k);
            r.checked++;
            if (d.neg) r.add(code0, date, 'Билетов с отрицательной ценой', d.neg, 0);
            const sm = salesMap[k];
            if (sm) {
                [['today', 'сегодня'], ['yesterday', 'вчера'], ['day2', 'позавчера'], ['d7', '7 дней'], ['d14', '14 дней'], ['d30', '30 дней']].forEach(([f, label]) => {
                    r.checked++;
                    if (sm[f] < 0) r.add(code0, date, 'Продано за ' + label + ', сводное число', sm[f], 0);
                });
            }
            await step();
        }
        return r;
    }

    // 4в. вылет есть в продажах, но нет в загрузке
    async function chkNoDeparture(ctx, step) {
        const r = newRes('nodep', 'Билеты есть, а вылета в загрузке нет', ['вылет с продажами', 'вылета с продажами', 'вылетов с продажами']);
        let tickets = 0;
        for (const k of ctx.keys) {
            r.checked++;
            const [date, code] = String(k).split('|');
            const code0 = String(code || '').split('~')[0];
            const has = ctx.rowsByKey.has(k) || (k.indexOf('~') < 0 && ctx.rowsByDep.has(k));
            if (!has) {
                const n = ctx.direct.get(k).n;
                tickets += n;
                r.add(code0, date, 'Билетов в продажах, строки вылета в загрузке нет', n, 0);
            }
            await step();
        }
        r.note = r.bad ? `Всего таких билетов: ${fmt(tickets)}` : '';
        return r;
    }

    // 4г. один вылет записан дважды
    async function chkDuplicates(ctx, step) {
        const r = newRes('dups', 'Дубли вылета', ['вылет', 'вылета', 'вылетов']);
        const seen = new Map();
        for (const row of allData || []) {
            if (!row || !row[0] || !row[1]) continue;
            const k = getFlightRowKey(row);
            if (!k) continue;
            seen.set(k, (seen.get(k) || 0) + 1);
            r.checked++;
        }
        seen.forEach((n, k) => { if (n > 1) { const p = k.split('|'); r.add(p[1], p[0], 'Строк одного вылета в загрузке', n, 1); } });
        // один вылет в двух рейсах-группах (участок чужого рейса с доп. посадкой не в счёт)
        ctx.rowsByDep.forEach((list, dk) => {
            const bases = new Set(list.filter(e => !e.row.segKey).map(e => e.base));
            if (bases.size > 1) { const p = dk.split('|'); r.add(p[1], p[0], 'Вылет лежит в нескольких рейсах-группах', bases.size, 1); }
        });
        await step(1);
        return r;
    }

    // 4д. туда и обратно: даты не дальше 2 дней
    async function chkPairs(ctx, step) {
        const r = newRes('pairs', 'Туда и обратно с разницей в датах больше 2 дней', ['пара рейсов', 'пары рейсов', 'пар рейсов']);
        for (const p of ctx.pairs) {
            try {
                const entries = buildPairTableEntries(getRowsForPairLeg(p.outbound), getRowsForPairLeg(p.inbound));
                entries.forEach(en => {
                    if (!en.outRow || !en.inRow) return;
                    r.checked++;
                    const a = dayNum(en.outRow[1]);
                    const b = dayNum(en.inRow[1]);
                    const diff = a != null && b != null ? b - a : null;
                    if (diff == null || diff < 0 || diff > 2) r.add(`${p.outbound} и ${p.inbound}`, en.outRow[1], `Дата обратного рейса ${en.inRow[1]}, разница в днях`, diff, 2);
                });
            } catch (x) { r.add(`${p.outbound} и ${p.inbound}`, '—', 'Пары: ошибка расчёта', String(x && x.message || x), '—'); }
            await step();
        }
        return r;
    }

    // 4е. рейс с посадками: продажи, расходы и субсидия считаются один раз
    async function chkSegments(ctx, step) {
        const r = newRes('segments', 'Рейс с посадками: продажи, расходы и субсидия не задвоены', ['вылет с посадками', 'вылета с посадками', 'вылетов с посадками']);
        for (const [k, list] of ctx.rowsByKey) {
            if (list.length < 2) continue;
            r.checked++;
            const [date, code] = k.split('|');
            const rows = list.map(e => e.row);
            const first = buildFirstSalesRowByKey(rows);
            const d = ctx.direct.get(k) || { rev: 0, today: 0 };
            try {
                const ms = rows.map(row => buildFlightLegMetrics(row, first, ctx.todayStart));
                r.cmp(code, date, 'Выручка, ₽: сумма по участкам и сумма по билетам', Math.round(ms.reduce((s, m) => s + (m.revenueNum || 0), 0)), Math.round(d.rev));
                r.cmp(code, date, 'Продано сегодня: сумма по участкам и пересчёт', ms.reduce((s, m) => s + (num(m.salesToday) || 0), 0), d.today);
                r.cmp(code, date, 'Участков с расходами', ms.filter(m => m.costNum > 0).length > 1 ? ms.filter(m => m.costNum > 0).length : 1, 1);
                r.cmp(code, date, 'Участков с субсидией', ms.filter(m => m.subsidyAmt > 0).length > 1 ? ms.filter(m => m.subsidyAmt > 0).length : 1, 1);
            } catch (x) { r.add(code, date, 'Участки: ошибка расчёта', String(x && x.message || x), '—'); }
            await step();
        }
        return r;
    }

    // сумма продаж по строкам таблицы, как в «Динамике продаж»: билеты на общем ключе один раз
    function rowWise(rows) {
        const first = buildFirstSalesRowByKey(rows);
        const s = { tSum: 0, ySum: 0, d2Sum: 0, d7Sum: 0, d14Sum: 0, d30Sum: 0 };
        rows.forEach(row => {
            if (!shouldAttachSalesToRowCached(row, first)) return;
            const m = getSalesMapForRow(row);
            s.tSum += m.today || 0; s.ySum += m.yesterday || 0; s.d2Sum += m.day2 || 0;
            s.d7Sum += m.d7 || 0; s.d14Sum += m.d14 || 0; s.d30Sum += m.d30 || 0;
        });
        return s;
    }

    function directSum(ctx, rows) {
        const seen = new Set();
        const s = { tSum: 0, ySum: 0, d2Sum: 0, d7Sum: 0, d14Sum: 0, d30Sum: 0 };
        rows.forEach(row => {
            const k = getSalesLookupKey(row);
            if (seen.has(k)) return;
            seen.add(k);
            const d = ctx.direct.get(k);
            if (!d) return;
            s.tSum += d.today; s.ySum += d.yesterday; s.d2Sum += d.day2; s.d7Sum += d.d7; s.d14Sum += d.d14; s.d30Sum += d.d30;
        });
        return s;
    }

    // 5а. «Динамика продаж»: строка «Всего» и сумма строк, все вылеты и только будущие
    async function chkTotalsDyn(ctx, step) {
        const r = newRes('totdyn', 'Итого в «Динамике продаж» и сумма строк', ['рейс', 'рейса', 'рейсов']);
        const LAB = { tSum: 'сегодня', ySum: 'вчера', d2Sum: 'позавчера', d7Sum: '7 дней', d14Sum: '14 дней', d30Sum: '30 дней' };
        for (const base of ctx.bases) {
            r.checked++;
            const all = ctx.byBase[base];
            const future = all.filter(row => { const d = parseLocalDate(row[1]); return d && d >= ctx.todayStart; });
            for (const [tag, rows] of [['все вылеты', all], ['будущие вылеты', future]]) {
                if (!rows.length) continue;
                try {
                    const total = sumUniqueSalesForRows(rows);
                    const byRows = rowWise(rows);
                    const direct = directSum(ctx, rows);
                    Object.keys(LAB).forEach(f => {
                        r.cmp(base, tag, `Итого ${LAB[f]}: итоговая строка и сумма строк`, total[f], byRows[f]);
                        r.cmp(base, tag, `Итого ${LAB[f]}: итоговая строка и пересчёт по билетам`, total[f], direct[f]);
                    });
                } catch (x) { r.add(base, tag, 'Итого: ошибка расчёта', String(x && x.message || x), '—'); }
            }
            await step();
        }
        return r;
    }

    // 5б. «Загрузка рейсов»: «Итого за сутки» и сумма строк
    async function chkTotalsData(ctx, step) {
        const r = newRes('totdata', 'Итого за сутки в «Загрузке рейсов» и сумма строк', ['направление', 'направления', 'направлений']);
        if (typeof buildDataDaySalesSumRow !== 'function' || typeof dataShowDaySales === 'undefined') { await step(ctx.pairs.length); return r; }
        const saveDay = dataShowDaySales;
        const saveHide = dataHideFlew;
        try {
            for (const p of ctx.pairs) {
                r.checked++;
                try {
                    dataShowDaySales = true;
                    dataHideFlew = false;
                    const html = buildDataDaySalesSumRow(p, ctx.todayStart);
                    const entries = getDataPairEntries(p, ctx.todayStart);
                    dataShowDaySales = saveDay;
                    dataHideFlew = saveHide;
                    if (!entries.length) { await step(); continue; }
                    const first = getDataEntriesFirstSales(entries);
                    const yest = (row) => {
                        if (!row || !shouldAttachSalesToRowCached(row, first)) return 0;
                        const d = ctx.direct.get(getSalesLookupKey(row));
                        return d ? d.yesterday : 0;
                    };
                    const out = entries.reduce((s, en) => s + yest(en.outRow), 0);
                    const inn = entries.reduce((s, en) => s + yest(en.inRow), 0);
                    const tpl = document.createElement('template');
                    tpl.innerHTML = '<table><tbody>' + html + '</tbody></table>';
                    const cells = [...tpl.content.querySelectorAll('.data-day-sum-cell strong')].map(x => num(x.textContent));
                    const all = tpl.content.querySelector('.data-block-avg strong');
                    const lab = `${p.outbound} и ${p.inbound}`;
                    r.cmp(lab, ctx.todayStr, 'Итого за сутки, туда: итоговая строка и пересчёт', cells[0], out);
                    r.cmp(lab, ctx.todayStr, 'Итого за сутки, обратно: итоговая строка и пересчёт', cells[1], inn);
                    r.cmp(lab, ctx.todayStr, 'Итого за сутки, всего: итоговая строка и пересчёт', all ? num(all.textContent) : null, out + inn);
                } catch (x) { r.add(`${p.outbound} и ${p.inbound}`, '—', 'Итого за сутки: ошибка расчёта', String(x && x.message || x), '—'); }
                await step();
            }
        } finally {
            dataShowDaySales = saveDay;
            dataHideFlew = saveHide;
        }
        return r;
    }

    // размер каждой проверки для полосы
    const CHECKS = [
        { run: chkLoad, size: c => c.rows.length },
        { run: chkTickets, size: c => c.keys.length },
        { run: chkWindows, size: c => c.keys.length + 1 },
        { run: chkOver, size: c => c.rows.length },
        { run: chkNegative, size: c => c.rows.length + c.keys.length },
        { run: chkNoDeparture, size: c => c.keys.length },
        { run: chkDuplicates, size: () => 1 },
        { run: chkPairs, size: c => c.pairs.length },
        { run: chkSegments, size: c => [...c.rowsByKey.values()].filter(l => l.length > 1).length },
        { run: chkTotalsDyn, size: c => c.bases.length },
        { run: chkTotalsData, size: c => c.pairs.length }
    ];

    async function runAll(rerender) {
        if (state.running) return;
        const sig = dataSig();
        state = { sig, res: null, running: true, done: 0, total: 1 };
        openId = '';
        if (rerender) rerender();
        const t0 = Date.now();
        const ctx = { done: 0, total: 1 };
        const step = makeStep(ctx);
        let out = null;
        try {
            await pause();
            const c = await buildCtx(() => step(0));
            c.done = 0;
            c.total = CHECKS.reduce((s, ch) => s + ch.size(c), 0);
            const stepC = makeStep(c);
            const checks = [];
            for (const ch of CHECKS) {
                let res;
                try { res = await ch.run(c, stepC); } catch (x) {
                    console.error(x);
                    res = newRes(ch.run.name, 'Проверка не выполнена', ['', '', '']);
                    res.add('—', '—', 'Ошибка проверки', String(x && x.message || x), '—');
                }
                checks.push(res);
                await pause();
            }
            c.done = c.total;
            paintProgress(c);
            out = { at: new Date(), ms: Date.now() - t0, checks };
        } finally {
            state.running = false;
            state.res = out && state.sig === dataSig() ? out : null;
            state.changed = !!out && !state.res;
        }
        if (rerender) rerender();
    }

    // ---------- экран ----------

    function exportData() {
        const res = state.res;
        if (!res || state.sig !== dataSig()) return { checks: [], rows: [], at: null };
        const rows = [];
        res.checks.forEach(c => c.examples.forEach(x => rows.push({ check: c.name, flight: x.flight, date: x.date, where: x.where, one: x.one, other: x.other })));
        return { at: res.at, checks: res.checks.map(c => ({ name: c.name, unit: unitOf(c), checked: c.checked, bad: c.bad, kept: c.examples.length })), rows };
    }

    function unitOf(c) { return pluralRu(c.checked, c.forms[0], c.forms[1], c.forms[2]); }

    function whenText(d) {
        const p = (n) => String(n).padStart(2, '0');
        return `${p(d.getDate())}.${p(d.getMonth() + 1)} в ${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    function tilesHtml(res) {
        const bad = res.checks.filter(c => c.bad).length;
        const t = (label, value, tone) => `<div class="rp-tile${tone ? ' rp-tile-' + tone : ''}"><div class="rp-tile-label">${esc(label)}</div><div class="rp-tile-value">${esc(value)}</div></div>`;
        return `<div class="rp-tiles sc-tiles">${t('Проверок', fmt(res.checks.length))}${t('Без расхождений', fmt(res.checks.length - bad))}${t('С расхождениями', fmt(bad), bad ? 'bad' : '')}</div>`;
    }

    function examplesHtml(c) {
        const list = c.examples.slice(0, SHOW);
        const more = c.bad > list.length ? `<p class="sc-more">Показано ${fmt(list.length)} из ${fmt(c.bad)}.${hasPerm('export_excel') ? ' Полный список в Excel.' : ''}</p>` : '';
        return `<tr class="sc-ex-row"><td colspan="3"><div class="rp-scroll sc-ex-scroll"><table class="rp-table sc-ex-table">
            <thead><tr><th>Рейс</th><th>Дата</th><th>Где</th><th>Одно число</th><th>Другое число</th></tr></thead>
            <tbody>${list.map(x => `<tr><td>${esc(x.flight)}</td><td>${esc(x.date)}</td><td class="rp-left">${esc(x.where)}</td><td>${esc(typeof x.one === 'number' ? fmt(x.one) : x.one)}</td><td>${esc(typeof x.other === 'number' ? fmt(x.other) : x.other)}</td></tr>`).join('')}</tbody>
        </table></div>${more}${c.note ? `<p class="sc-more">${esc(c.note)}</p>` : ''}</td></tr>`;
    }

    function resultHtml(res) {
        const rows = res.checks.map(c => {
            const open = openId === c.id && c.bad;
            const name = c.bad
                ? `<button type="button" class="sc-name" data-sc-open="${esc(c.id)}" aria-expanded="${open ? 'true' : 'false'}"><span class="sc-caret">${open ? '▾' : '▸'}</span> ${esc(c.name)}</button>`
                : `<span class="sc-name sc-name-plain">${esc(c.name)}</span>`;
            return `<tr class="${c.bad ? 'sc-bad' : ''}"><td class="rp-left">${name}</td><td>${fmt(c.checked)} ${esc(unitOf(c))}</td><td class="${c.bad ? 'sc-num-bad' : 'sc-num-ok'}">${fmt(c.bad)}</td></tr>${open ? examplesHtml(c) : ''}`;
        }).join('');
        const anyBad = res.checks.some(c => c.bad);
        return `${tilesHtml(res)}
            ${anyBad ? '' : '<p class="rp-ok">Расхождений нет.</p>'}
            <div class="rp-scroll sc-scroll"><table class="rp-table sc-table">
                <thead><tr><th>Проверка</th><th>Сверено</th><th>Расхождений</th></tr></thead>
                <tbody>${rows}</tbody>
            </table></div>`;
    }

    function card(rerender) {
        const live = state.res && state.sig === dataSig() ? state.res : null;
        const exp = hasPerm('export_excel') ? `<button type="button" class="btn-primary rp-btn" id="sc-export"${live ? '' : ' disabled'}>В Excel</button>` : '';
        let body;
        if (state.running) {
            const pct = state.total ? Math.min(100, Math.round(state.done / state.total * 100)) : 0;
            body = `<div class="sc-prog"><div class="sc-bar"><div class="sc-bar-in" id="sc-bar-in" style="width:${pct}%"></div></div><span class="sc-bar-text" id="sc-bar-text">Проверено ${fmt(Math.min(state.done, state.total))} из ${fmt(state.total)}</span></div>`;
        } else if (live) {
            body = resultHtml(live);
        } else {
            body = `<p class="rp-note">${state.changed ? 'Данные изменились, пока шла проверка. Проверьте заново.' : (state.sig ? 'Данные изменились. Проверьте заново.' : 'Нажмите «Проверить».')}</p>`;
        }
        const when = live ? `<span class="sc-when">Проверено ${esc(whenText(live.at))}</span>` : '';
        return `<section class="rp-card sc-card" id="rp-selfcheck">
            <div class="rp-card-head"><div class="rp-card-heading"><h3 class="rp-card-title">Проверка расчётов</h3></div>${exp}</div>
            <p class="rp-card-text">Сайт сверяет одни и те же числа в разных вкладках.</p>
            <div class="sc-ctl"><button type="button" class="filter-btn sc-run" id="sc-run"${state.running ? ' disabled' : ''}>${live ? 'Проверить заново' : 'Проверить'}</button>${when}</div>
            ${body}
        </section>`;
    }

    function handleClick(btn, rerender) {
        if (btn.id === 'sc-run') {
            if (!canView() || !hasData()) return true;
            runAll(rerender).catch(e => { console.error(e); state.running = false; if (rerender) rerender(); });
            return true;
        }
        if (btn.dataset.scOpen) {
            openId = openId === btn.dataset.scOpen ? '' : btn.dataset.scOpen;
            rerender();
            return true;
        }
        return false;
    }

    return { canView, card, handleClick, exportData, running: () => state.running, _checks: { chkLoad, chkTickets, chkWindows, chkOver, chkNegative, chkNoDeparture, chkDuplicates, chkPairs, chkSegments, chkTotalsDyn, chkTotalsData }, _run: runAll };
})();
