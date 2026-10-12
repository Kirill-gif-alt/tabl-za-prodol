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
    const VERSION = 2;              // формат журнала; файл новее — не перезаписываем
    const BACKFILL_V = 2;           // правила восстановления; старее — пересчитываются
    const MIN_CHOICE_SEG = 30;      // записей в сегменте (есть файл / есть история / нет ничего), чтобы выбирать для него отдельно
    const SWITCH_T = 1.0;           // смена выбранного способа — только при заметно меньшей ошибке (t-статистика разницы)
    const CHOICE_KEY = 'krasavia_fc_choice';
    const TRAIN_MAX = 6000;         // обучение — на последних записях (быстрее, свежее)
    const EVAL_WEEKS = 12;          // проверка — на последних неделях
    const DONE_KEY = 'krasavia_fclog_done';
    const DAY = 86400000;

    let log = Object.create(null);  // 'дд.мм.гггг|KV-101' → { b: base, s, f, h: { '7': { d, o, p, q, y, n, m, b, s, x } } }
    const loadedMonths = new Set();
    let loading = null;
    let loaded = false;
    let models = null;              // обученные на всём журнале (для карточки)
    let evalState = { sig: '', ev: null, run: 0, busy: false, waiters: [] };
    let rev = 0;
    let loadMonth = '';             // месяц, от которого считали окно журнала
    let failedMonths = 0;
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

    // Неделя — с понедельника по местному времени.
    function weekOf(ts) {
        const d = new Date(ts);
        return new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).getTime();
    }

    // Дней от среза данных продаж до вылета (данные могут быть старше «сегодня»).
    function dataLagDays() {
        if (typeof salesDataCutoffTime !== 'function') return 0;
        const c = salesDataCutoffTime();
        if (!c) return 0;
        const cd = new Date(c);
        const day = new Date(cd.getFullYear(), cd.getMonth(), cd.getDate()).getTime();
        return Math.max(0, Math.round((todayTs() - day) / DAY));
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
            out.h[h] = { d: num(r.d), o: num(r.o), p: num(r.p), q: num(r.q), y: num(r.y), n: num(r.n), m: num(r.m), b: r.b ? 1 : 0, bv: num(r.bv) || 0, s: num(r.s), x: normX(r.x) };
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
            // Живая запись важнее восстановленной; восстановленная по новым правилам — важнее старой.
            if (!a || (a.b && !b.b) || (a.b && b.b && (b.bv || 0) > (a.bv || 0))) { cur.h[h] = b; changed = true; }
        });
        return changed;
    }

    async function readMonth(month) {
        if (loadedMonths.has(month) || typeof SharedStorage === 'undefined') return;
        const r = await SharedStorage.readJsonFileStrict(fileOf(month)).catch(() => ({ ok: false }));
        if (!r.ok) { failedMonths++; return; }
        loadedMonths.add(month);
        const flights = r.data && r.data.flights;
        if (flights && typeof flights === 'object') {
            Object.keys(flights).forEach(k => { const e = normEntry(flights[k]); if (e) mergeEntry(log, k, e); });
        }
    }

    // Подпись обучающих данных: модель и проверка пересчитываются, только когда она меняется.
    function trainSig() {
        let n = 0;
        let sum = 0;
        Object.keys(log).forEach(k => {
            const e = log[k];
            if (e.f == null) return;
            Object.keys(e.h).forEach(h => {
                const r = e.h[h];
                n++;
                sum += e.f * 7 + r.o * 3 + (r.x ? 1 : 0) + (r.p || 0) * 11 + (r.q || 0) * 13 + (r.y || 0) * 17 + (r.d || 0) * 19 + (r.b ? 23 : 0);
            });
        });
        const cal = typeof CalendarEvents !== 'undefined' && CalendarEvents.revision ? CalendarEvents.revision() : 0;
        return `${n}|${sum}|${cal}`;
    }

    function invalidate() {
        rev++;
    }

    // Окно журнала: −6…+2 месяца от сегодняшнего. Не прочитанные (нет доступа) — перечитываются при следующем вызове.
    function ensureLoaded() {
        const m0 = monthOf(today());
        if (!loading || m0 !== loadMonth || (loaded && failedMonths)) {
            loadMonth = m0;
            failedMonths = 0;
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
            const rows = groupedData[base] || [];
            const perDate = Object.create(null);
            rows.forEach(row => { perDate[row[1]] = (perDate[row[1]] || 0) + 1; });
            rows.forEach(row => {
                const date = row[1];
                const t = parseLocalDate(date);
                const code = cleanFlight(row[0]);
                // Два вылета рейса в один день (основной и доп. номер) — это два разных вылета.
                if (!t || seen.has(date + '|' + code)) return;
                seen.add(date + '|' + code);
                const sc = getFlightSalesList(date, code).length || perDate[date] > 1 ? code : base;
                const dep = { base, date, ts: t.getTime(), row, rowCode: code, code: sc, s: getSeatsOnSale(row), sold: getSoldFromRow(row), flown: t.getTime() < now };
                (byBase[base] || (byBase[base] = [])).push(dep);
                byKey[date + '|' + code] = dep;
                if (!byKey[date + '|' + base] || code === base) byKey[date + '|' + base] = dep;
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

    // Сколько было продано на вылете X к моменту T. live — момент среза данных: берём загрузку из файла.
    function soldAt(X, T, live) {
        if (X.ts <= T || live) return X.sold;
        // Только то, что было в продажах к этому дню, — без подсказки итогом вылета.
        return at(rawOf(X), Math.round((X.ts - T) / DAY));
    }

    // Даты рейса: два вылета в один день (основной и доп. номер) — одна дата, кресла и продажи складываются.
    function datesOf(base) {
        const C = context();
        if (!C.dates) C.dates = Object.create(null);
        if (C.dates[base]) return C.dates[base];
        const m = new Map();
        (C.byBase[base] || []).forEach(dep => {
            const D = m.get(dep.date) || { date: dep.date, ts: dep.ts, deps: [], s: 0, sold: 0, flown: dep.flown };
            D.deps.push(dep);
            D.s += dep.s || 0;
            D.sold += dep.sold || 0;
            m.set(dep.date, D);
        });
        const list = [...m.values()].sort((a, b) => a.ts - b.ts);
        C.dates[base] = list;
        return list;
    }

    function dateSoldAt(D, T, live) {
        return D.deps.reduce((a, X) => a + soldAt(X, T, live), 0);
    }

    // Добор вылета-даты от h дней до вылета (в долях кресел), по кривой, приведённой к загрузке.
    function datePick(D, h) {
        if (!(D.s > 0) || !(D.sold > 0)) return null;
        const atH = D.deps.reduce((a, X) => a + at(anchOf(X), h), 0);
        return Math.max(0, (D.sold - atH) / D.s);
    }

    // Признаки соседей на момент T (h — дней до вылета): [темп 7 дн., соседние даты, добор рейса за 4 недели, обратный, есть обратный].
    // T — начало дня прогноза: для живой записи — день среза данных, для восстановленной — день за h до вылета.
    function neighborFeatures(dep, h, T, live, o) {
        const C = context();
        const s = dep.s || 1;
        const raw = rawOf(dep);
        const v7 = Math.max(0, (at(raw, h) - at(raw, h + 7)) / s);
        let nbSum = 0;
        let nbN = 0;
        let pkSum = 0;
        let pkN = 0;
        datesOf(dep.base).forEach(D => {
            if (D.date === dep.date || !(D.s > 0)) return;
            if (Math.abs(D.ts - dep.ts) / DAY <= NB_DAYS) { nbSum += dateSoldAt(D, T, live) / D.s; nbN++; }
            if (D.ts < T && T - D.ts <= PICK_DAYS * DAY) {
                const pk = datePick(D, h);
                if (pk != null) { pkSum += pk; pkN++; }
            }
        });
        const pair = typeof getFlightPair === 'function' ? getFlightPair(dep.base) : null;
        const other = pair ? (pair.outbound === dep.base ? pair.inbound : pair.outbound) : '';
        const R = other ? datesOf(other).find(D => D.date === dep.date) : null;
        const rv = R && R.s > 0 ? dateSoldAt(R, T, live) / R.s : 0;
        return [v7, nbN ? nbSum / nbN : o / s, pkN ? pkSum / pkN : 0, rv, R && R.s > 0 ? 1 : 0];
    }

    // Прогноз «по тем же дням недели» на момент T — одна функция и для журнала задним числом, и для сегодняшних записей:
    // те же дни недели этого рейса, улетевшие до T (±8 недель, без смешения праздников с обычными днями;
    // мало — любые улетевшие в этот день недели), включая вылеты из архива продаж.
    function histAsOf(dep, h, T, o) {
        const dow = new Date(dep.ts).getDay();
        const seen = new Set();
        const items = [];
        datesOf(dep.base).forEach(D => {
            if (D.ts >= T || new Date(D.ts).getDay() !== dow) return;
            const pk = datePick(D, h);
            if (pk == null) return;
            seen.add(D.date);
            items.push({ date: D.date, ts: D.ts, pick: pk });
        });
        if (typeof SalesArchive !== 'undefined' && SalesArchive.departuresFor) {
            SalesArchive.departuresFor(dep.base).forEach(a => {
                if (seen.has(a.date) || !(a.seats > 0) || !(a.sold > 0)) return;
                const d = parseLocalDate(a.date);
                if (!d || d.getTime() >= T || d.getDay() !== dow) return;
                const C = context();
                if (!C.arch) C.arch = Object.create(null);
                const ak = a.date + '|' + dep.base;
                if (!(ak in C.arch)) C.arch[ak] = anchorCurveToLoad(departureCurve(a.date, dep.base), a.sold) || null;
                const curve = C.arch[ak];
                if (!curve) return;
                items.push({ date: a.date, ts: d.getTime(), pick: Math.max(0, (a.sold - at(curve, h)) / a.seats) });
            });
        }
        if (items.length < 2) return { y: null, n: 0 };
        const near = items.filter(c => dep.ts - c.ts <= 56 * DAY);
        let use = near.length >= 2 ? near : items;
        if (typeof CalendarEvents !== 'undefined' && CalendarEvents.filterCohort) use = CalendarEvents.filterCohort(use, dep.date) || use;
        if (use.length < 2) return { y: null, n: 0 };
        const lf = use.reduce((a, c) => a + c.pick, 0) / use.length;
        const s = dep.s || 1;
        return { y: Math.max(o, Math.min(s, Math.round(o + lf * s))), n: use.length };
    }

    // ---------- календарь и рейс ----------

    let calMemo = new Map();
    let calRev = -1;

    function calFeatures(date) {
        const cr = typeof CalendarEvents !== 'undefined' && CalendarEvents.revision ? CalendarEvents.revision() : 0;
        if (cr !== calRev) { calMemo = new Map(); calRev = cr; }
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

    // Потери Хьюбера: большие ошибки (группы, отмены) не тянут деревья — ближе к средней ошибке в пассажирах.
    // Обучение отдаёт управление браузеру примерно каждые 25 мс — интерфейс не подвисает.
    async function gbmTrain(X, y) {
        const n = X.length;
        const k = X[0].length;
        const cuts = [];
        for (let f = 0; f < k; f++) {
            const vals = X.map(r => r[f]).sort((a, b) => a - b);
            const set = new Set();
            for (let q = 1; q < GBM.bins; q++) set.add(vals[Math.floor(q * (n - 1) / GBM.bins)]);
            cuts.push([...set].sort((a, b) => a - b));
        }
        const sortedY = y.slice().sort((a, b) => a - b);
        const base = sortedY[Math.floor(n / 2)];   // медиана
        const absDev = y.map(v => Math.abs(v - base)).sort((a, b) => a - b);
        const delta = Math.max(0.02, absDev[Math.floor(0.9 * (n - 1))]);
        const pred = new Array(n).fill(base);
        const trees = [];
        const gain = new Array(k).fill(0);
        const all = Array.from({ length: n }, (_, i) => i);
        let last = Date.now();
        for (let t = 0; t < GBM.rounds; t++) {
            const res = y.map((v, i) => Math.max(-delta, Math.min(delta, v - pred[i])));
            const tree = grow(X, res, all, 0, cuts, gain);
            trees.push(tree);
            for (let i = 0; i < n; i++) pred[i] += GBM.rate * treeValue(tree, X[i]);
            if (Date.now() - last > 25) { await pause(); last = Date.now(); }
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

    // Записи с известным фактом, по дате вылета.
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
        return out.sort((a, b) => a.ts - b.ts || a.h - b.h || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    }

    function target(x) {
        return (x.f - x.r.o) / x.s;
    }

    // Средний добор (доля кресел) на каждом горизонте по набору — для вылетов без файла и без истории.
    function poolOf(list) {
        const acc = {};
        list.forEach(x => { const a = acc[x.h] || (acc[x.h] = { sum: 0, n: 0 }); a.sum += target(x); a.n++; });
        const out = {};
        Object.keys(acc).forEach(h => { if (acc[h].n >= 10) out[h] = acc[h].sum / acc[h].n; });
        return out;
    }

    async function train(list) {
        if (list.length > TRAIN_MAX) list = list.slice(list.length - TRAIN_MAX);
        if (list.length < MIN_TRAIN) return null;
        const X = list.map(features);
        const y = list.map(target);
        const res = { n: list.length, lin: {}, linAll: ridge(X, y), gbm: await gbmTrain(X, y), route: {} };
        HORIZONS.forEach(h => {
            const ids = [];
            list.forEach((x, i) => { if (x.h === h) ids.push(i); });
            if (ids.length >= MIN_TRAIN_H) res.lin[h] = ridge(ids.map(i => X[i]), ids.map(i => y[i]));
        });
        // Поправка по рейсу — своя для близких, средних и дальних горизонтов, сжата к нулю при малом числе вылетов.
        const acc = {};
        list.forEach((x, i) => {
            const p = (linPredict(res.lin[x.h] || res.linAll, X[i]) + gbmPredict(res.gbm, X[i])) / 2;
            const key = x.base + '|' + groupOf(x.h).id;
            const a = acc[key] || (acc[key] = { sum: 0, n: 0 });
            a.sum += y[i] - p;
            a.n++;
        });
        Object.keys(acc).forEach(k => { res.route[k] = (acc[k].sum / acc[k].n) * (acc[k].n / (acc[k].n + ROUTE_K)); });
        return res;
    }

    // { lin, gbm, ens } — итог в пассажирах (не меньше проданного и не больше кресел).
    function predictAll(m, smp) {
        if (!m) return null;
        const x = features(smp);
        const corr = m.route[smp.base + '|' + groupOf(smp.h).id] || 0;
        const o = smp.r.o / smp.s;
        const clamp = (lf) => Math.max(smp.r.o, Math.min(smp.s, Math.round((o + lf) * smp.s)));
        const l = linPredict(m.lin[smp.h] || m.linAll, x);
        const g = gbmPredict(m.gbm, x);
        return { lin: clamp(l + corr), gbm: clamp(g + corr), ens: clamp((l + g) / 2 + corr) };
    }

    // Простые способы. pool — средний добор всех рейсов на этом горизонте (по вылетам, улетевшим к моменту прогноза).
    function simple(k, r, s, pool, h) {
        const pp = r.p != null && r.q != null ? Math.max(r.o, Math.min(s, Math.round(r.o + r.p - r.q))) : null;
        const pl = pool && pool[h] != null ? Math.max(r.o, Math.min(s, Math.round(r.o + pool[h] * s))) : null;
        if (k === 'naive') return r.o;
        if (k === 'pool') return pl;
        if (k === 'planPick') return pp;
        if (k === 'plan') return r.p != null ? Math.min(s, r.p) : null;
        if (k === 'planOr') return r.p != null ? Math.max(r.o, Math.min(s, r.p)) : null;
        if (k === 'hist') return r.y;
        return null;
    }

    // Сегмент вылета: от него зависит, какие способы вообще есть.
    function segOf(r) {
        return r.p != null ? 'plan' : (r.y != null ? 'hist' : 'none');
    }

    const SEG_LABEL = { plan: 'есть файл ожидаемой', hist: 'есть история дней недели', none: 'нет ни файла, ни истории' };

    // ---------- что известно о вылете сейчас ----------

    function horizonFor(dtd) {
        for (let i = HORIZONS.length - 1; i >= 0; i--) if (HORIZONS[i] >= dtd) return HORIZONS[i];
        return null;
    }

    // Дней до вылета от среза данных (если данные вчерашние — на день больше, чем от сегодня).
    function dataDtd(date) {
        const dtd = typeof getDaysUntil === 'function' ? getDaysUntil(date) : null;
        if (dtd == null) return null;
        return Math.max(dtd, typeof observedFromDtd === 'function' ? observedFromDtd(date) : dtd);
    }

    function liveRecord(dep, d) {
        const s = dep.s;
        if (!(s > 0)) return null;
        const cap = getCapacityFromAircraft(getAircraftType(dep.row[4]));
        const wk = getWeekForExpectedLoad(dep.date);
        const p = getExpectedLoad(cap, dep.base, 0, wk);
        const q = getExpectedLoad(cap, dep.base, d, wk);
        const o = dep.sold;
        const T = dep.ts - d * DAY;   // день среза данных
        const hy = histAsOf(dep, d, T, o);
        const x = neighborFeatures(dep, d, T, true, o).map(v => Math.round(v * 1000) / 1000);
        return { d, o, p: num(p), q: num(q), y: hy.y, n: hy.n || null, m: null, b: 0, s, x };
    }

    const METHOD_LABEL = {
        ens: 'модель', gbm: 'модель (деревья)', lin: 'модель (линейная)', planOr: 'файл ожидаемой загрузки',
        planPick: 'продано + добор по файлу', hist: 'по тем же дням недели', pool: 'средний добор всех рейсов', naive: 'продано на сейчас'
    };

    // Прогноз для вылета (карточка): способ, который ошибался меньше всех для этого горизонта и такого вылета.
    function predict(code, date) {
        if (!isAdmin() || !loaded) return null;
        const ev = evalState.ev;
        if (!ev || evalState.sig !== trainSig()) { startEvaluation(); if (!ev) return null; }
        const dtdNow = typeof getDaysUntil === 'function' ? getDaysUntil(date) : null;
        if (dtdNow == null || dtdNow <= 0) return null;   // уже улетел
        const base = getBaseFlight(code);
        const C = context();
        const dep = C.byKey[date + '|' + cleanFlight(code)] || C.byKey[date + '|' + base];
        const d = dataDtd(date);
        if (!dep || d == null || d <= 0 || d > 30) return null;
        const h = horizonFor(d);
        const r = liveRecord(dep, d);
        if (!r || !h) return null;
        const pick = ev.choice[h + '|' + segOf(r)] || ev.choice[h];
        if (!pick) return null;
        let final = null;
        if (pick.k === 'ens' || pick.k === 'gbm' || pick.k === 'lin') {
            if (!models) return null;
            final = predictAll(models, { base, date, ts: dep.ts, h, s: r.s, r })[pick.k];
        } else final = simple(pick.k, r, r.s, ev.pool, h);
        if (final == null) final = r.o;
        return { final, seats: r.s, lf: Math.round(final / r.s * 100), method: METHOD_LABEL[pick.k], err: Math.round(pick.v * 10) / 10, trainedOn: pick.n, h };
    }

    // ---------- запись журнала ----------

    // Восстановить записи улетевшего вылета: что было известно за h дней до вылета.
    function backfill(dep) {
        const s = dep.s;
        const f = dep.sold;
        if (!(s > 0) || !(f > 0)) return null;
        const raw = rawOf(dep);
        if (!(raw.total > 0)) return null;
        const cap = getCapacityFromAircraft(getAircraftType(dep.row[4]));
        const wk = getWeekForExpectedLoad(dep.date);
        const p = getExpectedLoad(cap, dep.base, 0, wk);
        const e = { b: dep.base, s, f, h: {} };
        HORIZONS.forEach(h => {
            const T = dep.ts - h * DAY;
            // Только то, что было в продажах к этому дню (без подсказки итогом вылета).
            const o = at(raw, h);
            const hy = histAsOf(dep, h, T, o);
            const x = neighborFeatures(dep, h, T, false, o).map(v => Math.round(v * 1000) / 1000);
            e.h[h] = { d: h, o, p: num(p), q: num(getExpectedLoad(cap, dep.base, h, wk)), y: hy.y, n: hy.n || null, m: null, b: 1, bv: BACKFILL_V, s, x };
        });
        return e;
    }

    function dataToken() {
        const at0 = typeof lastSalesUpdate !== 'undefined' && lastSalesUpdate ? new Date(lastSalesUpdate).getTime() : 0;
        return `v4|${today()}|${at0}|${(typeof allData !== 'undefined' && allData ? allData.length : 0)}`;
    }

    async function capture(force) {
        if (!isAdmin() || typeof SharedStorage === 'undefined') return false;
        if (typeof groupedData === 'undefined' || !Object.keys(groupedData || {}).length) return false;
        const token = dataToken();
        if (!force) { try { if (localStorage.getItem(DONE_KEY) === token) return true; } catch (e) { /* ignore */ } }
        if (!(await SharedStorage.canWrite())) return false;
        await ensureLoaded();
        const C = context();
        // Данные старше суток: прогнозы «на сегодня» по ним не пишем — они бы записались не на свой горизонт.
        const stale = dataLagDays() > 1;
        const additions = Object.create(null);
        const add = (key, date, e) => { const m = monthOf(date); (additions[m] || (additions[m] = Object.create(null)))[key] = e; };
        let recorded = 0;
        let finals = 0;
        let backfilled = 0;
        let lastYield = Date.now();

        for (const base of Object.keys(C.byBase)) {
            for (const dep of C.byBase[base]) {
                const key = dep.date + '|' + dep.rowCode;
                const cur = log[key];
                if (dep.flown) {
                    if (!(dep.s > 0) || !(dep.sold > 0)) continue;
                    // Факт — только когда данные уже охватывают день вылета.
                    if (observedFromDtd(dep.date) !== 0) continue;
                    if (cur && cur.f !== dep.sold) { add(key, dep.date, { b: base, s: dep.s, f: dep.sold, h: {} }); finals++; }
                    const need = !cur || HORIZONS.some(h => !cur.h[h] || (cur.h[h].b && (cur.h[h].bv || 0) < BACKFILL_V));
                    if (need) {
                        const e = backfill(dep);
                        if (e) { add(key, dep.date, e); backfilled++; }
                    }
                } else if (!stale) {
                    const d = dataDtd(dep.date);
                    if (d == null || d <= 0 || d > 30) continue;
                    const h = horizonFor(d);
                    if (cur && cur.h[h] && !cur.h[h].b) continue;
                    const r = liveRecord(dep, d);
                    if (!r) continue;
                    if (models) r.m = predictAll(models, { base, date: dep.date, ts: dep.ts, h, s: r.s, r }).ens;
                    add(key, dep.date, { b: base, s: r.s, f: null, h: { [h]: r } });
                    recorded++;
                }
                // Отдавать управление браузеру по времени, а не по числу вылетов: восстановление тяжелее записи.
                if (Date.now() - lastYield > 25) { await pause(); lastYield = Date.now(); }
            }
        }

        let ok = true;
        let changedAny = false;
        for (const month of Object.keys(additions)) {
            const read = await SharedStorage.readJsonFileStrict(fileOf(month)).catch(() => ({ ok: false }));
            if (!read.ok) { ok = false; continue; }
            // Файл записан более новой версией сайта — не трогаем, чтобы не потерять её поля.
            if (read.data && Number(read.data.version) > VERSION) { ok = false; continue; }
            const merged = Object.create(null);
            const remote = read.data && read.data.flights;
            if (remote && typeof remote === 'object') Object.keys(remote).forEach(k => { const e = normEntry(remote[k]); if (e) merged[k] = e; });
            let changed = false;
            Object.keys(additions[month]).forEach(k => { if (mergeEntry(merged, k, additions[month][k])) changed = true; });
            let written = true;
            if (changed) {
                written = await SharedStorage.writeJsonFile(fileOf(month), { version: VERSION, updatedAt: new Date().toISOString(), flights: merged });
                ok = written && ok;
                if (written) changedAny = true;
            }
            // В память — только записанное: иначе повторная запись решит, что всё уже сохранено.
            const source = written ? merged : (remote && typeof remote === 'object' ? remote : {});
            Object.keys(source).forEach(k => { const e = written ? source[k] : normEntry(source[k]); if (e) mergeEntry(log, k, e); });
        }
        if (changedAny) invalidate();
        lastCapture = { at: Date.now(), recorded, finals, backfilled, ok, stale };
        if (ok) { try { localStorage.setItem(DONE_KEY, token); } catch (e) { /* ignore */ } }
        return ok;
    }

    // После входа: прочитать журнал, обучить модель, записать сегодняшние прогнозы (с прогнозом модели).
    function afterStart() {
        if (!isAdmin()) return;
        const run = () => ensureLoaded()
            .then(() => new Promise(r => startEvaluation(r)))
            .then(() => capture())
            .then(() => startEvaluation())
            .catch(e => console.warn('ForecastLab', e));
        if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 30000 });
        else setTimeout(run, 5000);
    }

    // ---------- честная проверка (в фоне) ----------

    const modelCache = new Map();   // между запусками: обучающий набор не изменился — модель не переобучается

    async function cachedTrain(all, len, cum) {
        const key = `${len}|${cum[len]}`;
        if (modelCache.has(key)) return modelCache.get(key);
        const m = await train(all.slice(0, len));
        modelCache.set(key, m);
        if (modelCache.size > 40) modelCache.delete(modelCache.keys().next().value);
        return m;
    }

    function loadChoicePrev() {
        try { return JSON.parse(localStorage.getItem(CHOICE_KEY) || '{}') || {}; } catch (e) { return {}; }
    }

    function saveChoice(c) {
        const out = {};
        Object.keys(c).forEach(k => { if (c[k]) out[k] = c[k].k; });
        try { localStorage.setItem(CHOICE_KEY, JSON.stringify(out)); } catch (e) { /* ignore */ }
    }

    // Прогноз за h дней до вылета знает только вылеты, улетевшие до недели, в которой он сделан.
    // Все способы сравниваются на одних и тех же вылетах; выбор — отдельно для вылетов с файлом ожидаемой,
    // с историей дней недели и без того и другого. Выбор меняется, только если новый способ заметно лучше.
    async function evaluate() {
        const all = samples();
        const cum = [0];
        all.forEach((x, i) => { cum.push(cum[i] + x.f * 7 + x.r.o * 3 + (x.r.y || 0) * 5 + (x.r.p || 0) * 11 + (x.r.x ? 1 : 0)); });
        const weeks = [...new Set(all.map(x => weekOf(x.ts)))].sort((a, b) => a - b).slice(-EVAL_WEEKS);
        const firstWeek = weeks.length ? weeks[0] : Infinity;
        const test = all.filter(x => weekOf(x.ts) >= firstWeek);
        const pred = new Map();
        const pools = new Map();
        // Модель для каждого «среза» (понедельник недели, когда делался прогноз).
        const byCut = new Map();
        test.forEach(x => {
            const cut = weekOf(x.ts - x.h * DAY);
            (byCut.get(cut) || byCut.set(cut, []).get(cut)).push(x);
        });
        for (const [cut, list] of [...byCut.entries()].sort((a, b) => a[0] - b[0])) {
            let len = 0;
            while (len < all.length && all[len].ts + DAY <= cut) len++;
            const pool = poolOf(all.slice(0, len));
            list.forEach(x => pools.set(x, pool));
            if (len < MIN_TRAIN) continue;
            const m = await cachedTrain(all, len, cum);
            if (m) list.forEach(x => pred.set(x, predictAll(m, x)));
            await pause();
        }
        const kinds = ['naive', 'pool', 'plan', 'planOr', 'planPick', 'hist', 'lin', 'gbm', 'ens'];
        const val = (k, x) => (k === 'lin' || k === 'gbm' || k === 'ens' ? (pred.has(x) ? pred.get(x)[k] : null) : simple(k, x.r, x.s, pools.get(x), x.h));
        const err = (k, x) => { const v = val(k, x); return v == null ? null : Math.abs(v - x.f); };
        const stat = (k, list) => {
            const c = { sum: 0, bias: 0, n: 0 };
            list.forEach(x => { const v = val(k, x); if (v == null) return; c.sum += Math.abs(v - x.f); c.bias += v - x.f; c.n++; });
            return c;
        };
        // Таблица: по горизонту, на одних и тех же вылетах (где есть прогноз модели), иначе — на всех.
        const byH = {};
        HORIZONS.forEach(h => {
            const hl = test.filter(x => x.h === h);
            const common = hl.filter(x => pred.has(x));
            const base = common.length >= MIN_CHOICE ? common : hl;
            byH[h] = { total: hl.length, common: common.length, simpleOnly: common.length < MIN_CHOICE };
            kinds.forEach(k => { byH[h][k] = stat(k, base); });
        });
        // Выбор по горизонту и сегменту, с устойчивостью к шуму.
        const prev = loadChoicePrev();
        const choice = {};
        const decide = (key, list) => {
            const withModel = list.filter(x => pred.has(x));
            const base = withModel.length >= MIN_CHOICE_SEG ? withModel : list;
            const cands = (withModel.length >= MIN_CHOICE_SEG ? ['ens', 'gbm', 'lin'] : []).concat(['planOr', 'planPick', 'hist', 'pool', 'naive']);
            const scored = cands.map(k => {
                const e = base.map(x => err(k, x)).filter(v => v != null);
                return { k, n: e.length, v: e.length ? e.reduce((a, b) => a + b, 0) / e.length : Infinity };
            }).filter(c => c.n >= MIN_CHOICE_SEG && c.n >= base.length * 0.9);
            if (!scored.length) return null;
            scored.sort((a, b) => a.v - b.v);
            let best = scored[0];
            const old = scored.find(c => c.k === prev[key]);
            if (old && old.k !== best.k) {
                // Парная разница ошибок на одних вылетах: меняем, только если новый способ надёжно лучше.
                const d = base.map(x => { const a = err(best.k, x); const b = err(old.k, x); return a == null || b == null ? null : a - b; }).filter(v => v != null);
                const mean = d.reduce((a, b) => a + b, 0) / (d.length || 1);
                const sd = Math.sqrt(d.reduce((a, b) => a + (b - mean) * (b - mean), 0) / Math.max(1, d.length - 1));
                const t = sd > 0 ? -mean / (sd / Math.sqrt(d.length)) : (mean < 0 ? Infinity : 0);
                if (!(t > SWITCH_T)) best = old;
            }
            return { k: best.k, v: best.v, n: best.n };
        };
        HORIZONS.forEach(h => {
            const hl = test.filter(x => x.h === h);
            choice[h] = decide(String(h), hl);
            ['plan', 'hist', 'none'].forEach(sg => {
                const sl = hl.filter(x => segOf(x.r) === sg);
                if (sl.length >= MIN_CHOICE_SEG) choice[h + '|' + sg] = decide(h + '|' + sg, sl);
            });
        });
        saveChoice(choice);
        const anyModel = HORIZONS.some(h => !byH[h].simpleOnly);
        const byWeek = new Map();
        const byBase = new Map();
        test.filter(x => x.h === 7).forEach(x => {
            const w = weekOf(x.ts);
            const W = byWeek.get(w) || { plan: [0, 0], best: [0, 0], ts: w };
            const pl = simple('plan', x.r, x.s);
            const pick = choice[7 + '|' + segOf(x.r)] || choice[7];
            const md = pick ? (val(pick.k, x) != null ? val(pick.k, x) : x.r.o) : null;
            if (pl != null) { W.plan[0] += Math.abs(pl - x.f); W.plan[1]++; }
            if (md != null) { W.best[0] += Math.abs(md - x.f); W.best[1]++; }
            byWeek.set(w, W);
            const R = byBase.get(x.base) || { plan: [0, 0], model: [0, 0] };
            if (pl != null) { R.plan[0] += Math.abs(pl - x.f); R.plan[1]++; }
            if (md != null) { R.model[0] += Math.abs(md - x.f); R.model[1]++; }
            byBase.set(x.base, R);
        });
        // Модель для карточки — на всём журнале; «что влияет» — по её деревьям.
        const full = await cachedTrain(all, all.length, cum);
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
        }
        const segCount = { plan: 0, hist: 0, none: 0 };
        test.forEach(x => { if (x.h === 7) segCount[segOf(x.r)]++; });
        return { full, pool: poolOf(all), byH, byWeek, byBase, choice, influence, segCount, samples: all.length, departures: new Set(all.map(x => x.key)).size, trained: !!full, anyModel };
    }

    // Один расчёт за раз; все, кто ждал, получают результат (и при ошибке). Устаревший расчёт не применяется.
    function startEvaluation(onDone) {
        if (onDone) evalState.waiters.push(onDone);
        if (!loaded) return;
        const sig = trainSig();
        const flush = () => {
            const w = evalState.waiters.splice(0);
            w.forEach(f => { try { f(); } catch (e) { console.warn(e); } });
        };
        if (evalState.ev && evalState.sig === sig && !evalState.busy) { flush(); return; }
        if (evalState.busy) return;
        const run = ++evalState.run;
        evalState.busy = true;
        evaluate().then(ev => {
            if (run !== evalState.run) return;
            evalState.busy = false;
            if (trainSig() !== sig) { startEvaluation(); return; }
            evalState.ev = ev;
            evalState.sig = sig;
            models = ev.full || null;
            flush();
            if (typeof FlightCard !== 'undefined' && FlightCard.isOpen && FlightCard.isOpen() && FlightCard.refresh) FlightCard.refresh();
        }).catch(e => {
            console.warn('ForecastLab.evaluate', e);
            if (run === evalState.run) evalState.busy = false;
            flush();
        });
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
        if (!evalState.ev || evalState.sig !== trainSig()) {
            startEvaluation(rerender);
            if (!evalState.ev) return '<p class="rp-note">Модель учится и проверяет себя на прошлых неделях… Это занимает несколько секунд, работать на сайте можно.</p>';
        }
        const ev = evalState.ev;
        const now = todayTs();
        const futureKeys = Object.keys(log).filter(k => {
            if (log[k].f != null) return false;
            const d = parseLocalDate(k.slice(0, k.lastIndexOf('|')));
            return d && d.getTime() >= now;
        }).length;
        const cols = [['naive', 'Продано на сейчас'], ['pool', 'Средний добор всех рейсов'], ['plan', 'Файл ожидаемой, итог'], ['planPick', 'Продано + добор по файлу'], ['hist', 'По тем же дням недели'], ['lin', 'Модель: линейная'], ['gbm', 'Модель: деревья'], ['ens', 'Модель: среднее']];
        // Что берём: отдельно для вылетов с файлом ожидаемой, с историей и без того и другого (если данных хватает).
        const choiceCell = (h) => {
            const segs = ['plan', 'hist', 'none'].filter(sg => ev.choice[h + '|' + sg]);
            if (!segs.length) return ev.choice[h] ? `<strong>${esc(METHOD_LABEL[ev.choice[h].k])}</strong>` : '<span class="rp-muted">мало данных</span>';
            return segs.map(sg => {
                const c = ev.choice[h + '|' + sg];
                return `<div class="fl-seg"><span class="rp-muted">${esc(SEG_LABEL[sg])}:</span> <strong>${esc(METHOD_LABEL[c.k])}</strong> <span class="rp-muted">±${fmt(c.v)}</span></div>`;
            }).join('');
        };
        const rowsH = HORIZONS.map(h => {
            const B = ev.byH[h];
            const vals = cols.map(([k]) => (B[k].n ? B[k].sum / B[k].n : null));
            const okVals = vals.filter((v, i) => v != null && B[cols[i][0]].n >= MIN_CHOICE && cols[i][0] !== 'plan');
            const best = okVals.length ? Math.min(...okVals) : null;
            return `<tr><td><strong>${h} ${h === 1 ? 'день' : (h < 5 ? 'дня' : 'дней')}</strong></td>${cols.map(([k], i) => {
                const v = vals[i];
                const b = B[k].n ? B[k].bias / B[k].n : null;
                return `<td class="${v != null && v === best && B[k].n >= MIN_CHOICE && k !== 'plan' ? 'fl-best' : ''}">${fmt(v)}${v != null ? `<div class="rp-muted">${B[k].n} · ${b > 0 ? '↑' : '↓'}${fmt(Math.abs(b))}</div>` : ''}</td>`;
            }).join('')}<td class="rp-left">${choiceCell(h)}${B.simpleOnly ? '<div class="rp-muted">модель проверить пока не на чем</div>' : ''}</td></tr>`;
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
        let cap = lastCapture && (lastCapture.recorded || lastCapture.backfilled || lastCapture.finals)
            ? `Последняя запись журнала: прогнозов ${lastCapture.recorded}, восстановлено вылетов ${lastCapture.backfilled}, дописан факт ${lastCapture.finals}.` : '';
        if (lastCapture && lastCapture.stale) cap += ' Данные продаж старше суток — прогнозы на сегодня не записаны (запишутся после загрузки свежих данных).';
        return `
            <section class="rp-card">
                <div class="rp-card-head"><h3 class="rp-card-title">Точность прогноза загрузки</h3><span class="fl-admin">только администратор</span></div>
                <p class="rp-card-text">Каждый день сайт записывает прогноз по каждому вылету за 30, 21, 14, 10, 7, 5, 3 и 1 день до вылета, а после вылета — факт.
                    Модель учитывает продажи и их темп, файл ожидаемой загрузки, те же дни недели, соседние даты рейса, обратный рейс,
                    день недели, выходные, праздники и каникулы, сезон и тип рейса. Ошибка — в пассажирах, в среднем по вылетам; под числом — сколько вылетов
                    и в какую сторону ошибается (↑ завышает, ↓ занижает). Проверка честная: прогноз за N дней до вылета модель делает, зная только вылеты,
                    улетевшие к тому моменту. Все способы сравниваются на одних и тех же вылетах (последние ${EVAL_WEEKS} недель).
                    Способ выбирается отдельно для вылетов с файлом ожидаемой загрузки, с историей по дням недели и без того и другого,
                    и меняется, только когда новый способ надёжно точнее. «Средний добор всех рейсов» — сколько в среднем добирают все рейсы
                    за столько же дней до вылета: запасной способ для рейсов без файла и без истории.
                    ${ev.anyModel ? '' : '<strong>Модели пока не на чем проверяться: улетевших вылетов мало. Сравниваются простые способы.</strong>'}</p>
                <div class="dr-kpis">
                    <div class="dr-kpi"><div class="dr-kpi-label">Вылетов с фактом</div><div class="dr-kpi-value">${ev.departures}</div><div class="dr-kpi-sub">записей прогноза: ${ev.samples}</div></div>
                    <div class="dr-kpi"><div class="dr-kpi-label">Ждут вылета</div><div class="dr-kpi-value">${futureKeys}</div><div class="dr-kpi-sub">факт допишется после вылета</div></div>
                    <div class="dr-kpi ${ev.anyModel ? 'dr-kpi-up' : ''}"><div class="dr-kpi-label">Модель</div><div class="dr-kpi-value">${ev.anyModel ? 'работает' : (ev.trained ? 'копит данные' : 'учится')}</div><div class="dr-kpi-sub">${ev.anyModel ? 'линейная + деревья, проверена' : 'нужно больше улетевших вылетов для честной проверки'}</div></div>
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
                        ${rowsW ? `<table class="rp-table dr-sum-table"><thead><tr><th>Неделя</th><th>Файл ожидаемой</th><th>Что берём</th><th>Вылетов</th></tr></thead><tbody>${rowsW}</tbody></table>` : '<p class="rp-note">Пока нет данных.</p>'}
                    </div>
                </div>
                <div class="dr-sum"><div class="dr-sum-title">Где ошибается сильнее всего, за 7 дней</div>
                    ${rowsR ? `<table class="rp-table dr-sum-table"><thead><tr><th>Рейс</th><th>Файл ожидаемой</th><th>Что берём</th><th>Вылетов</th></tr></thead><tbody>${rowsR}</tbody></table>` : '<p class="rp-note">Пока нет данных.</p>'}
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
