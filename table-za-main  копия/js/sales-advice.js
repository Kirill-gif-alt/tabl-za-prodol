// Подсказка ценового решения по вылету (для «Управления продажами» и утренней сводки).
// Только вылеты в ближайшие 20 дней. Сравнивает продано сейчас с нормой («обычно к этому дню»)
// и с планом (файл ожидаемой загрузки) — те же цифры, что в выводе карточки и детализации:
//   отстаёт от всех доступных ориентиров на порог и больше  → ▼ снизить;
//   опережает все ориентиры на порог и больше             → ▲ повысить;
//   от одного отстаёт, другой опережает на порог           → ! внимание.
// Порог — 10% кресел, но не меньше 3 билетов. Решение всегда принимает человек: это только подсветка.
window.SalesAdvice = (function () {
    const DAYS_AHEAD = 20;
    let memo = new Map();
    let memoSig = '';

    function sig() {
        const epoch = typeof dataEpoch === 'number' ? dataEpoch : 0;
        const today = typeof getTodayDate === 'function' ? getTodayDate() : '';
        const rows = typeof allData !== 'undefined' && allData ? allData.length : 0;
        return `${epoch}|${today}|${rows}`;
    }

    function daysUntil(date) {
        return typeof getDaysUntil === 'function' ? getDaysUntil(date) : null;
    }

    function inWindow(date) {
        const d = daysUntil(date);
        // С завтрашнего дня: в день вылета менять цену уже поздно.
        return d != null && d >= 1 && d <= DAYS_AHEAD;
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
        if (ref != null && !isNaN(ref)) refs.push({ label: 'обычно к этому дню', value: Math.round(ref), d: sold - Math.round(ref) });
        if (exp != null && !isNaN(exp)) refs.push({ label: 'по плану', value: exp, d: sold - exp });
        if (!refs.length) return null;
        const T = Math.max(3, Math.round((seats || 0) * 0.10));
        const behind = refs.filter(r => r.d <= -T).length;
        const ahead = refs.filter(r => r.d >= T).length;
        let status = null;
        if (behind === refs.length) status = 'down';
        else if (ahead === refs.length) status = 'up';
        else if (behind && ahead) status = 'attn';
        const dtd = daysUntil(date);
        const diff = (d) => (d > 0 ? `+${d}` : String(d));
        const text = `Продано ${sold} ${dtd === 0 ? 'в день вылета' : `за ${dtd} дн. до вылета`}; ` + refs.map(r => `${r.label} ${r.value} (${diff(r.d)})`).join(', ');
        return { code, date, base, status, sold, refs, threshold: T, dtd, text, seats };
    }

    // Подсказка для вылета или null (нет данных / вне 20 дней / не о чем подсказывать).
    function forDeparture(code, date) {
        if (!code || !date || !inWindow(date)) return null;
        const s = sig();
        if (s !== memoSig) { memo = new Map(); memoSig = s; }
        const key = code + '|' + date;
        if (memo.has(key)) return memo.get(key);
        let res = null;
        try { res = compute(code, date); } catch (e) { console.warn('SalesAdvice', code, date, e); }
        memo.set(key, res);
        return res;
    }

    const LABEL = { down: '▼ снизить', up: '▲ повысить', attn: '! внимание' };
    const STATUS = { down: 'down', up: 'up', attn: 'attn' };

    // Все вылеты в окне 20 дней (по загруженным данным): [{ code, date, base }].
    function departuresAhead() {
        const out = [];
        const seen = new Set();
        Object.keys(typeof groupedData !== 'undefined' && groupedData ? groupedData : {}).forEach(base => {
            (groupedData[base] || []).forEach(r => {
                if (!r || !r[0] || !r[1] || !inWindow(r[1])) return;
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
    async function scanAll(onProgress) {
        const list = departuresAhead();
        const out = [];
        for (let i = 0; i < list.length; i++) {
            const a = forDeparture(list[i].code, list[i].date);
            if (a && a.status) out.push(a);
            if (i % 25 === 24) {
                if (onProgress) onProgress(i + 1, list.length);
                await new Promise(r => setTimeout(r, 0));
            }
        }
        return out;
    }

    return { forDeparture, scanAll, departuresAhead, inWindow, LABEL, STATUS, DAYS_AHEAD };
})();
