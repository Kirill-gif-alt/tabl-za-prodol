// Справочник багажа из Весовые.xlsx и расчёт ПКЗ (кг)
let baggageWeightsData = {};
/** key: "dd.mm.yyyy|KV-101" → count of children ages 2–12 from Дети.csv */
let childrenByFlightDate = {};

// Старый формат: A/B — города, D–O — багаж по месяцам (янв–дек)
const BAGGAGE_MONTH_COL_DO = { 1: 3, 2: 4, 3: 5, 4: 6, 5: 7, 6: 8, 7: 9, 8: 10, 9: 11, 10: 12, 11: 13, 12: 14 };
// Актуальный формат (Весовые.о): A — «Красноярск-Байкит», B–M — багаж (1–12)
const BAGGAGE_MONTH_COL_BM = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10, 11: 11, 12: 12 };
const BAGGAGE_HUB = 'Красноярск';
const ADULT_WEIGHT_SUMMER = 75;
const ADULT_WEIGHT_WINTER = 80;
/** Дети 2–12 лет — 30 кг (без багажа по ТЗ — только 30) */
const CHILD_WEIGHT_FIXED_KG = 30;
const PKZ_HORIZON_DAYS = 10;
const CHILD_AGE_MIN = 2;
const CHILD_AGE_MAX = 12;

const BAGGAGE_SECTION_MARKERS = new Set([
    'краевые',
    'межрегиональныерейсы',
    'межрегиональные рейсы',
    'межрегиональные'
]);

function canonicalCityForBaggage(name) {
    let c = typeof canonicalCityName === 'function' ? canonicalCityName(name) : String(name || '').trim();
    if (!c) return '';
    const cfg = window.CITY_CLASSIFICATION || {};
    const all = [
        ...(cfg.HUB_CITIES || []),
        ...(cfg.KRAI_CITIES || []),
        ...(cfg.INTERREGIONAL_CITIES || [])
    ];
    const low = c.toLowerCase();
    const hit = all.find(city => String(city).toLowerCase() === low);
    return hit || c;
}

function baggageRouteKey(from, to) {
    const f = canonicalCityForBaggage(from);
    const t = canonicalCityForBaggage(to);
    return f && t ? `${f}|${t}` : '';
}

function isBaggageHeaderCell(value) {
    const s = String(value || '').toLowerCase().replace(/\s+/g, '');
    return !s || s.includes('наименование') || s === 'тип' || s.includes('веспассажира');
}

function detectBaggageSheetFormat(json) {
    const head = json[0] || [];
    const b = parseFloat(head[1]);
    const c = parseFloat(head[2]);
    const d = parseFloat(head[3]);
    if (b === 1 && c === 2 && (d === 3 || !isNaN(d))) return 'route-bm';

    for (let i = 1; i < Math.min(20, json.length); i++) {
        const row = json[i];
        if (!row || row.length < 5) continue;
        const a = String(row[0] || '').trim();
        const bCity = String(row[1] || '').trim();
        if (!a || isBaggageHeaderCell(a)) continue;
        if (bCity && !isBaggageHeaderCell(bCity) && !/^\d/.test(a)) {
            const baggageD = parseFloat(row[3]);
            if (!isNaN(baggageD)) return 'cities-do';
        }
    }
    return 'route-bm';
}

function cityKeyForBaggage(name) {
    return typeof cityMatchKey === 'function'
        ? cityMatchKey(name)
        : String(name || '').toLowerCase().replace(/[—–\s\-]+/g, '');
}

function knownCitiesLongestFirst() {
    const cfg = window.CITY_CLASSIFICATION || {};
    const names = [
        ...(cfg.HUB_CITIES || []),
        ...(cfg.KRAI_CITIES || []),
        ...(cfg.INTERREGIONAL_CITIES || []),
        ...Object.keys(cfg.CITY_ALIASES || {}),
        ...Object.values(cfg.CITY_ALIASES || {})
    ];
    const seen = new Set();
    const unique = [];
    for (const n of names) {
        const s = String(n || '').trim();
        const k = cityKeyForBaggage(s);
        if (!s || !k || seen.has(k)) continue;
        seen.add(k);
        unique.push(s);
    }
    unique.sort((a, b) => cityKeyForBaggage(b).length - cityKeyForBaggage(a).length);
    return unique;
}

