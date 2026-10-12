// Прогноз загрузки, который учится (пока только для администратора).
// 1. Журнал прогнозов — shared/forecast-log/ГГГГ-ММ.json (по месяцу вылета). Раз в день у администратора
//    по каждому будущему вылету записывается, что было известно за 30/21/14/10/7/5/3/1 день до вылета:
//    продано (o), кресла (s), итог по файлу ожидаемой загрузки (p) и его значение на этот день (q),
//    прогноз по истории (y), прогноз модели (m) и признаки соседних вылетов (x). После вылета — факт (f).
//    Улетевшие вылеты из текущих данных восстанавливаются задним числом (b: 1) — журнал не пустой с первого дня.
// 2. Отчёт «Точность прогноза» («Отчёты»): ошибка каждого способа по горизонтам, по неделям и направлениям,
//    и что больше всего влияет на прогноз.
// 3. Модель предсказывает, сколько ещё доберёт вылет (в долях кресел). Учитывает:
//    • продажи на сейчас и темп за последние 7 дней;
//    • файл ожидаемой загрузки и прогноз по тем же дням недели;
//    • соседние вылеты: этот рейс в соседние даты (±3 дня, любой день недели), добор всех вылетов рейса
//      за 4 недели, обратный рейс в тот же день;
//    • календарь: день недели, выходной/будний, праздник, канун и после праздника, каникулы, свои события, сезон;
//    • тип рейса и вместимость ВС; поправку по рейсу.
//    Две модели — линейная (гребневая регрессия) и решающие деревья (градиентный бустинг) — и их среднее.
//    Проверка честная: для каждой недели модели обучены только на более ранних неделях. На каждом горизонте
//    берётся способ, который ошибался меньше всех.
window.ForecastLab = (function () {
    const HORIZONS = [30, 21, 14, 10, 7, 5, 3, 1];
    const GROUPS = [{ id: 'near', label: '1–3 дня', hs: [1, 3] }, { id: 'mid', label: '5–10 дней', hs: [5, 7, 10] }, { id: 'far', label: '14–30 дней', hs: [14, 21, 30] }];
    const MIN_TRAIN = 150;          // записей с фактом, чтобы модель включилась
    const MIN_TRAIN_H = 80;         // записей на одном горизонте для своей линейной модели
    const MIN_CHOICE = 30;          // записей, чтобы способ мог считаться «лучшим»
    const LAMBDA = 0.8;             // гребневая регуляризация
    const ROUTE_K = 10;             // сглаживание поправки по рейсу: n / (n + K)
    const GBM = { rounds: 120, depth: 3, rate: 0.08, minLeaf: 12, bins: 16 };
    const NB_DAYS = 3;              // соседние даты: ±3 дня
    const PICK_DAYS = 28;           // добор вылетов рейса за 4 недели
    const MONTHS_BACK = 6;
    const DONE_KEY = 'krasavia_fclog_done';
    const DAY = 86400000;

    let log = Object.create(null);  // 'дд.мм.гггг|KV-101' → { b: base, s, f, h: { '7': { d, o, p, q, y, n, m, b, s, x } } }
    const loadedMonths = new Set();
    let loading = null;
    let loaded = false;
    let models = null;              // обученные на всём журнале (для карточки)
    let modelsBusy = false;
    let evalState = { rev: -1, ev: null, busy: false };
    let rev = 0;
    let lastCapture = null;

    // ---------- общее ----------

    function isAdmin() {
        const p = typeof ProfileAuth !== 'undefined' && ProfileAuth.getCurrentProfile ? ProfileAuth.getCurrentProfile() : null;
        return !!(p && p.isAdmin);
    }

    function canView() {
        return isAdmin();
    }

    function esc(v) {
        return typeof escHtml === 'function' ? escHtml(v) : String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function pad(n) { return String(n).padStart(2, '0'); }

    function monthOf(dateStr) {
        const d = parseLocalDate(dateStr);
        return d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}` : '';
    }

    function shiftMonth(month, delta) {
        const [y, m] = month.split('-').map(Number);
        const d = new Date(y, m - 1 + delta, 1);
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    }

    function fileOf(month) {
        return `forecast-log/${month}.json`;
    }

    function today() {
        return typeof getTodayDate === 'function' ? getTodayDate() : formatDateRu(new Date());
    }

    function todayTs() {
        return parseLocalDate(today()).getTime();
    }

    function fmtDate(ts) {
        const d = new Date(ts);
        return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
    }

    function groupOf(h) {
        return GROUPS.find(g => g.hs.includes(Number(h))) || GROUPS[GROUPS.length - 1];
    }

    function num(v) {
        return v == null || v === '' || !isFinite(v) ? null : Math.round(Number(v));
    }

    const pause = () => new Promise(r => setTimeout(r, 0));

    // ---------- журнал: формат и слияние ----------

    function normX(x) {
        if (!Array.isArray(x) || x.length < 5) return null;
        return x.slice(0, 5).map(v => (isFinite(v) ? Math.round(Number(v) * 1000) / 1000 : 0));
    }

    function normEntry(e) {
        if (!e || typeof e !== 'object' || !e.h || typeof e.h !== 'object') return null;
        const out = { b: String(e.b || ''), s: num(e.s) || 0, f: num(e.f), h: {} };
        Object.keys(e.h).forEach(h => {
            if (!HORIZONS.includes(Number(h))) return;
            const r = e.h[h];
            if (!r || typeof r !== 'object' || num(r.o) == null) return;
            out.h[h] = { d: num(r.d), o: num(r.o), p: num(r.p), q: num(r.q), y: num(r.y), n: num(r.n), m: num(r.m), b: r.b ? 1 : 0, s: num(r.s), x: normX(r.x) };
        });
        return out;
    }

    // Живые записи важнее восстановленных; восстановленная с признаками важнее старой без них.
    function mergeEntry(target, key, e) {
        const cur = target[key];
        if (!cur) { target[key] = e; return true; }
        let changed = false;
        if (e.f != null && cur.f !== e.f) { cur.f = e.f; changed = true; }
        if (e.s && !cur.s) { cur.s = e.s; changed = true; }
        if (e.b && !cur.b) { cur.b = e.b; changed = true; }
        Object.keys(e.h).forEach(h => {
            const a = cur.h[h];
            const b = e.h[h];
            if (!a || (a.b && !b.b) || (a.b && b.b && !a.x && b.x)) { cur.h[h] = b; changed = true; }
        });
        return changed;
    }

    async function readMonth(month) {
        if (loadedMonths.has(month) || typeof SharedStorage === 'undefined') return;
        loadedMonths.add(month);
        const r = await SharedStorage.readJsonFileStrict(fileOf(month)).catch(() => ({ ok: false }));
        if (!r.ok) { loadedMonths.delete(month); return; }
        const flights = r.data && r.data.flights;
        if (flights && typeof flights === 'object') {
            Object.keys(flights).forEach(k => { const e = normEntry(flights[k]); if (e) mergeEntry(log, k, e); });
        }
    }

    function invalidate() {
        models = null;
        evalState = { rev: -1, ev: null, busy: false };
        rev++;
    }

    function ensureLoaded() {
        if (!loading) {
            const m0 = monthOf(today());
            const months = [];
            for (let i = -MONTHS_BACK; i <= 2; i++) months.push(shiftMonth(m0, i));
            loading = Promise.all(months.map(readMonth)).then(() => { loaded = true; invalidate(); });
        }
        return loading;
    }

    // ---------- вылеты в данных: соседние даты, обратный рейс, кривые ----------

    let ctxMemo = { sig: '', v: null };

    function context() {
        const sig = [typeof dataEpoch === 'number' ? dataEpoch : 0, today()].join('|');
        if (ctxMemo.sig === sig) return ctxMemo.v;
        const now = todayTs();
        const byBase = Object.create(null);
        const byKey = Object.create(null);
        Object.keys(typeof groupedData !== 'undefined' && groupedData ? groupedData : {}).forEach(base => {
            const seen = new Set();
            (groupedData[base] || []).forEach(row => {
                const date = row[1];
                const t = parseLocalDate(date);
                if (!t || seen.has(date)) return;
                seen.add(date);
                const code = cleanFlight(row[0]);
                const sc = getFlightSalesList(date, code).length ? code : base;
                const dep = { base, date, ts: t.getTime(), row, rowCode: code, code: sc, s: getSeatsOnSale(row), sold: getSoldFromRow(row), flown: t.getTime() < now };
                (byBase[base] || (byBase[base] = [])).push(dep);
                byKey[date + '|' + base] = dep;
            });
        });
        Object.keys(byBase).forEach(b => byBase[b].sort((a, c) => a.ts - c.ts));
        ctxMemo = { sig, v: { byBase, byKey, now } };
        return ctxMemo.v;
    }

    function rawOf(dep) {
        if (!dep._raw) dep._raw = buildOnHandByDtd(dep.date, dep.code) || { onHand: {}, maxDtd: 0, total: 0 };
        return dep._raw;
    }

    function anchOf(dep) {
        if (!dep._anch) dep._anch = anchorCurveToLoad(departureCurve(dep.date, dep.code), dep.sold) || rawOf(dep);
        return dep._anch;
    }

    function at(curve, d) {
        if (!curve) return 0;
        const v = curve.onHand[d];
        if (v != null) return v;
        return d > curve.maxDtd ? 0 : curve.total;
    }

    // Сколько было продано на вылете X к моменту T. live — момент «сейчас»: берём загрузку из файла.
    function soldAt(X, T, live) {
        if (X.ts <= T) return X.sold;
        if (live) return X.sold;
        const d = Math.round((X.ts - T) / DAY);
        return Math.min(X.sold || Infinity, at(rawOf(X), d));
    }

    // Признаки соседей для вылета dep на момент T (h — дней до вылета): [темп 7 дн., соседние даты, добор рейса, обратный, есть обратный].
    function neighborFeatures(dep, h, T, live, o) {
        const C = context();
        const s = dep.s || 1;
        const raw = rawOf(dep);
        const v7 = Math.max(0, (at(raw, h) - at(raw, h + 7)) / s);
        const list = C.byBase[dep.base] || [];
        let nbSum = 0;
        let nbN = 0;
        let pkSum = 0;
        let pkN = 0;
        list.forEach(X => {
            if (X === dep || !(X.s > 0)) return;
            const gap = Math.abs(X.ts - dep.ts) / DAY;
            if (gap <= NB_DAYS) { nbSum += soldAt(X, T, live) / X.s; nbN++; }
            if (X.ts < T && T - X.ts <= PICK_DAYS * DAY && X.sold > 0) {
                pkSum += Math.max(0, (X.sold - at(anchOf(X), h)) / X.s);
                pkN++;
            }
        });
        const pair = typeof getFlightPair === 'function' ? getFlightPair(dep.base) : null;
        const other = pair ? (pair.outbound === dep.base ? pair.inbound : pair.outbound) : '';
        const R = other ? C.byKey[dep.date + '|' + other] : null;
        const rv = R && R.s > 0 ? soldAt(R, T, live) / R.s : 0;
        return [v7, nbN ? nbSum / nbN : o / s, pkN ? pkSum / pkN : 0, rv, R && R.s > 0 ? 1 : 0];
    }

    // ---------- календарь и рейс ----------

    const calMemo = new Map();

    function calFeatures(date) {
        if (calMemo.has(date)) return calMemo.get(date);
        const d = parseLocalDate(date);
        const dow = d.getDay();
        const oneHot = [0, 0, 0, 0, 0, 0, 0];
        oneHot[dow] = 1;
        const CE = typeof CalendarEvents !== 'undefined' ? CalendarEvents : null;
        const kinds = (ds) => (CE ? CE.on(ds).map(e => e.type) : []);
        const k0 = kinds(date);
        const shift = (n) => fmtDate(d.getTime() + n * DAY);
        let pre = 0;
        let post = 0;
        for (let i = 1; i <= 3; i++) if (!k0.includes('holiday') && kinds(shift(i)).includes('holiday')) pre = 1;
        for (let i = 1; i <= 2; i++) if (!k0.includes('holiday') && kinds(shift(-i)).includes('holiday')) post = 1;
        const m = d.getMonth();
        const v = oneHot.concat([
            dow === 0 || dow === 6 ? 1 : 0,                 // выходной
            dow === 5 || dow === 0 ? 1 : 0,                 // пятница/воскресенье — пик поездок
            k0.includes('holiday') ? 1 : 0,
            k0.includes('school') ? 1 : 0,
            k0.includes('event') ? 1 : 0,
            pre, post,
            Math.sin(2 * Math.PI * m / 12), Math.cos(2 * Math.PI * m / 12)
        ]);
        calMemo.set(date, v);
        return v;
    }

    function routeFeatures(base, s) {
        const t = typeof getFlightRouteType === 'function' ? getFlightRouteType(base) : '';
        return [t === 'interregional' ? 1 : 0, Math.min(2, (s || 0) / 70)];
    }

    // Полный вектор признаков записи (без свободного члена). Цель — сколько ещё доберёт (доля кресел).
    const FEATURE_GROUPS = [
        ['Продано на сейчас', 1], ['Файл ожидаемой загрузки', 3], ['Прогноз по дням недели', 2], ['Дней до вылета', 1],
        ['Темп продаж за 7 дней', 1], ['Соседние даты рейса', 1], ['Добор рейса за 4 недели', 1], ['Обратный рейс', 2], ['Есть признаки соседей', 1],
        ['День недели', 7], ['Выходной / пятница–воскресенье', 2], ['Праздник', 1], ['Каникулы', 1], ['Событие', 1], ['Канун / после праздника', 2], ['Сезон', 2],
        ['Тип рейса и ВС', 2]
    ];

    function features(smp) {
        const { r, h, s } = smp;
        const o = r.o / s;
        const x = r.x || [0, o, 0, 0, 0];
        return [
            o,
            r.p != null && r.q != null ? Math.max(0, (r.p - r.q) / s) : 0,
            r.p != null ? Math.max(0, r.p / s - o) : 0,
            r.p != null ? 1 : 0,
            r.y != null ? Math.max(0, (r.y - r.o) / s) : 0,
            r.y != null ? 1 : 0,
            Math.min(1, (r.d != null ? r.d : h) / 30),
            x[0], x[1], x[2], x[3], x[4], r.x ? 1 : 0
        ].concat(calFeatures(smp.date), routeFeatures(smp.base, s));
    }

    // ---------- линейная модель ----------

    function ridge(X, y) {
        const k = X[0].length + 1;
        const A = Array.from({ length: k }, () => new Array(k).fill(0));
        const b = new Array(k).fill(0);
        X.forEach((row, i) => {
            const x = [1].concat(row);
            for (let a = 0; a < k; a++) {
                b[a] += x[a] * y[i];
                for (let c = a; c < k; c++) A[a][c] += x[a] * x[c];
            }
        });
        for (let a = 0; a < k; a++) for (let c = 0; c < a; c++) A[a][c] = A[c][a];
        for (let a = 1; a < k; a++) A[a][a] += LAMBDA;
        A[0][0] += 1e-6;
        for (let c = 0; c < k; c++) {
            let p = c;
            for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
            [A[c], A[p]] = [A[p], A[c]];
            [b[c], b[p]] = [b[p], b[c]];
            const piv = A[c][c];
            if (Math.abs(piv) < 1e-12) continue;
            for (let r = 0; r < k; r++) {
                if (r === c) continue;
                const f = A[r][c] / piv;
                if (!f) continue;
                for (let cc = c; cc < k; cc++) A[r][cc] -= f * A[c][cc];
                b[r] -= f * b[c];
            }
        }
        return b.map((v, i) => (Math.abs(A[i][i]) < 1e-12 ? 0 : v / A[i][i]));
    }

    function linPredict(w, x) {
        let s = w[0];
        for (let i = 0; i < x.length; i++) s += w[i + 1] * x[i];
        return s;
    }

    // ---------- решающие деревья (градиентный бустинг) ----------

    function gbmTrain(X, y) {
        const n = X.length;
        const k = X[0].length;
        // Пороги по квантилям каждого признака.
        const cuts = [];
        for (let f = 0; f < k; f++) {
            const vals = X.map(r => r[f]).sort((a, b) => a - b);
            const set = new Set();
            for (let q = 1; q < GBM.bins; q++) set.add(vals[Math.floor(q * (n - 1) / GBM.bins)]);
            cuts.push([...set].sort((a, b) => a - b));
        }
        const base = y.reduce((a, b) => a + b, 0) / n;
        const pred = new Array(n).fill(base);
        const trees = [];
        const gain = new Array(k).fill(0);
        for (let t = 0; t < GBM.rounds; t++) {
            const res = y.map((v, i) => v - pred[i]);
            const tree = grow(X, res, Array.from({ length: n }, (_, i) => i), 0, cuts, gain);
            trees.push(tree);
            for (let i = 0; i < n; i++) pred[i] += GBM.rate * treeValue(tree, X[i]);
        }
        return { base, trees, gain };
    }

    function grow(X, res, idx, depth, cuts, gain) {
        let sum = 0;
        idx.forEach(i => { sum += res[i]; });
        const mean = sum / idx.length;
        if (depth >= GBM.depth || idx.length < GBM.minLeaf * 2) return { v: mean };
        let best = null;
        const total = sum;
        const nAll = idx.length;
        for (let f = 0; f < cuts.length; f++) {
            const cs = cuts[f];
            if (!cs.length) continue;
            // Гистограмма: сумма и число по корзинам порогов.
            const bs = new Array(cs.length + 1).fill(0);
            const bn = new Array(cs.length + 1).fill(0);
            idx.forEach(i => {
                const v = X[i][f];
                let lo = 0;
                let hi = cs.length;
                while (lo < hi) { const m = (lo + hi) >> 1; if (v <= cs[m]) hi = m; else lo = m + 1; }
                bs[lo] += res[i];
                bn[lo]++;
            });
            let ls = 0;
            let ln = 0;
            for (let c = 0; c < cs.length; c++) {
                ls += bs[c];
                ln += bn[c];
                const rn = nAll - ln;
                if (ln < GBM.minLeaf || rn < GBM.minLeaf) continue;
                const rs = total - ls;
                const g = ls * ls / ln + rs * rs / rn - total * total / nAll;
                if (!best || g > best.g) best = { g, f, thr: cs[c] };
            }
        }
        if (!best || best.g <= 1e-9) return { v: mean };
        gain[best.f] += best.g;
        const L = [];
        const R = [];
        idx.forEach(i => (X[i][best.f] <= best.thr ? L : R).push(i));
        return { f: best.f, thr: best.thr, l: grow(X, res, L, depth + 1, cuts, gain), r: grow(X, res, R, depth + 1, cuts, gain) };
    }

    function treeValue(t, x) {
        while (t.v === undefined) t = x[t.f] <= t.thr ? t.l : t.r;
        return t.v;
    }

    function gbmPredict(m, x) {
        let s = m.base;
        for (const t of m.trees) s += GBM.rate * treeValue(t, x);
        return s;
    }

    // ---------- обучение и прогноз ----------

    function samples() {
        const out = [];
        Object.keys(log).forEach(key => {
            const e = log[key];
            if (e.f == null) return;
            const date = key.slice(0, key.lastIndexOf('|'));
            const d = parseLocalDate(date);
            if (!d) return;
            Object.keys(e.h).forEach(h => {
                const r = e.h[h];
                const s = r.s || e.s;
                if (!(s > 0)) return;
                out.push({ key, base: e.b, date, ts: d.getTime(), h: Number(h), s, r, f: e.f });
            });
        });
        return out;
    }

    function target(x) {
        return (x.f - x.r.o) / x.s;
    }

    function train(list) {
        if (list.length < MIN_TRAIN) return null;
        const X = list.map(features);
        const y = list.map(target);
        const res = { n: list.length, lin: {}, linAll: ridge(X, y), gbm: gbmTrain(X, y), route: {} };
        HORIZONS.forEach(h => {
            const ids = [];
            list.forEach((x, i) => { if (x.h === h) ids.push(i); });
            if (ids.length >= MIN_TRAIN_H) res.lin[h] = ridge(ids.map(i => X[i]), ids.map(i => y[i]));
        });
        // Поправка по рейсу: средняя остаточная ошибка ансамбля, сжатая к нулю при малом числе вылетов.
        const acc = {};
        list.forEach((x, i) => {
            const p = (linPredict(res.lin[x.h] || res.linAll, X[i]) + gbmPredict(res.gbm, X[i])) / 2;
            const a = acc[x.base] || (acc[x.base] = { sum: 0, n: 0 });
            a.sum += y[i] - p;
            a.n++;
        });
        Object.keys(acc).forEach(b => { res.route[b] = (acc[b].sum / acc[b].n) * (acc[b].n / (acc[b].n + ROUTE_K)); });
        return res;
    }

    // { lin, gbm, ens } — итог в пассажирах (не меньше проданного и не больше кресел).
    function predictAll(m, smp) {
        if (!m) return null;
        const x = features(smp);
        const corr = m.route[smp.base] || 0;
        const o = smp.r.o / smp.s;
        const clamp = (lf) => Math.max(smp.r.o, Math.min(smp.s, Math.round((o + lf) * smp.s)));
        const l = linPredict(m.lin[smp.h] || m.linAll, x);
        const g = gbmPredict(m.gbm, x);
        return { lin: clamp(l + corr), gbm: clamp(g + corr), ens: clamp((l + g) / 2 + corr) };
    }

    function trainedModel() {
        if (models || modelsBusy) return models;
        modelsBusy = true;
        // Обучение — в фоне, чтобы не задерживать открытие карточки.
        setTimeout(() => {
            try { models = train(samples()) || false; } catch (e) { console.warn('ForecastLab.train', e); models = false; }
            modelsBusy = false;
            if (typeof FlightCard !== 'undefined' && FlightCard.isOpen && FlightCard.isOpen() && FlightCard.refresh) FlightCard.refresh();
        }, 0);
        return null;
    }

    // ---------- что известно о вылете сейчас ----------

    function horizonFor(dtd) {
        for (let i = HORIZONS.length - 1; i >= 0; i--) if (HORIZONS[i] >= dtd) return HORIZONS[i];
        return null;
    }

    function liveRecord(dep, dtd) {
        const s = dep.s;
        if (!(s > 0)) return null;
        const cap = getCapacityFromAircraft(getAircraftType(dep.row[4]));
        const wk = getWeekForExpectedLoad(dep.date);
        const p = getExpectedLoad(cap, dep.base, 0, wk);
        const q = getExpectedLoad(cap, dep.base, dtd, wk);
        let y = null;
        let n = null;
        if (typeof FlightInsights !== 'undefined') {
            const f = FlightInsights.forecast(dep.rowCode, dep.date);
            if (f && f.source === 'history') { y = f.final; n = f.n; }
        }
        const o = dep.sold;
        const x = neighborFeatures(dep, dtd, context().now, true, o).map(v => Math.round(v * 1000) / 1000);
        return { d: dtd, o, p: num(p), q: num(q), y: num(y), n, m: null, b: 0, s, x };
    }

    const METHOD_LABEL = { ens: 'модель', gbm: 'модель (деревья)', lin: 'модель (линейная)', planPick: 'продано + добор по файлу', hist: 'по истории', naive: 'продано на сейчас' };

    // Лучший прогноз для вылета (карточка): способ, который на этом горизонте ошибался меньше всех.
    function predict(code, date) {
        if (!isAdmin() || !loaded) return null;
        const ev = evalState.ev;
        if (!ev) { startEvaluation(); return null; }
        const base = getBaseFlight(code);
        const dep = context().byKey[date + '|' + base];
        const dtd = typeof getDaysUntil === 'function' ? getDaysUntil(date) : null;
        if (!dep || dtd == null || dtd <= 0 || dtd > 30) return null;
        const h = horizonFor(dtd);
        const r = liveRecord(dep, dtd);
        if (!r || !h) return null;
        const pick = ev.choice[h];
        if (!pick) return null;
        const smp = { base, date, ts: dep.ts, h, s: r.s, r };
        let final = null;
        if (pick.k === 'ens' || pick.k === 'gbm' || pick.k === 'lin') {
            const m = trainedModel();
            if (!m) return null;
            final = predictAll(m, smp)[pick.k];
        } else if (pick.k === 'planPick') final = r.p != null && r.q != null ? Math.max(r.o, Math.min(r.s, Math.round(r.o + r.p - r.q))) : r.o;
        else if (pick.k === 'hist') final = r.y != null ? r.y : r.o;
        else final = r.o;
        return { final, seats: r.s, lf: Math.round(final / r.s * 100), method: METHOD_LABEL[pick.k], err: Math.round(pick.v * 10) / 10, trainedOn: pick.n, h };
    }

    // ---------- запись журнала ----------

    // Восстановить записи улетевшего вылета: что было известно за h дней до вылета.
    function backfill(dep, byBase) {
        const s = dep.s;
        const f = dep.sold;
        if (!(s > 0) || !(f > 0)) return null;
        const raw = rawOf(dep);
        if (!(raw.total > 0)) return null;
        const cap = getCapacityFromAircraft(getAircraftType(dep.row[4]));
        const wk = getWeekForExpectedLoad(dep.date);
        const p = getExpectedLoad(cap, dep.base, 0, wk);
        const dow = new Date(dep.ts).getDay();
        const e = { b: dep.base, s, f, h: {} };
        HORIZONS.forEach(h => {
            const T = dep.ts - h * DAY;
            const o = Math.min(f, at(raw, h));
            // По истории: те же дни недели, улетевшие к этому моменту (±8 недель).
            const coh = (byBase[dep.base] || []).filter(c => c.flown && c.ts < T && new Date(c.ts).getDay() === dow && dep.ts - c.ts <= 56 * DAY && c.s > 0 && c.sold > 0);
            let y = null;
            if (coh.length >= 2) {
                const lf = coh.reduce((a, c) => a + Math.max(0, (c.sold - at(anchOf(c), h)) / c.s), 0) / coh.length;
                y = Math.max(o, Math.min(s, Math.round(o + lf * s)));
            }
            const x = neighborFeatures(dep, h, T, false, o).map(v => Math.round(v * 1000) / 1000);
            e.h[h] = { d: h, o, p: num(p), q: num(getExpectedLoad(cap, dep.base, h, wk)), y, n: coh.length || null, m: null, b: 1, s, x };
        });
        return e;
    }

    function dataToken() {
        const at0 = typeof lastSalesUpdate !== 'undefined' && lastSalesUpdate ? new Date(lastSalesUpdate).getTime() : 0;
        return `v2|${today()}|${at0}|${(typeof allData !== 'undefined' && allData ? allData.length : 0)}`;
    }

    async function capture(force) {
        if (!isAdmin() || typeof SharedStorage === 'undefined') return false;
        if (typeof groupedData === 'undefined' || !Object.keys(groupedData || {}).length) return false;
        const token = dataToken();
        if (!force) { try { if (localStorage.getItem(DONE_KEY) === token) return true; } catch (e) { /* ignore */ } }
        if (!(await SharedStorage.canWrite())) return false;
        await ensureLoaded();
        const C = context();
        const additions = Object.create(null);
        const add = (key, date, e) => { const m = monthOf(date); (additions[m] || (additions[m] = Object.create(null)))[key] = e; };
        let recorded = 0;
        let finals = 0;
        let backfilled = 0;
        let i = 0;

        for (const base of Object.keys(C.byBase)) {
            for (const dep of C.byBase[base]) {
                const key = dep.date + '|' + dep.rowCode;
                const cur = log[key];
                if (dep.flown) {
                    if (!(dep.s > 0) || !(dep.sold > 0)) continue;
                    if (cur && cur.f == null) { add(key, dep.date, { b: base, s: dep.s, f: dep.sold, h: {} }); finals++; }
                    const need = observedFromDtd(dep.date) === 0 && (!cur || HORIZONS.some(h => !cur.h[h] || (cur.h[h].b && !cur.h[h].x)));
                    if (need) {
                        const e = backfill(dep, C.byBase);
                        if (e) { add(key, dep.date, e); backfilled++; }
                    }
                } else {
                    const dtd = getDaysUntil(dep.date);
                    if (dtd == null || dtd <= 0 || dtd > 30) continue;
                    const h = horizonFor(dtd);
                    if (cur && cur.h[h] && !cur.h[h].b) continue;
                    const r = liveRecord(dep, dtd);
                    if (!r) continue;
                    const m = models || null;
                    if (m) r.m = predictAll(m, { base, date: dep.date, ts: dep.ts, h, s: r.s, r }).ens;
                    add(key, dep.date, { b: base, s: r.s, f: null, h: { [h]: r } });
                    recorded++;
                }
                if (++i % 40 === 0) await pause();
            }
        }

        let ok = true;
        for (const month of Object.keys(additions)) {
            const read = await SharedStorage.readJsonFileStrict(fileOf(month)).catch(() => ({ ok: false }));
            if (!read.ok) { ok = false; continue; }
            const merged = Object.create(null);
            const remote = read.data && read.data.flights;
            if (remote && typeof remote === 'object') Object.keys(remote).forEach(k => { const e = normEntry(remote[k]); if (e) merged[k] = e; });
            let changed = false;
            Object.keys(additions[month]).forEach(k => { if (mergeEntry(merged, k, additions[month][k])) changed = true; });
            if (changed) ok = (await SharedStorage.writeJsonFile(fileOf(month), { version: 2, updatedAt: new Date().toISOString(), flights: merged })) && ok;
            Object.keys(merged).forEach(k => mergeEntry(log, k, merged[k]));
        }
        invalidate();
        lastCapture = { at: Date.now(), recorded, finals, backfilled, ok };
        if (ok) { try { localStorage.setItem(DONE_KEY, token); } catch (e) { /* ignore */ } }
        return ok;
    }

    function afterStart() {
        if (!isAdmin()) return;
        const run = () => capture().then(() => startEvaluation()).catch(e => console.warn('ForecastLab.capture', e));
        if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 30000 });
        else setTimeout(run, 5000);
    }

    // ---------- честная проверка (в фоне) ----------

    const weekOf = (ts) => Math.floor((ts - 4 * DAY) / (7 * DAY));

    async function evaluate() {
        const all = samples().sort((a, b) => a.ts - b.ts);
        const weeks = [...new Set(all.map(x => weekOf(x.ts)))].sort((a, b) => a - b);
        const pred = new Map();
        for (const w of weeks) {
            const m = train(all.filter(x => weekOf(x.ts) < w));
            if (m) all.filter(x => weekOf(x.ts) === w).forEach(x => pred.set(x, predictAll(m, x)));
            await pause();
        }
        const mp = (k) => (x) => (pred.has(x) ? pred.get(x)[k] : null);
        const methods = {
            naive: (x) => x.r.o,
            plan: (x) => (x.r.p != null ? Math.min(x.s, x.r.p) : null),
            planPick: (x) => (x.r.p != null && x.r.q != null ? Math.max(x.r.o, Math.min(x.s, Math.round(x.r.o + x.r.p - x.r.q))) : null),
            hist: (x) => x.r.y,
            lin: mp('lin'),
            gbm: mp('gbm'),
            ens: mp('ens')
        };
        const byH = {};
        HORIZONS.forEach(h => { byH[h] = { total: 0 }; Object.keys(methods).forEach(k => { byH[h][k] = { sum: 0, bias: 0, n: 0 }; }); });
        const byWeek = new Map();
        const byBase = new Map();
        all.forEach(x => {
            const B = byH[x.h];
            if (!B) return;
            B.total++;
            Object.keys(methods).forEach(k => {
                const v = methods[k](x);
                if (v == null) return;
                B[k].sum += Math.abs(v - x.f);
                B[k].bias += v - x.f;
                B[k].n++;
            });
            if (x.h === 7) {
                const w = weekOf(x.ts);
                const W = byWeek.get(w) || { plan: [0, 0], best: [0, 0], ts: x.ts };
                const pl = methods.plan(x);
                const md = methods.ens(x) != null ? methods.ens(x) : (methods.hist(x) != null ? methods.hist(x) : methods.planPick(x));
                if (pl != null) { W.plan[0] += Math.abs(pl - x.f); W.plan[1]++; }
                if (md != null) { W.best[0] += Math.abs(md - x.f); W.best[1]++; }
                W.ts = Math.min(W.ts, x.ts);
                byWeek.set(w, W);
                const R = byBase.get(x.base) || { plan: [0, 0], model: [0, 0] };
                if (pl != null) { R.plan[0] += Math.abs(pl - x.f); R.plan[1]++; }
                if (md != null) { R.model[0] += Math.abs(md - x.f); R.model[1]++; }
                byBase.set(x.base, R);
            }
        });
        const choice = {};
        HORIZONS.forEach(h => {
            let best = null;
            ['ens', 'gbm', 'lin', 'planPick', 'hist', 'naive'].forEach(k => {
                const c = byH[h][k];
                if (c.n < MIN_CHOICE) return;
                const v = c.sum / c.n;
                if (!best || v < best.v - 1e-9) best = { k, v, n: c.n };
            });
            choice[h] = best;
        });
        // Что влияет: вклад признаков в деревья модели, обученной на всём журнале.
        const full = train(all);
        let influence = [];
        if (full) {
            let pos = 0;
            const total = full.gbm.gain.reduce((a, b) => a + b, 0) || 1;
            influence = FEATURE_GROUPS.map(([label, len]) => {
                let g = 0;
                for (let i = 0; i < len; i++) g += full.gbm.gain[pos + i] || 0;
                pos += len;
                return { label, share: g / total };
            }).sort((a, b) => b.share - a.share);
            models = full;
        }
        return { byH, byWeek, byBase, choice, influence, samples: all.length, departures: new Set(all.map(x => x.key)).size, trained: !!full };
    }

    function startEvaluation(onDone) {
        if (!loaded || evalState.busy || evalState.rev === rev) { if (onDone && evalState.rev === rev) onDone(); return; }
        const myRev = rev;
        evalState = { rev: -1, ev: evalState.ev, busy: true };
        evaluate().then(ev => {
            if (myRev !== rev) { evalState.busy = false; startEvaluation(onDone); return; }
            evalState = { rev: myRev, ev, busy: false };
            if (onDone) onDone();
            if (typeof FlightCard !== 'undefined' && FlightCard.isOpen && FlightCard.isOpen() && FlightCard.refresh) FlightCard.refresh();
        }).catch(e => { console.warn('ForecastLab.evaluate', e); evalState.busy = false; });
    }

    // ---------- отчёт ----------

    function fmt(v) {
        return v == null ? '—' : (Math.round(v * 10) / 10).toLocaleString('ru-RU');
    }

    function html(rerender) {
        if (!canView()) return '<p class="rp-note">Раздел доступен только администратору.</p>';
        if (!loaded) {
            ensureLoaded().then(() => startEvaluation(rerender));
            return '<p class="rp-note">Загружаю журнал прогнозов…</p>';
        }
        if (evalState.rev !== rev || !evalState.ev) {
            startEvaluation(rerender);
            return '<p class="rp-note">Модель учится и проверяет себя на прошлых неделях…</p>';
        }
        const ev = evalState.ev;
        const futureKeys = Object.keys(log).filter(k => log[k].f == null).length;
        const cols = [['naive', 'Продано на сейчас'], ['plan', 'Файл ожидаемой, итог'], ['planPick', 'Продано + добор по файлу'], ['hist', 'По тем же дням недели'], ['lin', 'Модель: линейная'], ['gbm', 'Модель: деревья'], ['ens', 'Модель: среднее']];
        const rowsH = HORIZONS.map(h => {
            const B = ev.byH[h];
            const vals = cols.map(([k]) => (B[k].n ? B[k].sum / B[k].n : null));
            const okVals = vals.filter((v, i) => v != null && B[cols[i][0]].n >= MIN_CHOICE);
            const best = okVals.length ? Math.min(...okVals) : null;
            return `<tr><td><strong>${h} ${h === 1 ? 'день' : (h < 5 ? 'дня' : 'дней')}</strong></td>${cols.map(([k], i) => {
                const v = vals[i];
                const b = B[k].n ? B[k].bias / B[k].n : null;
                return `<td class="${v != null && v === best && B[k].n >= MIN_CHOICE ? 'fl-best' : ''}">${fmt(v)}${v != null ? `<div class="rp-muted">${B[k].n} · ${b > 0 ? '↑' : '↓'}${fmt(Math.abs(b))}</div>` : ''}</td>`;
            }).join('')}<td class="rp-left">${ev.choice[h] ? `<strong>${esc(METHOD_LABEL[ev.choice[h].k])}</strong>` : '<span class="rp-muted">мало данных</span>'}</td></tr>`;
        }).join('');
        const weeks = [...ev.byWeek.entries()].sort((a, b) => a[0] - b[0]).slice(-12);
        const rowsW = weeks.map(([, W]) => {
            const d = new Date(W.ts);
            const p = W.plan[1] ? W.plan[0] / W.plan[1] : null;
            const b = W.best[1] ? W.best[0] / W.best[1] : null;
            return `<tr><td>с ${pad(d.getDate())}.${pad(d.getMonth() + 1)}</td><td>${fmt(p)}</td><td class="${b != null && p != null && b < p ? 'fl-best' : ''}">${fmt(b)}</td><td>${Math.max(W.plan[1], W.best[1])}</td></tr>`;
        }).join('');
        const routes = [...ev.byBase.entries()].map(([b, R]) => ({ b, p: R.plan[1] ? R.plan[0] / R.plan[1] : null, m: R.model[1] ? R.model[0] / R.model[1] : null, n: Math.max(R.plan[1], R.model[1]) }))
            .filter(x => x.n >= 3).sort((a, b) => (b.m != null ? b.m : b.p || 0) - (a.m != null ? a.m : a.p || 0)).slice(0, 12);
        const rowsR = routes.map(x => `<tr><td class="rp-left"><strong>${esc(x.b)}</strong> <span class="rp-muted">${esc(typeof getFlightDirection === 'function' ? getFlightDirection(x.b) : '')}</span></td><td>${fmt(x.p)}</td><td>${fmt(x.m)}</td><td>${x.n}</td></tr>`).join('');
        const infl = ev.influence.filter(x => x.share > 0.001).map(x => `<div class="fl-infl"><span class="fl-infl-label">${esc(x.label)}</span><span class="fl-infl-bar"><span style="width:${Math.max(2, Math.round(x.share * 100))}%"></span></span><span class="fl-infl-val">${Math.round(x.share * 100)}%</span></div>`).join('');
        const cap = lastCapture && (lastCapture.recorded || lastCapture.backfilled || lastCapture.finals)
            ? `Последняя запись журнала: прогнозов ${lastCapture.recorded}, восстановлено вылетов ${lastCapture.backfilled}, дописан факт ${lastCapture.finals}.` : '';
        return `
            <section class="rp-card">
                <div class="rp-card-head"><h3 class="rp-card-title">Точность прогноза загрузки</h3><span class="fl-admin">только администратор</span></div>
                <p class="rp-card-text">Каждый день сайт записывает прогноз по каждому вылету за 30, 21, 14, 10, 7, 5, 3 и 1 день до вылета, а после вылета — факт.
                    Модель учитывает продажи и их темп, файл ожидаемой загрузки, те же дни недели, соседние даты рейса, обратный рейс,
                    день недели, выходные, праздники и каникулы, сезон и тип рейса. Ошибка — в пассажирах, в среднем по вылетам; под числом — сколько вылетов
                    и в какую сторону ошибается (↑ завышает, ↓ занижает). Проверка честная: для каждой недели модель обучена только на более ранних неделях.</p>
                <div class="dr-kpis">
                    <div class="dr-kpi"><div class="dr-kpi-label">Вылетов с фактом</div><div class="dr-kpi-value">${ev.departures}</div><div class="dr-kpi-sub">записей прогноза: ${ev.samples}</div></div>
                    <div class="dr-kpi"><div class="dr-kpi-label">Ждут вылета</div><div class="dr-kpi-value">${futureKeys}</div><div class="dr-kpi-sub">факт допишется после вылета</div></div>
                    <div class="dr-kpi ${ev.trained ? 'dr-kpi-up' : ''}"><div class="dr-kpi-label">Модель</div><div class="dr-kpi-value">${ev.trained ? 'обучена' : 'учится'}</div><div class="dr-kpi-sub">${ev.trained ? 'линейная + деревья' : `нужно от ${MIN_TRAIN} записей с фактом`}</div></div>
                </div>
                ${cap ? `<p class="rp-note">${esc(cap)}</p>` : ''}
                <div class="dr-list-title">Ошибка по горизонтам, пасс.</div>
                <div class="rp-scroll"><table class="rp-table">
                    <thead><tr><th>До вылета</th>${cols.map(([, l]) => `<th>${esc(l)}</th>`).join('')}<th title="Этот способ показывается в карточке рейса">Что берём</th></tr></thead>
                    <tbody>${rowsH}</tbody></table></div>
                <div class="dr-sums">
                    <div class="dr-sum"><div class="dr-sum-title">Что влияет на прогноз (модель «деревья»)</div>
                        ${infl || '<p class="rp-note">Появится, когда модель обучится.</p>'}
                    </div>
                    <div class="dr-sum"><div class="dr-sum-title">По неделям вылета, за 7 дней</div>
                        ${rowsW ? `<table class="rp-table dr-sum-table"><thead><tr><th>Неделя</th><th>Файл ожидаемой</th><th>Модель</th><th>Вылетов</th></tr></thead><tbody>${rowsW}</tbody></table>` : '<p class="rp-note">Пока нет данных.</p>'}
                    </div>
                </div>
                <div class="dr-sum"><div class="dr-sum-title">Где ошибается сильнее всего, за 7 дней</div>
                    ${rowsR ? `<table class="rp-table dr-sum-table"><thead><tr><th>Рейс</th><th>Файл ожидаемой</th><th>Модель</th><th>Вылетов</th></tr></thead><tbody>${rowsR}</tbody></table>` : '<p class="rp-note">Пока нет данных.</p>'}
                </div>
                <div class="ref-toolbar"><button type="button" class="btn-secondary rp-btn" id="fl-capture">Записать прогнозы сейчас</button>
                    <span class="rp-muted">Обычно это происходит само раз в день при входе администратора.</span></div>
            </section>`;
    }

    function handleClick(btn, rerender) {
        if (btn.id !== 'fl-capture') return false;
        btn.disabled = true;
        capture(true).then(ok => {
            if (typeof showToast === 'function') showToast(ok ? 'Прогнозы записаны в журнал' : 'Не удалось записать журнал (нет доступа к общей папке?)', ok ? undefined : 'error');
            rerender();
        }).catch(e => { console.warn(e); btn.disabled = false; });
        return true;
    }

    return { canView, html, handleClick, capture, afterStart, ensureLoaded, predict, revision: () => rev, HORIZONS, evaluation: () => evalState.ev, startEvaluation };
})();
