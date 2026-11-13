// архив продаж: улетевшие вылеты, которых уже нет в окне выгрузки
// curves-ГГГГ-ММ.json: кресла, ВС, билеты по дням до вылета и выручка (норма, sales-report.js)
// пишет только право share_data, в фоне; без ФИО и PNR
window.SalesArchive = (function () {
    const MAX_DTD = 365;
    const STD_SEATS = [48, 72, 120];   // ёмкость ВС парка: ATR-42 (до 48), ATR-72, 120 кресел
    const DONE_KEY = 'krasavia_archive_done';

    let curves = Object.create(null);   // 'дд.мм.гггг|KV-107' -> запись
    // история по билетам (SalesTickets.csv): контрольные дни 30...1 до вылета (H)
    // 'дд.мм.гггг|KV-107' -> { p: {H: [классы, макс. тариф]}, ro: {H: сданы позже H}, gh: {H: групповых} }
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

    // месяц в loadedMonths только после чтения; параллельные запросы ждут тот же промис
    const inflight = new Map();

    function readMonth(month) {
        if (loadedMonths.has(month)) return Promise.resolve();
        if (inflight.has(month)) return inflight.get(month);
        const p = readMonth0(month).finally(() => { inflight.delete(month); });
        inflight.set(month, p);
        return p;
    }

    async function readMonth0(month) {
        if (typeof SharedStorage === 'undefined') return;
        const r = await SharedStorage.readJsonFileStrict(`history/curves-${month}.json`).catch(() => ({ ok: false }));
        if (r.ok) loadedMonths.add(month);   // нет доступа - не помечаем, перечитаем позже
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

    // последние месяцы и те же месяцы год назад (для "год назад" по дню недели)
    let loadingMonth = '';
    function ensureLoaded() {
        const now = monthOf(todayStr());
        if (loading && loadingMonth === now) return loading;
        if (!now) return Promise.resolve();
        loadingMonth = now;
        const months = [];
        for (let i = 0; i <= PV.ARCH_MONTHS_BACK; i++) months.push(shiftMonth(now, -i));
        months.push(shiftMonth(now, -12), shiftMonth(now, -11));
        loading = Promise.all(months.map(m => readMonth(m).catch(() => null))).then(() => {
            rev++;
            refreshOpenReport();
            if (months.some(m => !loadedMonths.has(m))) loading = null;   // часть месяцев не прочиталась - повторим при следующем вызове
        });
        return loading;
    }

    // догрузить месяцы (для прогноза: обучение и "год назад"); промис - когда все прочитаны
    function ensureMonths(months) {
        const need = (months || []).filter(m => m && !loadedMonths.has(m));
        if (!need.length) return Promise.resolve(false);
        return Promise.all(need.map(m => readMonth(m).catch(() => null))).then(() => { rev++; return true; });
    }

    // все улетевшие вылеты для модели: [{ date, code, e }]
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

    function refreshOpenReport() {
        if (typeof refreshOpenSalesReport === 'function') refreshOpenSalesReport();
    }

    // кривая как в buildOnHandByDtd: onHand[t] - продано к t дням до вылета
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

    // улетевшие вылеты рейса (для нормы по дням недели); индекс по рейсу пересобирается после чтения
    // с историей за год: вызовов тысячи, записей десятки тысяч
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

    // запись архива по вылету или null (кресла, итог, признаки истории)
    function entryFor(dateStr, code) {
        return curves[`${dateStr}|${code}`] || null;
    }

    function eachDeparture(fn) {
        const seen = new Set();
        Object.keys(groupedData || {}).forEach(base => {
            if (typeof isValidFlightBase === 'function' && !isValidFlightBase(base)) return;
            (groupedData[base] || []).forEach(row => {
                const date = row[1];
                const code = cleanFlight(row[0]);
                if (!date || !code) return;
                // вылет с посадками один раз, по сквозному участку (его загрузка и кресла идут в архив)
                if (row.segShare) return;
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
            rev += x.fare || 0;
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
        // после полуночи вчерашние вылеты уходят в архив без новых данных
        return `${todayStr()}|${at}|${(allData || []).length}|${Object.keys(salesDetails || {}).length}`;
    }

    // записи в один файл по очереди, чтобы история и живые данные не затирали друг друга
    const writeQueue = Object.create(null);

    function mergeAndWrite(file, kind, additions) {
        const run = (writeQueue[file] || Promise.resolve()).catch(() => null).then(() => mergeAndWrite0(file, kind, additions));
        writeQueue[file] = run;
        return run;
    }

    async function mergeAndWrite0(file, kind, additions) {
        // строго: если файл не прочитался, архив не перезаписываем
        // запись только если файл не менялся с чтения, иначе перечитаем и сольём
        const res = await SharedStorage.updateJsonFile(file, (remote) => mergeArchive(remote, kind, additions)).catch(() => ({ ok: false }));
        return !!(res.ok || res.aborted);
    }

    // слияние добавок с файлом; false, если добавлять нечего
    function mergeArchive(remote, kind, additions) {
        const out = { version: 1, updatedAt: new Date().toISOString() };
        let changed = false;
        if (kind === 'curves') {
            const flights = remote && remote.flights && typeof remote.flights === 'object' ? { ...remote.flights } : {};
            Object.keys(additions).forEach(k => {
                const prev = flights[k] && normalizeCurve(flights[k]);
                const next = additions[k];
                // берём вариант с большим числом билетов: ранние продажи могли выпасть из окна выгрузки
                if (!prev || next.c.reduce((a, b) => a + b, 0) > prev.t || (next.sold !== prev.sold && next.c.reduce((a, b) => a + b, 0) === prev.t)) {
                    // возвраты, группы и корпоративные из истории в живых данных не считаются, переносим
                    flights[k] = prev ? { ...next, ...['r', 'g', 'k'].reduce((o, f) => (prev[f] ? { ...o, [f]: prev[f] } : o), {}) } : next;
                    changed = true;
                }
            });
            out.flights = flights;
        }
        if (kind === 'import') {
            // история: новые вылеты добавляются; вылет из живых данных (кресла и ВС) не трогаем, только дописываем r/g/k
            // повторная загрузка истории заменяет прежнюю
            const flights = remote && remote.flights && typeof remote.flights === 'object' ? { ...remote.flights } : {};
            Object.keys(additions).forEach(k => {
                const prev = flights[k] && normalizeCurve(flights[k]);
                const next = additions[k];
                if (!prev || prev.h) {
                    // рейса нет в данных (сезонный, приостановлен): кресел и ВС не знаем, прежние не затираем
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
        return changed ? out : false;
    }

    // записать архив по текущим данным; только у публикующего и только при новых данных
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

    // после входа: читаем архив, публикующий дописывает его
    function scheduleAfterStart() {
        whenIdle(() => {
            ensureLoaded().then(() => capture()).catch(e => console.warn('SalesArchive', e));
        });
        backgroundSummaries();
    }

    // фоновые сводки после входа и публикации: метка "новое" (signals-days.json), "деньги по решениям"
    function backgroundSummaries() {
        if (typeof SignalNews !== 'undefined' && SignalNews.backgroundSoon) SignalNews.backgroundSoon();
        if (typeof DecisionMoney !== 'undefined' && DecisionMoney.freezeSoon) DecisionMoney.freezeSoon();
        if (typeof LowReqReport !== 'undefined' && LowReqReport.captureSoon) LowReqReport.captureSoon();
    }

    function captureSoon() {
        whenIdle(() => capture().catch(e => console.warn('SalesArchive.capture', e)), 30000);
        backgroundSummaries();
    }

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
        // рейса нет в нынешних данных: кресла берём из его вылетов в архиве по живым данным (не из истории)
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

    // последний загруженный файл истории (history/import.json), повторно не грузим
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

    // отметка пишется слиянием, поля других загрузок не теряются
    async function writeImportMark(fields) {
        const res = await SharedStorage.updateJsonFile(IMPORT_FILE, (cur) => Object.assign({}, cur && typeof cur === 'object' ? cur : {}, fields, { version: 1 })).catch(() => ({ ok: false }));
        if (res.ok && res.data) lastImport = res.data;
        return !!res.ok;
    }

    async function noteImport(file, r) {
        lastImport = {
            ...(lastImport || {}),   // tickets* не теряем
            version: 1, sig: fileSig(file), file: file ? String(file.name || '').slice(0, 80) : '', at: new Date().toISOString(),
            flights: r.flights, from: r.from ? formatDateRu(r.from) : '', to: r.to ? formatDateRu(r.to) : ''
        };
        const ok = await writeImportMark({ sig: lastImport.sig, file: lastImport.file, at: lastImport.at, flights: lastImport.flights, from: lastImport.from, to: lastImport.to });
        // отметку не записали (старый локальный сервер, нет доступа): помним на этом компьютере
        // иначе история грузилась бы при каждой загрузке данных
        try { localStorage.setItem(IMPORT_LOCAL_KEY, lastImport.sig); } catch (e) { /* ignore */ }
        return ok;
    }

    // SalesHistory.csv (пишет Export-SalesHistory.ps1, например ночью по расписанию)
    // публикующий грузит сам, если файл изменился; модель после этого доучивается
    async function autoImport(file) {
        if (!file || typeof SharedStorage === 'undefined' || typeof ProfileAuth === 'undefined') return null;
        if (!ProfileAuth.hasPermission('share_data')) return null;
        if (!(await SharedStorage.canWrite())) return null;
        const read = await readLastImport();
        if (!read.ok) return null;   // не прочитали отметку - не грузим вслепую
        let localSig = '';
        try { localSig = localStorage.getItem(IMPORT_LOCAL_KEY) || ''; } catch (e) { /* ignore */ }
        if ((lastImport && lastImport.sig === fileSig(file)) || localSig === fileSig(file)) return { ok: true, same: true };
        const r = await importHistory(await file.text(), file);
        if (r.ok && typeof ForecastLab !== 'undefined' && ForecastLab.afterHistoryImport) ForecastLab.afterHistoryImport();
        return r;
    }

    // разбираем файл истории и дописываем архив
    // возвращает { ok, flights, months, skipped, estimated, from, to, error }
    async function importHistory(text, file) {
        if (typeof SharedStorage === 'undefined') return { ok: false, error: 'нет общей папки' };
        const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
        const splitLine = (l) => (typeof parseCSVLine === 'function' ? parseCSVLine(l) : l.split(',')).map(x => String(x == null ? '' : x).replace(/^"|"$/g, '').trim());
        const head = splitLine(lines[0] || '').map(x => x.toUpperCase());
        const col = (n) => head.indexOf(n);
        const need = ['REIS', 'FLYDATE', 'TICKETS', 'CURVE'];
        if (need.some(n => col(n) < 0)) return { ok: false, error: 'это не файл истории продаж (нет нужных столбцов: рейс, дата вылета, билеты, кривая)' };
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
            // ключ дд.мм.гггг, как у живых данных, иначе вылет посчитается дважды
            const date = d ? (typeof formatDateRu === 'function' ? formatDateRu(d) : `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`) : '';
            const sold = parseInt(r[col('TICKETS')], 10) || 0;
            if (!code || !d || (today && d >= today) || sold <= 0) { skipped++; continue; }
            const c = parseCurve(r[col('CURVE')], MAX_DTD);
            if (!c.length) { skipped++; continue; }
            if (!typical[code]) typical[code] = typicalOf(code);
            const ty = typical[code];
            // рейса нет в данных - s: 0: вылет в норму и "прошлый год", но не в обучение (иначе загрузка 100%)
            // продано больше кресел - берём наименьшую стандартную ёмкость, которая вмещает проданное
            const seats = ty.s >= sold ? ty.s : (ty.s > 0 ? (STD_SEATS.find(x => x >= sold) || 0) : 0);
            const e = { c, s: seats, ac: ty.s >= sold ? ty.ac : '', sold, rev: Math.round(Number(r[col('REVENUE')]) || 0), h: 1 };
            e.se = 1;   // кресел нет в истории - оценка по нынешнему ВС
            // ёмкость по проданному знает итог вылета, модели как признак её давать нельзя
            // s0 - обычные кресла рейса
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
            // повторная загрузка заменяет историю и в памяти; readMonth берёт запись, если в ней больше билетов
            Object.entries(byMonth[m]).forEach(([k, e]) => { const prev = curves[k]; if (!prev || prev.h) { const n = normalizeCurve(keepSeats(e, prev)); if (n) curves[k] = n; } });
        }
        rev++;
        if (typeof ActivityLog !== 'undefined') ActivityLog.log('import', `История продаж: ${flights} вылетов`);
        const res = { ok, flights, months: months.length, skipped, estimated, from, to };
        if (ok) await noteImport(file, res);
        return res;
    }

    async function importTickets(text, file) {
        if (typeof SharedStorage === 'undefined') return { ok: false, error: 'нет общей папки' };
        const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
        const split = (l) => l.split(',').map(x => x.replace(/^"|"$/g, '').trim());
        const head = split(lines[0] || '').map(x => x.toUpperCase());
        const col = (n) => head.indexOf(n);
        if (['REIS', 'FLYDATE', 'DTD', 'NFARE', 'BASICFARE', 'REFUND_DTD'].some(n => col(n) < 0)) return { ok: false, error: 'это не файл по билетам (нет нужных столбцов: рейс, дата вылета, дни до вылета, тариф, возврат)' };
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
                // на руках в день H: куплены не позже dtd >= H и не сданы к этому дню (возврат позже или не было)
                const held = list.filter(t => t.dtd >= H && !(t.rd != null && t.rd >= H));
                const ro = held.filter(t => t.rd != null).length;   // сданные позже - в истории их нет (за вычетом возвратов)
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
            // месяц сливаем по вылетам: прежние вылеты, которых нет в файле, остаются
            const wr = await SharedStorage.updateJsonFile(`history/tickets-${m}.json`, (cur) => ({
                version: 1, updatedAt: new Date().toISOString(), flights: Object.assign({}, cur && cur.flights, byMonth[m])
            })).catch(() => ({ ok: false }));
            const w = !!wr.ok;
            ok = w && ok;
            if (w) Object.assign(tickets, byMonth[m]);
        }
        rev++;
        if (typeof ActivityLog !== 'undefined') ActivityLog.log('import', `История по билетам: ${flights} вылетов`);
        if (ok) {
            const read = await readLastImport().catch(() => null);
            const base = (read && read.ok && lastImport) ? lastImport : {};
            lastImport = Object.assign({}, base, { ticketsSig: fileSig(file), ticketsAt: new Date().toISOString(), ticketsFlights: flights });
            await writeImportMark({ ticketsSig: fileSig(file), ticketsAt: lastImport.ticketsAt, ticketsFlights: flights });
            try { localStorage.setItem(IMPORT_LOCAL_KEY + '_t', fileSig(file)); } catch (e) { /* ignore */ }
        }
        return { ok, flights };
    }

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

    // обычные кресла рейса (по нынешним данным) - для вылетов истории с ёмкостью по проданному
    function typicalSeats(code) { return typicalOf(code).s || 0; }

    return {
        typicalSeats,
        autoImportTickets,
        ticketsFor,
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
        captureSoon,
        scheduleAfterStart,
        revision: () => rev
    };
})();