function parseCombinedRouteLabel(routeStr) {
    const raw = String(routeStr || '').trim();
    if (!raw || isBaggageHeaderCell(raw)) return null;

    // «Кызыл - Улан-Удэ»: пробелы вокруг тире. Нельзя менять все дефисы на тире —
    // иначе Улан-Удэ / Улан-Батор / Горно-Алтайск режутся на части.
    if (/\s[—–-]\s/.test(raw) || /[—–]/.test(raw)) {
        if (typeof parseDirectionCities === 'function') {
            const cities = parseDirectionCities(raw);
            if (cities.length >= 2) {
                return { from: canonicalCityForBaggage(cities[0]), to: canonicalCityForBaggage(cities[1]) };
            }
        }
    }

    const compact = cityKeyForBaggage(raw);
    if (compact) {
        const known = knownCitiesLongestFirst();
        for (const fromCity of known) {
            const fk = cityKeyForBaggage(fromCity);
            if (!fk || !compact.startsWith(fk)) continue;
            const rest = compact.slice(fk.length);
            if (!rest) continue;
            for (const toCity of known) {
                const tk = cityKeyForBaggage(toCity);
                if (!tk || rest !== tk) continue;
                const from = canonicalCityForBaggage(fromCity);
                const to = canonicalCityForBaggage(toCity);
                if (from && to && cityKeyForBaggage(from) !== cityKeyForBaggage(to)) {
                    return { from, to };
                }
            }
        }
    }

    const hub = BAGGAGE_HUB;
    const hubPrefix = hub + '-';
    const hubSuffix = '-' + hub;
    if (raw.startsWith(hubPrefix)) {
        return { from: hub, to: canonicalCityForBaggage(raw.slice(hubPrefix.length)) };
    }
    if (raw.endsWith(hubSuffix)) {
        return { from: canonicalCityForBaggage(raw.slice(0, -hubSuffix.length)), to: hub };
    }

    return null;
}

function readBaggageMonths(row, monthCols) {
    const baggage = {};
    let hasBaggage = false;
    for (let m = 1; m <= 12; m++) {
        const col = monthCols[m];
        const v = parseFloat(row[col]);
        if (!isNaN(v)) {
            baggage[m] = v;
            hasBaggage = true;
        }
    }
    return hasBaggage ? baggage : null;
}

function normalizeAircraftToken(t) {
    return String(t || '').toUpperCase()
        .replace(/ЯК/g, 'YK')
        .replace(/АН/g, 'AN')
        .replace(/Л-/g, 'L-')
        .replace(/\s+/g, '');
}

function aircraftMatchesEntry(acTypesStr, aircraftCode) {
    const ac = normalizeAircraftToken(typeof getAircraftType === 'function' ? getAircraftType(aircraftCode) : aircraftCode);
    if (!ac) return true;
    const pool = normalizeAircraftToken(acTypesStr);
    if (!pool) return true;
    const tokens = ['ATR', 'AT7', 'AN24', 'AN26', 'AN-24', 'AN-26', 'L410', 'L-410', 'YK42', 'YK-42', 'ЯК-42'];
    for (const tok of tokens) {
        const n = normalizeAircraftToken(tok);
        if (ac.includes(n.replace(/-/g, '')) || ac.includes(n)) {
            if (pool.includes(n.replace(/-/g, '')) || pool.includes(n)) return true;
        }
    }
    if (ac.includes('ATR') && pool.includes('ATR')) return true;
    if (ac.includes('AT7') && pool.includes('ATR')) return true;
    if ((ac.includes('YK') || ac.includes('ЯК')) && (pool.includes('YK') || pool.includes('ЯК'))) return true;
    if (ac.includes('AN') && pool.includes('AN')) return true;
    return pool.split(',').some(part => ac.includes(normalizeAircraftToken(part)));
}

