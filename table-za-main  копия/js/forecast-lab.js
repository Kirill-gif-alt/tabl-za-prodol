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
//    Способы: продано на сейчас, файл ожидаемой, те же дни недели, средний добор, добор этого рейса, цепочка добора,
//    линейная модель, решающие деревья, их среднее — и комитет: все вместе с весами по точности на каждом рейсе.
//    Проверка честная: для каждой недели модели обучены только на более ранних неделях. На каждом горизонте
//    берётся способ, который ошибался меньше всех.
//
// ═══════════════════════ МАТЕМАТИКА МОДЕЛИ ═══════════════════════
// Обозначения (вылет i, горизонт h — дней до вылета):
//   sᵢ — кресла, oᵢₕ — продано за h дней, fᵢ — итог (факт), pᵢ / qᵢₕ — файл ожидаемой: итог и значение на день h,
//   yᵢₕ — прогноз по тем же дням недели, xᵢₕ ∈ ℝ³⁴ — признаки (см. features / FEATURE_GROUPS).
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
//     ŵ = argmin_w Σᵢ (tᵢ − w₀ − wᵀxᵢ)² + λ‖w‖²   ⇒   ŵ = (X̃ᵀX̃ + λ·I₀)⁻¹ X̃ᵀt,
//     X̃ = [1 | X], I₀ = diag(0, 1, …, 1) (свободный член не штрафуется), λ = 0,8; решение — Гаусс–Жордан с выбором ведущего.
//
// (4) Градиентный бустинг деревьев с потерями Хьюбера:
//     F₀ = median(t);   δ = max(0,02; Q₀,₉ |tᵢ − F₀|)
//     для m = 1..M:  rᵢ = clip(tᵢ − Fₘ₋₁(xᵢ), −δ, δ)              (антиградиент Хьюбера: выбросы обрезаются)
//                    hₘ = дерево глубины 3 по МНК на rᵢ, лист ≥ 12, пороги — 16 квантилей признака
//                    разбиение по максимуму  G = S_L²/n_L + S_R²/n_R − S²/n   (S — сумма rᵢ в узле)
//                    Fₘ = Fₘ₋₁ + η·hₘ,    η = 0,08, M = 120
//     Важность признака: доля Σ G всех его разбиений во всех деревьях.
//
// (5) Ансамбль: t̂ = ½·(t̂_lin + t̂_gbm) + c_{b,g}
//     Поправка рейса b на группе горизонтов g (1–3 / 5–10 / 14–30 дней) — эмпирический Байес:
//     c_{b,g} = n/(n + K) · (1/n)·Σᵢ (tᵢ − t̂ᵢ),   K = 10   (мало вылетов — поправка ≈ 0, много — средний остаток рейса).
//
// (6) Честная проверка (walk-forward): прогноз за h дней до вылета i сделан в неделю cᵢ = понедельник(tsᵢ − h·сутки);
//     модель для него обучена только на вылетах j с tsⱼ + сутки ≤ cᵢ. Точность способа k на вылетах A:
//     MAEₖ = (1/|A|)·Σ |f̂ₖᵢ − fᵢ|,   смещение = (1/|A|)·Σ (f̂ₖᵢ − fᵢ),   все способы — на одних и тех же вылетах.
//
// (7) Выбор способа на горизонте h для сегмента (есть файл / есть история / нет ничего):  k* = argminₖ MAEₖ,
//     но прежний способ k₀ меняется на k*, только если парная разница dᵢ = |eₖ*,ᵢ| − |eₖ₀,ᵢ| надёжно меньше нуля:
//     t = −d̄ / (s_d/√n) > 1   (защита от «прыжков» из-за шума).
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
    const TRAIN_MAX = 16000;        // обучение: до 16 000 записей — половина самых свежих, половина равномерно по всей истории
    const EVAL_WEEKS = 12;          // проверка — на последних неделях
    const DONE_KEY = 'krasavia_fclog_done';
    const DAY = 86400000;
    const NODES = [30, 21, 14, 10, 7, 5, 3, 1, 0];   // точки цепочки добора (0 — итог вылета)
    const CHAIN_TAU = 28;           // давность звена: вес e^(−возраст/τ), τ = 28 дней
    const CHAIN_K = 6;              // сжатие звена рейса к общему: (Σw·v + K·общее)/(Σw + K)
    const CHAIN_K_DOW = 4;          // сжатие звена «рейс × день недели» к звену рейса
    const COMMITTEE_ETA = 4;        // «резкость» весов комитета: w ∝ exp(−η·(L/L_min − 1))
    const COMMITTEE_K = 8;          // сжатие ошибки способа на рейсе к ошибке на всех рейсах
    const COMMITTEE_TRIM = 2;       // способ с ошибкой > 2× лучшего в комитет не входит
    const EB_K = 10;                // добор рейса (эмпирический Байес) как способ: сжатие к общему, K = 10
    const EB_K_FEAT = 20;           // он же как признак модели: K = 20
    // Линии с конкурентом (для разбивки точности и ранних предупреждений). since — с какой даты вылета.
    const COMPETITION = [{ cities: ['Красноярск', 'Горно-Алтайск'], who: 'S7', since: '01.01.2026' }];
    const WARN_KEY = 'krasavia_fc_warn';
    const WARN_DEFAULT = { under: 60, over: 95, days: 30 };
    const CONF_LEVEL = 0.8;         // интервал прогноза: 80% вылетов попадают внутрь (проверено на прошлых неделях)
    const CONF_MIN = 20;            // остатков в «банке», чтобы интервал показывался

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
    let logRev = 0;   // меняется при каждом изменении журнала — по нему запоминается подпись обучающих данных

    function mergeEntry(target, key, e) {
        const changed = mergeEntry0(target, key, e);
        if (changed && target === log) logRev++;
        return changed;
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
    let sigMemo = { rev: -1, v: '' };

    function trainSig() {
        if (sigMemo.rev === logRev) return sigMemo.v;
        const v = trainSig0();
        sigMemo = { rev: logRev, v };
        return v;
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
            // Архив продаж: окно обучения и те же месяцы год назад (способ «прошлый год»).
            const arch = [];
            for (let i = -(MONTHS_BACK + 13); i <= 0; i++) arch.push(shiftMonth(m0, i));
            const archP = typeof SalesArchive !== 'undefined' && SalesArchive.ensureMonths ? SalesArchive.ensureMonths(arch).catch(() => null) : Promise.resolve();
            loading = Promise.all(months.map(readMonth).concat([archP])).then(() => { loaded = true; ctxMemo.sig = ''; invalidate(); });
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
            const from = parseLocalDate('01.' + shiftMonth(monthOf(today()), -MONTHS_BACK).split('-').reverse().join('.'));
            SalesArchive.entries().forEach(({ date, code, e }) => {
                if (byKey[date + '|' + code] || !(e.s > 0) || !(e.sold > 0)) return;
                const t = parseLocalDate(date);
                if (!t || t.getTime() >= now || (from && t < from)) return;
                const base = typeof getBaseFlight === 'function' ? getBaseFlight(code) : code;
                if (byKey[date + '|' + base] && base === code) return;
                const dep = { base, date, ts: t.getTime(), row: null, rowCode: code, code, s: e.s, sold: e.sold, flown: true, arch: true, ac: e.ac || '' };
                (byBase[base] || (byBase[base] = [])).push(dep);
                byKey[date + '|' + code] = dep;
                if (!byKey[date + '|' + base]) byKey[date + '|' + base] = dep;
            });
        }
        Object.keys(byBase).forEach(b => byBase[b].sort((a, c) => a.ts - c.ts));
        ctxMemo = { sig, v: { byBase, byKey, now } };
        return ctxMemo.v;
    }

    function rawOf(dep) {
        if (!dep._raw) {
            dep._raw = (dep.arch ? SalesArchive.curveFor(dep.date, dep.code) : buildOnHandByDtd(dep.date, dep.code)) || { onHand: {}, maxDtd: 0, total: 0 };
        }
        return dep._raw;
    }

    function anchOf(dep) {
        if (!dep._anch) dep._anch = (dep.arch ? anchorCurveToLoad(rawOf(dep), dep.sold) : anchorCurveToLoad(departureCurve(dep.date, dep.code), dep.sold)) || rawOf(dep);
        return dep._anch;
    }

    // «Прошлый год»: тот же рейс в тот же день недели год назад (364 дня, иначе ±1 неделя) из архива продаж.
    //   добор год назад: π = (итог_пг − продано_пг за h дней) / кресла_пг;   f̂ = clamp(o + π·s, o, s)
    function lyPredict(code, base, ts, h, o, s) {
        if (typeof SalesArchive === 'undefined' || !SalesArchive.entryFor || !(s > 0)) return null;
        for (const back of [364, 357, 371]) {
            const ds = fmtDate(ts - back * DAY);
            let cd = code;
            let e = SalesArchive.entryFor(ds, cd);
            if (!e && base && base !== code) { cd = base; e = SalesArchive.entryFor(ds, cd); }
            if (!e || !(e.s > 0) || !(e.sold > 0)) continue;
            const cv = SalesArchive.curveFor(ds, cd);
            if (!cv) continue;
            const pick = Math.max(0, (e.sold - at(cv, h)) / e.s);
            return Math.max(o, Math.min(s, Math.round(o + pick * s)));
        }
        return null;
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
                const raw = rawOf(X);
                if (!(raw.total > 0)) return;
                const R = res.route[base] || (res.route[base] = mk());
                const dk = base + '|' + new Date(X.ts).getDay();
                const D = res.dow[dk] || (res.dow[dk] = mk());
                for (let i = 0; i < L; i++) {
                    const a = NODES[i];
                    const b = NODES[i + 1];
                    // Итог известен, когда вылет улетел (как и для обучения моделей); точка b — когда наступил день b.
                    const tb = b === 0 ? X.ts + DAY : X.ts - b * DAY;
                    if (tb > T) break;
                    const v = ((b === 0 ? X.sold : at(raw, b)) - at(raw, a)) / X.s;
                    const w = Math.exp(-(T - tb) / DAY / CHAIN_TAU);
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
            const r = R ? (R.sw[i] + CHAIN_K * g) / (R.w[i] + CHAIN_K) : g;
            pick += D ? (D.sw[i] + CHAIN_K_DOW * r) / (D.w[i] + CHAIN_K_DOW) : r;
        }
        return Math.max(o, Math.min(s, Math.round(o + pick * s)));
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
        ['Тип рейса и ВС', 2], ['Добор этого рейса (сглаж.)', 3]
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
        ].concat(calFeatures(smp.date), routeFeatures(smp.base, s), smp.eb || [0, 0, 0]);
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
        // Пороги — квантили признака; значения раскладываются по корзинам один раз на обучение
        // (номер корзины: v ≤ cuts[c] ⟺ корзина ≤ c), дальше деревья работают только с номерами корзин.
        const cuts = [];
        const bins = [];
        for (let f = 0; f < k; f++) {
            const vals = new Float64Array(n);
            for (let i = 0; i < n; i++) vals[i] = X[i][f];
            const sorted = vals.slice().sort();
            const set = new Set();
            for (let q = 1; q < GBM.bins; q++) set.add(sorted[Math.floor(q * (n - 1) / GBM.bins)]);
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
        const ws = { bs: new Float64Array(GBM.bins + 1), bn: new Int32Array(GBM.bins + 1) };
        let last = Date.now();
        for (let t = 0; t < GBM.rounds; t++) {
            for (let i = 0; i < n; i++) { const r = y[i] - pred[i]; res[i] = r > delta ? delta : (r < -delta ? -delta : r); }
            const tree = grow(bins, res, all, 0, cuts, gain, ws);
            trees.push(tree);
            for (let i = 0; i < n; i++) {
                let nd = tree;
                while (nd.v === undefined) nd = bins[nd.f][i] <= nd.c ? nd.l : nd.r;
                pred[i] += GBM.rate * nd.v;
            }
            if (Date.now() - last > 25) { await pause(); last = Date.now(); }
        }
        return { base, trees, gain };
    }

    // Узел: лучший порог по всем признакам (максимум G = S_L²/n_L + S_R²/n_R − S²/n).
    function grow(bins, res, idx, depth, cuts, gain, ws) {
        const nAll = idx.length;
        let total = 0;
        for (let j = 0; j < nAll; j++) total += res[idx[j]];
        const mean = total / nAll;
        if (depth >= GBM.depth || nAll < GBM.minLeaf * 2) return { v: mean };
        let best = null;
        const { bs, bn } = ws;
        for (let f = 0; f < cuts.length; f++) {
            const cs = cuts[f];
            if (!cs.length) continue;
            const bf = bins[f];
            bs.fill(0);
            bn.fill(0);
            for (let j = 0; j < nAll; j++) { const i = idx[j]; const b = bf[i]; bs[b] += res[i]; bn[b]++; }
            let ls = 0;
            let ln = 0;
            for (let c = 0; c < cs.length; c++) {
                ls += bs[c];
                ln += bn[c];
                const rn = nAll - ln;
                if (ln < GBM.minLeaf || rn < GBM.minLeaf) continue;
                const rs = total - ls;
                const g = ls * ls / ln + rs * rs / rn - total * total / nAll;
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
        return { f: best.f, c: best.c, thr: best.thr, l: grow(bins, res, L, depth + 1, cuts, gain, ws), r: grow(bins, res, R, depth + 1, cuts, gain, ws) };
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
        out.sort((a, b) => a.ts - b.ts || a.h - b.h || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        // Признак «добор этого рейса» — на день прогноза T = дата − h: только по вылетам, улетевшим до T
        // (своего итога строка не видит). Проход по строкам в порядке T, улетевшие добавляются по мере наступления.
        const acc = ebEmpty();
        const byT = out.slice().sort((a, b) => (a.ts - a.h * DAY) - (b.ts - b.h * DAY));
        let ptr = 0;
        byT.forEach(x => {
            const T = x.ts - x.h * DAY;
            while (ptr < out.length && out[ptr].ts + DAY <= T) ebAdd(acc, out[ptr++]);
            x.eb = ebFeature(acc, x.base, x.h);
        });
        while (ptr < out.length) ebAdd(acc, out[ptr++]);
        ebLive = acc;
        return out;
    }

    // Добор рейса, сглаженный к среднему по всем рейсам (эмпирический Байес):
    //   t̄ₕ = Σtₕ / nₕ (все рейсы),   t̂_рейс,h = (Σ_рейс tₕ + K·t̄ₕ) / (n_рейс + K)
    let ebLive = null;               // накопленное по всем улетевшим — для сегодняшних прогнозов

    function ebEmpty() {
        return { H: Object.create(null), R: Object.create(null) };
    }

    function ebAdd(acc, x) {
        const t = target(x);
        const H = acc.H[x.h] || (acc.H[x.h] = { s: 0, n: 0 });
        const R = acc.R[x.base + '|' + x.h] || (acc.R[x.base + '|' + x.h] = { s: 0, n: 0 });
        H.s += t; H.n++;
        R.s += t; R.n++;
    }

    function ebPick(acc, base, h, K) {
        const H = acc && acc.H[h];
        if (!H || H.n < 10) return null;
        const R = acc.R[base + '|' + h] || { s: 0, n: 0 };
        return { v: (R.s + K * H.s / H.n) / (R.n + K), n: R.n };
    }

    function ebFeature(acc, base, h) {
        const e = ebPick(acc, base, h, EB_K_FEAT);
        return e ? [e.v, 1, e.n / (e.n + EB_K_FEAT)] : [0, 0, 0];
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

    async function train(list) {
        if (list.length > TRAIN_MAX) {
            // Свежие недели — целиком, более старые — каждая m-я запись: в обучение попадают все сезоны истории.
            const recent = TRAIN_MAX / 2;
            const head = list.slice(0, list.length - recent);
            const step = head.length / (TRAIN_MAX - recent);
            const pick = [];
            for (let j = 0; j < TRAIN_MAX - recent; j++) pick.push(head[Math.floor(j * step)]);
            list = pick.concat(list.slice(list.length - recent));
        }
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
    function simple(k, r, s, pool, h, base) {
        const pp = r.p != null && r.q != null ? Math.max(r.o, Math.min(s, Math.round(r.o + r.p - r.q))) : null;
        const pl = pool && pool[h] != null ? Math.max(r.o, Math.min(s, Math.round(r.o + pool[h] * s))) : null;
        if (k === 'naive') return r.o;
        if (k === 'pool') return pl;
        if (k === 'planPick') return pp;
        if (k === 'plan') return r.p != null ? Math.min(s, r.p) : null;
        if (k === 'planOr') return r.p != null ? Math.max(r.o, Math.min(s, r.p)) : null;
        if (k === 'hist') return r.y;
        if (k === 'eb') {
            const e = pool && pool.eb && base ? ebPick(pool.eb, base, h, EB_K) : null;
            return e ? Math.max(r.o, Math.min(s, Math.round(r.o + e.v * s))) : null;
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
        const pick = ev.choice[h + '|' + segOf(r)] || ev.choice[h];
        if (!pick) return null;
        // Все способы на сейчас — для комитета и для показа, кто на этом рейсе весит больше.
        const T = dep.ts - d * DAY;
        const ml = models ? predictAll(models, { base, date, ts: dep.ts, h, s: r.s, r, eb: ebFeature(ebLive, base, h) }) : null;
        const one = (k) => {
            if (k === 'ens' || k === 'gbm' || k === 'lin') return ml ? ml[k] : null;
            if (k === 'chain') return chainPredict(T, base, dep.ts, h, r.o, r.s);
            if (k === 'ly') return lyPredict(dep.rowCode, base, dep.ts, h, r.o, r.s);
            return simple(k, r, r.s, ev.pool, h, base);
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
        const c = ev.conf && ev.conf[h + '|' + segOf(r)];
        if (final != null && c && c.k === usedK) {
            lo = Math.min(final, Math.max(0, Math.floor(final + c.lo * r.s)));
            hi = Math.max(final, Math.min(Math.max(r.s, r.o), Math.ceil(final + c.hi * r.s)));
        }
        if (final == null) final = r.o;
        const hiRaw = c && c.k === usedK ? Math.ceil(final + c.hi * r.s) : null;   // без ограничения креслами — спрос сверх ёмкости
        return { final, lo, hi, hiRaw, sold: r.o, d, plan: r.p, team, cover: lo != null ? Math.round(CONF_LEVEL * 100) : null, seats: r.s, lf: Math.round(final / r.s * 100), method: METHOD_LABEL[usedK], err: Math.round(pick.v * 10) / 10, trainedOn: pick.n, h };
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
            const o = at(raw, h);
            const hy = histAsOf(dep, h, T, o);
            const x = neighborFeatures(dep, h, T, false, o).map(v => Math.round(v * 1000) / 1000);
            e.h[h] = { d: h, o, p: num(p), q: planOk ? num(getExpectedLoad(cap, dep.base, h, wk)) : null, y: hy.y, n: hy.n || null, m: null, b: 1, bv: BACKFILL_V, s, x };
        });
        return e;
    }

    function dataToken() {
        const at0 = typeof lastSalesUpdate !== 'undefined' && lastSalesUpdate ? new Date(lastSalesUpdate).getTime() : 0;
        return `v4|${today()}|${at0}|${(typeof allData !== 'undefined' && allData ? allData.length : 0)}`;
    }

    async function capture(force) {
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
                    if (models) r.m = predictAll(models, { base, date: dep.date, ts: dep.ts, h, s: r.s, r, eb: ebFeature(ebLive, base, h) }).ens;
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
        const L = {};
        ks.forEach(k => {
            const g = G[k] || [0, 0];
            const b = B[k] || [0, 0];
            const lg = (g[0] + COMMITTEE_K * L0) / (g[1] + COMMITTEE_K);
            L[k] = (b[0] + COMMITTEE_K * lg) / (b[1] + COMMITTEE_K);
        });
        const lmin = Math.max(1e-4, Math.min(...ks.map(k => L[k])));
        const w = {};
        let sum = 0;
        ks.forEach(k => {
            if (L[k] > COMMITTEE_TRIM * lmin) return;
            w[k] = Math.exp(-COMMITTEE_ETA * (L[k] / lmin - 1));
            sum += w[k];
        });
        Object.keys(w).forEach(k => { w[k] /= sum; });
        return w;
    }

    function committeeBlend(w, vals, o, s) {
        if (!w) return null;
        let v = 0;
        Object.keys(w).forEach(k => { v += w[k] * vals[k]; });
        return Math.max(o, Math.min(s, Math.round(v)));
    }

    // Интервал прогноза (сплит-конформный, несимметричный). Для способа k, выбранного на горизонте h для сегмента,
    // «банк» честных остатков в долях кресел rᵢ = (fᵢ − f̂ₖᵢ)/sᵢ — только из проверки на прошлых неделях.
    // Границы — порядковые статистики: q_lo = r₍⌊(n+1)·0,1⌋₎, q_hi = r₍⌈(n+1)·0,9⌉₎ — гарантия покрытия ≥ 80% и при малом n.
    // Банк берётся с первого уровня, где остатков ≥ 20: (h, сегмент) → h → (группа горизонтов, сегмент) → группа → все.
    async function conformal(test, choice, val, tick) {
        const alpha = (1 - CONF_LEVEL) / 2;
        const out = {};
        const bank = (k, list) => list.map(x => { const v = val(k, x); return v == null ? null : (x.f - v) / x.s; }).filter(v => v != null);
        for (const h of HORIZONS) {
            const g = groupOf(h).id;
            if (tick) await tick();
            ['plan', 'hist', 'none'].forEach(sg => {
                const pick = choice[h + '|' + sg] || choice[h];
                if (!pick) return;
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
                    if (n < CONF_MIN) continue;
                    const iLo = Math.floor((n + 1) * alpha);
                    const iHi = Math.ceil((n + 1) * (1 - alpha));
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
        let lastModel = null;
        let lastLen = 0;
        for (const [cut, list] of [...byCut.entries()].sort((a, b) => a[0] - b[0])) {
            let len = 0;
            while (len < all.length && all[len].ts + DAY <= cut) len++;
            const pool = poolOf(all.slice(0, len));
            list.forEach(x => pools.set(x, pool));
            if (len < MIN_TRAIN) continue;
            // Новая модель — только когда данных прибавилось на 15%; иначе прежняя (она знает меньше — проверка остаётся честной).
            let m = lastModel;
            if (!lastModel || len >= lastLen * 1.15) { m = await cachedTrain(all, len, cum); lastModel = m; lastLen = len; }
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
        const base0 = (k, x) => (k === 'lin' || k === 'gbm' || k === 'ens' ? (pred.has(x) ? pred.get(x)[k] : null)
            : (k === 'chain' ? (chainPred.has(x) ? chainPred.get(x) : null)
                : (k === 'ly' ? lyPredict(x.key.slice(x.key.lastIndexOf('|') + 1), x.base, x.ts, x.h, x.r.o, x.s) : simple(k, x.r, x.s, pools.get(x), x.h, x.base))));
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
            const base = common.length >= MIN_CHOICE ? common : hl;
            byH[h] = { total: hl.length, common: common.length, simpleOnly: common.length < MIN_CHOICE };
            kinds.forEach(k => { byH[h][k] = stat(k, base); });
        });
        await tick();
        // Выбор по горизонту и сегменту, с устойчивостью к шуму.
        const prev = loadChoicePrev();
        const choice = {};
        const decide = (key, list) => {
            const withModel = list.filter(x => pred.has(x));
            const base = withModel.length >= MIN_CHOICE_SEG ? withModel : list;
            const cands = (withModel.length >= MIN_CHOICE_SEG ? ['ens', 'gbm', 'lin'] : []).concat(['blend', 'chain', 'eb', 'ly', 'planOr', 'planPick', 'hist', 'pool', 'naive']);
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
        for (const h of HORIZONS) {
            await tick();
            const hl = test.filter(x => x.h === h);
            choice[h] = decide(String(h), hl);
            ['plan', 'hist', 'none'].forEach(sg => {
                const sl = hl.filter(x => segOf(x.r) === sg);
                if (sl.length >= MIN_CHOICE_SEG) choice[h + '|' + sg] = decide(h + '|' + sg, sl);
            });
        }
        saveChoice(choice);
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
            const base = common.length >= MIN_CHOICE ? common : hl;
            const c = { sum: 0, bias: 0, n: 0, f: 0 };
            base.forEach(x => { const v = chosenVal(x); if (v == null) return; c.sum += Math.abs(v - x.f); c.bias += v - x.f; c.f += x.f; c.n++; });
            byH[h].best = c;
        });
        await tick();
        const conf = await conformal(test, choice, val, tick);
        // Честное покрытие интервала: для вылета — банк остатков только по вылетам, улетевшим до недели прогноза
        // (уровень «группа горизонтов × сегмент × способ», n ≥ 20). Считается, сколько фактов попало внутрь.
        const alpha = (1 - CONF_LEVEL) / 2;
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
                const bk = committeeKey(y.h, y.r) + '|' + pk.k;
                (banks.get(bk) || banks.set(bk, []).get(bk)).push((y.f - v) / y.s);
            }
            byCut.get(cut).forEach(x => {
                const pk = choice[x.h + '|' + segOf(x.r)] || choice[x.h];
                const v = pk ? val(pk.k, x) : null;
                const r = pk && v != null ? sortedOf(committeeKey(x.h, x.r) + '|' + pk.k) : null;
                if (!r || r.length < CONF_MIN) return;
                const n = r.length;
                const lo = Math.max(0, Math.floor(v + r[Math.max(0, Math.floor((n + 1) * alpha) - 1)] * x.s));
                const hi = Math.min(Math.max(x.s, x.r.o), Math.ceil(v + r[Math.min(n - 1, Math.ceil((n + 1) * (1 - alpha)) - 1)] * x.s));
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
                ['Без файла ожидаемой', x => segOf(x.r) !== 'plan']
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
        return { full, pool: poolOf(all), committee, cover, groups, signals, byH, byWeek, byBase, choice, conf, influence, segCount, samples: all.length, departures: new Set(all.map(x => x.key)).size, trained: !!full, anyModel };
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

    // ---------- ранние предупреждения ----------
    // Для всех будущих вылетов в горизонте N дней: прогноз (P50) и интервал 80% (P10–P90) выбранным способом.
    //   недобор:  P50/s < порога (60%);   перегруз / упущенная выручка:  P50/s ≥ 95% или (P90 без ограничения > s и P50/s ≥ 90%);
    //   аномальный темп:  z = (o/s − m)/max(σ, 0,05),  |z| ≥ 2 и |o − m·s| ≥ 3 пасс., где m, σ — доля проданных к этому дню
    //   у вылетов того же рейса в тот же день недели за 8 недель (день уже наступил к моменту среза).
    //   Срочность: тяжесть / √(дней до вылета) — чем ближе вылет и сильнее отклонение, тем выше в списке.
    function warnSettings() {
        try { return Object.assign({}, WARN_DEFAULT, JSON.parse(localStorage.getItem(WARN_KEY) || '{}') || {}); } catch (e) { return Object.assign({}, WARN_DEFAULT); }
    }

    function paceNorm(dep, d, T) {
        const dow = new Date(dep.ts).getDay();
        const vals = [];
        datesOf(dep.base).forEach(D => {
            if (D.date === dep.date || !(D.s > 0) || new Date(D.ts).getDay() !== dow) return;
            if (D.ts - d * DAY > T || dep.ts - D.ts > 56 * DAY || D.ts > dep.ts + 56 * DAY) return;
            vals.push(D.deps.reduce((a, X) => a + at(rawOf(X), d), 0) / D.s);
        });
        if (vals.length < 3) return null;
        const m = vals.reduce((a, b) => a + b, 0) / vals.length;
        const sd = Math.sqrt(vals.reduce((a, b) => a + (b - m) * (b - m), 0) / (vals.length - 1));
        return { m, sd, n: vals.length };
    }

    const CAPS = [46, 72, 120];

    let warnMemo = { sig: '', list: null };
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
            const z = pace ? (p.sold / s - pace.m) / Math.max(pace.sd, 0.05) : 0;
            const paceGap = pace ? Math.round(p.sold - pace.m * s) : 0;
            const flags = [];
            if (lf * 100 < cfg.under) flags.push({ kind: 'under', sev: (cfg.under / 100 - lf) * 10 });
            if (lf * 100 >= cfg.over || (p.hiRaw != null && p.hiRaw > s && lf * 100 >= cfg.over - 5)) flags.push({ kind: 'over', sev: Math.max(lf - cfg.over / 100, 0) * 10 + (p.hiRaw != null && p.hiRaw > s ? (p.hiRaw - s) / s * 5 : 0) + 0.2 });
            if (pace && Math.abs(z) >= 2 && Math.abs(paceGap) >= 3) flags.push({ kind: z > 0 ? 'fast' : 'slow', sev: Math.min(Math.abs(z), 6) / 4 });
            if (!flags.length) continue;
            // Причины — что сильнее всего тянет прогноз.
            const why = [];
            if (pace) why.push(`продано ${p.sold}, обычно к этому дню ${Math.round(pace.m * s)} (${paceGap >= 0 ? '+' : '−'}${Math.abs(paceGap)})`);
            if (p.plan != null) why.push(`файл ожидаемой: ${Math.round(p.plan)}`);
            if (p.team && p.team[0] && p.team[0].w >= 35) why.push(`на этом рейсе точнее всего: ${p.team[0].label} (${p.team[0].w}%)`);
            const comp = competitorOf(base, dep.ts);
            if (comp) why.push(`на линии ${comp}`);
            const ev2 = typeof CalendarEvents !== 'undefined' && CalendarEvents.on ? CalendarEvents.on(dep.date).map(e => e.title || e.name || e.type).filter(Boolean) : [];
            if (ev2.length) why.push(`календарь: ${ev2.slice(0, 2).join(', ')}`);
            if (!why.length) why.push(`прогноз: ${p.method}, обычно ошибается на ±${String(p.err).replace('.', ',')} пасс.`);
            // Что сделать.
            const act = [];
            const hiTop = p.hi != null ? p.hi : p.final;
            const cap = getCapacityFromAircraft(getAircraftType(dep.row[4])) || s;   // ёмкость ВС (в продаже может быть меньше)
            flags.forEach(g => {
                if (g.kind === 'under') {
                    act.push('снизить цену / открыть дешёвые классы');
                    const smaller = CAPS.filter(c => c < cap - 4 && c >= hiTop).pop();
                    if (smaller && dtd >= 5) act.push(`ВС на ${smaller} кресел вместит даже верхнюю оценку (${hiTop})`);
                }
                if (g.kind === 'over') {
                    act.push('поднять цену / закрыть дешёвые классы');
                    if (p.hiRaw != null && p.hiRaw > s) {
                        if (cap > s + 1) act.push(`в продаже ${s} из ${cap} кресел — если нет ограничений по взлётной массе, открыть ещё (спрос до ~${p.hiRaw})`);
                        else {
                            const bigger = CAPS.find(c => c > cap + 4);
                            if (bigger) act.push(`спрос до ~${p.hiRaw} — рассмотреть ВС на ${bigger}`);
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
        const rows = list.slice(0, 60).map(w => `<tr>
                <td class="rp-left"><strong>${esc(w.code)}</strong> <span class="rp-muted">${esc(w.dir)}</span></td>
                <td>${esc(w.date)}<div class="rp-muted">через ${w.dtd} дн.</div></td>
                <td class="rp-left">${w.kinds.map(k => `<span class="fl-warn fl-warn-${k}">${esc(WARN_LABEL[k])}</span>`).join(' ')}</td>
                <td>${w.sold} <span class="rp-muted">из ${w.s}</span></td>
                <td><strong>${w.final}</strong> <span class="rp-muted">· ${w.lf}%</span>${w.lo != null ? `<div class="rp-muted">${w.lo}–${w.hi}${w.hiRaw > w.s ? ` (спрос до ${w.hiRaw})` : ''}</div>` : ''}</td>
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
                <button type="button" class="btn-primary rp-btn" id="fl-w-xlsx"${list.length ? '' : ' disabled'}>В Excel</button>
            </div>
            <div class="dr-kpis">
                <div class="dr-kpi"><div class="dr-kpi-label">Риск недобора</div><div class="dr-kpi-value">${counts.under}</div></div>
                <div class="dr-kpi"><div class="dr-kpi-label">Риск перегруза</div><div class="dr-kpi-value">${counts.over}</div></div>
                <div class="dr-kpi"><div class="dr-kpi-label">Необычный темп продаж</div><div class="dr-kpi-value">${counts.fast + counts.slow}</div><div class="dr-kpi-sub">выше: ${counts.fast} · ниже: ${counts.slow}</div></div>
            </div>
            ${rows ? `<div class="rp-scroll"><table class="rp-table"><thead><tr><th>Рейс</th><th>Вылет</th><th>Сигнал</th><th>Продано</th><th>Прогноз · интервал</th><th>Почему</th><th>Что сделать</th></tr></thead><tbody>${rows}</tbody></table></div>
                ${list.length > 60 ? `<p class="rp-note">Показаны 60 самых срочных из ${list.length} — полный список в Excel.</p>` : ''}` : '<p class="rp-note">Сигналов нет.</p>'}
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
            ? `В архиве ${st.n.toLocaleString('ru-RU')} улетевших вылетов: с ${d(st.from)} по ${d(st.to)}${st.h ? `, из файла истории — ${st.h.toLocaleString('ru-RU')}` : ''}.`
            : 'Архив пока пустой: модель видит только вылеты из текущего файла продаж (около 2 недель).';
        return `<section class="rp-card">
            <div class="rp-card-head"><h3 class="rp-card-title">История продаж для прогноза</h3></div>
            <p class="rp-card-text">Файл <strong>SalesHistory.csv</strong> из скрипта <strong>Export-SalesHistory.ps1</strong> — улетевшие вылеты за прошлые месяцы и годы,
                уже сведённые по вылетам, без ФИО, PNR и контактов. На них модель учится, по ним считаются «прошлый год» и норма продаж по дням недели.
                Кресла прошлых вылетов в продажах не записаны — берутся по нынешнему самолёту рейса. Загружать можно повторно: история заменяется,
                вылеты из текущих данных не трогаются.</p>
            <p class="rp-note">${esc(status)}</p>
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
                const r = await SalesArchive.importHistory(text);
                if (!r.ok) { toast('История не загружена: ' + (r.error || 'ошибка записи'), 'error'); return; }
                toast(`История загружена: ${r.flights.toLocaleString('ru-RU')} вылетов за ${r.months} мес.${r.skipped ? `, пропущено строк: ${r.skipped}` : ''}`);
                ctxMemo.sig = '';
                invalidate();
                // Восстановить журнал по новым вылетам и переобучить модель — в фоне.
                capture(true).then(() => startEvaluation(rerender)).catch(e => console.warn(e));
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

    async function exportWarnings() {
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
        const mae = (k, h) => { const c = ev.byH[h] && ev.byH[h][k]; return c && c.n >= MIN_CHOICE ? c.sum / c.n : null; };
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
        const cell = (c) => (c && c.n ? `${fmt(c.sum / c.n)}<div class="rp-muted">WAPE ${c.f ? Math.round(c.sum / c.f * 100) : '—'}% · ${c.bias > 0 ? '↑' : '↓'}${fmt(Math.abs(c.bias / c.n))}</div>` : '—');
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
            <details class="fl-math"><summary>Что проверили и пока не взяли</summary>
                <p class="rp-muted">Каждый способ проверялся так же честно — на прошлых неделях, по вылетам, которые к моменту прогноза ещё не улетели.</p>
                <ul class="fl-tested">
                    <li><b>Мультипликативный добор</b> (итог = продано × коэффициент) — хуже аддитивного на 1–2 пасс. за 5–10 дней: при малых продажах коэффициент «взрывается». Как и в исследованиях RMS (круизы, отели), аддитивный точнее.</li>
                    <li><b>Восстановление спроса распроданных рейсов</b> (unconstraining) — точность не выросла: прогноз и так не больше кресел. Вернёмся, когда понадобится прогноз спроса сверх ёмкости.</li>
                    <li><b>Подбор весов моделей по МНК (stacking)</b> — выигрыш в пределах шума на нынешних 3 неделях; комитет с весами по ошибкам надёжнее на малых данных («загадка комбинирования прогнозов»: простые веса часто не хуже сложных).</li>
                    <li><b>Больший вес свежим неделям</b> — эффект в пределах шума, пока журнал короче 2 месяцев.</li>
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
            ${f('<i>ℓ</i><sub>a→b</sub> = Σ<i>w</i>·(<i>o<sub>b</sub></i> − <i>o<sub>a</sub></i>)/<i>s</i> ⁄ Σ<i>w</i>, &nbsp; <i>w</i> = e<sup>−возраст/28</sup>, &nbsp; <i>f̂</i> = <i>o<sub>h</sub></i> + <i>s</i>·Σ<i>ℓ</i>', '«Цепочка добора» (advanced pickup, как в RMS авиакомпаний): добор между соседними точками 30→21→…→1→вылет считается и по ещё не улетевшим рейсам, свежие недели весят больше. Для рейса и дня недели звено сглаживается к общему.')}
            ${f('<i>t̂</i><sub>рейс</sub> = (Σ<i>t</i><sub>рейс</sub> + 10·<i>t̄</i>) / (<i>n</i><sub>рейс</sub> + 10)', '«Добор этого рейса»: средний добор рейса, подтянутый к среднему всех рейсов, пока вылетов мало (эмпирический Байес). Он же — признак для моделей.')}
            ${f('<i>w<sub>k</sub></i> ∝ exp(−4·(<i>L<sub>k</sub></i>/<i>L</i><sub>min</sub> − 1)), &nbsp; <i>L</i><sub>рейс</sub> = (Σ|<i>e</i>| + 8·<i>L</i><sub>все</sub>) / (<i>n</i> + 8)', '«Комитет моделей»: все способы считают прогноз, вес каждого — по его ошибкам именно на этом рейсе (пока вылетов мало — по всем рейсам). Лучший на рейсе весит больше, остальные страхуют; способ с ошибкой больше двух лучших не голосует.')}
            ${f('<i>ŵ</i> = (<i>X</i><sup>T</sup><i>X</i> + λ<i>I</i>)<sup>−1</sup><i>X</i><sup>T</sup><i>t</i>, &nbsp; λ = 0,8', 'Линейная модель (гребневая регрессия) по 34 признакам: штраф λ не даёт весам раздуваться на малых данных. Своя модель на каждом горизонте, когда записей ≥ 80.')}
            ${f('<i>F<sub>m</sub></i> = <i>F</i><sub><i>m</i>−1</sub> + η·<i>h<sub>m</sub></i>, &nbsp; <i>r</i> = clip(<i>t</i> − <i>F</i>, −δ, δ), &nbsp; η = 0,08, <i>M</i> = 120', 'Решающие деревья (градиентный бустинг): каждое следующее дерево исправляет ошибки предыдущих. Ошибка обрезается на δ (потери Хьюбера) — группы и отмены не сбивают модель.')}
            ${f('<i>t̂</i> = ½(<i>t̂</i><sub>лин</sub> + <i>t̂</i><sub>дер</sub>) + <i>c</i><sub>рейс</sub>, &nbsp; <i>c</i><sub>рейс</sub> = <i>n</i>/(<i>n</i> + 10) · средний остаток рейса', 'Среднее двух моделей и поправка по рейсу: при малом числе вылетов поправка почти ноль, при большом — равна средней ошибке рейса.')}
            ${f('[<i>f̂</i> + <i>q</i><sub>0,1</sub>·<i>s</i>; &nbsp;<i>f̂</i> + <i>q</i><sub>0,9</sub>·<i>s</i>], &nbsp; <i>q</i> — квантили остатков (<i>f</i> − <i>f̂</i>)/<i>s</i> прошлых прогнозов', 'Интервал 80% (конформный): по тому, как этот же способ ошибался раньше на таком же горизонте и таких же вылетах. Несимметричный — вниз и вверх ошибаются по-разному. В карточке: «44 из 72 (40–47, 80%)».')}
            ${f('недобор: P50/<i>s</i> &lt; 60%; &nbsp; перегруз: P50/<i>s</i> ≥ 95% или (P90 &gt; <i>s</i> и P50/<i>s</i> ≥ 90%); &nbsp; темп: |<i>z</i>| ≥ 2, <i>z</i> = (<i>o</i>/<i>s</i> − <i>m</i>)/σ', 'Ранние предупреждения. P50 — прогноз, P10–P90 — интервал 80%; <i>m</i> и σ — сколько обычно продано к этому дню у того же рейса в тот же день недели. Срочность = сила отклонения / √дней до вылета. Пороги меняются в отчёте.')}
            ${f('WAPE = Σ|<i>f̂</i> − <i>f</i>| / Σ<i>f</i>', 'Ошибка в процентах от всех перевезённых пассажиров — не «взрывается» на рейсах с малой загрузкой, в отличие от MAPE.')}
            ${f('обучение: вылеты с датой ≤ понедельник(дата − <i>h</i>) − 1 день', 'Честная проверка: прогноз за <i>h</i> дней модель делает, зная только вылеты, улетевшие к тому моменту.')}
            ${f('MAE = (1/<i>N</i>)·Σ|<i>f̂</i> − <i>f</i>|, &nbsp; смещение = (1/<i>N</i>)·Σ(<i>f̂</i> − <i>f</i>)', 'Средняя ошибка в пассажирах и в какую сторону ошибается (↑ завышает, ↓ занижает).')}
            ${f('<i>t</i> = −<i>d̄</i> / (<i>s<sub>d</sub></i>/√<i>n</i>) &gt; 1, &nbsp; <i>d<sub>i</sub></i> = |<i>e</i><sub>новый</sub>| − |<i>e</i><sub>прежний</sub>|', 'Способ меняется, только если новый надёжно точнее на тех же вылетах, а не случайно.')}
        </details>`;
    }

    function html(rerender) {
        if (!canView()) return '<p class="rp-note">Раздел доступен по праву «Прогноз загрузки и предупреждения» (выдаёт администратор в «Профилях»).</p>';
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
            return `<strong>±${fmt(b.sum / b.n)}</strong> <span class="rp-muted">· WAPE ${pct(b.f ? b.sum / b.f : null)} · ${b.bias > 0 ? '↑' : '↓'}${fmt(Math.abs(b.bias / b.n))}</span>`
                + (C && C.n ? `<div class="rp-muted" title="Интервал строится только по вылетам, улетевшим до недели прогноза">в интервал 80% попало ${pct(C.in / C.n)} из ${C.n}, ширина ≈ ${fmt(C.width / C.n)}</div>` : '<div class="rp-muted">покрытие проверить пока не на чем</div>');
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
            }).join('')}<td class="rp-left">${choiceCell(h)}${B.simpleOnly ? '<div class="rp-muted">модель проверить пока не на чем</div>' : ''}</td><td class="rp-left">${totalCell(h)}</td></tr>`;
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
        return `${warnHtml(rerender)}
            <section class="rp-card">
                <div class="rp-card-head"><h3 class="rp-card-title">Точность прогноза загрузки</h3></div>
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
                <div class="dr-list-title">Насколько ошибается прогноз, пасс. (меньше — лучше)</div>
                ${chartHtml(ev)}
                <div class="dr-list-title">Ошибка по горизонтам, пасс.</div>
                <div class="rp-scroll"><table class="rp-table">
                    <thead><tr><th>До вылета</th>${cols.map(([, l]) => `<th>${esc(l)}</th>`).join('')}<th title="Этот способ показывается в карточке рейса">Что берём</th><th>Итог: ошибка, WAPE, интервал</th></tr></thead>
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
                ${groupsHtml(ev)}
                ${mathHtml()}
                ${canWrite() ? `<div class="ref-toolbar"><button type="button" class="btn-secondary rp-btn" id="fl-capture">Записать прогнозы сейчас</button>
                    <span class="rp-muted">Обычно это происходит само раз в день при входе администратора.</span></div>` : ''}
            </section>
            ${historyHtml()}`;
    }

    function handleClick(btn, rerender) {
        if (btn.id === 'fl-w-apply') {
            const num = (id, lo, hi, def) => { const v = parseInt(document.getElementById(id) && document.getElementById(id).value, 10); return isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def; };
            const cfg = { under: num('fl-w-under', 10, 95, WARN_DEFAULT.under), over: num('fl-w-over', 50, 100, WARN_DEFAULT.over), days: num('fl-w-days', 3, 30, WARN_DEFAULT.days) };
            try { localStorage.setItem(WARN_KEY, JSON.stringify(cfg)); } catch (e) { /* ignore */ }
            rerender();
            return true;
        }
        if (btn.id === 'fl-w-xlsx') { exportWarnings().catch(e => console.warn(e)); return true; }
        if (btn.id === 'fl-hist-load') { if (canWrite()) loadHistory(rerender); return true; }
        if (btn.id !== 'fl-capture') return false;
        btn.disabled = true;
        capture(true).then(ok => {
            if (typeof showToast === 'function') showToast(ok ? 'Прогнозы записаны в журнал' : 'Не удалось записать журнал (нет доступа к общей папке?)', ok ? undefined : 'error');
            rerender();
        }).catch(e => { console.warn(e); btn.disabled = false; });
        return true;
    }

    return { canView, html, handleClick, capture, afterStart, ensureLoaded, predict, warnings, warningsAsync, revision: () => rev, HORIZONS, evaluation: () => evalState.ev, startEvaluation };
})();
