// Одно правило «вылет требует внимания» — для всего сайта.
// Это то, что RMS считает предупреждением: «Срочно» (уровень 3) и «Присмотреться» (уровень 2) из computeRowMetrics (metrics.js);
// пороги — из «Параметров расчётов» (раздел «Сигналы RMS»). Горизонт один: HORIZON дней вперёд, как в шапке сайта.
// Отсюда берут число и список: значок «Внимание» в шапке, RMS, «Сегодня», фильтры «Внимание» на вкладках с таблицами.
// Совет «Снизить / Повысить цену» (SalesAdvice) и сигналы моделей («Модели») — другое, сюда не входят.
window.Attention = (function () {
    const HORIZON = 30;

    // 3 — срочно, 2 — присмотреться, 0 — внимания не требует.
    function level(m) {
        if (!m || m.closed || m.flew || m.dtd == null || m.dtd < 0 || m.dtd >= HORIZON) return 0;
        return m.alertLevel >= 3 ? 3 : (m.alertLevel >= 2 ? 2 : 0);
    }
    function is(m) { return level(m) >= 2; }

    // Список считается один раз на эпоху данных: ключ — сам кэш метрик (он пересоздаётся при любой смене данных и порогов).
    let memo = { cache: null, list: [], keys: new Set() };
    function build() {
        const cache = typeof buildMetricsCache === 'function' ? buildMetricsCache() : null;
        if (!cache) return memo;
        if (memo.cache === cache) return memo;
        const list = getAllUpcomingFlights(HORIZON).filter(is);
        memo = { cache, list, keys: new Set(list.map(m => m.orig + '|' + m.date)) };
        return memo;
    }

    // Все вылеты, требующие внимания, в порядке RMS (по деньгам, потом по близости вылета).
    function list() { return build().list; }
    function count() { return build().list.length; }
    function has(code, date) { return build().keys.has(code + '|' + date); }

    return { HORIZON, level, is, list, count, has };
})();