function parseBaggageWeightsSheet(json) {
    const parsed = {};
    if (!Array.isArray(json)) return parsed;

    const format = detectBaggageSheetFormat(json);
    const monthCols = format === 'cities-do' ? BAGGAGE_MONTH_COL_DO : BAGGAGE_MONTH_COL_BM;
    const startRow = format === 'cities-do' ? 3 : 1;

    for (let i = startRow; i < json.length; i++) {
        const row = json[i];
        if (!row || row.length < 3) continue;

        let from = '';
        let to = '';
        let acTypes = '';

        if (format === 'route-bm') {
            const route = parseCombinedRouteLabel(row[0]);
            if (!route) continue;
            from = route.from;
            to = route.to;
        } else {
            const fromRaw = String(row[0] || '').trim();
            const toRaw = String(row[1] || '').trim();
            if (isBaggageHeaderCell(fromRaw) || isBaggageHeaderCell(toRaw)) continue;
            from = canonicalCityForBaggage(fromRaw);
            to = canonicalCityForBaggage(toRaw);
            acTypes = String(row[2] || '').trim();
        }

        if (!from || !to) continue;

        const fromLow = from.toLowerCase().replace(/\s+/g, '');
        const toLow = to.toLowerCase().replace(/\s+/g, '');
        if (BAGGAGE_SECTION_MARKERS.has(fromLow) || BAGGAGE_SECTION_MARKERS.has(toLow)) continue;

        const baggage = readBaggageMonths(row, monthCols);
        if (!baggage) continue;

        const entry = { from, to, baggage, acTypes };
        const key = baggageRouteKey(from, to);
        if (!parsed[key]) parsed[key] = [];
        parsed[key].push(entry);
    }
    return parsed;
}

function findBaggageEntry(from, to, aircraftCode) {
    const f = canonicalCityForBaggage(from);
    const t = canonicalCityForBaggage(to);
    let pool = baggageWeightsData[baggageRouteKey(f, t)] || [];
    if (!pool.length) pool = baggageWeightsData[baggageRouteKey(t, f)] || [];
    if (!pool.length) return null;
    if (pool.length === 1) return pool[0];
    const hit = pool.find(e => aircraftMatchesEntry(e.acTypes, aircraftCode));
    return hit || pool[0];
}

function getFlightMonthFromDate(dateStr) {
    const d = typeof parseLocalDate === 'function' ? parseLocalDate(dateStr) : null;
    return d ? d.getMonth() + 1 : null;
}

function isSummerWeightMonth(month) {
    return month >= 4 && month <= 10;
}

function getAdultBaseWeightKg(month) {
    return isSummerWeightMonth(month) ? ADULT_WEIGHT_SUMMER : ADULT_WEIGHT_WINTER;
}

function getChildBaseWeightKg(_month) {
    return CHILD_WEIGHT_FIXED_KG;
}

function isPkzHorizonDate(dateStr) {
    if (typeof getDaysUntil !== 'function') return true;
    const d = getDaysUntil(dateStr);
    return d !== null && d >= 0 && d <= PKZ_HORIZON_DAYS;
}

function childrenKey(dateStr, flight) {
    const fl = typeof cleanFlight === 'function' ? cleanFlight(flight) : String(flight || '');
    const d = String(dateStr || '').trim();
    return d && fl ? `${d}|${fl}` : '';
}

function getChildrenCountFromFile(dateStr, flight) {
    const k = childrenKey(dateStr, flight);
    if (!k) return 0;
    return childrenByFlightDate[k] || 0;
}

function parseChildrenCsvText(text) {
    const map = {};
    if (!text) return map;
    const lines = String(text).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line || !line.trim()) continue;
        // skip header / period lines
        if (i < 4 && !/^\d+[;,]/.test(line.trim())) continue;

        const row = typeof parseCSVLine === 'function'
            ? parseCSVLine(line.includes(';') ? line.replace(/;/g, ',') : line)
            : line.split(/[;,]/);
        // Format: №;FIO;category;gender;birth;flight;flyDate;...
        // After semicolon-split with parseCSVLine on commas — re-split by ;
        const cols = line.split(';');
        if (cols.length < 7) continue;

        const birthRaw = String(cols[4] || '').trim();
        const flightRaw = String(cols[5] || '').trim();
        const flyRaw = String(cols[6] || '').trim();
        const fl = typeof cleanFlight === 'function' ? cleanFlight(flightRaw) : flightRaw;
        const fly = typeof normalizeDate === 'function' ? normalizeDate(flyRaw) : flyRaw;
        const birth = typeof normalizeDate === 'function' ? normalizeDate(birthRaw) : birthRaw;
        if (!fl || !fly) continue;

        let age = null;
        if (typeof calculateAgeAtFly === 'function') {
            age = calculateAgeAtFly(birth, fly);
        }
        // Дети 2–12 включительно; младенцы <2 не считаем
        if (age === null || age < CHILD_AGE_MIN || age > CHILD_AGE_MAX) continue;

        const k = childrenKey(fly, fl);
        if (!k) continue;
        map[k] = (map[k] || 0) + 1;
    }
    return map;
}

