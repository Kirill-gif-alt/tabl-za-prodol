// Справочник городов для классификации рейсов (редактируйте списки ниже)
// Красноярск — хаб, в списки НЕ входит.
// Краевой рейс: пункт назначения/отправления (кроме Красноярска) в KRAI_CITIES.
// Межрегиональный: город в INTERREGIONAL_CITIES.

window.CITY_CLASSIFICATION = {
    // Хаб — не классифицируется
    HUB_CITIES: [
        'Красноярск'
    ],

    // Краевые — города Красноярского края
    KRAI_CITIES: [
        'Богучаны',
        'Байкит',
        'Ванавара',
        'Диксон',
        'Ербогачен',
        'Игарка',
        'Кодинск',
        'Мотыгино',
        'Норильск',
        'Подкаменная Тунгуска',
        'Светлогорск',
        'Северо-Енисейск',
        'Тура',
        'Туруханск',
        'Хатанга'
    ],

    // Межрегиональные — города за пределами края
    INTERREGIONAL_CITIES: [
        'Абакан',
        'Барнаул',
        'Горно-Алтайск',
        'Кемерово',
        'Кызыл',
        'Ленск',
        'Нижневартовск',
        'Нижнеангарск',
        'Новокузнецк',
        'Олекминск',
        'Полярный',
        'Стрежевой',
        'Талакан',
        'Таксимо',
        'Томск',
        'Улан-Батор',
        'Улан-Удэ',
        'Чара'
    ],

    // Синонимы из маршрутов (routes.js) → каноническое имя из списков выше
    CITY_ALIASES: {
        'П.Тунгуска': 'Подкаменная Тунгуска',
        'П. Тунгуска': 'Подкаменная Тунгуска',
        'С.Енисейск': 'Северо-Енисейск',
        'С. Енисейск': 'Северо-Енисейск',
        'Горно Алтайск': 'Горно-Алтайск',
        'ГорноАлтайск': 'Горно-Алтайск',
        'Горно-алтайск': 'Горно-Алтайск',
        'Алтайск': 'Горно-Алтайск',
        'УланУдэ': 'Улан-Удэ',
        'Улан Удэ': 'Улан-Удэ',
        'УланБатор': 'Улан-Батор',
        'Улан Батор': 'Улан-Батор',
        'ТураГорный': 'Тура',
        'Тура Горный': 'Тура',
        'Черемшанка': 'Красноярск',
        'Емельяново': 'Красноярск'
    }
};

const ROUTE_TYPE_LABELS = {
    krai: 'Краевой',
    interregional: 'Межрегиональный',
    unknown: 'Не классифицирован'
};

function normalizeCityToken(name) {
    return String(name || '')
        .replace(/\s+/g, ' ')
        .replace(/[—–-]/g, ' ')
        .trim();
}

function cityMatchKey(name) {
    return String(name || '').toLowerCase().replace(/[—–\s\-]+/g, '');
}

function canonicalCityName(name) {
    const token = normalizeCityToken(name);
    if (!token) return '';
    const cfg = window.CITY_CLASSIFICATION || {};
    const aliases = cfg.CITY_ALIASES || {};
    if (aliases[token]) return aliases[token];
    const lower = token.toLowerCase();
    for (const [alias, canonical] of Object.entries(aliases)) {
        if (alias.toLowerCase() === lower) return canonical;
    }
    const key = cityMatchKey(token);
    if (key) {
        const listed = [
            ...(cfg.HUB_CITIES || []),
            ...(cfg.KRAI_CITIES || []),
            ...(cfg.INTERREGIONAL_CITIES || [])
        ];
        const hit = listed.find(c => cityMatchKey(c) === key);
        if (hit) return hit;
        for (const [alias, canonical] of Object.entries(aliases)) {
            if (cityMatchKey(alias) === key) return canonical;
        }
    }
    return token;
}

function buildCityLookup() {
    const cfg = window.CITY_CLASSIFICATION || {};
    const hub = new Set((cfg.HUB_CITIES || []).map(c => canonicalCityName(c).toLowerCase()));
    const krai = new Set((cfg.KRAI_CITIES || []).map(c => canonicalCityName(c).toLowerCase()));
    const inter = new Set((cfg.INTERREGIONAL_CITIES || []).map(c => canonicalCityName(c).toLowerCase()));
    return { hub, krai, inter };
}

function parseDirectionCities(direction) {
    const text = String(direction || '').trim();
    if (!text || text.startsWith('Рейс ')) return [];
    // Тире внутри названия (Горно-Алтайск, Улан-Удэ) не должно резать маршрут
    let parts;
    if (/[—–]/.test(text)) {
        parts = text.split(/\s*[—–]\s*/);
    } else {
        parts = text.split(/\s+-\s+/);
    }
    return parts.map(canonicalCityName).filter(Boolean);
}

function cleanFlightCodeLocal(s) {
    if (typeof cleanFlight === 'function') return cleanFlight(s);
    const n = String(s || '').replace(/[^0-9]/g, '');
    return n ? `KV-${n}` : '';
}

function resolveDirectionFlightCode(flightCode) {
    const code = cleanFlightCodeLocal(flightCode);
    if (!code) return '';
    const dirs = window.FLIGHT_DIRECTIONS || {};
    if (dirs[code]) return code;
    if (typeof getBaseFlight === 'function') {
        const base = getBaseFlight(code);
        if (base && dirs[base]) return base;
    }
    return code;
}

function getCitiesFromFlight(flightCode) {
    const dirs = window.FLIGHT_DIRECTIONS || {};
    const key = resolveDirectionFlightCode(flightCode);
    return parseDirectionCities(dirs[key] || '');
}

function isHubCity(city) {
    const { hub } = buildCityLookup();
    return hub.has(canonicalCityName(city).toLowerCase());
}

function isKraiCity(city) {
    const { krai } = buildCityLookup();
    return krai.has(canonicalCityName(city).toLowerCase());
}

function isInterregionalCity(city) {
    const { inter } = buildCityLookup();
    return inter.has(canonicalCityName(city).toLowerCase());
}

function getFlightRouteType(flightCode) {
    const cities = getCitiesFromFlight(flightCode);
    if (!cities.length) return 'unknown';

    const nonHub = cities.filter(c => !isHubCity(c));
    if (!nonHub.length) return 'unknown';

    const hasInter = nonHub.some(isInterregionalCity);
    const allKrai = nonHub.every(isKraiCity);

    if (hasInter) return 'interregional';
    if (allKrai) return 'krai';

    // Частичное совпадение: хотя бы один город в списке края
    if (nonHub.some(isKraiCity)) return 'krai';

    return 'unknown';
}

function getFlightRouteTypeLabel(flightCode) {
    return ROUTE_TYPE_LABELS[getFlightRouteType(flightCode)] || '—';
}

function flightMatchesRouteTypeFilter(flightCode, filter) {
    if (!filter || filter === 'all') return true;
    return getFlightRouteType(flightCode) === filter;
}