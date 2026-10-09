// Прогноз и экономика вылета — то, что продажник спрашивает о рейсе в первую очередь:
//  • прогноз загрузки к вылету: сколько обычно добирают такие же вылеты (тот же рейс, тот же день недели,
//    соседние недели, без праздников — см. calendar-events.js) от этого дня до вылета; разброс — между ними;
//    когда рейс распродастся;
//  • точка безубыточности и прогноз финрезультата: себестоимость − субсидия против среднего тарифа;
//  • групповые брони: заказ (PNR) от 5 билетов: сколько человек и когда куплено.
// Всё считается лениво — только для показанных рейсов — и кэшируется до новых данных.
window.FlightInsights = (function () {
    const GROUP_MIN = 5;              // билетов в одном заказе — это группа
    const NEAR_DAYS = 56;             // вылеты ±8 недель (как у нормы)
    const MIN_COHORT = 2;
    const OWN_FARE_MIN = 5;           // своих оплаченных билетов, чтобы брать средний тариф вылета
    const ROUTE_FARE_DAYS = 60;

    let memo = { sig: '', fc: new Map(), econ: new Map(), fare: new Map() };

    function sig() {
        return [typeof dataEpoch === 'number' ? dataEpoch : 0,
            typeof getTodayDate === 'function' ? getTodayDate() : '',
            typeof SalesArchive !== 'undefined' && SalesArchive.revision ? SalesArchive.revision() : 0,
            typeof CalendarEvents !== 'undefined' ? CalendarEvents.revision() : 0,
            typeof SubsidyRef !== 'undefined' && SubsidyRef.revision ? SubsidyRef.revision() : 0,
            typeof SharedOverrides !== 'undefined' && SharedOverrides.subsidyRevision ? SharedOverrides.subsidyRevision() : 0].join('|');
    }

    function cache() {
        const s = sig();
        if (memo.sig !== s) memo = { sig: s, fc: new Map(), econ: new Map(), fare: new Map() };
        return memo;
    }

    function rowOf(code, date) {
        const base = typeof getBaseFlight === 'function' ? getBaseFlight(code) : code;
        return typeof getFlightRowForDate === 'function' ? getFlightRowForDate(base, date, code) : null;
    }

    function canEconomy() {
        // Финрезультат включает выручку и себестоимость — как «Фин. результат» в «Творческой».
        if (typeof ProfileAuth === 'undefined') return true;
        return (ProfileAuth.canAccessTab('pair') || ProfileAuth.canAccessTab('costs'))
            && (ProfileAuth.canAccessTab('table') || ProfileAuth.canAccessTab('pair'));
    }

    // ---------- групповые брони ----------

    // Размер заказа у каждого билета (grp) — считается по PNR до скрытия персональных данных,
    // поэтому «группу» видят и те, кому PNR не показывается.
    function annotateGroups(details) {
        Object.keys(details || {}).forEach(k => {
            const list = details[k];
            if (!Array.isArray(list) || !list.length || !list.some(s => s && s.pnr)) return;
            const by = new Map();
            const ids = new Map();
            list.forEach(s => {
                if (!s || !s.pnr) return;
                by.set(s.pnr, (by.get(s.pnr) || 0) + 1);
                if (!ids.has(s.pnr)) ids.set(s.pnr, ids.size + 1);
            });
            // grpId — номер заказа внутри вылета (1, 2, …), не PNR: по нему группы не склеиваются и не дробятся.
            list.forEach(s => {
                if (!s) return;
                s.grp = s.pnr ? by.get(s.pnr) : 1;
                if (s.pnr) s.grpId = ids.get(s.pnr);
            });
        });
        return details;
    }

    // Группы вылета: [{ n, dealDate, pnr? }] — от больших к меньшим.
    function groupsFor(code, date) {
        const list = typeof getFlightSalesList === 'function' ? getFlightSalesList(date, code) : [];
        if (!list.length) return [];
        const out = new Map();
        list.forEach(s => {
            const n = Number(s.grp) || 0;
            if (n < GROUP_MIN) return;
            const key = s.pnr || (s.grpId != null ? 'id' + s.grpId : 'g' + n + '|' + s.dealDate);
            const prev = out.get(key);
            if (!prev) out.set(key, { n, dealDate: s.dealDate, pnr: s.pnr || '' });
            else if (String(s.dealDate) < String(prev.dealDate) && parseLocalDate(s.dealDate) < parseLocalDate(prev.dealDate)) prev.dealDate = s.dealDate;
        });
        return [...out.values()].sort((a, b) => b.n - a.n);
    }

    function groupSeats(code, date) {
        return groupsFor(code, date).reduce((a, g) => a + g.n, 0);
    }

    // ---------- прогноз загрузки ----------

    function quantile(sorted, q) {
        if (!sorted.length) return null;
        const pos = (sorted.length - 1) * q;
        const lo = Math.floor(pos);
        const hi = Math.ceil(pos);
        return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
    }

    // Улетевшие вылеты того же рейса в тот же день недели (с их кривыми продаж, по загрузке).
    function flownCohort(base, code, date) {
        if (typeof collectSameWeekdayCohort !== 'function') return [];
        const all = collectSameWeekdayCohort(base, date, code).filter(c => c.observedFrom === 0 && c.seats > 0);
        const near = all.filter(c => c.dayGap <= NEAR_DAYS);
        const use = near.length >= 3 ? near : all;
        return use.map(c => ({ ...c, curve: anchorCurveToLoad(departureCurve(c.date, c.code), c.load) }))
            .filter(c => c.curve && c.curve.total > 0);
    }

    function valueAt(c, t) {
        return typeof weekdayNormValueAt === 'function' ? weekdayNormValueAt(c, t) : null;
    }

    function planFinal(base, row, date) {
        if (typeof getExpectedLoad !== 'function' || typeof getCapacityFromAircraft !== 'function') return null;
        const cap = getCapacityFromAircraft(getAircraftType(row[4]));
        const wk = typeof getWeekForExpectedLoad === 'function' ? getWeekForExpectedLoad(date) : 1;
        const ev = getExpectedLoad(cap, base, 0, wk);
        return ev == null ? null : Math.ceil(ev);
    }

    // { final, lo, hi, lf, seats, load, dtd, n, source: 'history'|'plan'|'flown', soldOutDtd, groups }
    function forecast(code, date) {
        const m = cache();
        const key = code + '|' + date;
        if (m.fc.has(key)) return m.fc.get(key);
        let res = null;
        try { res = computeForecast(code, date); } catch (e) { console.warn('FlightInsights.forecast', code, date, e); }
        m.fc.set(key, res);
        return res;
    }

    function computeForecast(code, date) {
        const row = rowOf(code, date);
        if (!row) return null;
        const base = getBaseFlight(code);
        const seats = getSeatsOnSale(row);
        const load = getSoldFromRow(row);
        const dtd = typeof getDaysUntil === 'function' ? getDaysUntil(date) : null;
        if (dtd == null || !(seats > 0)) return null;
        const groups = groupSeats(code, date);
        if (dtd <= 0) {
            return { final: load, lo: load, hi: load, lf: Math.round(load / seats * 100), seats, load, dtd, n: 0, source: 'flown', soldOutDtd: null, groups };
        }
        // Продажи известны по день среза: добор считаем от него.
        const t = typeof observedFromDtd === 'function' ? Math.max(dtd, observedFromDtd(date)) : dtd;
        const cohort = flownCohort(base, code, date);
        const pick = [];
        cohort.forEach(c => {
            const at = valueAt(c, t);
            if (at == null) return;
            pick.push({ c, at, lf: Math.max(0, (c.curve.total - at) / c.seats) });
        });
        if (pick.length >= MIN_COHORT) {
            const lfs = pick.map(p => p.lf).sort((a, b) => a - b);
            const mean = lfs.reduce((a, b) => a + b, 0) / lfs.length;
            const clamp = (v) => Math.max(load, Math.min(seats, Math.round(v)));
            const final = clamp(load + mean * seats);
            const lo = clamp(load + quantile(lfs, pick.length >= 5 ? 0.2 : 0) * seats);
            const hi = clamp(load + quantile(lfs, pick.length >= 5 ? 0.8 : 1) * seats);
            // Когда распродастся: средний добор к каждому следующему дню.
            let soldOutDtd = load >= seats ? dtd : null;
            if (soldOutDtd == null) {
                for (let k = t - 1; k >= 0; k--) {
                    let sum = 0;
                    let n = 0;
                    pick.forEach(p => {
                        const v = valueAt(p.c, k);
                        if (v == null) return;
                        sum += Math.max(0, (v - p.at) / p.c.seats);
                        n++;
                    });
                    if (n && load + (sum / n) * seats >= seats) { soldOutDtd = k; break; }
                }
            }
            return { final, lo, hi, lf: Math.round(final / seats * 100), seats, load, dtd, n: pick.length, source: 'history', soldOutDtd, groups };
        }
        const plan = planFinal(base, row, date);
        if (plan != null) {
            const final = Math.max(load, Math.min(seats, plan));
            return { final, lo: null, hi: null, lf: Math.round(final / seats * 100), seats, load, dtd, n: 0, source: 'plan', soldOutDtd: null, groups };
        }
        return null;
    }

    // ---------- экономика: безубыточность и прогноз результата ----------

    function paidFares(list) {
        return (list || []).map(s => s.adjustedFare || s.fare || 0).filter(v => v > 0);
    }

    // Средний тариф: свой (если продано хотя бы 5 платных), иначе по рейсу за последние 60 дней.
    function avgFare(code, date) {
        const m = cache();
        const key = code + '|' + date;
        if (m.fare.has(key)) return m.fare.get(key);
        let res = null;
        const own = paidFares(typeof getFlightSalesList === 'function' ? getFlightSalesList(date, code) : []);
        if (own.length >= OWN_FARE_MIN) {
            res = { value: Math.round(own.reduce((a, b) => a + b, 0) / own.length), source: 'own', n: own.length };
        } else {
            const fly = parseLocalDate(date);
            let sum = 0;
            let n = 0;
            Object.keys(typeof salesDetails !== 'undefined' && salesDetails ? salesDetails : {}).forEach(k => {
                const i = k.lastIndexOf('|');
                if (k.slice(i + 1) !== code || k.slice(0, i) === date) return;
                const d = parseLocalDate(k.slice(0, i));
                if (!d || !fly || Math.abs(d - fly) > ROUTE_FARE_DAYS * 86400000) return;
                paidFares(salesDetails[k]).forEach(v => { sum += v; n++; });
            });
            if (own.length) own.forEach(v => { sum += v; n++; });
            if (n) res = { value: Math.round(sum / n), source: 'route', n };
        }
        m.fare.set(key, res);
        return res;
    }

    // { cost, subsidy, fare, breakeven, final, finResult, need, needFare, belowCost }
    function economics(code, date) {
        if (!canEconomy()) return null;
        const m = cache();
        const key = code + '|' + date;
        if (m.econ.has(key)) return m.econ.get(key);
        let res = null;
        try { res = computeEconomics(code, date); } catch (e) { console.warn('FlightInsights.economics', code, date, e); }
        m.econ.set(key, res);
        return res;
    }

    function computeEconomics(code, date) {
        const row = rowOf(code, date);
        if (!row || typeof RouteCosts === 'undefined' || !RouteCosts.lookup) return null;
        const econ = RouteCosts.lookup(row, code, date);
        const cost = econ && econ.unitCost != null ? econ.unitCost : null;
        if (cost == null) return null;
        let subsidy = econ ? (econ.subsidyOneWay || 0) : 0;
        if (typeof SharedOverrides !== 'undefined' && SharedOverrides.hasSubsidy(code, date)) subsidy = Number(SharedOverrides.getSubsidy(code, date)) || 0;
        const fare = avgFare(code, date);
        const seats = getSeatsOnSale(row);
        const fc = forecast(code, date);
        const gap = cost - subsidy;
        const out = { cost, subsidy, fare: fare ? fare.value : null, fareSource: fare ? fare.source : '', seats, breakeven: null, final: fc ? fc.final : null, finResult: null, need: null, needFare: null, belowCost: false };
        if (!fare || !(fare.value > 0)) return out;
        out.breakeven = gap <= 0 ? 0 : Math.ceil(gap / fare.value);
        out.belowCost = out.breakeven > seats;
        if (fc && fc.final != null) {
            out.finResult = Math.round(fc.final * fare.value + subsidy - cost);
            if (out.finResult < 0) {
                out.need = Math.max(0, out.breakeven - fc.final);
                out.needFare = fc.final > 0 ? Math.ceil(gap / fc.final - fare.value) : null;
            }
        }
        return out;
    }

    // ---------- тексты ----------

    function plural(n, one, few, many) {
        const m10 = n % 10, m100 = n % 100;
        if (m10 === 1 && m100 !== 11) return one;
        if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
        return many;
    }

    function rub(v) {
        if (v == null) return '—';
        const abs = Math.abs(v);
        const sign = v < 0 ? '−' : '';
        if (abs >= 1000) return sign + Math.round(abs / 1000).toLocaleString('ru-RU') + ' тыс. ₽';
        return sign + Math.round(abs).toLocaleString('ru-RU') + ' ₽';
    }

    function rubFull(v) {
        return v == null ? '—' : Math.round(v).toLocaleString('ru-RU') + ' ₽';
    }

    // Короткая подпись прогноза: «38 (34–41) · 83%».
    function forecastShort(f) {
        if (!f) return '—';
        const range = f.lo != null && f.hi != null && f.lo !== f.hi ? ` (${f.lo}–${f.hi})` : '';
        return `${f.final}${range} · ${f.lf}%`;
    }

    function forecastText(f) {
        if (!f || f.source === 'flown') return '';
        const range = f.lo != null && f.hi != null && f.lo !== f.hi ? `, разброс ${f.lo}–${f.hi}` : '';
        const src = f.source === 'history'
            ? `по ${f.n} ${plural(f.n, 'прошлому вылету', 'прошлым вылетам', 'прошлым вылетам')} в этот день недели`
            : 'по файлу ожидаемой загрузки (своей истории пока мало)';
        let tail = '';
        if (f.load >= f.seats) tail = ' · уже распродан';
        else if (f.soldOutDtd != null) tail = f.soldOutDtd === 0 ? ' · распродастся к дню вылета' : ` · распродастся примерно за ${f.soldOutDtd} дн. до вылета — можно поднимать`;
        else if (f.lf < 60) tail = ' · не доберёт: стоит снижать или продвигать';
        return `Прогноз к вылету: ${f.final} из ${f.seats} (${f.lf}%)${range} — ${src}${tail}`;
    }

    function economicsText(e) {
        if (!e) return '';
        if (e.fare == null) return `Себестоимость ${rub(e.cost)}${e.subsidy ? `, субсидия ${rub(e.subsidy)}` : ''} — нет продаж для среднего тарифа.`;
        const fareNote = e.fareSource === 'route' ? ' (средний по рейсу)' : '';
        if (e.breakeven === 0) return `Безубыточность: субсидия покрывает себестоимость · средний тариф ${rubFull(e.fare)}${fareNote}${e.finResult != null ? ` · прогноз результата ${e.finResult >= 0 ? '+' : ''}${rub(e.finResult)}` : ''}`;
        let s = `Безубыточность: ${e.breakeven} пасс.${e.belowCost ? ' — больше кресел, при этом тарифе рейс не окупается' : ''} · средний тариф ${rubFull(e.fare)}${fareNote}`;
        if (e.finResult != null) {
            s += ` · прогноз результата ${e.finResult >= 0 ? '+' : ''}${rub(e.finResult)}`;
            if (e.finResult < 0 && !e.belowCost) {
                const parts = [];
                if (e.need) parts.push(`+${e.need} ${plural(e.need, 'билет', 'билета', 'билетов')}`);
                if (e.needFare != null && e.needFare > 0) parts.push(`тариф +${rubFull(e.needFare)}`);
                if (parts.length) s += ` (чтобы выйти в ноль: ${parts.join(' или ')})`;
            }
        }
        return s;
    }

    function groupsText(code, date) {
        const g = groupsFor(code, date);
        if (!g.length) return '';
        const total = g.reduce((a, x) => a + x.n, 0);
        const pnrOk = typeof ProfileAuth === 'undefined' || (ProfileAuth.hasPermission('sales_detail') && ProfileAuth.hasPermission('load_data'));
        const items = g.slice(0, 3).map(x => `${x.n} ${plural(x.n, 'человек', 'человека', 'человек')}${x.dealDate ? ' от ' + String(x.dealDate).slice(0, 5) : ''}${x.pnr && pnrOk ? ' (' + x.pnr + ')' : ''}`).join(', ');
        return g.length === 1 ? `Группа: ${items}` : `Группы (${g.length}): ${items}${g.length > 3 ? ' и др.' : ''} — всего ${total} ${plural(total, 'человек', 'человека', 'человек')}`;
    }

    return { forecast, economics, groupsFor, groupSeats, annotateGroups, forecastShort, forecastText, economicsText, groupsText, canEconomy, GROUP_MIN, rub, rubFull, plural };
})();
