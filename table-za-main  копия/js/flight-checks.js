// Проверки рейсов на ошибки в продажах.
// Сейчас одна проверка: субсидированный рейс, на котором продан детский тариф со скидкой 50%
// (код тарифа …/CN50). Субсидированность — как в «Экономической таблице»: ручная правка субсидии,
// иначе файл расходов и периодов субсидий (RouteCosts.lookup).
// Значок «!» ставится у рейса в «Загрузке рейсов», «Экономической таблице» и «Динамике продаж»,
// полный список — во вкладке «Отчёты», счётчик — в шапке.
window.FlightChecks = (function () {
    const RULE_TITLE = 'Детский тариф −50% на субсидированном рейсе';

    let cache = { epoch: -1, details: null, grouped: null, all: null, candidates: new Map() };

    function isChild50(sale) {
        if (!sale || typeof extractDiscountPercent !== 'function') return false;
        if (extractDiscountPercent(sale.basicFareStr) !== 50) return false;
        return typeof isChildSaleRecord === 'function' ? isChildSaleRecord(sale) : true;
    }

    // Тяжёлая часть — поиск билетов …/CN50 в продажах; пересчитывается только после загрузки данных.
    function candidates() {
        const epoch = typeof dataEpoch === 'number' ? dataEpoch : 0;
        const details = typeof salesDetails !== 'undefined' ? salesDetails : null;
        const grouped = typeof groupedData !== 'undefined' ? groupedData : null;
        const all = typeof allData !== 'undefined' ? allData : null;
        if (cache.epoch === epoch && cache.details === details && cache.grouped === grouped && cache.all === all) {
            return cache.candidates;
        }
        const map = new Map();
        Object.keys(grouped || {}).forEach(base => {
            if (typeof isValidFlightBase === 'function' && !isValidFlightBase(base)) return;
            const rows = grouped[base] || [];
            const first = typeof buildFirstSalesRowByKey === 'function' ? buildFirstSalesRowByKey(rows) : null;
            rows.forEach(row => {
                if (!row || !row[0] || !row[1]) return;
                if (first && typeof shouldAttachSalesToRowCached === 'function' && !shouldAttachSalesToRowCached(row, first)) return;
                const list = typeof getSalesDetailsForRow === 'function' ? (getSalesDetailsForRow(row) || []) : [];
                const hits = list.filter(isChild50);
                if (!hits.length) return;
                const code = cleanFlight(row[0]);
                map.set(code + '|' + row[1], { code, date: row[1], base, row, hits });
            });
        });
        cache = { epoch, details, grouped, all, candidates: map };
        return map;
    }

    // Субсидия проверяется на лету: правка субсидии в «Экономической таблице» сразу меняет результат.
    function subsidyInfo(c) {
        if (typeof SharedOverrides !== 'undefined' && SharedOverrides.hasSubsidy(c.code, c.date)) {
            const amount = SharedOverrides.getSubsidy(c.code, c.date) || 0;
            return { subsidized: amount !== 0, source: 'ручная правка', amount };
        }
        const econ = typeof RouteCosts !== 'undefined' && RouteCosts.lookup ? RouteCosts.lookup(c.row, c.code, c.date) : null;
        return {
            subsidized: !!(econ && econ.subsidized),
            source: 'файл субсидий',
            amount: econ ? (econ.subsidyOneWay || 0) : 0
        };
    }

    function stateOf(c) {
        if (typeof closedFlights !== 'undefined' && typeof getSalesLookupKey === 'function' && closedFlights.has(getSalesLookupKey(c.row))) return 'Закрыт';
        const d = parseLocalDate(c.date);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        return d && d < today ? 'Улетел' : 'Открыт';
    }

    function issueOf(c) {
        const sub = subsidyInfo(c);
        if (!sub.subsidized) return null;
        const fares = [];
        let paid = 0;
        c.hits.forEach(s => {
            const f = String(s.basicFareStr || '').trim();
            if (f && fares.indexOf(f) === -1) fares.push(f);
            paid += Number(s.fare) || 0;
        });
        const n = c.hits.length;
        return {
            rule: 'child50_subsidy',
            title: RULE_TITLE,
            code: c.code,
            base: c.base,
            date: c.date,
            direction: typeof getFlightDirection === 'function' ? getFlightDirection(c.code) : c.code,
            state: stateOf(c),
            count: n,
            fares,
            paid,
            subsidySource: sub.source,
            subsidyAmount: sub.amount,
            text: `${c.code} ${c.date}: субсидированный рейс, продано детских билетов со скидкой 50% — ${n} (${fares.join(', ')})`
        };
    }

    function issueFor(code, date) {
        const c = candidates().get(cleanFlight(code) + '|' + date);
        return c ? issueOf(c) : null;
    }

    function list() {
        const out = [];
        candidates().forEach(c => {
            const issue = issueOf(c);
            if (issue) out.push(issue);
        });
        out.sort((a, b) => {
            const da = parseLocalDate(a.date);
            const db = parseLocalDate(b.date);
            const t = (da ? da.getTime() : 0) - (db ? db.getTime() : 0);
            return t || String(a.code).localeCompare(String(b.code), 'ru', { numeric: true });
        });
        return out;
    }

    function flagForRow(row) {
        if (!row || !row[0] || !row[1]) return '';
        const issue = issueFor(row[0], row[1]);
        if (!issue) return '';
        const tip = `${RULE_TITLE}. ${issue.text}`;
        const esc = typeof escAttr === 'function' ? escAttr : (v) => String(v);
        return `<span class="fc-flag" role="img" aria-label="${esc(tip)}" title="${esc(tip)}"></span>`;
    }

    function rowsHaveIssue(rows) {
        return (rows || []).some(row => row && row[0] && row[1] && !!issueFor(row[0], row[1]));
    }

    function rowClass(rows) {
        return rowsHaveIssue(rows) ? ' fc-row-problem' : '';
    }

    function canOpenReport() {
        return typeof ProfileAuth === 'undefined' || ProfileAuth.canAccessTab('reports');
    }

    function openReport() {
        if (typeof switchMainTab !== 'function' || !canOpenReport()) return;
        switchMainTab('reports');
        requestAnimationFrame(() => {
            const el = document.getElementById('rp-checks');
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    }

    // Счётчик в шапке: показывает только ошибки по рейсам, которые ещё не улетели.
    function headerChip() {
        const open = list().filter(i => i.state !== 'Улетел');
        if (!open.length) return null;
        const chip = document.createElement('span');
        chip.className = 'header-kpi-error';
        chip.textContent = '! ' + open.length;
        chip.title = `${RULE_TITLE}: ${open.length} рейс(ов) до вылета. Нажмите, чтобы открыть отчёт.`;
        if (canOpenReport()) chip.addEventListener('click', openReport);
        return chip;
    }

    return { list, issueFor, flagForRow, rowClass, headerChip, openReport, RULE_TITLE };
})();