function findChildrenCsvFile(files) {
    const list = Array.from(files || []);
    for (const f of list) {
        const n = f.name.toLowerCase();
        const path = String(f.webkitRelativePath || f.name || '').toLowerCase();
        if (n.endsWith('.csv') && (n.includes('дети') || n.includes('deti') || path.includes('дети'))) {
            return f;
        }
    }
    // root of load folder
    for (const f of list) {
        if (f.name.toLowerCase() === 'дети.csv') return f;
    }
    return null;
}

async function loadChildrenFile(fh) {
    if (!fh) return 0;
    try {
        const file = typeof toFile === 'function' ? await toFile(fh) : fh;
        let text = '';
        if (typeof readSalesCsvText === 'function') {
            text = await readSalesCsvText(file);
        } else {
            text = await new Promise((resolve, reject) => {
                const r = new FileReader();
                r.onload = () => resolve(r.result || '');
                r.onerror = () => reject(new Error('read children'));
                r.readAsText(file, 'windows-1251');
            });
        }
        childrenByFlightDate = parseChildrenCsvText(text);
        if (typeof dataLoadStatus !== 'undefined') {
            dataLoadStatus.children = Object.keys(childrenByFlightDate).length > 0;
        }
        if (typeof invalidateMetricsCache === 'function') invalidateMetricsCache();
        return Object.keys(childrenByFlightDate).length;
    } catch (e) {
        console.error('loadChildrenFile', e);
        childrenByFlightDate = {};
        return 0;
    }
}

function getBaggageKgForRoute(from, to, month, aircraftCode) {
    if (!month) return null;
    const entry = findBaggageEntry(from, to, aircraftCode);
    if (!entry) return null;
    const v = entry.baggage[month];
    return v === undefined || isNaN(v) ? null : v;
}

function isChildSaleRecord(sale) {
    if (!sale) return false;
    if (typeof extractDiscountPercent === 'function' && extractDiscountPercent(sale.basicFareStr) > 0) return true;
    if (sale.birthDate && sale.flyDate && typeof calculateAgeAtFly === 'function') {
        const age = calculateAgeAtFly(sale.birthDate, sale.flyDate);
        return age !== null && age < 12;
    }
    return false;
}

function resolvePassengerSplit(totalPax, salesList, showSales, options = {}) {
    const total = Math.max(0, parseInt(totalPax, 10) || 0);
    if (!total) return { adults: 0, children: 0 };

    // Приоритет: Дети.csv (точное число детей 2–12)
    if (options.dateStr && options.flight) {
        const fromFile = getChildrenCountFromFile(options.dateStr, options.flight);
        if (fromFile > 0 || Object.keys(childrenByFlightDate).length > 0) {
            const children = Math.min(fromFile, total);
            return { adults: total - children, children };
        }
    }

    if (!showSales || !salesList || !salesList.length) {
        return { adults: total, children: 0 };
    }

    const salesAdults = salesList.filter(s => !isChildSaleRecord(s)).length;
    const salesCount = salesList.length;

    if (salesCount > total) {
        const adults = Math.min(salesAdults, total);
        return { adults, children: total - adults };
    }
    if (salesCount < total) {
        return { adults: total, children: 0 };
    }
    return { adults: salesAdults, children: total - salesAdults };
}

