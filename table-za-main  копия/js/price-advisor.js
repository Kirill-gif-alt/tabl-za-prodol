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
            return { beta: beta < -0.2 && beta >= -6 ? beta : DEFAULTS.beta, corridor: [0, 1, 2, 9].includes(Number(s.corridor)) ? Number(s.corridor) : DEFAULTS.corridor };
        } catch (e) { return { ...DEFAULTS }; }
    }

    function saveSettings(s) {
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings(), ...s })); } catch (e) { /* ignore */ }
        memo.dp = new Map();
    }

    function sig() {
        return [typeof dataEpoch === 'number' ? dataEpoch : 0,
            typeof SalesArchive !== 'undefined' && SalesArchive.revision ? SalesArchive.revision() : 0,
            typeof getTodayDate === 'function' ? getTodayDate() : '',
            typeof Params !== 'undefined' ? Params.revision() : 0,
            typeof FareGrid !== 'undefined' ? FareGrid.revision() : 0].join('|');
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
        if (FareRefs.isExcluded && FareRefs.isExcluded(code, date)) return null;
        if (typeof RouteCosts !== 'undefined' && RouteCosts.isCommercialDate && RouteCosts.isCommercialDate(code, date)) return null;
        const e = FareRefs.match(code, date);
        return e && e.adult > 0 ? Number(e.adult) : null;
    }

    function isAdultPaid(s) {
        const f = s.adjustedFare || s.fare || 0;
        const b = String(s.basicFareStr || '').toUpperCase();
        return f > 0 && !/\/(CN|IN|ID|WO|DA)\d*/.test(b) && !/IDB$/.test(b);
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
                const cls = String(s.basicFareStr || '?').trim().charAt(0).toUpperCase() || '?';
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
                    let prev = 0;
                    for (let t = Math.min(PV.PA_HORIZON, cv.maxDtd); t >= 0; t--) {
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
    function solve(info, prices, C) {
        const c = cache();
        const beta = betaFor();
        const key = `${info.dir}|${C}|${prices.join(',')}|${beta}`;
        if (c.dp.has(key)) return c.dp.get(key);
        const K = prices.length;
        const V = [];
        const act = [];
        let prev = new Float64Array(C + 1);   // V_{t−1}, после вылета 0
        for (let t = 0; t <= PV.PA_HORIZON; t++) {
            const cur = new Float64Array(C + 1);
            const ak = new Uint8Array(C + 1);
            const dists = prices.map(p => {
                const lam = Math.max(0, info.a[t] * Math.exp(beta * (p / info.pRef - 1)));
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

    // Нынешний минимальный класс: самый дешёвый взрослый тариф, проданный на этом вылете за последние 7 дней продаж.
    function currentPrice(code, date) {
        const list = typeof getFlightSalesList === 'function' ? getFlightSalesList(date, code) : [];
        const fly = parseLocalDate(date);
        if (!fly || !list.length) return null;
        const cutoff = typeof salesDataCutoffTime === 'function' ? salesDataCutoffTime() : Date.now();
        const recent = list.filter(s => isAdultPaid(s) && (() => { const d = parseLocalDate(s.dealDate); return d && cutoff - d.getTime() <= 7 * 86400000; })());
        const use = recent.length ? recent : list.filter(isAdultPaid);
        if (!use.length) return null;
        const min = use.reduce((m, s) => ((s.adjustedFare || s.fare) < (m.adjustedFare || m.fare) ? s : m));
        return { price: min.adjustedFare || min.fare, cls: String(min.basicFareStr || '').trim().charAt(0).toUpperCase() };
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
        const info = routeInfo(code);
        if (!info.a || !info.pRef || info.ladder.length < 2) return null;
        const cap = capFor(code, date);
        let ladder = info.ladder.filter(l => cap == null || l.price <= cap + 0.5);
        if (!ladder.length) ladder = [{ cls: '—', price: cap }];
        const prices = ladder.map(l => l.price);
        const free = Math.max(0, C - sold);
        if (free === 0) return { code, date, free: 0, dtd, cap, action: 'closed', text: 'распродан — продажи закрыты' };
        const cc = Math.min(C, 150);
        const { V, act } = solve(info, prices, cc);
        const x = Math.min(free, cc);
        const kRaw = act[dtd][x];
        const cp = currentPrice(code, date);
        // Открытый класс — по букве проданного билета, а не по ближайшей цене (иначе Q путается с G).
        let kCur = cp ? ladder.findIndex(l => l.cls === cp.cls) : null;
        if (cp && kCur < 0) kCur = nearestIdx(prices, cp.price);
        const corr = settings().corridor;
        let k = kRaw;
        if (kCur != null && corr < 9) k = Math.max(kCur - corr, Math.min(kCur + corr, kRaw));
        // Цель продаж: последний билет — ближе к вылету, а не за месяц. Если по прогнозу (тот же, что в карточке)
        // при нынешней цене рейс распродастся раньше чем за PV.PA_PACE_DAYS дн. до вылета — поднимаем хотя бы на класс.
        let early = null;
        const fc = typeof FlightInsights !== 'undefined' ? FlightInsights.forecast(code, date) : null;
        if (fc && fc.soldOutDtd != null && fc.soldOutDtd >= PV.PA_PACE_DAYS && free > 0 && kCur != null && kCur < prices.length - 1 && k <= kCur) {
            k = kCur + 1;
            early = fc.soldOutDtd;
        }
        const bid = dtd >= 1 ? Math.max(0, Math.round(V[dtd - 1][x] - V[dtd - 1][x - 1])) : 0;
        const action = kCur == null ? 'set' : (k > kCur ? 'up' : (k < kCur ? 'down' : 'hold'));
        return {
            code, date, dtd, free, cap, bid, beta: betaFor(), action,
            early, cls: ladder[k].cls, price: prices[k], curCls: kCur != null ? ladder[kCur].cls : null, curPrice: cp ? cp.price : null,
            raw: { cls: ladder[kRaw].cls, price: prices[kRaw] }, ladder, route: info.dir, deps: info.deps
        };
    }

    function rub(v) { return v == null ? '—' : Math.round(v).toLocaleString('ru-RU') + ' ₽'; }

    // Одна строка для карточки и таблиц.
    function text(a) {
        if (!a) return '';
        if (a.action === 'closed') return a.text;
        const capNote = a.cap != null ? ` · потолок субсидии ${rub(a.cap)}` : '';
        const what = a.action === 'hold' ? `держать класс ${a.cls} (${rub(a.price)})`
            : a.action === 'up' ? `поднять: открыть ${a.cls} (${rub(a.price)}), закрыть дешевле`
                : a.action === 'down' ? `снизить: открыть ${a.cls} (${rub(a.price)})`
                    : `открыть ${a.cls} (${rub(a.price)}), закрыть дешевле`;
        const why = a.early != null ? ` · при нынешней цене распродастся за ${a.early} дн. до вылета — рано` : '';
        return `${what}${why} · нижняя цена места ${rub(a.bid)}${capNote}`;
    }

    function canView() {
        // Включается в «Профилях» правом «Ценовой советник» (у администратора — всегда).
        return typeof ProfileAuth === 'undefined' || !!(ProfileAuth.getCurrentProfile() || {}).isAdmin || ProfileAuth.hasPermission('price_advisor');
    }

    // Все вылеты в окне (для отчёта): [{advice}], в фоне порциями.
    async function scanAll(days) {
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
        const cnt = { up: 0, down: 0, hold: 0 };
        list.forEach(a => { if (cnt[a.action] != null) cnt[a.action]++; });
        const act = (a) => (a.action === 'up' ? '<span class="fl-warn fl-warn-over">поднять</span>' : a.action === 'down' ? '<span class="fl-warn fl-warn-under">снизить</span>'
            : a.action === 'closed' ? 'распродан' : (a.action === 'set' ? 'открыть' : 'держать'));
        const rows = shown.slice(0, 80).map(a => `<tr>
            <td class="rp-left"><strong>${esc(a.code)}</strong> <span class="rp-muted">${esc(a.route || '')}</span></td>
            <td>${esc(a.date)}<div class="rp-muted">через ${a.dtd} дн.</div></td>
            <td>${a.free}</td>
            <td>${a.curPrice != null ? `${esc(a.curCls || '')} ${rub(a.curPrice)}` : '—'}</td>
            <td>${act(a)}${a.early != null ? `<div class="rp-muted">иначе распродан за ${a.early} дн.</div>` : ''}</td>
            <td><strong>${esc(a.cls || '')}</strong> ${rub(a.price)}${a.raw && a.raw.price !== a.price ? `<div class="rp-muted" title="Без ограничения коридором">модель: ${esc(a.raw.cls)} ${rub(a.raw.price)}</div>` : ''}</td>
            <td>${rub(a.bid)}</td>
            <td>${a.cap != null ? rub(a.cap) : '—'}</td></tr>`).join('');
        return `<section class="rp-card">
            <div class="rp-card-head"><h3 class="rp-card-title">Ценовой советник</h3></div>
            <p class="rp-card-text">Какой минимальный класс держать открытым, чтобы выручка вылета была наибольшей (всё дешевле — закрыть). Межрегиональные рейсы и Богучаны, Мотыгино, Кодинск; на субсидируемых — не выше предельного тарифа из «Справочника». Нижняя цена места — дешевле продавать место (и группе) невыгодно.
                Эластичность спроса по данным пока не измерена — используется сценарий; совет — не дальше выбранного числа классов от нынешнего.</p>
            <div class="fl-warn-cfg">
                <label>Эластичность <select id="pa-beta">${[-1, -1.5, -2, -3].map(b => `<option value="${b}"${s.beta === b ? ' selected' : ''}>${String(b).replace('.', ',')}${b === -1.5 ? ' (по умолчанию)' : ''}</option>`).join('')}</select></label>
                <label>Шаг от нынешнего класса <select id="pa-corr">${[[1, '±1 класс'], [2, '±2 класса'], [9, 'без ограничения']].map(([v, l]) => `<option value="${v}"${s.corridor === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
                <label><input type="checkbox" id="pa-only"${onlyChange ? ' checked' : ''}> только где менять</label>
                ${typeof ProfileAuth === 'undefined' || ProfileAuth.hasPermission('export_excel') || (ProfileAuth.getCurrentProfile() || {}).isAdmin ? `<button type="button" class="btn-primary rp-btn" id="pa-xlsx"${list.length ? '' : ' disabled'}>В Excel</button>` : ''}
            </div>
            <div class="dr-kpis">
                <div class="dr-kpi"><div class="dr-kpi-label">Поднять</div><div class="dr-kpi-value">${cnt.up}</div></div>
                <div class="dr-kpi"><div class="dr-kpi-label">Снизить</div><div class="dr-kpi-value">${cnt.down}</div></div>
                <div class="dr-kpi"><div class="dr-kpi-label">Держать</div><div class="dr-kpi-value">${cnt.hold}</div><div class="dr-kpi-sub">из ${list.length} вылетов на ${PV.PA_REPORT_DAYS} дн.</div></div>
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
        const lab = { up: 'поднять', down: 'снизить', hold: 'держать', set: 'открыть', closed: 'распродан' };
        const rows = list.map(a => [a.code, a.route || '', a.date, a.dtd, a.free, a.curCls || '', a.curPrice != null ? Math.round(a.curPrice) : '', lab[a.action] || '', a.cls || '', a.price != null ? Math.round(a.price) : '',
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

    function handleClick(el, rerender) {
        if (el.id === 'pa-xlsx') { exportReport().catch(e => console.warn(e)); return true; }
        return false;
    }

    function handleChange(el, rerender) {
        if (el.id === 'pa-only') { onlyChange = !!el.checked; rerender(); return true; }
        if (el.id === 'pa-beta') { saveSettings({ beta: Number(el.value) }); report.list = null; rerender(); return true; }
        if (el.id === 'pa-corr') { saveSettings({ corridor: Number(el.value) }); report.list = null; rerender(); return true; }
        return false;
    }

    return { advise, text, inScope, capFor, routeInfo, settings, saveSettings, scanAll, canView, rub, get T() { return PV.PA_HORIZON; }, reportHtml, handleClick, handleChange };
})();
