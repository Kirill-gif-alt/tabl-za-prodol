// Проверки рейсов на ошибки в продажах. Проверяются только субсидированные рейсы:
// межрегиональный рейс, у которого в «Экономической таблице» есть сумма субсидии (ручная правка,
// иначе сумма из файла расходов и периодов субсидий). Краевые рейсы не субсидированные.
// KV-247/248 Томск — Стрежевой считаются рейсами без субсидии, хотя есть в файле субсидий:
// не проверяются и нигде в проверках не показываются (NEVER_SUBSIDIZED).
// Рейсы-исключения из справочника (fare-refs.js) тоже не проверяются.
// Правила:
//   child50_subsidy    — продан детский тариф со скидкой 50% (код тарифа …/CN50);
//   fare_above_subsidy — продан билет дороже предела из справочника субсидированных тарифов (fare-refs.js).
//   На коммерческих датах проверки нет: там своя лестница тарифов, в том числе дешевле субсидированного,
//   и те же коды классов (MSTOW, GSTOW…) — совпадение кода ошибкой не является.
// modeFor/modeBadge — режим даты вылета «субсидия / коммерция» для меток в таблицах и на Графплане.
// Значок «!» ставится у рейса в «Загрузке рейсов», «Экономической таблице» и «Динамике продаж»,
// полный список — во вкладке «Отчёты», счётчик — в шапке.
window.FlightChecks = (function () {
    const RULE_TITLE = 'Проверка рейсов';
    const RULES = {
        child50_subsidy: { title: 'Детский тариф −50% на субсидированном рейсе', short: 'Детский −50%' },
        fare_above_subsidy: { title: 'Тариф выше субсидированного', short: 'Выше субсидированного тарифа' }
    };

    const NEVER_SUBSIDIZED = new Set(['KV-247', 'KV-248']);

    let cache = { epoch: -1, details: null, grouped: null, all: null, candidates: new Map() };

    function isNeverSubsidized(code) {
        const c = typeof cleanFlight === 'function' ? cleanFlight(code) : String(code || '');
        if (NEVER_SUBSIDIZED.has(c)) return true;
        const base = typeof getBaseFlight === 'function' ? getBaseFlight(c) : c;
        return NEVER_SUBSIDIZED.has(base);
    }

    // Админ включает и выключает проверку каждому профилю в «Управлении профилями» → «Функции».
    function enabled() {
        return typeof ProfileAuth === 'undefined' || typeof ProfileAuth.featureOn !== 'function' || ProfileAuth.featureOn('flight_checks');
    }

    // Ребёнок — только код тарифа …/CNnn (или возраст до 12 лет, если в продажах есть дата рождения).
    // Младенцы (…/INnn, …/IDnn) детским тарифом не считаются.
    function childPercent(sale) {
        const m = /\/CN(\d{1,2})\b/i.exec(String(sale && sale.basicFareStr || ''));
        return m ? parseInt(m[1], 10) : null;
    }

    function isChild(sale) {
        if (!sale) return false;
        if (childPercent(sale) != null) return true;
        if (/\/(IN|ID)\d/i.test(String(sale.basicFareStr || ''))) return false;
        if (sale.birthDate && sale.flyDate && typeof calculateAgeAtFly === 'function') {
            const age = calculateAgeAtFly(sale.birthDate, sale.flyDate);
            return age !== null && age >= 2 && age < 12;
        }
        return false;
    }

    function isChild50(sale) {
        return childPercent(sale) === 50;
    }

    // Вылеты с продажами; пересчитывается только после загрузки данных.
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
                const sales = typeof getSalesDetailsForRow === 'function' ? (getSalesDetailsForRow(row) || []) : [];
                if (!sales.length) return;
                const code = cleanFlight(row[0]);
                map.set(code + '|' + row[1], { code, date: row[1], base, row, sales, memo: null });
            });
        });
        cache = { epoch, details, grouped, all, candidates: map };
        return map;
    }

    // Субсидия проверяется по текущим правкам: правка в «Экономической таблице» сразу меняет результат.
    function subsidyInfo(c) {
        if (isNeverSubsidized(c.code)) {
            return { subsidized: false, excluded: true, source: 'без субсидии', amount: 0 };
        }
        // Рейс, исключённый в справочнике, не считается субсидированным.
        if (typeof FareRefs !== 'undefined' && FareRefs.isExcluded && FareRefs.isExcluded(c.code, c.date)) {
            return { subsidized: false, excluded: true, source: 'исключён в справочнике', amount: 0 };
        }
        const inter = typeof getFlightRouteType === 'function' && getFlightRouteType(c.code) === 'interregional';
        if (typeof SharedOverrides !== 'undefined' && SharedOverrides.hasSubsidy(c.code, c.date)) {
            const amount = Number(SharedOverrides.getSubsidy(c.code, c.date)) || 0;
            return { subsidized: inter && amount > 0, commercial: inter && amount <= 0, source: 'ручная правка', amount };
        }
        const econ = typeof RouteCosts !== 'undefined' && RouteCosts.lookup ? RouteCosts.lookup(c.row, c.code, c.date) : null;
        const amount = econ ? (Number(econ.subsidyOneWay) || 0) : 0;
        // Коммерческая дата — у маршрута есть субсидия в файле, но на эту дату по периодам её нет.
        const commercial = !!(inter && econ && econ.commercial && !econ.krai && Number(econ.subsidyAmt) > 0);
        return { subsidized: inter && amount > 0, commercial, source: 'файл субсидий', amount };
    }

    function stateOf(c) {
        if (typeof closedFlights !== 'undefined' && typeof getSalesLookupKey === 'function' && closedFlights.has(getSalesLookupKey(c.row))) return 'Закрыт';
        const d = parseLocalDate(c.date);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        return d && d < today ? 'Улетел' : 'Открыт';
    }

    function rub(n) {
        return typeof formatRub === 'function' ? formatRub(n) : Math.round(n) + ' ₽';
    }

    function faresOf(list) {
        const out = [];
        list.forEach(s => {
            const f = String(s.basicFareStr || '').trim();
            if (f && out.indexOf(f) === -1) out.push(f);
        });
        return out;
    }

    function limitFor(sale, ref) {
        return isChild(sale) && ref.child != null ? ref.child : ref.adult;
    }

    function overLimit(sale, ref) {
        const paid = Number(sale && sale.fare) || 0;
        if (paid <= 0) return false;
        return Math.round(paid) > Math.round(limitFor(sale, ref));
    }

    // Суммы пределов видит только тот, кому админ дал право на справочник.
    function canSeeRefs() {
        return typeof FareRefs !== 'undefined' && FareRefs.canEdit();
    }

    function revisionToken() {
        const refs = typeof FareRefs !== 'undefined' ? FareRefs.revision() : 0;
        const subs = typeof SharedOverrides !== 'undefined' && SharedOverrides.subsidyRevision ? SharedOverrides.subsidyRevision() : 0;
        const today = typeof getTodayDate === 'function' ? getTodayDate() : '';
        return refs + '|' + subs + '|' + today + '|' + (canSeeRefs() ? 1 : 0);
    }

    function evaluate(c) {
        const token = revisionToken();
        if (c.memo && c.memo.token === token) return c.memo;
        const sub = subsidyInfo(c);
        const issues = [];
        let ref = null;
        if (sub.subsidized) {
            const common = {
                code: c.code,
                base: c.base,
                date: c.date,
                direction: typeof getFlightDirection === 'function' ? getFlightDirection(c.code) : c.code,
                state: stateOf(c),
                subsidySource: sub.source,
                subsidyAmount: sub.amount
            };
            const hits = c.sales.filter(isChild50);
            if (hits.length) {
                const fares = faresOf(hits);
                issues.push({
                    ...common,
                    rule: 'child50_subsidy',
                    title: RULES.child50_subsidy.title,
                    count: hits.length,
                    fares,
                    paid: hits.reduce((a, s) => a + (Number(s.fare) || 0), 0),
                    detail: `детских билетов со скидкой 50% — ${hits.length} (${fares.join(', ')})`
                });
            }
            ref = typeof FareRefs !== 'undefined' ? FareRefs.match(c.code, c.date) : null;
            if (ref) {
                const over = c.sales.filter(s => overLimit(s, ref));
                if (over.length) {
                    const fares = faresOf(over);
                    const maxPaid = over.reduce((a, s) => Math.max(a, Number(s.fare) || 0), 0);
                    const open = canSeeRefs();
                    const limits = !open ? 'из справочника' : (ref.child != null ? `взрослый ${rub(ref.adult)}, детский ${rub(ref.child)}` : rub(ref.adult));
                    issues.push({
                        ...common,
                        rule: 'fare_above_subsidy',
                        title: RULES.fare_above_subsidy.title,
                        count: over.length,
                        fares,
                        paid: over.reduce((a, s) => a + (Number(s.fare) || 0), 0),
                        maxPaid,
                        limit: open ? ref.adult : null,
                        childLimit: open ? ref.child : null,
                        refCode: open ? ref.fareCode : '',
                        detail: `билетов дороже предела ${limits}${open && ref.fareCode ? ' (' + ref.fareCode + ')' : ''} — ${over.length}, максимум ${rub(maxPaid)} (${fares.join(', ')})`
                    });
                }
            }
        }
        issues.forEach(i => { i.text = `${i.code} ${i.date}: ${i.title.toLowerCase()} — ${i.detail}`; });
        c.memo = { token, issues, subsidized: sub.subsidized, hasRef: !!ref };
        return c.memo;
    }

    function issuesFor(code, date) {
        const c = candidates().get(cleanFlight(code) + '|' + date);
        return c ? evaluate(c).issues : [];
    }

    function issueFor(code, date) {
        return issuesFor(code, date)[0] || null;
    }

    function list() {
        const out = [];
        candidates().forEach(c => { evaluate(c).issues.forEach(i => out.push(i)); });
        out.sort((a, b) => {
            const da = parseLocalDate(a.date);
            const db = parseLocalDate(b.date);
            const t = (da ? da.getTime() : 0) - (db ? db.getTime() : 0);
            return t || String(a.code).localeCompare(String(b.code), 'ru', { numeric: true }) || String(a.rule).localeCompare(String(b.rule));
        });
        return out;
    }

    // Субсидированные рейсы с продажами до вылета, для которых в справочнике нет тарифа.
    function missingRefs() {
        const codes = new Set();
        candidates().forEach(c => {
            const ev = evaluate(c);
            if (ev.subsidized && !ev.hasRef && stateOf(c) !== 'Улетел') codes.add(c.code);
        });
        return [...codes].sort((a, b) => (parseInt(a.slice(3), 10) || 0) - (parseInt(b.slice(3), 10) || 0));
    }

    function pairCode(code) {
        if (typeof getFlightPair !== 'function') return '';
        const p = getFlightPair(code);
        const other = code === p.outbound ? p.inbound : p.outbound;
        return other && other !== code ? other : '';
    }

    function isInfant(sale) {
        return /\/(IN|ID)\d/i.test(String(sale && sale.basicFareStr || ''));
    }

    // Подсказки для пустого справочника: предел — самый дорогой из ходовых оплаченных взрослых тарифов
    // (не меньше 10% билетов) на субсидированных датах рейса; коммерческие даты не учитываются.
    // Дешевле предела бывают другие тарифы — это не ошибка, поэтому берётся не самый частый, а «потолок».
    // Админ подтверждает подсказку одним кликом; сам справочник ничего не заполняет.
    const SUGGEST_MIN_TICKETS = 20;
    function suggestRefs() {
        const missing = new Set(missingRefs());
        if (!missing.size) return [];
        const stats = new Map();
        candidates().forEach(c => {
            if (!missing.has(c.code)) return;
            const ev = evaluate(c);
            if (!ev.subsidized || ev.hasRef) return;
            let st = stats.get(c.code);
            if (!st) stats.set(c.code, st = { amounts: new Map(), total: 0, dates: new Set() });
            st.dates.add(c.date);
            c.sales.forEach(sale => {
                if (isChild(sale) || isInfant(sale)) return;
                const v = Math.round(Number(sale.fare) || 0);
                if (v <= 0) return;
                st.total++;
                let a = st.amounts.get(v);
                if (!a) st.amounts.set(v, a = { n: 0, fares: new Map() });
                a.n++;
                const root = String(sale.basicFareStr || '').trim().split('/')[0].toUpperCase();
                if (root) a.fares.set(root, (a.fares.get(root) || 0) + 1);
            });
        });
        const dominant = (st) => {
            let best = null;
            st.amounts.forEach((a, v) => { if (!best || a.n > best.n || (a.n === best.n && v > best.value)) best = { value: v, n: a.n, fares: a.fares }; });
            return best;
        };
        const summarize = (flights) => {
            const merged = { amounts: new Map(), total: 0, dates: new Set() };
            flights.forEach(code => {
                const st = stats.get(code);
                if (!st) return;
                merged.total += st.total;
                st.dates.forEach(d => merged.dates.add(d));
                st.amounts.forEach((a, v) => {
                    let m = merged.amounts.get(v);
                    if (!m) merged.amounts.set(v, m = { n: 0, fares: new Map() });
                    m.n += a.n;
                    a.fares.forEach((n, f) => m.fares.set(f, (m.fares.get(f) || 0) + n));
                });
            });
            let top = null;
            merged.amounts.forEach((a, v) => {
                if (a.n >= 5 && a.n >= merged.total * 0.1 && (!top || v > top.value)) top = { value: v, n: a.n, fares: a.fares };
            });
            if (!top) top = dominant(merged);
            if (!top) return null;
            let below = 0;
            let above = 0;
            let maxPaid = 0;
            merged.amounts.forEach((a, v) => {
                if (v > top.value) above += a.n;
                if (v < top.value) below += a.n;
                if (v > maxPaid) maxPaid = v;
            });
            let fareCode = '';
            let fareN = 0;
            top.fares.forEach((n, f) => { if (n > fareN) { fareN = n; fareCode = f; } });
            return {
                flights,
                adult: top.value,
                fareCode,
                tickets: top.n,
                total: merged.total,
                share: merged.total ? Math.round(top.n / merged.total * 100) : 0,
                belowShare: merged.total ? Math.round(below / merged.total * 100) : 0,
                above,
                maxPaid,
                departures: merged.dates.size,
                // Надёжно: билетов хватает и дороже предела — единичные выбросы (меньше 5%).
                enough: merged.total >= SUGGEST_MIN_TICKETS && above <= merged.total * 0.05
            };
        };
        const out = [];
        const done = new Set();
        [...missing].forEach(code => {
            if (done.has(code) || !stats.has(code)) return;
            done.add(code);
            const other = pairCode(code);
            // Пара туда-обратно одной записью, если предел у них получается одинаковый.
            if (other && missing.has(other) && stats.has(other) && !done.has(other)) {
                const a = summarize([code]);
                const b = summarize([other]);
                if (a && b && a.adult === b.adult) {
                    done.add(other);
                    const sum = summarize([code, other]);
                    if (sum) out.push(sum);
                    return;
                }
            }
            const sum = summarize([code]);
            if (sum) out.push(sum);
        });
        return out.sort((a, b) => (parseInt(a.flights[0].slice(3), 10) || 0) - (parseInt(b.flights[0].slice(3), 10) || 0));
    }

    // Режим даты вылета: 'subsidy' — субсидия, 'commercial' — у маршрута есть субсидия, но не на эту дату,
    // null — рейс без субсидии (краевой, KV-247/248, исключение) или нет файла расходов.
    let modeCache = { token: '', map: new Map() };
    function modeFor(code, date, row) {
        const fl = cleanFlight(code);
        if (!fl || !date) return null;
        const token = revisionToken() + '|' + (typeof dataEpoch === 'number' ? dataEpoch : 0)
            + '|' + (typeof RouteCosts !== 'undefined' && RouteCosts.loaded ? 1 : 0);
        if (modeCache.token !== token) modeCache = { token, map: new Map() };
        const key = fl + '|' + date;
        if (modeCache.map.has(key)) return modeCache.map.get(key);
        let mode = null;
        if (!(typeof getFlightRouteType === 'function' && getFlightRouteType(fl) !== 'interregional')) {
            const r = row || (typeof getFlightRowForDate === 'function' ? getFlightRowForDate(getBaseFlight(fl), date, fl) : null);
            const sub = subsidyInfo({ code: fl, date, row: r });
            mode = sub.excluded ? null : (sub.subsidized ? 'subsidy' : (sub.commercial ? 'commercial' : null));
        }
        modeCache.map.set(key, mode);
        return mode;
    }

    function modeBadge(code, date, row) {
        if (typeof ProfileAuth !== 'undefined' && typeof ProfileAuth.featureOn === 'function' && !ProfileAuth.featureOn('subsidy_mode')) return '';
        const mode = modeFor(code, date, row);
        if (mode === 'subsidy') return '<span class="mode-badge mode-sub" title="Субсидия на эту дату (по периодам субсидий)">С</span>';
        if (mode === 'commercial') return '<span class="mode-badge mode-com" title="Коммерция: на эту дату субсидии нет, хотя маршрут субсидированный">К</span>';
        return '';
    }

    function flagForRow(row) {
        if (!enabled() || !row || !row[0] || !row[1]) return '';
        const issues = issuesFor(row[0], row[1]);
        if (!issues.length) return '';
        const tip = issues.map(i => i.text).join('\n');
        const esc = typeof escAttr === 'function' ? escAttr : (v) => String(v);
        return `<span class="fc-flag" role="img" aria-label="${esc(tip)}" title="${esc(tip)}"></span>`;
    }

    function rowsHaveIssue(rows) {
        return (rows || []).some(row => row && row[0] && row[1] && issuesFor(row[0], row[1]).length > 0);
    }

    function rowClass(rows) {
        return enabled() && rowsHaveIssue(rows) ? ' fc-row-problem' : '';
    }

    function canOpenReport() {
        return typeof ProfileAuth === 'undefined' || ProfileAuth.canAccessTab('reports');
    }

    function openReport() {
        if (typeof switchMainTab !== 'function' || !canOpenReport()) return;
        if (typeof ReportsView !== 'undefined' && ReportsView.showSubtab) ReportsView.showSubtab('checks');
        switchMainTab('reports');
        requestAnimationFrame(() => {
            const el = document.getElementById('rp-checks');
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    }

    // Счётчик в шапке: число рейсов с ошибкой, которые ещё не улетели.
    function headerChip() {
        if (!enabled()) return null;
        const flights = new Set(list().filter(i => i.state !== 'Улетел').map(i => i.code + '|' + i.date));
        if (!flights.size) return null;
        const chip = document.createElement('span');
        chip.className = 'header-kpi-error';
        chip.textContent = '! ' + flights.size;
        chip.title = `Проверка рейсов: ${flights.size} рейс(ов) с ошибкой до вылета. Нажмите, чтобы открыть отчёт.`;
        if (canOpenReport()) chip.addEventListener('click', openReport);
        return chip;
    }

    // После правки справочника или субсидии: пересчитать значки в открытых таблицах и шапке.
    function refreshViews() {
        if (typeof invalidateTabPanelState === 'function') invalidateTabPanelState();
        if (typeof updateHeaderStatus === 'function') updateHeaderStatus();
    }

    return { enabled, isNeverSubsidized, list, issuesFor, issueFor, missingRefs, suggestRefs, modeFor, modeBadge, flagForRow, rowClass, headerChip, openReport, refreshViews, RULES, RULE_TITLE };
})();
