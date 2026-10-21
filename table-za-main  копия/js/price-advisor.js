// Ценовой советник: какой класс (минимальный открытый тариф) держать на вылете, чтобы выручка была наибольшей.
// Модель — из tools/price-model (отчёт команды RM, REPORT.md):
//   • где цену выбирает RMS: все межрегиональные направления + Богучаны, Мотыгино, Кодинск;
//   • субсидируемый рейс: тариф не выше предельного из «Справочника» → «Тарифы субсидии» (кроме дат коммерции);
//   • лестница цен направления — по проданным билетам: класс (1-я буква кода тарифа) → тариф взрослого (без /CN, /IN, 0 ₽);
//   • спрос в день: λ(p, t) = a(t)·exp(β·(p/p_ref − 1)), a(t) — кривая бронирований рейсов направления по архиву продаж,
//     p_ref — медианный взрослый тариф направления, β — эластичность (СЦЕНАРИЙ: по данным пока не измерена, см. отчёт);
//   • покупатель берёт самый дешёвый открытый класс, поэтому «цена» = «открыт минимальный класс k» (закрыть всё дешевле);
//   • динамическое программирование по дням до вылета t и свободным креслам x:
//       V_t(x) = max_k Σ_n P(N = n | λ(p_k, t)) · [p_k·min(n, x) + V_{t−1}(x − min(n, x))],  V_{−1} ≡ 0
//     нижняя цена места b_t(x) = V_{t−1}(x) − V_{t−1}(x − 1) — дешевле продавать место (например, группе) невыгодно;
//   • совет — в коридоре ±1 класс от нынешнего (пока эластичность не измерена экспериментом), не чаще раза в день.
window.PriceAdvisor = (function () {
    const KRAI_IN_RMS = ['богучаны', 'мотыгино', 'кодинск'];
    const SETTINGS_KEY = 'krasavia_price_advisor';
    const DEFAULTS = { get beta() { return PV.PA_BETA_DEFAULT; }, get corridor() { return PV.PA_CORRIDOR_DEFAULT; } };

    let memo = { sig: '', routes: new Map(), dp: new Map() };

    function settings() {
        try {
            const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {};
            const beta = Number(s.beta);
            // Своё значение — только если пользователь сам выбирал его в отчёте; иначе — значение администратора.
            const corr = Number(s.corridor);
            return { beta: s.beta != null && beta < -0.2 && beta >= -6 ? beta : DEFAULTS.beta, corridor: s.corridor != null && corr >= 0 && corr <= 9 ? corr : DEFAULTS.corridor };
        } catch (e) { return { ...DEFAULTS }; }
    }

    function saveSettings(s) {
        try {
            const own = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {};
            localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...own, ...s }));   // только изменённое поле
        } catch (e) { /* ignore */ }
        memo.dp = new Map();
    }

    function sig() {
        return [typeof dataEpoch === 'number' ? dataEpoch : 0,
            typeof SalesArchive !== 'undefined' && SalesArchive.revision ? SalesArchive.revision() : 0,
            typeof getTodayDate === 'function' ? getTodayDate() : '',
            typeof Params !== 'undefined' ? Params.revision() : 0,
            typeof FareGrid !== 'undefined' ? FareGrid.revision() : 0,
            // Потолок субсидии и коммерческие даты: справочник тарифов и периоды субсидии.
            typeof FareRefs !== 'undefined' && FareRefs.revision ? FareRefs.revision() : 0,
            typeof SubsidyRef !== 'undefined' && SubsidyRef.revision ? SubsidyRef.revision() : 0].join('|');
    }

    function cache() {
        const s = sig();
        if (memo.sig !== s) memo = { sig: s, routes: new Map(), dp: new Map() };
        return memo;
    }

    function base(code) { return typeof getBaseFlight === 'function' ? getBaseFlight(cleanFlight(code)) : cleanFlight(code); }

    function direction(code) {
        return String(typeof getFlightDirection === 'function' ? getFlightDirection(base(code)) || '' : '').replace(/\s+/g, ' ').trim();
    }

    // RMS выбирает цену: межрегиональные + Богучаны, Мотыгино, Кодинск.
    function inScope(code) {
        const type = typeof getFlightRouteType === 'function' ? getFlightRouteType(base(code)) : '';
        if (type === 'interregional') return true;
        const cities = typeof getCitiesFromFlight === 'function' ? getCitiesFromFlight(base(code)) : [];
        return cities.some(c => KRAI_IN_RMS.includes(String(c).toLowerCase().replace(/ё/g, 'е')));
    }

    // Предельный тариф субсидии на вылет или null (рейс коммерческий, дата коммерции, исключение или потолок не задан).
    function capFor(code, date) {
        if (typeof FareRefs === 'undefined' || !FareRefs.match) return null;
        if (typeof FlightChecks !== 'undefined' && FlightChecks.isNeverSubsidized && FlightChecks.isNeverSubsidized(code)) return null;   // KV-247/248
        if (FareRefs.isExcluded && FareRefs.isExcluded(code, date)) return null;
        if (typeof RouteCosts !== 'undefined' && RouteCosts.isCommercialDate && RouteCosts.isCommercialDate(code, date)) return null;
        const e = FareRefs.match(code, date);
        return e && e.adult > 0 ? Number(e.adult) : null;
    }

    function isAdultPaid(s) {
        return FareGrid.isAdultPaid(s);   // общая логика (fare-grid.js)
    }

    function median(a) {
        if (!a.length) return null;
        const s = a.slice().sort((x, y) => x - y);
        const m = s.length >> 1;
        return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    }

    // Направление: лестница классов, опорный тариф, кривая бронирований a(t) (взрослые платные в день на вылет).
    function routeInfo(code) {
        const c = cache();
        const dir = direction(code) || base(code);
        if (c.routes.has(dir)) return c.routes.get(dir);
        const flights = new Set();
        Object.keys(typeof groupedData !== 'undefined' && groupedData ? groupedData : {}).forEach(b => {
            if ((direction(b) || b) === dir) (groupedData[b] || []).forEach(r => flights.add(cleanFlight(r[0])));
        });
        flights.add(cleanFlight(code));
        const byClass = Object.create(null);
        const all = [];
        let tickets = 0;
        let adultPaid = 0;
        Object.keys(typeof salesDetails !== 'undefined' && salesDetails ? salesDetails : {}).forEach(k => {
            const fl = k.slice(k.indexOf('|') + 1);
            if (!flights.has(fl)) return;
            (salesDetails[k] || []).forEach(s => {
                tickets++;
                if (!isAdultPaid(s)) return;
                adultPaid++;
                const f = s.adjustedFare || s.fare;
                const cls = FareGrid.classOf(s) || '?';
                (byClass[cls] || (byClass[cls] = [])).push(f);
                all.push(f);
            });
        });
        const ladder = [];
        Object.keys(byClass).forEach(cls => {
            if (byClass[cls].length < PV.PA_MIN_CLASS_TICKETS) return;
            ladder.push({ cls, price: Math.round(median(byClass[cls])), n: byClass[cls].length });
        });
        ladder.sort((a, b) => a.price - b.price);
        // Сетка тарифов из справочника (лайт/стандарт — цена класса, оптимум не смешивается); иначе — медианы продаж.
        const fg = typeof FareGrid !== 'undefined' ? FareGrid.ladderFor([...flights][0] || code) : [];
        if (fg.length >= 2) { ladder.length = 0; fg.forEach(l => ladder.push({ cls: l.cls, price: l.price, n: 0 })); }
        const uniq = ladder.filter((l, i) => !i || Math.round(l.price / 10) !== Math.round(ladder[i - 1].price / 10));
        // Кривая бронирований по архиву продаж: средние продажи в день t на вылет (по всем вылетам рейсов направления).
        const acc = new Float64Array(PV.PA_HORIZON + 1);
        let deps = 0;
        if (typeof SalesArchive !== 'undefined' && SalesArchive.departuresFor) {
            flights.forEach(fl => {
                SalesArchive.departuresFor(fl).forEach(d => {
                    const cv = SalesArchive.curveFor(d.date, fl);
                    if (!cv || !(cv.total > 0)) return;
                    deps++;
                    const t0 = Math.min(PV.PA_HORIZON, cv.maxDtd);
                    let prev = cv.onHand[t0 + 1] || 0;   // проданное раньше горизонта не относим к его границе
                    for (let t = t0; t >= 0; t--) {
                        const v = cv.onHand[t] != null ? cv.onHand[t] : prev;
                        acc[t] += Math.max(0, v - prev);
                        prev = v;
                    }
                });
            });
        }
        let a = null;
        if (deps >= PV.PA_MIN_DEPS) {
            const share = tickets ? adultPaid / tickets : 1;
            a = new Float64Array(PV.PA_HORIZON + 1);
            for (let t = 0; t <= PV.PA_HORIZON; t++) {
                let s = 0;
                let n = 0;
                for (let j = Math.max(0, t - 3); j <= Math.min(PV.PA_HORIZON, t + 3); j++) { s += acc[j]; n++; }
                a[t] = (s / n / deps) * share;
            }
        }
        const info = { dir, ladder: uniq, pRef: median(all), a, deps, flights };
        c.routes.set(dir, info);
        return info;
    }

    // Кривая бронирований — по архиву за год. Пока он не дочитан, совет считался бы по 2–3 месяцам и потом «прыгал».
    let histReady = false;
    let histLoading = null;
    function ensureHistory() {
        if (histReady) return Promise.resolve(true);
        if (histLoading) return histLoading;
        if (typeof SalesArchive === 'undefined' || !SalesArchive.ensureMonths) { histReady = true; return Promise.resolve(true); }
        const months = [];
        const t = new Date();
        for (let i = 0; i <= 12; i++) { const d = new Date(t.getFullYear(), t.getMonth() - i, 1); months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`); }
        histLoading = SalesArchive.ensureMonths(months).catch(() => null).then(() => {
            histReady = true;
            histLoading = null;
            if (typeof FlightCard !== 'undefined' && FlightCard.refresh) FlightCard.refresh();
            return true;
        });
        return histLoading;
    }

    function betaFor() {
        return settings().beta;
    }

    // Пуассоновские вероятности P(N = n), n = 0..nMax (хвост — в последнюю ячейку).
    function poisson(lam, nMax) {
        const p = new Float64Array(nMax + 1);
        let term = Math.exp(-lam);
        let sum = 0;
        for (let n = 0; n < nMax; n++) { p[n] = term; sum += term; term *= lam / (n + 1); }
        p[nMax] = Math.max(0, 1 - sum);
        return p;
    }

    // DP для направления при C креслах и наборе цен (лестница под потолком). act[t][x] — индекс класса, V[t][x].
    function solve(info, prices, C, scale) {
        const c = cache();
        const beta = betaFor();
        const sc = scale > 0 ? Math.round(scale * 20) / 20 : 1;
        const key = `${info.dir}|${C}|${prices.join(',')}|${beta}|${sc}`;
        if (c.dp.has(key)) return c.dp.get(key);
        const K = prices.length;
        const V = [];
        const act = [];
        let prev = new Float64Array(C + 1);   // V_{t−1}, после вылета 0
        for (let t = 0; t <= PV.PA_HORIZON; t++) {
            const cur = new Float64Array(C + 1);
            const ak = new Uint8Array(C + 1);
            const dists = prices.map(p => {
                const lam = Math.max(0, sc * info.a[t] * Math.exp(beta * (p / info.pRef - 1)));
                const nMax = Math.min(C, Math.ceil(lam + 5 * Math.sqrt(lam) + 3));
                return poisson(lam, nMax);
            });
            for (let x = 1; x <= C; x++) {
                let best = -1;
                let bk = 0;
                for (let k = 0; k < K; k++) {
                    const P = dists[k];
                    let v = 0;
                    for (let n = 0; n < P.length; n++) {
                        const s = Math.min(n, x);
                        v += P[n] * (prices[k] * s + prev[x - s]);
                    }
                    if (v > best + 1e-9) { best = v; bk = k; }
                }
                cur[x] = best;
                ak[x] = bk;
            }
            V.push(cur);
            act.push(ak);
            prev = cur;
        }
        const res = { V, act };
        c.dp.set(key, res);
        if (c.dp.size > 200) c.dp.delete(c.dp.keys().next().value);
        return res;
    }

    // Открытый сейчас класс — по последним продажам вылета: взрослые билеты за последний день продаж в файле
    // (без окна «7 дней» и без «самого дешёвого»: дешёвый билет недельной давности — уже закрытый класс).
    function currentPrice(code, date) {
        const list = typeof getFlightSalesList === 'function' ? getFlightSalesList(date, code) : [];
        const paid = list.filter(isAdultPaid);
        if (!paid.length) return null;
        const t = s => { const d = parseLocalDate(s.dealDate); return d ? d.getTime() : 0; };
        const last = Math.max(...paid.map(t));
        const day = paid.filter(s => t(s) === last);
        const cls = [...new Set(day.map(s => String(s.basicFareStr || '').trim().charAt(0).toUpperCase()).filter(Boolean))];
        const tail = day[day.length - 1];   // в файле продажи идут по времени — последний билет дня
        return { price: tail.adjustedFare || tail.fare, cls: String(tail.basicFareStr || '').trim().charAt(0).toUpperCase(), classes: cls, dealDate: tail.dealDate };
    }

    function nearestIdx(prices, p) {
        let bi = 0;
        prices.forEach((q, i) => { if (Math.abs(q - p) < Math.abs(prices[bi] - p)) bi = i; });
        return bi;
    }

    // Совет по вылету: { cls, price, curCls, curPrice, action: 'up'|'down'|'hold', bid, cap, free, dtd, beta, raw } или null.
    function advise(code, date) {
        code = cleanFlight(code);
        if (!code || !date || !inScope(code)) return null;
        const row = typeof getFlightRowForDate === 'function' ? getFlightRowForDate(base(code), date, code) : null;
        if (!row) return null;
        const C = typeof getSeatsOnSale === 'function' ? getSeatsOnSale(row) : 0;
        const sold = typeof getSoldFromRow === 'function' ? getSoldFromRow(row) : 0;
        const dtd0 = typeof getDaysUntil === 'function' ? getDaysUntil(date) : null;
        if (!(C > 0) || dtd0 == null || dtd0 < 1) return null;
        const dtd = Math.min(PV.PA_HORIZON, Math.max(dtd0, typeof observedFromDtd === 'function' ? observedFromDtd(date) : dtd0));
        if (!histReady) { ensureHistory(); return null; }
        const info0 = routeInfo(code);
        // Уровни тарифов — по официальной сетке на дату вылета (периоды действия), иначе по продажам.
        const offL = typeof FareGrid !== 'undefined' && FareGrid.officialLadder ? FareGrid.officialLadder(direction(code) || base(code), date) : null;
        const info = offL && offL.ladder.length >= 2 ? Object.assign({}, info0, { ladder: offL.ladder }) : info0;
        if (!info.a || !info.pRef || info.ladder.length < 2) return null;
        const cap = capFor(code, date);
        // Нынешний класс — по полной лестнице (до потолка): класс выше потолка — нарушение, а не «ближайший под потолком».
        const cp = currentPrice(code, date);
        let curFull = null;
        if (cp) {
            const idx = cp.classes.map(c => info.ladder.findIndex(l => l.cls === c)).filter(i => i >= 0);
            curFull = idx.length ? info.ladder[Math.max(...idx)] : info.ladder[nearestIdx(info.ladder.map(l => l.price), cp.price)];
        }
        const overCap = cap != null && curFull && curFull.price > cap + 0.5;
        const ladder = info.ladder.filter(l => cap == null || l.price <= cap + 0.5);
        if (!ladder.length) {
            return { code, date, dtd, dtdNow: dtd0, cap, action: 'nocap', free: Math.max(0, C - sold), curCls: curFull ? curFull.cls : null,
                text: `ни один класс не укладывается в потолок субсидии ${rub(cap)}` };
        }
        const prices = ladder.map(l => l.price);
        const free = Math.max(0, C - sold);
        if (free === 0) return { code, date, free: 0, dtd, dtdNow: dtd0, cap, action: 'closed', text: 'распродан — продажи закрыты' };
        const cc = Math.min(C, 150);
        // Спрос этого вылета, а не среднего по направлению: кривую бронирований масштабируем так, чтобы при нынешней
        // цене до вылета продалось столько, сколько даёт прогноз загрузки (тот же, что в карточке). Иначе рейс,
        // который идёт лучше нормы, модель считала бы «средним» и советовала снижать.
        const fc = typeof FlightInsights !== 'undefined' ? FlightInsights.forecast(code, date) : null;
        const fcOk = fc && fc.source !== 'flown' && fc.final != null;
        let scale = 1;
        if (fcOk) {
            const pNow = curFull && !overCap ? curFull.price : prices[0];
            let base0 = 0;
            const betaNow = betaFor();
            for (let t = 1; t <= dtd; t++) base0 += info.a[t] * Math.exp(betaNow * (pNow / info.pRef - 1));
            // Прогноз не больше кресел: если он упёрся в кресла — спрос не меньше, берём верх интервала.
            const want = Math.max(0, (fc.final >= C && fc.hiRaw != null ? Math.max(fc.final, fc.hiRaw) : fc.final) - sold);
            if (base0 > 0.2) scale = Math.max(0.25, Math.min(4, want / base0));
        }
        const { V, act } = solve(info, prices, cc, scale);
        const x = Math.min(free, cc);
        const kRaw = act[dtd][x];
        // Открытый класс — по букве проданного билета, а не по ближайшей цене (иначе Q путается с G).
        // Если в последний день продано несколько классов — открыт самый дорогой из них (дешёвые закрывали в течение дня).
        // Открыт класс выше потолка — считаем «выше всех допустимых»: совет будет «снизить».
        let kCur = null;
        if (curFull && !overCap) kCur = ladder.findIndex(l => l.cls === curFull.cls);
        if (kCur != null && kCur < 0) kCur = nearestIdx(prices, curFull.price);
        const corr = settings().corridor;
        let k = kRaw;
        if (kCur != null && corr < 9) k = Math.max(kCur - corr, Math.min(kCur + corr, kRaw));
        if (overCap) k = kRaw;   // выше потолка нельзя — сразу в допустимое
        // Цель продаж: последний билет — ближе к вылету, а не за месяц. Если по прогнозу (тот же, что в карточке)
        // при нынешней цене рейс распродастся раньше чем за PV.PA_PACE_DAYS дн. до вылета — поднимаем хотя бы на класс.
        let early = null;
        if (fc && fc.soldOutDtd != null && fc.soldOutDtd >= PV.PA_PACE_DAYS && free > 0 && kCur != null && kCur < prices.length - 1 && k <= kCur) {
            k = kCur + 1;
            early = fc.soldOutDtd;
        }
        // Согласованность с прогнозом (как у подсказок решений): прогноз к вылету высокий — не снижать, низкий — не повышать.
        let guard = null;
        if (fcOk && kCur != null && !overCap) {
            if (k < kCur && fc.lf >= PV.ADVICE_FC_HIGH) { k = kCur; guard = `прогноз к вылету ${fc.lf}% — снижать не нужно`; }
            else if (k < kCur) {
                // Продажи идут не хуже нормы и плана (файла ожидаемой загрузки) на этот день — снижать незачем.
                const nm = typeof SalesAdvice !== 'undefined' ? SalesAdvice.norms(code, date) : null;
                const gaps = nm ? [nm.ref, nm.exp].filter(v => v != null).map(v => nm.sold - v) : [];
                if (gaps.length && gaps.every(d => d >= 0)) { k = kCur; guard = 'продажи не отстают от нормы и плана — снижать не нужно'; }
            }
            else if (k > kCur && early == null && fc.lf < PV.ADVICE_FC_LOW) { k = kCur; guard = `прогноз к вылету ${fc.lf}% — повышать рано`; }
        }
        const bid = dtd >= 1 ? Math.max(0, Math.round(V[dtd - 1][x] - V[dtd - 1][x - 1])) : 0;
        const action = overCap ? 'down' : (kCur == null ? 'set' : (k > kCur ? 'up' : (k < kCur ? 'down' : 'hold')));
        return {
            code, date, dtd, dtdNow: dtd0, free, cap, bid, beta: betaFor(), action, overCap, guard, scale: Math.round(scale * 100) / 100,
            early, cls: ladder[k].cls, price: prices[k], curCls: curFull ? curFull.cls : null, curDeal: cp ? cp.dealDate : null, curPrice: curFull ? curFull.price : null,
            raw: { cls: ladder[kRaw].cls, price: prices[kRaw] }, ladder, route: info.dir, deps: info.deps
        };
    }

    function rub(v) { return v == null ? '—' : Math.round(v).toLocaleString('ru-RU') + ' ₽'; }

    // Одна строка для карточки и таблиц.
    function text(a) {
        if (!a) return '';
        if (a.action === 'closed' || a.action === 'nocap') return a.text;
        const capNote = a.cap != null ? ` · потолок субсидии ${rub(a.cap)}` : '';
        const what = a.action === 'hold' ? `держать класс ${a.cls} (${rub(a.price)})`
            : a.action === 'up' ? `поднять: открыть ${a.cls} (${rub(a.price)}), закрыть дешевле`
                : a.action === 'down' ? `снизить: открыть ${a.cls} (${rub(a.price)})`
                    : `открыть ${a.cls} (${rub(a.price)}), закрыть дешевле`;
        const guardNote = a.guard ? ` · ${a.guard}` : '';
        const why = a.early != null ? ` · при нынешней цене распродастся за ${a.early} дн. до вылета — рано` : '';
        const now = a.curCls ? `сейчас продаётся ${a.curCls}${a.curDeal ? ` (продажи ${a.curDeal})` : ''}${a.overCap ? ' — выше потолка субсидии' : ''}; ` : '';
        // Совет ограничен коридором — сказать, куда звала модель (иначе «нижняя цена места» выше совета выглядит противоречием).
        const clamp = a.raw && a.raw.price !== a.price && !a.overCap && !a.guard && a.early == null ? ` · модель: ${a.raw.cls} (${rub(a.raw.price)}), ограничено шагом от нынешнего класса` : '';
        // Нижняя цена места: сколько стоит одно свободное место для выручки рейса (дешевле его продавать невыгодно).
        // Почти ноль — мест с запасом: лишнее место всё равно, скорее всего, улетит пустым.
        const low = a.ladder && a.ladder.length ? Math.min(...a.ladder.map(l => l.price)) : 0;
        const bidTxt = low && a.bid < low * 0.1 ? 'мест с запасом' : `нижняя цена места ${rub(a.bid)}`;
        return `${now}${what}${guardNote}${why}${clamp} · ${bidTxt}${capNote}`;
    }

    // Включается в «Настройки» → «Параметры расчётов» → «Подсказки по тарифам» → «Ценовой советник».
    function canView() {
        if (PV.HINT_PRICE !== 1) return false;
        // Включается в «Профилях» правом «Ценовой советник» (у администратора — всегда).
        return typeof ProfileAuth === 'undefined' || !!(ProfileAuth.getCurrentProfile() || {}).isAdmin || ProfileAuth.hasPermission('price_advisor');
    }

    // Все вылеты в окне (для отчёта): [{advice}], в фоне порциями.
    async function scanAll(days) {
        await ensureHistory();
        const out = [];
        const seen = new Set();
        const rows = [];
        Object.keys(typeof groupedData !== 'undefined' && groupedData ? groupedData : {}).forEach(b => (groupedData[b] || []).forEach(r => {
            const code = cleanFlight(r[0]);
            const d = typeof getDaysUntil === 'function' ? getDaysUntil(r[1]) : null;
            const k = code + '|' + r[1];
            if (seen.has(k) || d == null || d < 1 || d > days) return;
            seen.add(k);
            rows.push([code, r[1]]);
        }));
        let last = Date.now();
        for (const [code, date] of rows) {
            const a = advise(code, date);
            if (a) out.push(a);
            if (Date.now() - last > 30) { await new Promise(r => setTimeout(r, 0)); last = Date.now(); }
        }
        out.sort((x, y) => (x.dtd - y.dtd) || String(x.code).localeCompare(String(y.code)));
        return out;
    }

    // ---------- отчёт «Ценовой советник» («Отчёты» → «Прогноз и предупреждения») ----------
    let report = { sig: '', list: null, busy: false };
    let onlyChange = true;

    function esc(v) { return typeof escHtml === 'function' ? escHtml(v) : String(v == null ? '' : v); }

    function reportSig() { return sig() + '|' + JSON.stringify(settings()); }

    function reportHtml(rerender) {
        if (!canView()) return '';
        const s = settings();
        if (report.sig !== reportSig() || !report.list) {
            if (!report.busy) {
                report.busy = true;
                const want = reportSig();
                scanAll(PV.PA_REPORT_DAYS).then(list => { report = { sig: want, list, busy: false }; if (rerender) rerender(); })
                    .catch(e => { report.busy = false; console.warn('PriceAdvisor', e); });
            }
            if (!report.list) return `<section class="rp-card"><div class="rp-card-head"><h3 class="rp-card-title">Ценовой советник</h3></div><p class="rp-note">Считаю оптимальные классы по вылетам на ${PV.PA_REPORT_DAYS} дн.…</p></section>`;
        }
        const list = report.list;
        const shown = onlyChange ? list.filter(a => a.action === 'up' || a.action === 'down') : list;
        const cnt = { up: 0, down: 0, hold: 0, set: 0, closed: 0, nocap: 0 };
        list.forEach(a => { if (cnt[a.action] != null) cnt[a.action]++; });
        const act = (a) => (a.action === 'up' ? '<span class="fl-warn fl-warn-over">поднять</span>' : a.action === 'down' ? '<span class="fl-warn fl-warn-under">снизить</span>'
            : a.action === 'closed' ? 'распродан' : a.action === 'nocap' ? 'нет класса под потолок' : (a.action === 'set' ? 'открыть' : 'держать'));
        const rows = shown.slice(0, 80).map(a => `<tr>
            <td class="rp-left"><strong>${esc(a.code)}</strong> <span class="rp-muted">${esc(a.route || '')}</span></td>
            <td>${esc(a.date)}<div class="rp-muted">через ${a.dtdNow != null ? a.dtdNow : a.dtd} дн.</div></td>
            <td>${a.free}</td>
            <td>${a.curPrice != null ? `${esc(a.curCls || '')} ${rub(a.curPrice)}` : '—'}</td>
            <td>${act(a)}${a.early != null ? `<div class="rp-muted">иначе распродан за ${a.early} дн.</div>` : ''}</td>
            <td><strong>${esc(a.cls || '')}</strong> ${rub(a.price)}${a.raw && a.raw.price !== a.price ? `<div class="rp-muted" title="Без ограничения коридором">модель: ${esc(a.raw.cls)} ${rub(a.raw.price)}</div>` : ''}</td>
            <td>${rub(a.bid)}</td>
            <td>${a.cap != null ? rub(a.cap) : '—'}</td></tr>`).join('');
        return `<section class="rp-card">
            <div class="rp-card-head"><h3 class="rp-card-title">Ценовой советник</h3></div>
            <p class="rp-card-text">Какой минимальный класс держать открытым, чтобы выручка вылета была наибольшей (всё дешевле — закрыть). Считаем межрегиональные рейсы и Богучаны, Мотыгино, Кодинск. На субсидируемых рейсах — не выше предельного тарифа из «Справочника». Нижняя цена места: дешевле продавать место (и группе) невыгодно.
                Эластичность спроса пока не измерена, поэтому используется сценарий. Совет — не дальше выбранного числа классов от нынешнего.</p>
            <div class="fl-warn-cfg">
                <label>Эластичность <select id="pa-beta">${[...new Set([-1, -1.5, -2, -3, s.beta])].sort((x, y) => y - x).map(b => `<option value="${b}"${s.beta === b ? ' selected' : ''}>${String(b).replace('.', ',')}${b === DEFAULTS.beta ? ' (по умолчанию)' : ''}</option>`).join('')}</select></label>
                <label>Шаг от нынешнего класса <select id="pa-corr">${[[0, 'не менять класс'], [1, '±1 класс'], [2, '±2 класса'], ...(s.corridor > 2 && s.corridor < 9 ? [[s.corridor, `±${s.corridor} класса`]] : []), [9, 'без ограничения']].map(([v, l]) => `<option value="${v}"${s.corridor === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
                <label><input type="checkbox" id="pa-only"${onlyChange ? ' checked' : ''}> только где менять</label>
                ${typeof ProfileAuth === 'undefined' || ProfileAuth.hasPermission('export_excel') || (ProfileAuth.getCurrentProfile() || {}).isAdmin ? `<button type="button" class="btn-primary rp-btn" id="pa-xlsx"${list.length ? '' : ' disabled'}>В Excel</button>` : ''}
            </div>
            <div class="dr-kpis">
                <div class="dr-kpi"><div class="dr-kpi-label">Поднять</div><div class="dr-kpi-value">${cnt.up}</div></div>
                <div class="dr-kpi"><div class="dr-kpi-label">Снизить</div><div class="dr-kpi-value">${cnt.down}</div></div>
                <div class="dr-kpi"><div class="dr-kpi-label">Держать</div><div class="dr-kpi-value">${cnt.hold}</div></div>
                <div class="dr-kpi"><div class="dr-kpi-label">Открыть (продаж ещё нет)</div><div class="dr-kpi-value">${cnt.set}</div></div>
                <div class="dr-kpi"><div class="dr-kpi-label">Распродан / нет класса</div><div class="dr-kpi-value">${cnt.closed + cnt.nocap}</div><div class="dr-kpi-sub">всего ${list.length} вылетов на ${PV.PA_REPORT_DAYS} дн.</div></div>
            </div>
            ${rows ? `<div class="rp-scroll"><table class="rp-table"><thead><tr><th>Рейс</th><th>Вылет</th><th>Свободно</th><th>Сейчас от</th><th>Совет</th><th>Класс · цена</th><th>Нижняя цена места</th><th>Потолок</th></tr></thead><tbody>${rows}</tbody></table></div>
                ${shown.length > 80 ? `<p class="rp-note">Показаны 80 ближайших из ${shown.length} — полный список в Excel.</p>` : ''}` : '<p class="rp-note">Менять сейчас нечего.</p>'}
        </section>`;
    }

    async function exportReport() {
        const list = report.list || await scanAll(PV.PA_REPORT_DAYS);
        const lib = typeof loadStyledXlsx === 'function' ? await loadStyledXlsx() : (typeof XLSX !== 'undefined' ? XLSX : null);
        if (!lib) { if (typeof showToast === 'function') showToast('Библиотека Excel не загружена', 'error'); return; }
        const head = ['Рейс', 'Направление', 'Дата вылета', 'Дней до вылета', 'Свободно', 'Сейчас класс', 'Сейчас цена', 'Совет', 'Класс', 'Цена', 'Модель без коридора: класс', 'Модель: цена', 'Нижняя цена места', 'Потолок субсидии', 'Эластичность (сценарий)'];
        const lab = { up: 'поднять', down: 'снизить', hold: 'держать', set: 'открыть', closed: 'распродан', nocap: 'нет класса под потолок' };
        const rows = list.map(a => [a.code, a.route || '', a.date, a.dtdNow != null ? a.dtdNow : a.dtd, a.free, a.curCls || '', a.curPrice != null ? Math.round(a.curPrice) : '', lab[a.action] || '', a.cls || '', a.price != null ? Math.round(a.price) : '',
            a.raw ? a.raw.cls : '', a.raw ? Math.round(a.raw.price) : '', a.bid != null ? a.bid : '', a.cap != null ? Math.round(a.cap) : '', a.beta != null ? a.beta : '']);
        const wb = lib.utils.book_new();
        const ws = lib.utils.aoa_to_sheet([head].concat(rows));
        ws['!cols'] = head.map((h, i) => ({ wch: i === 1 ? 30 : 14 }));
        lib.utils.book_append_sheet(wb, ws, 'Ценовой советник');
        const day = typeof getTodayDate === 'function' ? getTodayDate() : '';
        const name = typeof excelDailyFilename === 'function' ? excelDailyFilename('КРАСАВИА_ценовой_советник', day) : `КРАСАВИА_ценовой_советник_${day}.xlsx`;
        const saved = typeof excelSaveWorkbook === 'function' ? await excelSaveWorkbook(lib, wb, name, null) : (lib.writeFile(wb, name), null);
        if (saved && typeof excelAnnounceSaved === 'function') excelAnnounceSaved(saved, 'Ценовой советник выгружен');
        else if (typeof showToast === 'function') showToast('Ценовой советник выгружен');
    }

    function handleClick(el) {
        if (el.id === 'pa-xlsx') { exportReport().catch(e => console.warn(e)); return true; }
        return false;
    }

    function handleChange(el, rerender) {
        if (el.id === 'pa-only') { onlyChange = !!el.checked; rerender(); return true; }
        if (el.id === 'pa-beta') { saveSettings({ beta: Number(el.value) }); report.list = null; rerender(); return true; }
        if (el.id === 'pa-corr') { saveSettings({ corridor: Number(el.value) }); report.list = null; rerender(); return true; }
        return false;
    }

    return { currentPrice, advise, text, settings, canView, rub, reportHtml, handleClick, handleChange };
})();
