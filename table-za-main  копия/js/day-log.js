// Ежедневный журнал продаж по вылетам (shared/history/daylog-ГГГГ-ММ.json, месяц — по ДАТЕ ВЫЛЕТА).
// Строится из живых билетов (salesDetails) и накапливается: ранние продажи выпадают из окна выгрузки,
// а в журнале остаются — по каждому «дню до вылета» (dtd): сколько билетов какого класса и по какой сумме.
//   { version: 1, updatedAt, flights: { 'дд.мм.гггг|KV-101': { s: кресел|0, d: { '<dtd>': {
//       k: { V: [число, сумма], K: [...] }   — взрослые платные по классам бронирования
//       z: нулевые (цена 0)   g: групповые (заказ от PV.GROUP_MIN билетов, любой тариф)
//       o: прочие платные (детские, младенцы, льготные)   cut: 1 — день среза данных, мог быть неполным
//       (z, g, o, cut — только если не ноль)
//       p: платных билетов всех видов (с группами и детскими)   r: выручка по ним, ₽ (по фактическому тарифу) } } } } }
// День сделки = дата вылета минус dtd. По журналу строятся «продажи по дням» (daysFor) и средний тариф в карточке рейса,
// а расчёт рублей по решениям (decision-money.js) берёт из него дни, которых уже нет в файле продаж.
// Без ФИО, PNR и дат рождения — только счётчики и суммы. Пишет только публикующий (share_data), в простое, порциями,
// не чаще раза на новые данные. Читается лениво (ensureMonths) — теми, у кого есть право.
window.SalesDayLog = (function () {
    const DONE_KEY = 'krasavia_daylog_done';
    const KEEP_RATIO = 0.8;   // новый вылет с числом билетов < 80% от записанного — обрезанная выгрузка, старое не трогаем
    const MAX_DTD = 365;

    const store = Object.create(null);   // 'дд.мм.гггг|KV-101' → запись вылета из загруженных файлов
    const loadedMonths = new Set();
    const inflight = new Map();
    let rev = 0;
    let running = null;

    function pad(n) { return String(n).padStart(2, '0'); }

    function monthOf(dateStr) {
        const d = parseLocalDate(dateStr);
        return d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}` : '';
    }

    function groupMin() {
        return typeof PV !== 'undefined' && PV.GROUP_MIN > 0 ? PV.GROUP_MIN : 5;
    }

    function cutoffStr() {
        if (typeof salesDataCutoffTime !== 'function') return '';
        const t = salesDataCutoffTime();
        return t ? formatDateRu(new Date(t)) : '';
    }

    // Читать может любой вошедший: в журнале нет ФИО, PNR и дат рождения, только счётчики и суммы.
    function canUse() {
        if (typeof ProfileAuth === 'undefined' || !ProfileAuth.getCurrentProfile) return false;
        return !!ProfileAuth.getCurrentProfile();
    }

    // Окно файла продаж: от самой ранней до самой поздней даты сделки в нём (мс). Дни внутри окна берутся из файла,
    // за его пределами — из журнала. Считается один раз на загрузку данных.
    let winMemo = { ref: null, epoch: -1, win: null };
    function fileWindow() {
        const sd = typeof salesDetails !== 'undefined' ? salesDetails : null;
        if (!sd) return null;
        const epoch = typeof dataEpoch === 'number' ? dataEpoch : 0;
        if (winMemo.ref === sd && winMemo.epoch === epoch) return winMemo.win;
        const seen = new Set();
        const keys = Object.keys(sd);
        for (let i = 0; i < keys.length; i++) {
            const l = sd[keys[i]];
            for (let j = 0; j < l.length; j++) seen.add(l[j].dealDate);
        }
        let lo = Infinity;
        let hi = -Infinity;
        seen.forEach(ds => { const t = ds ? parseLocalDate(ds) : null; if (t) { const ms = t.getTime(); if (ms < lo) lo = ms; if (ms > hi) hi = ms; } });
        const win = lo <= hi ? { from: lo, to: hi } : null;
        winMemo = { ref: sd, epoch, win };
        return win;
    }

    // Окно файла в «днях до вылета» для вылета date: { lo, hi } или null.
    function windowDtd(date, win) {
        const fly = parseLocalDate(date);
        if (!fly || !win) return null;
        const f = fly.getTime();
        return { lo: Math.round((f - win.to) / 86400000), hi: Math.round((f - win.from) / 86400000) };
    }

    // ---------- построение ----------

    // Запись вылета из живых билетов. Чистая функция: ничего не читает и не пишет, кроме salesDetails и среза данных.
    // seats — число кресел в продаже (если известно), иначе 0.
    function build(date, code, seats) {
        const fly = parseLocalDate(date);
        const list = typeof getFlightSalesList === 'function' ? getFlightSalesList(date, code) : [];
        if (!fly || !list || !list.length) return null;
        const gmin = groupMin();
        const cut = cutoffStr();
        const d = Object.create(null);
        for (let i = 0; i < list.length; i++) {
            const x = list[i];
            const deal = parseLocalDate(x.dealDate);
            if (!deal) continue;
            const dtd = Math.round((fly.getTime() - deal.getTime()) / 86400000);
            if (dtd < 0 || dtd > MAX_DTD) continue;
            const e = d[dtd] || (d[dtd] = { k: {}, z: 0, g: 0, o: 0, p: 0, r: 0, cut: cut && x.dealDate === cut ? 1 : 0 });
            const fp = x.fare > 0 ? x.fare : (x.adjustedFare || 0);   // как в расчёте рублей по решениям
            if (fp > 0) { e.p++; e.r += fp; }
            const price = x.adjustedFare || x.fare || 0;
            if ((Number(x.grp) || 0) >= gmin) e.g++;
            else if (!(price > 0)) e.z++;
            else if (FareGrid.isAdultPaid(x)) {
                const cls = FareGrid.classOf(x) || '?';
                const c = e.k[cls] || (e.k[cls] = [0, 0]);
                c[0]++;
                c[1] += price;
            } else e.o++;
        }
        const keys = Object.keys(d);
        if (!keys.length) return null;
        keys.forEach(t => {
            const e = d[t];
            e.r = Math.round(e.r);
            ['z', 'g', 'o', 'cut'].forEach(f => { if (!e[f]) delete e[f]; });   // нули не пишем: файл короче
            Object.keys(e.k).forEach(c => { e.k[c][1] = Math.round(e.k[c][1]); });
        });
        return { s: Math.max(0, parseInt(seats, 10) || 0), d };
    }

    function dayCount(e) {
        let n = (e.z || 0) + (e.g || 0) + (e.o || 0);
        Object.keys(e.k || {}).forEach(c => { n += (e.k[c] && e.k[c][0]) || 0; });
        return n;
    }

    // Билетов в записи; lo..hi — только дни из этого диапазона dtd (окно файла продаж).
    function flightCount(rec, lo, hi) {
        let n = 0;
        Object.keys((rec && rec.d) || {}).forEach(t => { if (lo == null || (+t >= lo && +t <= hi)) n += dayCount(rec.d[t]); });
        return n;
    }

    // Слияние записей одного вылета. Возвращает { rec, changed }. win — окно файла продаж в dtd этого вылета { lo, hi } (или null).
    // По каждому dtd: нового нет — старое; старое помечено cut (день был неполным) — новое; иначе новое,
    // кроме случая, когда в окне файла новых билетов < 80% от старых (обрезанный файл) — тогда старое.
    // Дни внутри окна, которых в новом файле нет (все билеты возвращены), убираются; крайний ранний день окна не уменьшаем
    // (файл мог начаться с середины дня).
    function mergeFlight(prev, next, win) {
        if (!prev || !prev.d) return { rec: next, changed: true };
        const lo = win ? win.lo : null;
        const hi = win ? win.hi : null;
        const truncated = flightCount(next, lo, hi) < flightCount(prev, lo, hi) * KEEP_RATIO;
        const d = {};
        let changed = false;
        Object.keys(prev.d).forEach(t => { d[t] = prev.d[t]; });
        Object.keys(next.d).forEach(t => {
            const o = prev.d[t];
            const n = next.d[t];
            if (o && !o.cut && truncated) return;
            if (o && win && +t === hi && dayCount(o) > dayCount(n)) return;
            if (!o || JSON.stringify(o) !== JSON.stringify(n)) { d[t] = n; changed = true; }
        });
        if (win && !truncated) {
            Object.keys(prev.d).forEach(t => { if (!next.d[t] && +t > lo && +t < hi) { delete d[t]; changed = true; } });
        }
        const s = next.s > 0 ? next.s : (prev.s || 0);
        if (s !== (prev.s || 0)) changed = true;
        return { rec: changed ? { s, d } : prev, changed };
    }

    // ---------- чтение ----------

    function readMonth(month) {
        if (loadedMonths.has(month)) return Promise.resolve();
        if (inflight.has(month)) return inflight.get(month);
        const p = readMonth0(month).finally(() => { inflight.delete(month); });
        inflight.set(month, p);
        return p;
    }

    async function readMonth0(month) {
        if (typeof SharedStorage === 'undefined') return;
        const r = await SharedStorage.readJsonFileStrict(`history/daylog-${month}.json`).catch(() => ({ ok: false }));
        if (!r.ok) return;   // нет доступа — не помечаем, перечитаем позже
        loadedMonths.add(month);
        const f = r.data && r.data.flights;
        if (f && typeof f === 'object') Object.keys(f).forEach(k => { if (f[k] && f[k].d) store[k] = f[k]; });
    }

    // Догрузить месяцы ['ГГГГ-ММ', …]: только у тех, у кого есть право. Промис — когда все прочитаны (true — что-то загрузили).
    function ensureMonths(months) {
        if (!canUse()) return Promise.resolve(false);
        const need = (months || []).filter(m => /^\d{4}-\d{2}$/.test(m) && !loadedMonths.has(m));
        if (!need.length) return Promise.resolve(false);
        return Promise.all(need.map(m => readMonth(m).catch(() => null))).then(() => {
            const got = need.some(m => loadedMonths.has(m));
            if (got) rev++;
            return got;   // true — что-то прочиталось (не прочиталось — повторять сразу нечего)
        });
    }

    // Запись вылета из загруженных файлов (после ensureMonths) или null.
    function flight(date, code) {
        return store[`${date}|${code}`] || null;
    }

    function addDaysStr(date, n) {
        const d = parseLocalDate(date);
        if (!d) return '';
        d.setDate(d.getDate() - n);
        return formatDateRu(d);
    }

    // Продажи вылета по дням сделки из журнала: [{ deal, dtd, n, a, r, ra, c, g, p }], по возрастанию даты.
    // n — билетов, a — взрослых платных, ra — их выручка, r — выручка по всем платным (null — день записан старым видом),
    // c — { класс: билетов } у взрослых платных, g — в группах, p — платных всех видов.
    function daysFor(date, code) {
        const rec = flight(date, code);
        if (!rec || !rec.d) return [];
        return Object.keys(rec.d).map(t => {
            const e = rec.d[t];
            let a = 0;
            let ra = 0;
            const c = {};
            Object.keys(e.k || {}).forEach(cl => { const v = e.k[cl] || [0, 0]; a += v[0] || 0; ra += v[1] || 0; c[cl] = v[0] || 0; });
            return { deal: addDaysStr(date, +t), dtd: +t, n: dayCount(e), a, ra, r: e.p != null ? (e.r || 0) : null, c, g: e.g || 0, p: e.p != null ? e.p : null };
        }).sort((x, y) => y.dtd - x.dtd);
    }

    // «Билеты» для расчёта рублей: дни сделок вне окна файла продаж, восстановленные из журнала. У каждого — средний тариф дня
    // (по классу взрослых и общий для прочих платных), так что число билетов и сумма по дню сходятся с настоящими.
    // Пусто, если журнала нет или он записан старым видом (без выручки по всем платным).
    function syntheticTickets(date, code) {
        const rec = flight(date, code);
        if (!rec || !rec.d) return [];
        const wd = windowDtd(date, fileWindow());
        const out = [];
        Object.keys(rec.d).forEach(ts => {
            const t = +ts;
            const e = rec.d[ts];
            if (e.p == null) return;
            if (wd && t >= wd.lo && t <= wd.hi) return;   // этот день есть в файле продаж
            const deal = addDaysStr(date, t);
            let kn = 0;
            let ks = 0;
            Object.keys(e.k || {}).forEach(cl => {
                const v = e.k[cl];
                if (!v || !(v[0] > 0)) return;
                kn += v[0];
                ks += v[1];
                const f = v[1] / v[0];
                for (let i = 0; i < v[0]; i++) out.push({ dealDate: deal, fare: f, adjustedFare: f, basicFareStr: cl === '?' ? '' : cl, syn: true });
            });
            const rest = Math.max(0, (e.p || 0) - kn);
            const rf = rest > 0 ? Math.max(0, (e.r || 0) - ks) / rest : 0;
            for (let i = 0; i < rest; i++) out.push({ dealDate: deal, fare: rf, adjustedFare: rf, basicFareStr: '', syn: true });
            const zeros = Math.max(0, dayCount(e) - (e.p || 0));
            for (let i = 0; i < zeros; i++) out.push({ dealDate: deal, fare: 0, adjustedFare: 0, basicFareStr: '', syn: true });
        });
        return out;
    }

    // Взрослые платные по дням сделки: свежие данные из файла продаж + более старые дни из журнала.
    // [{ dtd, a, ra }] по убыванию dtd (от раннего дня к позднему).
    function adultDays(date, code) {
        const wd = windowDtd(date, fileWindow());
        const byDtd = Object.create(null);
        const rec = flight(date, code);
        if (rec && rec.d) Object.keys(rec.d).forEach(ts => {
            const t = +ts;
            if (wd && t >= wd.lo && t <= wd.hi) return;
            const e = rec.d[ts];
            let a = 0;
            let ra = 0;
            Object.keys(e.k || {}).forEach(cl => { a += e.k[cl][0] || 0; ra += e.k[cl][1] || 0; });
            byDtd[t] = { dtd: t, a, ra };
        });
        const live = build(date, code, 0);
        if (live) Object.keys(live.d).forEach(ts => {
            const e = live.d[ts];
            let a = 0;
            let ra = 0;
            Object.keys(e.k || {}).forEach(cl => { a += e.k[cl][0] || 0; ra += e.k[cl][1] || 0; });
            byDtd[ts] = { dtd: +ts, a, ra };
        });
        return Object.keys(byDtd).map(t => byDtd[t]).sort((x, y) => y.dtd - x.dtd);
    }

    function monthsLoaded(months) {
        return (months || []).every(m => loadedMonths.has(m));
    }

    // ---------- запись ----------

    const pause = () => new Promise(r => setTimeout(r, 6));
    // Порции по ~8 мс: интерфейс остаётся отзывчивым, пока журнал собирается в фоне.
    function makeYield() {
        let t = performance.now();
        return async () => { if (performance.now() - t > 8) { await pause(); t = performance.now(); } };
    }

    function whenIdle(fn, timeout) {
        if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: timeout || 20000 });
        else setTimeout(fn, 3000);
    }

    function dataToken() {
        const at = typeof lastSalesUpdate !== 'undefined' && lastSalesUpdate ? new Date(lastSalesUpdate).getTime() : 0;
        const today = typeof getTodayDate === 'function' ? getTodayDate() : formatDateRu(new Date());
        return `${today}|${at}|${(allData || []).length}|${Object.keys(salesDetails || {}).length}`;
    }

    const writeQueue = Object.create(null);
    function mergeAndWrite(file, additions, tick) {
        const run = (writeQueue[file] || Promise.resolve()).catch(() => null).then(() => mergeAndWrite0(file, additions, tick));
        writeQueue[file] = run;
        return run;
    }

    async function mergeAndWrite0(file, additions, tick) {
        // Строгое чтение: файл не прочитался (ошибка, нет доступа) — не перезаписываем журнал.
        // Запись «только если файл не менялся с прочтения»: вылеты, которые другой ПК добавил между чтением и записью,
        // не теряются (при расхождении журнал перечитывается и сливается заново).
        let merged = null;
        const res = await SharedStorage.updateJsonFile(file, async (remote) => {
            const flights = remote && remote.flights && typeof remote.flights === 'object' ? { ...remote.flights } : {};
            let changed = false;
            let i = 0;
            const gw = fileWindow();
            for (const k of Object.keys(additions)) {
                const m = mergeFlight(flights[k], additions[k], windowDtd(k.slice(0, k.indexOf('|')), gw));
                if (m.changed) { flights[k] = m.rec; changed = true; }
                if ((++i & 31) === 0) await tick();
            }
            merged = flights;
            return changed ? { version: 1, updatedAt: new Date().toISOString(), flights } : false;   // нечего добавлять — файл не трогаем
        }).catch(() => ({ ok: false }));
        // Что есть в файле (с нашими слияниями) — доступно и для чтения в этой сессии.
        if (merged) Object.keys(merged).forEach(k => { if (merged[k] && merged[k].d) store[k] = merged[k]; });
        return !!(res.ok || res.aborted);
    }

    async function capture0() {
        if (typeof SharedStorage === 'undefined' || typeof ProfileAuth === 'undefined') return false;
        if (!ProfileAuth.hasPermission('share_data')) return false;
        if (typeof FareGrid === 'undefined' || !FareGrid.isAdultPaid) return false;
        if (!Object.keys(salesDetails || {}).length) return false;
        const token = dataToken();
        try { if (localStorage.getItem(DONE_KEY) === token) return true; } catch (e) { /* ignore */ }
        if (!(await SharedStorage.canWrite())) return false;

        // Кресла вылетов — из строк рейсов (если есть).
        const seatsOf = Object.create(null);
        const tick = makeYield();
        const bases = Object.keys(groupedData || {});
        for (let b = 0; b < bases.length; b++) {
            const rows = groupedData[bases[b]] || [];
            for (let r = 0; r < rows.length; r++) {
                const row = rows[r];
                if (!row[1] || !row[0]) continue;
                const key = `${row[1]}|${cleanFlight(row[0])}`;
                if (seatsOf[key] == null && typeof getSeatsOnSale === 'function') seatsOf[key] = getSeatsOnSale(row) || 0;
            }
            await tick();
        }

        const byMonth = Object.create(null);
        const keys = Object.keys(salesDetails);
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            const p = key.indexOf('|');
            const date = key.slice(0, p);
            const code = key.slice(p + 1);
            const m = monthOf(date);
            if (m) {
                const rec = build(date, code, seatsOf[key]);
                if (rec) (byMonth[m] || (byMonth[m] = {}))[key] = rec;
            }
            if ((i & 15) === 15) await tick();
        }

        let ok = true;
        for (const m of Object.keys(byMonth)) {
            ok = (await mergeAndWrite(`history/daylog-${m}.json`, byMonth[m], tick)) && ok;
            await tick();
        }
        rev++;
        if (ok) {
            try { localStorage.setItem(DONE_KEY, token); } catch (e) { /* ignore */ }
        }
        return ok;
    }

    // Записать журнал по текущим данным. Только у публикующего, не чаще раза на новые данные, порциями.
    function capture() {
        if (running) return running;
        running = capture0().catch(e => { console.warn('SalesDayLog.capture', e); return false; }).finally(() => { running = null; });
        return running;
    }

    // В простое — после публикации данных и после входа (как SalesArchive.captureSoon).
    function captureSoon() {
        whenIdle(() => { capture(); }, 40000);
    }

    return { flight, daysFor, adultDays, syntheticTickets, fileWindow, monthsLoaded, ensureMonths, capture, captureSoon, revision: () => rev };
})();
