// Архив продаж: то, что иначе уходит из окна выгрузки.
// • curves-ГГГГ-ММ.json — итог каждого улетевшего вылета: кресла, тип ВС, билеты и выручка,
//   и сколько билетов продано в каждый «день до вылета». По ним строится норма по дням недели
//   (sales-report.js) и «год назад», когда вылет уже пропал из файла продаж.
// • slices-ГГГГ-ММ.json — ежедневный срез загрузки вылетов на 60 дней вперёд (продано, кресла):
//   видно, как менялась загрузка с учётом возвратов. Читается только по запросу (карточка рейса).
// Пишет только тот, кто публикует данные (право share_data), в фоне и не чаще раза на новые данные.
// Читаются файлы тоже в фоне после входа: несколько сотен КБ, старт не задерживают. Без ФИО и PNR.
window.SalesArchive = (function () {
    const MONTHS_BACK = 3;           // норма берёт вылеты ±8 недель — хватает трёх месяцев
    const MAX_DTD = 365;
    const SLICE_DAYS_AHEAD = 60;
    const DONE_KEY = 'krasavia_archive_done';

    let curves = Object.create(null);   // 'дд.мм.гггг|KV-107' → запись
    let slices = Object.create(null);   // 'дд.мм.гггг' (дата среза) → { at, rows: { 'дата вылета': { 'KV-107': [продано, кресла] } } }
    const loadedMonths = new Set();
    const loadedSliceMonths = new Set();
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
        const c = r.data;
        if (c && c.flights && typeof c.flights === 'object') {
            Object.keys(c.flights).forEach(k => {
                const e = normalizeCurve(c.flights[k]);
                if (e && (!curves[k] || e.t > curves[k].t)) curves[k] = e;
            });
        }
    }

    async function readSliceMonth(month) {
        if (loadedSliceMonths.has(month)) return;
        loadedSliceMonths.add(month);
        if (typeof SharedStorage === 'undefined') return;
        const r = await SharedStorage.readJsonFileStrict(`history/slices-${month}.json`).catch(() => ({ ok: false }));
        if (!r.ok) loadedSliceMonths.delete(month);
        const s = r.data;
        if (s && s.days && typeof s.days === 'object') {
            Object.keys(s.days).forEach(day => {
                const d = s.days[day];
                if (d && d.rows && typeof d.rows === 'object' && (!slices[day] || String(d.at || '') > slices[day].at)) {
                    slices[day] = { at: String(d.at || ''), rows: d.rows };
                }
            });
        }
    }

    // Срезы за этот и прошлый месяц — для истории загрузки вылета (вылеты до 60 дней вперёд).
    function ensureSlices() {
        const now = monthOf(todayStr());
        if (!now) return Promise.resolve();
        return Promise.all([readSliceMonth(now), readSliceMonth(shiftMonth(now, -1))]).then(() => { rev++; });
    }

    function normalizeCurve(e) {
        if (!e || typeof e !== 'object' || !Array.isArray(e.c)) return null;
        const c = e.c.slice(0, MAX_DTD + 1).map(v => Math.max(0, parseInt(v, 10) || 0));
        const t = c.reduce((a, b) => a + b, 0);
        return {
            c,
            t,
            s: Math.max(0, parseInt(e.s, 10) || 0),
            ac: String(e.ac || '').slice(0, 20),
            sold: Math.max(0, parseInt(e.sold, 10) || 0),
            rev: Math.max(0, Math.round(Number(e.rev) || 0))
        };
    }

    // Загрузить последние месяцы (и те же месяцы год назад — для «год назад, тот же день недели»).
    function ensureLoaded() {
        if (loading) return loading;
        const now = monthOf(todayStr());
        if (!now) return Promise.resolve();
        const months = [];
        for (let i = 0; i <= MONTHS_BACK; i++) months.push(shiftMonth(now, -i));
        months.push(shiftMonth(now, -12), shiftMonth(now, -11));
        loading = Promise.all(months.map(m => readMonth(m).catch(() => null))).then(() => {
            rev++;
            refreshOpenReport();
        });
        return loading;
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

    // Улетевшие вылеты рейса из архива (для нормы по дням недели).
    function departuresFor(code) {
        const out = [];
        const suffix = '|' + code;
        Object.keys(curves).forEach(k => {
            if (!k.endsWith(suffix)) return;
            const e = curves[k];
            out.push({ date: k.slice(0, k.length - suffix.length), code, seats: e.s, aircraft: e.ac, sold: e.sold, total: e.t });
        });
        return out;
    }

    // Загрузка вылета по дням среза: [{ day, sold, seats }] — от старых к новым.
    function slicesFor(dateStr, code) {
        return Object.keys(slices)
            .map(day => ({ day, v: (slices[day].rows[dateStr] || {})[code] }))
            .filter(x => Array.isArray(x.v))
            .sort((a, b) => (parseLocalDate(a.day) || 0) - (parseLocalDate(b.day) || 0))
            .map(x => ({ day: x.day, sold: x.v[0], seats: x.v[1] }));
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

    function sliceDay() {
        const d = typeof lastSalesUpdate !== 'undefined' && lastSalesUpdate instanceof Date && !isNaN(lastSalesUpdate)
            ? lastSalesUpdate : new Date();
        return { day: formatDateRu(d), at: d.toISOString() };
    }

    function dataToken() {
        const at = typeof lastSalesUpdate !== 'undefined' && lastSalesUpdate ? new Date(lastSalesUpdate).getTime() : 0;
        return `${at}|${(allData || []).length}|${Object.keys(salesDetails || {}).length}`;
    }

    async function mergeAndWrite(file, kind, additions) {
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
                    flights[k] = next;
                    changed = true;
                }
            });
            out.flights = flights;
        } else {
            const days = remote && remote.days && typeof remote.days === 'object' ? { ...remote.days } : {};
            Object.keys(additions).forEach(day => {
                const prev = days[day];
                if (!prev || String(additions[day].at) >= String(prev.at || '')) {
                    days[day] = additions[day];
                    changed = true;
                }
            });
            out.days = days;
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
        const sliceRows = {};
        eachDeparture((key, date, code, row) => {
            const fly = parseLocalDate(date);
            if (!fly || !today) return;
            if (fly < today) {
                const e = buildCurve(date, code, row);
                if (!e) return;
                const m = monthOf(date);
                (curvesByMonth[m] || (curvesByMonth[m] = {}))[key] = e;
            } else if ((fly - today) / 86400000 <= SLICE_DAYS_AHEAD) {
                const sold = typeof getSoldFromRow === 'function' ? getSoldFromRow(row) : (parseInt(row[6], 10) || 0);
                const seats = typeof getSeatsOnSale === 'function' ? getSeatsOnSale(row) : 0;
                (sliceRows[date] || (sliceRows[date] = {}))[code] = [sold, seats];
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
        const { day, at } = sliceDay();
        if (Object.keys(sliceRows).length) {
            ok = (await mergeAndWrite(`history/slices-${monthOf(day)}.json`, 'slices', { [day]: { at, rows: sliceRows } })) && ok;
            slices[day] = { at, rows: sliceRows };
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

    return {
        ensureLoaded,
        ensureMonth,
        ensureSlices,
        curveFor,
        departuresFor,
        slicesFor,
        capture,
        captureSoon,
        scheduleAfterStart,
        revision: () => rev
    };
})();
