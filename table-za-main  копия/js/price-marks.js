// Ценовые решения из «Управления продажами» на графиках и отметка в один клик.
// • Маркеры ▲ повышение, ▼ снижение, ! внимание на графиках продаж рейса (плагин Chart.js).
// • Эффект решения: продажи за 3 дня до и 3 дня после (день отметки — в «после»),
//   с поправкой на норму по дню недели (sales-report.js). Пока окно «после» не закончилось
//   или норма не построена — честно пишем, что данных мало.
// • Быстрая отметка за сегодня (RMS, карточка рейса, детализация «Динамики»): те же права
//   и тот же файл, что в «Управлении продажами».
window.PriceMarks = (function () {
    // «3 дня», «5 дней» — окно решения из «Параметров расчётов».
    function winDays() { const n = PV.DECISION_WINDOW; const m10 = n % 10, m100 = n % 100; return n + ' ' + (m10 === 1 && m100 !== 11 ? 'день' : (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'дня' : 'дней')); }

    const GLYPH = { up: '▲', down: '▼', attn: '!' };
    const DECISIONS = new Set(['up', 'down', 'attn']);

    function cssVar(name, fallback) {
        try {
            const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
            return v || fallback;
        } catch (e) {
            return fallback;
        }
    }

    function color(status) {
        if (status === 'up') return '#15803d';
        if (status === 'down') return cssVar('--sm-down', '#8e1b2f');
        return '#ea580c';
    }

    function available() {
        return typeof SalesManagement !== 'undefined' && typeof SalesManagement.marksFor === 'function';
    }

    // Решения по вылету (без «проверено без изменений»).
    function decisions(code, flyDate) {
        if (!available()) return [];
        return SalesManagement.marksFor(code, flyDate).filter(m => DECISIONS.has(m.status));
    }

    function todayMark(code, flyDate) {
        if (!available() || typeof getTodayDate !== 'function') return null;
        return SalesManagement.getMark(code, flyDate, getTodayDate());
    }

    function dayDiff(a, b) {
        const da = parseLocalDate(a);
        const db = parseLocalDate(b);
        return da && db ? Math.round((da.getTime() - db.getTime()) / 86400000) : null;
    }

    // ---------- эффект решения ----------

    // Старая цена — цена класса, который был открыт перед решением: по букве билетов последнего дня продаж
    // (за 14 дней до решения) и сетке тарифов. Если сетки нет — медиана оплаченных взрослых билетов тех 14 дней.
    // Так «тариф до» не зависит от 2–3 случайных билетов (детских, групповых, дорогих) в окне 3 дней.
    function oldPrice(list, flyDate, code, d) {
        const adult = (x) => {
            const f = x.adjustedFare || x.fare || 0;
            const b = String(x.basicFareStr || '').toUpperCase();
            return f > 0 && !/\/(CN|IN|ID|WO|DA)\d*/.test(b) && !/IDB$/.test(b);
        };
        const pool = list.filter(x => { const t = dayDiff(flyDate, x.dealDate); return t != null && t > d && t <= d + 14 && adult(x); });
        if (!pool.length) return null;
        const last = Math.min(...pool.map(x => dayDiff(flyDate, x.dealDate)));
        const day = pool.filter(x => dayDiff(flyDate, x.dealDate) === last);
        const ladder = typeof FareGrid !== 'undefined' ? FareGrid.ladderFor(code, flyDate) : [];
        if (ladder.length >= 2) {
            let best = null;
            day.forEach(x => { const l = ladder.find(y => y.cls === String(x.basicFareStr || '').trim().charAt(0).toUpperCase()); if (l && (!best || l.price > best.price)) best = l; });
            if (best) return best.price;
        }
        const v = pool.map(x => x.adjustedFare || x.fare).sort((a, b) => a - b);
        return v[v.length >> 1];
    }

    function windowStats(list, flyDate, dtdFrom, dtdTo) {
        let n = 0;
        let sum = 0;
        let paid = 0;
        list.forEach(s => {
            const dtd = dayDiff(flyDate, s.dealDate);
            if (dtd == null || dtd < dtdTo || dtd > dtdFrom) return;
            n++;
            const v = s.adjustedFare || s.fare || 0;
            if (v > 0) { sum += v; paid++; }
        });
        // avg — средний оплаченный тариф (для показа); perTicket — выручка на один билет, включая билеты за 0 ₽:
        // по нему считается выручка «без решения», иначе нулевые билеты занижали бы итог решения на ровном месте.
        return { n, sum, avg: paid ? Math.round(sum / paid) : null, perTicket: n ? sum / n : null };
    }

    // Норма продаж за окно дней до вылета [dtdTo..dtdFrom] на кресла этого вылета.
    function normPickup(base, code, flyDate, dtdFrom, dtdTo) {
        if (typeof collectSameWeekdayCohort !== 'function' || typeof weekdayNormSeries !== 'function') return null;
        const row = typeof getFlightRowForDate === 'function' ? getFlightRowForDate(base, flyDate, code) : null;
        const seats = row && typeof getSeatsOnSale === 'function' ? getSeatsOnSale(row) : 0;
        // Оба дня окна — у одних и тех же вылетов: только те, у кого и конец окна уже наступил
        // (иначе разность двух средних по разным наборам вылетов врёт).
        const cohort = collectSameWeekdayCohort(base, flyDate, code)
            .filter(c => c.dayGap <= (typeof PV.WEEKDAY_NORM_WINDOW_DAYS === 'number' ? PV.WEEKDAY_NORM_WINDOW_DAYS : 56))
            .filter(c => !(c.observedFrom > Math.max(0, dtdTo)));
        const pts = weekdayNormSeries(cohort, [dtdFrom + 1, Math.max(0, dtdTo)], seats).points;
        if (!pts[0] || !pts[1] || pts[0].value == null || pts[1].value == null) return null;
        return { value: Math.max(0, pts[1].value - pts[0].value), n: Math.min(pts[0].n, pts[1].n) };
    }

    // Вылет уже выпал из файла продаж — число билетов по дням берём из архива кривых (без тарифов).
    function curveStats(curve, dtdFrom, dtdTo) {
        const val = (t) => (t > curve.maxDtd ? 0 : (curve.onHand[t] != null ? curve.onHand[t] : curve.total));
        return { n: Math.max(0, val(dtdTo) - val(dtdFrom + 1)), avg: null };
    }

    function effectFor(base, code, flyDate, mark) {
        const list = typeof getFlightSalesList === 'function' ? getFlightSalesList(flyDate, code) : [];
        const d = dayDiff(flyDate, mark.check);
        if (d == null) return null;
        const archived = !list.length && typeof SalesArchive !== 'undefined' ? SalesArchive.curveFor(flyDate, code) : null;
        const stats = (from, to) => (archived ? curveStats(archived, from, to) : windowStats(list, flyDate, from, to));
        const before = stats(d + PV.DECISION_WINDOW, d + 1);
        const afterTo = Math.max(0, d - (PV.DECISION_WINDOW - 1));
        const after = stats(d, afterTo);
        const cutoff = typeof salesDataCutoffTime === 'function' ? salesDataCutoffTime() : Date.now();
        const lastAfterDay = parseLocalDate(flyDate);
        if (lastAfterDay) lastAfterDay.setDate(lastAfterDay.getDate() - afterTo);
        // Последний день окна «после» должен быть целиком в данных: день среза может быть неполным.
        const complete = !!(lastAfterDay && lastAfterDay.getTime() < cutoff);
        const nb = normPickup(base, code, flyDate, d + PV.DECISION_WINDOW, d + 1);
        const na = normPickup(base, code, flyDate, d, afterTo);
        const effect = complete && nb && na ? (after.n - na.value) - (before.n - nb.value) : null;
        // Тариф «до»: средний за 3 дня до решения, а если тогда не продали ни одного — по всем более ранним продажам.
        // Выручка на билет до решения — по всем билетам за 14 дней до него (тот же состав, что «после»: дети, группы,
        // разные семейства), а не по 2–3 билетам окна и не по цене класса. Меньше 3 билетов — рубли не считаем.
        const b14 = archived ? null : windowStats(list, flyDate, d + 14, d + 1);
        const fareBefore = b14 && b14.n >= 3 ? b14.perTicket : null;
        const fareAfter = after.n ? after.perTicket : 0;
        // Итог в рублях: выручка за 3 дня после решения против той, что была бы без него.
        //   E = max(0, обычно_после + ½·(до − обычно_до)) — столько продали бы по старому тарифу: отклонение от нормы
        //   до решения учитывается наполовину (окна по 3 дня шумные, отклонения обычно возвращаются к норме);
        //   повышение: E ≥ после (дороже — не продали бы больше), снижение: E ≤ после;
        //   R0 = E × тариф_до,  R1 = после × тариф_после,  ΔR = R1 − R0.
        // Рубли по решениям не считаются: выручка за окно зависит от состава билетов (группы, дети, семейства тарифов)
        // сильнее, чем от самого решения, — итог в рублях получался шумом. Решение судится по билетам против нормы.
        let money = null;
        if (false && complete && nb && na && fareBefore != null && fareAfter != null) {
            const raw = Math.max(0, Math.round((na.value + (before.n - nb.value) / 2) * 10) / 10);
            let expected = raw;
            // Цена против спроса: после повышения билетов не может стать больше, чем было бы без него, а после снижения — меньше.
            if (mark.status === 'up') expected = Math.max(expected, after.n);
            if (mark.status === 'down') expected = Math.min(expected, after.n);
            const r0 = expected * fareBefore;
            const r1 = after.sum != null ? after.sum : after.n * fareAfter;   // фактическая сумма (билеты с нулевым тарифом не завышают)
            money = {
                expected,
                rawExpected: raw,
                r0: Math.round(r0),
                r1: Math.round(r1),
                delta: Math.round(r1 - r0),
                fareBefore: Math.round(fareBefore),
                fareAfter: after.n ? Math.round(fareAfter) : null,
                // Повышение окупается, пока продано не меньше E × тариф_до / тариф_после.
                breakEven: after.n && fareAfter > 0 ? Math.ceil(expected * fareBefore / fareAfter * 10) / 10 : null
            };
        }
        // Улетевший вылет: заполнился ли он (тогда «недопроданные» после повышения места ушли позже, дороже).
        let finalLf = null;
        const fly = parseLocalDate(flyDate);
        if (fly && fly.getTime() < Date.now() - 86400000 && typeof getFlightRowForDate === 'function') {
            const row = getFlightRowForDate(base, flyDate, code);
            const seats = row && typeof getSeatsOnSale === 'function' ? getSeatsOnSale(row) : 0;
            const sold = row && typeof getSoldFromRow === 'function' ? getSoldFromRow(row) : 0;
            if (seats > 0) finalLf = sold / seats;
        }
        if (mark.status === 'up') return upEffect(base, code, flyDate, d, list, archived, stats, before, nb, fareBefore);
        return { dtd: d, before, after, normBefore: nb, normAfter: na, complete, effect, money, finalLf };
    }

    // Повышение судится по итогу вылета, а не по 3 дням: дороже продают медленнее — это нормально, места продаются
    // ближе к вылету. Плохо только если рейс в итоге недобрал. Сравнение — выручка с решения до вылета против того,
    // что было бы без повышения: обычный добор с этого дня (норма по дню недели, с поправкой на темп до решения),
    // по старому тарифу, не больше свободных на тот момент мест. Рейс заполнился (от 95%) — места не потеряны.
    function upEffect(base, code, flyDate, d, list, archived, stats, before, nb, fareBefore) {
        const afterAll = stats(d, 0);
        const naAll = normPickup(base, code, flyDate, d, 0);
        const fly = parseLocalDate(flyDate);
        const cutoff = typeof salesDataCutoffTime === 'function' ? salesDataCutoffTime() : Date.now();
        const complete = !!(fly && fly.getTime() < cutoff);   // данные уже охватывают день вылета
        let seats = 0;
        let sold = 0;
        if (typeof getFlightRowForDate === 'function') {
            const row = getFlightRowForDate(base, flyDate, code);
            seats = row && typeof getSeatsOnSale === 'function' ? getSeatsOnSale(row) : 0;
            sold = row && typeof getSoldFromRow === 'function' ? getSoldFromRow(row) : 0;
        }
        // Вылет уже выпал из таблицы загрузки — кресла и итог из архива продаж.
        if (!(seats > 0) && typeof SalesArchive !== 'undefined' && SalesArchive.entryFor) {
            const ae = SalesArchive.entryFor(flyDate, code);
            if (ae && ae.s > 0) { seats = ae.s; sold = ae.sold || 0; }
        }
        // Кресел не знаем — не знаем, были ли свободные места: не судим (иначе «потеряли» билеты на полном рейсе).
        if (!(seats > 0)) return { dtd: d, before, after: afterAll, normBefore: nb, normAfter: naAll, complete, effect: null, money: null, finalLf: null, untilDeparture: true, expected: null };
        const finalLf = complete && seats > 0 ? sold / seats : null;
        const freeAtDecision = seats > 0 ? Math.max(0, seats - Math.max(0, sold - afterAll.n)) : null;
        let expected = naAll && nb ? Math.max(0, naAll.value + (before.n - nb.value) / 2) : null;
        if (expected != null && freeAtDecision != null) expected = Math.min(expected, freeAtDecision);
        if (expected != null && finalLf != null && finalLf >= 0.95) expected = afterAll.n;   // заполнился — мест не потеряли
        const effect = complete && expected != null ? Math.round((afterAll.n - expected) * 10) / 10 : null;
        // Выручка: с решением — фактическая сумма билетов от дня решения до вылета; без решения — обычный добор
        // (не меньше, чем продали) по старой цене открытого класса. Заполнился — без повышения продали бы столько же.
        let money = null;
        if (false && complete && expected != null && fareBefore != null && !archived) {
            const e0 = Math.max(expected, afterAll.n);
            const r0 = e0 * fareBefore;
            const r1 = afterAll.sum != null ? afterAll.sum : 0;
            money = { expected: Math.round(e0 * 10) / 10, rawExpected: expected, r0: Math.round(r0), r1: Math.round(r1), delta: Math.round(r1 - r0),
                fareBefore: Math.round(fareBefore), fareAfter: afterAll.n ? Math.round(afterAll.perTicket) : null,
                breakEven: afterAll.n && afterAll.perTicket > 0 ? Math.ceil(e0 * fareBefore / afterAll.perTicket * 10) / 10 : null };
        }
        return { dtd: d, before, after: afterAll, normBefore: nb, normAfter: naAll, complete, effect, money, finalLf, untilDeparture: true, expected };
    }

    // Итог решения — один для карточки рейса и для журнала решений.
    // worked: true / false, null — вывод делать рано (мало продаж) или не с чем сравнить.
    function judge(e, status) {
        if (!e || !e.complete) return e && e.untilDeparture
            ? { cls: 'wait', text: 'итог повышения — после вылета', short: 'ждём вылета', worked: null }
            : { cls: 'wait', text: `ещё идут ${winDays()}`, short: 'ждём', worked: null };
        if (e.effect == null) return { cls: 'none', text: 'не с чем сравнить', short: '—', worked: null };
        const m = e.money;
        const up = status === 'up';
        if (e.untilDeparture) {
            if (!m && e.finalLf != null && e.finalLf >= 0.95) return { cls: 'pos', text: `рейс заполнился (${Math.round(e.finalLf * 100)}%)`, short: 'сработало', worked: true };
            if (e.effect == null) return { cls: 'none', text: 'не с чем сравнить', short: '—', worked: null };
            const tol = Math.max(1, Math.round((e.expected || 0) * 0.1));
            if ((e.expected || 0) + e.after.n < 3) return { cls: 'none', text: 'мало продаж для вывода', short: 'рано судить', worked: null };
            if (m) {
                const rubS2 = (v) => `${v > 0 ? '+' : (v < 0 ? '−' : '')}${rub(Math.abs(v))}`;
                return m.delta >= 0
                    ? { cls: 'pos', text: `выручка ${rubS2(m.delta)} к «без повышения» (продано ${e.after.n}, обычно ${fmtN(m.expected)} по ${rub(m.fareBefore)})`, short: 'сработало', worked: true }
                    : { cls: 'neg', text: `выручка ${rubS2(m.delta)} к «без повышения»: продано ${e.after.n} на ${rub(m.r1)}, без повышения ~${fmtN(m.expected)} по ${rub(m.fareBefore)}`, short: 'не сработало', worked: false };
            }
            return e.effect >= -tol
                ? { cls: 'pos', text: `по новой цене добрали как обычно (${e.after.n} при обычных ${fmtN(Math.round(e.expected * 10) / 10)})`, short: 'сработало', worked: true }
                : { cls: 'neg', text: `после повышения добрали меньше обычного: ${e.after.n} вместо ${fmtN(Math.round(e.expected * 10) / 10)}, загрузка ${e.finalLf != null ? Math.round(e.finalLf * 100) + '%' : '—'}`, short: 'не сработало', worked: false };
        }
        if (up && e.finalLf != null && e.finalLf >= 0.95) {
            return { cls: 'pos', text: `рейс заполнился (${Math.round(e.finalLf * 100)}%) — повышение не стоило мест`, short: 'сработало', worked: true };
        }
        if (!m) {
            // Тарифов нет (вылет уже только в архиве) — по билетам, как раньше.
            if (up) return e.effect >= 0 ? { cls: 'pos', text: 'спрос выдержал повышение', short: 'сработало', worked: true }
                : { cls: 'neg', text: `билетов меньше обычного ${signedN(e.effect)}`, short: 'не сработало', worked: false };
            return e.effect > 0 ? { cls: 'pos', text: `продаётся лучше обычного ${signedN(e.effect)}`, short: 'сработало', worked: true }
                : { cls: 'neg', text: e.effect < 0 ? `хуже обычного ${signedN(e.effect)}` : 'без изменений', short: 'не сработало', worked: false };
        }
        const rubS = (v) => `${v > 0 ? '+' : (v < 0 ? '−' : '')}${rub(Math.abs(v))}`;
        // «Рано судить» — по оценке до поправки «не меньше / не больше»: иначе провалившееся снижение пряталось бы здесь.
        if ((m.rawExpected != null ? m.rawExpected : m.expected) + e.after.n < 4) {
            return { cls: 'none', text: `мало продаж для вывода (выручка ${rubS(m.delta)})`, short: 'рано судить', worked: null };
        }
        if (m.delta >= 0) {
            return { cls: 'pos', text: `выручка ${rubS(m.delta)} к «без ${up ? 'повышения' : 'снижения'}»`, short: 'сработало', worked: true };
        }
        return { cls: 'neg', text: up && m.breakEven != null
            ? `выручка ${rubS(m.delta)}: окупилось бы с ${fmtN(m.breakEven)} бил., продано ${e.after.n}`
            : `выручка ${rubS(m.delta)} к «без ${up ? 'повышения' : 'снижения'}»`, short: 'не сработало', worked: false };
    }

    function signedN(n) {
        return (n > 0 ? '+' : (n < 0 ? '−' : '')) + Math.abs(n);
    }

    function fmtN(v) {
        return String(v).replace('.', ',');
    }

    function rub(v) {
        return v == null ? '—' : (typeof formatRub === 'function' ? formatRub(v) : Math.round(v) + ' ₽');
    }

    function statusLabel(status) {
        return typeof SalesManagement !== 'undefined' && SalesManagement.STATUSES[status] ? SalesManagement.STATUSES[status].label : status;
    }

    function plural(n, one, few, many) {
        const m10 = n % 10, m100 = n % 100;
        if (m10 === 1 && m100 !== 11) return one;
        if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
        return many;
    }

    function tickets(n) {
        return `${n} ${plural(n, 'билет', 'билета', 'билетов')}`;
    }

    // Понятное описание: сколько продали до и после решения, сколько обычно, и вывод.
    function effectLines(e, status) {
        if (!e) return [];
        const usual = (x) => (x ? ` (обычно ${x.value})` : '');
        const lines = e.untilDeparture
            ? [`До решения: ${tickets(e.before.n)} за ${winDays()}${usual(e.normBefore)} → после решения до вылета: ${tickets(e.after.n)}${e.normAfter ? ` (обычно добирают ${e.normAfter.value})` : ''}${e.complete ? '' : ' — вылет ещё впереди'}`]
            : [`До решения: ${tickets(e.before.n)} за ${winDays()}${usual(e.normBefore)} → после: ${tickets(e.after.n)}${usual(e.normAfter)}${e.complete ? '' : ' — дни ещё идут'}`];
        if (e.before.avg != null && e.after.avg != null && e.before.avg !== e.after.avg) {
            const d = e.after.avg - e.before.avg;
            lines.push(`Средний тариф: ${rub(e.before.avg)} → ${rub(e.after.avg)} (${d > 0 ? '+' : '−'}${rub(Math.abs(d))})`);
        }
        let verdict;
        if (!e.complete) verdict = e.untilDeparture ? 'Итог повышения будет после вылета: важно, заполнится ли рейс' : `Итог будет, когда пройдут ${winDays()} после решения`;
        else if (e.untilDeparture && e.finalLf != null && e.finalLf >= 0.95) verdict = `Итог: рейс заполнился (${Math.round(e.finalLf * 100)}%) — повышение мест не стоило`;
        else if (e.untilDeparture && e.effect != null) verdict = e.effect >= 0 ? `Итог: после повышения добрали не меньше обычного (${signedN(e.effect)})` : `Итог: после повышения добрали меньше обычного — на ${tickets(Math.round(-e.effect))}`;
        else if (e.effect == null) verdict = 'Сравнить не с чем: мало прошлых вылетов в этот день недели';
        // В карточке — по билетам (рубли — в отчёте «Решения»).
        else if (e.effect > 0) verdict = `Итог: после решения продаётся лучше обычного — на ${tickets(e.effect)}`;
        else if (e.effect < 0) verdict = `Итог: после решения продаётся хуже обычного — на ${tickets(-e.effect)}`;
        else verdict = 'Итог: продаётся как обычно';
        lines.push(verdict);
        return lines;
    }

    function effectText(e, status) {
        return effectLines(e, status).join(' · ');
    }

    // Блок «Ценовые решения» под графиками.
    function decisionsHtml(base, code, flyDate) {
        const list = decisions(code, flyDate);
        if (!list.length) return '';
        const esc = typeof escHtml === 'function' ? escHtml : String;
        const rows = list.map(m => {
            const e = m.status === 'attn' ? null : effectFor(base, code, flyDate, m);
            const cls = e && e.complete && e.effect != null ? (e.effect > 0 ? 'pm-eff-up' : (e.effect < 0 ? 'pm-eff-down' : '')) : '';
            const lines = effectLines(e, m.status);
            return `<li class="pm-item">
                <div class="pm-item-head"><span class="pm-glyph pm-${m.status}">${GLYPH[m.status]}</span>
                <strong>${esc(statusLabel(m.status))}</strong> ${esc(m.check.slice(0, 5))}${m.author ? ' · ' + esc(m.author) : ''}</div>
                ${lines.length ? `<div class="pm-eff">${lines.slice(0, -1).map(l => `<div>${esc(l)}</div>`).join('')}<div class="pm-eff-verdict ${cls}">${esc(lines[lines.length - 1])}</div></div>` : ''}
            </li>`;
        }).join('');
        return `<div class="pm-block">
            <div class="pm-title">Ценовые решения по вылету</div>
            <ul class="pm-list">${rows}</ul>
        </div>`;
    }

    // Маркеры для графика: индекс точки по оси X.
    function chartItems(code, flyDate, indexOf) {
        return decisions(code, flyDate).map(m => {
            const index = indexOf(m);
            return index == null || index < 0 ? null : { index, status: m.status, title: `${GLYPH[m.status]} ${statusLabel(m.status)} ${m.check.slice(0, 5)}` };
        }).filter(Boolean);
    }

    const plugin = {
        id: 'priceMarks',
        afterDatasetsDraw(chart, args, opts) {
            const items = opts && opts.items;
            if (!items || !items.length) return;
            const x = chart.scales.x;
            const area = chart.chartArea;
            if (!x || !area) return;
            const ctx = chart.ctx;
            ctx.save();
            items.forEach(it => {
                const px = x.getPixelForValue(it.index);
                if (!isFinite(px) || px < area.left - 1 || px > area.right + 1) return;
                const c = color(it.status);
                ctx.strokeStyle = c;
                ctx.globalAlpha = 0.7;
                ctx.setLineDash([3, 3]);
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(px, area.top + 12);
                ctx.lineTo(px, area.bottom);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.globalAlpha = 1;
                ctx.fillStyle = c;
                ctx.font = 'bold 12px sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'top';
                ctx.fillText(GLYPH[it.status] || '•', px, area.top);
            });
            ctx.restore();
        }
    };
    if (typeof Chart !== 'undefined' && Chart.register) Chart.register(plugin);

    // ---------- отметка в один клик ----------

    function canMark() {
        return available() && SalesManagement.canEdit();
    }

    // Улетевший вылет не отмечаем — как и в таблице «Управления продажами».
    function flown(flyDate) {
        return available() && SalesManagement.isFlownDate && SalesManagement.isFlownDate(flyDate);
    }

    function setToday(code, flyDate, status) {
        if (!canMark()) {
            if (typeof showToast === 'function') showToast('Нет права ставить отметки «Управления продажами»', 'error');
            return false;
        }
        if (flown(flyDate)) {
            if (typeof showToast === 'function') showToast('Рейс уже улетел — отметка не нужна', 'error');
            return false;
        }
        const today = getTodayDate();
        const ok = status
            ? SalesManagement.putMark(code, flyDate, today, status, SalesManagement.profileName())
            : SalesManagement.clearMark(code, flyDate, today);
        if (ok && typeof ActivityLog !== 'undefined') {
            ActivityLog.log('sales_mark', `${code} ${flyDate}: ${status ? statusLabel(status) : 'снята'}`);
        }
        document.dispatchEvent(new CustomEvent('krasavia:mark', { detail: { code, date: flyDate, status } }));
        return ok;
    }

    // Чип сегодняшней отметки: кнопка для тех, кто может отмечать, иначе просто метка.
    function chipHtml(code, flyDate) {
        if (!available()) return '';
        const m = todayMark(code, flyDate);
        const esc = typeof escAttr === 'function' ? escAttr : String;
        const st = m && SalesManagement.STATUSES[m.status] ? m.status : '';
        const text = st ? (GLYPH[st] || '✓') : (canMark() ? '＋' : '');
        const title = st ? `Сегодня: ${statusLabel(st)}${m.author ? ' · ' + m.author : ''}` : 'Не проверен сегодня';
        if (!canMark() || flown(flyDate)) return st ? `<span class="pm-chip sm-st-${st}" title="${esc(title)}">${text}</span>` : '';
        return `<button type="button" class="pm-chip${st ? ' sm-st-' + st : ''}" data-pm-code="${esc(code)}" data-pm-date="${esc(flyDate)}" title="${esc(title + ' — нажмите, чтобы отметить (или клавиши 1–4 на строке)')}">${text}</button>`;
    }

    // Кнопки отметки (карточка рейса, детализация).
    const SHORT = { keep: 'Без изм.', attn: '! Вним.', down: '▼ Сниж.', up: '▲ Повыш.' };

    // Кнопки отметки за сегодня — компактно, в одну строку (карточка рейса, детализация, окно выбора).
    function buttonsHtml(code, flyDate) {
        if (!canMark() || flown(flyDate)) return '';
        const own = available() && SalesManagement.getOwnMark ? SalesManagement.getOwnMark(code, flyDate, getTodayDate()) : todayMark(code, flyDate);
        const esc = typeof escAttr === 'function' ? escAttr : String;
        const btn = (st, i) => `<button type="button" class="pm-btn sm-st-${st}${own && own.status === st ? ' pm-btn-on' : ''}" data-pm-set="${st}" data-pm-code="${esc(code)}" data-pm-date="${esc(flyDate)}" title="${esc(SalesManagement.STATUSES[st].label)} (клавиша ${i})">${SHORT[st]}</button>`;
        return `<div class="pm-buttons"><span class="pm-buttons-label">Сегодня:</span>${['keep', 'attn', 'down', 'up'].map((st, i) => btn(st, i + 1)).join('')}${own ? `<button type="button" class="pm-btn pm-btn-clear" data-pm-set="" data-pm-code="${esc(code)}" data-pm-date="${esc(flyDate)}" title="Снять свою отметку">✕</button>` : ''}</div>`;
    }

    const KEY_STATUS = { '1': 'keep', '2': 'attn', '3': 'down', '4': 'up' };

    function closePicker() {
        const pop = document.getElementById('pm-pop');
        if (pop) pop.hidden = true;
    }

    function openPicker(anchor) {
        const code = anchor.dataset.pmCode;
        const date = anchor.dataset.pmDate;
        let pop = document.getElementById('pm-pop');
        if (!pop) {
            pop = document.createElement('div');
            pop.id = 'pm-pop';
            pop.className = 'pm-pop';
            document.body.appendChild(pop);
            pop.addEventListener('click', (e) => {
                const b = e.target.closest('[data-pm-set]');
                if (!b) return;
                setToday(b.dataset.pmCode, b.dataset.pmDate, b.dataset.pmSet || null);
                closePicker();
            });
            document.addEventListener('pointerdown', (e) => {
                if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('.pm-chip')) closePicker();
            }, true);
            document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePicker(); });
        }
        pop.innerHTML = `<div class="pm-pop-title">${typeof escHtml === 'function' ? escHtml(code + ' · ' + date) : code}</div>${buttonsHtml(code, date)}`;
        pop.hidden = false;
        const r = anchor.getBoundingClientRect();
        const w = 300;
        pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
        let top = r.bottom + 6;
        const h = pop.offsetHeight || 90;
        if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
        pop.style.top = top + 'px';
    }

    // Делегирование: чипы и кнопки отметки в любом месте страницы.
    document.addEventListener('click', (e) => {
        const set = e.target.closest('[data-pm-set]');
        if (set && !set.closest('#pm-pop')) {
            e.preventDefault();
            e.stopPropagation();
            setToday(set.dataset.pmCode, set.dataset.pmDate, set.dataset.pmSet || null);
            return;
        }
        const chip = e.target.closest('button.pm-chip[data-pm-code]');
        if (chip) {
            e.preventDefault();
            e.stopPropagation();
            openPicker(chip);
        }
    }, true);

    // Клавиши 1–4 на строке с чипом (RMS): отметка без мыши.
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.altKey || e.metaKey) return;
        const st = KEY_STATUS[e.key];
        if (!st) return;
        const t = e.target;
        if (!t || !t.closest || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
        const host = t.closest('[data-pm-row]');
        const chip = host && host.querySelector('button.pm-chip[data-pm-code]');
        if (!chip) return;
        e.preventDefault();
        setToday(chip.dataset.pmCode, chip.dataset.pmDate, st);
    });

    return { winDays, decisions, todayMark, effectFor, judge, effectText, decisionsHtml, chartItems, chipHtml, buttonsHtml, setToday, canMark, GLYPH };
})();
