// Модель рейса: допустимые номера, направление, базовый номер.
// Globals on purpose: no bundler; onclick and other files call by name.

function isValidFlightBase(base) {
    if (typeof Security !== 'undefined' && Security.isFlightBase) {
        return Security.isFlightBase(base);
    }
    return typeof base === 'string' && /^KV-\d{1,6}$/.test(base.trim());
}

function getValidFlightBases() {
    return Object.keys(groupedData).filter(isValidFlightBase).sort();
}

function getFlightDirection(f) {
    const code = cleanFlight(f);
    const dirs = window.FLIGHT_DIRECTIONS || {};
    if (dirs[code]) return dirs[code];
    const base = getBaseFlight(code);
    if (dirs[base]) return dirs[base];
    return `Рейс ${code}`;
}

function getBaseFlight(f) {
    return PerfCache.getBaseFlightMemo(f);
}
