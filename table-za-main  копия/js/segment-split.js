// Доп. посадка: в день, когда у рейса лишняя посадка (маршрут дня — не его обычный), участок,
// совпадающий с маршрутом другого нашего рейса, показывается в том рейсе строкой «доп.» со своим номером.
// Пример: KV-173 17.11 KCY-TGP-THX → участок KCY-TGP уходит в KV-171 строкой «KV-173 (ДОП)»;
// сквозной KCY-THX и участок без своего рейса TGP-THX остаются в KV-173.
// Билеты этого участка (по «откуда / куда» из файла продаж) — на свой ключ «дата|KV-173~KJA-TGP».
// Рейсы с посадками по расписанию не трогаются: их маршрут дня совпадает с обычным.
window.SegmentSplit = (function () {
    const SAME = { KCY: 'KJA' };                      // Черемшанка и Емельяново — один Красноярск
    const RU = { 'КЯА': 'KJA', 'КЯС': 'KJA' };        // остальные русские коды городов узнаём по продажам
    let moved = [];                                   // ушедшие в другой рейс: { row, key, seg }

    function lat(c) {
        const s = String(c || '').trim().toUpperCase();
        return SAME[s] || s;
    }

    function points(route) {
        return String(route || '').toUpperCase().split('-').map(s => s.trim()).filter(Boolean).map(lat);
    }

    // Разнести строки загрузки по рейсам (после группировки по номеру). Меняет grouped на месте.
    function splitRows(grouped) {
        moved = [];
        const bases = Object.keys(grouped);
        bases.forEach(b => grouped[b].forEach(r => { delete r.segKey; delete r.segRoute; delete r.segShare; }));

        // Один самолёт — одни расходы: у вылета с посадками расходы и субсидия считаются в одной строке
        // (сквозной участок, иначе первый), остальные участки помечены segShare.
        const byDep = new Map();
        bases.forEach(b => grouped[b].forEach(r => {
            if (points(r[3]).length < 3) return;
            const k = r[1] + '|' + cleanFlight(r[0]);
            if (!byDep.has(k)) byDep.set(k, []);
            byDep.get(k).push(r);
        }));
        byDep.forEach(list => {
            if (list.length < 2) return;
            const rp = points(list[0][3]);
            const through = rp[0] + '-' + rp[rp.length - 1];
            const segOf = r => points(typeof parseSegmentField === 'function' ? parseSegmentField(r[2]).route : '').join('-');
            const legsOf = r => (typeof parseSegmentField === 'function' ? parseSegmentField(r[2]).legs : '') || '9';
            const main = list.find(r => segOf(r) === through)
                || list.slice().sort((a, c) => legsOf(a).localeCompare(legsOf(c)))[0];
            list.forEach(r => { if (r !== main) r.segShare = true; });
        });

        // Обычный маршрут рейса — тот, которым он летит в большинство дней (у дня с посадками строк больше).
        const usual = Object.create(null);
        bases.forEach(b => {
            const days = new Map();
            grouped[b].forEach(r => {
                const rt = String(r[3] || '').trim().toUpperCase();
                if (!rt) return;
                if (!days.has(rt)) days.set(rt, new Set());
                days.get(rt).add(r[1]);
            });
            let best = '', n = 0;
            days.forEach((set, k) => { const v = set.size; if (v > n || (v === n && k < best)) { best = k; n = v; } });
            usual[b] = best;
        });
        // «KJA-TGP» → рейс, который обычно летит так без посадок.
        const byEnds = new Map();
        bases.forEach(b => {
            const p = points(usual[b]);
            if (p.length !== 2) return;
            const k = p.join('-');
            const cur = byEnds.get(k);
            if (!cur || grouped[b].length > grouped[cur].length) byEnds.set(k, b);
        });

        const moves = [];
        bases.forEach(b => {
            const up = points(usual[b]);
            const own = up.length >= 2 ? up[0] + '-' + up[up.length - 1] : '';
            const keep = [];
            grouped[b].forEach(r => {
                const rt = String(r[3] || '').trim().toUpperCase();
                if (points(rt).length < 3 || rt === usual[b]) { keep.push(r); return; }
                const seg = typeof parseSegmentField === 'function' ? parseSegmentField(r[2]).route : '';
                const sp = points(seg);
                const key = sp.length === 2 ? sp.join('-') : '';
                const to = key && key !== own ? byEnds.get(key) : null;
                if (!to || to === b) { keep.push(r); return; }
                moves.push({ r, to, key, seg: String(seg).toUpperCase() });
            });
            grouped[b] = keep;
        });
        const closed = typeof closedFlights !== 'undefined' && closedFlights ? closedFlights : null;
        moves.forEach(m => {
            m.r.segKey = m.key;
            m.r.segRoute = m.seg;
            grouped[m.to].push(m.r);
            const baseKey = m.r[1] + '|' + cleanFlight(m.r[0]);
            if (closed && closed.has(baseKey)) closed.add(baseKey + '~' + m.key);
            moved.push({ row: m.r, key: baseKey, seg: m.key });
        });
        return moves.length;
    }

    // Русский код города → латинский: по билетам рейсов без посадок (откуда/куда = концы маршрута).
    function cityMap(details) {
        const votes = new Map();
        const vote = (ru, la) => {
            if (!ru || !la || RU[ru]) return;
            if (!votes.has(ru)) votes.set(ru, new Map());
            const m = votes.get(ru);
            m.set(la, (m.get(la) || 0) + 1);
        };
        const g = typeof groupedData !== 'undefined' && groupedData ? groupedData : {};
        const seen = new Set();
        Object.keys(g).forEach(b => g[b].forEach(r => {
            if (r.segKey) return;
            const p = points(r[3]);
            if (p.length !== 2) return;
            const k = r[1] + '|' + cleanFlight(r[0]);
            if (seen.has(k)) return;
            seen.add(k);
            (details[k] || []).forEach(s => {
                vote(String(s.city1 || '').trim().toUpperCase(), p[0]);
                vote(String(s.city2 || '').trim().toUpperCase(), p[1]);
            });
        }));
        const map = Object.assign({}, RU);
        votes.forEach((m, ru) => {
            let best = '', n = 0;
            m.forEach((v, la) => { if (v > n) { best = la; n = v; } });
            map[ru] = best;
        });
        return map;
    }

    // Вернуть билеты участков на общий ключ рейса (перед сверкой продаж и повторным разносом).
    function unsplitSales(details) {
        let n = 0;
        Object.keys(details || {}).forEach(k => {
            const i = k.indexOf('~');
            if (i < 0) return;
            const base = k.slice(0, i);
            (details[base] || (details[base] = [])).push(...details[k]);
            n += details[k].length;
            delete details[k];
        });
        return n;
    }

    // Билеты ушедших участков — на ключ участка, по «откуда / куда» билета.
    function splitSales(details) {
        if (!details || !moved.length) return 0;
        // Список закрытых рейсов грузится параллельно с загрузкой — пометку «закрыт» участку ставим и здесь.
        const closed = typeof closedFlights !== 'undefined' && closedFlights ? closedFlights : null;
        if (closed) moved.forEach(m => { if (closed.has(m.key)) closed.add(m.key + '~' + m.seg); });
        const map = cityMap(details);
        let n = 0;
        moved.forEach(m => {
            const list = details[m.key];
            if (!list || !list.length) return;
            const keep = [], seg = [];
            list.forEach(s => {
                const a = map[String(s.city1 || '').trim().toUpperCase()];
                const b = map[String(s.city2 || '').trim().toUpperCase()];
                (a && b && a + '-' + b === m.seg ? seg : keep).push(s);
            });
            if (!seg.length) return;
            const sk = m.key + '~' + m.seg;
            details[sk] = (details[sk] || []).concat(seg);
            if (keep.length) details[m.key] = keep;
            else delete details[m.key];
            n += seg.length;
        });
        return n;
    }

    return { splitRows, unsplitSales, splitSales };
})();
