// Деньги по ценовым решениям («Отчёты» → «Решения»). Нигде, кроме этого отчёта, не показываются.
//
// Идея. После решения (снижение или повышение цены) смотрим, сколько реально продали и на какую сумму, и сравниваем с тем,
// что вероятно продали бы без решения, по цене класса, который был открыт до него.
//   Δ ₽ = выручка факта − ожидаемое число платных билетов × цена прежнего класса.
//   Разложение (сумма точна): «объём» = (билетов факт − ожидалось) × новая цена; «цена» = ожидалось × (новая − прежняя).
//
// Ожидание — норма по аналогам: тот же рейс, тот же день недели, ±8 недель (затем шире), не меньше 3 вылетов; без вылетов,
// где самих ставили решения, и без допов/чартеров. Поправка на силу рейса затухающая: проверка на вылетах без решений показала,
// что темп за 3 дня почти не переносится на следующие дни (сырое отношение хуже простой нормы), а отбор «решения ставят на
// слабых рейсах» без поправки даёт ложный минус.
// Шум большой (продажи идут пачками, разброс в 3–5 раз выше пуассоновского), поэтому у каждой оценки есть диапазон,
// а вердикт «сработало / не сработало» только если диапазон не включает ноль и эффект не меньше порога; иначе «неопределённо».
//
// Понижение: окно от 4 до 10 дней (так, чтобы ожидалось не меньше ~6 билетов), без дня решения (время сделки неизвестно);
// результат фиксируется через день после окна. Повышение: через окно — только ранний сигнал, итог после вылета по остатку продаж.
// Зафиксированный итог лежит в shared/decision-money/ГГГГ-ММ.json и дальше не меняется (при смене данных и параметров тоже).
window.DecisionMoney = (function () {
    const METHOD_VERSION = 5;
    const DAY = 86400000;
    const REGULAR = /^KV-\d{3}$/;      // допы и чартеры (KV-9xxx и т. п.) не оцениваем: покупки блоками, нормы нет
    const GAPS = [56, 84, 182, 100000]; // расширение окна поиска аналогов, дней

    function num(name, d) { const v = typeof PV !== 'undefined' ? PV[name] : undefined; return typeof v === 'number' ? v : d; }

    function dayDiff(a, b) {
        const da = parseLocalDate(a);
        const db = parseLocalDate(b);
        return da && db ? Math.round((da.getTime() - db.getTime()) / DAY) : null;
    }

    function addDays(str, n) {
        const d = parseLocalDate(str);
        if (!d) return '';
        d.setDate(d.getDate() + n);
        return formatDateRu(d);
    }

    function round1(v) { return Math.round(v * 10) / 10; }
    function round1k(v) { return (Math.round(v / 100) * 100) || 0; }   // рубли — до сотен: без ложной точности (и без «−0», и без NaN)

    // ---------- чистая часть: оценка по готовым входам (проверяется отдельно, без данных сайта) ----------

    // Допустимое отклонение ожидания (билетов): √(4 + 3E), поправка на число аналогов (оптимум — 8).
    function sigmaTickets(E, k, tail) {
        const base = Math.sqrt(4 + 3 * Math.max(0, E)) * (tail ? 1.2 : 1);
        return base * Math.sqrt((1 + 1 / Math.max(1, k)) / 1.125);
    }

    // Окно после решения. inp: E (ожидание всех билетов), k (аналогов), nFactAll, nFactPaid, rFact, priceBefore, share,
    // strength: { own, norm } — билеты за 3 дня до решения у рейса и у аналогов.
    function estimateWindow(inp) {
        const gamma = num('MONEY_STRENGTH_GAMMA', 0.25);
        const adj = inp.strength && inp.strength.norm != null
            ? Math.pow((inp.strength.own + 0.5) / (inp.strength.norm + 0.5), gamma)
            : 1;
        const strengthK = Math.min(2, Math.max(0.5, adj));
        const nExpAll = inp.E * strengthK;
        const share = inp.share;
        const nExpPaid = nExpAll * share;
        const priceAfter = inp.nFactPaid > 0 ? inp.rFact / inp.nFactPaid : inp.priceBefore;
        const delta = inp.rFact - nExpPaid * inp.priceBefore;
        const sigma = sigmaTickets(nExpAll, inp.k, false);
        const z = num('MONEY_NOISE_Z', 1.9);
        const half = z * sigma * share * inp.priceBefore;
        const thr = Math.max(num('MONEY_MIN_PCT', 15) / 100 * nExpPaid * inp.priceBefore, num('MONEY_MIN_RUB', 20000));
        let verdict = 'unclear';
        if (delta - half > 0 && delta >= thr) verdict = 'worked';
        else if (delta + half < 0 && delta <= -thr) verdict = 'failed';
        return {
            nExpAll, nExpPaid, strengthK, priceAfter, delta, lo: delta - half, hi: delta + half, thr, verdict, sigma,
            volume: (inp.nFactPaid - nExpPaid) * priceAfter,
            price: nExpPaid * (priceAfter - inp.priceBefore),
            payback: priceAfter > 0 ? nExpPaid * inp.priceBefore / priceAfter : null,
            dTickets: inp.nFactAll - nExpAll,
            expRev: nExpPaid * inp.priceBefore, revFact: inp.rFact
        };
    }

    // Остаток до вылета (итог повышения). inp: E (ожидание остатка, все билеты), k, free (свободно на момент решения),
    // filled (рейс заполнился), nFactAll, nFactPaid, rFact, priceBefore, share.
    function estimateRemainder(inp) {
        let nExpAll = inp.E;
        if (inp.free != null) nExpAll = Math.min(nExpAll, inp.free);
        if (inp.filled) nExpAll = inp.nFactAll;   // заполнился — мест не потеряли, остаётся эффект цены
        const share = inp.share;
        const nExpPaid = nExpAll * share;
        const priceAfter = inp.nFactPaid > 0 ? inp.rFact / inp.nFactPaid : inp.priceBefore;
        const delta = inp.rFact - nExpPaid * inp.priceBefore;
        const sigma = sigmaTickets(inp.E, inp.k, true);
        const z = num('MONEY_NOISE_Z', 1.9);
        const half = inp.filled ? 0 : z * sigma * share * inp.priceBefore;
        const thr = Math.max(num('MONEY_MIN_PCT', 15) / 100 * nExpPaid * inp.priceBefore, num('MONEY_MIN_RUB', 20000));
        let verdict = 'unclear';
        if (delta - half > 0 && delta >= thr) verdict = 'worked';
        else if (delta + half < 0 && delta <= -thr) verdict = 'failed';
        return {
            nExpAll, nExpPaid, strengthK: 1, priceAfter, delta, lo: delta - half, hi: delta + half, thr, verdict, sigma,
            volume: (inp.nFactPaid - nExpPaid) * priceAfter,
            price: nExpPaid * (priceAfter - inp.priceBefore),
            payback: null,
            dTickets: inp.nFactAll - nExpAll,
            expRev: nExpPaid * inp.priceBefore, revFact: inp.rFact
        };
    }

    // ---------- данные сайта ----------

    function curveAt(curve, t) {
        return t > curve.maxDtd ? 0 : (curve.onHand[t] != null ? curve.onHand[t] : curve.total);
    }

    function countRange(curve, lo, hi) {   // билетов с «дней до вылета» от lo до hi (hi ≥ lo)
        return Math.max(0, curveAt(curve, lo) - curveAt(curve, hi + 1));
    }

    function price(s) { return s.adjustedFare || s.fare || 0; }
    // Считаем все билеты с ненулевым тарифом: взрослые, дети, группы. Нулевой тариф (служебные, бесплатные) не считаем.
    function isPaid(s) { return price(s) > 0; }
    function classOf(s) {
        if (typeof FareGrid !== 'undefined' && typeof FareGrid.classOf === 'function') return FareGrid.classOf(s);
        return String(s.basicFareStr || '').toUpperCase().split('/')[0].trim().slice(0, 1);
    }

    function hasDecision(code, date) {
        if (typeof SalesManagement === 'undefined' || !SalesManagement.marksFor) return false;
        return SalesManagement.marksFor(code, date).some(m => m.status === 'up' || m.status === 'down');
    }

    function seatsFor(base, code, dep) {
        const row = typeof getFlightRowForDate === 'function' ? getFlightRowForDate(base, dep, code) : null;
        let seats = row && typeof getSeatsOnSale === 'function' ? getSeatsOnSale(row) : 0;
        if (!(seats > 0) && typeof SalesArchive !== 'undefined' && SalesArchive.entryFor) {
            const ae = SalesArchive.entryFor(dep, code);
            if (ae && ae.s > 0) seats = ae.s;
        }
        return seats;
    }

    // Аналоги: тот же рейс и день недели, ±8 недель (расширяем до 12, 26 недель и всех дат). Нужны данные по концу окна (lo).
    // Сначала берём вылеты без ценовых решений; если их мало — и вылеты с решениями (оценка помечается, доверие ниже).
    // Результат поиска запоминается на время неизменных данных и отметок: у серии решений по одному вылету он один и тот же.
    const analogMemo = new Map();
    let analogMemoSig = '';

    function findAnalogs(base, code, dep, lo, seats) {
        const sg = [typeof dataEpoch === 'number' ? dataEpoch : 0, typeof SalesManagement !== 'undefined' && SalesManagement.markRevision ? SalesManagement.markRevision() : '',
            typeof SalesArchive !== 'undefined' && SalesArchive.revision ? SalesArchive.revision() : 0, typeof Params !== 'undefined' && Params.revision ? Params.revision() : 0].join('|');
        if (sg !== analogMemoSig) { analogMemo.clear(); analogMemoSig = sg; }
        const key = [base, code, dep, lo, Math.round(seats || 0)].join('|');
        if (!analogMemo.has(key)) analogMemo.set(key, findAnalogsRaw(base, code, dep, lo, seats));
        return analogMemo.get(key);
    }

    function findAnalogsRaw(base, code, dep, lo, seats) {
        let cohort = [];
        try { cohort = collectSameWeekdayCohort(base, dep, code); } catch (e) { cohort = []; }
        const usable = cohort.filter(c => c.seats > 0 && REGULAR.test(String(c.code)) && c.observedFrom <= lo);
        const win = num('WEEKDAY_NORM_WINDOW_DAYS', 56);
        const tiers = [win].concat(GAPS.filter(g => g > win));
        const attempts = [{ min: num('MONEY_MIN_ANALOGS', 3), withDec: false }, { min: num('MONEY_MIN_ANALOGS', 3), withDec: true }, { min: 2, withDec: true }];
        for (let a = 0; a < attempts.length; a++) {
            const pool = attempts[a].withDec ? usable : usable.filter(c => !hasDecision(c.code, c.date));
            for (let i = 0; i < tiers.length; i++) {
                const list = pool.filter(c => c.dayGap <= tiers[i]);
                if (list.length >= attempts[a].min) {
                    const withCurves = list.map(c => ({ c, curve: departureCurve(c.date, c.code), scale: seats > 0 ? Math.min(2.5, Math.max(0.4, seats / c.seats)) : 1 }));
                    return { list: withCurves, tier: tiers[i], withDecisions: attempts[a].withDec, few: attempts[a].min < num('MONEY_MIN_ANALOGS', 3) };
                }
            }
        }
        return { list: [], tier: 0 };
    }

    // Среднее по аналогам: билетов в днях до вылета [lo..hi] (приведено к местам этого вылета).
    function analogMean(an, lo, hi) {
        if (!an.list.length) return null;
        let s = 0;
        an.list.forEach(a => { s += countRange(a.curve, lo, hi) * a.scale; });
        return s / an.list.length;
    }

    function ladderIndex(code, dep) {
        const m = new Map();
        try { (FareGrid.ladderFor(code, dep) || []).forEach((l, i) => m.set(l.cls, { i, price: l.price })); } catch (e) { /* без лестницы */ }
        return m;
    }

    function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }

    function lowestClass(list, ladder) {
        let best = null;
        list.forEach(s => {
            const c = classOf(s);
            const li = ladder.get(c);
            const key = li ? li.price : 1e9;
            if (!best || key < best.key) best = { cls: c, key };
        });
        return best ? best.cls : null;
    }

    // Ключ решения — один для хранения и отчёта.
    function keyOf(m) { return [m.flight || m.code, m.dep, m.check, m.status].join('|'); }

    function na(reason, extra) { return Object.assign({ stage: 'na', reason, grade: 'C', v: METHOD_VERSION }, extra || {}); }

    // Следующее ценовое решение по этому вылету не дальше окна: до него и считаем эффект этой отметки (окна соседних отметок не пересекаются).
    function nextDecisionGap(code, dep, check) {
        const maxW = num('MONEY_WINDOW_MAX', 10);
        const marks = typeof SalesManagement !== 'undefined' && SalesManagement.marksFor ? SalesManagement.marksFor(code, dep) : [];
        let best = null;
        marks.forEach(x => {
            if (x.status !== 'up' && x.status !== 'down') return;
            const g = dayDiff(x.check, check);
            if (g != null && g > 0 && g <= maxW && (best == null || g < best)) best = g;
        });
        return best;
    }

    // Оценка одного решения по данным сайта. m: { code|flight, dep, check, status, clsFrom?, clsTo? }.
    // Почти всё считается; сомнительные случаи помечаются флагами (m.flags) и получают доверие «низкое».
    function compute(m) {
        const code = m.code || m.flight;
        const dep = m.dep;
        const kind = m.status;
        if (kind !== 'down' && kind !== 'up') return na('не ценовое решение');
        const base = typeof getBaseFlight === 'function' ? getBaseFlight(code) : code;
        if (!REGULAR.test(String(code))) return na('доп. рейс или чартер: обычной нормы нет');
        const dtdD0 = dayDiff(dep, m.check);
        if (dtdD0 == null) return na('нет даты решения');
        if (dtdD0 < 1) return na('решение в день вылета или позже: после него не осталось дней для оценки');
        const list = typeof getFlightSalesList === 'function' ? getFlightSalesList(dep, code) : [];
        if (!list.length) return na('билетов этого вылета нет в данных: оценить нельзя');
        const nextGap = nextDecisionGap(code, dep, m.check);
        const dtdD = dtdD0;
        const flags = [];
        if (nextGap != null) flags.push(`серия решений: окно только до следующего решения (${nextGap} дн.)`);
        if (dtdD < 3) flags.push(`решение за ${dtdD} дн. до вылета: окно очень короткое`);
        const maxW = num('MONEY_WINDOW_MAX', 10);
        // Праздники и события: норма из обычных дней грубее — считаем, но с пометкой.
        if (typeof CalendarEvents !== 'undefined') {
            const hi = Math.min(nextGap != null ? nextGap : maxW, dtdD);
            const probe = [dep, m.check, addDays(m.check, hi)].some(d => CalendarEvents.normKey(d) !== '');
            if (probe) flags.push('праздники или события рядом: обычная норма грубее');
        }
        const seats = seatsFor(base, code, dep);
        const W0 = num('DECISION_WINDOW_MONEY', 4);
        const minExp = num('MONEY_MIN_EXPECTED', 6);
        const wCap = Math.min(nextGap != null ? nextGap : maxW, dtdD);
        const loNeed = Math.max(0, dtdD - wCap);
        const an = findAnalogs(base, code, dep, loNeed, seats);
        if (an.list.length < 2) return na('нет похожих вылетов этого рейса и дня недели в данных: сравнивать не с чем');
        if (an.withDecisions) flags.push('у похожих вылетов тоже были ценовые решения');
        if (an.few || an.list.length < 3) flags.push(`похожих вылетов всего ${an.list.length}`);
        // Окно: от W0 дней (для эпизода — до последней отметки плюс W0), пока ожидание не дойдёт до минимума.
        let w = Math.min(W0, wCap);
        w = Math.max(1, w);
        let E = analogMean(an, dtdD - w, dtdD - 1);
        while (w < wCap && E < minExp) { w++; E = analogMean(an, dtdD - w, dtdD - 1); }
        const windowTo = addDays(m.check, w);
        const cutoffMs = typeof salesDataCutoffTime === 'function' ? salesDataCutoffTime() : Date.now();
        const needMs = parseLocalDate(windowTo).getTime() + num('MONEY_LAG_DAYS', 1) * DAY;
        const base0 = { w, windowFrom: addDays(m.check, 1), windowTo, k: an.list.length, tierDays: an.tier, v: METHOD_VERSION, kind, flags };
        if (cutoffMs < needMs) return Object.assign(base0, { stage: 'wait', reason: `ждём данные до ${windowTo}`, grade: 'C', readyOn: addDays(windowTo, num('MONEY_LAG_DAYS', 1)) });

        // Факт по билетам вылета.
        const own = { all: 0, paid: 0, rev: 0, beforeAll: 0, beforeAdult: 0 };
        const before3 = []; const before7 = []; const afterAdult = []; let nOwn3 = 0;
        list.forEach(s => {
            const d = dayDiff(dep, s.dealDate);
            if (d == null) return;
            if (d >= dtdD - w && d <= dtdD - 1) {
                own.all++;
                if (isPaid(s)) { own.paid++; own.rev += price(s); afterAdult.push(s); }
            }
            if (d >= dtdD + 1) {
                own.beforeAll++;
                if (isPaid(s)) {
                    own.beforeAdult++;
                    if (d <= dtdD + 3) before3.push(s);
                    if (d <= dtdD + 7) before7.push(s);
                }
            }
            if (d >= dtdD + 1 && d <= dtdD + 3) nOwn3++;
        });
        const ladder = ladderIndex(code, dep);
        // Цена и класс до решения: указанные вручную, по продажам за 3 (запасной — 7) дней до решения,
        // иначе — по средней цене продаж после решения (тогда считается только объём), иначе — по самому дешёвому классу лестницы.
        let priceBefore = null; let clsBefore = null;
        if (m.clsFrom && ladder.get(m.clsFrom)) { priceBefore = ladder.get(m.clsFrom).price; clsBefore = m.clsFrom; }
        if (priceBefore == null) {
            const src = before3.length ? before3 : before7;
            if (src.length) { priceBefore = mean(src.map(price)); clsBefore = lowestClass(src, ladder); }
        }
        if (!(priceBefore > 0)) priceBefore = null;   // нулевой или пустой тариф: делить на него нельзя
        const avgAfter = afterAdult.length ? mean(afterAdult.map(price)) : null;
        if (priceBefore == null && avgAfter != null) { priceBefore = avgAfter; flags.push('до решения продаж не было: прежний тариф взят по продажам после (считается только объём; укажите «Класс до»)'); }
        if (priceBefore == null) {
            const cheapest = [...ladder.values()].map(x => x.price).filter(x => x > 0);
            if (cheapest.length) { priceBefore = Math.min(...cheapest); flags.push('нет продаж до и после решения: тариф взят по самому дешёвому классу'); }
        }
        if (priceBefore == null) return na('нет данных о тарифах: не из чего посчитать рубли', base0);
        const clsAfter = m.clsTo || lowestClass(afterAdult, ladder);
        if (clsBefore && clsAfter && clsBefore === clsAfter && !m.clsFrom && !m.clsTo && avgAfter != null && Math.abs(avgAfter - priceBefore) / priceBefore < 0.03) {
            flags.push('по продажам тариф не изменился: эффект в основном объёмный');
        }
        // Доля платных взрослых негрупповых среди всех билетов вылета до решения.
        const share = own.beforeAll >= 10 ? own.beforeAdult / own.beforeAll : num('MONEY_PAID_SHARE', 0.9);
        // Сила рейса: билеты за 3 дня до решения у вылета и у аналогов.
        const normOwn = analogMean(an, dtdD + 1, dtdD + 3);
        const out = Object.assign(base0, { priceBefore: Math.round(priceBefore), clsBefore, clsAfter, share: round1(share * 100) / 100 });

        const flyDt = parseLocalDate(dep);
        const dataCoversFlight = !!(flyDt && flyDt.getTime() < cutoffMs);

        if (kind === 'up' && nextGap == null && dataCoversFlight) {
            // Итог повышения: остаток продаж от дня после решения до вылета против обычного добора (чистая норма).
            const an0 = findAnalogs(base, code, dep, 0, seats);
            if (an0.list.length < 2) return na('нет улетевших похожих вылетов для итога', out);
            if (an0.withDecisions && !flags.includes('у похожих вылетов тоже были ценовые решения')) flags.push('у похожих вылетов тоже были ценовые решения');
            const Erem = analogMean(an0, 0, dtdD - 1);
            const rem = { all: 0, paid: 0, rev: 0 };
            let soldAtD = 0;
            list.forEach(s => {
                const d = dayDiff(dep, s.dealDate);
                if (d == null) return;
                if (d <= dtdD - 1) { rem.all++; if (isPaid(s)) { rem.paid++; rem.rev += price(s); } }
                if (d >= dtdD) soldAtD++;
            });
            const free = seats > 0 ? Math.max(0, seats - soldAtD) : null;
            const totalNow = list.length;
            const filled = seats > 0 && totalNow / seats >= num('RMS_FULL_PCT', 95) / 100;
            const est = estimateRemainder({ E: Erem, k: an0.list.length, free, filled, nFactAll: rem.all, nFactPaid: rem.paid, rFact: rem.rev, priceBefore, share });
            return finish(out, est, { stage: 'final', k: an0.list.length, tierDays: an0.tier, remainder: true, filled, expAll: round1(est.nExpAll), factAll: rem.all });
        }

        const est = estimateWindow({ E, k: an.list.length, nFactAll: own.all, nFactPaid: own.paid, rFact: own.rev, priceBefore, share, strength: normOwn == null ? null : { own: nOwn3, norm: normOwn } });
        if (kind === 'up' && nextGap == null) {
            // Через окно — только ранний сигнал: рост цены сдвигает покупки на позже, вердикт по итогу вылета.
            const res = finish(out, est, { stage: 'prelim', expAll: round1(est.nExpAll), factAll: own.all });
            res.verdict = null;
            res.reason = 'ранний сигнал: итог повышения будет после вылета';
            return res;
        }
        const res = finish(out, est, { stage: 'final', expAll: round1(est.nExpAll), factAll: own.all });
        // Хвост и заполнение — для пояснения (без рублей): сколько продали после окна против обычного.
        if (dataCoversFlight) {
            const an0 = findAnalogs(base, code, dep, 0, seats);
            const Etail = an0.list.length ? analogMean(an0, 0, dtdD - w - 1) : null;
            let nTail = 0;
            list.forEach(s => { const d = dayDiff(dep, s.dealDate); if (d != null && d >= 0 && d <= dtdD - w - 1) nTail++; });
            if (Etail != null) { res.tailFact = nTail; res.tailExp = round1(Etail); }
            res.fullFlight = seats > 0 && list.length / seats >= num('RMS_FULL_PCT', 95) / 100;
        }
        return res;
    }

    // Функция ошибок (Абрамовиц–Стеган): для вероятности «плюс» в finish.
    function erf(x) {
        const sign = x < 0 ? -1 : 1;
        const a = Math.abs(x);
        const t = 1 / (1 + 0.3275911 * a);
        const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
        return sign * y;
    }

    function finish(base, est, extra) {
        const sampleOk = est.nExpAll + (extra.factAll || 0) >= num('MONEY_MIN_TICKETS', 4);
        const flags = base.flags || [];
        const kUsed = extra.k != null ? extra.k : base.k;   // у итога повышения — число аналогов именно для него
        const grade = flags.length ? 'C' : (kUsed >= 5 && est.nExpAll >= 6 ? 'A' : 'B');
        // Каждый флаг расширяет диапазон на 25%: сомнительные оценки реже получают «сработало/не сработало».
        const widen = 1 + 0.25 * flags.length;
        // Поправка на сдвиг: на вылетах без решений в окне «выходило» в среднем +24% к ожидаемой выручке
        // (норма занижена, тариф растёт сам); в остатке до вылета сдвиг в пределах шума.
        const filledNow = !!(est.filled || extra.filled);
        const bias = (extra.remainder ? num('MONEY_BIAS_REMAINDER', 0) : num('MONEY_BIAS_WINDOW', 0.24)) * est.nExpPaid * (base.priceBefore || 0);
        const dcorr = est.delta - bias;
        let half = (est.hi - est.lo) / 2 * widen;
        // Рейс заполнен: билетов уже не прибавить, но цена билета всё равно шумит.
        if (filledNow) half = num('MONEY_NOISE_Z', 1.9) * num('MONEY_PRICE_NOISE', 0.1) * est.nExpPaid * (base.priceBefore || 0) * widen;
        const lo = dcorr - half; const hi = dcorr + half;
        let verdict = 'unclear';
        if (lo > 0 && dcorr >= est.thr) verdict = 'worked';
        else if (hi < 0 && dcorr <= -est.thr) verdict = 'failed';
        // «Скорее»: диапазон включает ноль, но вероятность плюса (или минуса) по нормальной оценке не ниже 75%.
        const zc = num('MONEY_NOISE_Z', 1.9);
        const sd = half > 0 ? half / zc : 0;
        let pPos = null;
        if (sd > 0) {
            const t = dcorr / sd;
            pPos = 0.5 * (1 + erf(t / Math.SQRT2));
            if (verdict === 'unclear') {
                if (pPos >= num('MONEY_LEAN_P', 0.75)) verdict = 'lean_pos';
                else if (pPos <= 1 - num('MONEY_LEAN_P', 0.75)) verdict = 'lean_neg';
            }
        }
        const delta = round1k(dcorr);
        const volume = round1k(est.volume);
        const res = Object.assign(base, extra, {
            // «цена» = эффект минус «объём» после округления: сумма двух частей точно равна эффекту
            priceAfter: Math.round(est.priceAfter), delta, lo: round1k(lo), hi: round1k(hi),
            volume, priceEffect: delta - volume, payback: est.payback == null ? null : round1(est.payback),
            thr: round1k(est.thr), nExpPaid: round1(est.nExpPaid), expRev: round1k(est.revFact - dcorr), revFact: round1k(est.revFact), strengthK: Math.round(est.strengthK * 100) / 100,
            dTickets: round1(est.dTickets), grade
        });
        // Остаток: эффект ниже порога значимости — «без заметного эффекта», иначе — направление по знаку («чуть лучше / хуже»).
        // Вероятность плюса (pPos) показывается рядом, поэтому слабый сигнал не выдаётся за твёрдый.
        if (!sampleOk) verdict = verdict === 'worked' ? 'lean_pos' : (verdict === 'failed' ? 'lean_neg' : verdict);
        if (verdict === 'unclear') {
            if (Math.abs(dcorr) < est.thr) verdict = 'flat';
            else verdict = dcorr > 0 ? 'weak_pos' : 'weak_neg';
        }
        res.verdict = verdict;
        res.pPos = pPos == null ? null : Math.round(pPos * 100);
        if (!sampleOk) res.reason = 'мало билетов: вывод слабый';
        return res;
    }

    // ---------- зафиксированные итоги (общий файл) ----------

    const store = new Map();       // key → запись
    const loadedMonths = new Set();
    let rev = 0;

    function monthOf(dateStr) {
        const d = parseLocalDate(dateStr);
        return d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` : '';
    }
    function fileOf(month) { return `decision-money/${month}.json`; }

    function canFreeze() {
        if (typeof ProfileAuth === 'undefined') return false;
        const p = ProfileAuth.getCurrentProfile() || {};
        return !!p.isAdmin || ProfileAuth.hasPermission('share_data');
    }

    async function ensureMonths(months) {
        if (typeof SharedStorage === 'undefined') return;
        for (const month of months) {
            if (!month || loadedMonths.has(month)) continue;
            const r = await SharedStorage.readJsonFileStrict(fileOf(month)).catch(() => ({ ok: false }));
            if (!r.ok) continue;   // не читается — не считаем «пусто», повторим позже
            loadedMonths.add(month);
            const items = (r.data && r.data.items) || {};
            Object.keys(items).forEach(k => { store.set(k, items[k]); });
            rev++;
        }
    }

    function get(key) { return store.get(key) || null; }

    // Записывает зафиксированные итоги. Слияние по ключу: итог не заменяется предварительным; при двух итогах побеждает ранний.
    async function persist(entries) {
        if (!entries.length || typeof SharedStorage === 'undefined' || !canFreeze()) return false;
        const byMonth = new Map();
        entries.forEach(e => { const mo = monthOf(e.check); if (mo) { if (!byMonth.has(mo)) byMonth.set(mo, []); byMonth.get(mo).push(e); } });
        let ok = true;
        for (const [month, list] of byMonth) {
            const r = await SharedStorage.readJsonFileStrict(fileOf(month)).catch(() => ({ ok: false }));
            if (!r.ok) { ok = false; continue; }
            const items = (r.data && r.data.items) || {};
            list.forEach(e => {
                const old = items[e.key];
                if (old && old.stage === 'final' && old.v === METHOD_VERSION) return;                               // итог уже зафиксирован — не трогаем
                if (old && old.stage === 'prelim' && e.stage === 'prelim') return;       // ранний сигнал один раз
                items[e.key] = e;
            });
            const written = await SharedStorage.writeJsonFile(fileOf(month), { version: 1, updatedAt: new Date().toISOString(), items });
            if (written) { Object.keys(items).forEach(k => store.set(k, items[k])); rev++; } else ok = false;
        }
        return ok;
    }

    // Пересчитать зафиксированный итог с текущими параметрами (кнопка администратора): запись заменяется.
    async function recompute(m) {
        const key = keyOf(m);
        const res = compute(m);
        const entry = Object.assign({}, res, { key, check: m.check, at: new Date().toISOString(), recomputed: true });
        store.delete(key);
        if (res.stage === 'final' || res.stage === 'prelim') {
            if (typeof SharedStorage !== 'undefined' && canFreeze()) {
                const month = monthOf(m.check);
                const r = await SharedStorage.readJsonFileStrict(fileOf(month)).catch(() => ({ ok: false }));
                if (r.ok) {
                    const items = (r.data && r.data.items) || {};
                    items[key] = entry;
                    if (await SharedStorage.writeJsonFile(fileOf(month), { version: 1, updatedAt: new Date().toISOString(), items })) { store.set(key, entry); rev++; }
                }
            }
        }
        return entry;
    }

    // Итог для строки отчёта: зафиксированный или свежий расчёт (не зафиксированный — пометка live).
    // Фиксирует итоговые (и ранние сигналы) тот, у кого есть право, порциями, чтобы не вешать страницу.
    async function resolveAll(decisions, onProgress) {
        const months = [...new Set(decisions.map(d => monthOf(d.check)).filter(Boolean))];
        await ensureMonths(months);
        const out = new Map();
        const toSave = [];
        let last = performance.now();
        for (let i = 0; i < decisions.length; i++) {
            const m = decisions[i];
            const key = keyOf(m);
            const frozen = get(key);
            if (frozen && frozen.v === METHOD_VERSION && (frozen.stage === 'final' || (frozen.stage === 'prelim' && m.status === 'up' && !frozenUpgradable(m)))) { out.set(key, Object.assign({ frozen: true }, frozen)); continue; }
            let res;
            try { res = compute(m); } catch (e) { console.warn('DecisionMoney.compute', e); res = na('ошибка расчёта'); }
            const entry = Object.assign({}, res, { key, check: m.check, at: new Date().toISOString() });
            if (res.stage === 'final' || res.stage === 'prelim') toSave.push(entry);
            out.set(key, Object.assign({ frozen: false }, entry));
            if (performance.now() - last > 20) { await new Promise(r => setTimeout(r, 0)); last = performance.now(); if (onProgress) onProgress(i + 1, decisions.length); }
        }
        if (toSave.length && canFreeze()) {
            const saved = await persist(toSave);
            if (saved) toSave.forEach(e => { const o = out.get(e.key); if (o) o.frozen = true; });
        }
        return out;
    }

    // Ранний сигнал повышения можно заменить итогом, когда вылет состоялся.
    function frozenUpgradable(m) {
        const flyDt = parseLocalDate(m.dep);
        const cutoff = typeof salesDataCutoffTime === 'function' ? salesDataCutoffTime() : Date.now();
        return !!(flyDt && flyDt.getTime() < cutoff);
    }

    return { compute, estimateWindow, estimateRemainder, sigmaTickets, keyOf, get, ensureMonths, resolveAll, recompute, canFreeze, revision: () => rev, METHOD_VERSION };
})();