function getRouteCitiesForFlight(flightBase) {
    const code = typeof getBaseFlight === 'function' ? getBaseFlight(flightBase) : flightBase;
    const dir = typeof getFlightDirection === 'function' ? getFlightDirection(code) : '';
    const cities = typeof parseDirectionCities === 'function' ? parseDirectionCities(dir) : [];
    if (cities.length >= 2) return { from: cities[0], to: cities[1] };
    return null;
}

function calcPkzFromSplit(adults, children, adultUnitKg, childUnitKg) {
    if (adultUnitKg === null || childUnitKg === null || isNaN(adultUnitKg) || isNaN(childUnitKg)) return null;
    return Math.round((adults || 0) * adultUnitKg + (children || 0) * childUnitKg);
}

function getPkzFlightDetails(row, flightBase, options = {}) {
    if (!row) return null;
    const totalPax = parseInt(row[6] || 0, 10);
    if (!totalPax && !options.allowEmpty) return null;

    const month = getFlightMonthFromDate(row[1]);
    if (!month) return null;

    const flightCode = typeof cleanFlight === 'function' ? cleanFlight(row[0] || flightBase) : flightBase;
    const route = getRouteCitiesForFlight(flightBase || flightCode);
    const baggage = route ? getBaggageKgForRoute(route.from, route.to, month, row[4]) : null;
    const adultBaseKg = getAdultBaseWeightKg(month);
    const childBaseKg = CHILD_WEIGHT_FIXED_KG;
    const extraKg = Math.max(0, parseFloat(options.extraKg) || 0);
    const adultUnitKg = baggage !== null ? adultBaseKg + baggage : adultBaseKg;
    const childUnitKg = baggage !== null ? childBaseKg + baggage : childBaseKg;

    const split = options.splitOverride || resolvePassengerSplit(
        totalPax,
        options.salesList,
        options.showSales !== false,
        { dateStr: row[1], flight: flightCode }
    );

    let pkzKg = calcPkzFromSplit(split.adults, split.children, adultUnitKg, childUnitKg);
    if (pkzKg !== null) pkzKg += extraKg;

    return {
        totalPax,
        adults: split.adults,
        children: split.children,
        month,
        baggageKg: baggage,
        adultBaseKg,
        childBaseKg,
        adultUnitKg,
        childUnitKg,
        extraKg,
        pkzKg,
        hasWeights: Object.keys(baggageWeightsData).length > 0,
        horizonOk: isPkzHorizonDate(row[1]),
        flightCode,
        date: row[1]
    };
}

function calcCalculatedPkz(row, flightBase, options = {}) {
    const details = getPkzFlightDetails(row, flightBase, options);
    return details ? details.pkzKg : null;
}

/** Ср. багаж на 1 пасс. из Весовых */
function formatAvgBaggageOnlyKg(details) {
    if (!details || details.baggageKg == null || isNaN(details.baggageKg)) return '—';
    const n = Number(details.baggageKg);
    const text = Number.isInteger(n) ? String(n) : n.toFixed(1);
    return text + ' кг';
}

/**
 * Багаж на рейс = ср. багаж (Весовые) × загрузка.
 * Не путать с КЗ (там р/к 75/80 + багаж × взрослые + (30 + багаж) × дети).
 */
function formatBaggageTimesLoadKg(details) {
    if (!details || details.baggageKg == null || isNaN(details.baggageKg)) return '—';
    const load = parseInt(details.totalPax, 10) || 0;
    const total = Math.round(Number(details.baggageKg) * load * 10) / 10;
    if (typeof formatNum === 'function') {
        const whole = Math.round(total);
        if (Math.abs(total - whole) < 0.05) return formatNum(whole) + ' кг';
    }
    const text = Number.isInteger(total) ? String(total) : total.toFixed(1);
    return (typeof formatNum === 'function' ? formatNum(Math.round(total)) : text) + ' кг';
}

/** @deprecated имя оставлено для совместимости — теперь «багаж × загрузка» */
function formatAvgBagUnitKg(details) {
    return formatBaggageTimesLoadKg(details);
}

