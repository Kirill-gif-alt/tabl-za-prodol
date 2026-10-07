// Парсинг загрузки по сегментам (RepRaidAvailSeg / «загрузка таб»)

function readCsvText(file) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = e => resolve(e.target.result);
        r.onerror = () => reject(new Error('Ошибка чтения файла'));
        r.readAsText(file, 'windows-1251');
    });
}

function isAircraftConfig(val) {
    const s = String(val || '').toUpperCase();
    return /^(AN4|AN6|AT5|AT7|YK2|ATR|AN-|AT-)/.test(s) || s.includes('/');
}

/**
 * Время из файла загрузки: «08:45», «8:45», «+1 08:45», «+108:45»
 * (+N = прилёт на N-й следующий календарный день; в UI показываем только HH:MM)
 */
function looksLikeTime(val) {
    const s = String(val || '').trim();
    return /^(?:\+\d+\s*)?\d{1,2}:\d{2}(?::\d{2})?$/.test(s);
}

/** Убрать префикс +N и нормализовать в HH:MM */
function normalizeTimeStr(val) {
    const s = String(val || '').trim();
    if (!s) return '';
    // один match: «08:45», «+1 08:45», «+108:45» (движок сам отрежет +N)
    const m = s.match(/^(?:\+\d+\s*)?(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if (!m) return '';
    const hh = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    if (isNaN(hh) || isNaN(mm) || hh > 23 || mm > 59) return '';
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** Минуты от полуночи; без времени → 9999 (в конец дня при сортировке) */
function timeToMinutes(val) {
    const raw = String(val || '');
    if (raw.length === 5 && raw[2] === ':') {
        const hh = raw.charCodeAt(0) * 10 + raw.charCodeAt(1) - 528;
        const mm = raw.charCodeAt(3) * 10 + raw.charCodeAt(4) - 528;
        if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) return hh * 60 + mm;
    }
    const s = normalizeTimeStr(val);
    if (!s) return 9999;
    return parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
}

function isSalesStatusOpen(status) {
    const s = String(status || '').toLowerCase().trim();
    if (!s) return true;
    if (s.includes('закрыт')) return false;
    return s.includes('открыт');
}

function parseSegmentField(seg) {
    const raw = String(seg || '').trim();
    const m = raw.match(/^(\d+-\d+)\s+(.+)$/);
    if (m) return { legs: m[1], route: m[2].trim().toUpperCase() };
    if (/^[A-Z]{3}-[A-Z]{3}$/i.test(raw)) return { legs: '', route: raw.toUpperCase() };
    return { legs: '', route: raw };
}

function getRouteFromRow(row) {
    const route = String(row[3] || '').trim();
    if (route) return route.toUpperCase();
    return parseSegmentField(row[2]).route;
}

function getFlightRowKey(row) {
    const date = row[1];
    const fl = cleanFlight(row[0]);
    const route = getRouteFromRow(row);
    if (date && fl && route) return `${date}|${fl}|${route}`;
    if (date && fl) return `${date}|${fl}`;
    return '';
}

function getSalesLookupKey(row) {
    return `${row[1]}|${cleanFlight(row[0])}`;
}

function resolveSalesKey(row) {
    return getSalesLookupKey(row);
}

function getSalesMapForRow(row) {
    const k = resolveSalesKey(row);
    return salesMap[k] || (typeof emptySalesBucket === 'function' ? emptySalesBucket() : { today: 0, yesterday: 0, day2: 0, d7: 0, d14: 0, d30: 0 });
}

function getSalesDetailsForRow(row) {
    const k = resolveSalesKey(row);
    return salesDetails[k] || [];
}

/** Вр. вылета / прилёта — индексы 11, 12 (после status) */
function getDepTime(row) {
    if (!row) return '';
    const t = row[11];
    if (typeof t === 'string' && t.length === 5 && t.charCodeAt(2) === 58) return t;
    return normalizeTimeStr(t);
}

function getArrTime(row) {
    if (!row) return '';
    const t = row[12];
    if (typeof t === 'string' && t.length === 5 && t.charCodeAt(2) === 58) return t;
    return normalizeTimeStr(t);
}

function formatRouteDisplay(route) {
    const r = String(route || '').trim().toUpperCase();
    if (!r) return '';
    const parts = r.split('-');
    if (parts.length === 2) return `${parts[0]} → ${parts[1]}`;
    return r;
}

function countRowsByDateFlight(rows) {
    const counts = {};
    rows.forEach(r => {
        const k = getSalesLookupKey(r);
        if (!k) return;
        counts[k] = (counts[k] || 0) + 1;
    });
    return counts;
}

function shouldShowRouteForRow(row, rowsOrCounts) {
    const k = getSalesLookupKey(row);
    if (!k) return false;
    const counts = Array.isArray(rowsOrCounts) ? countRowsByDateFlight(rowsOrCounts) : rowsOrCounts;
    if (!counts) return false;
    return (counts[k] || 0) >= 2;
}

function buildFirstSalesRowByKey(rows) {
    const map = new Map();
    for (const r of rows) {
        const k = getSalesLookupKey(r);
        if (k && !map.has(k)) map.set(k, r);
    }
    return map;
}

function shouldAttachSalesToRowCached(row, firstByKey) {
    const key = getSalesLookupKey(row);
    return firstByKey.get(key) === row;
}

function hasMultiSegmentDates(rows) {
    const counts = countRowsByDateFlight(rows);
    return Object.values(counts).some(c => c >= 2);
}

/**
 * Row layout (stable indices for rest of app):
 * [0]flight [1]date [2]segment [3]route [4]config
 * [5]total [6]free [7]totalSeg [8]avs [9]totalAv [10]status
 * [11]depTime [12]arrTime
 */
/**
 * Прочитать поле времени: «08:45» / «+1 08:45» /
 * либо «+1» и следующее поле «08:45» (сдвиг столбцов).
 * @returns {{ time: string, next: number }}
 */
function readTimeField(chunk, idx) {
    const cur = chunk[idx];
    if (looksLikeTime(cur)) {
        return { time: normalizeTimeStr(cur), next: idx + 1 };
    }
    const alone = String(cur || '').trim();
    if (/^\+\d+$/.test(alone) && looksLikeTime(chunk[idx + 1])) {
        return { time: normalizeTimeStr(chunk[idx + 1]), next: idx + 2 };
    }
    return { time: normalizeTimeStr(cur), next: idx + 1 };
}

function parseAvailabilityChunk(chunk) {
    if (!chunk || chunk.length < 7) return null;
    const flight = cleanFlight(chunk[0]);
    const date = normalizeDate(chunk[1]);
    if (!flight || !date) return null;

    let segment, route, status, config, total, free, totalSeg, avs, totalAv, dep = '', arr = '';
    const col4IsConfig = isAircraftConfig(chunk[4]);

    // Новый формат: статус + вр.вылета + вр.прилёта + конфигурация + AU…
    // [2]seg [3]route [4]status [5]dep [6]arr [7]config [8]total [9]free [10]totSeg [11]avs [12]totAv
    if (!col4IsConfig && looksLikeTime(chunk[5]) && chunk.length >= 12) {
        segment = chunk[2];
        route = String(chunk[3] || '').trim().toUpperCase();
        status = chunk[4];
        const d = readTimeField(chunk, 5);
        dep = d.time;
        const a = readTimeField(chunk, d.next);
        arr = a.time;
        let i = a.next;
        config = chunk[i++];
        total = chunk[i++];
        free = chunk[i++];
        totalSeg = chunk[i++];
        avs = chunk[i++];
        totalAv = chunk[i++];
    } else if (!col4IsConfig && chunk.length >= 11) {
        // Старый: статус + config + AU (без времён)
        segment = chunk[2];
        route = String(chunk[3] || '').trim().toUpperCase();
        status = chunk[4];
        config = chunk[5];
        total = chunk[6];
        free = chunk[7];
        totalSeg = chunk[8];
        avs = chunk[9];
        totalAv = chunk[10];
    } else if (looksLikeTime(chunk[4]) && (isAircraftConfig(chunk[6]) || isAircraftConfig(chunk[7]))) {
        // Без статуса: dep, arr, config… (arr может быть «+1 08:45» или «+1»+время)
        segment = chunk[2];
        route = String(chunk[3] || '').trim().toUpperCase();
        status = '';
        const d = readTimeField(chunk, 4);
        dep = d.time;
        const a = readTimeField(chunk, d.next);
        arr = a.time;
        let i = a.next;
        config = chunk[i++];
        total = chunk[i++];
        free = chunk[i++];
        totalSeg = chunk[i++];
        avs = chunk[i++];
        totalAv = chunk[i++];
    } else {
        // Самый старый: config сразу после route
        segment = chunk[2];
        route = String(chunk[3] || '').trim().toUpperCase();
        status = '';
        config = chunk[4];
        total = chunk[5];
        free = chunk[6];
        totalSeg = chunk[7];
        avs = chunk[8];
        totalAv = chunk[9];
    }

    if (!route) route = parseSegmentField(segment).route;
    if (status && !isSalesStatusOpen(status)) return null;

    return [flight, date, segment, route, config, total, free, totalSeg, avs, totalAv, status, dep, arr];
}

function parseAvailabilityLine(line) {
    const cols = line.split(';').map(x => x.trim());
    const records = [];
    const flightIndices = [];
    for (let i = 0; i < cols.length; i++) {
        if (/^KV-\d/i.test(cols[i])) flightIndices.push(i);
    }
    if (!flightIndices.length) return records;

    for (let fi = 0; fi < flightIndices.length; fi++) {
        const start = flightIndices[fi];
        const end = flightIndices[fi + 1] ?? cols.length;
        const rec = parseAvailabilityChunk(cols.slice(start, end));
        if (rec) records.push(rec);
    }
    return records;
}

/** Лимит строк загрузки — защита от чрезмерного потребления памяти */
const MAX_AVAILABILITY_ROWS = 120000;

function parseAvailabilityText(text, fromLine, into) {
    const lines = String(text || '').split(/\r?\n/);
    const rows = into || [];
    let headerPassed = fromLine > 0;
    const start = fromLine || 0;

    for (let i = start; i < lines.length; i++) {
        if (rows.length >= MAX_AVAILABILITY_ROWS) break;
        const trimmed = lines[i].trim();
        if (!trimmed) continue;
        if (!headerPassed) {
            if (/^KV-\d/i.test(trimmed)) headerPassed = true;
            else continue;
        }
        if (!/^KV-\d/i.test(trimmed)) continue;
        const recs = parseAvailabilityLine(trimmed);
        for (let r = 0; r < recs.length && rows.length < MAX_AVAILABILITY_ROWS; r++) {
            rows.push(recs[r]);
        }
    }
    return rows;
}

/** Крупный CSV загрузки: отдаём UI каждые N строк */
async function parseAvailabilityTextAsync(text, onProgress) {
    const lines = String(text || '').split(/\r?\n/);
    const rows = [];
    let headerPassed = false;
    const YIELD_EVERY = 400;
    const n = lines.length;

    for (let i = 0; i < n; i++) {
        if (rows.length >= MAX_AVAILABILITY_ROWS) break;
        const trimmed = lines[i].trim();
        if (!trimmed) continue;
        if (!headerPassed) {
            if (/^KV-\d/i.test(trimmed)) headerPassed = true;
            else continue;
        }
        if (!/^KV-\d/i.test(trimmed)) continue;
        const recs = parseAvailabilityLine(trimmed);
        for (let r = 0; r < recs.length && rows.length < MAX_AVAILABILITY_ROWS; r++) {
            rows.push(recs[r]);
        }
        if (i && i % YIELD_EVERY === 0) {
            if (typeof onProgress === 'function') onProgress(Math.min(99, Math.round((i / n) * 100)));
            await new Promise((res) => setTimeout(res, 0));
        }
    }
    return rows;
}

function dedupeAvailabilityRows(rows) {
    const map = new Map();
    for (const row of rows) {
        const key = getFlightRowKey(row);
        if (!key) continue;
        if (!map.has(key)) map.set(key, row);
    }
    return [...map.values()];
}

function sumUniqueSalesForRows(rows) {
    const seen = new Set();
    let tSum = 0, ySum = 0, d2Sum = 0, d7Sum = 0, d14Sum = 0, d30Sum = 0;
    rows.forEach(r => {
        const k = resolveSalesKey(r);
        if (seen.has(k)) return;
        seen.add(k);
        const s = getSalesMapForRow(r);
        tSum += s.today || 0;
        ySum += s.yesterday || 0;
        d2Sum += s.day2 || 0;
        d7Sum += s.d7 || 0;
        d14Sum += s.d14 || 0;
        d30Sum += s.d30 || 0;
    });
    return { tSum, ySum, d2Sum, d7Sum, d14Sum, d30Sum };
}

function collectSalesByDealDateForFlightDate(baseFlight, flyDateStr, flightCode) {
    const salesByDealDate = {};
    const code = flightCode ? cleanFlight(flightCode) : cleanFlight(baseFlight);

    const addSalesFromKey = (key) => {
        if (!key) return;
        (salesDetails[key] || []).forEach(sale => {
            const deal = sale.dealDate;
            if (!deal) return;
            if (!salesByDealDate[deal]) salesByDealDate[deal] = { count: 0, totalFare: 0 };
            salesByDealDate[deal].count++;
            salesByDealDate[deal].totalFare += (sale.adjustedFare || sale.fare || 0);
        });
    };

    addSalesFromKey(`${flyDateStr}|${code}`);
    return salesByDealDate;
}

function isLoadTabDirName(name) {
    const l = String(name || '').toLowerCase();
    return l.includes('загрузка таб') || l.includes('загрузкатаб');
}

/** Сортировка: дата, затем время вылета */
function compareRowsByDateThenDep(a, b, dir = 'asc') {
    const sign = dir === 'desc' ? -1 : 1;
    const da = typeof compareDateStr === 'function'
        ? compareDateStr(a[1], b[1])
        : (parseLocalDate(a[1])?.getTime() || 0) - (parseLocalDate(b[1])?.getTime() || 0);
    if (da !== 0) return sign * da;
    const ta = timeToMinutes(getDepTime(a));
    const tb = timeToMinutes(getDepTime(b));
    return sign * (ta - tb);
}
