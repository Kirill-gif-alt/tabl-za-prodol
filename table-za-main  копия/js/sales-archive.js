// Архив продаж: то, что иначе уходит из окна выгрузки.
// • curves-ГГГГ-ММ.json — итог каждого улетевшего вылета: кресла, тип ВС, билеты и выручка,
//   и сколько билетов продано в каждый «день до вылета». По ним строится норма по дням недели
//   (sales-report.js) и «год назад», когда вылет уже пропал из файла продаж.
// Пишет только тот, кто публикует данные (право share_data), в фоне и не чаще раза на новые данные.
// Читаются файлы тоже в фоне после входа: несколько сотен КБ, старт не задерживают. Без ФИО и PNR.
// • История продаж (SalesHistory.csv из Export-SalesHistory.ps1): улетевшие вылеты за прошлые месяцы и годы,
//   уже сведённые по вылетам, без персональных данных. Загружает администратор — кривые попадают в тот же архив
//   (h: 1 — из истории; se: 1 — кресла оценены по нынешнему ВС рейса; r — возвращено; g — в группах; k — корпоративных).
window.SalesArchive = (function () {
    const MAX_DTD = 365;
    const STD_SEATS = [48, 72, 120];   // ёмкость ВС парка: ATR-42 (до 48), ATR-72, 120 кресел
    const DONE_KEY = 'krasavia_archive_done';

    let curves = Object.create(null);   // 'дд.мм.гггг|KV-107' → запись
    // История по билетам (SalesTickets.csv): что было на вылете в контрольные дни 30…1 до вылета.
    // 'дд.мм.гггг|KV-107' → { p: {H: [классы последнего дня продаж, макс. тариф]}, ro: {H: билетов, сданных позже дня H}, gh: {H: групповых на руках} }
    let tickets = Object.create(null);
    const T_HORIZONS = [30, 21, 14, 10, 7, 5, 3, 1];
    const loadedMonths = new Set();
    let loading = null;
    let rev = 0;

    function pad(n) { return String(n).padStart(2, '0'); }

    function monthOf(dateStr) {
        const d = parseLocalDate(dateStr);
        return d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}` : '';
    }

    function shiftMonth(month, delta) {
        const [y, m] = month.split('-').map(Number);
        const d = new Date(y, m - 1 + delta, 1);
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    }

    function todayStr() {
        return typeof getTodayDate === 'function' ? getTodayDate() : formatDateRu(new Date());
    }

    // ---------- чтение ----------

    async function readMonth(month) {
        if (loadedMonths.has(month)) return;
        loadedMonths.add(month);
        if (typeof SharedStorage === 'undefined') return;
        const r = await SharedStorage.readJsonFileStrict(`history/curves-${month}.json`).catch(() => ({ ok: false }));
        if (!r.ok) loadedMonths.delete(month); // нет доступа — перечитаем позже
        const tr = await SharedStorage.readJsonFileStrict(`history/tickets-${month}.json`).catch(() => ({ ok: false }));
        if (tr.ok && tr.data && tr.data.flights && typeof tr.data.flights === 'object') Object.assign(tickets, tr.data.flights);
        const c = r.data;
        if (c && c.flights && typeof c.flights === 'object') {
            Object.keys(c.flights).forEach(k => {
                const e = normalizeCurve(c.flights[k]);
                if (e && (!curves[k] || e.t > curves[k].t)) curves[k] = e;
            });
        }
    }

    function normalizeCurve(e) {
        if (!e || typeof e !== 'object' || !Array.isArray(e.c)) return null;
        const c = e.c.slice(0, MAX_DTD + 1).map(v => Math.max(0, parseInt(v, 10) || 0));
        const t = c.reduce((a, b) => a + b, 0);
        const out = {
            c,
            t,
            s: Math.max(0, parseInt(e.s, 10) || 0),
            ac: String(e.ac || '').slice(0, 20),
            sold: Math.max(0, parseInt(e.sold, 10) || 0),
            rev: Math.max(0, Math.round(Number(e.rev) || 0))
        };
        ['h', 'se', 's0', 'r', 'g', 'k'].forEach(f => { const v = parseInt(e[f], 10); if (v > 0) out[f] = v; });
        return out;
    }

    // Загрузить последние месяцы (и те же месяцы год назад — для «год назад, тот же день недели»).
    function ensureLoaded() {
        if (loading) return loading;
        const now = monthOf(todayStr());
        if (!now) return Promise.resolve();
        const months = [];
        for (let i = 0; i <= PV.ARCH_MONTHS_BACK; i++) months.push(shiftMonth(now, -i));
        months.push(shiftMonth(now, -12), shiftMonth(now, -11));
        loading = Promise.all(months.map(m => readMonth(m).catch(() => null))).then(() => {
            rev++;
            refreshOpenReport();
        });
        return loading;
    }

    // Догрузить несколько месяцев (для прогноза: обучение и «год назад»). Промис — когда все прочитаны.
    function ensureMonths(months) {
        const need = (months || []).filter(m => m && !loadedMonths.has(m));
        if (!need.length) return Promise.resolve(false);
        return Promise.all(need.map(m => readMonth(m).catch(() => null))).then(() => { rev++; return true; });
    }

    // Все улетевшие вылеты архива (для модели прогноза): [{ date, code, e }].
    function entries() {
        return Object.keys(curves).map(k => {
            const i = k.lastIndexOf('|');
            return { date: k.slice(0, i), code: k.slice(i + 1), e: curves[k] };
        });
    }

    function stats() {
        let n = 0;
        let h = 0;
        let from = null;
        let to = null;
        Object.keys(curves).forEach(k => {
            const d = parseLocalDate(k.slice(0, k.lastIndexOf('|')));
            if (!d) return;
            n++;
            if (curves[k].h) h++;
            if (!from || d < from) from = d;
            if (!to || d > to) to = d;
        });
        return { n, h, from, to, months: loadedMonths.size };
    }

    // Догрузить конкретный месяц (например, дату год назад) и перерисовать открытую детализацию.
    function ensureMonth(dateStr) {
        const m = monthOf(dateStr);
        if (!m || loadedMonths.has(m)) return;
        readMonth(m).then(() => {
            rev++;
            refreshOpenReport();
        }).catch(() => null);
    }

    function refreshOpenReport() {
        if (typeof refreshOpenSalesReport === 'function') refreshOpenSalesReport();
    }

    // ---------- доступ для расчётов ----------

    // Кривая в формате buildOnHandByDtd: onHand[t] — продано к «t дней до вылета».
    function curveFor(dateStr, code) {
        const e = curves[`${dateStr}|${code}`];
        if (!e) return null;
        const onHand = Object.create(null);
        let run = 0;
        let maxDtd = 0;
        for (let t = e.c.length - 1; t >= 0; t--) {
            if (!maxDtd && e.c[t]) maxDtd = t;
            run += e.c[t];
            onHand[t] = run;
        }
        return { onHand, maxDtd, total: run };
    }

    // Улетевшие вылеты рейса из архива (для нормы по дням недели). Индекс по рейсу — пересобирается после чтения архива:
    // с историей за год вызовов тысячи, а записей — десятки тысяч.
    let index = { rev: -1, map: null };

    function departuresFor(code) {
        if (index.rev !== rev || !index.map) {
            const map = new Map();
            Object.keys(curves).forEach(k => {
                const i = k.lastIndexOf('|');
                const c = k.slice(i + 1);
                const e = curves[k];
                (map.get(c) || map.set(c, []).get(c)).push({ date: k.slice(0, i), code: c, seats: e.s, aircraft: e.ac, sold: e.sold, total: e.t });
            });
            index = { rev, map };
        }
        return (index.map.get(code) || []).slice();
    }

    // Запись архива по вылету (кресла, итог, признаки истории) или null.
    function entryFor(dateStr, code) {
        return curves[`${dateStr}|${code}`] || null;
    }

    // ---------- запись ----------

    function eachDeparture(fn) {
        const seen = new Set();
        Object.keys(groupedData || {}).forEach(base => {
            if (typeof isValidFlightBase === 'function' && !isValidFlightBase(base)) return;
            (groupedData[base] || []).forEach(row => {
                const date = row[1];
                const code = cleanFlight(row[0]);
                if (!date || !code) return;
                const key = `${date}|${code}`;
                if (seen.has(key)) return;
                seen.add(key);
                fn(key, date, code, row);
            });
        });
    }

    function buildCurve(date, code, row) {
        const list = (salesDetails || {})[`${date}|${code}`];
        const fly = parseLocalDate(date);
        if (!list || !list.length || !fly) return null;
        const c = [];
        let rev = 0;
        list.forEach(x => {
            const deal = parseLocalDate(x.dealDate);
            if (!deal) return;
            const dtd = Math.round((fly.getTime() - deal.getTime()) / 86400000);
            if (dtd < 0 || dtd > MAX_DTD) return;
            c[dtd] = (c[dtd] || 0) + 1;
            rev += x.adjustedFare || x.fare || 0;
        });
        for (let i = 0; i < c.length; i++) if (!c[i]) c[i] = 0;
        if (!c.length) return null;
        return {
            c,
            s: typeof getSeatsOnSale === 'function' ? getSeatsOnSale(row) : 0,
            ac: typeof getAircraftType === 'function' ? getAircraftType(row[4]) : '',
            sold: typeof getSoldFromRow === 'function' ? getSoldFromRow(row) : (parseInt(row[6], 10) || 0),
            rev: Math.round(rev)
        };
    }

    function dataToken() {
        const at = typeof lastSalesUpdate !== 'undefined' && lastSalesUpdate ? new Date(lastSalesUpdate).getTime() : 0;
        // С датой: после полуночи вчерашние вылеты становятся улетевшими и должны попасть в архив без новых данных.
        return `${todayStr()}|${at}|${(allData || []).length}|${Object.keys(salesDetails || {}).length}`;
    }

    // Записи в один файл — по очереди: загрузка истории и запись архива по живым данным не затирают друг друга.
    const writeQueue = Object.create(null);

    function mergeAndWrite(file, kind, additions) {
        const run = (writeQueue[file] || Promise.resolve()).catch(() => null).then(() => mergeAndWrite0(file, kind, additions));
        writeQueue[file] = run;
        return run;
    }

    async function mergeAndWrite0(file, kind, additions) {
        // Строгое чтение: если файл не прочитался (ошибка, нет доступа), не перезаписываем архив.
        const read = await SharedStorage.readJsonFileStrict(file).catch(() => ({ ok: false }));
        if (!read.ok) return false;
        const remote = read.data;
        const out = { version: 1, updatedAt: new Date().toISOString() };
        let changed = false;
        if (kind === 'curves') {
            const flights = remote && remote.flights && typeof remote.flights === 'object' ? { ...remote.flights } : {};
            Object.keys(additions).forEach(k => {
                const prev = flights[k] && normalizeCurve(flights[k]);
                const next = additions[k];
                // Берём вариант, где больше билетов: ранние продажи могли уже выпасть из окна выгрузки.
                if (!prev || next.c.reduce((a, b) => a + b, 0) > prev.t || (next.sold !== prev.sold && next.c.reduce((a, b) => a + b, 0) === prev.t)) {
                    // Возвраты, группы и корпоративные из истории продаж в живых данных не считаются — переносим.
                    flights[k] = prev ? { ...next, ...['r', 'g', 'k'].reduce((o, f) => (prev[f] ? { ...o, [f]: prev[f] } : o), {}) } : next;
                    changed = true;
                }
            });
            out.flights = flights;
        }
        if (kind === 'import') {
            // История: новые вылеты добавляются; вылет, записанный по живым данным (настоящие кресла и ВС), не трогаем —
            // только дописываем к нему возвраты/группы/корпоративных. Повторная загрузка истории заменяет прежнюю.
            const flights = remote && remote.flights && typeof remote.flights === 'object' ? { ...remote.flights } : {};
            Object.keys(additions).forEach(k => {
                const prev = flights[k] && normalizeCurve(flights[k]);
                const next = additions[k];
                if (!prev || prev.h) {
                    // Рейса сейчас нет в данных (сезонный, приостановлен) — кресла и ВС не знаем: прежние не затираем.
                    flights[k] = keepSeats(next, prev);
                    changed = true;
                    return;
                }
                const extra = {};
                ['r', 'g', 'k'].forEach(f => { if (next[f] && prev[f] == null) extra[f] = next[f]; });
                if (Object.keys(extra).length) { flights[k] = { ...flights[k], ...extra }; changed = true; }
            });
            out.flights = flights;
        }
        if (!changed) return true;
        return SharedStorage.writeJsonFile(file, out);
    }

    // Записать архив по текущим данным. Только у публикующего и только когда данные новые.
    async function capture() {
        if (typeof SharedStorage === 'undefined' || typeof ProfileAuth === 'undefined') return false;
        if (!ProfileAuth.hasPermission('share_data')) return false;
        if (!Object.keys(groupedData || {}).length || !Object.keys(salesDetails || {}).length) return false;
        const token = dataToken();
        try { if (localStorage.getItem(DONE_KEY) === token) return true; } catch (e) { /* ignore */ }
        if (!(await SharedStorage.canWrite())) return false;

        const today = parseLocalDate(todayStr());
        const curvesByMonth = {};
        eachDeparture((key, date, code, row) => {
            const fly = parseLocalDate(date);
            if (!fly || !today) return;
            if (fly < today) {
                const e = buildCurve(date, code, row);
                if (!e) return;
                const m = monthOf(date);
                (curvesByMonth[m] || (curvesByMonth[m] = {}))[key] = e;
            }
        });

        let ok = true;
        for (const m of Object.keys(curvesByMonth)) {
            ok = (await mergeAndWrite(`history/curves-${m}.json`, 'curves', curvesByMonth[m])) && ok;
            Object.entries(curvesByMonth[m]).forEach(([k, v]) => {
                const e = normalizeCurve(v);
                if (e && (!curves[k] || e.t > curves[k].t)) curves[k] = e;
            });
        }
        rev++;
        if (ok) {
            try { localStorage.setItem(DONE_KEY, token); } catch (e) { /* ignore */ }
        }
        return ok;
    }

    function whenIdle(fn, timeout) {
        if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: timeout || 20000 });
        else setTimeout(fn, 3000);
    }

    // После входа: прочитать архив, у публикующего — дописать его по текущим данным.
    function scheduleAfterStart() {
        whenIdle(() => {
            ensureLoaded().then(() => capture()).catch(e => console.warn('SalesArchive', e));
        });
    }

    // После публикации новых данных.
    function captureSoon() {
        whenIdle(() => capture().catch(e => console.warn('SalesArchive.capture', e)), 30000);
    }

    // ---------- загрузка истории (SalesHistory.csv) ----------

    function keepSeats(next, prev) {
        if (!prev || next.s > 0 || !(prev.s > 0) || prev.s < next.sold) return next;
        return { ...next, s: prev.s, ac: next.ac || prev.ac };
    }

    function typicalOf(code) {
        const C = {};
        const A = {};
        const base = typeof getBaseFlight === 'function' ? getBaseFlight(code) : code;
        (groupedData && groupedData[base] || []).forEach(row => {
            if (cleanFlight(row[0]) !== code && base !== code) return;
            const s = typeof getSeatsOnSale === 'function' ? getSeatsOnSale(row) : 0;
            if (s > 0) C[s] = (C[s] || 0) + 1;
            const ac = typeof getAircraftType === 'function' ? getAircraftType(row[4]) : '';
            if (ac) A[ac] = (A[ac] || 0) + 1;
        });
        // Рейса нет в нынешних данных — кресла по его вылетам, уже записанным в архив по живым данным (не из истории).
        if (!Object.keys(C).length) {
            Object.keys(curves).forEach(k => {
                if (k.slice(k.lastIndexOf('|') + 1) !== code) return;
                const e = curves[k];
                if (e.h || !(e.s > 0)) return;
                C[e.s] = (C[e.s] || 0) + 1;
                if (e.ac) A[e.ac] = (A[e.ac] || 0) + 1;
            });
        }
        const top = (o) => Object.keys(o).sort((a, b) => o[b] - o[a])[0];
        return { s: parseInt(top(C), 10) || 0, ac: top(A) || '' };
    }

    function parseCurve(str, maxDtd) {
        const c = [];
        String(str || '').trim().split(/\s+/).forEach(p => {
            const m = /^(-?\d+):(\d+)$/.exec(p);
            if (!m) return;
            const t = parseInt(m[1], 10);
            if (t < 0 || t > maxDtd) return;
            c[t] = (c[t] || 0) + parseInt(m[2], 10);
        });
        for (let i = 0; i < c.length; i++) if (!c[i]) c[i] = 0;
        return c;
    }

    // Какой файл истории загружен последним (history/import.json): тот же файл повторно не загружается.
    const IMPORT_FILE = 'history/import.json';
    const IMPORT_LOCAL_KEY = 'krasavia_hist_import_sig';
    let lastImport = null;

    function fileSig(file) {
        return file ? `${file.size}|${file.lastModified}` : '';
    }

    async function readLastImport() {
        if (typeof SharedStorage === 'undefined') return null;
        const r = await SharedStorage.readJsonFileStrict(IMPORT_FILE).catch(() => ({ ok: false }));
        if (r.ok) lastImport = r.data && typeof r.data === 'object' ? r.data : null;
        return r;
    }

    async function noteImport(file, r) {
        lastImport = {
            version: 1, sig: fileSig(file), file: file ? String(file.name || '').slice(0, 80) : '', at: new Date().toISOString(),
            flights: r.flights, from: r.from ? formatDateRu(r.from) : '', to: r.to ? formatDateRu(r.to) : ''
        };
        const ok = await SharedStorage.writeJsonFile(IMPORT_FILE, lastImport).catch(() => false);
        // Отметку не записали (старый локальный сервер, нет доступа) — помним хотя бы на этом компьютере,
        // иначе история перезагружалась бы при каждой загрузке данных.
        try { localStorage.setItem(IMPORT_LOCAL_KEY, lastImport.sig); } catch (e) { /* ignore */ }
        return ok;
    }

    // SalesHistory.csv из папки данных (её пишет Export-SalesHistory.ps1, например каждую ночь по расписанию):
    // загружается сама у публикующего, если файл изменился с прошлой загрузки. Модель после этого доучивается.
    async function autoImport(file) {
        if (!file || typeof SharedStorage === 'undefined' || typeof ProfileAuth === 'undefined') return null;
        if (!ProfileAuth.hasPermission('share_data')) return null;
        if (!(await SharedStorage.canWrite())) return null;
        const read = await readLastImport();
        if (!read.ok) return null;   // не прочитали отметку — не грузим вслепую
        let localSig = '';
        try { localSig = localStorage.getItem(IMPORT_LOCAL_KEY) || ''; } catch (e) { /* ignore */ }
        if ((lastImport && lastImport.sig === fileSig(file)) || localSig === fileSig(file)) return { ok: true, same: true };
        const r = await importHistory(await file.text(), file);
        if (r.ok && typeof ForecastLab !== 'undefined' && ForecastLab.afterHistoryImport) ForecastLab.afterHistoryImport();
        return r;
    }

    // Разобрать файл истории и дописать архив. Возвращает { ok, flights, months, skipped, estimated, from, to, error }.
    async function importHistory(text, file) {
        if (typeof SharedStorage === 'undefined') return { ok: false, error: 'нет общей папки' };
        const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
        const splitLine = (l) => (typeof parseCSVLine === 'function' ? parseCSVLine(l) : l.split(',')).map(x => String(x == null ? '' : x).replace(/^"|"$/g, '').trim());
        const head = splitLine(lines[0] || '').map(x => x.toUpperCase());
        const col = (n) => head.indexOf(n);
        const need = ['REIS', 'FLYDATE', 'TICKETS', 'CURVE'];
        if (need.some(n => col(n) < 0)) return { ok: false, error: 'это не файл истории продаж (нужны столбцы REIS, FLYDATE, TICKETS, CURVE)' };
        if (!(await SharedStorage.canWrite())) return { ok: false, error: 'нет доступа на запись в общую папку' };
        const today = parseLocalDate(todayStr());
        const byMonth = {};
        const typical = {};
        let flights = 0;
        let skipped = 0;
        let estimated = 0;
        let from = null;
        let to = null;
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            if (!line || !line.trim()) continue;
            const r = splitLine(line);
            const code = cleanFlight(r[col('REIS')] || '');
            const d = parseLocalDate(String(r[col('FLYDATE')] || '').trim());
            // Ключ — в том же виде, что у живых данных (дд.мм.гггг), иначе один вылет посчитается дважды.
            const date = d ? (typeof formatDateRu === 'function' ? formatDateRu(d) : `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`) : '';
            const sold = parseInt(r[col('TICKETS')], 10) || 0;
            if (!code || !d || (today && d >= today) || sold <= 0) { skipped++; continue; }
            const c = parseCurve(r[col('CURVE')], MAX_DTD);
            if (!c.length) { skipped++; continue; }
            if (!typical[code]) typical[code] = typicalOf(code);
            const ty = typical[code];
            // Кресла прошлых вылетов не записаны — берём по нынешнему рейсу. Рейса нет в данных — кресел не знаем (s: 0):
            // такой вылет идёт в норму и «прошлый год», но не в обучение модели (иначе загрузка была бы 100% по построению).
            // Продано больше нынешних кресел — тогда летал ВС больше: берём наименьшую стандартную ёмкость, которая вмещает
            // проданное (иначе такие вылеты выпали бы из обучения, и модель училась бы только на недогруженных).
            const seats = ty.s >= sold ? ty.s : (ty.s > 0 ? (STD_SEATS.find(x => x >= sold) || 0) : 0);
            const e = { c, s: seats, ac: ty.s >= sold ? ty.ac : '', sold, rev: Math.round(Number(r[col('REVENUE')]) || 0), h: 1 };
            e.se = 1;   // кресел прошлых вылетов в истории продаж нет — оценка по нынешнему ВС рейса
            // Ёмкость «по проданному» знает итог вылета — модели как признак её давать нельзя: s0 — обычные кресла рейса.
            if (ty.s > 0 && ty.s < sold) e.s0 = ty.s;
            ['REFUNDED', 'GROUP', 'CORP'].forEach((n, j) => { const v = parseInt(r[col(n)], 10); if (v > 0) e[['r', 'g', 'k'][j]] = v; });
            estimated++;
            const m = monthOf(date);
            (byMonth[m] || (byMonth[m] = {}))[`${date}|${code}`] = e;
            flights++;
            if (!from || d < from) from = d;
            if (!to || d > to) to = d;
            if (i % 3000 === 0) await new Promise(res => setTimeout(res, 0));
        }
        if (!flights) return { ok: false, error: 'в файле нет улетевших вылетов' };
        let ok = true;
        const months = Object.keys(byMonth).sort();
        for (const m of months) {
            ok = (await mergeAndWrite(`history/curves-${m}.json`, 'import', byMonth[m])) && ok;
            loadedMonths.delete(m);
            await readMonth(m).catch(() => null);
            // Повторная загрузка заменяет историю и в памяти (readMonth берёт запись, только если в ней больше билетов).
            Object.entries(byMonth[m]).forEach(([k, e]) => { const prev = curves[k]; if (!prev || prev.h) { const n = normalizeCurve(keepSeats(e, prev)); if (n) curves[k] = n; } });
        }
        rev++;
        if (typeof ActivityLog !== 'undefined') ActivityLog.log('import', `История продаж: ${flights} вылетов`);
        const res = { ok, flights, months: months.length, skipped, estimated, from, to };
        if (ok) await noteImport(file, res);
        return res;
    }

    // ---------- история по билетам (SalesTickets.csv) ----------
    async function importTickets(text, file) {
        if (typeof SharedStorage === 'undefined') return { ok: false, error: 'нет общей папки' };
        const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
        const split = (l) => l.split(',').map(x => x.replace(/^"|"$/g, '').trim());
        const head = split(lines[0] || '').map(x => x.toUpperCase());
        const col = (n) => head.indexOf(n);
        if (['REIS', 'FLYDATE', 'DTD', 'NFARE', 'BASICFARE', 'REFUND_DTD'].some(n => col(n) < 0)) return { ok: false, error: 'это не файл по билетам (нужны REIS, FLYDATE, DTD, NFARE, BASICFARE, REFUND_DTD)' };
        if (!(await SharedStorage.canWrite())) return { ok: false, error: 'нет доступа на запись в общую папку' };
        const today = parseLocalDate(todayStr());
        const deps = Object.create(null);
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            if (!line) continue;
            const v = split(line);
            const code = cleanFlight(v[col('REIS')] || '');
            const d = parseLocalDate(v[col('FLYDATE')] || '');
            if (!code || !d || (today && d >= today)) continue;
            const date = formatDateRu(d);
            const key = `${date}|${code}`;
            const dep = deps[key] || (deps[key] = []);
            const rd = v[col('REFUND_DTD')];
            dep.push({
                dtd: parseInt(v[col('DTD')], 10) || 0,
                fare: Number(String(v[col('NFARE')] || '').replace(',', '.')) || 0,
                basis: String(v[col('BASICFARE')] || '').toUpperCase(),
                rd: rd === '' || rd == null ? null : parseInt(rd, 10),
                grp: col('GROUP') >= 0 && v[col('GROUP')] === '1'
            });
            if (i % 5000 === 0) await new Promise(res => setTimeout(res, 0));
        }
        const adultPaid = (t) => t.fare > 0 && !/\/(CN|IN|ID|WO|DA)\d*/.test(t.basis) && !/IDB$/.test(t.basis.split('/')[0]);
        const byMonth = Object.create(null);
        let flights = 0;
        Object.keys(deps).forEach(key => {
            const list = deps[key];
            const out = { p: {}, ro: {}, gh: {} };
            T_HORIZONS.forEach(H => {
                // На руках в день H: куплены не позже (dtd ≥ H) и не сданы к этому дню (возврат позже или не было).
                const held = list.filter(t => t.dtd >= H && !(t.rd != null && t.rd >= H));
                const ro = held.filter(t => t.rd != null).length;   // сданы позже — в истории (за вычетом возвратов) их нет
                if (ro) out.ro[H] = ro;
                const g = held.filter(t => t.grp).length;
                if (g) out.gh[H] = g;
                const paid = list.filter(t => t.dtd >= H && adultPaid(t));
                if (!paid.length) return;
                const last = Math.min(...paid.map(t => t.dtd));   // последний день продаж к дню H
                const day = paid.filter(t => t.dtd === last);
                out.p[H] = [[...new Set(day.map(t => t.basis.charAt(0)))].join(''), Math.max(...day.map(t => t.fare))];
            });
            const m = monthOf(key.slice(0, key.indexOf('|')));
            (byMonth[m] || (byMonth[m] = {}))[key] = out;
            flights++;
        });
        if (!flights) return { ok: false, error: 'в файле нет улетевших вылетов' };
        let ok = true;
        for (const m of Object.keys(byMonth).sort()) {
            const w = await SharedStorage.writeJsonFile(`history/tickets-${m}.json`, { version: 1, updatedAt: new Date().toISOString(), flights: byMonth[m] });
            ok = w && ok;
            if (w) Object.assign(tickets, byMonth[m]);
        }
        rev++;
        ticketsRev++;
        if (typeof ActivityLog !== 'undefined') ActivityLog.log('import', `История по билетам: ${flights} вылетов`);
        if (ok) {
            const read = await readLastImport().catch(() => null);
            const base = (read && read.ok && lastImport) ? lastImport : {};
            lastImport = Object.assign({}, base, { ticketsSig: fileSig(file), ticketsAt: new Date().toISOString(), ticketsFlights: flights });
            await SharedStorage.writeJsonFile(IMPORT_FILE, lastImport).catch(() => false);
            try { localStorage.setItem(IMPORT_LOCAL_KEY + '_t', fileSig(file)); } catch (e) { /* ignore */ }
        }
        return { ok, flights };
    }

    let ticketsRev = 0;
    async function autoImportTickets(file) {
        if (!file || typeof SharedStorage === 'undefined' || typeof ProfileAuth === 'undefined') return null;
        if (!ProfileAuth.hasPermission('share_data')) return null;
        if (!(await SharedStorage.canWrite())) return null;
        const read = await readLastImport();
        if (!read.ok) return null;
        let localSig = '';
        try { localSig = localStorage.getItem(IMPORT_LOCAL_KEY + '_t') || ''; } catch (e) { /* ignore */ }
        if ((lastImport && lastImport.ticketsSig === fileSig(file)) || localSig === fileSig(file)) return { ok: true, same: true };
        const r = await importTickets(await file.text(), file);
        if (r.ok && typeof ForecastLab !== 'undefined' && ForecastLab.afterHistoryImport) ForecastLab.afterHistoryImport();
        return r;
    }

    function ticketsFor(date, code) { return tickets[`${date}|${code}`] || null; }

    // Обычные кресла рейса (по нынешним данным) — для вылетов истории, где ёмкость подобрана по проданному.
    function typicalSeats(code) { return typicalOf(code).s || 0; }

    return {
        typicalSeats,
        importTickets,
        autoImportTickets,
        ticketsFor,
        ticketsRevision: () => ticketsRev + Object.keys(tickets).length,
        ensureLoaded,
        ensureMonth,
        ensureMonths,
        entries,
        entryFor,
        stats,
        importHistory,
        autoImport,
        lastImport: () => lastImport,
        readLastImport,
        curveFor,
        departuresFor,
        capture,
        captureSoon,
        scheduleAfterStart,
        revision: () => rev
    };
})();