function buildPkzAdjustPanelHtml(details, opts = {}) {
    if (!details) return '';
    const esc = typeof escHtml === 'function' ? escHtml : (s) => String(s || '');
    const fmt = typeof formatNum === 'function' ? formatNum : (n) => String(n);
    const pkzText = formatPkzKg(details.pkzKg);
    const bagPerPax = formatAvgBaggageOnlyKg(details);
    const seasonLabel = isSummerWeightMonth(details.month) ? 'лето 75' : 'зима 80';
    const extra = details.extraKg || 0;
    const maxKids = Math.max(details.totalPax, details.children, 0);
    const flyDate = opts.date || details.date || '';
    const flightCode = opts.flightCode || details.flightCode || '';
    let navVal = opts.navKg;
    if (navVal === undefined && typeof getPkzNavValue === 'function' && flyDate && flightCode) {
        navVal = getPkzNavValue(flyDate, flightCode);
    }
    const navInput = navVal != null && !isNaN(navVal) ? String(navVal) : '';
    const kzKg = details.pkzKg != null && !isNaN(details.pkzKg) ? details.pkzKg : null;
    let vacText = '—';
    let vacCls = '';
    if (navVal != null && !isNaN(navVal) && kzKg != null) {
        vacText = typeof formatVacancyKg === 'function'
            ? formatVacancyKg(navVal, kzKg)
            : `${Math.round(navVal - kzKg)} кг`;
        const d = navVal - kzKg;
        if (d > 0) vacCls = ' pkz-vacancy-pos';
        else if (d < 0) vacCls = ' pkz-vacancy-neg';
    }

    return `
        <div class="pkz-adjust-panel" data-pkz-panel="1"
             data-total="${details.totalPax}"
             data-date="${esc(flyDate)}"
             data-flight="${esc(flightCode)}"
             data-adult-unit="${details.adultUnitKg != null ? details.adultUnitKg : ''}"
             data-child-unit="${details.childUnitKg != null ? details.childUnitKg : CHILD_WEIGHT_FIXED_KG}">
            <div class="pkz-adjust-head">
                <h4 class="pkz-adjust-title">КЗ расчётная</h4>
                <span class="pkz-adjust-season">${esc(seasonLabel)} · багаж ${esc(bagPerPax)}/пасс. · дети ${CHILD_WEIGHT_FIXED_KG} кг</span>
            </div>
            <div class="pkz-adjust-grid">
                <div class="pkz-stat pkz-stat-edit">
                    <span class="pkz-stat-label">Загрузка (общая)</span>
                    <input type="number" class="pkz-load-input"
                           min="0" step="1" value="${details.totalPax}"
                           aria-label="Общая загрузка пассажиров">
                </div>
                <div class="pkz-stat">
                    <span class="pkz-stat-label">Взрослых</span>
                    <span class="pkz-stat-val" data-pkz-adults>${fmt(details.adults)}</span>
                </div>
                <div class="pkz-stat pkz-stat-edit">
                    <span class="pkz-stat-label">Детей (2–12)</span>
                    <input type="number" class="pkz-children-input"
                           min="0" max="${maxKids}" step="1" value="${details.children}"
                           aria-label="Количество детей">
                </div>
                <div class="pkz-stat pkz-stat-edit">
                    <span class="pkz-stat-label">Доп. кг</span>
                    <input type="number" class="pkz-extra-input"
                           min="0" step="1" value="${extra}"
                           aria-label="Дополнительный вес кг">
                </div>
                <div class="pkz-stat pkz-stat-edit">
                    <span class="pkz-stat-label">ПКЗ из NAV</span>
                    <input type="number" class="pkz-nav-input pkz-detail-nav-input"
                           step="1" value="${esc(navInput)}" placeholder="кг"
                           data-date="${esc(flyDate)}" data-flight="${esc(flightCode)}"
                           ${(typeof ProfileAuth !== 'undefined' && !ProfileAuth.hasPermission('edit_pkz_nav')) ? 'readonly' : ''}
                           aria-label="ПКЗ из NAV">
                </div>
                <div class="pkz-stat pkz-stat-highlight">
                    <span class="pkz-stat-label">КЗ расч.</span>
                    <span class="pkz-stat-val pkz-stat-pkz" data-pkz-value data-kz-num="${kzKg != null ? kzKg : ''}">${esc(pkzText)}</span>
                </div>
                <div class="pkz-stat">
                    <span class="pkz-stat-label">Вакансия</span>
                    <span class="pkz-stat-val${vacCls}" data-pkz-detail-vacancy>${esc(vacText)}</span>
                </div>
            </div>

        </div>`;
}

