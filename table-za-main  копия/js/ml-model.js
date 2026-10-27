// Вторая модель прогноза итоговой загрузки — машинное обучение прямо в браузере, без Python и без служб.
// Учится на улетевших вылетах из истории сайта (кривая «сколько продано за N дней до вылета») и сама
// переучивается раз в день, когда в истории появляются новые вылеты.
//  • сроки: за 30, 14, 7 и 1–3 дня до вылета — для каждого своя модель;
//  • три способа считать и их сочетание: «по средним» (добавка к проданному), «по доле продаж», градиентный бустинг
//    (деревья решений); веса сочетания подобраны на вылетах, которых модель при обучении не видела;
//  • история рейса учитывается с иерархией: рейс и день недели → рейс → направление и день недели → направление → всё вместе;
//    берутся только вылеты, улетевшие ДО даты прогноза (будущее не подсматриваем);
//  • проверка: ошибка в пассажирах на последних 20% вылетов по времени, рядом — «просто текущие продажи»;
//  • критик: итог не ниже уже проданного и не выше мест, пустые и бесконечные числа не пропускаются.
// Данные берёт у ForecastLab (mlHistory / mlLive) — это те же вылеты, что видит модель 1, но считает по-своему.
window.MlModel = (function () {
    const CURVE_H = 62;                 // длина кривой: дней до вылета
    const DAY = 86400000;
    const STORE_KEY = 'krasavia_ml2_v1';
    const MIN_FLIGHTS = 300;            // меньше улетевших вылетов обучать нечего
    const SHRINK = 5;
    const HZ = {
        '30d': { c: 30, lo: 27, hi: 33 },
        '14d': { c: 14, lo: 12, hi: 16 },
        '7d': { c: 7, lo: 6, hi: 8 },
        '1_3d': { c: 2, lo: 1, hi: 3 }
    };
    const KEYS = Object.keys(HZ);
    const FEATURES = ['dtd', 'bookedPct', 'cap', 'pace3', 'pace7', 'pace14', 'growth7', 'dow', 'month', 'dom', 'weekend',
        'doySin', 'doyCos', 'hFinal', 'hBook', 'hRem', 'nBase', 'level', 'bookedVsHist'];
    const NF = FEATURES.length;
    const GBM = { trees: 90, depth: 4, lr: 0.1, bins: 32, minLeaf: 25, lambda: 5, subsample: 0.7 };

    let S = { status: 'idle', progress: 0, model: null, hist: null, idx: null, err: '', running: null, tpl: new Map() };
    const listeners = new Set();
    function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
    function notify() { listeners.forEach(fn => { try { fn(); } catch (e) { /* ignore */ } }); }
    const tick = () => new Promise(r => setTimeout(r, 0));

    function dirOf(base) { try { return typeof getFlightDirection === 'function' ? String(getFlightDirection(base) || '') : ''; } catch (e) { return ''; } }
    function dowOf(ts) { return (new Date(ts).getDay() + 6) % 7; }
    // Дата вылета в истории — местная полночь: через toISOString() она сдвигалась бы на сутки назад (Красноярск, UTC+7).
    function ymd(ts) {
        const d = new Date(ts);
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    // ---------- история: индекс по уровням с накопленными суммами ----------
    // Для каждого уровня и ключа — вылеты по возрастанию даты и накопленные суммы (итог/места, продано к h0/места).
    function buildIndex(hist, h0) {
        const levels = { d: new Map(), dd: new Map(), b: new Map(), bd: new Map() };
        const all = { ts: [], cs: [[0], [0]] };
        const sorted = hist;     // уже по возрастанию даты
        const add = (map, key, ts, v0, v1) => {
            let e = map.get(key);
            if (!e) { e = { ts: [], c0: [0], c1: [0] }; map.set(key, e); }
            e.ts.push(ts);
            e.c0.push(e.c0[e.c0.length - 1] + v0);
            e.c1.push(e.c1[e.c1.length - 1] + v1);
        };
        sorted.forEach(d => {
            const v0 = d.sold / d.s, v1 = d.cum[h0] / d.s;
            all.ts.push(d.ts);
            all.cs[0].push(all.cs[0][all.cs[0].length - 1] + v0);
            all.cs[1].push(all.cs[1][all.cs[1].length - 1] + v1);
            add(levels.d, d.dir, d.ts, v0, v1);
            add(levels.dd, d.dir + '|' + d.dow, d.ts, v0, v1);
            add(levels.b, d.base, d.ts, v0, v1);
            add(levels.bd, d.base + '|' + d.dow, d.ts, v0, v1);
        });
        return { levels, all };
    }

    function countBefore(arr, t) {          // число элементов < t в отсортированном массиве
        let lo = 0, hi = arr.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < t) lo = m + 1; else hi = m; }
        return lo;
    }

    // Сглаженные средние (итог/места, продано/места) для вылета на момент asOf: общий -> направление -> ... -> рейс×день.
    function histStats(idx, base, dir, dow, asOf) {
        const n0 = countBefore(idx.all.ts, asOf);
        let f = n0 ? idx.all.cs[0][n0] / n0 : 0;
        let b = n0 ? idx.all.cs[1][n0] / n0 : 0;
        let level = 0, nBase = 0;
        const chain = [['d', dir], ['dd', dir + '|' + dow], ['b', base], ['bd', base + '|' + dow]];
        chain.forEach(([lv, key], i) => {
            const e = idx.levels[lv].get(key);
            const n = e ? countBefore(e.ts, asOf) : 0;
            const s0 = e ? e.c0[n] : 0, s1 = e ? e.c1[n] : 0;
            f = (s0 + SHRINK * f) / (n + SHRINK);
            b = (s1 + SHRINK * b) / (n + SHRINK);
            if (n >= 3) level = i + 1;
            if (lv === 'b') nBase = n;
        });
        return { hFinal: f, hBook: b, hRem: Math.max(0, f - b), nBase, level };
    }

    // ---------- признаки ----------
    const at = (cum, k) => cum[Math.min(Math.max(k, 0), cum.length - 1)];

    function features(out, o, idx, h0) {
        // out — Float32Array(NF), o: { cum, s, ts, base, dir, dow, h }
        const { cum, s, ts, h } = o;
        const booked = at(cum, h);
        const hs = histStats(idx, o.base, o.dir, o.dow, ts - h * DAY);
        const d = new Date(ts);
        const doy = Math.floor((ts - new Date(d.getFullYear(), 0, 0).getTime()) / DAY);
        out[0] = h;
        out[1] = booked / s;
        out[2] = s;
        out[3] = (booked - at(cum, h + 3)) / 3 / s;
        out[4] = (booked - at(cum, h + 7)) / 7 / s;
        out[5] = (booked - at(cum, h + 14)) / 14 / s;
        out[6] = (booked + 1) / (at(cum, h + 7) + 1);
        out[7] = o.dow;
        out[8] = d.getMonth() + 1;
        out[9] = d.getDate();
        out[10] = o.dow >= 5 ? 1 : 0;
        out[11] = Math.sin(2 * Math.PI * doy / 365.25);
        out[12] = Math.cos(2 * Math.PI * doy / 365.25);
        out[13] = hs.hFinal;
        out[14] = hs.hBook;
        out[15] = hs.hRem;
        out[16] = hs.nBase;
        out[17] = hs.level;
        out[18] = (booked / s + 0.02) / (hs.hBook + 0.02);
        return booked;
    }

    // Простые способы (не обучаются): прогноз итога в пассажирах.
    function simpleAdd(x, booked, cap) { return booked + x[15] * cap; }
    function simpleRatio(x, booked, cap) {
        const r = x[14] > 0.02 ? Math.min(x[13] / x[14], 6) : null;
        return r == null ? booked + x[15] * cap : booked * r;
    }

    // ---------- градиентный бустинг (гистограммные деревья) ----------
    function rng(seed) { let a = seed >>> 0; return () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; }; }

    function makeBins(X, n) {
        const edges = [];
        for (let f = 0; f < NF; f++) {
            const step = Math.max(1, Math.floor(n / 4000));
            const vals = [];
            for (let i = 0; i < n; i += step) vals.push(X[i * NF + f]);
            vals.sort((a, b) => a - b);
            const e = [];
            for (let q = 1; q < GBM.bins; q++) {
                const v = vals[Math.min(vals.length - 1, Math.floor(q * vals.length / GBM.bins))];
                if (!e.length || v > e[e.length - 1]) e.push(v);
            }
            edges.push(e);
        }
        return edges;
    }
    function binOf(e, v) { let lo = 0, hi = e.length; while (lo < hi) { const m = (lo + hi) >> 1; if (v <= e[m]) hi = m; else lo = m + 1; } return lo; }

    async function fitGbm(X, y, n, label) {
        const edges = makeBins(X, n);
        const B = new Uint8Array(n * NF);
        for (let i = 0; i < n; i++) for (let f = 0; f < NF; f++) B[i * NF + f] = binOf(edges[f], X[i * NF + f]);
        let base = 0;
        for (let i = 0; i < n; i++) base += y[i];
        base /= Math.max(1, n);
        const pred = new Float32Array(n).fill(base);
        const rand = rng(12345);
        const trees = [];
        const NB = GBM.bins;
        for (let t = 0; t < GBM.trees; t++) {
            const g = new Float32Array(n);
            for (let i = 0; i < n; i++) g[i] = y[i] - pred[i];
            const rows = [];
            for (let i = 0; i < n; i++) if (rand() < GBM.subsample) rows.push(i);
            const tree = { f: [], t: [], l: [], r: [], v: [] };
            const grow = (idxs, depth) => {
                const id = tree.f.length;
                tree.f.push(-1); tree.t.push(0); tree.l.push(-1); tree.r.push(-1); tree.v.push(0);
                let G = 0;
                for (let k = 0; k < idxs.length; k++) G += g[idxs[k]];
                const cnt = idxs.length;
                tree.v[id] = G / (cnt + GBM.lambda) * GBM.lr;
                if (depth >= GBM.depth || cnt < GBM.minLeaf * 2) return id;
                let bestGain = 1e-9, bf = -1, bb = -1;
                const parent = G * G / (cnt + GBM.lambda);
                const hg = new Float64Array(NB), hc = new Float64Array(NB);
                for (let f = 0; f < NF; f++) {
                    hg.fill(0); hc.fill(0);
                    for (let k = 0; k < idxs.length; k++) { const i = idxs[k]; const b = B[i * NF + f]; hg[b] += g[i]; hc[b] += 1; }
                    let gl = 0, cl = 0;
                    for (let b = 0; b < NB - 1; b++) {
                        gl += hg[b]; cl += hc[b];
                        if (cl < GBM.minLeaf || cnt - cl < GBM.minLeaf) continue;
                        const gr = G - gl, cr = cnt - cl;
                        const gain = gl * gl / (cl + GBM.lambda) + gr * gr / (cr + GBM.lambda) - parent;
                        if (gain > bestGain) { bestGain = gain; bf = f; bb = b; }
                    }
                }
                if (bf < 0) return id;
                const left = [], right = [];
                for (let k = 0; k < idxs.length; k++) { const i = idxs[k]; (B[i * NF + bf] <= bb ? left : right).push(i); }
                tree.f[id] = bf;
                tree.t[id] = edges[bf][Math.min(bb, edges[bf].length - 1)];
                tree.l[id] = grow(left, depth + 1);
                tree.r[id] = grow(right, depth + 1);
                return id;
            };
            grow(rows, 0);
            for (let i = 0; i < n; i++) pred[i] += evalTree(tree, X, i * NF);
            trees.push(tree);
            if (t % 6 === 5) { await tick(); S.sub = (t + 1) / GBM.trees; notify(); }
        }
        return { base, trees };
    }

    function evalTree(tree, X, off) {
        let id = 0;
        while (tree.f[id] >= 0) id = X[off + tree.f[id]] <= tree.t[id] ? tree.l[id] : tree.r[id];
        return tree.v[id];
    }
    function gbmPredict(m, x) {
        let v = m.base;
        for (let k = 0; k < m.trees.length; k++) {
            const tr = m.trees[k];
            let id = 0;
            while (tr.f[id] >= 0) id = x[tr.f[id]] <= tr.t[id] ? tr.l[id] : tr.r[id];
            v += tr.v[id];
        }
        return v;
    }

    // ---------- обучение ----------
    function signature(hist) {
        const last = hist.length ? hist[hist.length - 1].ts : 0;
        return hist.length + '|' + new Date(last).toISOString().slice(0, 10) + '|' + GBM.trees + '|v1';
    }

    function prepareHist() {
        if (typeof ForecastLab === 'undefined' || !ForecastLab.mlHistory) return [];
        const hist = ForecastLab.mlHistory(CURVE_H);
        hist.forEach(d => { d.dir = dirOf(d.base); d.dow = dowOf(d.ts); });
        hist.sort((a, b) => a.ts - b.ts);
        return hist;
    }

    function rowsFor(hist, key, idx, from, to, firstTs) {
        const { c: h0, lo, hi } = HZ[key];
        const rowsX = [], rowsY = [], rowsMeta = [];
        const buf = new Float32Array(NF);
        for (let i = from; i < to; i++) {
            const d = hist[i];
            if (d.ts - firstTs < 30 * DAY) continue;       // первые недели истории: нет опоры на прошлое
            for (let h = lo; h <= hi; h++) {
                const booked = features(buf, { cum: d.cum, s: d.s, ts: d.ts, base: d.base, dir: d.dir, dow: d.dow, h }, idx, h0);
                rowsX.push(Float32Array.from(buf));
                rowsY.push(Math.max(0, (d.sold - booked) / d.s));
                rowsMeta.push({ booked, cap: d.s, final: d.sold });
            }
        }
        const n = rowsX.length;
        const X = new Float32Array(n * NF);
        rowsX.forEach((r, i) => X.set(r, i * NF));
        return { X, y: Float32Array.from(rowsY), meta: rowsMeta, n };
    }

    const clipPred = (p, m) => Math.max(m.booked, Math.min(m.cap, p));

    function bestWeights(preds, meta, n) {
        // перебор весов (шаг 0,1) для трёх способов; минимум средней ошибки
        let best = { w: [0, 0, 1], mae: Infinity };
        for (let a = 0; a <= 10; a++) for (let b = 0; b <= 10 - a; b++) {
            const w = [a / 10, b / 10, (10 - a - b) / 10];
            let err = 0;
            for (let i = 0; i < n; i++) {
                const p = w[0] * preds[0][i] + w[1] * preds[1][i] + w[2] * preds[2][i];
                err += Math.abs(clipPred(p, meta[i]) - meta[i].final);
            }
            if (err / n < best.mae) best = { w, mae: err / n };
        }
        return best.w;
    }

    function score(preds, meta, n) {
        let ae = 0, ape = 0, k = 0;
        for (let i = 0; i < n; i++) {
            const e = Math.abs(clipPred(preds[i], meta[i]) - meta[i].final);
            ae += e;
            if (meta[i].final > 0) { ape += e / meta[i].final; k++; }
        }
        return { mae: ae / Math.max(1, n), mape: k ? ape / k * 100 : null, n };
    }

    async function train() {
        const hist = prepareHist();
        if (hist.length < MIN_FLIGHTS) {
            S = Object.assign(S, { status: 'nodata', hist, model: null, err: `улетевших вылетов с кривой продаж: ${hist.length}, нужно не меньше ${MIN_FLIGHTS}` });
            notify();
            return;
        }
        S.status = 'training'; S.progress = 0; S.hist = hist; notify();
        const firstTs = hist[0].ts;
        const cut = Math.floor(hist.length * 0.8);
        const cutTs = hist[cut].ts;
        const gap = hist.findIndex(d => d.ts >= cutTs - 35 * DAY);
        const metrics = {};
        const hz = {};
        let step = 0;
        for (const key of KEYS) {
            const { c: h0 } = HZ[key];
            const idx = buildIndex(hist, h0);
            await tick();
            const tr = rowsFor(hist, key, idx, 0, gap < 0 ? cut : gap, firstTs);
            const va = rowsFor(hist, key, idx, cut, hist.length, firstTs);
            if (tr.n < 200 || va.n < 50) { hz[key] = null; continue; }
            const m1 = await fitGbm(tr.X, tr.y, tr.n, key);
            // прогнозы на проверочной части
            const preds = [new Float64Array(va.n), new Float64Array(va.n), new Float64Array(va.n)];
            for (let i = 0; i < va.n; i++) {
                const x = va.X.subarray(i * NF, (i + 1) * NF);
                const mt = va.meta[i];
                preds[0][i] = simpleAdd(x, mt.booked, mt.cap);
                preds[1][i] = simpleRatio(x, mt.booked, mt.cap);
                preds[2][i] = mt.booked + gbmPredict(m1, x) * mt.cap;
            }
            const w = bestWeights(preds, va.meta, va.n);
            const ens = new Float64Array(va.n);
            for (let i = 0; i < va.n; i++) ens[i] = w[0] * preds[0][i] + w[1] * preds[1][i] + w[2] * preds[2][i];
            metrics[key] = {
                _baseline_booked: score(va.meta.map(m => m.booked), va.meta, va.n),
                hmean: score(preds[0], va.meta, va.n),
                ratio: score(preds[1], va.meta, va.n),
                gbm: score(preds[2], va.meta, va.n),
                ensemble: score(ens, va.meta, va.n)
            };
            // окончательная модель — на всех вылетах
            const all = rowsFor(hist, key, idx, 0, hist.length, firstTs);
            const mf = await fitGbm(all.X, all.y, all.n, key);
            hz[key] = { w, gbm: mf };
            step++;
            S.progress = step / KEYS.length; notify();
            await tick();
        }
        const model = {
            sig: signature(hist), trainedAt: new Date().toISOString(), nFlights: hist.length,
            period: { from: ymd(hist[0].ts), to: ymd(hist[hist.length - 1].ts) },
            metrics, hz
        };
        S.model = model;
        S.idx = {};
        KEYS.forEach(k => { S.idx[k] = buildIndex(hist, HZ[k].c); });
        S.tpl.clear();
        S.status = 'ready';
        save(model);
        notify();
    }

    function save(model) {
        try {
            const slim = JSON.stringify(model, (k, v) => (typeof v === 'number' ? Math.round(v * 1e5) / 1e5 : v));
            localStorage.setItem(STORE_KEY, slim);
        } catch (e) { /* не влезло — переобучится в следующий раз */ }
    }
    function load() {
        try { const s = localStorage.getItem(STORE_KEY); return s ? JSON.parse(s) : null; } catch (e) { return null; }
    }

    // Подготовка: если сохранённая модель свежая — берём её, иначе обучаем. Параллельные вызовы ждут один и тот же расчёт.
    function ensure() {
        if (S.running) return S.running;
        if (S.status === 'ready' && S.model && S.sigNow === dataSig()) return Promise.resolve();
        S.running = (async () => {
            try {
                const hist = prepareHist();
                S.sigNow = dataSig();
                if (hist.length < MIN_FLIGHTS) {
                    S = Object.assign(S, { status: 'nodata', hist, model: null, err: `улетевших вылетов с кривой продаж: ${hist.length}, нужно не меньше ${MIN_FLIGHTS}` });
                    notify();
                    return;
                }
                const saved = load();
                if (saved && saved.sig === signature(hist) && saved.hz) {
                    S.hist = hist; S.model = saved; S.idx = {};
                    KEYS.forEach(k => { S.idx[k] = buildIndex(hist, HZ[k].c); });
                    S.tpl.clear();
                    S.status = 'ready';
                    notify();
                    return;
                }
                await train();
            } catch (e) {
                console.warn('MlModel', e);
                S.status = 'error'; S.err = String(e && e.message || e);
                notify();
            } finally {
                S.running = null;
            }
        })();
        return S.running;
    }

    function dataSig() {
        return [typeof dataEpoch === 'number' ? dataEpoch : 0, typeof getTodayDate === 'function' ? getTodayDate() : '',
            typeof SalesArchive !== 'undefined' && SalesArchive.revision ? SalesArchive.revision() : 0].join('|');
    }

    function health() {
        const m = S.model;
        if (S.status === 'ready' && m) {
            // Период — по истории в памяти (местные даты): у модели, сохранённой раньше, он мог быть записан со сдвигом на сутки.
            const hs = S.hist && S.hist.length ? S.hist : null;
            const period = hs ? { from: ymd(hs[0].ts), to: ymd(hs[hs.length - 1].ts) } : m.period;
            return { status: 'ok', model_loaded: true, version: m.sig, trained_at: m.trainedAt, n_flights: m.nFlights, data_period: period, metrics: m.metrics };
        }
        if (S.status === 'training') return { status: 'training', model_loaded: false, progress: S.progress };
        return { status: 'no_model', model_loaded: false, detail: S.err || '' };
    }

    // ---------- прогноз ----------
    function template(base, dir, asOf) {
        const key = base + '|' + Math.floor(asOf / DAY);
        if (S.tpl.has(key)) return S.tpl.get(key);
        const hist = S.hist || [];
        let out = null;
        for (const pick of [d => d.base === base, d => d.dir === dir, () => true]) {
            const sel = [];
            for (let i = hist.length - 1; i >= 0 && sel.length < 40; i--) if (hist[i].ts < asOf && pick(hist[i])) sel.push(hist[i]);
            if (sel.length >= 3) {
                out = new Array(CURVE_H + 1).fill(0);
                sel.forEach(d => d.cum.forEach((v, k) => { out[k] += v / d.s / sel.length; }));       // в долях мест
                break;
            }
        }
        S.tpl.set(key, out);
        return out;
    }

    // Кривая вылета: известная часть — из данных сайта (если вылет есть), будущая — по типичной кривой, приведённой к темпу.
    function requestCurve(base, dir, ts, cb, cap, dtd, live) {
        const T = template(base, dir, ts - dtd * DAY);
        const c = new Array(CURVE_H + 1);
        const Td = T ? Math.max(T[Math.min(dtd, CURVE_H)] * cap, 1e-6) : 0;
        const scale = T ? Math.min(4, Math.max(0.25, cb / Td)) : 1;
        for (let k = 0; k <= CURVE_H; k++) {
            if (k >= dtd) {
                if (live && live.cum[k] != null) c[k] = Math.min(live.cum[k], cb);
                else c[k] = T ? cb * (T[k] * cap) / Td : cb;
            } else {
                c[k] = T ? cb + (T[k] * cap - T[Math.min(dtd, CURVE_H)] * cap) * scale : cb;
            }
        }
        for (let k = 1; k <= CURVE_H; k++) if (c[k] > c[k - 1]) c[k] = c[k - 1];        // не растёт к ранним дням
        c[Math.min(dtd, CURVE_H)] = Math.min(c[Math.min(dtd, CURVE_H)], cb);
        return c;
    }

    function parseDate(s) {
        const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(s || '').trim());
        if (!m) return null;
        const d = new Date(+m[3], +m[2] - 1, +m[1]);
        return d.getMonth() === +m[2] - 1 ? d : null;
    }

    const FLAG_PENALTY = { far_from_horizon: 0.85, sparse_route: 0.85, fallback_model: 0.85, clipped_to_capacity: 0.9, clipped_to_booked: 0.9 };

    function predictOne(it) {
        const date = parseDate(it.flydate);
        if (!date) throw new Error('дата вылета должна быть в виде ДД.ММ.ГГГГ');
        const cb = Number(it.current_booked), cap = Number(it.total_au), dtd = Math.round(Number(it.dtd));
        if (!(cap > 0) || !(cb >= 0) || !(dtd >= 0 && dtd <= 180)) throw new Error('проверьте числа: продано ≥ 0, мест > 0, дней до вылета 0–180');
        const code = String(it.reis).toUpperCase();
        const base = typeof getBaseFlight === 'function' ? getBaseFlight(code) : code;
        const dir = dirOf(base);
        const ts = date.getTime();
        const dow = dowOf(ts);
        const live = typeof ForecastLab !== 'undefined' && ForecastLab.mlLive ? ForecastLab.mlLive(code, it.flydate, CURVE_H) : null;
        const curve = requestCurve(base, dir, ts, Math.min(cb, cap), cap, dtd, live && Math.abs(live.cum[Math.min(dtd, CURVE_H)] - cb) <= Math.max(2, cb * 0.15) ? live : null);
        const horizons = {};
        const flags = [];
        const per = {};
        let allOk = true;
        const buf = new Float32Array(NF);
        KEYS.forEach(key => {
            const { c: h0, lo, hi } = HZ[key];
            const hzm = S.model.hz[key];
            const h = dtd >= lo && dtd <= hi ? dtd : h0;
            const dist = Math.abs(h - dtd);
            const fl = [];
            let pred, conf;
            try {
                if (!hzm) throw new Error('нет модели срока');
                const booked = features(buf, { cum: curve, s: cap, ts, base, dir, dow, h }, S.idx[key], h0);
                const x = Array.from(buf);
                const raw = hzm.w[0] * simpleAdd(x, booked, cap) + hzm.w[1] * simpleRatio(x, booked, cap) + hzm.w[2] * (booked + gbmPredict(hzm.gbm, x) * cap);
                if (!Number.isFinite(raw)) throw new Error('не число');
                pred = raw;
                if (dist >= 7) fl.push('far_from_horizon');
                if (x[16] < 10) fl.push('sparse_route');
                const mae = S.model.metrics[key] && S.model.metrics[key].ensemble ? S.model.metrics[key].ensemble.mae : null;
                const scale = Math.max(pred - cb, 0.1 * cap, 1);
                conf = 0.97 * Math.exp(-0.05 * dist) * (mae != null ? 1 / (1 + 2 * mae / scale) : 0.7);
            } catch (e) {
                pred = cb; conf = 0.05; fl.push('service_error'); allOk = false;
            }
            if (cb > cap) { fl.push('total_au_below_booked'); pred = cb; allOk = false; }
            else if (pred > cap) { pred = cap; fl.push('clipped_to_capacity'); }
            if (pred < cb) { pred = cb; fl.push('clipped_to_booked'); }
            fl.forEach(f => { conf *= FLAG_PENALTY[f] || 1; });
            horizons[key] = { pred: Math.round(pred), confidence: Math.round(Math.min(0.99, Math.max(0.05, conf)) * 1e4) / 1e4 };
            per[key] = fl;
            fl.forEach(f => flags.push(key + ':' + f));
        });
        const near = KEYS.reduce((a, k) => Math.abs(HZ[k].c - dtd) < Math.abs(HZ[a].c - dtd) ? k : a, KEYS[0]);
        return { reis: code, flydate: it.flydate, horizons, critic: { ok: allOk, chosen_model: 'ensemble_' + near, flags } };
    }

    // Много рейсов за раз. Ответ — как у API: [{ ok, result } | { ok: false, error }].
    function predictMany(items) {
        if (S.status !== 'ready' || !S.model) return items.map(() => ({ ok: false, error: 'модель ещё не обучена' }));
        return items.map(it => {
            try { return { ok: true, result: predictOne(it) }; } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
        });
    }

    return { ensure, health, predictMany, onChange, status: () => S.status, reset: () => { S.sigNow = ''; } };
})();
