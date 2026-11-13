// одно правило 'вылет требует внимания' для всего сайта: то, что RMS считает предупреждением
// срочно (3) и присмотреться (2) из computeRowMetrics (metrics.js); пороги в Параметрах расчётов, Сигналы RMS
// горизонт HORIZON дней, как в шапке; совет цены (SalesAdvice) и сигналы Модели сюда не входят
window.Attention = (function () {
    const HORIZON = 30;

    // 3 срочно, 2 присмотреться, 0 внимания не требует
    function level(m) {
        if (!m || m.closed || m.flew || m.dtd == null || m.dtd < 0 || m.dtd >= HORIZON) return 0;
        return m.alertLevel >= 3 ? 3 : (m.alertLevel >= 2 ? 2 : 0);
    }
    function is(m) { return level(m) >= 2; }

    // список один раз на эпоху данных; ключ - сам кэш метрик (пересоздаётся при смене данных и порогов)
    let memo = { cache: null, list: [], keys: new Set() };
    function build() {
        const cache = typeof buildMetricsCache === 'function' ? buildMetricsCache() : null;
        if (!cache) return memo;
        if (memo.cache === cache) return memo;
        const list = getAllUpcomingFlights(HORIZON).filter(is);
        memo = { cache, list, keys: new Set(list.map(m => m.orig + '|' + m.date)) };
        return memo;
    }

    // в порядке RMS: по деньгам, потом по близости вылета
    function list() { return build().list; }
    function count() { return build().list.length; }
    function has(code, date) { return build().keys.has(code + '|' + date); }

    return { HORIZON, level, is, list, count, has };
})();
