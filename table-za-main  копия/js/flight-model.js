// модель рейса: допустимые номера, направление, базовый номер
// глобальные специально, без сборщика; onclick и другие файлы зовут по имени

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
