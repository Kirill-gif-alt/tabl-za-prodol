// js\flight-model.js - extracted from script.js, logic unchanged.
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
    if (typeof PerfCache !== 'undefined') return PerfCache.getBaseFlightMemo(f);
    if (window.FLIGHT_EXTRA_BASE && window.FLIGHT_EXTRA_BASE[f]) return window.FLIGHT_EXTRA_BASE[f];
    let n = parseInt(String(f).replace('KV-', ''), 10) || 0;
    if ([151, 351, 355, 455].includes(n)) return 'KV-155';
    if ([152, 352, 356, 456].includes(n)) return 'KV-156';
    if (n === 261) return 'KV-161';
    if (n === 262) return 'KV-162';
    if (n === 253) return 'KV-153';
    if (n === 254) return 'KV-154';
    if (n === 273) return 'KV-173';
    if (n === 274) return 'KV-174';
    if (n === 325) return 'KV-225';
    if (n === 326) return 'KV-226';
    if (n === 347) return 'KV-247';
    if (n === 348) return 'KV-248';
    if (n >= 300 && n <= 399) return 'KV-' + (n - 200);
    if (n >= 400 && n <= 499) return 'KV-' + (n - 300);
    return f;
}