function bindPkzAdjustPanel(root) {
    if (!root) return;
    const panel = root.querySelector('[data-pkz-panel]');
    if (!panel || panel.dataset.pkzBound) return;
    panel.dataset.pkzBound = '1';

    const loadInput = panel.querySelector('.pkz-load-input');
    const input = panel.querySelector('.pkz-children-input');
    const extraInput = panel.querySelector('.pkz-extra-input');
    const navInput = panel.querySelector('.pkz-detail-nav-input');
    const adultsEl = panel.querySelector('[data-pkz-adults]');
    const pkzEl = panel.querySelector('[data-pkz-value]');
    const vacEl = panel.querySelector('[data-pkz-detail-vacancy]');
    if (!input || !adultsEl || !pkzEl) return;

    const adultUnit = parseFloat(panel.dataset.adultUnit);
    const childUnit = parseFloat(panel.dataset.childUnit) || CHILD_WEIGHT_FIXED_KG;
    const fmt = typeof formatNum === 'function' ? formatNum : (n) => String(n);

    const syncVacancy = (kzNum) => {
        if (!vacEl) return;
        const raw = navInput?.value?.trim() || '';
        if (raw === '' || kzNum == null || isNaN(kzNum)) {
            vacEl.textContent = '—';
            vacEl.classList.remove('pkz-vacancy-pos', 'pkz-vacancy-neg');
            return;
        }
        const nav = parseFloat(raw.replace(/\s/g, '').replace(',', '.'));
        if (isNaN(nav)) {
            vacEl.textContent = '—';
            vacEl.classList.remove('pkz-vacancy-pos', 'pkz-vacancy-neg');
            return;
        }
        const d = Math.round(nav - kzNum);
        vacEl.textContent = typeof formatVacancyKg === 'function'
            ? formatVacancyKg(nav, kzNum)
            : `${d > 0 ? '+' : ''}${d} кг`;
        vacEl.classList.toggle('pkz-vacancy-pos', d > 0);
        vacEl.classList.toggle('pkz-vacancy-neg', d < 0);
    };

    const refresh = () => {
        let total = parseInt(loadInput?.value ?? panel.dataset.total, 10);
        if (isNaN(total) || total < 0) total = 0;
        if (loadInput) loadInput.value = total;
        panel.dataset.total = String(total);

        let children = parseInt(input.value, 10);
        if (isNaN(children) || children < 0) children = 0;
        if (children > total) children = total;
        input.value = children;
        input.max = String(Math.max(total, 0));

        let extra = parseFloat(extraInput?.value);
        if (isNaN(extra) || extra < 0) extra = 0;
        if (extraInput) extraInput.value = extra;

        const adults = total - children;
        adultsEl.textContent = fmt(adults);
        let pkz = calcPkzFromSplit(adults, children, adultUnit, childUnit);
        if (pkz !== null) pkz += extra;
        pkzEl.textContent = formatPkzKg(pkz);
        if (pkz !== null) pkzEl.dataset.kzNum = String(pkz);
        else delete pkzEl.dataset.kzNum;
        syncVacancy(pkz);

        // синхронизация строки таблицы, если открыта
        const date = panel.dataset.date;
        const flight = panel.dataset.flight;
        if (date && flight) {
            const rowInp = document.querySelector(
                `.pkz-nav-input[data-date="${CSS.escape(date)}"][data-flight="${CSS.escape(flight)}"]`
            );
            if (rowInp && rowInp !== navInput && document.activeElement !== rowInp) {
                if (pkz !== null) rowInp.dataset.kzKg = String(pkz);
                const vacCell = rowInp.closest('tr')?.querySelector('[data-pkz-vacancy]');
                if (vacCell && navInput) {
                    const raw = navInput.value.trim();
                    if (raw === '' || pkz == null) {
                        vacCell.textContent = '—';
                        vacCell.classList.remove('pkz-vacancy-pos', 'pkz-vacancy-neg');
                    } else {
                        const nav = parseFloat(raw.replace(',', '.'));
                        if (!isNaN(nav)) {
                            vacCell.textContent = typeof formatVacancyKg === 'function'
                                ? formatVacancyKg(nav, pkz) : `${Math.round(nav - pkz)} кг`;
                            const d = nav - pkz;
                            vacCell.classList.toggle('pkz-vacancy-pos', d > 0);
                            vacCell.classList.toggle('pkz-vacancy-neg', d < 0);
                        }
                    }
                }
            }
        }
    };

    loadInput?.addEventListener('input', refresh);
    loadInput?.addEventListener('change', refresh);
    input.addEventListener('input', refresh);
    input.addEventListener('change', refresh);
    extraInput?.addEventListener('input', refresh);
    extraInput?.addEventListener('change', refresh);

    if (navInput) {
        ['click', 'mousedown', 'dblclick'].forEach((ev) => {
            navInput.addEventListener(ev, (e) => e.stopPropagation());
        });
        navInput.addEventListener('input', () => {
            const kz = parseFloat(pkzEl.dataset.kzNum);
            syncVacancy(isNaN(kz) ? null : kz);
        });
        navInput.addEventListener('change', () => {
            if (typeof ProfileAuth !== 'undefined' && !ProfileAuth.hasPermission('edit_pkz_nav')) return;
            const date = navInput.dataset.date || panel.dataset.date;
            const flight = navInput.dataset.flight || panel.dataset.flight;
            if (typeof setPkzNavValue === 'function' && date && flight) {
                setPkzNavValue(date, flight, navInput.value);
            }
            // обновить input в строке таблицы
            const rowInp = document.querySelector(
                `#pkz-table-container .pkz-nav-input[data-date="${CSS.escape(date)}"][data-flight="${CSS.escape(flight)}"]`
            );
            if (rowInp && rowInp !== navInput) {
                rowInp.value = navInput.value;
                rowInp.dispatchEvent(new Event('input', { bubbles: true }));
            }
            const kz = parseFloat(pkzEl.dataset.kzNum);
            syncVacancy(isNaN(kz) ? null : kz);
        });
    }
}

