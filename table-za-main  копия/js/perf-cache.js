// Кэши и агрегаты для ускорения парсинга и отрисовки
window.PerfCache = (function () {
    const cleanFlightCache = new Map();
    const baseFlightCache = new Map();
    const localDateCache = new Map();
    const dayOfWeekCache = new Map();
    const daysUntilCache = new Map();
    const weekNumberCache = new Map();
    const LOCAL_DATE_CACHE_MAX = 12_000;
    const MEMO_CACHE_MAX = 12_000;

    let salesStatsByKey = Object.create(null);
    let salesTodayKpi = { sales: 0, revenue: 0 };

    function reset() {
        cleanFlightCache.clear();
        baseFlightCache.clear();
        localDateCache.clear();
        dayOfWeekCache.clear();
        daysUntilCache.clear();
        weekNumberCache.clear();
        salesStatsByKey = Object.create(null);
        salesTodayKpi = { sales: 0, revenue: 0 };
    }

    function memoSet(map, key, value, maxSize) {
        if (maxSize && map.size >= maxSize) map.clear();
        map.set(key, value);
        return value;
    }

    function cleanFlightMemo(raw) {
        const key = raw || '';
        if (cleanFlightCache.has(key)) return cleanFlightCache.get(key);
        const n = String(key).replace(/[^0-9]/g, '');
        return memoSet(cleanFlightCache, key, n ? 'KV-' + n : '', MEMO_CACHE_MAX);
    }

    function getBaseFlightMemo(flight) {
        const key = String(flight || '');
        if (baseFlightCache.has(key)) return baseFlightCache.get(key);
        // Справочник рейсов (flight-registry.js): свои доп. номера и рейсы важнее встроенных правил.
        const reg = window.FLIGHT_EXTRA_BASE;
        if (reg && reg[key]) return memoSet(baseFlightCache, key, reg[key], MEMO_CACHE_MAX);
        let n = parseInt(key.replace('KV-', ''), 10) || 0;
        let result = key;
        if ([151, 351, 355, 455].includes(n)) result = 'KV-155';
        else if ([152, 352, 356, 456].includes(n)) result = 'KV-156';
        else if (n === 261) result = 'KV-161';
        else if (n === 262) result = 'KV-162';
        else if (n === 253) result = 'KV-153';
        else if (n === 254) result = 'KV-154';
        else if (n === 273) result = 'KV-173';
        else if (n === 274) result = 'KV-174';
        else if (n === 325) result = 'KV-225';
        else if (n === 326) result = 'KV-226';
        else if ([347, 348].includes(n)) result = 'KV-' + (n - 100);
        else if (n >= 300 && n <= 399) result = 'KV-' + (n - 200);
        else if (n >= 400 && n <= 499) result = 'KV-' + (n - 300);
        return memoSet(baseFlightCache, key, result, MEMO_CACHE_MAX);
    }

    // Справочник рейсов изменился — базовые номера пересчитать.
    function clearFlightCaches() {
        baseFlightCache.clear();
    }

    function cloneMemoDate(d) {
        return d instanceof Date && !isNaN(d.getTime()) ? new Date(d.getTime()) : d;
    }

    function parseLocalDateMemo(dateStr) {
        if (!dateStr) return null;
        const key = String(dateStr);
        if (localDateCache.has(key)) return cloneMemoDate(localDateCache.get(key));
        const parts = key.split('.');
        if (parts.length !== 3) return null;
        const d = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10) - 1;
        const y = parseInt(parts[2], 10);
        if (typeof isValidCalendarDate === 'function') {
            if (!isValidCalendarDate(y, m, d)) return memoSet(localDateCache, key, null, LOCAL_DATE_CACHE_MAX);
        } else if (isNaN(d) || isNaN(m) || isNaN(y)) {
            return null;
        }
        const dt = new Date(y, m, d);
        if (dt.getFullYear() !== y || dt.getMonth() !== m || dt.getDate() !== d) {
            return memoSet(localDateCache, key, null, LOCAL_DATE_CACHE_MAX);
        }
        memoSet(localDateCache, key, dt, LOCAL_DATE_CACHE_MAX);
        return cloneMemoDate(dt);
    }

    // Время даты «ДД.ММ.ГГГГ» (полночь) числом — без копии Date, для частых сравнений; null — не дата.
    function dateTsMemo(dateStr) {
        if (!dateStr) return null;
        const key = String(dateStr);
        let d = localDateCache.get(key);
        if (d === undefined) {
            parseLocalDateMemo(key);
            d = localDateCache.get(key);
        }
        return d instanceof Date ? d.getTime() : null;
    }

    function getDayOfWeekMemo(dateStr, daysRu) {
        if (!dateStr) return '';
        if (dayOfWeekCache.has(dateStr)) return dayOfWeekCache.get(dateStr);
        const fd = parseLocalDateMemo(dateStr);
        const dow = fd && daysRu ? daysRu[fd.getDay()] : '';
        return memoSet(dayOfWeekCache, dateStr, dow, MEMO_CACHE_MAX);
    }

    function getDaysUntilMemo(input, todayStr) {
        if (!input) return null;
        const key = (input instanceof Date ? input.toISOString().slice(0, 10) : String(input)) + '|' + (todayStr || '');
        if (daysUntilCache.has(key)) return daysUntilCache.get(key);
        let f;
        if (input instanceof Date) f = new Date(input.getTime());
        else f = parseLocalDateMemo(String(input));
        if (!f) return memoSet(daysUntilCache, key, null, LOCAL_DATE_CACHE_MAX);
        const t = new Date();
        t.setHours(0, 0, 0, 0);
        f.setHours(0, 0, 0, 0);
        const v = Math.ceil((f - t) / 86400000);
        return memoSet(daysUntilCache, key, v, LOCAL_DATE_CACHE_MAX);
    }

    function getWeekNumberMemo(input) {
        if (!input) return 1;
        const key = input instanceof Date ? input.toISOString().slice(0, 10) : String(input);
        if (weekNumberCache.has(key)) return weekNumberCache.get(key);
        let d;
        if (input instanceof Date) d = new Date(input.getTime());
        else d = parseLocalDateMemo(key);
        if (!d) return memoSet(weekNumberCache, key, 1, LOCAL_DATE_CACHE_MAX);
        d.setHours(0, 0, 0, 0);
        const j = new Date(d.getFullYear(), 0, 1);
        j.setHours(0, 0, 0, 0);
        const dow = j.getDay();
        const mon = new Date(j);
        if (dow === 0) mon.setDate(j.getDate() - 6);
        else mon.setDate(j.getDate() - (dow - 1));
        const diff = Math.floor((d - mon) / 86400000);
        const w = Math.min(Math.max(Math.floor(diff / 7) + 1, 1), 52);
        return memoSet(weekNumberCache, key, w, LOCAL_DATE_CACHE_MAX);
    }

    function parseSalesDateFast(str) {
        const raw = String(str || '').trim();
        let digits = '';
        for (let i = 0; i < raw.length; i++) {
            const c = raw.charCodeAt(i);
            if (c >= 48 && c <= 57) digits += raw[i];
        }
        if (digits.length === 8) {
            return digits.slice(0, 2) + '.' + digits.slice(2, 4) + '.' + digits.slice(4);
        }
        return null;
    }

    function parseCsvLineFast(line) {
        if (line.indexOf('"') === -1) {
            const parts = line.split(',');
            for (let i = 0; i < parts.length; i++) parts[i] = parts[i].trim();
            return parts;
        }
        return null;
    }

    function resetSalesStats() {
        salesStatsByKey = Object.create(null);
        salesTodayKpi = { sales: 0, revenue: 0 };
    }

    function recordSaleStat(key, dealDate, adj, nf, basicFareStr, today, yesterday) {
        let st = salesStatsByKey[key];
        if (!st) {
            st = salesStatsByKey[key] = {
                count: 0,
                fareSum: 0,
                lastFare: 0,
                lastBasicFare: '',
                lastDealTs: 0
            };
        }
        st.count++;
        st.fareSum += adj || 0;
        if (dealDate === today) {
            salesTodayKpi.sales++;
            salesTodayKpi.revenue += adj || 0;
        }
        const ts = dateTsMemo(dealDate) || 0;
        if (ts >= st.lastDealTs) {
            st.lastDealTs = ts;
            st.lastFare = nf || 0;
            st.lastBasicFare = basicFareStr || '';
        }
    }

    function getSalesStats(key) {
        return salesStatsByKey[key] || null;
    }

    function getSalesAvg(key) {
        const st = salesStatsByKey[key];
        return st && st.count ? Math.round(st.fareSum / st.count) : 0;
    }

    function getTodayKpi() {
        return salesTodayKpi;
    }

    return {
        reset,
        resetSalesStats,
        cleanFlightMemo,
        getBaseFlightMemo,
        parseLocalDateMemo,
        dateTsMemo,
        clearFlightCaches,
        getDayOfWeekMemo,
        getDaysUntilMemo,
        getWeekNumberMemo,
        parseSalesDateFast,
        parseCsvLineFast,
        recordSaleStat,
        getSalesStats,
        getSalesAvg,
        getTodayKpi
    };
})();