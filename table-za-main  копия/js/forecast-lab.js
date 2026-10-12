// Прогноз загрузки, который учится (пока только для администратора).
// 1. Журнал прогнозов — shared/forecast-log/ГГГГ-ММ.json (по месяцу вылета). Раз в день у администратора
//    по каждому будущему вылету записывается, что было известно за 30/21/14/10/7/5/3/1 день до вылета:
//    продано (o), кресла (s), итог по файлу ожидаемой загрузки (p) и его значение на этот день (q),
//    прогноз по истории (y) и прогноз модели (m). После вылета дописывается факт (f).
//    Улетевшие вылеты из текущих данных восстанавливаются задним числом (b: 1) — журнал не пустой с первого дня.
// 2. Отчёт «Точность прогноза» («Отчёты»): ошибка каждого способа по горизонтам, по неделям и направлениям.
// 3. Модель: гребневая регрессия по журналу — сколько ещё доберёт вылет (в долях кресел) по продажам на сейчас,
//    добору по файлу и прогнозу по истории, плюс поправка по рейсу. Проверка честная: модель для каждой недели
//    обучается только на более ранних неделях. Включается, когда в журнале достаточно вылетов с фактом.
window.ForecastLab = (function () {
    const HORIZONS = [30, 21, 14, 10, 7, 5, 3, 1];
    const GROUPS = [{ id: 'near', label: '1–3 дня', hs: [1, 3] }, { id: 'mid', label: '5–10 дней', hs: [5, 7, 10] }, { id: 'far', label: '14–30 дней', hs: [14, 21, 30] }];
    const MIN_TRAIN = 150;          // записей с фактом в группе горизонтов, чтобы модель включилась
    const MIN_TRAIN_H = 80;         // записей на одном горизонте, чтобы у него была своя модель
    const LAMBDA = 0.5;             // гребневая регуляризация
    const ROUTE_K = 10;             // сглаживание поправки по рейсу: n / (n + K)
    const MONTHS_BACK = 6;
    const DONE_KEY = 'krasavia_fclog_done';
    const DAY = 86400000;

    let log = Object.create(null);  // 'дд.мм.гггг|KV-101' → { b: base, s, f, h: { '7': { d, o, p, q, y, n, m, b } } }
    const loadedMonths = new Set();
    let loading = null;
    let loaded = false;
    let models = null;              // { near: {w, n}, ... , route: {base: corr}, trainedOn }
    let rev = 0;
    let lastCapture = null;         // { at, recorded, finals, backfilled }

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

    function groupOf(h) {
        return GROUPS.find(g => g.hs.includes(Number(h))) || GROUPS[GROUPS.length - 1];
    }

    function num(v) {
        return v == null || v === '' || !isFinite(v) ? null : Math.round(Number(v));
    }

    function normEntry(e) {
        if (!e || typeof e !== 'object' || !e.h || typeof e.h !== 'object') return null;
        const out = { b: String(e.b || ''), s: num(e.s) || 0, f: num(e.f), h: {} };
        Object.keys(e.h).forEach(h => {
            if (!HORIZONS.includes(Number(h))) return;
            const r = e.h[h];
            if (!r || typeof r !== 'object' || num(r.o) == null) return;
            out.h[h] = { d: num(r.d), o: num(r.o), p: num(r.p), q: num(r.q), y: num(r.y), n: num(r.n), m: num(r.m), b: r.b ? 1 : 0, s: num(r.s) };
        });
        return out;
    }

    // Слить запись: живые записи важнее восстановленных, факт берётся любой известный.
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
            if (!a || (a.b && !b.b)) { cur.h[h] = b; changed = true; }
        });
        return changed;
    }

    // ---------- чтение ----------

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

    function ensureLoaded() {
        if (!loading) {
            const m0 = monthOf(today());
            const months = [];
            for (let i = -MONTHS_BACK; i <= 2; i++) months.push(shiftMonth(m0, i));
            loading = Promise.all(months.map(readMonth)).then(() => { loaded = true; models = null; rev++; });
        }
        return loading;
    }

    // ---------- признаки и модель ----------

    // Признаки записи r (горизонт h) для вылета с s креслами. Цель — сколько доберёт в долях кресел.
    function features(r, h, s) {
        const o = r.o / s;
        const planPick = r.p != null && r.q != null ? Math.max(0, (r.p - r.q) / s) : 0;
        const planLeft = r.p != null ? Math.max(0, r.p / s - o) : 0;
        const histPick = r.y != null ? Math.max(0, (r.y - r.o) / s) : 0;
        return [1, o, planPick, planLeft, histPick, r.y != null ? 1 : 0, r.p != null ? 1 : 0, Math.min(1, (r.d != null ? r.d : h) / 30)];
    }

    // Решить (XᵀX + λI) w = Xᵀy методом Гаусса (8×8).
    function ridge(X, y) {
        const k = X[0].length;
        const A = Array.from({ length: k }, () => new Array(k).fill(0));
        const b = new Array(k).fill(0);
        X.forEach((x, i) => {
            for (let a = 0; a < k; a++) {
                b[a] += x[a] * y[i];
                for (let c = 0; c < k; c++) A[a][c] += x[a] * x[c];
            }
        });
        for (let a = 1; a < k; a++) A[a][a] += LAMBDA;  // свободный член не штрафуем
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

    function dot(w, x) {
        let s = 0;
        for (let i = 0; i < w.length; i++) s += w[i] * x[i];
        return s;
    }

    // Обучающие примеры: [{ key, base, date, ts, h, s, r, f }] — только с фактом.
    function samples(filterFn) {
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
                const smp = { key, base: e.b, date, ts: d.getTime(), h: Number(h), s, r, f: e.f };
                if (!filterFn || filterFn(smp)) out.push(smp);
            });
        });
        return out;
    }

    function train(list) {
        const res = { trainedOn: list.length, route: {} };
        const fit = (sub) => ({ w: ridge(sub.map(x => features(x.r, x.h, x.s)), sub.map(x => (x.f - x.r.o) / x.s)), n: sub.length });
        GROUPS.forEach(g => {
            const sub = list.filter(x => g.hs.includes(x.h));
            res[g.id] = sub.length < MIN_TRAIN ? null : fit(sub);
        });
        // Свой горизонт, когда примеров хватает: за 1 день до вылета добор совсем не такой, как за 3.
        res.byH = {};
        HORIZONS.forEach(h => {
            const sub = list.filter(x => x.h === h);
            if (sub.length >= MIN_TRAIN_H) res.byH[h] = fit(sub);
        });
        // Поправка по рейсу: средняя остаточная ошибка модели, сжатая к нулю при малом числе вылетов.
        const acc = {};
        list.forEach(x => {
            const m = res.byH[x.h] || res[groupOf(x.h).id];
            if (!m) return;
            const pred = x.r.o / x.s + dot(m.w, features(x.r, x.h, x.s));
            const a = acc[x.base] || (acc[x.base] = { sum: 0, n: 0 });
            a.sum += x.f / x.s - pred;
            a.n++;
        });
        Object.keys(acc).forEach(b => { res.route[b] = (acc[b].sum / acc[b].n) * (acc[b].n / (acc[b].n + ROUTE_K)); });
        return res;
    }

    function predictWith(m, r, h, s, base) {
        const g = m && ((m.byH && m.byH[h]) || m[groupOf(h).id]);
        if (!g) return null;
        const lf = r.o / s + dot(g.w, features(r, h, s)) + (m.route[base] || 0);
        return Math.max(r.o, Math.min(s, Math.round(lf * s)));
    }

    function model() {
        if (!models) models = train(samples());
        return models;
    }

    function ready() {
        const m = model();
        return !!(m && GROUPS.some(g => m[g.id]));
    }

    // ---------- что известно о вылете сейчас ----------

    function horizonFor(dtd) {
        for (let i = HORIZONS.length - 1; i >= 0; i--) if (HORIZONS[i] >= dtd) return HORIZONS[i];
        return null;
    }

    function liveRecord(base, code, date, row, dtd) {
        const s = getSeatsOnSale(row);
        if (!(s > 0)) return null;
        const cap = getCapacityFromAircraft(getAircraftType(row[4]));
        const wk = getWeekForExpectedLoad(date);
        const p = getExpectedLoad(cap, base, 0, wk);
        const q = getExpectedLoad(cap, base, dtd, wk);
        let y = null;
        let n = null;
        if (typeof FlightInsights !== 'undefined') {
            const f = FlightInsights.forecast(code, date);
            if (f && f.source === 'history') { y = f.final; n = f.n; }
        }
        return { d: dtd, o: getSoldFromRow(row), p: num(p), q: num(q), y: num(y), n, m: null, b: 0, s };
    }

    // Лучший прогноз для вылета (для карточки): способ, который на этом горизонте ошибался меньше всех.
    // null — данных для выбора ещё мало.
    function predict(code, date) {
        if (!isAdmin() || !loaded) return null;
        const base = getBaseFlight(code);
        const row = typeof getFlightRowForDate === 'function' ? getFlightRowForDate(base, date, code) : null;
        const dtd = typeof getDaysUntil === 'function' ? getDaysUntil(date) : null;
        if (!row || dtd == null || dtd <= 0 || dtd > 30) return null;
        const h = horizonFor(dtd);
        const r = liveRecord(base, code, date, row, dtd);
        if (!r || !h) return null;
        const pick = evaluation().choice[h];
        if (!pick) return null;
        let final = null;
        if (pick.k === 'model') final = predictWith(model(), r, h, r.s, base);
        else if (pick.k === 'planPick') final = r.p != null && r.q != null ? Math.max(r.o, Math.min(r.s, Math.round(r.o + r.p - r.q))) : null;
        else if (pick.k === 'hist') final = r.y;
        else final = r.o;
        if (final == null) final = predictWith(model(), r, h, r.s, base);
        if (final == null) return null;
        return { final, seats: r.s, lf: Math.round(final / r.s * 100), method: METHOD_LABEL[pick.k], err: Math.round(pick.v * 10) / 10, trainedOn: pick.n, h };
    }

    // ---------- запись журнала ----------

    // Восстановить записи улетевшего вылета по кривой продаж (что было продано за h дней до вылета).
    function backfill(base, code, date, row, byBase) {
        const s = getSeatsOnSale(row);
        const f = getSoldFromRow(row);
        if (!(s > 0) || !(f > 0)) return null;
        const raw = typeof buildOnHandByDtd === 'function' ? buildOnHandByDtd(date, code) : null;
        if (!raw || !(raw.total > 0)) return null;
        const at = (curve, d) => { const v = curve.onHand[d]; return v != null ? v : (d > curve.maxDtd ? 0 : curve.total); };
        const fly = parseLocalDate(date);
        const cap = getCapacityFromAircraft(getAircraftType(row[4]));
        const wk = getWeekForExpectedLoad(date);
        const p = getExpectedLoad(cap, base, 0, wk);
        const e = { b: base, s, f, h: {} };
        HORIZONS.forEach(h => {
            const asOf = fly.getTime() - h * DAY;
            const o = Math.min(f, at(raw, h));
            // Прогноз по истории: те же дни недели, улетевшие до этого момента (±8 недель).
            const coh = (byBase[base] || []).filter(c => c.ts < asOf && c.dow === fly.getDay() && fly.getTime() - c.ts <= 56 * DAY);
            let y = null;
            if (coh.length >= 2) {
                const lf = coh.reduce((a, c) => a + Math.max(0, (c.f - at(c.curve, h)) / c.s), 0) / coh.length;
                y = Math.max(o, Math.min(s, Math.round(o + lf * s)));
            }
            e.h[h] = { d: h, o, p: num(p), q: num(getExpectedLoad(cap, base, h, wk)), y, n: coh.length || null, m: null, b: 1, s };
        });
        return e;
    }

    function dataToken() {
        const at = typeof lastSalesUpdate !== 'undefined' && lastSalesUpdate ? new Date(lastSalesUpdate).getTime() : 0;
        return `${today()}|${at}|${(typeof allData !== 'undefined' && allData ? allData.length : 0)}`;
    }

    const pause = () => new Promise(r => setTimeout(r, 0));

    async function capture(force) {
        if (!isAdmin() || typeof SharedStorage === 'undefined') return false;
        if (typeof groupedData === 'undefined' || !Object.keys(groupedData || {}).length) return false;
        const token = dataToken();
        if (!force) { try { if (localStorage.getItem(DONE_KEY) === token) return true; } catch (e) { /* ignore */ } }
        if (!(await SharedStorage.canWrite())) return false;
        await ensureLoaded();
        const todayTs = parseLocalDate(today()).getTime();
        const additions = Object.create(null);   // month → key → entry
        const add = (key, date, e) => { const m = monthOf(date); (additions[m] || (additions[m] = Object.create(null)))[key] = e; };
        const m = model();
        let recorded = 0;
        let finals = 0;
        let backfilled = 0;

        // Улетевшие вылеты текущих данных: кривые для «истории» и восстановление записей.
        const flown = [];
        const byBase = Object.create(null);
        Object.keys(groupedData).forEach(base => {
            const seen = new Set();
            (groupedData[base] || []).forEach(row => {
                const date = row[1];
                const t = parseLocalDate(date);
                if (!t || seen.has(date) || t.getTime() >= todayTs) return;
                seen.add(date);
                const code = cleanFlight(row[0]);
                const sc = getFlightSalesList(date, code).length ? code : base;
                const s = getSeatsOnSale(row);
                const f = getSoldFromRow(row);
                if (!(s > 0) || !(f > 0)) return;
                const curve = anchorCurveToLoad(departureCurve(date, sc), f);
                if (!curve || !(curve.total > 0)) return;
                const item = { base, code: sc, date, row, ts: t.getTime(), dow: t.getDay(), s, f, curve };
                flown.push(item);
                (byBase[base] || (byBase[base] = [])).push(item);
            });
        });

        let i = 0;
        for (const x of flown) {
            const key = x.date + '|' + cleanFlight(x.row[0]);
            const cur = log[key];
            if (cur && cur.f == null) { add(key, x.date, { b: x.base, s: x.s, f: x.f, h: {} }); finals++; }
            const fresh = observedFromDtd(x.date) === 0 && (!cur || HORIZONS.some(h => !cur.h[h]));
            if (fresh) {
                const e = backfill(x.base, x.code, x.date, x.row, byBase);
                if (e) { add(key, x.date, e); backfilled++; }
            }
            if (++i % 50 === 0) await pause();
        }

        // Будущие вылеты в пределах 30 дней: запись на ближайшем горизонте, если её ещё нет.
        i = 0;
        for (const base of Object.keys(groupedData)) {
            const seen = new Set();
            for (const row of groupedData[base] || []) {
                const date = row[1];
                if (seen.has(date)) continue;
                seen.add(date);
                const dtd = getDaysUntil(date);
                if (dtd == null || dtd <= 0 || dtd > 30) continue;
                const h = horizonFor(dtd);
                const code = cleanFlight(row[0]);
                const key = date + '|' + code;
                if (log[key] && log[key].h[h] && !log[key].h[h].b) continue;
                const r = liveRecord(base, code, date, row, dtd);
                if (!r) continue;
                r.m = predictWith(m, r, h, r.s, base);
                add(key, date, { b: base, s: r.s, f: null, h: { [h]: r } });
                recorded++;
                if (++i % 40 === 0) await pause();
            }
        }

        // Запись по месяцам: перечитать файл, слить, записать (как архив продаж).
        let ok = true;
        for (const month of Object.keys(additions)) {
            const read = await SharedStorage.readJsonFileStrict(fileOf(month)).catch(() => ({ ok: false }));
            if (!read.ok) { ok = false; continue; }
            const merged = Object.create(null);
            const remote = read.data && read.data.flights;
            if (remote && typeof remote === 'object') Object.keys(remote).forEach(k => { const e = normEntry(remote[k]); if (e) merged[k] = e; });
            let changed = false;
            Object.keys(additions[month]).forEach(k => { if (mergeEntry(merged, k, additions[month][k])) changed = true; });
            if (changed) {
                const written = await SharedStorage.writeJsonFile(fileOf(month), { version: 1, updatedAt: new Date().toISOString(), flights: merged });
                ok = written && ok;
            }
            Object.keys(merged).forEach(k => mergeEntry(log, k, merged[k]));
        }
        models = null;
        rev++;
        lastCapture = { at: Date.now(), recorded, finals, backfilled, ok };
        if (ok) { try { localStorage.setItem(DONE_KEY, token); } catch (e) { /* ignore */ } }
        return ok;
    }

    function afterStart() {
        if (!isAdmin()) return;
        const run = () => capture().catch(e => console.warn('ForecastLab.capture', e));
        if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 30000 });
        else setTimeout(run, 5000);
    }

    // ---------- отчёт ----------

    // Ошибки способов на всех примерах. Модель — «вперёд по времени»: для недели вылета обучена на более ранних.
    function evaluate() {
        const all = samples();
        all.sort((a, b) => a.ts - b.ts);
        const weekOf = (ts) => Math.floor((ts - 4 * DAY) / (7 * DAY));
        const weeks = [...new Set(all.map(x => weekOf(x.ts)))].sort((a, b) => a - b);
        const modelPred = new Map();
        weeks.forEach(w => {
            const trainSet = all.filter(x => weekOf(x.ts) < w);
            const m = train(trainSet);
            all.filter(x => weekOf(x.ts) === w).forEach(x => {
                const v = predictWith(m, x.r, x.h, x.s, x.base);
                if (v != null) modelPred.set(x, v);
            });
        });
        const methods = {
            naive: (x) => x.r.o,
            plan: (x) => (x.r.p != null ? Math.min(x.s, x.r.p) : null),
            planPick: (x) => (x.r.p != null && x.r.q != null ? Math.max(x.r.o, Math.min(x.s, Math.round(x.r.o + x.r.p - x.r.q))) : null),
            hist: (x) => x.r.y,
            model: (x) => (modelPred.has(x) ? modelPred.get(x) : null)
        };
        const byH = {};
        HORIZONS.forEach(h => { byH[h] = {}; Object.keys(methods).forEach(k => { byH[h][k] = { sum: 0, bias: 0, n: 0 }; }); byH[h].total = 0; });
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
                const md = methods.model(x) != null ? methods.model(x) : (methods.hist(x) != null ? methods.hist(x) : methods.planPick(x));
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
        // Что брать на каждом горизонте: способ с наименьшей ошибкой на прошлых вылетах (от 30 записей).
        const choice = {};
        HORIZONS.forEach(h => {
            let best = null;
            ['model', 'planPick', 'hist', 'naive'].forEach(k => {
                const c = byH[h][k];
                if (c.n < 30) return;
                const v = c.sum / c.n;
                if (!best || v < best.v - 1e-9) best = { k, v, n: c.n };
            });
            choice[h] = best;
        });
        return { byH, byWeek, byBase, choice, samples: all.length, departures: new Set(all.map(x => x.key)).size };
    }

    let evalMemo = { rev: -1, ev: null };
    function evaluation() {
        if (evalMemo.rev !== rev) evalMemo = { rev, ev: evaluate() };
        return evalMemo.ev;
    }

    const METHOD_LABEL = { model: 'модель', planPick: 'продано + добор по файлу', hist: 'по истории', naive: 'продано на сейчас' };

    let memo = { rev: -1, html: '' };
    let loadStarted = false;

    function mae(c) {
        return c && c.n ? (c.sum / c.n) : null;
    }

    function fmt(v) {
        return v == null ? '—' : (Math.round(v * 10) / 10).toLocaleString('ru-RU');
    }

    function html(rerender) {
        if (!canView()) return '<p class="rp-note">Раздел доступен только администратору.</p>';
        if (!loadStarted) {
            loadStarted = true;
            ensureLoaded().then(() => { memo.rev = -1; if (typeof rerender === 'function') rerender(); });
        }
        if (!loaded) return '<p class="rp-note">Загружаю журнал прогнозов…</p>';
        if (memo.rev === rev && memo.html) return memo.html;
        const ev = evaluation();
        const m = model();
        const futureKeys = Object.keys(log).filter(k => log[k].f == null).length;
        const ready = GROUPS.filter(g => m[g.id]);
        const status = ready.length
            ? `Модель обучена (${ready.map(g => `${g.label}: ${m[g.id].n} записей`).join(' · ')}). На каждом горизонте берётся способ, который ошибался меньше всех («Что берём»); его прогноз виден в карточке рейса.`
            : `Модель ещё учится: для каждой группы горизонтов нужно от ${MIN_TRAIN} записей с фактом. Пока только сравнение способов.`;
        const cols = [['naive', 'Продано на сейчас'], ['plan', 'Файл ожидаемой, итог'], ['planPick', 'Продано + добор по файлу'], ['hist', 'По истории (как на сайте)'], ['model', 'Модель']];
        const rowsH = HORIZONS.map(h => {
            const B = ev.byH[h];
            const vals = cols.map(([k]) => mae(B[k]));
            // Лучший — только среди способов, где записей достаточно для вывода.
            const best = Math.min(...vals.filter((v, i) => v != null && B[cols[i][0]].n >= 30));
            return `<tr><td><strong>${h} ${h === 1 ? 'день' : (h < 5 ? 'дня' : 'дней')}</strong></td>${cols.map(([k], i) => {
                const v = vals[i];
                const b = B[k].n ? B[k].bias / B[k].n : null;
                return `<td class="${v != null && v === best ? 'fl-best' : ''}">${fmt(v)}${v != null ? `<div class="rp-muted">${B[k].n} · ${b > 0 ? 'завышает' : 'занижает'} на ${fmt(Math.abs(b))}</div>` : ''}</td>`;
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
        const cap = lastCapture && (lastCapture.recorded || lastCapture.backfilled || lastCapture.finals)
            ? `Последняя запись журнала: прогнозов ${lastCapture.recorded}, восстановлено вылетов ${lastCapture.backfilled}, дописан факт ${lastCapture.finals}.` : '';
        memo = {
            rev,
            html: `
            <section class="rp-card">
                <div class="rp-card-head"><h3 class="rp-card-title">Точность прогноза загрузки</h3><span class="fl-admin">только администратор</span></div>
                <p class="rp-card-text">Каждый день сайт записывает прогноз по каждому вылету за 30, 21, 14, 10, 7, 5, 3 и 1 день до вылета, а после вылета — факт.
                    Здесь видно, насколько ошибается каждый способ. Ошибка — в пассажирах, в среднем по вылетам; под числом — сколько вылетов и в какую сторону ошибается. Модель учится на этом же журнале и
                    проверяется честно: для каждой недели — обученная только на более ранних неделях.</p>
                <div class="dr-kpis">
                    <div class="dr-kpi"><div class="dr-kpi-label">Вылетов с фактом</div><div class="dr-kpi-value">${ev.departures}</div><div class="dr-kpi-sub">записей прогноза: ${ev.samples}</div></div>
                    <div class="dr-kpi"><div class="dr-kpi-label">Ждут вылета</div><div class="dr-kpi-value">${futureKeys}</div><div class="dr-kpi-sub">факт допишется после вылета</div></div>
                    <div class="dr-kpi ${ready.length ? 'dr-kpi-up' : ''}"><div class="dr-kpi-label">Модель</div><div class="dr-kpi-value">${ready.length ? 'обучена' : 'учится'}</div><div class="dr-kpi-sub">${ready.length}/${GROUPS.length} групп горизонтов</div></div>
                </div>
                <p class="rp-note">${esc(status)} ${esc(cap)}</p>
                <div class="dr-list-title">Ошибка по горизонтам, пасс.</div>
                <div class="rp-scroll"><table class="rp-table">
                    <thead><tr><th>За сколько до вылета</th>${cols.map(([, l]) => `<th>${esc(l)}</th>`).join('')}<th title="Этот способ показывается в карточке рейса">Что берём</th></tr></thead>
                    <tbody>${rowsH}</tbody></table></div>
                <div class="dr-sums">
                    <div class="dr-sum"><div class="dr-sum-title">По неделям вылета, за 7 дней</div>
                        ${rowsW ? `<table class="rp-table dr-sum-table"><thead><tr><th>Неделя</th><th>Файл ожидаемой</th><th>Модель / лучший</th><th>Вылетов</th></tr></thead><tbody>${rowsW}</tbody></table>` : '<p class="rp-note">Пока нет данных.</p>'}
                    </div>
                    <div class="dr-sum"><div class="dr-sum-title">Где ошибается сильнее всего, за 7 дней</div>
                        ${rowsR ? `<table class="rp-table dr-sum-table"><thead><tr><th>Рейс</th><th>Файл ожидаемой</th><th>Модель / лучший</th><th>Вылетов</th></tr></thead><tbody>${rowsR}</tbody></table>` : '<p class="rp-note">Пока нет данных.</p>'}
                    </div>
                </div>
                <div class="ref-toolbar"><button type="button" class="btn-secondary rp-btn" id="fl-capture">Записать прогнозы сейчас</button>
                    <span class="rp-muted">Обычно это происходит само раз в день при входе администратора.</span></div>
            </section>`
        };
        return memo.html;
    }

    function handleClick(btn, rerender) {
        if (btn.id !== 'fl-capture') return false;
        btn.disabled = true;
        capture(true).then(ok => {
            if (typeof showToast === 'function') showToast(ok ? 'Прогнозы записаны в журнал' : 'Не удалось записать журнал (нет доступа к общей папке?)', ok ? undefined : 'error');
            memo.rev = -1;
            rerender();
        }).catch(e => { console.warn(e); btn.disabled = false; });
        return true;
    }

    return { canView, html, handleClick, capture, afterStart, ensureLoaded, predict, ready, revision: () => rev, HORIZONS };
})();