function formatPkzKg(value) {
    if (value === null || value === undefined || isNaN(value)) return '—';
    const n = Math.round(value);
    return (typeof formatNum === 'function' ? formatNum(n) : String(n)) + ' кг';
}

function findBaggageWeightsFile(files) {
    const list = Array.from(files || []);
    for (const f of list) {
        const n = f.name.toLowerCase();
        const path = String(f.webkitRelativePath || f.name || '').toLowerCase();
        if (n.endsWith('.xlsx') && (n.includes('весов') || path.includes('весов'))) return f;
    }
    return null;
}

async function loadBaggageWeightsFile(fh) {
    if (!fh || typeof XLSX === 'undefined') return;
    try {
        const file = typeof toFile === 'function' ? await toFile(fh) : fh;
        const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
        const sh = wb.Sheets[wb.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json(sh, { header: 1, raw: true });
        baggageWeightsData = parseBaggageWeightsSheet(json);
        if (typeof dataLoadStatus !== 'undefined') dataLoadStatus.weights = Object.keys(baggageWeightsData).length > 0;
        if (typeof invalidateMetricsCache === 'function') invalidateMetricsCache();
        if (typeof updateHeaderStatus === 'function') updateHeaderStatus();
    } catch (e) {
        console.error('loadBaggageWeightsFile', e);
    }
}

window.BaggageWeights = {
    get data() { return baggageWeightsData; },
    get children() { return childrenByFlightDate; },
    parseBaggageWeightsSheet,
    findBaggageWeightsFile,
    loadBaggageWeightsFile,
    findChildrenCsvFile,
    loadChildrenFile,
    parseChildrenCsvText,
    resolvePassengerSplit,
    getPkzFlightDetails,
    calcCalculatedPkz,
    calcPkzFromSplit,
    buildPkzAdjustPanelHtml,
    bindPkzAdjustPanel,
    isPkzHorizonDate,
    getChildrenCountFromFile,
    CHILD_WEIGHT_FIXED_KG,
    PKZ_HORIZON_DAYS,
    formatPkzKg,
    formatBaggageTimesLoadKg,
    formatAvgBaggageOnlyKg,
    getBaggageKgForRoute
};