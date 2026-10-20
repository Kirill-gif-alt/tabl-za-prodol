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
//    • тип рейса и вместимость ВС.
//    Способы: продано на сейчас, файл ожидаемой, те же дни недели, средний добор, добор этого рейса, цепочка добора,
//    линейная модель, решающие деревья, их среднее — и комитет: все вместе с весами по точности на каждом рейсе.
//    Проверка честная: для каждой недели модели обучены только на более ранних неделях. На каждом горизонте
//    берётся способ, который ошибался меньше всех.
//
// ═══════════════════════ МАТЕМАТИКА МОДЕЛИ ═══════════════════════
// Обозначения (вылет i, горизонт h — дней до вылета):
//   sᵢ — кресла, oᵢₕ — продано за h дней, fᵢ — итог (факт), pᵢ / qᵢₕ — файл ожидаемой: итог и значение на день h,
//   yᵢₕ — прогноз по тем же дням недели, xᵢₕ — вектор признаков (см. features / FEATURE_GROUPS).
//
// (1) Цель — добор в долях кресел:      tᵢₕ = (fᵢ − oᵢₕ) / sᵢ
//     Итог из прогноза добора:           f̂ᵢₕ = clamp(round(oᵢₕ + sᵢ·t̂ᵢₕ), oᵢₕ, sᵢ)   — не меньше проданного, не больше кресел.
//
// (2) Простые способы:
//     naive     f̂ = o                                 (дальше не продадут ничего)
//     planOr    f̂ = clamp(p, o, s)                     (итог файла ожидаемой)
//     planPick  f̂ = clamp(o + (p − q), o, s)           (продано + добор по файлу от дня h до вылета)
//     hist      f̂ = y                                  (те же дни недели: средний итог при похожих продажах на день h)
//     pool      f̂ = clamp(o + π̄ₕ·s, o, s),  π̄ₕ = (1/Nₕ)·Σⱼ tⱼₕ   (средний добор всех улетевших рейсов на горизонте h, Nₕ ≥ 10)
//
// (3) Гребневая регрессия (на всех горизонтах и своя на каждом h при nₕ ≥ 80):
//     Вес записи по давности (модель постоянно доучивается и подстраивается под нынешние продажи):
//       aᵢ = 2^(−(T − tsᵢ)/τ½),  τ½ = 120 дней,  T — последний вылет в обучающем наборе; окно — 12 месяцев.
//     ŵ = argmin_w Σᵢ aᵢ·(tᵢ − w₀ − wᵀxᵢ)² + λ̄‖w‖²   ⇒   ŵ = (X̃ᵀAX̃ + λ̄·I₀)⁻¹ X̃ᵀAt,  λ̄ = λ·(Σa/n),
//     X̃ = [1 | X], I₀ = diag(0, 1, …, 1) (свободный член не штрафуется), λ = 0,8; решение — Гаусс–Жордан с выбором ведущего.
//
// (4) Градиентный бустинг деревьев с потерями Хьюбера:
//     F₀ = median(t);   δ = max(0,02; Q₀,₉ |tᵢ − F₀|)
//     для m = 1..M:  rᵢ = clip(tᵢ − Fₘ₋₁(xᵢ), −δ, δ)              (антиградиент Хьюбера: выбросы обрезаются)
//                    hₘ = дерево по МНК на rᵢ (глубина, минимум записей в листе и число порогов — из параметров расчётов)
//                    разбиение по максимуму  G = S_L²/A_L + S_R²/A_R − S²/A   (S = Σaᵢrᵢ, A = Σaᵢ в узле; лист = S/A)
//                    Fₘ = Fₘ₋₁ + η·hₘ,    η и число деревьев M — из параметров расчётов
//     Важность признака: доля Σ G всех его разбиений во всех деревьях.
//
// (5) Ансамбль: t̂ = ½·(t̂_lin + t̂_gbm). Отдельной поправки рейса нет: она бралась по остаткам на тех же данных
//     (двойная подстройка); особенности рейса несёт признак «добор этого рейса» (EB).
//
// (6) Честная проверка (walk-forward): прогноз за h дней до вылета i сделан в неделю cᵢ = понедельник(tsᵢ − h·сутки);
//     модель для него обучена только на вылетах j с tsⱼ + сутки ≤ cᵢ. Точность способа k на вылетах A:
//     MAEₖ = (1/|A|)·Σ |f̂ₖᵢ − fᵢ|,   смещение = (1/|A|)·Σ (f̂ₖᵢ − fᵢ),   все способы — на одних и тех же вылетах.
//
// (7) Выбор способа на горизонте h для сегмента (есть файл / есть история / нет ничего):  k* = argminₖ MAEₖ,
//     но прежний способ k₀ меняется на k*, только если парная разница dᵢ = |eₖ*,ᵢ| − |eₖ₀,ᵢ| надёжно меньше нуля:
//     t = −d̄ / (s_d/√n) > 2, d — средняя разница ошибок за дату вылета (блоки по датам; защита от «прыжков» из-за шума).
//
// (8) Цепочка добора (advanced pickup): звенья 30→21→14→10→7→5→3→1→итог; звено a→b — по всем вылетам, у которых день b
//     уже наступил к моменту прогноза T (и по ещё не улетевшим):  vₓ = (o_b − o_a)/s,  wₓ = e^(−(T − t_b)/τ), τ = 28;
//     ℓ_общ = Σwv/Σw,  ℓ_рейс = (Σwv + 6·ℓ_общ)/(Σw + 6),  ℓ_рейс×дн.нед = (Σwv + 4·ℓ_рейс)/(Σw + 4);  f̂ = o + s·Σℓ от h до итога.
//
// (9) Добор этого рейса (эмпирический Байес): t̂_рейс,h = (Σ_рейс tₕ + K·t̄ₕ)/(n_рейс + K), K = 10 (способ) и K = 20 (признак модели,
//     считается на день прогноза только по улетевшим к нему вылетам).
//
// (10) Комитет моделей (Hedge с байесовским сжатием): ошибка способа k на рейсе b в группе g (горизонт × сегмент)
//     L_g,k = (Σ|e| + 8·L₀)/(n + 8),  L_b,k = (Σ_b|e| + 8·L_g,k)/(n_b + 8),  e = (f̂ − f)/s;
//     wₖ ∝ exp(−4·(Lₖ/L_min − 1)), Lₖ > 2·L_min — вне комитета;  f̂ = Σwₖf̂ₖ/Σwₖ. Нет прогноза у способа — вес у остальных.
//     Ошибки — только по вылетам, улетевшим до недели прогноза.
//
// (11) Интервал 80% (сплит-конформный, несимметричный): остатки выбранного способа на честной проверке
//     rᵢ = (fᵢ − f̂ᵢ)/sᵢ, отсортированы, n ≥ 20;  q_lo = r₍⌊(n+1)·0,1⌋₎,  q_hi = r₍⌈(n+1)·0,9⌉₎;
//     интервал [max(0, ⌊f̂ + q_lo·s⌋); min(max(s, o), ⌈f̂ + q_hi·s⌉)]. Нижняя граница может быть меньше проданного —
//     неявки и возвраты (за 1 день до вылета итог меньше проданного у половины вылетов).
window.ForecastLab = (function () {
    const HORIZONS = [30, 21, 14, 10, 7, 5, 3, 1];
    const GROUPS = [{ id: 'near', label: '1–3 дня', hs: [1, 3] }, { id: 'mid', label: '5–10 дней', hs: [5, 7, 10] }, { id: 'far', label: '14–30 дней', hs: [14, 21, 30] }];
    const GBM = { get rounds() { return PV.GBM_ROUNDS; }, get depth() { return PV.GBM_DEPTH; }, get rate() { return PV.GBM_RATE; }, get minLeaf() { return PV.GBM_MIN_LEAF; }, get bins() { return PV.GBM_BINS; } };   // «Настройки» → «Параметры расчётов»
    const VERSION = 3;              // формат журнала; файл новее — не перезаписываем (3: цена/класс, группы, кресла к ВС)
    const BACKFILL_V = 5;           // правила восстановления; старее — пересчитываются (4: + цена/класс, группы, кресла к ВС)
    const CHOICE_KEY = 'krasavia_fc_choice';
    const DONE_KEY = 'krasavia_fclog_done';
    const DAY = 86400000;
    const routeTypeMemo = new Map();   // тип рейса по номеру: вызывается миллионы раз за проверку
    const TRUNC_DAYS = 90;          // вылет раньше чем через 90 дней от начала истории продаж — ранние покупки не попали
    const NODES = [30, 21, 14, 10, 7, 5, 3, 1, 0];   // точки цепочки добора (0 — итог вылета)
    // Линии с конкурентом (для разбивки точности и ранних предупреждений). since — с какой даты вылета.
    const COMPETITION = [{ cities: ['Красноярск', 'Горно-Алтайск'], who: 'S7', since: '01.01.2026' }];
    const WARN_KEY = 'krasavia_fc_warn';
    const WARN_DEFAULT = { get under() { return PV.WARN_UNDER; }, get over() { return PV.WARN_OVER; }, get days() { return PV.WARN_DAYS; } };

    let log = Object.create(null);  // 'дд.мм.гггг|KV-101' → { b: base, s, f, h: { '7': { d, o, p, q, y, n, m, b, s, x } } }
    const loadedMonths = new Set();
    let loading = null;
    let loaded = false;
    let models = null;              // обученные на всём журнале (для карточки)
    let evalState = { sig: '', ev: null, busy: false, waiters: [] };
    let modelRev = 0;               // растёт после каждого обучения — карточка, RMS и «Сегодня» берут новый прогноз
    let loadMonth = '';             // месяц, от которого считали окно журнала
    let failedMonths = 0;
    let lastCapture = null;

    // ---------- общее ----------

    function isAdmin() {
        const p = typeof ProfileAuth !== 'undefined' && ProfileAuth.getCurrentProfile ? ProfileAuth.getCurrentProfile() : null;
        return !!(p && p.isAdmin);
    }

    // Видеть прогноз: администратор или право «Прогноз загрузки и предупреждения».
    function canView() {
        if (isAdmin()) return true;
        return !!(typeof ProfileAuth !== 'undefined' && ProfileAuth.hasPermission && ProfileAuth.hasPermission('view_forecast'));
    }

    // Писать журнал и загружать историю — ещё и право публиковать данные.
    function canWrite() {
        return canView() && (isAdmin() || !!(typeof ProfileAuth !== 'undefined' && ProfileAuth.hasPermission('share_data')));
    }

    function esc(v) {
        return typeof escHtml === 'function' ? escHtml(v) : String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function pad(n) { return String(n).padStart(2, '0'); }

    const plural = pluralRu;   // core-utils.js

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
    // Долгие циклы отдают управление браузеру каждые ~10 мс: страница не замирает, пока модель учится.
    function makeYield(ms) {
        let t = performance.now();
        // После порции работы — короткая пауза: интерфейс успевает отвечать, пока модель считается в фоне.
        return async () => { if (performance.now() - t > (ms || 10)) { await new Promise(r => setTimeout(r, 6)); t = performance.now(); } };
    }
    async function mapAsync(arr, fn) {
        const tick = makeYield();
        const out = new Array(arr.length);
        for (let i = 0; i < arr.length; i++) {
            out[i] = fn(arr[i]);
            if ((i & 127) === 127) await tick();
        }
        return out;
    }

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
            if (r.ai) out.h[h].ai = String(r.ai).slice(0, 40);
            // База знаний о вылете на этот день: открытый класс и цена, группы на руках, кресла в продаже к ёмкости ВС.
            if (r.pi) { out.h[h].pi = 1; out.h[h].pk = num(r.pk) || 0; out.h[h].pf = num(r.pf) || 0; if (r.pc) out.h[h].pc = String(r.pc).slice(0, 2); }
            if (num(r.gh) > 0) out.h[h].gh = num(r.gh);
            if (num(r.ss) > 0) out.h[h].ss = num(r.ss);
        });
        return out;
    }

    // Живые записи важнее восстановленных; восстановленная с признаками важнее старой без них.
    let logRev = 0;   // меняется при каждом изменении журнала — по нему запоминается подпись обучающих данных

    function mergeEntry(target, key, e) {
        const changed = mergeEntry0(target, key, e);
        if (changed && target === log) logRev++;
        return changed;
    }

    // Какая история продаж загружена: восстановленные записи журнала пересчитываются, когда она меняется
    // (признаки «те же дни недели», соседние даты, добор рейса зависят от архива).
    function historyStamp() {
        const li = typeof SalesArchive !== 'undefined' && SalesArchive.lastImport ? SalesArchive.lastImport() : null;
        // История по билетам тоже меняет восстановленные записи (возвраты, цена и класс по дням).
        return li && (li.sig || li.ticketsSig) ? String((li.sig || '') + (li.ticketsSig ? '|t' + li.ticketsSig : '')).slice(0, 40) : '';
    }

    function offDay(r, h) {
        return !!r && !r.b && r.d != null && r.d !== Number(h);
    }

    function mergeEntry0(target, key, e) {
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
            // Живая запись не в свой контрольный день (старые версии писали «за 7 дней» на 5-й день) — хуже восстановленной.
            if (!a || (a.b && !b.b && !offDay(b, h)) || (a.b && b.b && ((b.bv || 0) > (a.bv || 0) || ((b.bv || 0) === (a.bv || 0) && (b.ai || '') !== (a.ai || '')))) || (offDay(a, h) && b.b)) { cur.h[h] = b; changed = true; }
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
    let sigMemo = { rev: -1, v: '' };

    function trainSig() {
        const arch = typeof SalesArchive !== 'undefined' && SalesArchive.revision ? SalesArchive.revision() : 0;
        const cal = typeof CalendarEvents !== 'undefined' && CalendarEvents.revision ? CalendarEvents.revision() : 0;
        if (sigMemo.rev !== logRev) sigMemo = { rev: logRev, v: trainSig0() };
        const w = warnSettings();   // проверка сигналов считается при нынешних порогах
        return `${sigMemo.v}|${arch}|${cal}|${w.under}|${w.over}|p${typeof Params !== 'undefined' ? Params.revision() : 0}`;
    }

    function trainSig0() {
        let n = 0;
        let sum = 0;
        Object.keys(log).forEach(k => {
            const e = log[k];
            if (e.f == null) return;
            Object.keys(e.h).forEach(h => {
                const r = e.h[h];
                n++;
                sum += e.f * 7 + r.o * 3 + (r.x ? 1 : 0) + (r.p || 0) * 11 + (r.q || 0) * 13 + (r.y || 0) * 17 + (r.d || 0) * 19 + (r.b ? 23 : 0) + (r.pk || 0) * 29 + (r.pf || 0) * 31 + (r.gh || 0) * 37 + (r.ss || 0) * 41;
            });
        });
        const cal = typeof CalendarEvents !== 'undefined' && CalendarEvents.revision ? CalendarEvents.revision() : 0;
        return `${n}|${sum}|${cal}`;
    }

    function invalidate() {
        routeTypeMemo.clear();
        lyMemoTrend.clear();
    }

    // Окно журнала: −6…+2 месяца от сегодняшнего. Не прочитанные (нет доступа) — перечитываются при следующем вызове.
    function ensureLoaded() {
        const m0 = monthOf(today());
        if (!loading || m0 !== loadMonth || (loaded && failedMonths)) {
            loadMonth = m0;
            failedMonths = 0;
            const months = [];
            for (let i = -PV.FL_MONTHS_BACK; i <= 2; i++) months.push(shiftMonth(m0, i));
            // Архив продаж: окно обучения и те же месяцы год назад (способ «прошлый год»).
            const arch = [];
            for (let i = -(PV.FL_MONTHS_BACK + 13); i <= 0; i++) arch.push(shiftMonth(m0, i));
            const archP = typeof SalesArchive !== 'undefined' && SalesArchive.ensureMonths ? SalesArchive.ensureMonths(arch).catch(() => null) : Promise.resolve();
            const liP = typeof SalesArchive !== 'undefined' && SalesArchive.readLastImport ? SalesArchive.readLastImport().catch(() => null) : Promise.resolve();
            loading = Promise.all(months.map(readMonth).concat([archP, liP])).then(() => { loaded = true; ctxMemo.sig = ''; invalidate(); });
        }
        return loading;
    }

    // ---------- вылеты в данных: соседние даты, обратный рейс, кривые ----------

    let ctxMemo = { sig: '', v: null };

    function context() {
        const sig = [typeof dataEpoch === 'number' ? dataEpoch : 0, today(), typeof SalesArchive !== 'undefined' && SalesArchive.revision ? SalesArchive.revision() : 0].join('|');
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
        // Улетевшие вылеты из архива продаж (история, прошлые месяцы), которых уже нет в текущих данных, —
        // в пределах окна журнала: на них модель учится, по ним считаются соседние даты и цепочка добора.
        if (typeof SalesArchive !== 'undefined' && SalesArchive.entries) {
            const from = parseLocalDate('01.' + shiftMonth(monthOf(today()), -PV.FL_MONTHS_BACK).split('-').reverse().join('.'));
            SalesArchive.entries().forEach(({ date, code, e }) => {
                if (byKey[date + '|' + code] || !(e.s > 0) || !(e.sold > 0) || e.sold > e.s) return;
                const t = parseLocalDate(date);
                if (!t || t.getTime() >= now || (from && t < from)) return;
                const base = typeof getBaseFlight === 'function' ? getBaseFlight(code) : code;
                // sF — кресла для признаков: у вылетов истории, где ёмкость подобрана по проданному, — обычные кресла рейса
                // (иначе признак «ёмкость» знает итог вылета).
                const sF = e.s0 || (e.se && !e.ac && SalesArchive.typicalSeats ? SalesArchive.typicalSeats(code) : 0) || e.s;
                const dep = { base, date, ts: t.getTime(), row: null, rowCode: code, code, s: e.s, sF, sold: e.sold, flown: true, arch: true, ac: e.ac || '', hist: !!e.h, c0: e.c };
                (byBase[base] || (byBase[base] = [])).push(dep);
                byKey[date + '|' + code] = dep;
                if (!byKey[date + '|' + base]) byKey[date + '|' + base] = dep;
            });
        }
        Object.keys(byBase).forEach(b => byBase[b].sort((a, c) => a.ts - c.ts));
        // Начало истории продаж: самая ранняя покупка в загруженной истории. Вылеты в первые месяцы после неё
        // без ранних продаж («обрезаны слева») — продано на 30/21/14 дней занижено, их добор ложно большой.
        let histStart = null;
        Object.keys(byKey).forEach(k => {
            const d = byKey[k];
            if (!d.arch || !d.hist || !d.c0) return;
            let mx = 0;
            for (let i = d.c0.length - 1; i >= 0; i--) if (d.c0[i]) { mx = i; break; }
            const st = d.ts - mx * DAY;
            if (histStart == null || st < histStart) histStart = st;
        });
        if (histStart != null) Object.keys(byKey).forEach(k => { const d = byKey[k]; if (d.arch && d.hist) d.trunc = d.ts - TRUNC_DAYS * DAY < histStart; });
        lyMemoTrend.clear();
        ctxMemo = { sig, v: { byBase, byKey, now, histStart } };
        return ctxMemo.v;
    }

    function rawOf(dep) {
        if (!dep._raw) {
            dep._raw = (dep.arch ? SalesArchive.curveFor(dep.date, dep.code) : buildOnHandByDtd(dep.date, dep.code)) || { onHand: {}, maxDtd: 0, total: 0 };
        }
        return dep._raw;
    }

    // Средний взрослый платный тариф по основному рейсу (по файлу продаж) — для ошибки в рублях.
    function routeFares() {
        const acc = Object.create(null);
        Object.keys(typeof salesDetails !== 'undefined' && salesDetails ? salesDetails : {}).forEach(k => {
            const b = getBaseFlight(k.slice(k.indexOf('|') + 1));
            (salesDetails[k] || []).forEach(s => {
                const f = s.adjustedFare || s.fare || 0;
                if (!(f > 0) || /\/(CN|IN|ID)/i.test(String(s.basicFareStr || ''))) return;
                const a = acc[b] || (acc[b] = [0, 0]);
                a[0] += f; a[1]++;
            });
        });
        const out = Object.create(null);
        Object.keys(acc).forEach(b => { if (acc[b][1] >= 10) out[b] = acc[b][0] / acc[b][1]; });
        return out;
    }

    // Групповые билеты вылета по дням до вылета (брони от 5 человек; только вылеты из текущего файла продаж —
    // в архиве истории время покупки групп не записано). { byDtd: {t: n}, total }.
    function groupsOf(dep) {
        if (dep._grp) return dep._grp;
        const g = { byDtd: Object.create(null), total: 0 };
        if (!dep.arch && typeof getFlightSalesList === 'function') {
            const fly = parseLocalDate(dep.date);
            const list = getFlightSalesList(dep.date, dep.code);
            // Размер брони известен, если данные загружены из файлов (по PNR). В общем снимке PNR нет — тогда группа:
            // 5+ билетов одного кода тарифа, купленных в один день.
            const hasGrp = list.some(s => s.grp != null);
            const sameDay = Object.create(null);
            // Без PNR: один день, один код и одна цена (иначе 5 разных людей, купивших самый дешёвый класс, — «группа»).
            const gk = (s) => s.dealDate + '|' + (s.basicFareStr || '') + '|' + Math.round(Number(s.fare) || 0);
            if (!hasGrp) list.forEach(s => { const k = gk(s); sameDay[k] = (sameDay[k] || 0) + 1; });
            list.forEach(s => {
                const size = hasGrp ? (Number(s.grp) || 0) : sameDay[gk(s)];
                if (!(size >= PV.GROUP_MIN)) return;
                const d = parseLocalDate(s.dealDate);
                if (!d || !fly) return;
                const t = Math.max(0, Math.round((fly - d) / DAY));
                g.byDtd[t] = (g.byDtd[t] || 0) + 1;
                g.total++;
            });
        }
        dep._grp = g;
        return g;
    }

    // Групповых билетов, купленных в днях до вылета (lo, hi] (lo < t ≤ hi).
    function groupsBetween(dep, lo, hi) {
        const g = groupsOf(dep);
        if (!g.total) return 0;
        let n = 0;
        Object.keys(g.byDtd).forEach(t => { const k = Number(t); if (k > lo && k <= hi) n += g.byDtd[t]; });
        return n;
    }

    function anchOf(dep) {
        if (!dep._anch) dep._anch = (dep.arch ? anchorCurveToLoad(rawOf(dep), dep.sold) : anchorCurveToLoad(departureCurve(dep.date, dep.code), dep.sold)) || rawOf(dep);
        return dep._anch;
    }

    // «Прошлый год»: тот же рейс в тот же день недели год назад (364 дня, иначе ±1 неделя) из архива продаж.
    //   добор год назад: π = (итог_пг − продано_пг за h дней) / кресла_пг;   f̂ = clamp(o + π·s, o, s)
    // «Прошлый год»: сколько этот рейс ДОБРАЛ от дня h до вылета год назад, в пересчёте на нынешние условия.
    //   • Дата: тот же день недели год назад (364 дня назад: 14.10.2026 ср → 15.10.2025 ср); если там был праздник,
    //     каникулы или событие, а сейчас нет (или наоборот) — соседняя неделя (−357 / −371 дня) с тем же календарём.
    //   • Добор берётся в пассажирах (не в доле кресел): если год назад летал самолёт больше и продали 48 —
    //     сейчас на 46 креслах итог упрётся в кресла. Разница ёмкостей учитывается мягко: √(кресла сейчас / тогда).
    //   • Частота: в неделю вокруг вылета год назад было n₁ рейсов направления, сейчас n₀ — спрос делится
    //     на рейсы, добор × n₁/n₀ (0,5…2).
    //   • Рост к прошлому году: пассажиры направления за 8 недель до дня прогноза против тех же недель год назад
    //     (только улетевшие к дню прогноза — без подглядывания), сжато к 1 при малом числе вылетов, 0,6…1,6.
    //   • Добор от дня h до вылета виден в истории целиком, если день (вылет − h) год назад после начала истории.
    const lyMemoTrend = new Map();
    const CAL_KEYS = [9, 10, 11, 12, 13];   // праздник, каникулы, событие, канун, после праздника (calFeatures)
    function calSig(dateStr) { const v = calFeatures(dateStr); return CAL_KEYS.map(i => v[i] ? 1 : 0).join(''); }

    function weekCount(listTs, center) {
        let n = 0;
        listTs.forEach(t => { if (Math.abs(t - center) <= 3 * DAY) n++; });
        return n;
    }

    function lyTrend(base, T) {
        const key = base + '|' + weekOf(T);
        if (lyMemoTrend.has(key)) return lyMemoTrend.get(key);
        const C = context();
        let now = 0;
        let ly = 0;
        let n = 0;
        (C.byBase[base] || []).forEach(dep => {
            if (!(dep.ts < T && dep.ts >= T - 56 * DAY) || !(dep.sold > 0)) return;
            const e = SalesArchive.entryFor(fmtDate(dep.ts - 364 * DAY), dep.rowCode) || SalesArchive.entryFor(fmtDate(dep.ts - 364 * DAY), base);
            now += dep.sold;
            if (e && e.sold > 0) { ly += e.sold; n++; }
        });
        // Вылеты прошлого года в те же недели, которых нет в паре (другое расписание), — тоже в «тогда».
        let r = 1;
        if (n >= 4 && ly > 0) {
            const raw = Math.max(0.6, Math.min(1.6, now / ly));
            r = (n * raw + 6) / (n + 6);
        }
        lyMemoTrend.set(key, r);
        return r;
    }

    function lyPredict(code, base, ts, h, o, s) {
        if (typeof SalesArchive === 'undefined' || !SalesArchive.entryFor || !(s > 0)) return null;
        const hs = context().histStart;
        const nowCal = calSig(fmtDate(ts));
        let pick = null;
        for (const back of [364, 357, 371]) {
            const lyTs = ts - back * DAY;
            const ds = fmtDate(lyTs);
            let cd = code;
            let e = SalesArchive.entryFor(ds, cd);
            if (!e && base && base !== code) { cd = base; e = SalesArchive.entryFor(ds, cd); }
            if (!e || !(e.sold > 0)) continue;
            const cv = SalesArchive.curveFor(ds, cd);
            if (!cv) continue;
            if (e.h && hs != null && lyTs - h * DAY < hs) continue;   // добор от дня h год назад не весь в истории
            const cand = { e, cv, lyTs, cd, same: calSig(ds) === nowCal };
            if (!pick || (cand.same && !pick.same)) pick = cand;
            if (pick.same) break;
        }
        if (!pick) return null;
        const { e, cv, lyTs, cd } = pick;
        let add = Math.max(0, e.sold - at(cv, h));   // добрали год назад, пассажиров
        const sLy = Math.max(e.sold, e.s0 || e.s || 0);
        if (sLy > 0) add *= Math.sqrt(Math.max(0.5, Math.min(2, s / sLy)));
        // Частота рейсов направления в неделю вокруг вылета: тогда и сейчас.
        const C = context();
        const nowN = weekCount((C.byBase[base] || []).map(d => d.ts), ts) || 1;
        const lyDeps = SalesArchive.departuresFor(cd).concat(cd !== base ? SalesArchive.departuresFor(base) : []);
        const lyN = weekCount(lyDeps.map(d => { const x = parseLocalDate(d.date); return x ? x.getTime() : 0; }), lyTs) || 1;
        add *= Math.max(0.5, Math.min(2, lyN / nowN));
        add *= lyTrend(base, ts - h * DAY);
        return Math.max(o, Math.min(s, Math.round(o + add)));
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
        return rawAt(X, Math.round((X.ts - T) / DAY), T);
    }

    // В файле продаж билетов больше, чем в загрузке (возвраты и обмены, которых в нём не видно), а итог вылета и
    // «продано сейчас» в живом прогнозе — по загрузке. Чтобы обучение и прогноз мерили одно и то же, продажи по файлу
    // приводятся к загрузке: ρ = Σ загрузка / Σ продажи по вылетам рейса, улетевшим до недели T (меньше 30 билетов —
    // по всем рейсам). Только прошлое — без подсказки итогом. Архив истории уже без возвратов — для него ρ = 1.
    function rhoAsOf(base, T) {
        const C = context();
        if (!C.rho) C.rho = new Map();
        const wk = weekOf(T);
        const key = base + '|' + wk;
        if (C.rho.has(key)) return C.rho.get(key);
        const acc = (deps, a) => {
            deps.forEach(X => {
                if (X.arch || !(X.sold > 0) || X.ts + DAY > wk) return;
                const raw = rawOf(X);
                if (raw.total > 0) { a[0] += X.sold; a[1] += raw.total; }
            });
            return a;
        };
        let a = acc(C.byBase[base] || [], [0, 0]);
        if (a[1] < 30) {
            const gk = '*|' + wk;
            if (!C.rho.has(gk)) {
                const g = [0, 0];
                Object.keys(C.byBase).forEach(b => acc(C.byBase[b], g));
                C.rho.set(gk, g[1] >= 30 ? g[0] / g[1] : 1);
            }
            a = null;
        }
        const v = Math.max(0.8, Math.min(1.05, a ? a[0] / a[1] : C.rho.get('*|' + wk)));
        C.rho.set(key, v);
        return v;
    }

    function rawAt(X, d, T) {
        const v = at(rawOf(X), d);
        return X.arch ? v : v * rhoAsOf(X.base, T);
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
        const s = dep.s || 1;
        // Темп за 7 дней — без групп: одна групповая бронь не значит, что рейс «вдруг пошёл».
        const v7 = Math.max(0, (rawAt(dep, h, T) - rawAt(dep, h + 7, T) - groupsBetween(dep, h, h + 7)) / s);
        let nbSum = 0;
        let nbN = 0;
        let pkSum = 0;
        let pkN = 0;
        datesOf(dep.base).forEach(D => {
            if (D.date === dep.date || !(D.s > 0)) return;
            if (Math.abs(D.ts - dep.ts) / DAY <= PV.NB_DAYS) { nbSum += dateSoldAt(D, T, live) / D.s; nbN++; }
            if (D.ts < T && T - D.ts <= PV.PICK_DAYS * DAY) {
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

    // ---------- цепочка добора (advanced pickup, как в RMS авиакомпаний) ----------
    // Добор от h дней до вылета — сумма «звеньев» между соседними точками 30→21→…→1→итог.
    // Звено a→b берётся по всем вылетам, у которых точка b уже наступила к моменту T, — и по ещё не улетевшим:
    // за 30 дней до вылета звено 30→21 известно по вылетам ближайших трёх недель, а не только по улетевшим месяц назад.
    //   vₓ = (продано_b − продано_a)/s,   вес wₓ = e^(−(T − t_b)/τ)
    //   ℓ_общ = Σw·v / Σw;   ℓ_рейс = (Σw·v + K·ℓ_общ)/(Σw + K);   ℓ_рейс×дн = (Σw·v + K₂·ℓ_рейс)/(Σw + K₂)
    //   f̂ = clamp(o + s·Σ ℓ по звеньям от h до итога, o, s)
    function chainAsOf(T) {
        const C = context();
        if (!C.chain) C.chain = new Map();
        if (C.chain.has(T)) return C.chain.get(T);
        const L = NODES.length - 1;
        const mk = () => ({ sw: new Array(L).fill(0), w: new Array(L).fill(0) });
        const res = { glob: mk(), route: Object.create(null), dow: Object.create(null) };
        Object.keys(C.byBase).forEach(base => {
            C.byBase[base].forEach(X => {
                if (!(X.s > 0) || X.ts - NODES[0] * DAY > T) return;
                if (!(rawOf(X).total > 0)) return;
                const R = res.route[base] || (res.route[base] = mk());
                const dk = base + '|' + new Date(X.ts).getDay();
                const D = res.dow[dk] || (res.dow[dk] = mk());
                for (let i = 0; i < L; i++) {
                    const a = NODES[i];
                    const b = NODES[i + 1];
                    // Итог известен, когда вылет улетел (как и для обучения моделей); точка b — когда наступил день b.
                    const tb = b === 0 ? X.ts + DAY : X.ts - b * DAY;
                    if (tb > T) break;
                    const v = ((b === 0 ? X.sold : rawAt(X, b, T)) - rawAt(X, a, T)) / X.s;
                    const w = Math.exp(-(T - tb) / DAY / PV.CHAIN_TAU);
                    [res.glob, R, D].forEach(A => { A.sw[i] += w * v; A.w[i] += w; });
                }
            });
        });
        C.chain.set(T, res);
        if (C.chain.size > 60) C.chain.delete(C.chain.keys().next().value);
        return res;
    }

    // Прогноз по цепочке для вылета (base, дата ts) с продажами o за h дней; null — звеньев ещё нет.
    function chainPredict(T, base, ts, h, o, s) {
        const idx = NODES.indexOf(h);
        if (idx < 0 || !(s > 0)) return null;
        const ch = chainAsOf(T);
        const R = ch.route[base];
        const D = ch.dow[base + '|' + new Date(ts).getDay()];
        let pick = 0;
        if (!(ch.glob.w[idx] > 0)) return null;
        for (let i = idx; i < NODES.length - 1; i++) {
            if (!(ch.glob.w[i] > 0)) continue;   // звена ещё не видно ни по одному вылету — добора по нему не ждём (как «продано на сейчас»)
            const g = ch.glob.sw[i] / ch.glob.w[i];
            const r = R ? (R.sw[i] + PV.CHAIN_K * g) / (R.w[i] + PV.CHAIN_K) : g;
            pick += D ? (D.sw[i] + PV.CHAIN_K_DOW * r) / (D.w[i] + PV.CHAIN_K_DOW) : r;
        }
        return Math.max(0, Math.min(s, Math.round(o + pick * s)));
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
        let t = routeTypeMemo.get(base);
        if (t === undefined) { t = typeof getFlightRouteType === 'function' ? getFlightRouteType(base) : ''; routeTypeMemo.set(base, t); }
        return [t === 'interregional' ? 1 : 0, Math.min(2, (s || 0) / 70)];
    }

    // Полный вектор признаков записи (без свободного члена). Цель — сколько ещё доберёт (доля кресел).
    const FEATURE_GROUPS = [
        ['Продано на сейчас', 1], ['Файл ожидаемой загрузки', 3], ['Прогноз по дням недели', 2], ['Дней до вылета', 1],
        ['Темп продаж за 7 дней', 1], ['Соседние даты рейса', 1], ['Добор рейса за 4 недели', 1], ['Обратный рейс', 2], ['Есть признаки соседей', 1],
        ['День недели', 7], ['Выходной / пятница–воскресенье', 2], ['Праздник', 1], ['Каникулы', 1], ['Событие', 1], ['Канун / после праздника', 2], ['Сезон', 2],
        ['Тип рейса и ВС', 2], ['Добор этого рейса (сглаж.)', 3], ['Рейс часто улетает полным', 1], ['Спрос рейса без ограничения кресел', 1], ['Обычное падение продаж к вылету (возвраты, неявки)', 2],
        ['Открытый класс и цена', 3], ['Группы на руках', 1], ['Кресла в продаже к ёмкости ВС', 1]
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
        ].concat(calFeatures(smp.date), routeFeatures(smp.base, smp.sF || s), smp.eb || [0, 0, 0, 0, 0, 0, 0],
            // Нет данных о цене (история) — 0 и признак «нет»: модель учится на тех, где есть, и не путает «нет» с «дёшево».
            [r.pi ? 1 : 0, r.pi ? r.pk || 0 : 0, r.pi ? r.pf || 0 : 0, r.gh || 0, r.ss || 1]);
    }

    // ---------- линейная модель ----------

    // Признаки стандартизуются (взвешенные среднее и разброс): штраф λ одинаково действует на все веса, независимо
    // от единиц признака (доли кресел, дни, 0/1). Свободный член не штрафуется. Веса возвращаются в исходных единицах.
    async function ridge(X, y, w) {
        const tick = makeYield();
        const k = X[0].length + 1;
        const mu = new Array(k - 1).fill(0);
        const sd = new Array(k - 1).fill(0);
        let sw0 = 0;
        X.forEach((row, i) => { const wi = w ? w[i] : 1; sw0 += wi; for (let j = 0; j < k - 1; j++) mu[j] += wi * row[j]; });
        for (let j = 0; j < k - 1; j++) mu[j] /= sw0 || 1;
        X.forEach((row, i) => { const wi = w ? w[i] : 1; for (let j = 0; j < k - 1; j++) { const d = row[j] - mu[j]; sd[j] += wi * d * d; } });
        for (let j = 0; j < k - 1; j++) sd[j] = Math.sqrt(sd[j] / (sw0 || 1));
        const z = (row) => { const out = [1]; for (let j = 0; j < k - 1; j++) out.push(sd[j] > 1e-9 ? (row[j] - mu[j]) / sd[j] : 0); return out; };
        const A = Array.from({ length: k }, () => new Array(k).fill(0));
        const b = new Array(k).fill(0);
        let sw = 0;
        for (let i = 0; i < X.length; i++) {
            const x = z(X[i]);
            const wi = w ? w[i] : 1;
            sw += wi;
            for (let a = 0; a < k; a++) {
                b[a] += wi * x[a] * y[i];
                for (let c = a; c < k; c++) A[a][c] += wi * x[a] * x[c];
            }
            if ((i & 255) === 255) await tick();
        }
        for (let a = 0; a < k; a++) for (let c = 0; c < a; c++) A[a][c] = A[c][a];
        // Штраф — в той же мере, что без весов: λ·(Σw/n).
        const lam = PV.LAMBDA * (X.length ? sw / X.length : 1);
        for (let a = 1; a < k; a++) A[a][a] += lam;
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
        const beta = b.map((v, i) => (Math.abs(A[i][i]) < 1e-12 ? 0 : v / A[i][i]));
        const out = [beta[0]];
        for (let j = 0; j < k - 1; j++) {
            const wj = sd[j] > 1e-9 ? beta[j + 1] / sd[j] : 0;
            out.push(wj);
            out[0] -= wj * mu[j];
        }
        return out;
    }

    function linPredict(w, x) {
        let s = w[0];
        for (let i = 0; i < x.length; i++) s += w[i + 1] * x[i];
        return s;
    }

    // ---------- решающие деревья (градиентный бустинг) ----------

    // Потери Хьюбера: большие ошибки (группы, отмены) не тянут деревья — ближе к средней ошибке в пассажирах.
    // gbmCore самодостаточна (без внешних имён): её исходный текст уходит в фоновый поток браузера, там деревья
    // обучаются параллельно и не трогают интерфейс. Нет потока — тот же код считается в основном потоке с паузами.
    async function gbmCore(X, y, w, P, tick) {
        const n = X.length;
        const k = X[0].length;
        // Пороги — квантили признака; значения раскладываются по корзинам один раз на обучение
        // (номер корзины: v ≤ cuts[c] ⟺ корзина ≤ c), дальше деревья работают только с номерами корзин.
        const cuts = [];
        const bins = [];
        for (let f = 0; f < k; f++) {
            const vals = new Float64Array(n);
            for (let i = 0; i < n; i++) vals[i] = X[i][f];
            const sorted = vals.slice().sort();
            const set = new Set();
            for (let q = 1; q < P.bins; q++) set.add(sorted[Math.floor(q * (n - 1) / P.bins)]);
            const cs = [...set].sort((a, c) => a - c);
            cuts.push(cs);
            const bf = new Uint8Array(n);
            for (let i = 0; i < n; i++) {
                const v = vals[i];
                let lo = 0;
                let hi = cs.length;
                while (lo < hi) { const m = (lo + hi) >> 1; if (v <= cs[m]) hi = m; else lo = m + 1; }
                bf[i] = lo;
            }
            bins.push(bf);
        }
        const sortedY = Float64Array.from(y).sort();
        const base = sortedY[Math.floor(n / 2)];   // медиана
        const absDev = Float64Array.from(y, v => Math.abs(v - base)).sort();
        const delta = Math.max(0.02, absDev[Math.floor(0.9 * (n - 1))]);
        const pred = new Float64Array(n).fill(base);
        const res = new Float64Array(n);
        const trees = [];
        const gain = new Array(k).fill(0);
        const all = new Int32Array(n);
        for (let i = 0; i < n; i++) all[i] = i;
        const wt = w ? Float64Array.from(w) : new Float64Array(n).fill(1);
        const ws = { bs: new Float64Array(P.bins + 1), bn: new Int32Array(P.bins + 1), bw: new Float64Array(P.bins + 1), w: wt };

        // Узел: лучший порог по всем признакам (максимум G = S_L²/n_L + S_R²/n_R − S²/n).
        function grow(idx, depth) {
            const nAll = idx.length;
            const { bs, bn, bw, w } = ws;
            let total = 0;
            let wAll = 0;
            for (let j = 0; j < nAll; j++) { const i = idx[j]; total += w[i] * res[i]; wAll += w[i]; }
            const mean = wAll > 0 ? total / wAll : 0;
            if (depth >= P.depth || nAll < P.minLeaf * 2) return { v: mean };
            let best = null;
            for (let f = 0; f < cuts.length; f++) {
                const cs = cuts[f];
                if (!cs.length) continue;
                const bf = bins[f];
                bs.fill(0);
                bn.fill(0);
                bw.fill(0);
                for (let j = 0; j < nAll; j++) { const i = idx[j]; const b = bf[i]; bs[b] += w[i] * res[i]; bn[b]++; bw[b] += w[i]; }
                let ls = 0;
                let ln = 0;
                let lw = 0;
                for (let c = 0; c < cs.length; c++) {
                    ls += bs[c];
                    ln += bn[c];
                    lw += bw[c];
                    const rn = nAll - ln;
                    const rw = wAll - lw;
                    if (ln < P.minLeaf || rn < P.minLeaf || lw <= 0 || rw <= 0) continue;
                    const rs = total - ls;
                    const g = ls * ls / lw + rs * rs / rw - total * total / wAll;
                    if (!best || g > best.g) best = { g, f, c, thr: cs[c] };
                }
            }
            if (!best || best.g <= 1e-9) return { v: mean };
            gain[best.f] += best.g;
            const bf = bins[best.f];
            let nl = 0;
            for (let j = 0; j < nAll; j++) if (bf[idx[j]] <= best.c) nl++;
            const L = new Int32Array(nl);
            const R = new Int32Array(nAll - nl);
            let a = 0;
            let z = 0;
            for (let j = 0; j < nAll; j++) { const i = idx[j]; if (bf[i] <= best.c) L[a++] = i; else R[z++] = i; }
            return { f: best.f, c: best.c, thr: best.thr, l: grow(L, depth + 1), r: grow(R, depth + 1) };
        }

        for (let t = 0; t < P.rounds; t++) {
            for (let i = 0; i < n; i++) { const r = y[i] - pred[i]; res[i] = r > delta ? delta : (r < -delta ? -delta : r); }
            const tree = grow(all, 0);
            trees.push(tree);
            for (let i = 0; i < n; i++) {
                let nd = tree;
                while (nd.v === undefined) nd = bins[nd.f][i] <= nd.c ? nd.l : nd.r;
                pred[i] += P.rate * nd.v;
            }
            if (tick) await tick();
        }
        return { base, trees, gain, rate: P.rate };
    }

    // Пул фоновых потоков для деревьев (до 3). Исходный текст потока — из gbmCore (Blob), поэтому отдельного файла нет
    // и работает в любом способе запуска сайта. Нет Worker / запрещён политикой — пул пуст, считаем в основном потоке.
    let gbmPool = null;
    function gbmWorkers() {
        if (gbmPool) return gbmPool;
        gbmPool = { slots: [], free: [], waiters: [] };
        try {
            if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || !URL.createObjectURL) return gbmPool;
            const src = 'const core=' + gbmCore.toString() + ';self.onmessage=async function(e){const d=e.data;try{const X=new Array(d.n);for(let i=0;i<d.n;i++)X[i]=d.xf.subarray(i*d.k,(i+1)*d.k);const m=await core(X,d.y,d.w,d.P,null);self.postMessage({m:m});}catch(err){self.postMessage({err:String(err&&err.message||err)});}};';
            const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
            const n = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));
            for (let i = 0; i < n; i++) { const slot = { w: new Worker(url) }; gbmPool.slots.push(slot); gbmPool.free.push(slot); }
            URL.revokeObjectURL(url);   // воркеры уже стартовали, ссылка больше не нужна
        } catch (e) { gbmPoolOff(); }
        return gbmPool;
    }

    function gbmPoolOff() {
        if (gbmPool) gbmPool.slots.forEach(s => { try { s.w.terminate(); } catch (e) { /* ignore */ } });
        gbmPool = { slots: [], free: [], waiters: [], off: true };
    }

    function gbmParams() {
        return { bins: GBM.bins, rounds: GBM.rounds, depth: GBM.depth, rate: GBM.rate, minLeaf: GBM.minLeaf };
    }

    // Несколько моделей деревьев сразу: jobs = [{ X, y, w }]. Параллельно в потоках; сбой потока — всё заново в основном.
    async function gbmTrainAll(jobs) {
        const P = gbmParams();
        const pool = gbmWorkers();
        if (pool.slots.length) {
            const acquire = () => (pool.free.length ? Promise.resolve(pool.free.pop()) : new Promise(r => pool.waiters.push(r)));
            const release = (s) => { const w = pool.waiters.shift(); if (w) w(s); else pool.free.push(s); };
            try {
                return await Promise.all(jobs.map(j => acquire().then(slot => new Promise((res, rej) => {
                    slot.w.onmessage = (e) => { release(slot); if (e.data && e.data.err) rej(new Error(e.data.err)); else res(e.data.m); };
                    slot.w.onerror = (e) => { release(slot); rej(new Error(e && e.message || 'worker')); };
                    // Данные уходят плоскими буферами с передачей владения: без копирования структуры в основном потоке.
                    const n = j.X.length, k = j.X[0].length;
                    const xf = new Float64Array(n * k);
                    for (let i = 0; i < n; i++) xf.set(j.X[i], i * k);
                    const yf = Float64Array.from(j.y);
                    const wf = j.w ? Float64Array.from(j.w) : null;
                    slot.w.postMessage({ xf, n, k, y: yf, w: wf, P }, wf ? [xf.buffer, yf.buffer, wf.buffer] : [xf.buffer, yf.buffer]);
                }))));
            } catch (e) {
                console.warn('ForecastLab: фоновый поток не сработал, считаю в основном', e);
                gbmPoolOff();
            }
        }
        const out = [];
        for (const j of jobs) {
            let last = Date.now();
            out.push(await gbmCore(j.X, j.y, j.w, P, async () => { if (Date.now() - last > 10) { await pause(); last = Date.now(); } }));
        }
        return out;
    }

    function treeValue(t, x) {
        while (t.v === undefined) t = x[t.f] <= t.thr ? t.l : t.r;
        return t.v;
    }

    function gbmPredict(m, x) {
        let s = m.base;
        const rate = m.rate != null ? m.rate : GBM.rate;
        for (const t of m.trees) s += rate * treeValue(t, x);
        return s;
    }

    // ---------- обучение и прогноз ----------

    // Групповых билетов, купленных после дня h (то есть в доборе, который учит модель), — для вылетов из файла продаж.
    function grpAfterOf(key, h) {
        const C = context();
        const dep = C.byKey[key];
        return dep && !dep.arch ? groupsBetween(dep, -1, h - 1) : 0;
    }

    // Сбой данных: накануне вылета почти пусто (≤15% итога), а улетел заметный вылет (от 15 пасс.) — так не бывает,
    // это выгрузка продаж без части дней. Такой вылет не годится ни для обучения, ни для проверки.
    function isGlitch(e) {
        if (!e || e.f == null || !(e.f >= 15)) return false;
        const r = e.h && (e.h[1] || e.h[3]);
        return !!(r && r.o <= 0.15 * e.f);
    }
    let glitchLive = [];   // для отчёта: какие вылеты исключены

    // Видны ли по вылету возвраты: живые вылеты — да; архив — только с файлом по билетам (иначе он «чистый»,
    // и падения продаж к вылету в нём не видно).
    function grossKnown(dep) {
        if (!dep) return false;
        if (!dep.arch) return true;
        return !!(typeof SalesArchive !== 'undefined' && SalesArchive.ticketsFor && SalesArchive.ticketsFor(dep.date, dep.code));
    }

    // Записи с известным фактом, по дате вылета.
    function samples() {
        const out = [];
        const C = context();
        glitchLive = [];
        Object.keys(log).forEach(key => {
            const e = log[key];
            if (e.f == null) return;
            if (isGlitch(e)) { glitchLive.push(key); return; }
            const date = key.slice(0, key.lastIndexOf('|'));
            const d = parseLocalDate(date);
            if (!d) return;
            Object.keys(e.h).forEach(h => {
                const r = e.h[h];
                const s = r.s || e.s;
                if (!(s > 0)) return;
                const dep = C.byKey[key];
                if (dep && dep.trunc) return;   // ранние продажи вылета не попали в историю — добор ложный
                out.push({ key, base: e.b, date, ts: d.getTime(), h: Number(h), s, sF: dep && dep.sF ? dep.sF : s, r, f: e.f, gr: grossKnown(dep), grpAfter: grpAfterOf(key, Number(h)) });
            });
        });
        out.sort((a, b) => a.ts - b.ts || a.h - b.h || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        // Признак «добор этого рейса» — на день прогноза T = дата − h: только по вылетам, улетевшим до T
        // (своего итога строка не видит). Проход по строкам в порядке T, улетевшие добавляются по мере наступления.
        const acc = ebEmpty();
        const byT = out.slice().sort((a, b) => (a.ts - a.h * DAY) - (b.ts - b.h * DAY));
        let ptr = 0;
        byT.forEach(x => {
            const T = x.ts - x.h * DAY;
            while (ptr < out.length && out[ptr].ts + DAY <= T) ebAdd(acc, out[ptr++]);
            x.eb = ebFeature(acc, x.base, x.h, x.sF || x.s);
        });
        while (ptr < out.length) ebAdd(acc, out[ptr++]);
        ebLive = acc;
        return out;
    }

    // Добор рейса, сглаженный к среднему по всем рейсам (эмпирический Байес):
    //   t̄ₕ = Σtₕ / nₕ (все рейсы),   t̂_рейс,h = (Σ_рейс tₕ + K·t̄ₕ) / (n_рейс + K)
    let ebLive = null;               // накопленное по всем улетевшим — для сегодняшних прогнозов

    function ebEmpty() {
        return { H: Object.create(null), G: Object.create(null), R: Object.create(null) };
    }

    // Группа похожих рейсов: тип (межрегиональный / краевой) × ёмкость (до 50 / до 80 / больше кресел).
    // Добор редкого рейса сжимается сначала к своей группе, а не ко всем рейсам сразу.
    function ebGroup(base, s) {
        let t = routeTypeMemo.get(base);
        if (t === undefined) { t = typeof getFlightRouteType === 'function' ? getFlightRouteType(base) : ''; routeTypeMemo.set(base, t); }
        return (t === 'interregional' ? 'i' : 'k') + (s <= 50 ? 46 : (s <= 80 ? 72 : 120));
    }

    function ebAdd(acc, x) {
        // Вылет, где после этого дня пришла группа, — не про обычный добор рейса (группа — отдельный поток).
        if (x.grpAfter >= PV.GROUP_MIN) return;
        const t = target(x);
        // Улетел почти полным (≥ 95% кресел): добор обрезан креслами — спрос был больше, чем видно.
        const fu = x.f >= 0.95 * x.s ? 1 : 0;
        const H = acc.H[x.h] || (acc.H[x.h] = { s: 0, n: 0, fu: 0 });
        const gk = ebGroup(x.base, x.sF || x.s) + '|' + x.h;
        const G = acc.G[gk] || (acc.G[gk] = { s: 0, n: 0, fu: 0 });
        const R = acc.R[x.base + '|' + x.h] || (acc.R[x.base + '|' + x.h] = { s: 0, n: 0, fu: 0 });
        H.s += t; H.n++; H.fu += fu;
        G.s += t; G.n++; G.fu += fu;
        R.s += t; R.n++; R.fu += fu;
        // Падение к вылету: сколько кресел в среднем «уходит» (возвраты, неявки) и как часто итог ниже проданного.
        if (x.gr) {
            const dn = t < 0 ? -t : 0;
            const ng = t < 0 ? 1 : 0;
            H.dn = (H.dn || 0) + dn; H.ng = (H.ng || 0) + ng; H.gn = (H.gn || 0) + 1;
            G.dn = (G.dn || 0) + dn; G.ng = (G.ng || 0) + ng; G.gn = (G.gn || 0) + 1;
            R.dn = (R.dn || 0) + dn; R.ng = (R.ng || 0) + ng; R.gn = (R.gn || 0) + 1;
        }
        // Восстановление спроса (projection detruncation): добор полных вылетов заменяется ожиданием добора
        // при условии «не меньше увиденного» по нормальному закону добора группы на этом горизонте,
        // оценённому по неполным вылетам: E[t | t ≥ c] = μ + σ·φ(a)/(1 − Φ(a)), a = (c − μ)/σ.
        if (!fu) { G.us = (G.us || 0) + t; G.uq = (G.uq || 0) + t * t; G.un = (G.un || 0) + 1; }
        let tu = t;
        if (fu && G.un >= 20) {
            const mu = G.us / G.un;
            const sd = Math.sqrt(Math.max(1e-6, G.uq / G.un - mu * mu));
            const a = (t - mu) / sd;
            const tail = 1 - normCdf(a);
            tu = Math.max(t, tail > 1e-4 ? mu + sd * normPdf(a) / tail : t);
        }
        R.u = (R.u || 0) + tu;
        G.u = (G.u || 0) + tu;
        H.u = (H.u || 0) + tu;
    }

    function normPdf(a) { return Math.exp(-a * a / 2) / Math.sqrt(2 * Math.PI); }
    function normCdf(a) {
        // Abramowitz–Stegun 26.2.17, точность ~1e-7.
        const t = 1 / (1 + 0.2316419 * Math.abs(a));
        const p = normPdf(a) * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
        return a >= 0 ? 1 - p : p;
    }

    // Добор рейса: t̂ = (Σ_рейс + K·t̄_группы)/(n_рейс + K),  t̄_группы = (Σ_группы + K·t̄_все)/(n_группы + K).
    function ebPick(acc, base, h, K, s) {
        const H = acc && acc.H[h];
        if (!H || H.n < 10) return null;
        const all = H.s / H.n;
        const G = s ? acc.G[ebGroup(base, s) + '|' + h] : null;
        const grp = G && G.n ? (G.s + K * all) / (G.n + K) : all;
        const R = acc.R[base + '|' + h] || { s: 0, n: 0, fu: 0 };
        const fAll = H.fu / H.n;
        const fGrp = G && G.n ? (G.fu + K * fAll) / (G.n + K) : fAll;
        const uAll = (H.u || H.s) / H.n;
        const uGrp = G && G.n ? ((G.u || G.s) + K * uAll) / (G.n + K) : uAll;
        const m = (a, gn) => (gn > 0 ? a / gn : 0);
        const dnAll = m(H.dn || 0, H.gn || 0);
        const dnGrp = G && G.gn ? ((G.dn || 0) + K * dnAll) / (G.gn + K) : dnAll;
        const ngAll = m(H.ng || 0, H.gn || 0);
        const ngGrp = G && G.gn ? ((G.ng || 0) + K * ngAll) / (G.gn + K) : ngAll;
        return { dn: ((R.dn || 0) + K * dnGrp) / ((R.gn || 0) + K), ng: ((R.ng || 0) + K * ngGrp) / ((R.gn || 0) + K), v: (R.s + K * grp) / (R.n + K), n: R.n, fu: (R.fu + K * fGrp) / (R.n + K), u: ((R.u || R.s) + K * uGrp) / (R.n + K) };
    }

    // [добор рейса, есть, доверие, доля вылетов рейса, улетевших полными] — последний: насколько добор рейса
    // занижен креслами (цензурированный спрос). Высокая доля — спрос выше того, что рейс успевает «показать».
    function ebFeature(acc, base, h, s) {
        const e = ebPick(acc, base, h, PV.EB_K_FEAT, s);
        return e ? [e.v, 1, e.n / (e.n + PV.EB_K_FEAT), e.fu, e.u, e.dn, e.ng] : [0, 0, 0, 0, 0, 0, 0];
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
        const eb = ebEmpty();
        list.forEach(x => ebAdd(eb, x));
        Object.defineProperty(out, 'eb', { value: eb, enumerable: false });
        return out;
    }

    // Тот же poolOf, но по нарастающей: срезы идут по времени, к прошлому срезу добавляются только новые вылеты
    // (раньше на каждый срез всё пересчитывалось заново — квадратично, ~7 с на слабом ПК). Снимок eb — копия.
    function poolStream() {
        const acc = {};
        const eb = ebEmpty();
        let done = 0;
        const copy = (m) => { const o = Object.create(null); Object.keys(m).forEach(k => { o[k] = { s: m[k].s, n: m[k].n }; }); return o; };
        return (all, len) => {
            for (; done < len; done++) {
                const x = all[done];
                const a = acc[x.h] || (acc[x.h] = { sum: 0, n: 0 });
                a.sum += target(x); a.n++;
                ebAdd(eb, x);
            }
            const out = {};
            Object.keys(acc).forEach(h => { if (acc[h].n >= 10) out[h] = acc[h].sum / acc[h].n; });
            Object.defineProperty(out, 'eb', { value: { H: copy(eb.H), G: copy(eb.G), R: copy(eb.R) }, enumerable: false });
            return out;
        };
    }

    // Вес записи по давности вылета: wᵢ = 2^(−(T − tsᵢ)/τ½), T — последний вылет в наборе.
    function recencyWeights(list) {
        if (!(PV.HALF_LIFE > 0) || !list.length) return null;
        let T = -Infinity;
        list.forEach(x => { if (x.ts > T) T = x.ts; });
        return list.map(x => Math.pow(2, -(T - x.ts) / (PV.HALF_LIFE * DAY)));
    }

    async function train(list) {
        if (list.length > PV.TRAIN_MAX) {
            // Свежие недели — целиком, более старые — каждая m-я запись: в обучение попадают все сезоны истории.
            const recent = PV.TRAIN_MAX / 2;
            const head = list.slice(0, list.length - recent);
            const step = head.length / (PV.TRAIN_MAX - recent);
            const pick = [];
            for (let j = 0; j < PV.TRAIN_MAX - recent; j++) pick.push(head[Math.floor(j * step)]);
            list = pick.concat(list.slice(list.length - recent));
            list.thin = { n: pick.length, step };
        }
        if (list.length < PV.MIN_TRAIN) return null;
        const X = await mapAsync(list, x => features(x));
        const y = list.map(target);
        const W = recencyWeights(list);
        // Прореженная старая часть — каждая m-я запись — весит за m записей: вес по давности не умножается на прореживание.
        if (W && list.thin) for (let i = 0; i < list.thin.n; i++) W[i] *= list.thin.step;
        // Деревья: общие и отдельные на близкие (1–3 дня), средние (5–10) и дальние (14–30) горизонты — параллельно.
        const jobs = [{ X, y, w: W }];
        const gids = [];
        GROUPS.forEach(g => {
            const ids = [];
            list.forEach((x, i) => { if (g.hs.includes(x.h)) ids.push(i); });
            if (ids.length >= PV.MIN_TRAIN) { gids.push(g.id); jobs.push({ X: ids.map(i => X[i]), y: ids.map(i => y[i]), w: W && ids.map(i => W[i]) }); }
        });
        const trees = await gbmTrainAll(jobs);
        const res = { n: list.length, lin: {}, linAll: await ridge(X, y, W), gbm: trees[0], gbmG: {} };
        gids.forEach((id, j) => { res.gbmG[id] = trees[j + 1]; });
        for (const h of HORIZONS) {
            const ids = [];
            list.forEach((x, i) => { if (x.h === h) ids.push(i); });
            if (ids.length >= PV.MIN_TRAIN_H) res.lin[h] = await ridge(ids.map(i => X[i]), ids.map(i => y[i]), W && ids.map(i => W[i]));
        }
        // Отдельной поправки по рейсу нет: она считалась по остаткам на тех же данных, на которых училась модель
        // (двойная подстройка), а признак «добор этого рейса» уже несёт особенности рейса. Без неё проверка точнее.
        return res;
    }

    // { lin, gbm, ens } — итог в пассажирах (от нуля до числа кресел: в последние дни возвраты бывают больше новых продаж).
    function predictAll(m, smp) {
        if (!m) return null;
        const x = features(smp);
        const o = smp.r.o / smp.s;
        const clamp = (lf) => Math.max(0, Math.min(smp.s, Math.round((o + lf) * smp.s)));
        const l = linPredict(m.lin[smp.h] || m.linAll, x);
        const gg = m.gbmG && m.gbmG[groupOf(smp.h).id];
        const g = gg ? (1 - PV.GBM_GROUP_MIX) * gbmPredict(m.gbm, x) + PV.GBM_GROUP_MIX * gbmPredict(gg, x) : gbmPredict(m.gbm, x);
        return { lin: clamp(l), gbm: clamp(g), ens: clamp((l + g) / 2) };
    }

    // Простые способы. pool — средний добор всех рейсов на этом горизонте (по вылетам, улетевшим к моменту прогноза).
    function simple(k, r, s, pool, h, base) {
        const pp = r.p != null && r.q != null ? Math.max(r.o, Math.min(s, Math.round(r.o + r.p - r.q))) : null;
        const pl = pool && pool[h] != null ? Math.max(0, Math.min(s, Math.round(r.o + pool[h] * s))) : null;
        if (k === 'naive') return r.o;
        if (k === 'pool') return pl;
        if (k === 'planPick') return pp;
        if (k === 'plan') return r.p != null ? Math.min(s, r.p) : null;
        if (k === 'planOr') return r.p != null ? Math.max(r.o, Math.min(s, r.p)) : null;
        if (k === 'hist') return r.y;
        if (k === 'eb') {
            const e = pool && pool.eb && base ? ebPick(pool.eb, base, h, PV.EB_K, s) : null;
            return e ? Math.max(0, Math.min(s, Math.round(r.o + e.v * s))) : null;
        }
        return null;
    }

    // Сегмент вылета: от него зависит, какие способы вообще есть.
    function segOf(r) {
        return r.p != null ? 'plan' : (r.y != null ? 'hist' : 'none');
    }

    // Конкурент на линии рейса в эту дату вылета (по названию направления), иначе null.
    function competitorOf(base, ts) {
        const dir = typeof getFlightDirection === 'function' ? String(getFlightDirection(base) || '') : '';
        const c = COMPETITION.find(cp => cp.cities.every(city => dir.includes(city)));
        if (!c) return null;
        const since = parseLocalDate(c.since);
        return !since || ts >= since.getTime() ? c.who : null;
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

    // Что было на вылете в день T (за h дней): открытый класс и цена, группы на руках, кресла в продаже к ёмкости ВС.
    // Только для вылетов из текущего файла продаж (в истории по дням цены и класса нет) — у остальных pi = 0.
    function isAdultPaidSale(x) {
        return FareGrid.isAdultPaid(x);   // общая логика (fare-grid.js)
    }
    function stateAt(dep, h, T, s) {
        const out = {};
        if (dep.arch) {
            // Вылеты истории: класс и цена, группы — из SalesTickets.csv (если загружен).
            const tk = typeof SalesArchive !== 'undefined' && SalesArchive.ticketsFor ? SalesArchive.ticketsFor(dep.date, dep.code) : null;
            if (!tk) return out;
            if (tk.gh && tk.gh[h] && s > 0) out.gh = Math.round(tk.gh[h] / s * 1000) / 1000;
            const pv = tk.p && tk.p[h];
            const ladder = pv && typeof FareGrid !== 'undefined' ? FareGrid.ladderFor(dep.code, dep.date) : [];
            if (!pv || ladder.length < 2) return out;
            const prices = ladder.map(l => l.price).sort((a, b) => a - b);
            const mid = prices[prices.length >> 1];
            let best = -1;
            String(pv[0] || '').split('').forEach(c => { const i = ladder.findIndex(l => l.cls === c); if (i > best) best = i; });
            const price = best >= 0 ? ladder[best].price : Number(pv[1]) || mid;
            out.pi = 1;
            out.pc = best >= 0 ? ladder[best].cls : '';
            out.pk = best >= 0 ? Math.round(best / (ladder.length - 1) * 1000) / 1000 : 0.5;
            out.pf = Math.round(Math.max(-0.6, Math.min(0.8, price / mid - 1)) * 1000) / 1000;
            return out;
        }
        if (dep.row && s > 0) {
            const cap = getCapacityFromAircraft(getAircraftType(dep.row[4]));
            if (cap > 0) out.ss = Math.round(Math.min(1.5, s / cap) * 1000) / 1000;
        }
        const held = groupsBetween(dep, h - 1, 400);
        if (held > 0 && s > 0) out.gh = Math.round(held / s * 1000) / 1000;
        const list = typeof getFlightSalesList === 'function' ? getFlightSalesList(dep.date, dep.code) : [];
        let last = -Infinity;
        const tsOf = (x) => { const dd = parseLocalDate(x.dealDate); return dd ? dd.getTime() : null; };
        const paid = list.filter(x => { const t = tsOf(x); if (t == null || t > T || !isAdultPaidSale(x)) return false; if (t > last) last = t; return true; });
        if (!paid.length) return out;
        const day = paid.filter(x => tsOf(x) === last);
        const ladder = typeof FareGrid !== 'undefined' ? FareGrid.ladderFor(dep.code, dep.date) : [];
        if (ladder.length < 2) return out;
        const prices = ladder.map(l => l.price).sort((a, b) => a - b);
        const mid = prices[prices.length >> 1];
        let best = -1;
        day.forEach(x => { const i = ladder.findIndex(l => l.cls === String(x.basicFareStr || '').trim().charAt(0).toUpperCase()); if (i > best) best = i; });
        const price = best >= 0 ? ladder[best].price : Math.max(...day.map(x => x.adjustedFare || x.fare));
        out.pi = 1;
        out.pc = best >= 0 ? ladder[best].cls : '';
        out.pk = best >= 0 ? Math.round(best / (ladder.length - 1) * 1000) / 1000 : 0.5;
        out.pf = Math.round(Math.max(-0.6, Math.min(0.8, price / mid - 1)) * 1000) / 1000;
        return out;
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
        return Object.assign({ d, o, p: num(p), q: num(q), y: hy.y, n: hy.n || null, m: null, b: 0, s, x }, stateAt(dep, d, T, s));
    }

    const METHOD_LABEL = {
        blend: 'комитет моделей', chain: 'цепочка добора', eb: 'добор этого рейса', ly: 'прошлый год', ens: 'модель', gbm: 'модель (деревья)', lin: 'модель (линейная)', planOr: 'файл ожидаемой загрузки',
        planPick: 'продано + добор по файлу', hist: 'по тем же дням недели', pool: 'средний добор всех рейсов', naive: 'продано на сейчас'
    };

    // Прогноз для вылета (карточка): способ, который ошибался меньше всех для этого горизонта и такого вылета.
    function predict(code, date) {
        if (!canView() || !loaded) return null;
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
        // Продажи закрыты — добора не будет: итог = продано.
        if (dep.row && typeof closedFlights !== 'undefined' && typeof getSalesLookupKey === 'function' && closedFlights.has(getSalesLookupKey(dep.row))) {
            return { final: r.o, lo: r.o, hi: r.o, hiRaw: r.o, sold: r.o, d, plan: r.p, team: [], cover: null, seats: r.s, lf: Math.round(r.o / r.s * 100), method: 'продажи закрыты', err: 0, trainedOn: 0, h, closed: true };
        }
        const pick = ev.choice[h + '|' + segOf(r)] || ev.choice[h];
        if (!pick) return null;
        // Все способы на сейчас — для комитета и для показа, кто на этом рейсе весит больше.
        const T = dep.ts - d * DAY;
        const ml = models ? predictAll(models, { base, date, ts: dep.ts, h, s: r.s, r, eb: ebFeature(ebLive, base, h, r.s) }) : null;
        const hLo0 = HORIZONS.find(x => x < h) || 0;
        // Модели обучены на контрольных днях: между ними — прогноз модели соседнего меньшего дня, и добор линейно между ними.
        const mlLo = models && d < h && hLo0 ? predictAll(models, { base, date, ts: dep.ts, h: hLo0, s: r.s, r, eb: ebFeature(ebLive, base, hLo0, r.s) }) : null;
        const at0 = (k, hh) => {
            if (k === 'chain') return chainPredict(T, base, dep.ts, hh, r.o, r.s);
            if (k === 'ly') return lyPredict(dep.rowCode, base, dep.ts, hh, r.o, r.s);
            return simple(k, r, r.s, ev.pool, hh, base);
        };
        // Сегодня между контрольными днями (d < h): добор считается от d, а не от h — иначе в прогноз вошёл бы
        // добор, который уже продан. Добор от d — линейно между соседними контрольными днями h и h₋ (у вылета — 0).
        const hLo = HORIZONS.find(x => x < h) || 0;
        const one = (k) => {
            if (k === 'ens' || k === 'gbm' || k === 'lin') {
                if (!ml) return null;
                if (!mlLo || d >= h) return ml[k];
                const w = (d - hLo0) / (h - hLo0);
                return Math.max(0, Math.min(r.s, Math.round(mlLo[k] + w * (ml[k] - mlLo[k]))));
            }
            const vHi = at0(k, h);
            if (vHi == null || d >= h || !['pool', 'eb', 'chain', 'ly'].includes(k)) return vHi;
            const vLo = hLo ? at0(k, hLo) : r.o;
            if (vLo == null) return vHi;
            const w = (d - hLo) / (h - hLo);
            return Math.max(0, Math.min(r.s, Math.round(vLo + w * (vHi - vLo))));
        };
        const vals = {};
        expertsFor(h).forEach(k => { const v = one(k); if (v != null) vals[k] = v; });
        if (!Object.keys(vals).length) vals.naive = r.o;
        const weights = committeeWeights(ev.committee, base, h, r, vals);
        const blendV = committeeBlend(weights, vals, r.o, r.s);
        let final = pick.k === 'blend' ? blendV : one(pick.k);
        let usedK = pick.k;
        if (final == null && blendV != null) { final = blendV; usedK = 'blend'; }   // у выбранного нет прогноза — комитет
        const team = weights ? Object.keys(weights).sort((a, b) => weights[b] - weights[a])
            .map(k => ({ k, label: METHOD_LABEL[k], w: Math.round(weights[k] * 100), v: vals[k] })).filter(x => x.w >= 1) : [];
        // Интервал 80%: [f̂ + q_lo·s, f̂ + q_hi·s], снизу 0 (неявки и возвраты бывают), сверху — кресла.
        let lo = null;
        let hi = null;
        // Интервал по загрузке, какой выйдет у прогноза (до калибровки); мало рейсов такой загрузки — общий.
        const vForBand = final != null ? final : r.o;
        const c = ev.conf && (ev.conf[h + '|' + segOf(r) + '|' + loadBand(vForBand, r.s)] || ev.conf[h + '|' + segOf(r)]);
        // Интервал — только если проверялся тот же расчёт, что идёт вживую: комитет и модели на горизонте,
        // где модели проверить было не на чем, вживую устроены иначе, чем в проверке.
        const sameAsEval = ['planOr', 'planPick', 'hist', 'naive'].includes(usedK) || !(ev.byH[h] && ev.byH[h].simpleOnly);
        if (final != null && c && c.k === usedK && sameAsEval) {
            // Снизу — не меньше уже проданного: «8 из 10» показывает, сколько ещё доберут.
            lo = Math.min(final, Math.max(0, Math.round(final + c.lo * r.s)));
            hi = Math.max(final, Math.min(Math.max(r.s, r.o), Math.round(final + c.hi * r.s)));
        }
        if (final == null) final = r.o;
        // Калибровка по уровню загрузки (если на проверке она уменьшила ошибку) — интервал сдвигается вместе с прогнозом.
        if (ev.calib) {
            const l = final / r.s;
            const b = l < 0.5 ? 0 : (l < 0.7 ? 1 : (l < 0.85 ? 2 : (l < 0.95 ? 3 : 4)));
            const c = ev.calib[groupOf(h).id + '|' + b] || 0;
            const shifted = Math.max(0, Math.min(r.s, Math.round(final + c * r.s)));
            const dlt = shifted - final;
            final = shifted;
            if (lo != null) { lo = Math.max(0, Math.min(final, lo + dlt)); hi = Math.max(final, Math.min(Math.max(r.s, r.o), hi + dlt)); }
        }
        const hiRaw = lo != null ? Math.ceil(final + c.hi * r.s) : null;   // без ограничения креслами — спрос сверх ёмкости
        const mlNow = ml ? one('ens') : null;   // прогноз самих моделей на сейчас — для сравнения с записью недельной давности
        return { final, lo, hi, hiRaw, mlNow, sold: r.o, d, plan: r.p, team, cover: lo != null ? Math.round(PV.CONF_LEVEL * 100) : null, seats: r.s, lf: Math.round(final / r.s * 100), method: METHOD_LABEL[usedK], err: Math.round(pick.v * 10) / 10, trainedOn: pick.n, h };
    }

    // ---------- запись журнала ----------

    // Восстановить записи улетевшего вылета: что было известно за h дней до вылета.
    function backfill(dep) {
        const s = dep.s;
        const f = dep.sold;
        if (!(s > 0) || !(f > 0)) return null;
        const raw = rawOf(dep);
        if (!(raw.total > 0)) return null;
        const cap = dep.row ? getCapacityFromAircraft(getAircraftType(dep.row[4])) : (getCapacityFromAircraft(dep.ac) || s);
        const wk = getWeekForExpectedLoad(dep.date);
        // Файл ожидаемой загрузки — на текущий год: вылетам прошлых лет он не подходит.
        const planOk = !dep.arch || new Date(dep.ts).getFullYear() === new Date(todayTs()).getFullYear();
        const p = planOk ? getExpectedLoad(cap, dep.base, 0, wk) : null;
        const e = { b: dep.base, s, f, h: {} };
        HORIZONS.forEach(h => {
            const T = dep.ts - h * DAY;
            // Только то, что было в продажах к этому дню (без подсказки итогом вылета).
            // История продаж — за вычетом всех будущих возвратов; живые данные — с ними. Билеты, сданные позже дня h,
            // на тот день были на руках — добавляем их (SalesTickets.csv), иначе модель учится не на том «продано».
            const tk = dep.arch && typeof SalesArchive !== 'undefined' && SalesArchive.ticketsFor ? SalesArchive.ticketsFor(dep.date, dep.code) : null;
            const o = Math.round(rawAt(dep, h, T)) + (tk && tk.ro && tk.ro[h] ? tk.ro[h] : 0);
            const hy = histAsOf(dep, h, T, o);
            const x = neighborFeatures(dep, h, T, false, o).map(v => Math.round(v * 1000) / 1000);
            e.h[h] = Object.assign({ d: h, o, p: num(p), q: planOk ? num(getExpectedLoad(cap, dep.base, h, wk)) : null, y: hy.y, n: hy.n || null, m: null, b: 1, bv: BACKFILL_V, ai: historyStamp(), s, x }, stateAt(dep, h, T, s));
        });
        return e;
    }

    function dataToken() {
        const at0 = typeof lastSalesUpdate !== 'undefined' && lastSalesUpdate ? new Date(lastSalesUpdate).getTime() : 0;
        return `v4|${today()}|${at0}|${(typeof allData !== 'undefined' && allData ? allData.length : 0)}`;
    }

    // Записи журнала — по очереди: запись после загрузки истории и запись при входе не затирают друг друга.
    let captureChain = Promise.resolve();

    function capture(force) {
        const run = captureChain.catch(() => null).then(() => capture0(force));
        captureChain = run;
        return run;
    }

    async function capture0(force) {
        if (!canWrite() || typeof SharedStorage === 'undefined') return false;
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
                    const need = !cur || HORIZONS.some(h => !cur.h[h] || offDay(cur.h[h], h) || (cur.h[h].b && ((cur.h[h].bv || 0) < BACKFILL_V || (cur.h[h].ai || '') !== historyStamp())));
                    if (need) {
                        const e = backfill(dep);
                        if (e) { add(key, dep.date, e); backfilled++; }
                    }
                } else if (!stale) {
                    const d = dataDtd(dep.date);
                    if (d == null || d <= 0 || d > 30) continue;
                    // Только в сам контрольный день: запись «за 7 дней» с продажами на 5-й день учила бы модель не тому.
                    // Пропущенный день восстановится после вылета (по кривой продаж).
                    const h = horizonFor(d);
                    if (h !== d || (cur && cur.h[h] && !cur.h[h].b)) continue;
                    const r = liveRecord(dep, d);
                    if (!r) continue;
                    if (models) r.m = predictAll(models, { base, date: dep.date, ts: dep.ts, h, s: r.s, r, eb: ebFeature(ebLive, base, h, r.s) }).ens;
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
        // Общий прогноз читают все (небольшой файл); обучаются — те, кому виден отчёт.
        const pub = () => readPublished().catch(() => null);
        if (typeof requestIdleCallback === 'function') requestIdleCallback(pub, { timeout: 8000 });
        else setTimeout(pub, 2000);
        if (!canView()) return;
        const run = () => ensureLoaded()
            .then(() => new Promise(r => startEvaluation(r)))
            .then(() => (canWrite() ? capture() : false))
            .then(() => startEvaluation())
            .catch(e => console.warn('ForecastLab', e));
        if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 30000 });
        else setTimeout(run, 5000);
    }

    // ---------- честная проверка (в фоне) ----------

    const modelCache = new Map();   // между запусками: обучающий набор не изменился — модель не переобучается

    async function cachedTrain(all, len, cum) {
        const cal = typeof CalendarEvents !== 'undefined' && CalendarEvents.revision ? CalendarEvents.revision() : 0;
        const key = `${len}|${cum[len]}|${cal}|${typeof Params !== 'undefined' ? Params.revision() : 0}`;   // параметры модели поменялись — переобучить
        if (modelCache.has(key)) return modelCache.get(key);
        const m = await train(all.slice(0, len));
        modelCache.set(key, m);
        if (modelCache.size > 40) modelCache.delete(modelCache.keys().next().value);
        return m;
    }

    // Прежний выбор способа — общий (из forecast-now.json), чтобы у всех администраторов был один и тот же прогноз;
    // нет общего — свой из браузера.
    function loadChoiceLocal() {
        try { return JSON.parse(localStorage.getItem(CHOICE_KEY) || '{}') || {}; } catch (e) { return {}; }
    }

    function loadChoicePrev() {
        if (published.choice && typeof published.choice === 'object') return published.choice;
        return loadChoiceLocal();
    }

    function saveChoice(c) {
        const out = {};
        Object.keys(c).forEach(k => { if (c[k]) out[k] = c[k].k; });
        try { localStorage.setItem(CHOICE_KEY, JSON.stringify(out)); } catch (e) { /* ignore */ }
    }

    // ---------- комитет моделей ----------
    // Все способы работают одновременно; вес каждого — по его честным ошибкам на этом рейсе (вылеты, улетевшие
    // до момента прогноза), сжатым к ошибке на всех рейсах того же типа (горизонт 1–3 / 5–10 / 14–30 × сегмент):
    //   L_общ,k = (Σ|eₖ| + K·L₀)/(n + K),   L_рейс,k = (Σ|eₖ| на рейсе + K·L_общ,k)/(n_рейс + K),   e = (f̂ − f)/s
    //   wₖ ∝ exp(−η·(Lₖ/L_min − 1)),  способы с Lₖ > 2·L_min не входят;  f̂ = Σ wₖ·f̂ₖ / Σ wₖ
    // Нет прогноза у какого-то способа (нет файла, мало данных) — его вес делят остальные: они «страхуют».
    // Пока ошибок мало, веса почти равные (L₀ одинаковое для всех); с каждым улетевшим вылетом лучший на рейсе весит больше.
    const EXPERTS = ['planPick', 'planOr', 'hist', 'ly', 'eb', 'pool', 'chain', 'lin', 'gbm', 'naive'];

    function expertsFor(h) {
        return h <= 3 ? EXPERTS : EXPERTS.filter(k => k !== 'naive');   // «ничего больше не продадут» — только у самого вылета
    }

    function committeeKey(h, r) {
        return groupOf(h).id + '|' + segOf(r);
    }

    function committeeAdd(st, base, h, r, s, f, vals) {
        const gk = committeeKey(h, r);
        const G = st.g[gk] || (st.g[gk] = {});
        const B = st.bg[base + '|' + gk] || (st.bg[base + '|' + gk] = {});
        Object.keys(vals).forEach(k => {
            const e = Math.abs(vals[k] - f) / s;
            (G[k] || (G[k] = [0, 0]));
            (B[k] || (B[k] = [0, 0]));
            G[k][0] += e; G[k][1]++;
            B[k][0] += e; B[k][1]++;
        });
    }

    // Веса способов для вылета: { k: w }, сумма 1.
    function committeeWeights(st, base, h, r, vals) {
        const ks = Object.keys(vals);
        if (!ks.length) return null;
        const gk = committeeKey(h, r);
        const G = (st && st.g[gk]) || {};
        const B = (st && st.bg[base + '|' + gk]) || {};
        const seen = ks.filter(k => G[k] && G[k][1] > 0);
        const L0 = seen.length ? seen.reduce((a, k) => a + G[k][0] / G[k][1], 0) / seen.length : 0.1;
        // Способ без единой проверенной ошибки в этой группе — с осторожной ошибкой (как у худшего из проверенных),
        // а не со средней: иначе непроверенные способы голосовали бы наравне с проверенными.
        const Lworst = seen.length ? Math.max(...seen.map(k => G[k][0] / G[k][1])) : 0.1;
        const L = {};
        ks.forEach(k => {
            const g = G[k] || [0, 0];
            const b = B[k] || [0, 0];
            const lg = g[1] > 0 ? (g[0] + PV.COMMITTEE_K * L0) / (g[1] + PV.COMMITTEE_K) : Lworst;
            L[k] = (b[0] + PV.COMMITTEE_K * lg) / (b[1] + PV.COMMITTEE_K);
        });
        const lmin = Math.max(1e-4, Math.min(...ks.map(k => L[k])));
        const w = {};
        let sum = 0;
        ks.forEach(k => {
            if (L[k] > PV.COMMITTEE_TRIM * lmin) return;
            w[k] = Math.exp(-PV.COMMITTEE_ETA * (L[k] / lmin - 1));
            sum += w[k];
        });
        Object.keys(w).forEach(k => { w[k] /= sum; });
        return w;
    }

    function committeeBlend(w, vals, o, s) {
        if (!w) return null;
        let v = 0;
        Object.keys(w).forEach(k => { v += w[k] * vals[k]; });
        return Math.max(0, Math.min(s, Math.round(v)));
    }

    // Интервал прогноза (сплит-конформный, несимметричный). Для способа k, выбранного на горизонте h для сегмента,
    // «банк» честных остатков в долях кресел rᵢ = (fᵢ − f̂ₖᵢ)/sᵢ — только из проверки на прошлых неделях.
    // Границы — порядковые статистики: q_lo = r₍⌊(n+1)·0,1⌋₎, q_hi = r₍⌈(n+1)·0,9⌉₎ — гарантия покрытия ≥ 80% и при малом n.
    // Банк берётся с первого уровня, где остатков ≥ 20: (h, сегмент) → h → (группа горизонтов, сегмент) → группа → все.
    // Номера порядковых статистик ⌊(n+1)·α⌋ и ⌈(n+1)·(1−α)⌉ — с поправкой на двоичную запись 0,1 и 0,9
    // (иначе при n = 29 получалось 2 вместо 3).
    function rankLo(n, a) { return Math.floor((n + 1) * a + 1e-9); }
    function rankHi(n, a) { return Math.ceil((n + 1) * (1 - a) - 1e-9); }

    // Загрузка по прогнозу: слабые, средние и почти полные рейсы ошибаются по-разному (у полных потолок — кресла),
    // поэтому интервал берётся из остатков рейсов той же загрузки, если их достаточно.
    const BAND_MULT = 4;   // по загрузке интервал берётся при остатков в 4 раза больше минимума: на малом числе он завышен
    function loadBand(v, s) {
        const l = s > 0 ? v / s : 0;
        return l < 0.55 ? 0 : (l < 0.85 ? 1 : 2);
    }

    async function conformal(test, choice, val, tick) {
        const alpha = (1 - PV.CONF_LEVEL) / 2;
        const out = {};
        const bank = (k, list) => list.map(x => { const v = val(k, x); return v == null ? null : (x.f - v) / x.s; }).filter(v => v != null);
        for (const h of HORIZONS) {
            const g = groupOf(h).id;
            if (tick) await tick();
            ['plan', 'hist', 'none'].forEach(sg => {
                const pick = choice[h + '|' + sg] || choice[h];
                if (!pick) return;
                const bandOf = (x) => { const v = val(pick.k, x); return v == null ? -1 : loadBand(v, x.s); };
                [0, 1, 2].forEach(lb => {
                    const r = bank(pick.k, test.filter(x => x.h === h && segOf(x.r) === sg && bandOf(x) === lb)).sort((a, b) => a - b);
                    const n = r.length;
                    if (n < PV.CONF_MIN * BAND_MULT) return;
                    const iLo = rankLo(n, alpha);
                    const iHi = rankHi(n, alpha);
                    if (iLo < 1 || iHi > n) return;
                    out[h + '|' + sg + '|' + lb] = { k: pick.k, lo: r[iLo - 1], hi: r[iHi - 1], n, level: 'h·сегмент·загрузка' };
                });
                const levels = [
                    ['h·сегмент', x => x.h === h && segOf(x.r) === sg],
                    ['h', x => x.h === h],
                    ['группа·сегмент', x => groupOf(x.h).id === g && segOf(x.r) === sg],
                    ['группа', x => groupOf(x.h).id === g],
                    ['все', () => true]
                ];
                for (const [level, fn] of levels) {
                    const r = bank(pick.k, test.filter(fn)).sort((a, b) => a - b);
                    const n = r.length;
                    if (n < PV.CONF_MIN) continue;
                    const iLo = rankLo(n, alpha);
                    const iHi = rankHi(n, alpha);
                    if (iLo < 1 || iHi > n) continue;
                    out[h + '|' + sg] = { k: pick.k, lo: r[iLo - 1], hi: r[iHi - 1], n, level };
                    break;
                }
            });
        }
        return out;
    }

    // Прогноз за h дней до вылета знает только вылеты, улетевшие до недели, в которой он сделан.
    // Все способы сравниваются на одних и тех же вылетах; выбор — отдельно для вылетов с файлом ожидаемой,
    // с историей дней недели и без того и другого. Выбор меняется, только если новый способ заметно лучше.
    async function evaluate() {
        // С историей за год — десятки тысяч записей: между этапами и внутри длинных циклов отдаём управление браузеру.
        let lastT = Date.now();
        const tick = async () => { if (Date.now() - lastT > 30) { await pause(); lastT = Date.now(); } };
        const all = samples();
        await tick();
        const cum = [0];
        all.forEach((x, i) => { cum.push(cum[i] + x.f * 7 + x.r.o * 3 + (x.r.y || 0) * 5 + (x.r.p || 0) * 11 + (x.r.x ? 1 : 0) + (x.r.pk || 0) * 29 + (x.r.pf || 0) * 31 + (x.r.gh || 0) * 37 + (x.sF || 0) * 43); });
        const weeks = [...new Set(all.map(x => weekOf(x.ts)))].sort((a, b) => a - b).slice(-PV.EVAL_WEEKS);
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
        let lastModel = null;
        let lastLen = 0;
        const poolAt = poolStream();
        for (const [cut, list] of [...byCut.entries()].sort((a, b) => a[0] - b[0])) {
            let len = 0;
            while (len < all.length && all[len].ts + DAY <= cut) len++;
            const pool = poolAt(all, len);
            list.forEach(x => pools.set(x, pool));
            if (len < PV.MIN_TRAIN) continue;
            // Новая модель — только когда данных прибавилось на 7%; иначе прежняя (она знает меньше — проверка остаётся честной).
            let m = lastModel;
            // Переобучение при +7% данных (раньше +15%): модель на проверке не отстаёт от недель на 1–2 месяца.
            if (!lastModel || len >= lastLen * 1.07) { m = await cachedTrain(all, len, cum); lastModel = m; lastLen = len; }
            if (m) list.forEach(x => pred.set(x, predictAll(m, x)));
            await pause();
        }
        // Цепочка добора — на момент недели прогноза.
        const cutOf = x => weekOf(x.ts - x.h * DAY);
        const chainPred = new Map();
        for (let i = 0; i < test.length; i++) {
            const x = test[i];
            const v = chainPredict(cutOf(x), x.base, x.ts, x.h, x.r.o, x.s);
            if (v != null) chainPred.set(x, v);
            if ((i & 511) === 0) await tick();
        }
        // «Прошлый год» считается один раз на запись (его спрашивают много раз за проверку).
        const lyMemo = new Map();
        const lyOf = (x) => {
            if (!lyMemo.has(x)) lyMemo.set(x, lyPredict(x.key.slice(x.key.lastIndexOf('|') + 1), x.base, x.ts, x.h, x.r.o, x.s));
            return lyMemo.get(x);
        };
        const base0 = (k, x) => (k === 'lin' || k === 'gbm' || k === 'ens' ? (pred.has(x) ? pred.get(x)[k] : null)
            : (k === 'chain' ? (chainPred.has(x) ? chainPred.get(x) : null)
                : (k === 'ly' ? lyOf(x) : simple(k, x.r, x.s, pools.get(x), x.h, x.base))));
        const expertVals = x => {
            const out = {};
            expertsFor(x.h).forEach(k => { const v = base0(k, x); if (v != null) out[k] = v; });
            if (!Object.keys(out).length) out.naive = x.r.o;   // последняя страховка — «продано на сейчас»
            return out;
        };
        // Комитет: веса — только по вылетам, улетевшим до недели прогноза (по возрастанию недель).
        const blendPred = new Map();
        const committee = { g: {}, bg: {} };
        let ptr = 0;
        for (const cut of [...byCut.keys()].sort((a, b) => a - b)) {
            while (ptr < test.length && test[ptr].ts + DAY <= cut) {
                const y = test[ptr++];
                committeeAdd(committee, y.base, y.h, y.r, y.s, y.f, expertVals(y));
                if ((ptr & 511) === 0) await tick();
            }
            await tick();
            byCut.get(cut).forEach(x => {
                const vals = expertVals(x);
                const v = committeeBlend(committeeWeights(committee, x.base, x.h, x.r, vals), vals, x.r.o, x.s);
                if (v != null) blendPred.set(x, v);
            });
        }
        while (ptr < test.length) {
            const y = test[ptr++];
            committeeAdd(committee, y.base, y.h, y.r, y.s, y.f, expertVals(y));
            if ((ptr & 511) === 0) await tick();
        }
        const kinds = ['naive', 'pool', 'eb', 'ly', 'plan', 'planOr', 'planPick', 'hist', 'chain', 'lin', 'gbm', 'ens', 'blend'];
        const val = (k, x) => (k === 'blend' ? (blendPred.has(x) ? blendPred.get(x) : null) : base0(k, x));
        const err = (k, x) => { const v = val(k, x); return v == null ? null : Math.abs(v - x.f); };
        const stat = (k, list) => {
            const c = { sum: 0, bias: 0, n: 0, f: 0 };
            list.forEach(x => { const v = val(k, x); if (v == null) return; c.sum += Math.abs(v - x.f); c.bias += v - x.f; c.f += x.f; c.n++; });
            return c;
        };
        // Таблица: по горизонту, на одних и тех же вылетах (где есть прогноз модели), иначе — на всех.
        const byH = {};
        HORIZONS.forEach(h => {
            const hl = test.filter(x => x.h === h);
            const common = hl.filter(x => pred.has(x));
            const base = common.length >= PV.MIN_CHOICE ? common : hl;
            byH[h] = { total: hl.length, common: common.length, simpleOnly: common.length < PV.MIN_CHOICE };
            kinds.forEach(k => { byH[h][k] = stat(k, base); });
        });
        await tick();
        // Выбор по горизонту и сегменту, с устойчивостью к шуму.
        // t-статистика «способ a точнее b» по парной разнице ошибок. Вылеты одного дня ошибаются вместе (погода,
        // праздник, сбой данных), поэтому разница сначала усредняется по дате вылета — блоки по датам, а не по рейсам.
        const pairT = (list, a, b) => {
            const byDate = new Map();
            list.forEach(x => {
                const ea = err(a, x); const eb = err(b, x);
                if (ea == null || eb == null) return;
                const g = byDate.get(x.date) || byDate.set(x.date, { s: 0, n: 0 }).get(x.date);
                g.s += ea - eb; g.n++;
            });
            const d = [...byDate.values()].map(g => g.s / g.n);
            if (d.length < 2) return 0;
            const mean = d.reduce((p, q) => p + q, 0) / d.length;
            const sd = Math.sqrt(d.reduce((p, q) => p + (q - mean) * (q - mean), 0) / (d.length - 1));
            return sd > 0 ? -mean / (sd / Math.sqrt(d.length)) : (mean < 0 ? Infinity : 0);
        };
        const prevStored = loadChoicePrev();
        const choice = {};
        const decide = (key, list, prev = prevStored) => {
            const withModel = list.filter(x => pred.has(x));
            const base = withModel.length >= PV.MIN_CHOICE_SEG ? withModel : list;
            const cands = (withModel.length >= PV.MIN_CHOICE_SEG ? ['ens', 'gbm', 'lin'] : []).concat(['blend', 'chain', 'eb', 'ly', 'planOr', 'planPick', 'hist', 'pool', 'naive']);
            const scored = cands.map(k => {
                const e = base.map(x => err(k, x)).filter(v => v != null);
                return { k, n: e.length, v: e.length ? e.reduce((a, b) => a + b, 0) / e.length : Infinity };
            }).filter(c => c.n >= PV.MIN_CHOICE_SEG && c.n >= base.length * 0.9);
            if (!scored.length) return null;
            scored.sort((a, b) => a.v - b.v);
            let best = scored[0];
            // Выбор по тем же неделям, на которых он проверяется, оптимистичен. Поэтому по умолчанию — комитет (он сам
            // взвешивает способы по прошлым ошибкам), а отдельный способ — только если он надёжно точнее комитета.
            const blendC = scored.find(c => c.k === 'blend');
            if (blendC && best.k !== 'blend' && !(pairT(base, best.k, 'blend') > 2)) best = blendC;
            const old = scored.find(c => c.k === prev[key]);
            // Меняем прежний способ, только если новый надёжно лучше.
            if (old && old.k !== best.k && !(pairT(base, best.k, old.k) > PV.SWITCH_T)) best = old;
            return { k: best.k, v: best.v, n: best.n };
        };
        for (const h of HORIZONS) {
            await tick();
            const hl = test.filter(x => x.h === h);
            choice[h] = decide(String(h), hl);
            ['plan', 'hist', 'none'].forEach(sg => {
                const sl = hl.filter(x => segOf(x.r) === sg);
                if (sl.length >= PV.MIN_CHOICE_SEG) choice[h + '|' + sg] = decide(h + '|' + sg, sl);
            });
        }
        saveChoice(choice);
        // Честная оценка выбора (вне выборки): способ выбирается по первым неделям проверки, ошибка — на последних 4,
        // где выбор их «не видел». В таблице «Что берём» выбор и оценка на одних неделях — это оптимистичнее.
        const lateFrom = weeks.length > 6 ? weeks[weeks.length - 4] : Infinity;
        const early = test.filter(x => weekOf(x.ts) < lateFrom);
        const late = test.filter(x => weekOf(x.ts) >= lateFrom);
        const choiceE = {};
        if (late.length) {
            for (const h of HORIZONS) {
                const hl = early.filter(x => x.h === h);
                if (hl.length >= PV.MIN_CHOICE_SEG) choiceE[h] = decide(String(h), hl, {});
                ['plan', 'hist', 'none'].forEach(sg => {
                    const sl = hl.filter(x => segOf(x.r) === sg);
                    if (sl.length >= PV.MIN_CHOICE_SEG) choiceE[h + '|' + sg] = decide(h + '|' + sg, sl, {});
                });
                await tick();
            }
        }
        // «Что берём» — выбранный способ по сегменту на тех же вылетах, что и остальные столбцы.
        const chosenVal = (x) => {
            const pick = choice[x.h + '|' + segOf(x.r)] || choice[x.h];
            if (!pick) return null;
            const v = val(pick.k, x);
            if (v != null) return v;
            const b = val('blend', x);   // у выбранного способа нет прогноза — комитет (у него он есть всегда)
            return b != null ? b : x.r.o;
        };
        HORIZONS.forEach(h => {
            const hl = test.filter(x => x.h === h);
            const common = hl.filter(x => pred.has(x));
            const base = common.length >= PV.MIN_CHOICE ? common : hl;
            const c = { sum: 0, bias: 0, n: 0, f: 0 };
            base.forEach(x => { const v = chosenVal(x); if (v == null) return; c.sum += Math.abs(v - x.f); c.bias += v - x.f; c.f += x.f; c.n++; });
            byH[h].best = c;
            // Отдельно — живые вылеты (не из архива): в архиве без файла по билетам «продано на день h» уже без будущих
            // возвратов, и проверка на нём оптимистична. Живые — то, как модель работает на самом деле.
            const C0 = context();
            const lv = { sum: 0, n: 0 };
            base.forEach(x => { const dep = C0.byKey[x.key]; if (dep && dep.arch) return; const v = chosenVal(x); if (v == null) return; lv.sum += Math.abs(v - x.f); lv.n++; });
            byH[h].live = lv;
            // Честно: выбор по ранним неделям, ошибка на поздних.
            // Для сравнения на тех же поздних неделях: ошибка выбора «по всем неделям» (inS) и комитета (blend).
            const hon = { sum: 0, n: 0, inS: 0, blend: 0, nb: 0 };
            late.filter(x => x.h === h).forEach(x => {
                const vi = chosenVal(x);
                const vb = val('blend', x);
                if (vi != null && vb != null) { hon.inS += Math.abs(vi - x.f); hon.blend += Math.abs(vb - x.f); hon.nb++; }
                const pk = choiceE[x.h + '|' + segOf(x.r)] || choiceE[x.h];
                let v = pk ? val(pk.k, x) : null;
                if (v == null) v = val('blend', x);
                if (v == null) return;
                hon.sum += Math.abs(v - x.f); hon.n++;
            });
            byH[h].honest = hon;
        });
        await tick();
        // Калибровка по уровню прогнозной загрузки: средний остаток (факт − прогноз)/кресла в корзине
        // «группа горизонтов × загрузка по прогнозу», сжатый к нулю: c = n/(n+30)·mean. Сильные рейсы модель занижает,
        // слабые — завышает (сжатие к среднему); поправка это снимает. Берётся, только если на поздних неделях,
        // не участвовавших в подгонке, ошибка с ней меньше.
        const lfBucket = (v, s) => { const l = v / s; return l < 0.5 ? 0 : (l < 0.7 ? 1 : (l < 0.85 ? 2 : (l < 0.95 ? 3 : 4))); };
        const fitCalib = (rows) => {
            const acc = {};
            rows.forEach(x => {
                const v = chosenVal(x);
                if (v == null) return;
                const k = groupOf(x.h).id + '|' + lfBucket(v, x.s);
                const a = acc[k] || (acc[k] = { s: 0, n: 0 });
                a.s += (x.f - v) / x.s; a.n++;
            });
            const out = {};
            Object.keys(acc).forEach(k => { out[k] = (acc[k].s / acc[k].n) * (acc[k].n / (acc[k].n + PV.CALIB_K)); });
            return out;
        };
        const applyCalib = (cal, x, v) => {
            const c = cal[groupOf(x.h).id + '|' + lfBucket(v, x.s)] || 0;
            return Math.max(0, Math.min(x.s, Math.round(v + c * x.s)));
        };
        let calib = null;
        const calibCheck = { before: 0, after: 0, n: 0 };
        if (late.length >= 100 && early.length >= 200) {
            const calE = fitCalib(early);
            late.forEach(x => {
                const v = chosenVal(x);
                if (v == null) return;
                calibCheck.before += Math.abs(v - x.f);
                calibCheck.after += Math.abs(applyCalib(calE, x, v) - x.f);
                calibCheck.n++;
            });
            if (calibCheck.n && calibCheck.after < calibCheck.before * 0.995) calib = fitCalib(test);
        }
        await tick();
        const conf = await conformal(test, choice, val, tick);
        // Честное покрытие интервала: для вылета — банк остатков только по вылетам, улетевшим до недели прогноза
        // (уровень «группа горизонтов × сегмент × способ», n ≥ 20). Считается, сколько фактов попало внутрь.
        const alpha = (1 - PV.CONF_LEVEL) / 2;
        const banks = new Map();
        const sortedBank = new Map();   // банк сортируется заново, только когда в него что-то добавили
        const sortedOf = (bk) => {
            const b = banks.get(bk);
            if (!b) return null;
            const c = sortedBank.get(bk);
            if (c && c.len === b.length) return c.arr;
            const arr = Float64Array.from(b).sort();
            sortedBank.set(bk, { len: b.length, arr });
            return arr;
        };
        const bankKeys = (x, k, v) => {
            const sg = segOf(x.r);
            const g = groupOf(x.h).id;
            return [`l|${x.h}|${sg}|${loadBand(v, x.s)}|${k}`, `a|${x.h}|${sg}|${k}`, `b|${x.h}|${k}`, `c|${g}|${sg}|${k}`, `d|${g}|${k}`, `e|${k}`];
        };
        const cover = {};
        HORIZONS.forEach(h => { cover[h] = { in: 0, n: 0, width: 0 }; });
        let cp = 0;
        for (const cut of [...byCut.keys()].sort((a, b) => a - b)) {
            await tick();
            while (cp < test.length && test[cp].ts + DAY <= cut) {
                const y = test[cp++];
                const pk = choice[y.h + '|' + segOf(y.r)] || choice[y.h];
                const v = pk ? val(pk.k, y) : null;
                if (v == null) continue;
                bankKeys(y, pk.k, v).forEach(bk => (banks.get(bk) || banks.set(bk, []).get(bk)).push((y.f - v) / y.s));
            }
            byCut.get(cut).forEach(x => {
                const pk = choice[x.h + '|' + segOf(x.r)] || choice[x.h];
                const v = pk ? val(pk.k, x) : null;
                // Тот же порядок уровней, что у живого интервала (conformal): h·сегмент → h → группа·сегмент → группа → все.
                let r = null;
                if (pk && v != null) {
                    for (const bk of bankKeys(x, pk.k, v)) {
                        const a = sortedOf(bk);
                        if (a && a.length >= PV.CONF_MIN * (bk.charAt(0) === 'l' ? BAND_MULT : 1) && rankLo(a.length, alpha) >= 1 && rankHi(a.length, alpha) <= a.length) { r = a; break; }
                    }
                }
                if (!r) return;
                const n = r.length;
                const lo = Math.min(v, Math.max(0, Math.round(v + r[Math.max(0, rankLo(n, alpha) - 1)] * x.s)));
                const hi = Math.min(Math.max(x.s, x.r.o), Math.round(v + r[Math.min(n - 1, rankHi(n, alpha) - 1)] * x.s));
                const C = cover[x.h];
                C.n++;
                C.width += hi - lo;
                if (x.f >= lo && x.f <= hi) C.in++;
            });
        }
        // Точность за 7 дней по группам: ёмкость ВС (46 — с 42 и 48; 72; 120), линии с конкурентом, тип рейса.
        const capClass = (sx) => (sx <= 50 ? '46' : (sx <= 80 ? '72' : '120'));
        const groupsAt = (h) => {
            const hl = test.filter(x => x.h === h);
            const defs = [
                ['Все вылеты', () => true],
                ['ВС на 42–48 кресел', x => capClass(x.s) === '46'],
                ['ВС на 72 кресла', x => capClass(x.s) === '72'],
                ['ВС на 120 кресел', x => capClass(x.s) === '120'],
                ['Линии с конкурентом', x => competitorOf(x.base, x.ts) != null],
                ['Линии без конкурента', x => competitorOf(x.base, x.ts) == null],
                ['С файлом ожидаемой', x => segOf(x.r) === 'plan'],
                ['Без файла ожидаемой', x => segOf(x.r) !== 'plan'],
                // Где ошибка дороже всего: сильные рейсы (почти полные — решения о цене и перегрузе) и вылеты с группами.
                ['Сильные рейсы (итог ≥ 90% кресел)', x => x.f / x.s >= 0.9],
                ['Слабые рейсы (итог < 60%)', x => x.f / x.s < 0.6],
                ['С группой после этого дня', x => x.grpAfter >= PV.GROUP_MIN],
                ['Без групп', x => !(x.grpAfter >= PV.GROUP_MIN)]
            ];
            const one = (list, fn) => {
                const c = { sum: 0, bias: 0, n: 0, f: 0 };
                list.forEach(x => { const v = fn(x); if (v == null) return; c.sum += Math.abs(v - x.f); c.bias += v - x.f; c.f += x.f; c.n++; });
                return c;
            };
            // Сравнение на одних и тех же вылетах: где есть прогноз и цепочки, и добора рейса (файл — только где он есть).
            const fair = hl.filter(x => val('chain', x) != null && val('eb', x) != null);
            return defs.map(([label, fn]) => {
                const list = fair.filter(fn);
                return { label, n: list.length, best: one(list, chosenVal), naive: one(list, x => x.r.o), chain: one(list, x => val('chain', x)), eb: one(list, x => val('eb', x)), planPick: one(list, x => val('planPick', x)) };
            }).filter(g => g.n > 0).concat(fair.length < hl.length ? [{ label: '', n: 0, note: hl.length - fair.length }] : []);
        };
        await tick();
        const groups = { 7: groupsAt(7), 3: groupsAt(3) };
        // Ошибка в рублях: |ошибка, пасс.| × средний взрослый тариф рейса — ошибка на дорогом рейсе дороже.
        const fareOf = routeFares();
        const rubErr = {};
        [14, 7, 3].forEach(h => {
            let s = 0;
            let n = 0;
            test.filter(x => x.h === h).forEach(x => {
                const v = chosenVal(x);
                const fr = fareOf[x.base];
                if (v == null || !fr) return;
                s += Math.abs(v - x.f) * fr; n++;
            });
            rubErr[h] = n ? { avg: s / n, n } : null;
        });
        await tick();
        // Проверка сигналов на улетевших: точность (сбылось из поданных) и полнота (поймано из случившихся).
        const wc = warnSettings();
        const signals = [14, 7, 3].map(h => {
            const z = { h, under: { tp: 0, fp: 0, fn: 0 }, over: { tp: 0, fp: 0, fn: 0 } };
            test.filter(x => x.h === h).forEach(x => {
                const v = chosenVal(x);
                if (v == null) return;
                [['under', v / x.s * 100 < wc.under, x.f / x.s * 100 < wc.under], ['over', v / x.s * 100 >= wc.over, x.f / x.s * 100 >= wc.over]].forEach(([k, said, was]) => {
                    if (said && was) z[k].tp++; else if (said) z[k].fp++; else if (was) z[k].fn++;
                });
            });
            return z;
        });
        await tick();
        const anyModel = HORIZONS.some(h => !byH[h].simpleOnly);
        const byWeek = new Map();
        const byBase = new Map();
        test.filter(x => x.h === 7).forEach(x => {
            const w = weekOf(x.ts);
            const W = byWeek.get(w) || { plan: [0, 0], best: [0, 0], ts: w };
            const pl = simple('plan', x.r, x.s);
            const pick = choice[7 + '|' + segOf(x.r)] || choice[7];
            const md = pick ? (val(pick.k, x) != null ? val(pick.k, x) : x.r.o) : null;
            // Файл и «что берём» — на одних и тех же вылетах (где файл есть), иначе сравнение нечестное.
            if (pl != null && md != null) { W.plan[0] += Math.abs(pl - x.f); W.plan[1]++; W.best[0] += Math.abs(md - x.f); W.best[1]++; }
            byWeek.set(w, W);
            // Файл и «что берём» — на одних вылетах (где есть файл); у рейса без файла — «что берём» по всем.
            const R = byBase.get(x.base) || { plan: [0, 0], model: [0, 0], modelAll: [0, 0] };
            if (pl != null && md != null) { R.plan[0] += Math.abs(pl - x.f); R.plan[1]++; R.model[0] += Math.abs(md - x.f); R.model[1]++; }
            if (md != null) { R.modelAll[0] += Math.abs(md - x.f); R.modelAll[1]++; }
            byBase.set(x.base, R);
        });
        // Где модель ошибается: по рейсам, за 3, 7 и 14 дней до вылета («что берём»). Ошибка, её доля от перевезённых и смещение
        // (↑ завышает, ↓ занижает) — по ним видно рейсы, на которых модели не хватает данных или признаков.
        const rAcc = new Map();
        test.forEach(x => {
            if (x.h !== 3 && x.h !== 7 && x.h !== 14) return;
            const v = chosenVal(x);
            if (v == null) return;
            const a = rAcc.get(x.base) || { n: 0, abs: 0, bias: 0, f: 0 };
            a.n++; a.abs += Math.abs(v - x.f); a.bias += v - x.f; a.f += x.f;
            rAcc.set(x.base, a);
        });
        const routeErr = [...rAcc.entries()].filter(([, a]) => a.n >= 15)
            .map(([b, a]) => ({ b, n: a.n, mae: a.abs / a.n, wape: a.f ? a.abs / a.f : null, bias: a.bias / a.n }))
            .sort((p, q) => q.mae - p.mae).slice(0, 15);
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
        // Как модель учится: сколько вылетов за последнюю неделю данных добавилось в обучение.
        const lastTs = all.length ? all[all.length - 1].ts : 0;
        const fresh = new Set(all.filter(x => x.ts > lastTs - 7 * DAY).map(x => x.key)).size;
        return { at: Date.now(), fresh, calib, calibCheck, rubErr, full, pool: poolOf(all), committee, cover, groups, signals, byH, byWeek, byBase, routeErr, glitches: glitchLive.slice(), choice, conf, influence, segCount, samples: all.length, departures: new Set(all.map(x => x.key)).size, trained: !!full, anyModel };
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
        evalState.busy = true;
        evaluate().then(ev => {
            evalState.busy = false;
            if (trainSig() !== sig) { startEvaluation(); return; }
            evalState.ev = ev;
            evalState.sig = sig;
            models = ev.full || null;
            modelRev++;
            publishSoon();
            refreshViews();
            flush();
        }).catch(e => {
            console.warn('ForecastLab.evaluate', e);
            evalState.busy = false;
            flush();
        });
    }

    // ---------- один прогноз для всех ----------
    // Модель обучается у тех, кому виден отчёт о прогнозе. Чтобы у всех сотрудников в карточке, RMS и «Сегодня» было
    // одно и то же число, обученный прогноз по всем вылетам на 30 дней записывается в shared/forecast-now.json
    // (тем, кто публикует данные), а остальные берут его оттуда — если он посчитан по тем же данным продаж.
    const NOW_FILE = 'forecast-now.json';
    let published = { token: '', flights: null, choice: null, at: '' };

    let publishedText = '';
    let publishTimer = 0;

    function salesToken() {
        return typeof lastSalesUpdate !== 'undefined' && lastSalesUpdate ? String(new Date(lastSalesUpdate).getTime()) : '';
    }

    function publishSoon() {
        if (!canWrite() || typeof SharedStorage === 'undefined') return;
        clearTimeout(publishTimer);
        publishTimer = setTimeout(() => { publishNow().catch(e => console.warn('ForecastLab.publish', e)); }, 2000);
    }

    async function publishNow() {
        const token = salesToken();
        if (!token || !evalState.ev || !canWrite()) return false;
        const C = context();
        const flights = {};
        let lastYield = Date.now();
        for (const base of Object.keys(C.byBase)) {
            for (const dep of C.byBase[base]) {
                if (dep.arch || dep.flown) continue;
                const p = predict(dep.rowCode, dep.date);
                if (p) flights[dep.date + '|' + dep.rowCode] = [p.final, p.lo, p.hi, p.seats, p.method, p.err, p.h];
                if (Date.now() - lastYield > 25) { await pause(); lastYield = Date.now(); }
            }
        }
        const body = JSON.stringify(flights);
        if (body === publishedText) return true;
        const choice = loadChoiceLocal();
        const ok = await SharedStorage.writeJsonFile(NOW_FILE, { version: 1, token, at: new Date().toISOString(), choice, flights });
        if (ok) { publishedText = body; published = { token, flights, choice, at: new Date().toISOString() }; }
        return ok;
    }

    async function readPublished() {
        if (typeof SharedStorage === 'undefined') return;
        const r = await SharedStorage.readJsonFileStrict(NOW_FILE).catch(() => ({ ok: false }));
        const d = r.ok && r.data;
        if (!d || !d.flights || typeof d.flights !== 'object') return;
        published = { token: String(d.token || ''), flights: d.flights, choice: d.choice && typeof d.choice === 'object' ? d.choice : null, at: d.at || '' };
        modelRev++;
        refreshViews();
    }

    // Прогноз из общего файла — только если он посчитан по тем же данным продаж, что открыты сейчас.
    function publishedFor(code, date) {
        if (!published.flights || !published.token || published.token !== salesToken()) return null;
        const e = published.flights[date + '|' + cleanFlight(code)];
        if (!Array.isArray(e)) return null;
        const nn = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v) : null);   // общий файл — только числа
        const final = nn(e[0]);
        const seats = nn(e[3]);
        if (final == null || final < 0 || !(seats > 0)) return null;
        const lo = nn(e[1]);
        const hi = nn(e[2]);
        const [, , , , method, err, h] = e;
        return { final, lo, hi, seats, method: String(method || 'модель'), err: Number(err) || 0, h: Number(h) || null, team: [], lf: Math.round(final / seats * 100), shared: true };
    }

    // Один прогноз: своя обученная модель, иначе общий файл. null — модели нет (тогда прогноз по прошлым вылетам).
    function forecastFor(code, date) {
        if (canView()) {
            const p = predict(code, date);
            if (p) return p;
        }
        return publishedFor(code, date);
    }

    // Модель обучилась или пришёл общий прогноз — перерисовать открытые карточку, RMS и «Сегодня».
    let refreshTimer = 0;
    function refreshViews() {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
            if (typeof FlightCard !== 'undefined' && FlightCard.isOpen && FlightCard.isOpen() && FlightCard.refresh) FlightCard.refresh();
            const tab = typeof currentTab !== 'undefined' ? currentTab : '';
            if ((tab === 'rms' || tab === 'today') && typeof refreshTabPanel === 'function') refreshTabPanel(tab);
        }, 300);
    }

    // ---------- ранние предупреждения ----------
    // Для всех будущих вылетов в горизонте N дней: прогноз (P50) и интервал 80% (P10–P90) выбранным способом.
    //   недобор:  P50/s < порога (60%);   перегруз / упущенная выручка:  P50/s ≥ 95% или (P90 без ограничения > s и P50/s ≥ 90%);
    //   аномальный темп:  z = (o/s − m)/max(σ, 0,05),  |z| ≥ 2 и |o − m·s| ≥ 3 пасс., где m, σ — доля проданных к этому дню
    //   у вылетов того же рейса в тот же день недели за 8 недель (день уже наступил к моменту среза).
    //   Срочность: тяжесть / √(дней до вылета) — чем ближе вылет и сильнее отклонение, тем выше в списке.
    // Свои пороги читаются из браузера один раз (predict вызывается по каждому вылету); сброс — при «Применить» и смене параметров.
    let warnCache = null;
    let warnCacheRev = -1;
    function warnSettings() {
        const pr = typeof Params !== 'undefined' ? Params.revision() : 0;
        if (!warnCache || warnCacheRev !== pr) {
            warnCacheRev = pr;
            try { warnCache = Object.assign({}, WARN_DEFAULT, JSON.parse(localStorage.getItem(WARN_KEY) || '{}') || {}); } catch (e) { warnCache = Object.assign({}, WARN_DEFAULT); }
        }
        return Object.assign({}, warnCache);
    }

    function paceNorm(dep, d, T) {
        const dow = new Date(dep.ts).getDay();
        const vals = [];
        datesOf(dep.base).forEach(D => {
            if (D.date === dep.date || !(D.s > 0) || new Date(D.ts).getDay() !== dow) return;
            if (D.ts - d * DAY > T || dep.ts - D.ts > 56 * DAY || D.ts > dep.ts + 56 * DAY) return;
            vals.push(D.deps.reduce((a, X) => a + rawAt(X, d, T), 0) / D.s);
        });
        if (vals.length < PV.PACE_MIN_DEPS) return null;   // по 3–5 вылетам разброс случайный — «необычный темп» был бы у каждого пятого
        const m = vals.reduce((a, b) => a + b, 0) / vals.length;
        const ss = vals.reduce((a, b) => a + (b - m) * (b - m), 0);
        // Разброс по 6–8 вылетам сам шумный: сжимаем его к общему разбросу всех рейсов на этот день до вылета
        // (s² = (Σ(x − m)² + K·σ²_общ)/(n − 1 + K), K = 6) — иначе случайно «ровный» рейс даёт ложную тревогу.
        const g = paceGlobalVar(d, T);
        const K = 6;
        const sd = Math.sqrt(g != null ? (ss + K * g) / (vals.length - 1 + K) : ss / (vals.length - 1));
        return { m, sd, n: vals.length };
    }

    // Общий разброс «продано к дню d» (доля кресел) внутри рейса и дня недели — по всем рейсам, за те же 8 недель.
    function paceGlobalVar(d, T) {
        const C = context();
        const memo = C.paceG || (C.paceG = new Map());
        const key = d + '|' + T;
        if (memo.has(key)) return memo.get(key);
        let ss = 0;
        let df = 0;
        Object.keys(C.byBase || {}).forEach(base => {
            const groups = {};
            datesOf(base).forEach(D => {
                if (!(D.s > 0) || D.ts - d * DAY > T || T - D.ts > 56 * DAY) return;
                const k = new Date(D.ts).getDay();
                (groups[k] || (groups[k] = [])).push(D.deps.reduce((a, X) => a + rawAt(X, d, T), 0) / D.s);
            });
            Object.values(groups).forEach(v => {
                if (v.length < 3) return;
                const m = v.reduce((a, b) => a + b, 0) / v.length;
                ss += v.reduce((a, b) => a + (b - m) * (b - m), 0);
                df += v.length - 1;
            });
        });
        const out = df >= 20 ? ss / df : null;
        memo.set(key, out);
        return out;
    }

    const CAPS = [46, 72, 120];

    let warnMemo = { sig: '', list: null };
    let warnKind = '';   // фильтр списка по плитке: under / over / pace
    let warnBusy = null;

    function warnSig() {
        const cfg = warnSettings();
        return [evalState.sig, typeof dataEpoch === 'number' ? dataEpoch : 0, today(), cfg.under, cfg.over, cfg.days].join('|');
    }

    // Готовый список (или null, если ещё не посчитан под текущие данные и пороги).
    function warnings() {
        if (!evalState.ev || !loaded || !canView()) return null;
        return warnMemo.sig === warnSig() ? warnMemo.list : null;
    }

    // Посчитать в фоне: сотни вылетов, управление отдаётся браузеру каждые ~25 мс.
    function warningsAsync() {
        if (!evalState.ev || !loaded || !canView()) return Promise.resolve(null);
        const sig = warnSig();
        if (warnMemo.sig === sig) return Promise.resolve(warnMemo.list);
        if (warnBusy && warnBusy.sig === sig) return warnBusy.p;
        const p = computeWarnings(sig).finally(() => { if (warnBusy && warnBusy.sig === sig) warnBusy = null; });
        warnBusy = { sig, p };
        return p;
    }

    async function computeWarnings(sig) {
        const cfg = warnSettings();
        const C = context();
        const now = todayTs();
        const out = [];
        let lastYield = Date.now();
        const deps = [];
        Object.keys(C.byBase).forEach(base => C.byBase[base].forEach(dep => deps.push([base, dep])));
        for (const [base, dep] of deps) {
            if (Date.now() - lastYield > 25) { await pause(); lastYield = Date.now(); }
            const dtd = Math.round((dep.ts - now) / DAY);
            if (dtd < 1 || dtd > cfg.days || !(dep.s > 0) || dep.arch) continue;
            const p = predict(dep.rowCode, dep.date);
            if (!p) continue;
            const s = p.seats;
            const lf = p.final / s;
            const T = dep.ts - p.d * DAY;
            const pace = paceNorm(dep, p.d, T);
            // «Обычно к этому дню» — то же число, что в карточке рейса (норма по тем же дням недели); разброс — по вылетам рейса.
            if (pace && typeof buildFlightDtdBookingSeries === 'function') {
                try {
                    const ser = buildFlightDtdBookingSeries(base, dep.date, dep.rowCode, 1, dep.row[4]);
                    const nv = ser && !ser.refIsLy && ser.refData && ser.refData.length ? ser.refData[ser.refData.length - 1] : null;
                    if (nv != null && !isNaN(nv)) pace.m = nv / s;
                } catch (e) { /* норма карточки не посчиталась — своя */ }
            }
            const z = pace ? (p.sold / s - pace.m) / Math.max(pace.sd, 0.05) : 0;
            const paceGap = pace ? Math.round(p.sold - pace.m * s) : 0;
            const flags = [];
            if (lf * 100 < cfg.under) flags.push({ kind: 'under', sev: (cfg.under / 100 - lf) * 10 });
            if (lf * 100 >= cfg.over || (p.hiRaw != null && p.hiRaw > s && lf * 100 >= cfg.over - 5)) flags.push({ kind: 'over', sev: Math.max(lf - cfg.over / 100, 0) * 10 + (p.hiRaw != null && p.hiRaw > s ? (p.hiRaw - s) / s * 5 : 0) + 0.2 });
            if (pace && Math.abs(z) >= PV.PACE_Z && Math.abs(paceGap) >= PV.PACE_GAP) flags.push({ kind: z > 0 ? 'fast' : 'slow', sev: Math.min(Math.abs(z), 6) / 4 });
            if (!flags.length) continue;
            // Причины — что сильнее всего тянет прогноз.
            const why = [];
            if (pace) why.push(`продано ${p.sold}, обычно к этому дню ${Math.round(pace.m * s)} (${paceGap >= 0 ? '+' : '−'}${Math.abs(paceGap)})`);
            if (p.plan != null) why.push(`файл ожидаемой: ${Math.round(p.plan)}`);
            if (p.team && p.team[0] && p.team[0].w >= 35) why.push(`на этом рейсе точнее всего: ${p.team[0].label} (${p.team[0].w}%)`);
            const comp = competitorOf(base, dep.ts);
            if (comp) why.push(`на линии ${comp}`);
            const ev2 = typeof CalendarEvents !== 'undefined' && CalendarEvents.on ? CalendarEvents.on(dep.date).map(e => e.name || e.type).filter(Boolean) : [];
            if (ev2.length) why.push(`календарь: ${ev2.slice(0, 2).join(', ')}`);
            if (!why.length) why.push(`прогноз: ${p.method}, обычно ошибается на ±${String(p.err).replace('.', ',')} пасс.`);
            // Что сделать.
            const act = [];
            const hiTop = p.hi != null ? p.hi : p.final;
            const cap = getCapacityFromAircraft(getAircraftType(dep.row[4])) || s;   // ёмкость ВС (в продаже может быть меньше)
            flags.forEach(g => {
                if (g.kind === 'under') {
                    act.push('снизить цену / открыть дешёвые классы');
                    const smaller = CAPS.filter(c => c < cap - 4 && c >= hiTop)[0];   // наименьший подходящий тип ВС
                    if (smaller && dtd >= 5) act.push(`ВС на ${smaller} кресел вместит даже верхнюю оценку (${hiTop})`);
                }
                if (g.kind === 'over' && p.sold >= s) {
                    // Уже распродан: «поднять цену» бессмысленно.
                    act.push(cap > s + 1 ? `распродан — открыть закрытые кресла (в продаже ${s} из ${cap}), если позволяет взлётная масса` : 'распродан — проверить овербукинг и замену на ВС больше');
                    return;
                }
                if (g.kind === 'over') {
                    act.push('поднять цену / закрыть дешёвые классы');
                    if (p.hiRaw != null && p.hiRaw > s) {
                        if (cap > s + 1) act.push(`в продаже ${s} из ${cap} кресел — если нет ограничений по взлётной массе, открыть ещё (без учёта кресел прогноз доходит до ~${p.hiRaw})`);
                        else {
                            const bigger = CAPS.find(c => c > cap + 4);
                            if (bigger) act.push(`без учёта кресел прогноз доходит до ~${p.hiRaw} — рассмотреть ВС на ${bigger}`);
                        }
                    }
                }
                if (g.kind === 'fast') act.push('продажи быстрее обычного — проверить, не занижена ли цена');
                if (g.kind === 'slow') act.push('продажи медленнее обычного — проверить цену и продвижение');
            });
            const sev = flags.reduce((a, g) => a + g.sev, 0);
            out.push({ base, code: dep.rowCode, date: dep.date, dtd, dir: typeof getFlightDirection === 'function' ? getFlightDirection(base) : '', s, sold: p.sold, final: p.final, lo: p.lo, hi: p.hi, hiRaw: p.hiRaw, lf: Math.round(lf * 100), method: p.method, kinds: flags.map(g => g.kind), why, act: [...new Set(act)], urgency: sev / Math.sqrt(dtd) });
        }
        out.sort((a, b) => b.urgency - a.urgency);
        if (sig === warnSig()) warnMemo = { sig, list: out };
        return out;
    }

    // ---------- что изменилось за неделю ----------
    // Прогноз моделей сейчас против записи журнала примерно недельной давности (ближайший контрольный день 7 дней назад).
    let chgMemo = { sig: '', list: null };
    let chgBusy = null;

    function weekChanges() {
        return chgMemo.sig === warnSig() ? chgMemo.list : null;
    }

    function weekChangesAsync() {
        if (!evalState.ev || !loaded || !canView()) return Promise.resolve(null);
        const sig = warnSig();
        if (chgMemo.sig === sig) return Promise.resolve(chgMemo.list);
        if (chgBusy && chgBusy.sig === sig) return chgBusy.p;
        const p = computeChanges(sig).finally(() => { if (chgBusy && chgBusy.sig === sig) chgBusy = null; });
        chgBusy = { sig, p };
        return p;
    }

    async function computeChanges(sig) {
        const C = context();
        const now = todayTs();
        const out = [];
        let lastYield = Date.now();
        const deps = [];
        Object.keys(C.byBase).forEach(base => C.byBase[base].forEach(dep => deps.push([base, dep])));
        for (const [base, dep] of deps) {
            if (Date.now() - lastYield > 25) { await pause(); lastYield = Date.now(); }
            const dtd = Math.round((dep.ts - now) / DAY);
            if (dtd < 1 || dtd > 21 || !(dep.s > 0) || dep.arch) continue;
            const e = log[dep.date + '|' + dep.code] || log[dep.date + '|' + base];
            if (!e || !e.h) continue;
            const p = predict(dep.rowCode, dep.date);
            if (!p || p.mlNow == null || p.closed) continue;
            // Запись примерно неделю назад: контрольный день не меньше чем на 3 дня дальше нынешнего, ближайший к «сейчас + 7».
            let best = null;
            HORIZONS.forEach(h => {
                const r = e.h[h];
                if (!r || r.m == null || h < p.d + 3) return;
                if (!best || Math.abs(h - (p.d + 7)) < Math.abs(best.h - (p.d + 7))) best = { h, r };
            });
            if (!best) continue;
            const delta = p.mlNow - best.r.m;
            if (Math.abs(delta) < Math.max(4, Math.round(p.seats * 0.08))) continue;
            const days = best.h - p.d;
            const dSold = p.sold - best.r.o;
            const norm = typeof SalesAdvice !== 'undefined' ? SalesAdvice.norms(dep.rowCode, dep.date) : null;
            const dPlan = norm && norm.exp != null && best.r.q != null ? norm.exp - best.r.q : null;
            const why = [`продано ${best.r.o} → ${p.sold} (${dSold >= 0 ? '+' : '−'}${Math.abs(dSold)} за ${days} дн.)`];
            if (dPlan != null) {
                why.push(`по плану за это время ${dPlan >= 0 ? '+' : '−'}${Math.abs(dPlan)}`);
                if (dSold - dPlan >= 3) why.push('продажи идут быстрее плана');
                else if (dPlan - dSold >= 3) why.push('продажи идут медленнее плана');
            }
            out.push({ code: dep.rowCode, date: dep.date, dtd, dir: typeof getFlightDirection === 'function' ? getFlightDirection(base) : '', s: p.seats, old: Math.round(best.r.m), now: Math.round(p.mlNow), delta: Math.round(delta), days, why });
        }
        out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
        chgMemo = { sig, list: out };
        return out;
    }

    function changesHtml(rerender) {
        if (!evalState.ev) return '';
        const list = weekChanges();
        if (!list) {
            weekChangesAsync().then(() => { if (rerender) rerender(); }).catch(e => console.warn(e));
            return '';
        }
        if (!list.length) return `<section class="rp-card"><div class="rp-card-head"><h3 class="rp-card-title">Что изменилось за неделю</h3></div>
            <p class="rp-note">Прогноз моделей по вылетам на 3 недели вперёд почти не изменился (порог — 8% кресел, не меньше 4 пасс.).</p></section>`;
        const rows = list.slice(0, 30).map(c => `<tr>
            <td class="rp-left"><strong>${esc(c.code)}</strong> <span class="rp-muted">${esc(c.dir)}</span></td>
            <td>${esc(c.date)}<div class="rp-muted">через ${c.dtd} дн.</div></td>
            <td>${c.old} → <strong>${c.now}</strong> <span class="rp-muted">из ${c.s}</span></td>
            <td class="${c.delta > 0 ? 'fl-best' : 'fl-warn-slow'}"><strong>${c.delta > 0 ? '▲ +' : '▼ −'}${Math.abs(c.delta)}</strong></td>
            <td class="rp-left fl-warn-why">${c.why.map(esc).join('; ')}</td></tr>`).join('');
        return `<section class="rp-card"><div class="rp-card-head"><h3 class="rp-card-title">Что изменилось за неделю</h3></div>
            <p class="rp-card-text">Вылеты на 3 недели вперёд, у которых прогноз моделей сейчас заметно отличается от записанного примерно неделю назад (порог — 8% кресел, не меньше 4 пасс.). Сначала — самые большие изменения. Показано ${Math.min(30, list.length)} из ${list.length}.</p>
            <div class="rp-scroll"><table class="rp-table"><thead><tr><th>Рейс</th><th>Вылет</th><th>Прогноз моделей</th><th>Изменение</th><th>Почему</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
    }

    const WARN_LABEL = { under: 'Риск недобора', over: 'Риск перегруза', fast: 'Темп выше обычного', slow: 'Темп ниже обычного' };

    function warnHtml(rerender) {
        if (!evalState.ev) return '';
        const list = warnings();
        if (!list) {
            warningsAsync().then(() => { if (rerender) rerender(); }).catch(e => console.warn(e));
            return `<section class="rp-card"><div class="rp-card-head"><h3 class="rp-card-title">Ранние предупреждения</h3></div>
                <p class="rp-note">Считаю прогноз по всем вылетам на ${warnSettings().days} дн. вперёд… Работать на сайте можно.</p></section>`;
        }
        const cfg = warnSettings();
        const counts = { under: 0, over: 0, fast: 0, slow: 0 };
        list.forEach(w => w.kinds.forEach(k => { counts[k]++; }));
        const ev = evalState.ev;
        const pr = (a, b) => (b ? `${Math.round(a / b * 100)}%` : '—');
        const sigRows = (ev.signals || []).map(z => `<tr><td>${z.h} дн.</td>${['under', 'over'].map(k => { const c = z[k]; return `<td>${pr(c.tp, c.tp + c.fp)} <span class="rp-muted">(${c.tp} из ${c.tp + c.fp})</span></td><td>${pr(c.tp, c.tp + c.fn)} <span class="rp-muted">(${c.tp} из ${c.tp + c.fn})</span></td>`; }).join('')}</tr>`).join('');
        const shown = warnKind ? list.filter(w => warnKind === 'pace' ? (w.kinds.includes('fast') || w.kinds.includes('slow')) : w.kinds.includes(warnKind)) : list;
        const rows = shown.slice(0, 60).map(w => `<tr>
                <td class="rp-left"><strong>${esc(w.code)}</strong> <span class="rp-muted">${esc(w.dir)}</span></td>
                <td>${esc(w.date)}<div class="rp-muted">через ${w.dtd} дн.</div></td>
                <td class="rp-left">${w.kinds.map(k => `<span class="fl-warn fl-warn-${k}">${esc(WARN_LABEL[k])}</span>`).join(' ')}</td>
                <td>${w.sold} <span class="rp-muted">из ${w.s}</span></td>
                <td><strong>${w.final}</strong> <span class="rp-muted">· ${w.lf}%</span>${w.lo != null ? `<div class="rp-muted">${w.lo}–${w.hi}${w.hiRaw > w.s ? ` <span title="Верх прогноза, если бы кресел было больше: оценка, а не точный спрос">(без учёта кресел до ${w.hiRaw})</span>` : ''}</div>` : ''}</td>
                <td class="rp-left fl-warn-why">${w.why.map(esc).join('; ')}</td>
                <td class="rp-left fl-warn-why">${w.act.map(esc).join('; ')}</td></tr>`).join('');
        return `<section class="rp-card">
            <div class="rp-card-head"><h3 class="rp-card-title">Ранние предупреждения</h3></div>
            <p class="rp-card-text">Все вылеты на ${cfg.days} дн. вперёд: прогноз к вылету и интервал 80% (в карточке рейса — то же). Сначала — самые срочные: сильное отклонение и близкий вылет.</p>
            <div class="fl-warn-cfg">
                <label>Недобор, если прогноз ниже <input type="number" id="fl-w-under" min="10" max="95" value="${cfg.under}">%</label>
                <label>Перегруз, если выше <input type="number" id="fl-w-over" min="50" max="100" value="${cfg.over}">%</label>
                <label>На <input type="number" id="fl-w-days" min="3" max="30" value="${cfg.days}"> дн. вперёд</label>
                <button type="button" class="btn-secondary rp-btn" id="fl-w-apply">Применить</button>
                ${canExport() ? `<button type="button" class="btn-primary rp-btn" id="fl-w-xlsx"${list.length ? '' : ' disabled'}>В Excel</button>` : ''}
            </div>
            <div class="dr-kpis">
                ${[['under', 'Риск недобора', counts.under, ''], ['over', 'Риск перегруза', counts.over, ''], ['pace', 'Необычный темп продаж', counts.fast + counts.slow, `выше: ${counts.fast} · ниже: ${counts.slow}`]].map(([k, label, n, sub]) => `<button type="button" class="dr-kpi fl-w-kpi${warnKind === k ? ' fl-w-kpi-on' : ''}" data-fl-wkind="${k}" title="${warnKind === k ? 'Показать все' : 'Показать только эти'}"><div class="dr-kpi-label">${label}</div><div class="dr-kpi-value">${n}</div><div class="dr-kpi-sub">${sub || (warnKind === k ? 'показаны только эти · нажмите ещё раз — все' : 'нажмите — показать только эти')}</div></button>`).join('')}
            </div>
            ${rows ? `<div class="rp-scroll"><table class="rp-table"><thead><tr><th>Рейс</th><th>Вылет</th><th>Сигнал</th><th>Продано</th><th>Прогноз · интервал</th><th>Почему</th><th>Что сделать</th></tr></thead><tbody>${rows}</tbody></table></div>
                ${shown.length > 60 ? `<p class="rp-note">Показаны 60 самых срочных из ${shown.length} — полный список в Excel.</p>` : ''}` : '<p class="rp-note">Сигналов нет.</p>'}
            ${sigRows ? `<details class="fl-math"><summary>Насколько сигналам можно верить — проверка на улетевших</summary>
                <p class="rp-muted">Прогноз за N дней до вылета (честный, как в таблице точности) против факта, при нынешних порогах. «Сбылось» — из поданных сигналов сколько подтвердилось; «Поймали» — из случившихся недоборов/перегрузов сколько было предсказано.</p>
                <table class="rp-table dr-sum-table"><thead><tr><th>За</th><th>Недобор: сбылось</th><th>Недобор: поймали</th><th>Перегруз: сбылось</th><th>Перегруз: поймали</th></tr></thead><tbody>${sigRows}</tbody></table></details>` : ''}
        </section>`;
    }

    // ---------- история продаж (SalesHistory.csv) ----------

    function historyHtml() {
        const st = typeof SalesArchive !== 'undefined' && SalesArchive.stats ? SalesArchive.stats() : null;
        const d = (x) => (x ? fmtDate(x.getTime()) : '—');
        const status = st && st.n
            ? `В архиве ${st.n.toLocaleString('ru-RU')} ${plural(st.n, 'улетевший вылет', 'улетевших вылета', 'улетевших вылетов')}: с ${d(st.from)} по ${d(st.to)}${st.h ? `, из файла истории — ${st.h.toLocaleString('ru-RU')}` : ''}.`
            : 'Архив пока пустой: модель видит только вылеты из текущего файла продаж (около 2 недель).';
        const li = typeof SalesArchive !== 'undefined' && SalesArchive.lastImport ? SalesArchive.lastImport() : null;
        const nFl = Number(li && li.flights) || 0;
        const range = li && li.from ? (li.from === li.to ? ` за ${li.from}` : ` с ${li.from} по ${li.to}`) : '';
        const liTxt = li && li.at ? `Последняя загрузка истории: ${fmtDate(new Date(li.at).getTime())}${li.file ? ` (${li.file})` : ''} — ${nFl.toLocaleString('ru-RU')} ${plural(nFl, 'вылет', 'вылета', 'вылетов')}${range}.` : '';
        return `<section class="rp-card">
            <div class="rp-card-head"><h3 class="rp-card-title">История продаж для прогноза</h3></div>
            <p class="rp-card-text"><strong>SalesHistory.csv</strong> (скрипт Export-SalesHistory.ps1, без ФИО и PNR) из папки данных загружается сам, когда обновился. На нём модель учится, по нему — «год назад» и норма по дням недели.</p>
            <p class="rp-note">${esc(status)}${liTxt ? `<br>${esc(liTxt)}` : ''}</p>
            ${canWrite() ? '<div class="ref-toolbar"><button type="button" class="btn-primary rp-btn" id="fl-hist-load">Загрузить файл истории</button></div>' : '<p class="rp-muted">Загружать историю может тот, у кого есть право «Публикация данных для всех».</p>'}
        </section>`;
    }

    function loadHistory(rerender) {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = '.csv,text/csv';
        inp.onchange = async () => {
            const file = inp.files && inp.files[0];
            if (!file) return;
            const toast = (m, t) => { if (typeof showToast === 'function') showToast(m, t); };
            try {
                if (typeof showLoading === 'function') showLoading('Загружаю историю продаж…');
                const text = await file.text();
                const r = await SalesArchive.importHistory(text, file);
                if (!r.ok) { toast('История не загружена: ' + (r.error || 'ошибка записи'), 'error'); return; }
                toast(`История загружена: ${r.flights.toLocaleString('ru-RU')} вылетов за ${r.months} мес.${r.skipped ? `, пропущено строк: ${r.skipped}` : ''}`);
                afterHistoryImport(rerender);
            } catch (e) {
                console.warn(e);
                toast('Не удалось прочитать файл истории', 'error');
            } finally {
                if (typeof hideLoading === 'function') hideLoading();
                rerender();
            }
        };
        inp.click();
    }

    // Загрузили свежие данные посреди дня: дописать факт улетевших, записать прогнозы и доучиться (в фоне).
    function afterDataLoad() {
        const run = () => {
            if (!canView()) { readPublished().catch(() => null); return; }
            ctxMemo.sig = '';
            ensureLoaded().then(() => (canWrite() ? capture() : false)).then(() => startEvaluation()).catch(e => console.warn('ForecastLab', e));
        };
        if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 20000 });
        else setTimeout(run, 3000);
    }

    // После загрузки истории: восстановить журнал по новым вылетам и переобучить модель — в фоне.
    function afterHistoryImport(rerender) {
        ctxMemo.sig = '';
        invalidate();
        if (!canView()) return;
        ensureLoaded().then(() => (canWrite() ? capture(true) : false)).then(() => startEvaluation(rerender)).catch(e => console.warn(e));
    }

    function canExport() {
        return isAdmin() || !!(typeof ProfileAuth !== 'undefined' && ProfileAuth.hasPermission('export_excel'));
    }

    async function exportWarnings() {
        if (!canExport()) return;
        const list = (await warningsAsync()) || [];
        const lib = typeof loadStyledXlsx === 'function' ? await loadStyledXlsx() : (typeof XLSX !== 'undefined' ? XLSX : null);
        if (!lib) { if (typeof showToast === 'function') showToast('Библиотека Excel не загружена', 'error'); return; }
        const head = ['Рейс', 'Направление', 'Дата вылета', 'Дней до вылета', 'Сигнал', 'Продано', 'Кресел', 'Прогноз', 'Загрузка, %', 'Интервал от', 'Интервал до', 'Спрос до (без ограничения)', 'Способ', 'Почему', 'Что сделать', 'Срочность'];
        const rows = list.map(w => [w.code, w.dir, w.date, w.dtd, w.kinds.map(k => WARN_LABEL[k]).join(', '), w.sold, w.s, w.final, w.lf, w.lo != null ? w.lo : '', w.hi != null ? w.hi : '', w.hiRaw != null ? w.hiRaw : '', w.method, w.why.join('; '), w.act.join('; '), Math.round(w.urgency * 100) / 100]);
        const wb = lib.utils.book_new();
        const ws = lib.utils.aoa_to_sheet([head].concat(rows));
        ws['!cols'] = head.map((h, i) => ({ wch: i === 13 || i === 14 ? 60 : (i === 1 ? 32 : 14) }));
        lib.utils.book_append_sheet(wb, ws, 'Предупреждения');
        const day = typeof getTodayDate === 'function' ? getTodayDate() : today();
        const name = typeof excelDailyFilename === 'function' ? excelDailyFilename('КРАСАВИА_предупреждения', day) : `КРАСАВИА_предупреждения_${day}.xlsx`;
        const saved = typeof excelSaveWorkbook === 'function' ? await excelSaveWorkbook(lib, wb, name, null) : (lib.writeFile(wb, name), null);
        if (saved && typeof excelAnnounceSaved === 'function') excelAnnounceSaved(saved, 'Предупреждения выгружены');
        else if (typeof showToast === 'function') showToast('Предупреждения выгружены');
    }

    // ---------- отчёт ----------

    function fmt(v) {
        return v == null ? '—' : (Math.round(v * 10) / 10).toLocaleString('ru-RU');
    }

    // График «ошибка по горизонтам»: линии (не столбцы) — ошибка меняется по мере приближения вылета.
    // Ось X — дни до вылета слева направо (30 → 1), Y — средняя ошибка, пасс. Подписи серий — у правого края,
    // подсказка по наведению/фокусу — на чистом CSS (без обработчиков). Таблица ниже — табличный вид того же.
    const CHART_SERIES = [['best', 'Что берём'], ['blend', 'Комитет моделей'], ['chain', 'Цепочка добора'], ['naive', 'Продано на сейчас']];

    function chartHtml(ev) {
        const W = 760, H = 260, L = 44, R = 150, T = 14, B = 34;
        const pw = W - L - R, ph = H - T - B;
        const xs = HORIZONS.map((h, i) => L + (HORIZONS.length === 1 ? pw / 2 : i * pw / (HORIZONS.length - 1)));
        const mae = (k, h) => { const c = ev.byH[h] && ev.byH[h][k]; return c && c.n >= PV.MIN_CHOICE ? c.sum / c.n : null; };
        const series = CHART_SERIES.map(([k, label], si) => ({ k, label, si, vals: HORIZONS.map(h => mae(k, h)) }))
            .filter(sr => sr.vals.some(v => v != null));
        const all = series.flatMap(sr => sr.vals).filter(v => v != null);
        if (!all.length) return '';
        const rawMax = Math.max(...all);
        const step = [1, 2, 5, 10, 20, 50].find(st => rawMax / st <= 5) || 100;
        const yMax = Math.max(step, Math.ceil(rawMax / step) * step);
        const yOf = v => T + ph - v / yMax * ph;
        const r1 = v => (Math.round(v * 10) / 10).toLocaleString('ru-RU');
        const grid = [];
        for (let v = 0; v <= yMax + 1e-9; v += step) {
            grid.push(`<line class="flc-grid${v === 0 ? ' flc-base' : ''}" x1="${L}" x2="${L + pw}" y1="${yOf(v)}" y2="${yOf(v)}"/><text class="flc-ytick" x="${L - 8}" y="${yOf(v) + 4}">${v}</text>`);
        }
        const xt = HORIZONS.map((h, i) => `<text class="flc-xtick" x="${xs[i]}" y="${T + ph + 18}">${h}</text>`).join('');
        const lines = series.map(sr => {
            const segs = [];
            let cur = [];
            sr.vals.forEach((v, i) => { if (v == null) { if (cur.length) segs.push(cur); cur = []; } else cur.push(`${xs[i].toFixed(1)},${yOf(v).toFixed(1)}`); });
            if (cur.length) segs.push(cur);
            const path = segs.map(sg => 'M' + sg.join('L')).join('');
            const dots = sr.vals.map((v, i) => (v == null ? '' : `<circle class="flc-dot" cx="${xs[i].toFixed(1)}" cy="${yOf(v).toFixed(1)}" r="4"/>`)).join('');
            return `<g class="flc-s flc-s${sr.si + 1}">${path ? `<path class="flc-line" d="${path}"/>` : ''}${dots}</g>`;
        }).join('');
        // Подписи у последней точки каждой серии, раздвинутые, чтобы не наезжали.
        const labs = series.map(sr => {
            let i = sr.vals.length - 1;
            while (i >= 0 && sr.vals[i] == null) i--;
            return { sr, y: yOf(sr.vals[i]), x: xs[i] };
        }).sort((a, b) => a.y - b.y);
        for (let i = 1; i < labs.length; i++) if (labs[i].y - labs[i - 1].y < 15) labs[i].y = labs[i - 1].y + 15;
        const over = labs.length ? labs[labs.length - 1].y - (T + ph + 4) : 0;
        if (over > 0) labs.forEach(lb => { lb.y -= over; });
        const direct = labs.map(lb => `<text class="flc-dlabel" x="${L + pw + 12}" y="${(lb.y + 4).toFixed(1)}"><tspan class="flc-key flc-s${lb.sr.si + 1}">●</tspan> ${esc(lb.sr.label)}</text>`).join('');
        // Колонки для наведения: зона шире точки, перекрестие и подсказка со всеми сериями.
        const nOf = (h) => { const c = ev.byH[h] && ev.byH[h].best; return c ? c.n : 0; };
        const colW = pw / Math.max(1, HORIZONS.length - 1);
        const cols = HORIZONS.map((h, i) => {
            const rows = series.map(sr => ({ sr, v: sr.vals[i] })).filter(r => r.v != null);
            if (!rows.length) return '';
            const tw = 224, th = 26 + rows.length * 18;
            const tx = xs[i] + 12 + tw > W ? xs[i] - 12 - tw : xs[i] + 12;
            const ty = T + 4;
            const word = h === 1 ? 'день' : (h < 5 ? 'дня' : 'дней');
            return `<g class="flc-col" tabindex="0" aria-label="За ${h} ${word} до вылета: ${rows.map(r => `${esc(r.sr.label)} ${r1(r.v)}`).join(', ')}">
                <rect class="flc-hit" x="${(xs[i] - colW / 2).toFixed(1)}" y="${T}" width="${colW.toFixed(1)}" height="${ph}"/>
                <line class="flc-cross" x1="${xs[i]}" x2="${xs[i]}" y1="${T}" y2="${T + ph}"/>
                <g class="flc-tip"><rect class="flc-tip-box" x="${tx}" y="${ty}" width="${tw}" height="${th}" rx="6"/>
                    <text class="flc-tip-head" x="${tx + 10}" y="${ty + 17}">За ${h} ${word} до вылета</text><text class="flc-tip-n" x="${tx + tw - 10}" y="${ty + 17}">${nOf(h)} выл.</text>
                    ${rows.map((r, j) => `<text class="flc-tip-row" x="${tx + 10}" y="${ty + 36 + j * 18}"><tspan class="flc-key flc-s${r.sr.si + 1}">●</tspan> ${esc(r.sr.label)}</text><text class="flc-tip-val" x="${tx + tw - 10}" y="${ty + 36 + j * 18}">±${r1(r.v)}</text>`).join('')}
                </g></g>`;
        }).join('');
        const legend = series.map(sr => `<span class="flc-leg"><span class="flc-leg-mark flc-s${sr.si + 1}"></span>${esc(sr.label)}</span>`).join('');
        return `<div class="fl-chart">
            <div class="flc-legend">${legend}</div>
            <svg class="flc-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Средняя ошибка прогноза в пассажирах по числу дней до вылета">
                ${grid.join('')}${xt}
                <text class="flc-axis" x="${L + pw / 2}" y="${H - 2}">дней до вылета</text>
                ${lines}${direct}${cols}
            </svg></div>`;
    }

    // Точность по группам вылетов (за 7 и за 3 дня): где модель ошибается сильнее.
    function groupsHtml(ev) {
        if (!ev.groups) return '';
        const cell = (c) => (c && c.n ? `${fmt(c.sum / c.n)}<div class="rp-muted">ошибка ${c.f ? Math.round(c.sum / c.f * 100) : '—'}% · ${c.bias > 0 ? '↑' : '↓'}${fmt(Math.abs(c.bias / c.n))}</div>` : '—');
        const table = (h) => {
            const skipped = (ev.groups[h] || []).filter(g => g.note).map(g => g.note)[0] || 0;
            const rows = (ev.groups[h] || []).filter(g => !g.note).map(g => {
                const vals = ['best', 'naive', 'chain', 'eb', 'planPick'].map(k => (g[k] && g[k].n ? g[k].sum / g[k].n : null));
                const best = Math.min(...vals.filter(v => v != null));
                return `<tr><td class="rp-left"><strong>${esc(g.label)}</strong></td><td>${g.n}</td>${['best', 'naive', 'chain', 'eb', 'planPick'].map((k, i) => `<td class="${vals[i] != null && vals[i] === best ? 'fl-best' : ''}">${cell(g[k])}</td>`).join('')}</tr>`;
            }).join('');
            return rows ? `<table class="rp-table dr-sum-table"><thead><tr><th>Группа</th><th>Вылетов</th><th>Что берём</th><th>Продано на сейчас</th><th>Цепочка добора</th><th>Добор этого рейса</th><th>Продано + добор по файлу <span class="rp-muted">(где есть файл)</span></th></tr></thead><tbody>${rows}</tbody></table>${skipped ? `<p class="rp-note">Все способы сравниваются на одних и тех же вылетах; ${skipped} вылетов, где цепочке или добору рейса ещё не на чем было считать, не вошли.</p>` : ''}` : '<p class="rp-note">Пока нет данных.</p>';
        };
        const comp = COMPETITION.map(c => `${c.cities.join(' — ')} (${c.who}, с ${c.since})`).join('; ');
        return `<div class="dr-sum"><div class="dr-sum-title">Точность по группам, пасс. (за 7 дней до вылета)</div><div class="rp-scroll">${table(7)}</div>
                <div class="dr-sum-title" style="margin-top:10px">За 3 дня до вылета</div><div class="rp-scroll">${table(3)}</div>
                <p class="rp-note">Линии с конкурентом: ${esc(comp)}. Ёмкость — по креслам в продаже: до 50 — ВС на 42–48, до 80 — на 72, больше — на 120.</p></div>
            <details class="fl-math"><summary>Что проверили: что взяли и что пока нет</summary>
                <p class="rp-muted">Каждый способ проверялся так же честно — на прошлых неделях, по вылетам, которые к моменту прогноза ещё не улетели.</p>
                <ul class="fl-tested">
                    <li><b>Мультипликативный добор</b> (итог = продано × коэффициент) — хуже аддитивного на 1–2 пасс. за 5–10 дней: при малых продажах коэффициент «взрывается». Как и в исследованиях RMS (круизы, отели), аддитивный точнее.</li>
                    <li><b>Восстановление спроса распроданных рейсов</b> — точность не выросла: прогноз и так не больше кресел. Вернёмся, когда понадобится прогноз спроса сверх ёмкости.</li>
                    <li><b>Подбор весов моделей по МНК</b> — выигрыш в пределах шума на нынешних 3 неделях; комитет с весами по ошибкам надёжнее на малых данных («загадка комбинирования прогнозов»: простые веса часто не хуже сложных).</li>
                    <li><b>«Забывание» старых ошибок в комитете</b> (свежие ошибки весят больше) — на годе истории разницы нет: комитет и так судит по последним 12 неделям.</li>
                    <li><b>Взято:</b> обучение на годе истории со свежими вылетами весомее (вес вдвое меньше каждые 120 дней) — модель точнее на 2%, комитет на 1% (12 недель проверки на реальной истории).</li>
                </ul></details>`;
    }

    // «Как считается» — те же формулы, что в шапке файла, человеческим языком.
    function mathHtml() {
        const f = (formula, text) => `<div class="fl-math-row"><div class="fl-math-f">${formula}</div><div class="fl-math-t">${text}</div></div>`;
        return `<details class="fl-math"><summary>Как считается прогноз — формулы</summary>
            <p class="rp-muted">Обозначения: <i>s</i> — кресел, <i>o<sub>h</sub></i> — продано за <i>h</i> дней до вылета, <i>f</i> — итог (факт),
                <i>p</i> и <i>q<sub>h</sub></i> — файл ожидаемой загрузки: итог и его значение на день <i>h</i>.</p>
            ${f('<i>t</i> = (<i>f</i> − <i>o<sub>h</sub></i>) / <i>s</i>', 'Модель предсказывает <b>добор</b> — сколько ещё купят, в долях кресел.')}
            ${f('<i>f̂</i> = min(<i>s</i>, max(<i>o<sub>h</sub></i>, <i>o<sub>h</sub></i> + <i>s</i>·<i>t̂</i>))', 'Итог: не меньше уже проданного и не больше кресел.')}
            ${f('<i>f̂</i> = <i>o<sub>h</sub></i> + (<i>p</i> − <i>q<sub>h</sub></i>)', '«Продано + добор по файлу»: сколько файл ожидаемой ещё добирает от этого дня до вылета.')}
            ${f('<i>f̂</i> = <i>o<sub>h</sub></i> + <i>s</i>·<span class="fl-bar">π</span><sub>h</sub>, &nbsp; <span class="fl-bar">π</span><sub>h</sub> = среднее <i>t</i> всех улетевших рейсов на горизонте <i>h</i>', '«Средний добор всех рейсов» — запасной способ, когда нет ни файла, ни истории.')}
            ${f('<i>ℓ</i><sub>a→b</sub> = Σ<i>w</i>·(<i>o<sub>b</sub></i> − <i>o<sub>a</sub></i>)/<i>s</i> ⁄ Σ<i>w</i>, &nbsp; <i>w</i> = e<sup>−возраст/28</sup>, &nbsp; <i>f̂</i> = <i>o<sub>h</sub></i> + <i>s</i>·Σ<i>ℓ</i>', '«Цепочка добора» (как в RMS авиакомпаний): добор между соседними точками 30→21→…→1→вылет считается и по ещё не улетевшим рейсам, свежие недели весят больше. Для рейса и дня недели звено сглаживается к общему.')}
            ${f('<i>t̂</i><sub>рейс</sub> = (Σ<i>t</i><sub>рейс</sub> + 10·<i>t̄</i>) / (<i>n</i><sub>рейс</sub> + 10)', '«Добор этого рейса»: средний добор рейса, подтянутый к среднему всех рейсов, пока вылетов мало (эмпирический Байес). Он же — признак для моделей.')}
            ${f('<i>w<sub>k</sub></i> ∝ exp(−4·(<i>L<sub>k</sub></i>/<i>L</i><sub>min</sub> − 1)), &nbsp; <i>L</i><sub>рейс</sub> = (Σ|<i>e</i>| + 8·<i>L</i><sub>все</sub>) / (<i>n</i> + 8)', '«Комитет моделей»: все способы считают прогноз, вес каждого — по его ошибкам именно на этом рейсе (пока вылетов мало — по всем рейсам). Лучший на рейсе весит больше, остальные страхуют; способ с ошибкой больше двух лучших не голосует.')}
            ${f('<i>a<sub>i</sub></i> = 2<sup>−давность/120 дн.</sup>', 'Постоянное дообучение: каждый день модели заново учатся на всех улетевших вылетах за год (загруженная история + новые вылеты). Свежие вылеты весят больше: полугодовой — в 3 раза меньше вчерашнего, годовой — в 8 раз.')}
            ${f('<i>ŵ</i> = (<i>X</i><sup>T</sup><i>AX</i> + λ<i>I</i>)<sup>−1</sup><i>X</i><sup>T</sup><i>At</i>, <i>A</i> = diag(<i>a</i>), &nbsp; λ = 0,8', `Линейная модель (гребневая регрессия) по ${FEATURE_GROUPS.reduce((a, g) => a + g[1], 0)} признакам: признаки приводятся к одному масштабу, штраф λ не даёт весам раздуваться на малых данных. Своя модель на каждом горизонте, когда записей ≥ 80.`)}
            ${f(`<i>F<sub>m</sub></i> = <i>F</i><sub><i>m</i>−1</sub> + η·<i>h<sub>m</sub></i>, &nbsp; <i>r</i> = clip(<i>t</i> − <i>F</i>, −δ, δ), &nbsp; η = ${String(PV.GBM_RATE).replace('.', ',')}, <i>M</i> = ${PV.GBM_ROUNDS}, глубина ${PV.GBM_DEPTH}`, 'Решающие деревья (градиентный бустинг): каждое следующее дерево исправляет ошибки предыдущих. Ошибка обрезается на δ (потери Хьюбера) — группы и отмены не сбивают модель. Кроме общих деревьев обучаются отдельные на близкие (1–3 дня), средние (5–10) и дальние (14–30) горизонты; итог — их смесь. Обучение идёт в фоновых потоках браузера и не тормозит сайт.')}
            ${f('<i>t̂</i> = ½(<i>t̂</i><sub>лин</sub> + <i>t̂</i><sub>дер</sub>)', 'Среднее двух моделей. Особенности рейса модели берут из признака «добор этого рейса». Добор может быть и отрицательным: в последние дни возвраты бывают больше новых продаж.')}
            ${f('[<i>f̂</i> + <i>q</i><sub>0,1</sub>·<i>s</i>; &nbsp;<i>f̂</i> + <i>q</i><sub>0,9</sub>·<i>s</i>], &nbsp; <i>q</i> — квантили остатков (<i>f</i> − <i>f̂</i>)/<i>s</i> прошлых прогнозов', 'Интервал 80% (конформный): по тому, как этот же способ ошибался раньше на таком же горизонте, таких же вылетах и такой же загрузке (слабые, средние и почти полные рейсы ошибаются по-разному). Несимметричный — вниз и вверх ошибаются по-разному. В карточке: «44 из 72 (40–47, 80%)».')}
            ${f('недобор: P50/<i>s</i> &lt; 60%; &nbsp; перегруз: P50/<i>s</i> ≥ 95% или (P90 &gt; <i>s</i> и P50/<i>s</i> ≥ 90%); &nbsp; темп: |<i>z</i>| ≥ 2, <i>z</i> = (<i>o</i>/<i>s</i> − <i>m</i>)/σ', 'Ранние предупреждения. P50 — прогноз, P10–P90 — интервал 80%; <i>m</i> и σ — сколько обычно продано к этому дню у того же рейса в тот же день недели. Срочность = сила отклонения / √дней до вылета. Пороги меняются в отчёте.')}
            ${f('Ошибка, % = Σ|<i>f̂</i> − <i>f</i>| / Σ<i>f</i>', 'Ошибка в процентах от всех перевезённых пассажиров — не «взрывается» на рейсах с малой загрузкой, в отличие от средней ошибки в процентах по рейсам.')}
            ${f('обучение: вылеты с датой ≤ понедельник(дата − <i>h</i>) − 1 день', 'Честная проверка: прогноз за <i>h</i> дней модель делает, зная только вылеты, улетевшие к тому моменту.')}
            ${f('MAE = (1/<i>N</i>)·Σ|<i>f̂</i> − <i>f</i>|, &nbsp; смещение = (1/<i>N</i>)·Σ(<i>f̂</i> − <i>f</i>)', 'Средняя ошибка в пассажирах и в какую сторону ошибается (↑ завышает, ↓ занижает).')}
            ${f('<i>t</i> = −<i>d̄</i> / (<i>s<sub>d</sub></i>/√<i>n</i>) &gt; порога (параметр «Смена способа»), &nbsp; <i>d<sub>i</sub></i> = |<i>e</i><sub>новый</sub>| − |<i>e</i><sub>прежний</sub>|', 'Способ меняется, только если новый надёжно точнее на тех же вылетах, а не случайно.')}
        </details>`;
    }

    // Постоянное дообучение: когда модель обучилась, на скольких новых вылетах, как меняется ошибка за 7 дней.
    function learnKpis(ev) {
        const d = new Date(ev.at || Date.now());
        const when = `${fmtDate(d.getTime()) === fmtDate(Date.now()) ? 'сегодня' : fmtDate(d.getTime())} в ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        const weeks = [...ev.byWeek.values()].sort((a, b) => a.ts - b.ts).filter(W => W.best[1]);
        const avg = (ws) => { const s = ws.reduce((a, W) => a + W.best[0], 0); const n = ws.reduce((a, W) => a + W.best[1], 0); return n ? s / n : null; };
        const now4 = weeks.length >= 6 ? avg(weeks.slice(-4)) : null;
        const prev4 = weeks.length >= 6 ? avg(weeks.slice(-8, -4)) : null;
        const trend = now4 != null && prev4 != null
            ? `<div class="dr-kpi ${now4 <= prev4 ? 'dr-kpi-up' : ''}"><div class="dr-kpi-label">Средняя ошибка за 7 дней до вылета</div><div class="dr-kpi-value">${fmt(now4)} пасс.</div><div class="dr-kpi-sub">вылеты с файлом ожидаемой за последние 4 недели; за 4 недели до них — ${fmt(prev4)}</div></div>` : '';
        // Данные продаж старые — новых улетевших вылетов нет, учиться не на чем: так и пишем.
        const lag = dataLagDays();
        const stale = lag > 1 && typeof lastSalesUpdate !== 'undefined' && lastSalesUpdate
            ? `данные продаж от ${fmtDate(new Date(lastSalesUpdate).getTime())} — загрузите свежие, чтобы модель доучилась` : '';
        return `<div class="dr-kpi ${stale ? 'dr-kpi-down' : ''}"><div class="dr-kpi-label">Обучена</div><div class="dr-kpi-value">${when}</div><div class="dr-kpi-sub">${stale || `за неделю данных +${ev.fresh || 0} улетевших вылетов · доучивается при каждом обновлении данных`}</div></div>${trend}`;
    }

    function html(rerender) {
        if (!canView()) {
            // Только «Ценовой советник» (своё право) — без отчёта о прогнозе.
            if (typeof PriceAdvisor !== 'undefined' && PriceAdvisor.canView()) return PriceAdvisor.reportHtml(rerender);
            return '<p class="rp-note">Раздел доступен по праву «Прогноз загрузки и предупреждения» (выдаёт администратор в «Профилях»).</p>';
        }
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
        const cols = [['naive', 'Продано на сейчас'], ['pool', 'Средний добор всех рейсов'], ['eb', 'Добор этого рейса'], ['ly', 'Прошлый год'], ['chain', 'Цепочка добора'], ['plan', 'Файл ожидаемой, итог'], ['planPick', 'Продано + добор по файлу'], ['hist', 'По тем же дням недели'], ['lin', 'Модель: линейная'], ['gbm', 'Модель: деревья'], ['ens', 'Модель: среднее'], ['blend', 'Комитет моделей']];
        // Что берём: отдельно для вылетов с файлом ожидаемой, с историей и без того и другого (если данных хватает).
        const choiceCell = (h) => {
            const segs = ['plan', 'hist', 'none'].filter(sg => ev.choice[h + '|' + sg]);
            if (!segs.length) return ev.choice[h] ? `<strong>${esc(METHOD_LABEL[ev.choice[h].k])}</strong>` : '<span class="rp-muted">мало данных</span>';
            return segs.map(sg => {
                const c = ev.choice[h + '|' + sg];
                const ci = ev.conf && ev.conf[h + '|' + sg];
                const pp = v => `${v > 0 ? '+' : (v < 0 ? '−' : '')}${Math.abs(Math.round(v * 100))}`;
                const ciTxt = ci && ci.k === c.k ? ` <span class="rp-muted" title="80% вылетов попадали в эти пределы вокруг прогноза (п.п. загрузки, по ${ci.n} прошлым прогнозам)">· 80%: ${pp(ci.lo)}…${pp(ci.hi)} п.п.</span>` : '';
                return `<div class="fl-seg"><span class="rp-muted">${esc(SEG_LABEL[sg])}:</span> <strong>${esc(METHOD_LABEL[c.k])}</strong> <span class="rp-muted">±${fmt(c.v)}</span>${ciTxt}</div>`;
            }).join('');
        };
        const pct = v => (v == null || !isFinite(v) ? '—' : `${Math.round(v * 100)}%`);
        // Итог «что берём»: средняя ошибка, WAPE = Σ|ошибка| / Σ факт, смещение и честное покрытие интервала.
        const totalCell = (h) => {
            const b = ev.byH[h].best;
            const C = ev.cover && ev.cover[h];
            if (!b || !b.n) return '—';
            const hn = ev.byH[h].honest;
            const rb = ev.rubErr && ev.rubErr[h];
            return `<strong>±${fmt(b.sum / b.n)}</strong> <span class="rp-muted">· ошибка ${pct(b.f ? b.sum / b.f : null)} · ${b.bias > 0 ? '↑' : '↓'}${fmt(Math.abs(b.bias / b.n))}</span>`
                + (ev.byH[h].live && ev.byH[h].live.n >= 30 ? `<div class="rp-muted" title="Только вылеты из ежедневных данных сайта, без архива продаж">на живых вылетах: ±${fmt(ev.byH[h].live.sum / ev.byH[h].live.n)} (${ev.byH[h].live.n})</div>` : '')
                + (hn && hn.n ? `<div class="rp-muted" title="Способ выбран по ранним неделям проверки, ошибка — на последних 4 (их выбор не видел)">честно, вне выборки: ±${fmt(hn.sum / hn.n)} (${hn.n})</div>` : '')
                + (rb ? `<div class="rp-muted" title="Ошибка × средний взрослый тариф рейса: ошибка на дорогом рейсе дороже">в рублях ≈ ${Math.round(rb.avg).toLocaleString('ru-RU')} ₽ на вылет</div>` : '')
                + (C && C.n ? `<div class="rp-muted" title="Интервал строится только по вылетам, улетевшим до недели прогноза">в интервал 80% попало ${pct(C.in / C.n)} из ${C.n}, ширина ≈ ${fmt(C.width / C.n)}</div>` : '<div class="rp-muted">покрытие проверить пока не на чем</div>');
        };
        const rowsH = HORIZONS.map(h => {
            const B = ev.byH[h];
            const vals = cols.map(([k]) => (B[k].n ? B[k].sum / B[k].n : null));
            // Лучший — только среди способов, посчитанных почти на всех вылетах этого горизонта (иначе сравнение на разных вылетах).
            const maxN = Math.max(0, ...cols.map(([k]) => B[k].n || 0));
            const full = (k) => B[k].n >= PV.MIN_CHOICE && B[k].n >= 0.9 * maxN && k !== 'plan';
            const okVals = vals.filter((v, i) => v != null && full(cols[i][0]));
            const best = okVals.length ? Math.min(...okVals) : null;
            return `<tr><td><strong>${h} ${h === 1 ? 'день' : (h < 5 ? 'дня' : 'дней')}</strong></td>${cols.map(([k], i) => {
                const v = vals[i];
                const b = B[k].n ? B[k].bias / B[k].n : null;
                return `<td class="${v != null && v === best && full(k) ? 'fl-best' : ''}"${B[k].n && B[k].n < 0.9 * maxN ? ' title="Посчитан не на всех вылетах — сравнивать с осторожностью"' : ''}>${fmt(v)}${v != null ? `<div class="rp-muted">${B[k].n} · ${b > 0 ? '↑' : '↓'}${fmt(Math.abs(b))}</div>` : ''}</td>`;
            }).join('')}<td class="rp-left">${choiceCell(h)}${B.simpleOnly ? '<div class="rp-muted">модель проверить пока не на чем</div>' : ''}</td><td class="rp-left">${totalCell(h)}</td></tr>`;
        }).join('');
        const weeks = [...ev.byWeek.entries()].sort((a, b) => a[0] - b[0]).slice(-12);
        const rowsW = weeks.map(([, W]) => {
            const d = new Date(W.ts);
            const p = W.plan[1] ? W.plan[0] / W.plan[1] : null;
            const b = W.best[1] ? W.best[0] / W.best[1] : null;
            return `<tr><td>с ${pad(d.getDate())}.${pad(d.getMonth() + 1)}</td><td>${fmt(p)}</td><td class="${b != null && p != null && b < p ? 'fl-best' : ''}">${fmt(b)}</td><td>${Math.max(W.plan[1], W.best[1])}</td></tr>`;
        }).join('');
        const routes = [...ev.byBase.entries()].map(([b, R]) => {
            const M = R.plan[1] ? R.model : (R.modelAll || R.model);
            return { b, p: R.plan[1] ? R.plan[0] / R.plan[1] : null, m: M[1] ? M[0] / M[1] : null, n: Math.max(R.plan[1], M[1]) };
        })
            .filter(x => x.n >= 3).sort((a, b) => (b.m != null ? b.m : b.p || 0) - (a.m != null ? a.m : a.p || 0)).slice(0, 12);
        const rowsR = routes.map(x => `<tr><td class="rp-left"><strong>${esc(x.b)}</strong> <span class="rp-muted">${esc(typeof getFlightDirection === 'function' ? getFlightDirection(x.b) : '')}</span></td><td>${fmt(x.p)}</td><td>${fmt(x.m)}</td><td>${x.n}</td></tr>`).join('');
        const infl = ev.influence.filter(x => x.share > 0.001).map(x => `<div class="fl-infl"><span class="fl-infl-label">${esc(x.label)}</span><span class="fl-infl-bar"><span style="width:${Math.max(2, Math.round(x.share * 100))}%"></span></span><span class="fl-infl-val">${Math.round(x.share * 100)}%</span></div>`).join('');
        let cap = lastCapture && (lastCapture.recorded || lastCapture.backfilled || lastCapture.finals)
            ? `Последняя запись журнала: прогнозов ${lastCapture.recorded}, восстановлено вылетов ${lastCapture.backfilled}, дописан факт ${lastCapture.finals}.` : '';
        if (lastCapture && lastCapture.stale) cap += ' Данные продаж старше суток — прогнозы на сегодня не записаны (запишутся после загрузки свежих данных).';
        return `${warnHtml(rerender)}
            ${changesHtml(rerender)}
            ${typeof PriceAdvisor !== 'undefined' ? PriceAdvisor.reportHtml(rerender) : ''}
            <section class="rp-card">
                <div class="rp-card-head"><h3 class="rp-card-title">Точность прогноза загрузки</h3></div>
                <p class="rp-card-text">Каждый день сайт записывает прогноз по каждому вылету за 30, 21, 14, 10, 7, 5, 3 и 1 день до вылета, а после вылета — факт.
                    Модель учитывает продажи и их темп, файл ожидаемой загрузки, те же дни недели, соседние даты рейса, обратный рейс,
                    день недели, выходные, праздники и каникулы, сезон и тип рейса. Ошибка — в пассажирах, в среднем по вылетам; под числом — сколько вылетов
                    и в какую сторону ошибается (↑ завышает, ↓ занижает). Проверка честная: прогноз за N дней до вылета модель делает, зная только вылеты,
                    улетевшие к тому моменту. Все способы сравниваются на одних и тех же вылетах (последние ${PV.EVAL_WEEKS} недель).
                    Способ выбирается отдельно для вылетов с файлом ожидаемой загрузки, с историей по дням недели и без того и другого,
                    и меняется, только когда новый способ надёжно точнее. «Средний добор всех рейсов» — сколько в среднем добирают все рейсы
                    за столько же дней до вылета: запасной способ для рейсов без файла и без истории.
                    ${ev.anyModel ? '' : '<strong>Модели пока не на чем проверяться: улетевших вылетов мало. Сравниваются простые способы.</strong>'}</p>
                <div class="dr-kpis">
                    <div class="dr-kpi"><div class="dr-kpi-label">Вылетов с фактом</div><div class="dr-kpi-value">${ev.departures}</div><div class="dr-kpi-sub">записей прогноза: ${ev.samples}</div></div>
                    <div class="dr-kpi"><div class="dr-kpi-label">Ждут вылета</div><div class="dr-kpi-value">${futureKeys}</div><div class="dr-kpi-sub">факт допишется после вылета</div></div>
                    <div class="dr-kpi ${ev.anyModel ? 'dr-kpi-up' : ''}"><div class="dr-kpi-label">Модель</div><div class="dr-kpi-value">${ev.anyModel ? 'работает' : (ev.trained ? 'копит данные' : 'учится')}</div><div class="dr-kpi-sub">${ev.anyModel ? 'линейная + деревья, проверена' : 'нужно больше улетевших вылетов для честной проверки'}</div></div>
                    ${learnKpis(ev)}
                </div>
                ${cap ? `<p class="rp-note">${esc(cap)}</p>` : ''}
                ${ev.calibCheck && ev.calibCheck.n ? `<p class="rp-note">Поправка по уровню загрузки (сильные рейсы прогноз занижает, слабые — завышает): на последних 4 неделях проверки средняя ошибка ${fmt(ev.calibCheck.before / ev.calibCheck.n)} → ${fmt(ev.calibCheck.after / ev.calibCheck.n)} пасс. — ${ev.calib ? 'поправка включена' : 'выигрыша нет, поправка не применяется'}.</p>` : ''}
                <div class="dr-list-title">Насколько ошибается прогноз, пасс. (меньше — лучше)</div>
                ${chartHtml(ev)}
                <div class="dr-list-title">Ошибка по горизонтам, пасс.</div>
                <div class="rp-scroll"><table class="rp-table">
                    <thead><tr><th>До вылета</th>${cols.map(([, l]) => `<th>${esc(l)}</th>`).join('')}<th title="Этот способ показывается в карточке рейса">Что берём</th><th title="Способ выбран по этим же неделям — поэтому оценка «что берём» немного оптимистична; столбцы отдельных способов честные">Итог: ошибка, ошибка в %, интервал</th></tr></thead>
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
                ${ev.routeErr && ev.routeErr.length ? `<div class="dr-sum"><div class="dr-sum-title">Где модель ошибается: рейсы с самой большой ошибкой (за 3, 7 и 14 дней до вылета)</div>
                    <table class="rp-table dr-sum-table"><thead><tr><th>Рейс</th><th>Ошибка, пасс.</th><th>Ошибка, %</th><th title="↑ прогноз завышает, ↓ занижает">Смещение</th><th>Записей</th></tr></thead><tbody>${ev.routeErr.map(x => `<tr><td class="rp-left"><strong>${esc(x.b)}</strong> <span class="rp-muted">${esc(typeof getFlightDirection === 'function' ? getFlightDirection(x.b) : '')}</span></td><td>${fmt(x.mae)}</td><td>${x.wape == null ? '—' : Math.round(x.wape * 100) + '%'}</td><td>${x.bias > 0 ? '↑' : '↓'}${fmt(Math.abs(x.bias))}</td><td>${x.n}</td></tr>`).join('')}</tbody></table></div>` : ''}
                ${ev.glitches && ev.glitches.length ? `<p class="rp-note">Исключены как сбой данных (накануне вылета почти пусто, а улетел заметный вылет): ${ev.glitches.length} — ${esc(ev.glitches.slice(0, 6).map(k => k.split('|').reverse().join(' ')).join(', '))}${ev.glitches.length > 6 ? '…' : ''}.</p>` : ''}
                ${groupsHtml(ev)}
                ${mathHtml()}
                ${canWrite() ? `<div class="ref-toolbar"><button type="button" class="btn-secondary rp-btn" id="fl-capture">Записать прогнозы сейчас</button>
                    <span class="rp-muted">Обычно это происходит само раз в день при входе администратора.</span></div>` : ''}
            </section>
            ${historyHtml()}`;
    }

    function handleClick(btn, rerender) {
        if (btn.dataset.flWkind) { warnKind = warnKind === btn.dataset.flWkind ? '' : btn.dataset.flWkind; rerender(); return true; }
        if (btn.id === 'fl-w-apply') {
            const num = (id, lo, hi, def) => { const v = parseInt(document.getElementById(id) && document.getElementById(id).value, 10); return isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def; };
            const cfg = { under: num('fl-w-under', 10, 95, WARN_DEFAULT.under), over: num('fl-w-over', 50, 100, WARN_DEFAULT.over), days: num('fl-w-days', 3, 30, WARN_DEFAULT.days) };
            try { localStorage.setItem(WARN_KEY, JSON.stringify(cfg)); } catch (e) { /* ignore */ }
            warnCache = null;
            rerender();
            return true;
        }
        if (btn.id === 'fl-w-xlsx') { if (canExport()) exportWarnings().catch(e => console.warn(e)); return true; }
        if (btn.id === 'fl-hist-load') { if (canWrite()) loadHistory(rerender); return true; }
        if (btn.id !== 'fl-capture') return false;
        btn.disabled = true;
        capture(true).then(ok => {
            if (typeof showToast === 'function') showToast(ok ? 'Прогнозы записаны в журнал' : 'Не удалось записать журнал (нет доступа к общей папке?)', ok ? undefined : 'error');
            rerender();
        }).catch(e => { console.warn(e); btn.disabled = false; });
        return true;
    }

    return { canView, html, handleClick, afterStart, afterDataLoad, afterHistoryImport, modelRevision: () => modelRev, forecastFor, ensureLoaded, capture, startEvaluation, evaluation: () => evalState.ev, predict, HORIZONS };
})();
