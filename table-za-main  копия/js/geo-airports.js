// Справочник координат пунктов сети. WGS84, аэропорты / фактические точки.
// Нет записи → точка на карте не ставится (не угадываем).
window.GEO_AIRPORTS = (function () {
    // iata/код → { lat, lon, name, city }
    const BY_CODE = {
        KJA: { lat: 56.1729, lon: 92.4934, name: 'Красноярск', city: 'Красноярск' },
        ABA: { lat: 53.7400, lon: 91.3850, name: 'Абакан', city: 'Абакан' },
        KYZ: { lat: 51.6694, lon: 94.4006, name: 'Кызыл', city: 'Кызыл' },
        TOF: { lat: 56.3803, lon: 85.2083, name: 'Томск', city: 'Томск' },
        BAX: { lat: 53.3638, lon: 83.5385, name: 'Барнаул', city: 'Барнаул' },
        RGK: { lat: 51.9667, lon: 85.8333, name: 'Горно-Алтайск', city: 'Горно-Алтайск' },
        KEJ: { lat: 55.2701, lon: 86.1072, name: 'Кемерово', city: 'Кемерово' },
        NOZ: { lat: 53.8114, lon: 86.8772, name: 'Новокузнецк', city: 'Новокузнецк' },
        NSK: { lat: 69.3111, lon: 87.3322, name: 'Норильск (Алыкель)', city: 'Норильск' },
        DKS: { lat: 73.5178, lon: 80.3797, name: 'Диксон', city: 'Диксон' },
        HTG: { lat: 71.9781, lon: 102.4906, name: 'Хатанга', city: 'Хатанга' },
        IAA: { lat: 67.4372, lon: 86.6219, name: 'Игарка', city: 'Игарка' },
        THX: { lat: 65.7972, lon: 87.9353, name: 'Туруханск', city: 'Туруханск' },
        MJY: { lat: 58.1840, lon: 94.7480, name: 'Мотыгино', city: 'Мотыгино' },
        BXY: { lat: 61.6767, lon: 96.3550, name: 'Байкит', city: 'Байкит' },
        SBT: { lat: 66.9390, lon: 88.3520, name: 'Светлогорск', city: 'Светлогорск' },
        TGP: { lat: 61.5900, lon: 89.9900, name: 'Подкаменная Тунгуска', city: 'Подкаменная Тунгуска' },
        ULN: { lat: 47.8431, lon: 106.7666, name: 'Улан-Батор', city: 'Улан-Батор' },
        UUD: { lat: 51.8078, lon: 107.4375, name: 'Улан-Удэ', city: 'Улан-Удэ' },
        NJC: { lat: 60.9493, lon: 76.4836, name: 'Нижневартовск', city: 'Нижневартовск' },
        SWT: { lat: 60.7094, lon: 77.6600, name: 'Стрежевой', city: 'Стрежевой' },
        ULK: { lat: 60.7206, lon: 114.8256, name: 'Ленск', city: 'Ленск' },
        TLK: { lat: 59.8764, lon: 111.0444, name: 'Талакан', city: 'Талакан' },
        PYR: { lat: 66.4004, lon: 112.0300, name: 'Полярный', city: 'Полярный' },
        CZR: { lat: 56.9133, lon: 118.2717, name: 'Чара', city: 'Чара' },
        NZG: { lat: 55.8014, lon: 109.6031, name: 'Нижнеангарск', city: 'Нижнеангарск' },
        HTA: { lat: 52.0263, lon: 113.3056, name: 'Чита', city: 'Чита' },
        IKT: { lat: 52.2680, lon: 104.3886, name: 'Иркутск', city: 'Иркутск' },
        BQS: { lat: 50.4254, lon: 127.4125, name: 'Благовещенск', city: 'Благовещенск' }
    };

    const CITY_ONLY = [
        { lat: 58.4750, lon: 99.1840, name: 'Кодинск', city: 'Кодинск' },
        { lat: 64.2780, lon: 100.2110, name: 'Тура', city: 'Тура' },
        { lat: 60.3730, lon: 93.0410, name: 'Северо-Енисейск', city: 'Северо-Енисейск' },
        { lat: 58.3810, lon: 97.4430, name: 'Богучаны', city: 'Богучаны' },
        { lat: 60.3567, lon: 102.3233, name: 'Ванавара', city: 'Ванавара' },
        { lat: 61.2750, lon: 108.0310, name: 'Ербогачен', city: 'Ербогачен' },
        { lat: 56.3610, lon: 114.9300, name: 'Таксимо', city: 'Таксимо' },
        { lat: 60.3972, lon: 120.4714, name: 'Олекминск', city: 'Олекминск' }
    ];

    const BY_CITY = {};
    Object.keys(BY_CODE).forEach(code => {
        const a = BY_CODE[code];
        const key = cityKey(a.city);
        if (key && !BY_CITY[key]) BY_CITY[key] = Object.assign({ code }, a);
    });
    CITY_ONLY.forEach(a => {
        const key = cityKey(a.city);
        if (key && !BY_CITY[key]) BY_CITY[key] = Object.assign({ code: '' }, a);
    });

    function cityKey(name) {
        if (typeof cityMatchKey === 'function') return cityMatchKey(canonicalCityName(name));
        return String(name || '').toLowerCase().replace(/[—–\s\-]+/g, '');
    }

    function lookupCode(code) {
        let c = String(code || '').trim().toUpperCase();
        if (!c) return null;
        if (c === 'KCY') c = 'KJA';
        return BY_CODE[c] ? Object.assign({ code: c }, BY_CODE[c]) : null;
    }

    function lookupCity(name) {
        const canon = typeof canonicalCityName === 'function' ? canonicalCityName(name) : name;
        const key = cityKey(canon);
        if (!key) return null;
        if (key === cityKey('Черемшанка') || key === cityKey('Емельяново')) {
            return BY_CITY[cityKey('Красноярск')] || lookupCode('KJA');
        }
        return BY_CITY[key] || null;
    }

    function lookupToken(token) {
        const raw = String(token || '').trim();
        if (!raw) return null;
        if (/^[A-Z]{3,4}$/i.test(raw)) {
            const hit = lookupCode(raw);
            if (hit) return hit;
        }
        return lookupCity(raw);
    }

    function endpointsFromDirection(flightCode) {
        if (!flightCode || typeof getCitiesFromFlight !== 'function') return { a: null, b: null };
        const cities = getCitiesFromFlight(flightCode);
        if (!cities || cities.length < 2) return { a: null, b: null };
        return { a: lookupCity(cities[0]), b: lookupCity(cities[cities.length - 1]) };
    }

    /**
     * Концы линии: сначала справочник рейса (KV-185 = Красноярск—Кодинск).
     * IATA из файла — только если обе точки нашлись и рейса нет в справочнике.
     * Нельзя склеивать «код из файла» с «городом из другого рейса».
     */
    function endpointsFromRow(row, flightCode) {
        const fromBook = endpointsFromDirection(flightCode);
        if (fromBook.a && fromBook.b) {
            if ((fromBook.a.city || fromBook.a.code) === (fromBook.b.city || fromBook.b.code)) {
                return { a: null, b: null, unknown: [] };
            }
            return { a: fromBook.a, b: fromBook.b, unknown: [] };
        }

        const route = typeof getRouteFromRow === 'function' ? getRouteFromRow(row) : String(row && row[3] || '');
        const raw = String(route || '').toUpperCase().trim();
        const iataParts = raw.match(/^[A-Z]{3}(?:-[A-Z]{3})+$/)
            ? raw.split('-')
            : [];
        let a = null;
        let b = null;
        if (iataParts.length >= 2) {
            a = lookupToken(iataParts[0]);
            b = lookupToken(iataParts[iataParts.length - 1]);
        }
        if (a && b) {
            if ((a.city || a.code) === (b.city || b.code)) {
                return { a: null, b: null, unknown: [] };
            }
            return { a, b, unknown: [] };
        }

        const unknown = [];
        if (iataParts.length >= 2) {
            if (!a) unknown.push(iataParts[0]);
            if (!b) unknown.push(iataParts[iataParts.length - 1]);
        } else if (raw) unknown.push(raw);
        return { a: null, b: null, unknown };
    }

    return { BY_CODE, lookupCode, lookupCity, lookupToken, endpointsFromRow, cityKey };
})();
