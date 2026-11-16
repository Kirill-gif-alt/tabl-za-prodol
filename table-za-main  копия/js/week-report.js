// отчёт "Неделя" (Отчёты): один лист для руководства за полную неделю пн-вс
// улетевшие рейсы берём как отчёт для экономистов (ReportsView.collectWeek) и архив продаж, решения - из DecisionMoney, запросы - из LowReqReport
// тяжёлое (рубли по решениям, прогноз на следующую неделю) считаем порциями и храним до смены данных
window.WeekReport = (function () {
    const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

    let sel = null;            // понедельник выбранной недели (Date)
    let lastRerender = null;
    let rev = 0;
    const cache = new Map();   // ключ данных и недели -> результат
    const busy = new Set();
    let marksAsked = false;
    let marksReady = false;
    const monthsAsked = new Set();

    function esc(v) { return escHtml(v); }
    function hasPerm(p) { return typeof ProfileAuth === 'undefined' || ProfileAuth.hasPermission(p); }
    function fmt(n) { return n == null || !isFinite(n) ? '—' : Math.round(n).toLocaleString('ru-RU'); }
    function hasData() { return typeof groupedData !== 'undefined' && groupedData && Object.keys(groupedData).length > 0; }
    function canView() { return true; }
    function canDecisions() { return typeof DecisionsReport !== 'undefined' && DecisionsReport.canView() && typeof SalesManagement !== 'undefined' && SalesManagement.allMarks && typeof DecisionMoney !== 'undefined'; }
    function canLowReq() { return typeof LowReqReport !== 'undefined' && LowReqReport.canView(); }

    function dayStart(d) { const t = new Date(d.getTime()); t.setHours(0, 0, 0, 0); return t; }
    function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
    function today() { return dayStart(parseLocalDate(getTodayDate()) || new Date()); }
    function mondayOf(d) { const t = dayStart(d); return addDays(t, -((t.getDay() + 6) % 7)); }
    function ru(d) { return formatDateRu(d); }
    function iso(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
    function lastFull() { return addDays(mondayOf(today()), -7); }

    // 9-15 ноября 2026; через месяц и год подпись длиннее
    function label(mon) {
        const a = mon;
        const b = addDays(mon, 6);
        if (a.getFullYear() !== b.getFullYear()) return `${a.getDate()} ${MONTHS[a.getMonth()]} ${a.getFullYear()} – ${b.getDate()} ${MONTHS[b.getMonth()]} ${b.getFullYear()}`;
        if (a.getMonth() !== b.getMonth()) return `${a.getDate()} ${MONTHS[a.getMonth()]} – ${b.getDate()} ${MONTHS[b.getMonth()]} ${b.getFullYear()}`;
        return `${a.getDate()}–${b.getDate()} ${MONTHS[b.getMonth()]} ${b.getFullYear()}`;
    }

    function sigBase() {
        return [typeof dataEpoch === 'number' ? dataEpoch : 0, getTodayDate(),
            typeof SalesArchive !== 'undefined' && SalesArchive.revision ? SalesArchive.revision() : 0,
            typeof SalesManagement !== 'undefined' && SalesManagement.markRevision ? SalesManagement.markRevision() : 0,
            typeof Params !== 'undefined' && Params.revision ? Params.revision() : 0].join('|');
    }

    function sigLow() {
        return sigBase() + '|' + (typeof LowReqReport !== 'undefined' && LowReqReport.revision ? LowReqReport.revision() : '');
    }

    const pause = () => new Promise(r => setTimeout(r, 6));
    function makeYield() {
        let t = performance.now();
        return async () => { if (performance.now() - t > 8) { await pause(); t = performance.now(); } };
    }

    function bump() { rev++; if (typeof lastRerender === 'function' && document.getElementById('wk-root')) lastRerender(); }

    // ---------- самая ранняя неделя с данными ----------
    let earliestMemo = { sig: '', mon: null };
    function earliest() {
        const sig = sigBase();
        if (earliestMemo.sig === sig) return earliestMemo.mon;
        let min = null;
        Object.keys(groupedData || {}).forEach(base => (groupedData[base] || []).forEach(row => {
            const d = row && row[1] ? parseLocalDate(row[1]) : null;
            if (d && (!min || d < min)) min = d;
        }));
        if (typeof SalesArchive !== 'undefined' && SalesArchive.entries) {
            SalesArchive.entries().forEach(x => { const d = parseLocalDate(x.date); if (d && (!min || d < min)) min = d; });
        }
        earliestMemo = { sig, mon: min ? mondayOf(min) : null };
        return earliestMemo.mon;
    }

    // ---------- улетевшие рейсы недели ----------
    function revenueOf(date, code) {
        const list = (typeof salesDetails !== 'undefined' && salesDetails ? salesDetails[`${date}|${code}`] : null) || [];
        let sum = 0;
        list.forEach(s => { sum += Number(s && s.fare) || 0; });
        // в архиве вариант с большим числом билетов: ранние продажи могли выпасть из окна выгрузки (как слияние в sales-archive.js)
        const a = typeof SalesArchive !== 'undefined' && SalesArchive.entryFor ? SalesArchive.entryFor(date, code) : null;
        if (a && a.t > list.length) return a.rev || 0;
        return sum;
    }

    function pct(a, b) { return b > 0 ? Math.round(a / b * 100) : null; }

    function weekStats(mon) {
        if (cache.size > 300) cache.clear();
        const key = 'w|' + sigBase() + '|' + mon.getTime();
        if (cache.has(key)) return cache.get(key);
        const week = { from: mon, to: addDays(mon, 6) };
        const t0 = today().getTime();
        const items = (typeof ReportsView !== 'undefined' && ReportsView.collectWeek ? ReportsView.collectWeek(week, false) : [])
            .filter(f => f.time < t0)
            .map(f => ({ code: f.code, date: f.date, direction: f.direction, seats: f.seats || 0, sold: f.sold || 0, rev: revenueOf(f.date, f.code), known: true }));
        // вылеты, которых уже нет в файлах, но есть в архиве
        if (typeof SalesArchive !== 'undefined' && SalesArchive.entries) {
            const have = new Set(items.map(f => f.date + '|' + f.code));
            SalesArchive.entries().forEach(x => {
                const d = parseLocalDate(x.date);
                if (!d || d < week.from || d > week.to || d.getTime() >= t0 || have.has(x.date + '|' + x.code)) return;
                if (typeof closedFlights !== 'undefined' && closedFlights.has(x.date + '|' + x.code)) return;
                have.add(x.date + '|' + x.code);
                items.push({ code: x.code, date: x.date, direction: getFlightDirection(x.code), seats: x.e.s || 0, sold: x.e.sold || 0, rev: x.e.rev || 0, known: (x.e.s || 0) > 0 });
            });
        }
        const dirs = new Map();
        const total = { flights: 0, pax: 0, seats: 0, soldSeats: 0, rev: 0 };
        const add = (acc, f) => {
            acc.flights++;
            acc.pax += f.sold;
            acc.rev += f.rev;
            if (f.known) { acc.seats += f.seats; acc.soldSeats += f.sold; }
        };
        items.forEach(f => {
            add(total, f);
            if (!dirs.has(f.direction)) dirs.set(f.direction, { name: f.direction, flights: 0, pax: 0, seats: 0, soldSeats: 0, rev: 0 });
            add(dirs.get(f.direction), f);
        });
        total.load = pct(total.soldSeats, total.seats);
        dirs.forEach(d => { d.load = pct(d.soldSeats, d.seats); });
        const res = { week, items, total, dirs };
        cache.set(key, res);
        return res;
    }

    // ---------- решения по ценам ----------
    function weekMarks(mon) {
        const from = mon;
        const to = addDays(mon, 6);
        const out = [];
        const seen = new Map();
        SalesManagement.allMarks().forEach(m => {
            if (m.status !== 'down' && m.status !== 'up' && m.status !== 'attn') return;
            const c = parseLocalDate(m.check);
            if (!c || c < from || c > to) return;
            // одно решение от двух людей считаем один раз, как в "Решениях"
            const dk = [m.flight, m.dep, m.check, m.status].join('|');
            if (seen.has(dk)) {
                const r0 = seen.get(dk);
                if (String(m.updatedAt || '') > String(r0.at || '')) r0.at = m.updatedAt;
                return;
            }
            const r = { code: m.flight, dep: m.dep, check: m.check, status: m.status, at: m.updatedAt || '', clsFrom: m.clsFrom || '', clsTo: m.clsTo || '' };
            seen.set(dk, r);
            out.push(r);
        });
        const price = out.filter(r => r.status !== 'attn');
        if (typeof PriceMarks !== 'undefined' && PriceMarks.markOverlaps) PriceMarks.markOverlaps(price);
        return out;
    }

    function countMarks(mon) {
        if (!canDecisions() || !marksReady) return null;
        const list = weekMarks(mon);
        return { up: list.filter(r => r.status === 'up').length, down: list.filter(r => r.status === 'down').length, attn: list.filter(r => r.status === 'attn').length };
    }

    // итог решения: зафиксированный в DecisionMoney или свежий расчёт без записи в общую папку
    function resultOf(r) {
        const key = DecisionMoney.keyOf(r);
        const frozen = DecisionMoney.get(key);
        if (frozen && frozen.v === DecisionMoney.METHOD_VERSION && (frozen.stage === 'final' || (frozen.stage === 'prelim' && r.status === 'up'))) return frozen;
        try { return DecisionMoney.compute(r); } catch (e) { return { stage: 'na', reason: 'ошибка расчёта' }; }
    }

    // сработало и итог в рублях по тем же правилам, что итоги в "Решениях" (moneyTotals)
    function decisionStats(mon) {
        const key = 'd|' + sigBase() + '|' + mon.getTime();
        if (cache.has(key)) return cache.get(key);
        if (!canDecisions() || !marksReady) return null;
        if (busy.has(key)) return null;
        busy.add(key);
        (async () => {
            const list = weekMarks(mon);
            const price = list.filter(r => r.status !== 'attn');
            const months = [...new Set(price.map(r => r.check.slice(3)).filter(Boolean))];
            try { await DecisionMoney.ensureMonths(months.map(m => `${m.slice(3)}-${m.slice(0, 2)}`)); } catch (e) { /* что есть */ }
            const dm = [...new Set(price.map(r => r.dep.slice(3)))].map(m => `${m.slice(3)}-${m.slice(0, 2)}`);
            if (typeof SalesDayLog !== 'undefined' && SalesDayLog.ensureMonths) { try { await SalesDayLog.ensureMonths(dm); } catch (e) { /* без журнала */ } }
            const tick = makeYield();
            const kinds = { up: { n: 0, good: 0, sum: 0, judged: 0 }, down: { n: 0, good: 0, sum: 0, judged: 0 } };
            let waiting = 0;
            let judged = 0;
            for (const r of price) {
                await tick();
                const k = kinds[r.status];
                k.n++;
                if (r.overlap) continue;
                const m = resultOf(r);
                if (!m || m.stage === 'wait' || m.stage === 'prelim') { waiting++; continue; }
                if (m.stage === 'na') continue;
                k.judged++;
                judged++;
                k.sum += (m.delta || 0) + (m.corr || 0);
                const rough = (m.verdict === 'worked' || m.verdict === 'failed') && m.grade === 'C';
                if (rough ? (m.delta > 0) : (m.verdict === 'worked' || m.verdict === 'lean_pos' || m.verdict === 'weak_pos')) k.good++;
            }
            const attn = list.filter(r => r.status === 'attn').length;
            cache.set(key, { up: kinds.up, down: kinds.down, attn, waiting, judged, n: kinds.up.n + kinds.down.n });
            busy.delete(key);
            bump();
        })().catch(e => { console.warn('WeekReport decisions', e); busy.delete(key); cache.set(key, { up: { n: 0, good: 0, sum: 0, judged: 0 }, down: { n: 0, good: 0, sum: 0, judged: 0 }, attn: 0, waiting: 0, judged: 0, n: 0, failed: true }); });
        return null;
    }

    // ---------- запросы на снижение ----------
    // свой период отчёта на время чтения ставим на неделю и возвращаем как был
    function lowReq(mon) {
        if (!canLowReq()) return null;
        const key = 'l|' + sigLow() + '|' + mon.getTime();
        if (cache.has(key)) return cache.get(key);
        const saved = Object.assign({}, CustomPeriod.state('low'));
        let t = null;
        try {
            CustomPeriod.set('low', { on: true, from: iso(mon), to: iso(addDays(mon, 6)) });
            t = LowReqReport.exportData().totals;
        } catch (e) { t = null; } finally {
            CustomPeriod.set('low', { on: !!saved.on, from: saved.from || '', to: saved.to || '' });
        }
        const res = t ? { n: t.n, yes: t.yes, no: t.no, wait: t.wait } : null;
        cache.set(key, res);
        return res;
    }

    // ---------- следующая неделя ----------
    function nextWeek(mon) {
        const key = 'n|' + sigBase() + '|' + mon.getTime();
        if (cache.has(key)) return cache.get(key);
        if (busy.has(key)) return null;
        busy.add(key);
        (async () => {
            const week = { from: mon, to: addDays(mon, 6) };
            const flights = typeof ReportsView !== 'undefined' && ReportsView.collectWeek ? ReportsView.collectWeek(week, false) : [];
            const tick = makeYield();
            const rows = [];
            for (const f of flights) {
                await tick();
                let fc = null;
                try { fc = typeof FlightInsights !== 'undefined' ? FlightInsights.forecast(f.code, f.date) : null; } catch (e) { fc = null; }
                const ok = !!(fc && fc.final != null && fc.seats > 0);
                rows.push({ code: f.code, date: f.date, direction: f.direction, seats: f.seats, sold: f.sold, final: ok ? fc.final : null, fcSeats: ok ? fc.seats : 0, lf: ok ? Math.round(fc.final / fc.seats * 100) : null });
            }
            const withFc = rows.filter(r => r.lf != null);
            const res = {
                week, rows,
                flights: rows.length,
                seats: rows.reduce((s, r) => s + r.seats, 0),
                sold: rows.reduce((s, r) => s + r.sold, 0),
                fcN: withFc.length,
                lf: pct(withFc.reduce((s, r) => s + r.final, 0), withFc.reduce((s, r) => s + r.fcSeats, 0)),
                lowest: withFc.slice().sort((a, b) => (a.lf - b.lf) || (parseLocalDate(a.date) - parseLocalDate(b.date)) || a.code.localeCompare(b.code, 'ru', { numeric: true })).slice(0, 5)
            };
            cache.set(key, res);
            busy.delete(key);
            bump();
        })().catch(e => { console.warn('WeekReport next', e); busy.delete(key); cache.set(key, { week: { from: mon, to: addDays(mon, 6) }, rows: [], flights: 0, seats: 0, sold: 0, fcN: 0, lf: null, lowest: [] }); });
        return null;
    }

    // ---------- слова про изменение ----------
    function relWord(cur, prev, up, down) {
        if (prev == null || !(prev > 0)) return 'неделей раньше данных нет';
        const d = Math.round((cur - prev) / prev * 100);
        if (d === 0) return 'столько же, сколько неделей раньше';
        return `на ${Math.abs(d)}% ${d > 0 ? up : down}, чем неделей раньше`;
    }
    function ppWord(cur, prev) {
        if (cur == null || prev == null) return 'неделей раньше данных нет';
        const d = cur - prev;
        if (d === 0) return 'столько же, сколько неделей раньше';
        return `на ${Math.abs(d)} ${pluralRu(Math.abs(d), 'пункт', 'пункта', 'пунктов')} ${d > 0 ? 'выше' : 'ниже'}, чем неделей раньше`;
    }
    function countWord(cur, prev) {
        if (prev == null) return 'неделей раньше данных нет';
        const d = cur - prev;
        if (d === 0) return 'столько же, сколько неделей раньше';
        return `на ${Math.abs(d)} ${pluralRu(Math.abs(d), 'решение', 'решения', 'решений')} ${d > 0 ? 'больше' : 'меньше'}, чем неделей раньше`;
    }
    function ppShort(cur, prev) {
        if (cur == null || prev == null) return '—';
        const d = cur - prev;
        return d === 0 ? 'так же' : `${d > 0 ? '+' : '−'}${Math.abs(d)} ${pluralRu(Math.abs(d), 'пункт', 'пункта', 'пунктов')}`;
    }

    // ---------- сборка листа ----------
    function build() {
        const mon = sel;
        const cur = weekStats(mon);
        const prevMon = addDays(mon, -7);
        const prev = weekStats(prevMon);
        const dec = canDecisions() ? decisionStats(mon) : null;
        const counts = countMarks(mon);
        const prevCounts = countMarks(prevMon);
        const low = lowReq(mon);
        const nextMon = addDays(mon, 7);
        const next = nextWeek(nextMon);
        return { mon, cur, prev, dec, counts, prevCounts, low, next, nextMon };
    }

    function tiles(b) {
        const t = b.cur.total;
        const p = b.prev.items.length ? b.prev.total : null;
        const list = [
            { label: 'Пассажиров улетело', value: fmt(t.pax), sub: relWord(t.pax, p && p.pax, 'больше', 'меньше') },
            { label: 'Загрузка кресел, %', value: t.load == null ? '—' : String(t.load), sub: ppWord(t.load, p && p.load) },
            { label: 'Выручка, ₽', value: fmt(t.rev), sub: relWord(t.rev, p && p.rev, 'больше', 'меньше') }
        ];
        if (b.counts) {
            const n = b.counts.up + b.counts.down;
            const pn = b.prevCounts ? b.prevCounts.up + b.prevCounts.down : null;
            list.push({ label: 'Решений по ценам принято', value: fmt(n), sub: countWord(n, pn) });
        } else if (canDecisions()) list.push({ label: 'Решений по ценам принято', value: '…', sub: '' });
        return list;
    }

    function dirRows(b) {
        const rows = [...b.cur.dirs.values()].sort((a, c) => (c.rev - a.rev) || (c.pax - a.pax) || a.name.localeCompare(c.name, 'ru'));
        return rows.map(d => {
            const p = b.prev.dirs.get(d.name);
            return { name: d.name, flights: d.flights, pax: d.pax, load: d.load, rev: d.rev, change: ppShort(d.load, p ? p.load : null) };
        });
    }

    function totalRow(b) {
        const t = b.cur.total;
        const p = b.prev.items.length ? b.prev.total : null;
        return { name: 'Итого', flights: t.flights, pax: t.pax, load: t.load, rev: t.rev, change: ppShort(t.load, p ? p.load : null) };
    }

    // ---------- экран ----------
    function table(heads, rows, cls) {
        return `<div class="rp-scroll"><table class="rp-table wk-table ${cls || ''}"><thead><tr>${heads.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
    }

    function dirTableHtml(b) {
        const rows = dirRows(b);
        const cell = (r, tot) => `<tr${tot ? ' class="rp-total"' : ''}><td class="rp-left">${esc(r.name)}</td><td>${fmt(r.flights)}</td><td>${fmt(r.pax)}</td><td>${r.load == null ? '—' : r.load}</td><td>${fmt(r.rev)}</td><td>${esc(r.change)}</td></tr>`;
        return table(['Направление', 'Рейсов', 'Пассажиров', 'Загрузка, %', 'Выручка, ₽', 'Загрузка к прошлой неделе'],
            rows.map(r => cell(r, false)).join('') + cell(totalRow(b), true));
    }

    function decisionsHtml(b) {
        if (!canDecisions()) return '';
        const head = ReportsView.head('Решения по ценам за неделю', '', '');
        if (!b.dec) return `<section class="rp-card wk-card">${head}<p class="rp-note">Считаем…</p></section>`;
        const d = b.dec;
        const c = b.counts || { up: d.up.n, down: d.down.n, attn: d.attn };
        const row = (name, n, k) => `<tr><td class="rp-left">${name}</td><td>${fmt(n)}</td><td>${k ? fmt(k.good) : '—'}</td><td>${k ? sign(k.sum) : '—'}</td></tr>`;
        const sum = d.up.sum + d.down.sum;
        const tot = `<tr class="rp-total"><td class="rp-left">Всего</td><td>${fmt(c.up + c.down + c.attn)}</td><td>${fmt(d.up.good + d.down.good)}</td><td>${sign(sum)}</td></tr>`;
        const wait = d.waiting ? `<p class="wk-foot">Ещё ждём итога по ${fmt(d.waiting)} ${pluralRu(d.waiting, 'решению', 'решениям', 'решениям')}: они войдут в следующий лист.</p>` : '';
        return `<section class="rp-card wk-card">${head}${table(['Решение', 'Принято', 'Сработало', 'Итог, ₽'], row('Повышение', c.up, d.up) + row('Снижение', c.down, d.down) + row('Внимание', c.attn, null) + tot)}${wait}</section>`;
    }

    function sign(n) {
        const v = Math.round(n || 0);
        return (v > 0 ? '+' : (v < 0 ? '−' : '')) + Math.abs(v).toLocaleString('ru-RU');
    }

    function lowReqHtml(b) {
        if (!b.low) return '';
        const l = b.low;
        return `<section class="rp-card wk-card">${ReportsView.head('Запросы на снижение за неделю', '', '')}${table(['Запросов', 'Согласовано', 'Не согласовано', 'Ждём ответа'], `<tr><td>${fmt(l.n)}</td><td>${fmt(l.yes)}</td><td>${fmt(l.no)}</td><td>${fmt(l.wait)}</td></tr>`, 'wk-center')}</section>`;
    }

    function nextHtml(b) {
        const head = ReportsView.head(`Следующая неделя: ${label(b.nextMon)}`, '', '');
        const n = b.next;
        if (!n) return `<section class="rp-card wk-card">${head}<p class="rp-note">Считаем…</p></section>`;
        if (!n.flights) return `<section class="rp-card wk-card">${head}<p class="rp-note">Рейсов на этой неделе в данных нет.</p></section>`;
        const main = table(['Рейсов', 'Кресел', 'Уже продано', 'Прогноз загрузки, %'], `<tr><td>${fmt(n.flights)}</td><td>${fmt(n.seats)}</td><td>${fmt(n.sold)}</td><td>${n.lf == null ? '—' : n.lf}</td></tr>`, 'wk-center');
        const low = n.lowest.length
            ? `<h4 class="wk-sub">Пять рейсов с самой низкой прогнозной загрузкой</h4>${table(['Рейс', 'Направление', 'Дата', 'Продано', 'Кресел', 'Прогноз загрузки, %'], n.lowest.map(r => `<tr><td>${esc(r.code)}</td><td class="rp-left">${esc(r.direction)}</td><td>${esc(r.date)}</td><td>${fmt(r.sold)}</td><td>${fmt(r.seats)}</td><td>${r.lf}</td></tr>`).join(''), 'wk-low')}`
            : '<p class="rp-note">Прогноза по рейсам этой недели нет.</p>';
        return `<section class="rp-card wk-card">${head}${main}${low}</section>`;
    }

    function ready(b) {
        return !!(b.cur.items.length && (!canDecisions() || b.dec) && b.next);
    }

    function html(rerender) {
        if (typeof rerender === 'function') lastRerender = rerender;
        if (!hasData()) return '<section class="rp-card wk-card"><p class="rp-note">Данных нет — нажмите «Загрузить» или «Последние».</p></section>';
        const first = earliest();
        const maxMon = lastFull();
        if (!sel || sel > maxMon) sel = maxMon;
        if (first && sel < first) sel = first;
        prepare();
        const b = build();
        const exp = hasPerm('export_excel') ? `<button type="button" class="btn-primary rp-btn" id="wk-export"${ready(b) ? '' : ' disabled'}>В Excel</button>` : '';
        const canBack = !!first && addDays(sel, -7) >= first;
        const canFwd = sel < maxMon;
        const nav = `<div class="wk-nav">
            <button type="button" class="filter-btn wk-step" data-wk-step="-1" aria-label="Неделя раньше"${canBack ? '' : ' disabled'}>‹</button>
            <span class="wk-label" id="wk-label">${esc(label(sel))}</span>
            <button type="button" class="filter-btn wk-step" data-wk-step="1" aria-label="Неделя позже"${canFwd ? '' : ' disabled'}>›</button>
            <span class="wk-sp"></span>${exp}</div>`;
        if (!b.cur.items.length) return `<div id="wk-root">${nav}<section class="rp-card wk-card"><p class="rp-note">За эту неделю данных нет.</p></section></div>`;
        return `<div id="wk-root">${nav}${ReportsView.tiles(tiles(b))}
            <section class="rp-card wk-card">${ReportsView.head('По направлениям', '', '')}${dirTableHtml(b)}</section>
            ${decisionsHtml(b)}${lowReqHtml(b)}${nextHtml(b)}</div>`;
    }

    // отметки и архив читаем один раз; когда пришли, перерисовываем
    function prepare() {
        if (!marksAsked && typeof SalesManagement !== 'undefined' && SalesManagement.load) {
            marksAsked = true;
            SalesManagement.load().then(() => { marksReady = true; cache.clear(); bump(); }).catch(() => { marksReady = true; cache.clear(); bump(); });
        } else if (typeof SalesManagement === 'undefined' || !SalesManagement.load) { marksAsked = true; marksReady = true; }
        if (typeof SalesArchive !== 'undefined' && SalesArchive.ensureMonths && sel) {
            const months = [];
            for (let i = -7; i <= 13; i += 7) { const d = addDays(sel, i); months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`); }
            const need = [...new Set(months)].filter(m => !monthsAsked.has(m));
            if (need.length) {
                need.forEach(m => monthsAsked.add(m));
                SalesArchive.ensureMonths(need).then(ch => { if (ch) bump(); }).catch(() => {});
            }
        }
    }

    function handleClick(btn, rerender) {
        if (btn.dataset.wkStep != null) {
            if (rerender) lastRerender = rerender;
            sel = addDays(sel || lastFull(), 7 * parseInt(btn.dataset.wkStep, 10));
            rev++;
            rerender();
            return true;
        }
        return false;
    }

    // для Excel: тот же лист данными
    function exportData() {
        if (!hasData() || !sel) return null;
        const b = build();
        if (!b.cur.items.length || !ready(b)) return null;
        const tl = tiles(b);
        return {
            label: label(sel),
            tiles: tl.map(t => ({ label: t.label, value: t.value, sub: t.sub })),
            dirs: dirRows(b),
            total: totalRow(b),
            decisions: canDecisions() && b.dec ? { up: { n: (b.counts || { up: b.dec.up.n }).up, good: b.dec.up.good, sum: Math.round(b.dec.up.sum) }, down: { n: (b.counts || { down: b.dec.down.n }).down, good: b.dec.down.good, sum: Math.round(b.dec.down.sum) }, attn: (b.counts || { attn: b.dec.attn }).attn, waiting: b.dec.waiting } : null,
            low: b.low,
            next: { label: label(b.nextMon), flights: b.next.flights, seats: b.next.seats, sold: b.next.sold, lf: b.next.lf, lowest: b.next.lowest }
        };
    }

    return { canView, html, handleClick, exportData, revision: () => rev + '|' + (sel ? sel.getTime() : 0), _stats: weekStats, _decisions: (mon) => decisionStats(mon || sel), _select: (d) => { sel = d; } };
})();
