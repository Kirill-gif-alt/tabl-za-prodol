// деньги по ценовым решениям (только в отчёте "Решения")
// Δ ₽ = выручка факта - ожидаемые платные билеты × прежняя цена
// цена = ожидалось × (новая - прежняя), объём = остальное, в т.ч. поправка на сдвиг
window.DecisionMoney = (function () {
    const METHOD_VERSION = 11;
    const DAY = 86400000;
    const REGULAR = /^KV-\d{3}$/;      // допы и чартеры (KV-9xxx) не оцениваем, нормы нет
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
    function round1k(v) { return (Math.round(v / 100) * 100) || 0; }   // рубли до сотен, без -0 и NaN

    // разброс ожидания в билетах: окно √(0,4 + 4,7·E), остаток √(24 + 2,5·E)
    // продажи идут пачками, разброс ~в 5 раз выше пуассоновского; подобрано по вылетам без решений
    // поправка на число аналогов по эффективному k (оптимум около 10)
    function sigmaTickets(E, k, tail) {
        const e = Math.max(0, E);
        const base = Math.sqrt(tail ? 24 + 2.5 * e : 0.4 + 4.7 * e);
        return base * Math.sqrt((1 + 1 / Math.max(1, k)) / 1.1);
    }

    // окно после решения; inp: E (ожидание всех билетов), k (аналогов), nFactAll, nFactPaid, rFact, priceBefore, share
    // strength: { own, norm } - билеты за 3 дня до решения у рейса и у аналогов
    function estimateWindow(inp) {
        const gamma = num('MONEY_STRENGTH_GAMMA', 0.2);
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
            dTickets: inp.nFactAll - nExpAll, nFactPaid: inp.nFactPaid,
            expRev: nExpPaid * inp.priceBefore, revFact: inp.rFact
        };
    }

    // остаток до вылета (итог повышения); inp: E (ожидание остатка, все билеты), k, free (свободно при решении),
    // filled (рейс заполнился), nFactAll, nFactPaid, rFact, priceBefore, share
    function estimateRemainder(inp) {
        let nExpAll = inp.E;
        if (inp.free != null) nExpAll = Math.min(nExpAll, inp.free);
        if (inp.filled) nExpAll = inp.nFactAll;   // заполнился: мест не потеряли, остаётся только эффект цены
        const share = inp.share;
        const nExpPaid = nExpAll * share;
        const priceAfter = inp.nFactPaid > 0 ? inp.rFact / inp.nFactPaid : inp.priceBefore;
        const delta = inp.rFact - nExpPaid * inp.priceBefore;
        const sigma = sigmaTickets(inp.E, inp.k, true);
        const z = num('MONEY_NOISE_Z', 1.9);
        let half = inp.filled ? 0 : z * sigma * share * inp.priceBefore;
        // разброс не больше свободных мест по прежней цене
        let halfMax = null;
        if (!inp.filled && inp.free != null) { halfMax = inp.free * share * inp.priceBefore; half = Math.min(half, halfMax); }
        const thr = Math.max(num('MONEY_MIN_PCT', 15) / 100 * nExpPaid * inp.priceBefore, num('MONEY_MIN_RUB', 20000));
        let verdict = 'unclear';
        if (delta - half > 0 && delta >= thr) verdict = 'worked';
        else if (delta + half < 0 && delta <= -thr) verdict = 'failed';
        return {
            nExpAll, nExpPaid, strengthK: 1, priceAfter, delta, lo: delta - half, hi: delta + half, thr, verdict, sigma, halfMax,
            volume: (inp.nFactPaid - nExpPaid) * priceAfter,
            price: nExpPaid * (priceAfter - inp.priceBefore),
            payback: null,
            dTickets: inp.nFactAll - nExpAll, nFactPaid: inp.nFactPaid,
            expRev: nExpPaid * inp.priceBefore, revFact: inp.rFact
        };
    }

    function curveAt(curve, t) {
        return t > curve.maxDtd ? 0 : (curve.onHand[t] != null ? curve.onHand[t] : curve.total);
    }

    function countRange(curve, lo, hi) {   // билеты с днями до вылета от lo до hi (hi >= lo)
        return Math.max(0, curveAt(curve, lo) - curveAt(curve, hi + 1));
    }

    // деньги по фактическому тарифу (fare), детский со скидкой - по заплаченному
    // adjustedFare только если fare нет
    function price(s) { return s.fare > 0 ? s.fare : (s.adjustedFare || 0); }
    // платные - ненулевой тариф (взрослые, дети, группы); служебные и бесплатные не считаем
    function isPaid(s) { return price(s) > 0; }
    function classOf(s) {
        if (typeof FareGrid !== 'undefined' && typeof FareGrid.classOf === 'function') return FareGrid.classOf(s);
        return String(s.basicFareStr || '').toUpperCase().split('/')[0].trim().slice(0, 1);
    }

    function hasDecision(code, date) {
        if (typeof SalesManagement === 'undefined' || !SalesManagement.marksFor) return false;
        return SalesManagement.marksFor(code, date).some(m => m.status === 'up' || m.status === 'down');
    }

    // кэш на один расчёт: отметки по вылету смотрим один раз
    let decMemo = new Map();
    function hasDec(code, date) {
        const k = code + '|' + date;
        let v = decMemo.get(k);
        if (v === undefined) { v = hasDecision(code, date); decMemo.set(k, v); }
        return v;
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

    // аналоги - вылеты того же рейса: тот же день недели ±8 нед (до 12, 26 и всех дат), вес падает с давностью
    // + соседние по дате вылеты ±5 дней в другие дни недели, билеты пересчитываются на день недели вылета
    // сначала без решений; "достаточно" = (Σw)²/Σw² не меньше минимума
    const analogMemo = new Map();
    const poolMemo = new Map();
    const dowMemo = new Map();
    let analogMemoSig = '';

    function dataSig() {
        return [typeof dataEpoch === 'number' ? dataEpoch : 0, typeof SalesManagement !== 'undefined' && SalesManagement.markRevision ? SalesManagement.markRevision() : '',
            typeof SalesArchive !== 'undefined' && SalesArchive.revision ? SalesArchive.revision() : 0, typeof Params !== 'undefined' && Params.revision ? Params.revision() : 0].join('|');
    }

    function ensureSig() {
        const sg = dataSig();
        if (sg !== analogMemoSig) { analogMemo.clear(); poolMemo.clear(); dowMemo.clear(); levelMemo.clear(); analogMemoSig = sg; }
    }

    function findAnalogs(base, code, dep, lo, seats) {
        ensureSig();
        const key = [base, code, dep, lo, Math.round(seats || 0)].join('|');
        if (!analogMemo.has(key)) analogMemo.set(key, findAnalogsRaw(base, code, dep, lo, seats));
        return analogMemo.get(key);
    }

    // все вылеты базового рейса с продажами, из файлов и архива; кривые считаем один раз
    function basePool(base, code) {
        const key = base;
        if (poolMemo.has(key)) return poolMemo.get(key);
        const items = [];
        const seen = new Set();
        const codes = new Set([code]);
        const rows = (typeof groupedData !== 'undefined' && groupedData[base]) || [];
        rows.forEach(row => {
            const dtStr = row[1];
            if (!dtStr || seen.has(dtStr) || row.segKey) return;   // участок доп. посадки другого рейса - не вылет
            const dt = parseLocalDate(dtStr);
            if (!dt) return;
            const orig = cleanFlight(row[0]);
            codes.add(orig);
            const salesCode = getFlightSalesList(dtStr, orig).length ? orig : code;
            if (!getFlightSalesList(dtStr, salesCode).length) return;
            const seats = typeof getSeatsOnSale === 'function' ? getSeatsOnSale(row) : 0;
            if (!(seats > 0) || !REGULAR.test(String(salesCode))) return;
            seen.add(dtStr);
            items.push({ date: dtStr, code: salesCode, seats, ms: dt.getTime(), dow: dt.getDay(), observedFrom: observedFromDtd(dtStr) });
        });
        if (typeof SalesArchive !== 'undefined') {
            codes.forEach(c => {
                SalesArchive.departuresFor(c).forEach(a => {
                    if (seen.has(a.date) || !(a.seats > 0) || !REGULAR.test(String(c))) return;
                    const dt = parseLocalDate(a.date);
                    if (!dt) return;
                    seen.add(a.date);
                    items.push({ date: a.date, code: c, seats: a.seats, ms: dt.getTime(), dow: dt.getDay(), observedFrom: 0 });
                });
            });
        }
        poolMemo.set(key, items);
        return items;
    }

    function itemCurve(it) {
        if (!it.curve) it.curve = departureCurve(it.date, it.code);
        return it.curve;
    }

    // доля проданных кресел в окне [lo..hi] по дням недели рейса, ближние ±26 нед, без самого вылета
    // сжатие к общему среднему (τ псевдо-вылета), чтобы дни с 1-2 вылетами не перекашивали
    function dowLevels(an, lo, hi) {
        const key = [an.base, an.dep, lo, hi, an.withDecisions ? 1 : 0, an.asOfMs || 0].join('|');
        if (dowMemo.has(key)) return dowMemo.get(key);
        const tau = num('MONEY_DOW_TAU', 2);
        const sum = [0, 0, 0, 0, 0, 0, 0]; const cnt = [0, 0, 0, 0, 0, 0, 0];
        let tot = 0; let n = 0;
        basePool(an.base, an.code).forEach(it => {
            if (it.date === an.dep || it.observedFrom > lo || Math.abs(it.ms - an.depMs) > 182 * DAY || (an.asOfMs && it.ms > an.asOfMs)) return;
            if (!an.withDecisions && hasDec(it.code, it.date)) return;
            const v = countRange(itemCurve(it), lo, hi) / it.seats;
            sum[it.dow] += v; cnt[it.dow]++; tot += v; n++;
        });
        const M = n ? tot / n : 0;
        const lev = sum.map((x, d) => (x + tau * M) / (cnt[d] + tau));
        const out = { lev, cnt, M };
        dowMemo.set(key, out);
        return out;
    }

    // множитель: день недели соседнего вылета -> день недели этого, окно [lo..hi]
    function dowFactor(an, it, lo, hi) {
        const L = dowLevels(an, lo, hi);
        const a = L.lev[an.dow]; const b = L.lev[it.dow];
        if (!(a > 0) || !(b > 0)) return 1;
        return Math.min(2.5, Math.max(0.4, a / b));
    }

    function keffOf(ws) {
        let s = 0; let q = 0;
        ws.forEach(w => { s += w; q += w * w; });
        return q > 0 ? s * s / q : 0;
    }

    // поправка уровня: спрос ходит волнами, норма из прошлых недель отстаёт
    // смотрим, как последние улетевшие вылеты сети (до дня решения) шли против нормы по более ранним вылетам
    // если факт выше нормы на 20%, норму поднимаем (затухание λ, в пределах [0,6; 1,8])
    const levelMemo = new Map();
    function levelFactor(checkStr) {
        const days = num('MONEY_LEVEL_DAYS', 10);
        const lam = num('MONEY_LEVEL_LAMBDA', 1);
        if (!(days > 0) || !(lam > 0)) return { k: 1, n: 0 };
        const cdt = parseLocalDate(checkStr);
        if (!cdt) return { k: 1, n: 0 };
        ensureSig();
        const cutoffMs = typeof salesDataCutoffTime === 'function' ? salesDataCutoffTime() : Date.now();
        const asOfMs = Math.min(cdt.getTime() - DAY, cutoffMs - DAY);   // вылеты не позже дня до даты, их продажи уже закончились
        const key = String(asOfMs);
        const lo = 1; const hi = 10;   // окно 1-10 дн. до вылета: на других окнах поправка та же, а считается в разы дольше
        if (levelMemo.has(key)) return levelMemo.get(key);
        let a = 0; let e = 0; let n = 0;
        const win = num('WEEKDAY_NORM_WINDOW_DAYS', 56);
        const nbDays = num('MONEY_NEIGHBOR_DAYS', 5);
        const nbW = num('MONEY_NEIGHBOR_W', 1);
        const recency = num('MONEY_RECENCY_DAYS', 45);
        Object.keys(groupedData || {}).forEach(base => {
            if (typeof isValidFlightBase === 'function' && !isValidFlightBase(base)) return;
            const items = basePool(base, base);
            items.forEach(g => {
                if (g.ms > asOfMs || g.ms < asOfMs - days * DAY) return;
                if (hasDec(g.code, g.date)) return;
                const ctx = { base, code: g.code, dep: g.date, depMs: g.ms, dow: g.dow, withDecisions: false, asOfMs };
                let s = 0; let sw = 0; let nEq = 0;
                items.forEach(it => {
                    if (it === g || it.ms > asOfMs) return;
                    const gap = Math.round(Math.abs(it.ms - g.ms) / DAY);
                    let w; let f = 1;
                    if (it.dow === g.dow) { if (gap > win) return; w = recency > 0 ? Math.exp(-gap / recency) : 1; nEq += 1; }
                    else { if (gap > nbDays || gap < 1 || nbW <= 0) return; w = nbW; f = dowFactor(ctx, it, lo, hi); nEq += 0.5; }
                    if (hasDec(it.code, it.date)) return;
                    s += w * countRange(itemCurve(it), lo, hi) * Math.min(2.5, Math.max(0.4, g.seats / it.seats)) * f;
                    sw += w;
                });
                if (nEq < num('MONEY_MIN_ANALOGS', 3) || !(sw > 0)) return;
                e += s / sw; a += countRange(itemCurve(g), lo, hi); n++;
            });
        });
        const raw = n >= 20 && e > 0 ? a / e : 1;
        const out = { k: Math.pow(Math.min(1.8, Math.max(0.6, raw)), lam), raw, n };
        levelMemo.set(key, out);
        return out;
    }

    function findAnalogsRaw(base, code, dep, lo, seats) {
        let cohort = [];
        try { cohort = collectSameWeekdayCohort(base, dep, code); } catch (e) { cohort = []; }
        const usable = cohort.filter(c => c.seats > 0 && REGULAR.test(String(c.code)) && c.observedFrom <= lo);
        const depDt = parseLocalDate(dep);
        const depMs = depDt ? depDt.getTime() : 0;
        const nbDays = num('MONEY_NEIGHBOR_DAYS', 5);
        const nbW = num('MONEY_NEIGHBOR_W', 1);
        const recency = num('MONEY_RECENCY_DAYS', 45);
        let nbAll = [];
        if (nbDays > 0 && nbW > 0 && depDt) {
            const key = typeof CalendarEvents !== 'undefined' ? CalendarEvents.normKey(dep) : '';
            nbAll = basePool(base, code).filter(it => {
                const g = Math.round(Math.abs(it.ms - depMs) / DAY);
                if (g < 1 || g > nbDays || it.dow === depDt.getDay() || it.observedFrom > lo) return false;
                return (typeof CalendarEvents === 'undefined' ? '' : CalendarEvents.normKey(it.date)) === key;
            }).map(it => ({ it, gap: Math.round(Math.abs(it.ms - depMs) / DAY) }));
        }
        const win = num('WEEKDAY_NORM_WINDOW_DAYS', 56);
        const tiers = [win].concat(GAPS.filter(g => g > win));
        const minA = num('MONEY_MIN_ANALOGS', 3);
        const attempts = [{ min: minA, withDec: false }, { min: minA, withDec: true }, { min: 2, withDec: true }];
        const wSame = c => (recency > 0 ? Math.exp(-c.dayGap / recency) : 1);
        for (let a = 0; a < attempts.length; a++) {
            const pool = attempts[a].withDec ? usable : usable.filter(c => !hasDec(c.code, c.date));
            const nbPool = attempts[a].withDec ? nbAll : nbAll.filter(n => !hasDec(n.it.code, n.it.date));
            for (let i = 0; i < tiers.length; i++) {
                const list = pool.filter(c => c.dayGap <= tiers[i]);
                const ws = list.map(wSame).concat(nbPool.map(() => nbW));
                // достаточно по числу вылетов, соседние считаются вполовину; разброс - по эффективному числу с весами
                const nEq = list.length + 0.5 * nbPool.length;
                if (list.length + nbPool.length >= 2 && nEq >= attempts[a].min - 1e-9) {
                    const items = list.map(c => ({ c, curve: departureCurve(c.date, c.code), nb: false, w: wSame(c), scale: seats > 0 ? Math.min(2.5, Math.max(0.4, seats / c.seats)) : 1 }))
                        .concat(nbPool.map(n => ({ c: n.it, curve: itemCurve(n.it), nb: true, w: nbW, dow: n.it.dow, it: n.it, scale: seats > 0 ? Math.min(2.5, Math.max(0.4, seats / n.it.seats)) : 1 })));
                    return { list: items, tier: tiers[i], withDecisions: attempts[a].withDec, few: attempts[a].min < minA, keff: keffOf(items.map(x => x.w)), nEq, nSame: list.length, nNb: nbPool.length, base, code, dep, depMs, dow: depDt ? depDt.getDay() : 0 };
                }
            }
        }
        return { list: [], tier: 0, keff: 0 };
    }

    // среднее по аналогам: билеты в днях до вылета [lo..hi], приведены к местам и дню недели этого вылета
    function analogMean(an, lo, hi) {
        if (!an.list.length) return null;
        let s = 0; let sw = 0;
        an.list.forEach(a => {
            const f = a.nb ? dowFactor(an, a.it, lo, hi) : 1;
            s += a.w * countRange(a.curve, lo, hi) * a.scale * f;
            sw += a.w;
        });
        return sw > 0 ? s / sw : null;
    }

    // естественный рост тарифа: средняя цена билетов, проданных в те же дни до вылета, против цены за 1-3 дня до них
    // медиана отношений со сжатием к 1 (мало вылетов - почти без поправки); возвращает { drift, n }
    // пул: похожие вылеты и ближние по дате вылеты этого рейса (любой день недели)
    function driftPool(an, base, dep, code) {
        const seen = new Set();
        const pool = [];
        const add = (date, c) => { const k = date + '|' + c; if (!seen.has(k)) { seen.add(k); pool.push({ c: { date, code: c } }); } };
        (an && an.list || []).forEach(a0 => add(a0.c.date, a0.c.code));
        try {
            const depDt = parseLocalDate(dep);
            const rows = (typeof groupedData !== 'undefined' && groupedData[base]) || [];
            const cand = [];
            rows.forEach(r => {
                const dt = parseLocalDate(r[1]);
                if (!dt || !depDt || r[1] === dep || r.segKey || dt.getTime() >= depDt.getTime()) return;
                cand.push({ date: r[1], code: r[0], gap: depDt.getTime() - dt.getTime() });
            });
            cand.sort((x, y) => x.gap - y.gap);
            cand.slice(0, num('MONEY_DRIFT_POOL', 24)).forEach(x => add(x.date, x.code));
        } catch (e) { /* без расширения пула */ }
        return pool;
    }

    function priceDriftOf(an, dtdD, aLo, aHi, base, dep, code) {
        const minT = num('MONEY_DRIFT_MIN_TICKETS', 3);
        const rs = [];
        driftPool(an, base, dep, code).forEach(a0 => {
            let list = [];
            try { list = typeof getFlightSalesList === 'function' ? getFlightSalesList(a0.c.date, a0.c.code) : []; } catch (e) { list = []; }
            if (!list || list.length < 2 * minT) return;
            const bef = []; const aft = [];
            list.forEach(t => {
                const d = dayDiff(a0.c.date, t.dealDate);
                if (d == null || !isPaid(t)) return;
                if (d >= dtdD + 1 && d <= dtdD + 3) bef.push(price(t));
                else if (d >= aLo && d <= aHi) aft.push(price(t));
            });
            if (bef.length < minT || aft.length < minT) return;
            const r = mean(aft) / mean(bef);
            if (r > 0 && isFinite(r)) rs.push(r);
        });
        if (rs.length < num('MONEY_DRIFT_MIN_FLIGHTS', 3)) return { drift: 1, n: rs.length };
        rs.sort((x, y) => x - y);
        const med = rs.length % 2 ? rs[(rs.length - 1) / 2] : (rs[rs.length / 2 - 1] + rs[rs.length / 2]) / 2;
        const shrunk = 1 + (med - 1) * rs.length / (rs.length + 2);
        return { drift: Math.min(1.6, Math.max(0.7, shrunk)), n: rs.length };
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

    // ключ решения, общий для хранения и отчёта
    function keyOf(m) { return [m.flight || m.code, m.dep, m.check, m.status].join('|'); }

    function na(reason, extra) { return Object.assign({ stage: 'na', reason, grade: 'C', v: METHOD_VERSION }, extra || {}); }

    // до следующего решения по этому вылету (окна соседних отметок не пересекаются)
    // maxDays - искать дальше окна: итог повышения не должен заходить в дни следующего решения
    function nextDecisionGap(code, dep, check, maxDays) {
        const maxW = maxDays != null ? maxDays : num('MONEY_WINDOW_MAX', 10);
        const marks = typeof SalesManagement !== 'undefined' && SalesManagement.marksFor ? SalesManagement.marksFor(code, dep) : [];
        let best = null;
        marks.forEach(x => {
            if (x.status !== 'up' && x.status !== 'down') return;
            const g = dayDiff(x.check, check);
            if (g != null && g > 0 && g <= maxW && (best == null || g < best)) best = g;
        });
        return best;
    }

    // оценка одного решения по данным сайта; m: { code|flight, dep, check, status, clsFrom?, clsTo? }
    // сомнительное помечаем флагами (m.flags), доверие "низкое"
    // дней, которых нет в файле продаж (~14 дней), берём из журнала (day-log.js); дни из файла не заменяем
    function withJournal(dep, code, fileList) {
        if (typeof SalesDayLog === 'undefined' || !SalesDayLog.syntheticTickets) return fileList;
        let syn = [];
        try { syn = SalesDayLog.syntheticTickets(dep, code); } catch (e) { syn = []; }
        return syn.length ? fileList.concat(syn) : fileList;
    }

    function compute(m) {
        decMemo = new Map();
        const code = m.code || m.flight;
        const dep = m.dep;
        const kind = m.status;
        if (kind !== 'down' && kind !== 'up') return na('не ценовое решение');
        const base = typeof getBaseFlight === 'function' ? getBaseFlight(code) : code;
        if (!REGULAR.test(String(code))) return na('доп. рейс или чартер: обычной нормы нет');
        const dtdD0 = dayDiff(dep, m.check);
        if (dtdD0 == null) return na('нет даты решения');
        if (dtdD0 < 1) return na('решение в день вылета или позже: после него не осталось дней для оценки');
        const list = withJournal(dep, code, typeof getFlightSalesList === 'function' ? getFlightSalesList(dep, code) : []);
        if (!list.length) return na('билетов этого вылета нет в данных: оценить нельзя', { noTickets: true });
        const nextGap = nextDecisionGap(code, dep, m.check);
        const dtdD = dtdD0;
        const flags = [];
        if (nextGap != null) flags.push(`серия решений: окно только до следующего решения (${nextGap} дн.)`);
        if (dtdD < 3) flags.push(`решение за ${dtdD} дн. до вылета: окно очень короткое`);
        const maxW = num('MONEY_WINDOW_MAX', 10);
        // праздники и события: норма из обычных дней грубее, считаем с пометкой
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
        if (an.few || an.nEq < num('MONEY_MIN_ANALOGS', 3) - 1e-9) flags.push(`похожих вылетов всего ${an.list.length}`);
        // окно от W0 дней (для эпизода - до последней отметки + W0), пока ожидание не дойдёт до минимума
        // уровень спроса - по вылетам до конца окна, но не позже вылета: продажи других рейсов от решения не зависят
        const asOfStr = dayDiff(addDays(m.check, maxW + 1), dep) > 0 ? dep : addDays(m.check, maxW + 1);
        const lvK = levelFactor(asOfStr).k;
        let w = Math.min(W0, wCap);
        w = Math.max(1, w);
        let E = analogMean(an, dtdD - w, dtdD - 1) * lvK;
        while (w < wCap && E < minExp) { w++; E = analogMean(an, dtdD - w, dtdD - 1) * lvK; }
        const windowTo = addDays(m.check, w);
        const cutoffMs = typeof salesDataCutoffTime === 'function' ? salesDataCutoffTime() : Date.now();
        const needMs = parseLocalDate(windowTo).getTime() + num('MONEY_LAG_DAYS', 1) * DAY;
        const base0 = { w, windowFrom: addDays(m.check, 1), windowTo, k: an.list.length, ke: round1(an.keff), kNb: an.nNb || 0, levelK: Math.round(lvK * 100) / 100, dtd: dtdD, tierDays: an.tier, v: METHOD_VERSION, kind, flags };
        if (cutoffMs < needMs) return Object.assign(base0, { stage: 'wait', reason: `ждём данные до ${windowTo}`, grade: 'C', readyOn: addDays(windowTo, num('MONEY_LAG_DAYS', 1)) });

        // факт по билетам вылета
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
        // цена и класс до решения: средний фактический тариф за 3 дня до решения (запасной - 7), как и "после"
        // класс до из отметки только подпись; своих продаж нет - по сетке, иначе по цене после, иначе самый дешёвый класс
        let priceBefore = null; let clsBefore = null;
        const src = before3.length ? before3 : before7;
        if (src.length) { priceBefore = mean(src.map(price)); clsBefore = m.clsFrom || lowestClass(src, ladder); }
        if (!(priceBefore > 0)) priceBefore = null;   // нулевой тариф не годится, делить на него нельзя
        const avgAfter = afterAdult.length ? mean(afterAdult.map(price)) : null;
        if (priceBefore == null && m.clsFrom && ladder.get(m.clsFrom) && ladder.get(m.clsFrom).price > 0) {
            // цена без решения = факт после × (сетка до / сетка после): разница как в сетке, состав билетов как по факту
            // нет "класс после" - цена класса по сетке
            const pFrom = ladder.get(m.clsFrom).price;
            const to = m.clsTo ? ladder.get(m.clsTo) : null;
            priceBefore = to && to.price > 0 && avgAfter != null ? avgAfter * pFrom / to.price : pFrom;
            clsBefore = m.clsFrom;
        }
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
        // доля платных взрослых негрупповых среди всех билетов до решения
        // мало билетов до решения (<10) или доля меньше 0,3 - берём долю по умолчанию (MONEY_PAID_SHARE)
        let share = own.beforeAll >= 10 ? own.beforeAdult / own.beforeAll : num('MONEY_PAID_SHARE', 0.9);
        if (share < 0.3) share = num('MONEY_PAID_SHARE', 0.9);
        // Сила рейса: билеты за 3 дня до решения у вылета и у аналогов.
        const sDays = 3;
        const normOwn = analogMean(an, dtdD + 1, dtdD + sDays) * lvK;
        const out = Object.assign(base0, { priceBefore: Math.round(priceBefore), clsBefore, clsAfter, share: round1(share * 100) / 100 });

        const flyDt = parseLocalDate(dep);
        const dataCoversFlight = !!(flyDt && flyDt.getTime() < cutoffMs);

        if (kind === 'up' && nextGap == null && dataCoversFlight) {
            // итог повышения: остаток продаж после решения до вылета против обычного добора
            const an0 = findAnalogs(base, code, dep, 0, seats);
            if (an0.list.length < 2) return na('нет улетевших похожих вылетов для итога', out);
            if (an0.withDecisions && !flags.includes('у похожих вылетов тоже были ценовые решения')) flags.push('у похожих вылетов тоже были ценовые решения');
            // следующее решение дальше окна: остаток только до него (его день включаем, как у окна)
            // иначе одни и те же билеты засчитаются и повышению, и следующему решению
            const nextFar = nextDecisionGap(code, dep, m.check, Infinity);
            const remLo = nextFar != null ? Math.max(0, dtdD - nextFar) : 0;
            if (nextFar != null) flags.push(`серия решений: итог только до следующего решения (${nextFar} дн.)`);
            const Erem = analogMean(an0, remLo, dtdD - 1) * lvK;
            const rem = { all: 0, paid: 0, rev: 0 };
            let soldAtD = 0;
            list.forEach(s => {
                const d = dayDiff(dep, s.dealDate);
                if (d == null) return;
                if (d <= dtdD - 1 && d >= remLo) { rem.all++; if (isPaid(s)) { rem.paid++; rem.rev += price(s); } }
                if (d >= dtdD) soldAtD++;
            });
            const free = seats > 0 ? Math.max(0, seats - soldAtD) : null;
            const totalNow = list.length;
            const filled = seats > 0 && totalNow / seats >= num('RMS_FULL_PCT', 95) / 100;
            const dr = priceDriftOf(an0, dtdD, remLo, dtdD - 1, base, dep, code);
            const pCf = priceBefore * dr.drift;   // цена без решения - прежняя с естественным ростом тарифа
            Object.assign(out, { priceCf: Math.round(pCf), drift: Math.round(dr.drift * 1000) / 1000, driftN: dr.n });
            const est = estimateRemainder({ E: Erem, k: an0.keff, free, filled, nFactAll: rem.all, nFactPaid: rem.paid, rFact: rem.rev, priceBefore: pCf, share });
            return finish(out, est, { stage: 'final', k: an0.list.length, ke: round1(an0.keff), kNb: an0.nNb || 0, tierDays: an0.tier, remainder: true, filled, expAll: round1(est.nExpAll), factAll: rem.all,
                remDays: dtdD - remLo, remTo: nextFar != null ? addDays(m.check, nextFar) : null });
        }

        const dr = priceDriftOf(an, dtdD, dtdD - w, dtdD - 1, base, dep, code);
        const pCf = priceBefore * dr.drift;
        Object.assign(out, { priceCf: Math.round(pCf), drift: Math.round(dr.drift * 1000) / 1000, driftN: dr.n });
        const est = estimateWindow({ E, k: an.keff, nFactAll: own.all, nFactPaid: own.paid, rFact: own.rev, priceBefore: pCf, share, strength: normOwn == null ? null : { own: nOwn3, norm: normOwn } });
        if (kind === 'up' && nextGap == null) {
            // через окно только ранний сигнал: рост цены сдвигает покупки на позже, вердикт - по итогу вылета
            const res = finish(out, est, { stage: 'prelim', expAll: round1(est.nExpAll), factAll: own.all });
            res.verdict = null;
            res.reason = 'ранний сигнал: итог повышения будет после вылета';
            return res;
        }
        const res = finish(out, est, { stage: 'final', expAll: round1(est.nExpAll), factAll: own.all });
        // хвост и заполнение для пояснения, без рублей: продажи после окна против обычного
        if (dataCoversFlight) {
            const an0 = findAnalogs(base, code, dep, 0, seats);
            const Etail = an0.list.length ? analogMean(an0, 0, dtdD - w - 1) * lvK : null;
            let nTail = 0;
            list.forEach(s => { const d = dayDiff(dep, s.dealDate); if (d != null && d >= 0 && d <= dtdD - w - 1) nTail++; });
            if (Etail != null) { res.tailFact = nTail; res.tailExp = round1(Etail); }
            res.fullFlight = seats > 0 && list.length / seats >= num('RMS_FULL_PCT', 95) / 100;
        }
        return res;
    }

    // функция ошибок (Абрамовиц-Стеган), для вероятности "плюс" в finish
    function erf(x) {
        const sign = x < 0 ? -1 : 1;
        const a = Math.abs(x);
        const t = 1 / (1 + 0.3275911 * a);
        const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
        return sign * y;
    }

    // сдвиг (рубли), вычитаем из эффекта; два устойчивых на вылетах без решений:
    // 1) тариф растёт к вылету: доля выручки линейно от "решение за <=2 дня" до ">=9 дней"
    // 2) норма сжата к середине: добавка в билетах за день окна (у остатка до 12 дней); заполненный - 0
    function biasShift(base, est, extra, filled) {
        const pb = base.priceCf || base.priceBefore || 0;
        const ticketRub = (base.share != null ? base.share : 1) * pb;   // рублей на один ожидаемый билет
        if (extra.remainder) {
            if (filled) return 0;
            const days = extra.remDays != null ? extra.remDays : (base.dtd || 0);   // дней в остатке: до вылета или до следующего решения
            return num('MONEY_BIAS_REMAINDER', -0.32) * est.nExpPaid * pb + num('MONEY_BIAS_ADD_REMAINDER', 0.58) * ticketRub * Math.min(12, Math.max(0, days));
        }
        const t = base.dtd > 0 ? Math.min(1, Math.max(0, (base.dtd - 2) / 7)) : 1;
        const rate = num('MONEY_BIAS_WINDOW_NEAR', -0.36) + (num('MONEY_BIAS_WINDOW', -0.06) - num('MONEY_BIAS_WINDOW_NEAR', -0.36)) * t;
        return rate * est.nExpPaid * pb + num('MONEY_BIAS_ADD_WINDOW', 0.41) * ticketRub * (base.w || 0);
    }

    function finish(base, est, extra) {
        // нет ни обычных, ни фактических продаж: судить не о чем, иначе метку дала бы одна поправка на сдвиг
        if (extra.stage === 'final' && est.nExpAll < 0.5 && !(extra.factAll > 0)) {
            return Object.assign(base, extra, { stage: 'na', reason: 'нет продаж ни обычно, ни по факту: оценивать нечего', grade: 'C', expAll: round1(est.nExpAll) });
        }
        const pbCf = base.priceCf || base.priceBefore || 0;   // цена "без решения"
        const sampleOk = est.nExpAll + (extra.factAll || 0) >= num('MONEY_MIN_TICKETS', 4);
        const flags = base.flags || [];
        const kUsed = extra.ke != null ? extra.ke : (base.ke != null ? base.ke : base.k);   // для итога повышения - свой ke (число аналогов)
        const grade = flags.length ? 'C' : (kUsed >= 5 && est.nExpAll >= 6 ? 'A' : 'B');
        // каждый флаг расширяет диапазон на 25%, сомнительные реже дают "сработало" или "не сработало"
        const widen = 1 + 0.25 * flags.length;
        // поправка на сдвиг, см. biasShift
        const filledNow = !!(est.filled || extra.filled);
        const bias = biasShift(base, est, extra, filledNow);
        // спрос не зависит от решения: при повышении "без решения" не меньше факта, при снижении не больше
        // разница идёт решению (минус при повышении, плюс при снижении)
        // шум в одну сторону смещает сумму: добавляем его среднее, до 0,4 σ (подобрано по вылетам без решений)
        let cfAdj = 0;
        let cfNoise = 0;
        const pb0 = pbCf;
        let dcorr = est.delta - bias;
        if (!filledNow && est.nFactPaid != null) {
            const sh = base.share != null ? base.share : 1;
            if (base.kind === 'up') {
                cfAdj = Math.max(0, est.nFactPaid - est.nExpPaid);
                cfNoise = num('MONEY_UP_NOISE', 0.3) * (est.sigma || 0) * sh;
                dcorr -= (cfAdj - cfNoise) * pb0;
            } else if (base.kind === 'down') {
                cfAdj = Math.max(0, est.nExpPaid - est.nFactPaid);
                cfNoise = num('MONEY_DOWN_NOISE', 0.35) * (est.sigma || 0) * sh;
                dcorr += (cfAdj - cfNoise) * pb0;
            }
        }
        let half = (est.hi - est.lo) / 2 * widen;
        // рейс заполнен: билетов не прибавить, но цена всё равно шумит
        if (filledNow) half = num('MONEY_NOISE_Z', 1.9) * num('MONEY_PRICE_NOISE', 0.32) * est.nExpPaid * pbCf * widen;
        else if (est.halfMax != null) half = Math.min(half, est.halfMax);
        // на вылетах без решений хвост вверх длиннее: вниз диапазон шире (строже "помогло"), вверх уже
        let lo = dcorr - half * num('MONEY_RANGE_LOW', 1.2); let hi = dcorr + half * num('MONEY_RANGE_HIGH', 0.65);
        // билеты без решения: при повышении не меньше факта, при снижении не больше; у заполненного - по факту
        let nCf = base.kind === 'up' ? est.nExpPaid + cfAdj : (base.kind === 'down' ? est.nExpPaid - cfAdj : est.nExpPaid);
        if (filledNow && est.nFactPaid != null) nCf = est.nFactPaid;
        // порог значимости от выручки без решения
        const thr = Math.max(num('MONEY_MIN_PCT', 15) / 100 * nCf * pbCf, num('MONEY_MIN_RUB', 20000));
        let verdict = 'unclear';
        if (lo > 0 && dcorr >= thr) verdict = 'worked';
        else if (hi < 0 && dcorr <= -thr) verdict = 'failed';
        // "скорее": диапазон включает ноль, но вероятность знака по нормальной оценке не ниже 75%
        const zc = num('MONEY_NOISE_Z', 1.9);
        const sd = half > 0 ? half / zc : 0;
        let pPos = null;
        if (sd > 0) {
            // плюс подтверждаем строже, минус мягче (отклонения вверх длиннее)
            const skew = num('MONEY_SKEW', 0.1);
            const t = dcorr / (sd * (dcorr >= 0 ? 1 + skew : 1 - skew));
            pPos = 0.5 * (1 + erf(t / Math.SQRT2));
            if (verdict === 'unclear') {
                if (pPos >= num('MONEY_LEAN_P', 0.75)) verdict = 'lean_pos';
                else if (pPos <= 1 - num('MONEY_LEAN_P', 0.75)) verdict = 'lean_neg';
            }
        }
        // эффект по продажам: выручка по факту минус билеты без решения × прежняя цена
        // поправка на шум и сдвиг (corr) в эффект не входит, она только для метки и вероятности
        const nFp = est.nFactPaid != null ? est.nFactPaid : nCf;
        const pure = est.revFact - nCf * pb0;
        const shift = dcorr - pure;
        const delta = round1k(pure);
        const priceEffect = round1k(nCf * (est.priceAfter - pb0));
        const volPure = delta - priceEffect;
        const corr = round1k(shift);
        // только цена: билеты как по факту, меняется цена против "без решения"; вторая граница результата
        const priceOnly = round1k((nFp) * (est.priceAfter - pb0));
        const volume = volPure;
        // диапазон вокруг того же числа, что и метка: эффект с поправкой (delta + corr)
        const res = Object.assign(base, extra, {
            priceAfter: Math.round(est.priceAfter), delta, lo: round1k(lo), hi: round1k(hi), sd: round1k(sd),
            volume, volPure, corr, priceEffect, nCf: round1(nCf), priceOnly, rangeLow: Math.min(delta, priceOnly), rangeHigh: Math.max(delta, priceOnly), payback: est.priceAfter > 0 ? round1(nCf * pb0 / est.priceAfter) : null,
            thr: round1k(thr), nExpPaid: round1(est.nExpPaid), expRev: round1k(nCf * pb0), revFact: round1k(est.revFact), strengthK: Math.round(est.strengthK * 100) / 100,
            dTickets: round1(est.dTickets), grade, cfAdj: round1(cfAdj)
        });
        // остаток: ниже порога - "без заметного эффекта", иначе направление по знаку ("чуть лучше / хуже")
        // pPos показываем рядом, чтобы слабый сигнал не выдавали за твёрдый
        if (!sampleOk) verdict = verdict === 'worked' ? 'lean_pos' : (verdict === 'failed' ? 'lean_neg' : verdict);
        if (verdict === 'unclear') {
            if (Math.abs(dcorr) < thr) verdict = 'flat';
            else verdict = dcorr > 0 ? 'weak_pos' : 'weak_neg';
        }
        res.verdict = verdict;
        res.pPos = pPos == null ? null : Math.round(pPos * 100);
        if (!sampleOk) res.reason = 'мало билетов: вывод слабый';
        return res;
    }

    const store = new Map();       // ключ -> запись
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
            if (!r.ok) continue;   // файл не читается: не считаем пустым, повторим позже
            loadedMonths.add(month);
            const items = (r.data && r.data.items) || {};
            Object.keys(items).forEach(k => { store.set(k, items[k]); });
            rev++;
        }
    }

    function get(key) { return store.get(key) || null; }

    // слияние по ключу: итог не затирает предварительный; при двух итогах побеждает ранний
    async function persist(entries) {
        if (!entries.length || typeof SharedStorage === 'undefined' || !canFreeze()) return false;
        const byMonth = new Map();
        entries.forEach(e => { const mo = monthOf(e.check); if (mo) { if (!byMonth.has(mo)) byMonth.set(mo, []); byMonth.get(mo).push(e); } });
        let ok = true;
        for (const [month, list] of byMonth) {
            // перечитать, добавить свои итоги, записать только если файл не менялся с прочтения
            // итоги другого ПК, записанные между чтением и записью, не теряем; при расхождении - заново
            let items = null;
            const res = await SharedStorage.updateJsonFile(fileOf(month), (cur) => {
                const next = Object.assign({}, (cur && cur.items) || {});
                let changed = false;
                list.forEach(e => {
                    const old = next[e.key];
                    if (old && old.stage === 'final' && old.v === METHOD_VERSION) return;                               // итог уже зафиксирован, не трогаем
                    if (old && old.stage === 'prelim' && e.stage === 'prelim') return;       // ранний сигнал пишем один раз
                    next[e.key] = e;
                    changed = true;
                });
                items = next;
                return changed ? { version: 1, updatedAt: new Date().toISOString(), items: next } : false;   // всё уже записано, файл не трогаем
            }).catch(() => ({ ok: false }));
            if (res.ok || res.aborted) { Object.keys(items).forEach(k => store.set(k, items[k])); rev++; } else ok = false;
        }
        return ok;
    }

    // пересчёт зафиксированного итога с текущими параметрами (кнопка админа), запись заменяется
    async function recompute(m) {
        const key = keyOf(m);
        if (typeof SalesDayLog !== 'undefined' && SalesDayLog.ensureMonths) { try { await SalesDayLog.ensureMonths([monthOf(m.dep)]); } catch (e) { /* ignore */ } }
        const res = compute(m);
        // пересчитать нечем (билетов вылета уже нет): прежний итог не стираем
        const old = get(key);
        if (old && old.stage === 'final' && res.stage === 'na' && res.noTickets) return old;
        const entry = Object.assign({}, res, { key, check: m.check, at: new Date().toISOString(), recomputed: true });
        store.delete(key);
        if (res.stage === 'final' || res.stage === 'prelim') {
            if (typeof SharedStorage !== 'undefined' && canFreeze()) {
                const month = monthOf(m.check);
                const res = await SharedStorage.updateJsonFile(fileOf(month), (cur) => {
                    const items = Object.assign({}, (cur && cur.items) || {});
                    items[key] = entry;
                    return { version: 1, updatedAt: new Date().toISOString(), items };
                }).catch(() => ({ ok: false }));
                if (res.ok) { store.set(key, entry); rev++; }
            }
        }
        return entry;
    }

    // итог для строки отчёта: зафиксированный или свежий расчёт (незафиксированный - пометка live)
    // фиксирует тот, у кого есть право, порциями, чтобы не вешать страницу
    async function resolveAll(decisions, onProgress) {
        const months = [...new Set(decisions.map(d => monthOf(d.check)).filter(Boolean))];
        await ensureMonths(months);
        // журнал продаж по дням: читаем месяцы вылетов решений (файл на месяц небольшой)
        if (typeof SalesDayLog !== 'undefined' && SalesDayLog.ensureMonths) {
            const dm = [...new Set(decisions.map(d => monthOf(d.dep)).filter(Boolean))];
            try { await SalesDayLog.ensureMonths(dm); } catch (e) { /* без журнала считаем по файлу продаж */ }
        }
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
            const kept = keepOld(frozen, res);
            if (kept) { toSave.push(kept); out.set(key, Object.assign({ frozen: false }, kept)); continue; }
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

    // фоновая фиксация итогов после входа и публикации, в простое, порциями (resolveAll - каждые 20 мс)
    // нужна, чтобы плитка "Сегодня" была актуальной; только у тех, кому можно фиксировать
    let freezeSig = '';
    let freezing = false;
    function freezeInBackground() {
        if (freezing || !canFreeze() || typeof SalesManagement === 'undefined' || !SalesManagement.allMarks) return Promise.resolve(false);
        if (typeof groupedData === 'undefined' || !groupedData || !Object.keys(groupedData).length) return Promise.resolve(false);
        // нет свежего файла продаж: итог был бы неверным
        if (typeof hasSalesFileLoaded === 'function' && !hasSalesFileLoaded()) return Promise.resolve(false);
        if (typeof getStaleSalesInfo === 'function' && getStaleSalesInfo()) return Promise.resolve(false);
        const today = typeof getTodayDate === 'function' ? getTodayDate() : '';
        const sg = [typeof dataEpoch === 'number' ? dataEpoch : 0, today, SalesManagement.markRevision ? SalesManagement.markRevision() : ''].join('|');
        if (sg === freezeSig) return Promise.resolve(false);
        const t0 = parseLocalDate(today);
        const seen = new Set();
        const list = [];
        SalesManagement.allMarks().forEach(m => {
            if (m.status !== 'down' && m.status !== 'up') return;
            const d = parseLocalDate(m.check);
            const ago = d && t0 ? Math.round((t0 - d) / 86400000) : null;
            if (ago == null || ago < 0 || ago > 30) return;       // то же окно, что у плитки "Сегодня"
            const k = keyOf(m);
            if (seen.has(k)) return;
            seen.add(k);
            list.push({ flight: m.flight, code: m.flight, dep: m.dep, check: m.check, status: m.status, at: m.updatedAt || '' });
        });
        if (typeof PriceMarks !== 'undefined' && PriceMarks.markOverlaps) PriceMarks.markOverlaps(list);
        const todo = list.filter(r => !r.overlap);
        if (!todo.length) { freezeSig = sg; return Promise.resolve(true); }
        freezing = true;
        return resolveAll(todo).then(() => { freezeSig = sg; return true; })
            .catch(e => { console.warn('DecisionMoney.freeze', e); return false; })
            .finally(() => { freezing = false; });
    }

    function freezeSoon() {
        const run = () => { freezeInBackground(); };
        if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 60000 });
        else setTimeout(run, 5000);
    }

    // метод сменился, а билетов вылета уже нет в файле продаж: оставляем прежний итог
    // в архиве только билеты по дням и выручка за вылет, тарифа по дням нет, рубли за окно не пересчитать
    // записываем под текущей версией с пометкой vOld (посчитан прежним способом)
    function keepOld(frozen, res) {
        if (!frozen || frozen.stage !== 'final' || frozen.v === METHOD_VERSION || !res || res.stage !== 'na' || !res.noTickets) return null;
        return Object.assign({}, frozen, { v: METHOD_VERSION, vOld: frozen.vOld || frozen.v });
    }

    // ранний сигнал повышения заменяем итогом, когда вылет состоялся
    function frozenUpgradable(m) {
        const flyDt = parseLocalDate(m.dep);
        const cutoff = typeof salesDataCutoffTime === 'function' ? salesDataCutoffTime() : Date.now();
        return !!(flyDt && flyDt.getTime() < cutoff);
    }

    return { compute, keyOf, get, ensureMonths, resolveAll, freezeSoon, recompute, canFreeze, revision: () => rev, METHOD_VERSION, erf };
})();
