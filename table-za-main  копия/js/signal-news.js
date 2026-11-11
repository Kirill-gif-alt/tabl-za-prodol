// Метка «новое»: сигнал появился сегодня, а в прошлый раз (в последний прошлый день работы) его не было.
// Сигналы: «требует внимания» (attention.js) и совет «Снизить / Повысить цену» (SalesAdvice, считает вкладка «Сегодня»).
// Общей папки с дневным снимком сигналов на сайте нет (daylog — это продажи, не сигналы), поэтому снимок хранится в браузере:
// localStorage, ключ KEY, по дате; держим 3 последних дня. На каждом компьютере свой; в первый день работы и без localStorage меток нет.
// Вылет, который вчера ещё не попадал в окно подсчёта (окно сдвинулось), «новым» не считается — иначе метка была бы ложной.
window.SignalNews = (function () {
    const KEY = 'krasavia_signal_days_v1';
    const KEEP = 3;

    let advice = [];        // сегодняшние советы up/down: [{ code, date, status, dtd }]
    let adviceAhead = 0;    // на сколько дней вперёд они посчитаны (0 — не считались)
    let lastSaved = '';
    let memo = { al: null, sig: '', set: new Set(), base: false };
    let rev = 0;

    function today() { return typeof getTodayDate === 'function' ? getTodayDate() : ''; }

    function load() {
        try {
            const o = JSON.parse(localStorage.getItem(KEY) || '{}');
            return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
        } catch (e) { return {}; }
    }

    function dayNum(dateStr) {
        const d = typeof parseLocalDate === 'function' ? parseLocalDate(dateStr) : null;
        return d ? Math.round(d.getTime() / 86400000) : null;
    }

    // Последний снимок за день ДО сегодняшнего: { d, gap, a: Set, s: Set, h } или null.
    function baseline() {
        const t = dayNum(today());
        if (t == null) return null;
        const all = load();
        let best = null;
        Object.keys(all).forEach(d => {
            const n = dayNum(d);
            if (n != null && n < t && (!best || n > best.n)) best = { n, d };
        });
        if (!best) return null;
        const e = all[best.d] || {};
        return { d: best.d, gap: t - best.n, a: new Set(e.a || []), s: new Set(e.s || []), h: e.h || {} };
    }

    // Принять сегодняшние советы от «Сегодня» (ahead — окно дней; 0, если подсказки выключены или недоступны).
    function setAdvice(list, ahead) {
        advice = (list || []).filter(a => a && (a.status === 'up' || a.status === 'down'));
        adviceAhead = ahead || 0;
        rev++;
    }

    // Новые за сегодня: Set «рейс|дата». Пересчёт — только когда сменились сигналы или день.
    function fresh() {
        const al = typeof Attention !== 'undefined' ? Attention.list() : [];
        const sig = rev + '|' + today() + '|' + (typeof dataEpoch === 'number' ? dataEpoch : 0);
        if (memo.al === al && memo.sig === sig) return memo;
        const base = baseline();
        const set = new Set();
        if (base) {
            const ha = base.h.a || 0;
            const hs = base.h.s || 0;
            al.forEach(m => {
                if (m.dtd + base.gap <= ha - 1 && !base.a.has(m.orig + '|' + m.date + '|attn')) set.add(m.orig + '|' + m.date);
            });
            advice.forEach(a => {
                if (a.dtd != null && a.dtd + base.gap <= hs && !base.s.has(a.code + '|' + a.date + '|' + a.status)) set.add(a.code + '|' + a.date);
            });
        }
        memo = { al, sig, set, base: !!base };
        return memo;
    }

    function isNew(code, date) { return fresh().set.has(code + '|' + date); }
    function hasBaseline() { return fresh().base; }
    function revision() { const m = fresh(); return m.sig + '|' + m.set.size; }

    // Записать снимок за сегодня (перезаписывает сегодняшний, прошлые дни не трогает). Зовёт «Сегодня», когда всё посчитано.
    function record() {
        try {
            if (typeof Attention === 'undefined' || !today()) return;
            const all = load();
            const entry = {
                a: Attention.list().map(m => m.orig + '|' + m.date + '|attn'),
                s: advice.map(a => a.code + '|' + a.date + '|' + a.status),
                h: { a: Attention.HORIZON, s: adviceAhead }
            };
            all[today()] = entry;
            const days = Object.keys(all).sort((x, y) => (dayNum(y) || 0) - (dayNum(x) || 0)).slice(0, KEEP);
            const out = {};
            days.forEach(d => { out[d] = all[d]; });
            const str = JSON.stringify(out);
            if (str === lastSaved) return;
            localStorage.setItem(KEY, str);
            lastSaved = str;
        } catch (e) { /* localStorage недоступен — меток просто не будет */ }
    }

    return { setAdvice, isNew, hasBaseline, revision, record };
})();
