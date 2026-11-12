// Вертолёты (Ми-8, конфигурация MIH-…): данные отдельно от самолётных.
// • Строки файла «загрузка таб» с конфигурацией MIH-* не попадают в allData: самолётные вкладки, итоги шапки,
//   RMS, «Сегодня» и модели вертолётов не видят. Они лежат здесь и уходят в снимок отдельным полем heli.
// • У рейса с остановками в файле на каждую дату перечислены ВСЕ пары «откуда-куда»; «Free SegBkd» = продано на пару.
//   Загрузка отрезка i→i+1 = сумма продаж пар, у которых начало ≤ i и конец ≥ i+1. Мест в продаже = вместимость − спецброни сквозной пары.
// • Билеты вертолётных рейсов из файла продаж хранятся отдельно (без ПДн): дата продажи и пункты «откуда / куда».
// • Справочник пунктов (код → название) — общий файл shared/heli-points.json; без файла — встроенный.
window.HeliData = (function () {
    const NUM_MIN = 765;   // запасной признак вертолётного рейса, пока нет файла загрузки (KV-765 … KV-812)
    const NUM_MAX = 812;
    const CAP_DEFAULT = 22;
    const POINTS_FILE = 'heli-points.json';

    // ---------- справочник пунктов ----------
    const DEFAULT_POINTS = [
        ['BKA', 'Байкит'], ['TGP', 'Подкаменная Тунгуска'], ['VAQ', 'Ванавара'], ['HTG', 'Хатанга'],
        ['ТРЛ', 'Тура'], ['ЧИР', 'Чиринда'], ['ЕСИ', 'Ессей'], ['ЭКО', 'Эконда'], ['УМИ', 'Учами'],
        ['ТНЧ', 'Тутончаны'], ['КСЮ', 'Кислокан'], ['ЮКТ', 'Юкта'], ['КЮМ', 'Куюмба'], ['ОША', 'Ошарово'],
        ['МГА', 'Мирюга'], ['БУЫ', 'Бурный'], ['КЗВ', 'Кузьмовка'], ['САЙ', 'Суломай'], ['ПГУ', 'Полигус'],
        ['СДР', 'Суринда'], ['СЧУ', 'Стрелка-Чуня'], ['ЧЕМ', 'Чемдальск'], ['ОКБ', 'Оскоба'], ['МРЙ', 'Муторай'],
        ['НРЫ', 'Новорыбная'], ['СДН', 'Сындасско'], ['НАЯ', 'Новая'], ['ХЭТ', 'Хета'], ['КТЫ', 'Катырык'],
        ['ПГА', 'Попигай']
    ];
    let points = null;        // код → название (рабочий справочник)
    let pointsBase = null;    // что было в файле при загрузке (для слияния правок)
    let pointsRev = 0;
    let pointsLoaded = false;
    let canonIndex = null;

    // Латиница и кириллица в кодах путаются (A/А, B/В, K/К …): для поиска в справочнике приводим к одному виду.
    const LOOK = { A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х', Y: 'У' };
    function canon(code) {
        return String(code || '').trim().toUpperCase().replace(/[ABCEHKMOPTXY]/g, c => LOOK[c]);
    }

    function defaults() {
        const o = {};
        DEFAULT_POINTS.forEach(([c, n]) => { o[c] = n; });
        return o;
    }

    function cleanName(v) {
        return String(v == null ? '' : v).replace(/[\x00-\x1F<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
    }

    function cleanCode(v) {
        return String(v == null ? '' : v).replace(/[\x00-\x1F<>;"'\s]/g, '').trim().slice(0, 12);
    }

    function pointsMap() {
        if (!points) points = defaults();
        return points;
    }

    function reindex() {
        canonIndex = new Map();
        Object.keys(pointsMap()).forEach(c => canonIndex.set(canon(c), pointsMap()[c]));
    }

    function pointName(code) {
        const c = String(code || '').trim();
        if (!c) return '';
        const m = pointsMap();
        if (Object.prototype.hasOwnProperty.call(m, c)) return m[c];
        if (!canonIndex) reindex();
        return canonIndex.get(canon(c)) || c;   // неизвестный код — сам код
    }

    function hasPointName(code) {
        const c = String(code || '').trim();
        if (!c) return false;
        if (Object.prototype.hasOwnProperty.call(pointsMap(), c)) return true;
        if (!canonIndex) reindex();
        return canonIndex.has(canon(c));
    }

    // Загрузить общий справочник (один раз; force — перечитать). Файла нет — остаётся встроенный.
    async function loadPoints(force) {
        if (pointsLoaded && !force) return pointsMap();
        let file = null;
        try {
            if (typeof SharedStorage !== 'undefined' && SharedStorage.readJsonFile) file = await SharedStorage.readJsonFile(POINTS_FILE);
        } catch (e) { file = null; }
        const next = defaults();
        const src = file && typeof file === 'object' && file.points && typeof file.points === 'object' ? file.points : null;
        if (src) {
            // Файл — полный справочник: пункты, которых в нём нет, считаются удалёнными.
            Object.keys(next).forEach(k => { delete next[k]; });
            Object.keys(src).slice(0, 500).forEach(k => {
                const c = cleanCode(k), n = cleanName(src[k]);
                if (c && n) next[c] = n;
            });
        }
        points = next;
        pointsBase = Object.assign({}, next);
        pointsLoaded = true;
        pointsRev++;
        canonIndex = null;
        return points;
    }

    function pointsSnapshot() {
        return Object.assign({}, pointsMap());
    }

    // Сохранить правки для всех: к свежему файлу применяются только мои изменения относительно прочитанного.
    // edited — { код: название }; удалённые пункты — те, что были в base и пропали.
    async function savePoints(edited) {
        const base = pointsBase || defaults();
        const clean = {};
        Object.keys(edited || {}).slice(0, 500).forEach(k => {
            const c = cleanCode(k), n = cleanName(edited[k]);
            if (c && n) clean[c] = n;
        });
        if (typeof SharedStorage === 'undefined' || !SharedStorage.updateJsonFile) return { ok: false, reason: 'no-storage' };
        const by = (typeof ProfileAuth !== 'undefined' && ProfileAuth.getCurrentProfile && ProfileAuth.getCurrentProfile()) || null;
        const res = await SharedStorage.updateJsonFile(POINTS_FILE, (cur) => {
            const fresh = cur && cur.points && typeof cur.points === 'object' ? Object.assign({}, cur.points) : defaults();
            Object.keys(clean).forEach(c => { if (base[c] !== clean[c]) fresh[c] = clean[c]; });
            Object.keys(base).forEach(c => { if (!(c in clean)) delete fresh[c]; });
            return { version: 1, updatedAt: Date.now(), updatedBy: by ? String(by.name || by.id || '') : '', points: fresh };
        });
        if (res && res.ok) {
            points = Object.assign({}, res.data.points);
            pointsBase = Object.assign({}, points);
            pointsLoaded = true;
            pointsRev++;
            canonIndex = null;
            return { ok: true };
        }
        return { ok: false, reason: res && res.readFailed ? 'read' : 'write' };
    }

    // Временная правка в окне (без записи): рабочий справочник заменяется копией только после «Сохранить».
    function pointsRevision() { return pointsRev; }

    // Название места в родительном падеже: «до Кузьмовки», «из Байкита». Код вне справочника не склоняется.
    function genitive(name) {
        const s = String(name || '');
        if (!/[А-Яа-яЁё]/.test(s)) return s;
        const one = (w) => {
            const l = w.toLowerCase();
            if (/[^а-яё]/.test(l.replace(/-/g, ''))) return w;
            if (/ая$/.test(l)) return w.slice(0, -2) + 'ой';
            if (/яя$/.test(l)) return w.slice(0, -2) + 'ей';
            if (/ый$/.test(l)) return w.slice(0, -2) + 'ого';
            if (/[кг]ий$/.test(l)) return w.slice(0, -2) + 'ого';
            if (/ий$/.test(l)) return w.slice(0, -2) + 'его';
            if (/ой$/.test(l)) return w.slice(0, -2) + 'ого';
            if (/[гкхжчшщ]а$/.test(l)) return w.slice(0, -1) + 'и';
            if (/а$/.test(l)) return w.slice(0, -1) + 'ы';
            if (/я$/.test(l)) return w.slice(0, -1) + 'и';
            if (/[ао]й$/.test(l) || /ей$/.test(l)) return w.slice(0, -1) + 'я';
            if (/о$/.test(l)) return w.slice(0, -1) + 'а';
            if (/ы$/.test(l)) return w.slice(0, -1);
            if (/[иеёуюэ]$/.test(l)) return w;
            if (/[бвгджзклмнпрстфхцчшщ]$/.test(l)) return w + 'а';
            return w;
        };
        return s.split(' ').map(part => part.split('-').map(one).join('-')).join(' ');
    }

    // ---------- хранилище ----------
    let rows = [];            // [рейс, дата, сегмент, маршрут, статус, вылет, прилёт, конфиг, AU, продано, всего, спецброни, всего AV]
    let flightNos = new Set();
    let sales = {};           // 'дд.мм.гггг|KV-781' → [[дата продажи, откуда, куда], …]
    let salesCount = 0;
    let epoch = 0;
    let salesEpoch = 0;
    let model = null;
    let cityCache = null;
    let salesCache = new Map();

    function bump() {
        epoch++;
        model = null;
        cityCache = null;
        salesCache = new Map();
        flightNos = new Set();
        rows.forEach(r => flightNos.add(r[0]));
    }

    function reset() {
        rows = [];
        sales = {};
        salesCount = 0;
        salesEpoch++;
        bump();
    }

    function hasData() { return rows.length > 0; }
    function hasSales() { return salesCount > 0; }
    function rowCount() { return rows.length; }
    function ticketCount() { return salesCount; }
    function getEpoch() { return epoch + ':' + salesEpoch; }

    function flightNum(code) {
        const m = /(\d+)\s*$/.exec(String(code || ''));
        return m ? parseInt(m[1], 10) : 0;
    }

    // Билет какого рейса — вертолётный: номер есть в файле загрузки; пока файла нет — по диапазону номеров.
    function isHeliFlight(code) {
        const c = String(code || '').trim().toUpperCase();
        if (flightNos.has(c)) return true;
        const n = flightNum(c);
        return n >= NUM_MIN && n <= NUM_MAX;
    }

    function dateTs(s) {
        const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(s || ''));
        return m ? new Date(+m[3], +m[2] - 1, +m[1]).getTime() : null;
    }

    function fmtDate(d) {
        const p = n => String(n).padStart(2, '0');
        return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
    }

    function intOf(v) {
        const n = parseInt(String(v == null ? '' : v).replace(/[^\d-]/g, ''), 10);
        return isNaN(n) ? 0 : n;
    }

    function timeOf(v) {
        if (typeof normalizeTimeStr === 'function') return normalizeTimeStr(v);
        const m = /(\d{1,2}):(\d{2})/.exec(String(v || ''));
        return m ? m[1].padStart(2, '0') + ':' + m[2] : '';
    }

    function dateOf(v) {
        if (typeof normalizeDate === 'function') return normalizeDate(v);
        return String(v || '').trim();
    }

    // Разбор текста файла: только строки с конфигурацией MIH-*. other — сколько строк с другой конфигурацией (самолётных).
    function parseText(text) {
        const out = [];
        const seen = new Set();
        let other = 0;
        const lines = String(text || '').split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            const t = lines[i];
            if (!/^\s*KV-\d/i.test(t)) continue;
            if (!/;\s*MIH-/i.test(t)) { other++; continue; }
            const c = t.split(';').map(x => x.trim());
            const ci = c.findIndex(x => /^MIH-/i.test(x));
            if (ci < 4) { other++; continue; }
            const no = String(c[0]).toUpperCase().replace(/\s+/g, '');
            const date = dateOf(c[1]);
            if (!no || !date) continue;
            const key = no + '|' + date + '|' + c[2];
            if (seen.has(key)) continue;
            seen.add(key);
            const route = String(c[3] || '').toUpperCase();
            out.push([
                no, date, c[2], route, ci >= 5 ? c[ci - 3] : '', timeOf(c[ci - 2]), timeOf(c[ci - 1]), c[ci],
                intOf(c[ci + 1]), intOf(c[ci + 2]), intOf(c[ci + 3]), intOf(c[ci + 4]), intOf(c[ci + 5])
            ]);
        }
        return { rows: out, other };
    }

    // Вид файла по первым строкам: 'heli' — только вертолётные строки, 'mixed' — и те и другие, 'air' — самолётный.
    function classifyText(text) {
        let heli = 0, other = 0;
        const lines = String(text || '').split(/\r?\n/);
        for (let i = 0; i < lines.length && heli + other < 400; i++) {
            const t = lines[i];
            if (!/^\s*KV-\d/i.test(t)) continue;
            if (/;\s*MIH-/i.test(t)) heli++; else other++;
        }
        if (heli && !other) return 'heli';
        if (heli && other) return 'mixed';
        return 'air';
    }

    // Объединить строки нескольких файлов (первый побеждает) и принять как рабочие.
    function setRows(list) {
        const seen = new Set();
        const next = [];
        (list || []).forEach(r => {
            if (!r || r.length < 10) return;
            const k = r[0] + '|' + r[1] + '|' + r[2];
            if (seen.has(k)) return;
            seen.add(k);
            next.push(r);
        });
        rows = next;
        bump();
    }

    // ---------- продажи ----------
    function beginSales() {
        sales = {};
        salesCount = 0;
        salesEpoch++;
        salesCache = new Map();
        cityCache = null;
    }

    function addTicket(fly, code, deal, city1, city2) {
        const k = fly + '|' + String(code).toUpperCase();
        (sales[k] || (sales[k] = [])).push([deal || '', String(city1 || '').trim().toUpperCase(), String(city2 || '').trim().toUpperCase()]);
        salesCount++;
    }

    function endSales() {
        salesEpoch++;
        salesCache = new Map();
        cityCache = null;
    }

    // Русский код города из продаж → код пункта из файла загрузки: по рейсам без остановок (откуда/куда = концы маршрута), голосованием.
    // Остальные коды — как есть, если совпали с пунктом файла (с поправкой на латиницу/кириллицу).
    function cityMap() {
        const stamp = epoch + ':' + salesEpoch;
        if (cityCache && cityCache.stamp === stamp) return cityCache;
        const m = buildModel();
        const votes = new Map();
        const known = new Map();
        const vote = (ru, la) => {
            if (!ru || !la) return;
            if (!votes.has(ru)) votes.set(ru, new Map());
            const v = votes.get(ru);
            v.set(la, (v.get(la) || 0) + 1);
        };
        m.flights.forEach(F => {
            F.pts.forEach(c => known.set(canon(c), c));
            if (F.pts.length !== 2) return;
            (sales[F.key] || []).forEach(t => { vote(t[1], F.pts[0]); vote(t[2], F.pts[1]); });
        });
        const best = new Map();
        votes.forEach((v, ru) => {
            let b = '', n = 0;
            v.forEach((cnt, la) => { if (cnt > n) { b = la; n = cnt; } });
            best.set(ru, b);
        });
        cityCache = { stamp, best, known, resolve: (c) => best.get(c) || known.get(canon(c)) || '' };
        return cityCache;
    }

    function dayStrings() {
        const t = new Date();
        t.setHours(0, 0, 0, 0);
        const y = new Date(t); y.setDate(y.getDate() - 1);
        return { today: fmtDate(t), yesterday: fmtDate(y), todayTs: t.getTime() };
    }

    // Продано за сегодня / вчера / 7 дней: по рейсу и по каждой паре «откуда-куда».
    function flightSales(F) {
        const d = dayStrings();
        const ck = F.key + '|' + d.today + '|' + salesEpoch + '|' + epoch;
        const hit = salesCache.get(ck);
        if (hit) return hit;
        const res = { today: 0, yesterday: 0, d7: 0, total: 0, unmatched: 0, byPair: new Map() };
        const list = sales[F.key] || [];
        if (list.length) {
            const cm = cityMap();
            list.forEach(t => {
                const a = cm.resolve(t[1]), b = cm.resolve(t[2]);
                let pk = '';
                if (a && b) {
                    const ca = canon(a), cb = canon(b);
                    for (let i = 0; i < F.pairs.length; i++) {
                        const p = F.pairs[i];
                        if (canon(F.pts[p.a - 1]) === ca && canon(F.pts[p.b - 1]) === cb) { pk = p.a + '-' + p.b; break; }
                    }
                }
                let bucket = null;
                if (pk) {
                    bucket = res.byPair.get(pk);
                    if (!bucket) { bucket = { today: 0, yesterday: 0, d7: 0, total: 0 }; res.byPair.set(pk, bucket); }
                } else res.unmatched++;
                const deal = t[0];
                const ts = deal ? dateTs(deal) : null;
                const ago = ts === null ? null : Math.round((d.todayTs - ts) / 86400000);
                [res, bucket].forEach(x => {
                    if (!x) return;
                    x.total++;
                    if (deal === d.today) x.today++;
                    else if (deal === d.yesterday) x.yesterday++;
                    if (ago !== null && ago >= 0 && ago < 7) x.d7++;
                });
            });
        }
        salesCache.set(ck, res);
        return res;
    }

    // ---------- расчёт по отрезкам ----------
    function capOf(cfg) {
        const m = /(\d+)\s*$/.exec(String(cfg || ''));
        const n = m ? parseInt(m[1], 10) : 0;
        return n > 0 && n < 200 ? n : CAP_DEFAULT;
    }

    function buildFlight(key, first) {
        const F = {
            key, no: first[0], num: flightNum(first[0]), date: first[1], ts: dateTs(first[1]),
            route: first[3], pts: String(first[3] || '').split('-').map(s => s.trim()).filter(Boolean),
            cfg: first[7], pairs: [], pairMap: new Map()
        };
        F.n = F.pts.length;
        F.cap = capOf(first[7]);
        return F;
    }

    function finishFlight(F) {
        const n = F.n;
        const through = F.pairMap.get('1-' + n);
        F.ssp = through ? through.ssp : 0;
        F.seats = Math.max(0, F.cap - F.ssp);
        F.segs = [];
        F.segClosed = [];
        for (let i = 1; i < n; i++) {
            let s = 0;
            for (let k = 0; k < F.pairs.length; k++) {
                const p = F.pairs[k];
                if (p.a <= i && p.b >= i + 1) s += p.sold;
            }
            F.segs.push(s);
            const own = F.pairMap.get(i + '-' + (i + 1));
            F.segClosed.push(!!(own && own.closed));
        }
        F.max = F.segs.length ? Math.max(...F.segs) : 0;
        F.maxIdx = F.max > 0 ? F.segs.indexOf(F.max) : -1;
        F.pct = F.seats > 0 ? Math.round(F.max / F.seats * 100) : 0;
        F.closedAll = F.pairs.length > 0 && F.pairs.every(p => p.closed);
        F.closedPairs = F.pairs.filter(p => p.closed);
        F.total = F.pairs.reduce((s, p) => s + p.sold, 0);
        // Время вылета из пункта j (1…n−1) — по паре «j → j+1», иначе по любой паре, начинающейся в j; прилёт — по сквозной паре.
        F.depAt = [];
        for (let j = 1; j < n; j++) {
            let p = F.pairMap.get(j + '-' + (j + 1));
            if (!p) p = F.pairs.find(x => x.a === j);
            F.depAt.push(p ? p.dep : '');
        }
        let last = through || F.pairs.find(x => x.b === n);
        F.arr = last ? last.arr : '';
        F.dep = F.depAt[0] || '';
        F.arrAt = [];
        for (let j = 2; j <= n; j++) {
            const p = F.pairMap.get((j - 1) + '-' + j) || F.pairs.find(x => x.b === j);
            F.arrAt.push(p ? p.arr : '');
        }
    }

    // Столбцы плашек карточки: пункты маршрута карточки → значение отрезка этой даты (рейс с другим набором остановок «растягивается»).
    function mapCells(F, cardPts) {
        const nCols = cardPts.length - 1;
        const cells = new Array(nCols).fill(null);
        const idx = new Map(cardPts.map((c, i) => [canon(c), i]));
        const rowIdx = F.pts.map(c => (idx.has(canon(c)) ? idx.get(canon(c)) : -1));
        let aligned = rowIdx.every(i => i >= 0);
        for (let j = 1; aligned && j < rowIdx.length; j++) if (rowIdx[j] <= rowIdx[j - 1]) aligned = false;
        if (!aligned) {
            if (F.pts.length === cardPts.length) F.segs.forEach((v, j) => { cells[j] = { v, closed: F.segClosed[j], seg: j, first: true }; });
            return cells;
        }
        for (let j = 0; j < F.segs.length; j++) {
            for (let k = rowIdx[j]; k < rowIdx[j + 1]; k++) {
                cells[k] = { v: F.segs[j], closed: F.segClosed[j], seg: j, first: k === rowIdx[j] };
            }
        }
        return cells;
    }

    function buildModel() {
        if (model && model.epoch === epoch) return model;
        const flights = new Map();
        rows.forEach(r => {
            const key = r[1] + '|' + r[0];
            let F = flights.get(key);
            if (!F) { F = buildFlight(key, r); flights.set(key, F); }
            const mm = /^(\d+)-(\d+)/.exec(String(r[2] || ''));
            if (!mm) return;
            const a = +mm[1], b = +mm[2];
            if (a < 1 || b > F.n || a >= b) return;
            const pk = a + '-' + b;
            if (F.pairMap.has(pk)) return;
            const p = {
                a, b, key: pk, sold: Math.max(0, r[9]), au: r[8], ssp: r[11], dep: r[5], arr: r[6],
                closed: !(typeof isSalesStatusOpen === 'function' ? isSalesStatusOpen(r[4]) : !/закрыт/i.test(String(r[4] || '')))
            };
            F.pairs.push(p);
            F.pairMap.set(pk, p);
        });
        flights.forEach(finishFlight);

        // карточки: пара рейсов «туда» (нечётный) / «обратно» (следующий чётный)
        const byCard = new Map();
        flights.forEach(F => {
            const k = F.num % 2 ? F.num : F.num - 1;
            let c = byCard.get(k);
            if (!c) { c = { key: k, outNo: 'KV-' + k, inNo: 'KV-' + (k + 1), dates: new Map(), outPts: [], inPts: [] }; byCard.set(k, c); }
            let e = c.dates.get(F.date);
            if (!e) { e = { date: F.date, ts: F.ts, out: null, in: null }; c.dates.set(F.date, e); }
            if (F.num % 2) e.out = F; else e.in = F;
        });
        const cards = [];
        byCard.forEach(c => {
            const entries = [...c.dates.values()].sort((a, b) => (a.ts || 0) - (b.ts || 0));
            let outPts = [], inPts = [];
            entries.forEach(e => {
                if (e.out && e.out.pts.length > outPts.length) outPts = e.out.pts;
                if (e.in && e.in.pts.length > inPts.length) inPts = e.in.pts;
            });
            if (!inPts.length) inPts = outPts.slice().reverse();
            if (!outPts.length) outPts = inPts.slice().reverse();
            entries.forEach(e => {
                if (e.out) e.out.cells = mapCells(e.out, outPts);
                if (e.in) e.in.cells = mapCells(e.in, inPts);
            });
            const any = entries.map(e => e.out || e.in).find(Boolean);
            cards.push({
                key: c.key, outNo: c.outNo, inNo: c.inNo, entries, outPts, inPts,
                base: outPts[0] || '', multi: outPts.length > 2 || inPts.length > 2,
                cap: any ? any.cap : CAP_DEFAULT
            });
        });
        cards.sort((a, b) => a.key - b.key);
        model = { epoch, flights, cards };
        return model;
    }

    function getFlight(date, no) { return buildModel().flights.get(date + '|' + no) || null; }

    // ---------- снимок ----------
    function toSnapshot() {
        if (!rows.length && !salesCount) return null;
        return { v: 1, rows, sales };
    }

    function applySnapshot(snap) {
        sales = {};
        salesCount = 0;
        if (snap && Array.isArray(snap.rows)) {
            const seen = new Set();
            const next = [];
            snap.rows.forEach(r => {
                if (!Array.isArray(r) || r.length < 10) return;
                const k = r[0] + '|' + r[1] + '|' + r[2];
                if (seen.has(k)) return;
                seen.add(k);
                next.push(r);
            });
            rows = next;
        } else rows = [];
        if (snap && snap.sales && typeof snap.sales === 'object') {
            Object.keys(snap.sales).forEach(k => {
                const list = snap.sales[k];
                if (!Array.isArray(list) || !list.length) return;
                sales[k] = list.map(t => [String(t[0] || ''), String(t[1] || ''), String(t[2] || '')]);
                salesCount += list.length;
            });
        }
        salesEpoch++;
        bump();
    }

    return {
        parseText, classifyText, setRows, reset, hasData, hasSales, rowCount, ticketCount, getEpoch,
        isHeliFlight, beginSales, addTicket, endSales, flightSales, cityMap,
        model: buildModel, getFlight, toSnapshot, applySnapshot,
        points: { load: loadPoints, map: pointsSnapshot, name: pointName, has: hasPointName, save: savePoints, rev: pointsRevision, defaults, genitive, clean: { code: cleanCode, name: cleanName } },
        canon, genitive, dayStrings, fmtDate, dateTs
    };
})();
