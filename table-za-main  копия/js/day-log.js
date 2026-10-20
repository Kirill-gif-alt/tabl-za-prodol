// Ежедневный журнал продаж по вылетам (shared/history/daylog-ГГГГ-ММ.json, месяц — по ДАТЕ ВЫЛЕТА).
// Строится из живых билетов (salesDetails) и накапливается: ранние продажи выпадают из окна выгрузки,
// а в журнале остаются — по каждому «дню до вылета» (dtd): сколько билетов какого класса и по какой сумме.
//   { version: 1, updatedAt, flights: { 'дд.мм.гггг|KV-101': { s: кресел|0, d: { '<dtd>': {
//       k: { V: [число, сумма], K: [...] }   — взрослые платные по классам бронирования
//       z: нулевые (цена 0)   g: групповые (заказ от PV.GROUP_MIN билетов, любой тариф)
//       o: прочие платные (детские, младенцы, льготные)   cut: 1 — день среза данных, мог быть неполным } } } } }
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

    function canUse() {
        return typeof ProfileAuth !== 'undefined' && ProfileAuth.hasPermission
            && (ProfileAuth.hasPermission('share_data') || ProfileAuth.hasPermission('view_forecast'));
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
            const e = d[dtd] || (d[dtd] = { k: {}, z: 0, g: 0, o: 0, cut: cut && x.dealDate === cut ? 1 : 0 });
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
            Object.keys(e.k).forEach(c => { e.k[c][1] = Math.round(e.k[c][1]); });
        });
        return { s: Math.max(0, parseInt(seats, 10) || 0), d };
    }

    function dayCount(e) {
        let n = (e.z || 0) + (e.g || 0) + (e.o || 0);
        Object.keys(e.k || {}).forEach(c => { n += (e.k[c] && e.k[c][0]) || 0; });
        return n;
    }

    function flightCount(rec) {
        let n = 0;
        Object.keys((rec && rec.d) || {}).forEach(t => { n += dayCount(rec.d[t]); });
        return n;
    }

    // Слияние записей одного вылета. Возвращает { rec, changed }.
    // По каждому dtd: нового нет — старое; старое помечено cut (день был неполным) — новое; иначе новое,
    // кроме случая, когда во всём вылете новых билетов < 80% от старых (обрезанный файл) — тогда старое.
    function mergeFlight(prev, next) {
        if (!prev || !prev.d) return { rec: next, changed: true };
        const truncated = flightCount(next) < flightCount(prev) * KEEP_RATIO;
        const d = {};
        let changed = false;
        Object.keys(prev.d).forEach(t => { d[t] = prev.d[t]; });
        Object.keys(next.d).forEach(t => {
            const o = prev.d[t];
            const n = next.d[t];
            if (o && !o.cut && truncated) return;
            if (!o || JSON.stringify(o) !== JSON.stringify(n)) { d[t] = n; changed = true; }
        });
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
        return Promise.all(need.map(m => readMonth(m).catch(() => null))).then(() => { rev++; return true; });
    }

    // Запись вылета из загруженных файлов (после ensureMonths) или null.
    function flight(date, code) {
        return store[`${date}|${code}`] || null;
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
        const read = await SharedStorage.readJsonFileStrict(file).catch(() => ({ ok: false }));
        if (!read.ok) return false;
        const remote = read.data;
        const flights = remote && remote.flights && typeof remote.flights === 'object' ? { ...remote.flights } : {};
        let changed = false;
        let i = 0;
        for (const k of Object.keys(additions)) {
            const m = mergeFlight(flights[k], additions[k]);
            if (m.changed) { flights[k] = m.rec; changed = true; }
            if ((++i & 31) === 0) await tick();
        }
        // Что есть в файле (с нашими слияниями) — доступно и для чтения в этой сессии.
        Object.keys(flights).forEach(k => { if (flights[k] && flights[k].d) store[k] = flights[k]; });
        if (!changed) return true;
        const ok = await SharedStorage.writeJsonFile(file, { version: 1, updatedAt: new Date().toISOString(), flights });
        return ok;
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

    return { build, flight, ensureMonths, capture, captureSoon, mergeFlight, revision: () => rev };
})();
