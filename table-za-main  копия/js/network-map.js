// Главная: географическая карта сети. Контур кэшируется, пульс рисует только верхний слой.
window.NetworkMap = (function () {
    const DEFAULT_VIEW = { lon0: 94, lat0: 58, lonMin: 78, lonMax: 114, latMin: 46.5, latMax: 75.5 };
    const WATER = '#c5d4e4';
    const LAND_RU = '#e8e2d4';
    const LAND_OTHER = '#dfe4dc';
    const HUB_NAVY = '#012A4A';

    let aggCache = { sig: '', data: null };
    let outline = null;
    let landPaths = null;
    let view = { scale: 1, tx: 0, ty: 0 };
    let hover = null;
    let selectedKey = null;
    let selectedCity = null;
    let period = null;
    let layer = 'load';
    let openOnly = true;
    let projected = { cities: [], lines: [], w: 0, h: 0 };
    let dragging = null;
    let pulseT = 0;
    let raf = 0;
    let canvas = null;
    let baseCanvas = null;
    let resizeObs = null;
    let baseDirty = true;
    let livePlanes = [];
    let estTimer = 0;
    let liveBindDirty = true;
    let lastPulseAt = 0;
    let geomDirty = true;
    let viewRaf = 0;

    window.networkMapFilter = window.networkMapFilter || null;

    function esc(s) {
        return typeof escHtml === 'function' ? escHtml(s) : String(s ?? '');
    }

    function cacheSig() {
        const ep = typeof dataEpoch !== 'undefined' ? dataEpoch : 0;
        return `${ep}|${period}|${openOnly ? 1 : 0}|${getTodayDate?.() || ''}`;
    }

    function weekDays() {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const named = ['Сегодня', 'Завтра', 'Послезавтра'];
        const wd = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
        const days = [];
        for (let i = 0; i < 7; i++) {
            const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
            const date = typeof formatDateRu === 'function'
                ? formatDateRu(d)
                : `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
            days.push({
                date,
                name: named[i] || wd[d.getDay()],
                short: date.slice(0, 5)
            });
        }
        return days;
    }

    function syncPeriod(p) {
        const days = weekDays();
        if (p === 'file') return 'file';
        if (p && days.some(d => d.date === p)) return p;
        return days[0].date;
    }

    function periodCaption() {
        if (period === 'file') return 'Период файла';
        const hit = weekDays().find(d => d.date === period);
        if (hit) return `${hit.name} · ${hit.short}`;
        return period || 'Сегодня';
    }

    function isLiveDay() {
        const today = typeof getTodayDate === 'function' ? getTodayDate() : '';
        return !!today && period === today;
    }

    function periodButtonsHtml() {
        const days = weekDays().map(d =>
            `<button type="button" data-period="${esc(d.date)}" title="${esc(d.date)}"><span>${esc(d.name)}</span><span class="nmap-day-date">${esc(d.short)}</span></button>`
        ).join('');
        return days + '<button type="button" data-period="file">Весь период файла</button>';
    }

    function inPeriod(row) {
        const date = row[1];
        if (!date) return false;
        if (period === 'file') return true;
        return date === period;
    }

    function emptyLeg() {
        return { n: 0, au: 0, sold: 0, avs: 0, zpkSum: 0, zpkN: 0, closed: 0, open: 0, nearest: null, flights: [] };
    }

    function addLeg(leg, m, orig, avsVal) {
        const au = m.au != null ? m.au : (m.total || 0);
        const sold = m.free || 0;
        const avs = avsVal || 0;
        const denom = Math.max(0, au - avs);
        const zpk = denom > 0 ? sold / denom : null;
        leg.n++;
        leg.au += au;
        leg.sold += sold;
        leg.avs += avs;
        if (zpk != null && Number.isFinite(zpk)) {
            leg.zpkSum += zpk;
            leg.zpkN++;
        }
        if (m.closed) leg.closed++;
        else leg.open++;
        if (!leg.nearest || (m.dtd != null && (leg.nearest.dtd == null || m.dtd < leg.nearest.dtd))) {
            leg.nearest = { date: m.date, dtd: m.dtd, orig };
        }
        if (orig && !leg.flights.includes(orig)) leg.flights.push(orig);
    }

    function legAvg(leg) {
        if (!leg || !leg.zpkN) return null;
        return Math.round((leg.zpkSum / leg.zpkN) * 100);
    }

    function pointId(p) {
        return (p && (p.city || p.code)) || '';
    }

    function pairKey(a, b) {
        const ca = pointId(a);
        const cb = pointId(b);
        return ca < cb ? `${ca}|${cb}` : `${cb}|${ca}`;
    }

    function buildAggregate() {
        const sig = cacheSig();
        if (aggCache.sig === sig && aggCache.data) return aggCache.data;
        const today = typeof getTodayDate === 'function' ? getTodayDate() : '';
        let yesterday = '';
        if (today && typeof parseLocalDate === 'function') {
            const yd = parseLocalDate(today);
            if (yd) {
                yd.setDate(yd.getDate() - 1);
                yesterday = typeof formatDateRu === 'function'
                    ? formatDateRu(yd)
                    : `${String(yd.getDate()).padStart(2, '0')}.${String(yd.getMonth() + 1).padStart(2, '0')}.${yd.getFullYear()}`;
            }
        }
        const lines = {};
        const cities = {};
        const unknown = new Set();
        const flightCodes = new Set();
        const todayLegs = [];
        const geo = window.GEO_AIRPORTS;

        Object.keys(groupedData || {}).forEach(base => {
            (groupedData[base] || []).forEach(row => {
                if (!row || !row[1]) return;
                const liveYest = period === today && yesterday && row[1] === yesterday;
                if (!inPeriod(row) && !liveYest) return;
                const orig = typeof cleanFlight === 'function' ? cleanFlight(row[0]) : row[0];
                if (orig) {
                    flightCodes.add(orig);
                    if (typeof getBaseFlight === 'function') flightCodes.add(getBaseFlight(orig));
                }
                const m = typeof getRowMetrics === 'function' ? getRowMetrics(row, base) : null;
                if (!m) return;
                const ep = geo ? geo.endpointsFromRow(row, orig) : { a: null, b: null, unknown: [] };
                (ep.unknown || []).forEach(u => unknown.add(u));
                if (!ep.a || !ep.b) return;
                if (pointId(ep.a) === pointId(ep.b)) return;
                if (!m.closed && (m.date === today || liveYest)) {
                    todayLegs.push({
                        orig,
                        date: m.date,
                        dep: row[11],
                        arr: row[12],
                        from: ep.a,
                        to: ep.b,
                        ac: row[4]
                    });
                }
                if (liveYest) return;
                if (openOnly && (m.closed || m.flew)) return;
                const key = pairKey(ep.a, ep.b);
                if (!lines[key]) {
                    const [left, right] = pointId(ep.a) < pointId(ep.b) ? [ep.a, ep.b] : [ep.b, ep.a];
                    lines[key] = { key, a: left, b: right, ab: emptyLeg(), ba: emptyLeg(), today: false };
                }
                const line = lines[key];
                const fromIsA = pointId(ep.a) === pointId(line.a);
                const avs = typeof getSpecBookings === 'function' ? getSpecBookings(row) : 0;
                addLeg(fromIsA ? line.ab : line.ba, m, orig, avs);
                if (m.date === today && !m.flew) line.today = true;

                [ep.a, ep.b].forEach(pt => {
                    const ck = pointId(pt);
                    if (!cities[ck]) cities[ck] = { ...pt, today: false, n: 0 };
                    cities[ck].n++;
                    if (m.date === today && !m.flew) cities[ck].today = true;
                });
            });
        });

        const list = Object.values(lines).map(line => {
            const n = line.ab.n + line.ba.n;
            const au = line.ab.au + line.ba.au;
            const sold = line.ab.sold + line.ba.sold;
            const avs = line.ab.avs + line.ba.avs;
            const zpkN = line.ab.zpkN + line.ba.zpkN;
            const zpkSum = line.ab.zpkSum + line.ba.zpkSum;
            const avgZpk = zpkN ? Math.round((zpkSum / zpkN) * 100) : null;
            const allClosed = n > 0 && line.ab.open + line.ba.open === 0;
            const remain = Math.max(0, au - sold - avs);
            const zpkAb = legAvg(line.ab);
            const zpkBa = legAvg(line.ba);
            const nearest = [line.ab.nearest, line.ba.nearest].filter(Boolean).sort((x, y) => (x.dtd ?? 99) - (y.dtd ?? 99))[0] || null;
            const dtd = nearest ? nearest.dtd : null;
            const problem = avgZpk != null && avgZpk < 50 && dtd != null && dtd <= 7;
            const flights = [...line.ab.flights, ...line.ba.flights];
            return {
                ...line, n, au, sold, avs, remain, avgZpk, allClosed, zpkAb, zpkBa, nearest, dtd, problem, flights
            };
        });

        const cityList = Object.values(cities);
        const data = {
            lines: list,
            cities: cityList,
            unknown: [...unknown],
            hasToday: cityList.some(c => c.today),
            flightCodes,
            todayLegs
        };
        aggCache = { sig, data };
        return data;
    }

    function zpkColor(pct) {
        if (pct == null) return '#94a3b8';
        const t = Math.max(0, Math.min(1, pct / 100));
        const stops = [
            [0, [185, 28, 28]],
            [0.45, [202, 138, 4]],
            [1, [4, 120, 87]]
        ];
        let a = stops[0], b = stops[stops.length - 1];
        for (let i = 1; i < stops.length; i++) {
            if (t <= stops[i][0]) { a = stops[i - 1]; b = stops[i]; break; }
        }
        const u = (t - a[0]) / Math.max(0.001, b[0] - a[0]);
        const r = Math.round(a[1][0] + (b[1][0] - a[1][0]) * u);
        const g = Math.round(a[1][1] + (b[1][1] - a[1][1]) * u);
        const bl = Math.round(a[1][2] + (b[1][2] - a[1][2]) * u);
        return `rgb(${r},${g},${bl})`;
    }

    const PHI1 = 50 * Math.PI / 180, PHI2 = 70 * Math.PI / 180, PHI0 = 56 * Math.PI / 180, LAM0 = 95 * Math.PI / 180;
    const N_ALB = 0.5 * (Math.sin(PHI1) + Math.sin(PHI2));
    const C_ALB = Math.cos(PHI1) * Math.cos(PHI1) + 2 * N_ALB * Math.sin(PHI1);
    const RHO0 = Math.sqrt(C_ALB - 2 * N_ALB * Math.sin(PHI0)) / N_ALB;

    function projectLonLat(lon, lat) {
        const lam = lon * Math.PI / 180;
        const phi = lat * Math.PI / 180;
        const rho = Math.sqrt(Math.max(0, C_ALB - 2 * N_ALB * Math.sin(phi))) / N_ALB;
        const theta = N_ALB * (lam - LAM0);
        return { x: rho * Math.sin(theta), y: RHO0 - rho * Math.cos(theta) };
    }

    function toScreen(pt) {
        return { x: pt.x * view.scale + view.tx, y: -pt.y * view.scale + view.ty };
    }

    function bboxPoints(pts) {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        pts.forEach(p => {
            if (p.x < minX) minX = p.x;
            if (p.x > maxX) maxX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.y > maxY) maxY = p.y;
        });
        return { minX, maxX, minY, maxY };
    }

    function defaultBBox() {
        const sw = projectLonLat(DEFAULT_VIEW.lonMin, DEFAULT_VIEW.latMin);
        const ne = projectLonLat(DEFAULT_VIEW.lonMax, DEFAULT_VIEW.latMax);
        const nw = projectLonLat(DEFAULT_VIEW.lonMin, DEFAULT_VIEW.latMax);
        const se = projectLonLat(DEFAULT_VIEW.lonMax, DEFAULT_VIEW.latMin);
        return bboxPoints([sw, ne, nw, se]);
    }

    function applyBBox(box, w, h) {
        const pad = 36;
        const dx = Math.max(0.001, box.maxX - box.minX);
        const dy = Math.max(0.001, box.maxY - box.minY);
        const sx = (w - pad * 2) / dx;
        const sy = (h - pad * 2) / dy;
        const scale = Math.min(sx, sy);
        if (!Number.isFinite(scale) || scale <= 0) return;
        view.scale = scale;
        view.baseScale = scale;
        view.tx = pad - box.minX * scale + (w - pad * 2 - dx * scale) / 2;
        view.ty = pad + box.maxY * scale + (h - pad * 2 - dy * scale) / 2;
        view._fitted = true;
        baseDirty = true;
        syncZoomLabel();
    }

    function fitView(w, h) {
        applyBBox(defaultBBox(), w, h);
    }

    function zoomAt(sx, sy, factor) {
        const base = view.baseScale || view.scale || 1;
        const next = Math.max(base * 0.35, Math.min(base * 16, view.scale * factor));
        if (!Number.isFinite(next) || next <= 0) return;
        const k = next / view.scale;
        view.tx = sx - (sx - view.tx) * k;
        view.ty = sy - (sy - view.ty) * k;
        view.scale = next;
        baseDirty = true;
        syncZoomLabel();
        requestViewRedraw();
    }

    function requestViewRedraw() {
        if (viewRaf) return;
        viewRaf = requestAnimationFrame(() => {
            viewRaf = 0;
            redraw('all');
        });
    }

    function syncProjectedScreen() {
        const vs = view.scale, tx = view.tx, ty = view.ty;
        if (projected._vs === vs && projected._tx === tx && projected._ty === ty) return;
        projected._vs = vs;
        projected._tx = tx;
        projected._ty = ty;
        (projected.lines || []).forEach(it => {
            if (!it.pa || !it.pb || !it.ctrlW) return;
            const a = toScreen(it.pa);
            const b = toScreen(it.pb);
            const ctrl = toScreen(it.ctrlW);
            it.a = a;
            it.b = b;
            const prev = it.arcs && it.arcs[0];
            it.arcs = [{
                a, b, ctrl,
                zpk: prev ? prev.zpk : it.l.avgZpk,
                closed: prev ? prev.closed : it.l.allClosed,
                fromCity: it.l.a.city,
                toCity: it.l.b.city
            }];
        });
        const used = [];
        (projected.cities || []).forEach(it => {
            const pw = it.pw || (it.c ? projectLonLat(it.c.lon, it.c.lat) : null);
            if (!pw) return;
            it.pw = pw;
            it.p = toScreen(pw);
            it.lx = it.p.x + 9;
            it.ly = it.p.y - 9;
            used.forEach(u => {
                if (Math.abs(u.x - it.lx) < 72 && Math.abs(u.y - it.ly) < 13) it.ly -= 13;
            });
            used.push({ x: it.lx, y: it.ly });
        });
    }

    function syncZoomLabel() {
        const el = document.getElementById('nmap-zoom-val');
        if (!el) return;
        const base = view.baseScale || view.scale || 1;
        el.textContent = Math.round((view.scale / base) * 100) + '%';
    }

    function ringInFrame(ring) {
        for (let i = 0; i < ring.length; i++) {
            const lon = ring[i][0], lat = ring[i][1];
            if (lon >= 68 && lon <= 132 && lat >= 42 && lat <= 78) return true;
        }
        return false;
    }

    function addPolyToPath(path, poly) {
        poly.forEach(ring => {
            ring.forEach((c, i) => {
                const p = projectLonLat(c[0], c[1]);
                if (i === 0) path.moveTo(p.x, -p.y);
                else path.lineTo(p.x, -p.y);
            });
            path.closePath();
        });
    }

    function ensureLandPaths() {
        const fc = outline || window.GEO_OUTLINE_FALLBACK;
        if (!fc || !fc.features) {
            landPaths = null;
            return;
        }
        if (landPaths && landPaths.src === fc) return;
        const ru = new Path2D();
        const other = new Path2D();
        fc.features.forEach(f => {
            const isRu = f.id === 'RUS' || f.properties?.name === 'Russia';
            const target = isRu ? ru : other;
            const geom = f.geometry;
            if (!geom) return;
            const polys = geom.type === 'Polygon' ? [geom.coordinates] : (geom.coordinates || []);
            polys.forEach(poly => {
                if (!poly || !poly[0] || !ringInFrame(poly[0])) return;
                addPolyToPath(target, poly);
            });
        });
        landPaths = { ru, other, src: fc };
    }

    function syncCanvasSize(cv, w, h, dpr) {
        if (!cv) return false;
        const tw = Math.round(w * dpr);
        const th = Math.round(h * dpr);
        if (cv.width !== tw || cv.height !== th) {
            cv.width = tw;
            cv.height = th;
            return true;
        }
        return false;
    }

    function drawBase(w, h, dpr) {
        if (!baseCanvas) return;
        const ctx = baseCanvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = WATER;
        ctx.fillRect(0, 0, w, h);
        const vg = ctx.createLinearGradient(0, 0, 0, h);
        vg.addColorStop(0, 'rgba(255,255,255,0.18)');
        vg.addColorStop(0.55, 'rgba(255,255,255,0)');
        vg.addColorStop(1, 'rgba(1,42,74,0.06)');
        ctx.fillStyle = vg;
        ctx.fillRect(0, 0, w, h);

        ensureLandPaths();
        if (!landPaths) return;
        ctx.save();
        ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.tx, dpr * view.ty);
        ctx.fillStyle = LAND_OTHER;
        ctx.fill(landPaths.other, 'evenodd');
        ctx.fillStyle = LAND_RU;
        ctx.fill(landPaths.ru, 'evenodd');
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.strokeStyle = 'rgba(1,42,74,0.34)';
        ctx.lineWidth = 1.2 / view.scale;
        ctx.stroke(landPaths.ru);
        ctx.strokeStyle = 'rgba(71,85,105,0.22)';
        ctx.lineWidth = 0.9 / view.scale;
        ctx.stroke(landPaths.other);
        ctx.restore();
        baseDirty = false;
    }

    function visibleLines(data) {
        let list = data.lines;
        if (layer === 'problem') list = list.filter(l => l.problem);
        return list;
    }

    function qPoint(a, c, b, t) {
        const u = 1 - t;
        return {
            x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
            y: u * u * a.y + 2 * u * t * c.y + t * t * b.y
        };
    }

    function qTan(a, c, b, t) {
        return {
            dx: 2 * (1 - t) * (c.x - a.x) + 2 * t * (b.x - c.x),
            dy: 2 * (1 - t) * (c.y - a.y) + 2 * t * (b.y - c.y)
        };
    }

    function lineTouchesCity(l, city) {
        if (!city || !l) return false;
        return l.a.city === city || l.b.city === city || l.a.code === city || l.b.code === city;
    }

    function lineMode(l) {
        const hoverCity = hover && hover.type === 'city' ? hover.city.city : null;
        const hoverLine = hover && (hover.type === 'line' || hover.type === 'arc' || hover.type === 'plane')
            ? (hover.line ? hover.line.key : hover.key)
            : null;
        if (selectedKey === l.key || hoverLine === l.key) return 'hot';
        if (selectedCity && lineTouchesCity(l, selectedCity)) return 'hot';
        if (hoverCity && lineTouchesCity(l, hoverCity)) return 'hot';
        if (selectedKey || selectedCity) return 'dim';
        return 'normal';
    }

    function angleDiff(a, b) {
        let d = Math.abs(a - b);
        if (d > Math.PI) d = 2 * Math.PI - d;
        return d;
    }

    function rebuildProjected(data, w, h) {
        let hubP = null;
        (data.cities || []).some(c => {
            if (!isHubName(c.city)) return false;
            hubP = projectLonLat(c.lon, c.lat);
            return true;
        });
        const raw = visibleLines(data).map(l => {
            const pa = projectLonLat(l.a.lon, l.a.lat);
            const pb = projectLonLat(l.b.lon, l.b.lat);
            const dx = pb.x - pa.x, dy = pb.y - pa.y;
            const lenP = Math.hypot(dx, dy) || 1;
            return {
                l, pa, pb, lenP,
                ang: Math.atan2(dy, dx),
                a: toScreen(pa),
                b: toScreen(pb)
            };
        });
        raw.forEach(it => {
            const sibs = raw.filter(o => {
                if (o.l.a.city !== it.l.a.city && o.l.a.city !== it.l.b.city
                    && o.l.b.city !== it.l.a.city && o.l.b.city !== it.l.b.city) return false;
                return angleDiff(it.ang, o.ang) < 0.38;
            }).sort((x, y) => x.lenP - y.lenP || x.l.key.localeCompare(y.l.key));
            it.fan = Math.max(0, sibs.findIndex(s => s.l.key === it.l.key));
        });
        raw.forEach(it => {
            const { pa, pb, lenP, fan, l } = it;
            const dx = pb.x - pa.x, dy = pb.y - pa.y;
            let nx = -dy / lenP, ny = dx / lenP;
            const mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2;
            if (hubP) {
                if (nx * (mx - hubP.x) + ny * (my - hubP.y) < 0) {
                    nx = -nx;
                    ny = -ny;
                }
            } else if (ny < 0) {
                nx = -nx;
                ny = -ny;
            }
            const mag = lenP * (0.13 + fan * 0.05);
            const ctrlW = { x: mx + nx * mag, y: my + ny * mag };
            const a = toScreen(pa);
            const b = toScreen(pb);
            const ctrl = toScreen(ctrlW);
            it.ctrlW = ctrlW;
            it.a = a;
            it.b = b;
            it.arcs = [{
                a, b, ctrl,
                zpk: l.avgZpk,
                closed: l.allClosed,
                fromCity: l.a.city,
                toCity: l.b.city
            }];
        });
        const used = [];
        const onScreen = new Set();
        raw.forEach(item => {
            onScreen.add(pointId(item.l.a));
            onScreen.add(pointId(item.l.b));
        });
        const citySrc = layer === 'problem'
            ? data.cities.filter(c => onScreen.has(pointId(c)))
            : data.cities;
        const cities = citySrc.map(c => {
            const pw = projectLonLat(c.lon, c.lat);
            const p = toScreen(pw);
            let lx = p.x + 9;
            let ly = p.y - 9;
            used.forEach(u => {
                if (Math.abs(u.x - lx) < 72 && Math.abs(u.y - ly) < 13) ly -= 13;
            });
            used.push({ x: lx, y: ly });
            return { c: { ...c, hub: isHubName(c.city) }, p, pw, lx, ly };
        });
        projected = { w, h, lines: raw, cities, _vs: view.scale, _tx: view.tx, _ty: view.ty };
        geomDirty = false;
    }

    function strokeArc(ctx, arc, mode) {
        const color = mode === 'dim' ? 'rgba(1,42,74,0.10)' : zpkColor(arc.zpk);
        const width = mode === 'hot' ? 2.8 : (mode === 'dim' ? 1.15 : 1.65);
        ctx.beginPath();
        ctx.moveTo(arc.a.x, arc.a.y);
        ctx.quadraticCurveTo(arc.ctrl.x, arc.ctrl.y, arc.b.x, arc.b.y);
        ctx.setLineDash(arc.closed ? [5, 5] : []);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        if (mode === 'hot') {
            ctx.strokeStyle = 'rgba(255,255,255,0.75)';
            ctx.lineWidth = width + 2.2;
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(arc.a.x, arc.a.y);
            ctx.quadraticCurveTo(arc.ctrl.x, arc.ctrl.y, arc.b.x, arc.b.y);
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.globalAlpha = mode === 'normal' ? 0.92 : 1;
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.setLineDash([]);
    }

    function cityNameFromIata(code) {
        if (!code || !window.GEO_AIRPORTS) return '';
        const hit = GEO_AIRPORTS.lookupCode(code);
        return (hit && hit.city) || '';
    }

    function screenHeading(lon, lat, hdg) {
        const rad = (hdg || 0) * Math.PI / 180;
        const a = toScreen(projectLonLat(lon, lat));
        const b = toScreen(projectLonLat(
            lon + Math.sin(rad) * 0.25,
            lat + Math.cos(rad) * 0.25
        ));
        return Math.atan2(b.y - a.y, b.x - a.x);
    }

    function normIata(code) {
        const c = String(code || '').toUpperCase();
        return c === 'KCY' ? 'KJA' : c;
    }

    function sameCity(a, b) {
        if (!a || !b) return false;
        if (typeof cityMatchKey === 'function') {
            const ca = typeof canonicalCityName === 'function' ? canonicalCityName(a) : a;
            const cb = typeof canonicalCityName === 'function' ? canonicalCityName(b) : b;
            return cityMatchKey(ca) === cityMatchKey(cb);
        }
        return String(a) === String(b);
    }

    function bookRoute(flight) {
        if (!flight || typeof getCitiesFromFlight !== 'function') return null;
        const cities = getCitiesFromFlight(flight);
        if (!cities || cities.length < 2) return null;
        return { from: cities[0], to: cities[cities.length - 1], flight };
    }

    function matchPlaneToLine(p, lines) {
        const book = bookRoute(p.flight);
        if (book) {
            for (let i = 0; i < lines.length; i++) {
                const l = lines[i].l;
                const hit = (sameCity(l.a.city, book.from) && sameCity(l.b.city, book.to))
                    || (sameCity(l.a.city, book.to) && sameCity(l.b.city, book.from));
                if (!hit) continue;
                const fromA = sameCity(l.a.city, book.from);
                return { item: lines[i], fromA, fromCity: book.from, toCity: book.to };
            }
            return { item: null, fromA: true, fromCity: book.from, toCity: book.to };
        }
        const orig = normIata(p.orig);
        const dest = normIata(p.dest);
        if (orig && dest) {
            for (let i = 0; i < lines.length; i++) {
                const l = lines[i].l;
                const ca = normIata(l.a.code);
                const cb = normIata(l.b.code);
                if (orig === ca && dest === cb) {
                    return { item: lines[i], fromA: true, fromCity: l.a.city, toCity: l.b.city };
                }
                if (orig === cb && dest === ca) {
                    return { item: lines[i], fromA: false, fromCity: l.b.city, toCity: l.a.city };
                }
            }
        }
        return null;
    }

    function flightOnBoard(code) {
        if (!code) return false;
        const allowed = (aggCache.data && aggCache.data.flightCodes) || new Set();
        if (allowed.has(code)) return true;
        const base = typeof getBaseFlight === 'function' ? getBaseFlight(code) : '';
        if (base && allowed.has(base)) return true;
        if (base) {
            for (const f of allowed) {
                if (typeof getBaseFlight === 'function' && getBaseFlight(f) === base) return true;
            }
        }
        return false;
    }

    function parseHm(val) {
        if (val == null || val === '') return null;
        if (typeof timeToMinutes === 'function') {
            const n = timeToMinutes(val);
            if (Number.isFinite(n) && n >= 0 && n < 24 * 60) return n;
        }
        const s = String(val).trim();
        let m = s.match(/(\d{1,2})[:.](\d{2})/);
        if (m) return (+m[1]) * 60 + (+m[2]);
        m = s.match(/^(\d{3,4})$/);
        if (m) {
            const v = m[1].padStart(4, '0');
            return (+v.slice(0, 2)) * 60 + (+v.slice(2));
        }
        return null;
    }

    const CITY_UTC_HOURS = {
        'Таксимо': 8, 'Олекминск': 9, 'Ербогачен': 8, 'Чара': 9,
        'Нижневартовск': 5, 'Стрежевой': 5, 'Улан-Удэ': 8, 'Улан-Батор': 8,
        'Ленск': 9, 'Талакан': 9, 'Полярный': 9, 'Нижнеангарск': 8
    };

    function utcHoursForPoint(pt) {
        const code = String((pt && pt.code) || '').toUpperCase();
        if (code === 'KCY') return utcHoursForPoint({ code: 'KJA', city: 'Красноярск' });
        if (code && typeof timelineAirportUtc === 'function') return timelineAirportUtc(code);
        const city = (pt && pt.city) || '';
        if (city && window.GEO_AIRPORTS) {
            const hit = GEO_AIRPORTS.lookupCity(city);
            if (hit && hit.code && typeof timelineAirportUtc === 'function') {
                return timelineAirportUtc(hit.code);
            }
        }
        if (CITY_UTC_HOURS[city] != null) return CITY_UTC_HOURS[city];
        return 7;
    }

    function airportUtcMin(ptOrCode) {
        if (ptOrCode && typeof ptOrCode === 'object') return utcHoursForPoint(ptOrCode) * 60;
        if (typeof timelineAirportUtc === 'function') return timelineAirportUtc(ptOrCode) * 60;
        return 7 * 60;
    }

    function wallToUtcMs(dateStr, hmMin, ptOrCode) {
        const d = typeof parseLocalDate === 'function' ? parseLocalDate(dateStr) : null;
        if (!d || hmMin == null) return null;
        return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0)
            + hmMin * 60000
            - airportUtcMin(ptOrCode) * 60000;
    }

    function gcKm(a, b) {
        if (!a || !b) return 0;
        const R = 6371;
        const p1 = a.lat * Math.PI / 180, p2 = b.lat * Math.PI / 180;
        const dlat = p2 - p1, dlon = (b.lon - a.lon) * Math.PI / 180;
        const x = Math.sin(dlat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dlon / 2) ** 2;
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
    }

    function cruiseKmh(ac) {
        const t = String(typeof getAircraftType === 'function' ? getAircraftType(ac) : ac || '').toUpperCase();
        if (t.includes('ATR-72') || t.includes('AT7')) return 460;
        if (t.includes('ATR') || t.includes('AT4')) return 430;
        if (t.includes('ЯК-42') || t.includes('YK2') || t.includes('YAK')) return 700;
        if (t.includes('АН-26') || t.includes('AN-26')) return 420;
        if (t.includes('АН-24') || t.includes('AN-24')) return 400;
        return 480;
    }

    function lerpGeo(a, b, t) {
        return {
            lat: a.lat + (b.lat - a.lat) * t,
            lon: a.lon + (b.lon - a.lon) * t
        };
    }

    function buildEstimatedPlanes() {
        if (!isLiveDay()) return [];
        const legs = (aggCache.data && aggCache.data.todayLegs) || [];
        const now = Date.now();
        const out = [];
        legs.forEach(leg => {
            const from = leg.from, to = leg.to;
            if (!from || !to) return;
            const depHm = parseHm(leg.dep);
            if (depHm == null) return;
            let depMs = wallToUtcMs(leg.date, depHm, from);
            if (depMs == null) return;
            let arrHm = parseHm(leg.arr);
            const dist = gcKm(from, to);
            const blockMs = Math.max(25 * 60000, (dist / cruiseKmh(leg.ac)) * 3600000 + 20 * 60000);
            let arrMs = arrHm != null ? wallToUtcMs(leg.date, arrHm, to) : depMs + blockMs;
            if (arrMs != null && arrMs <= depMs) arrMs += 86400000;
            if (arrMs - depMs < 20 * 60000) arrMs = depMs + blockMs;
            const taxi = 8 * 60000;
            const after = 18 * 60000;
            if (now < depMs - 12 * 60000) return;
            if (now > arrMs + after) return;
            let gnd = false;
            let t = 0;
            if (now <= depMs + taxi) {
                gnd = true;
                t = 0.02;
            } else if (now >= arrMs) {
                gnd = true;
                t = 0.98;
            } else {
                const air0 = depMs + taxi;
                const air1 = Math.max(air0 + 60000, arrMs - 6 * 60000);
                let u = (now - air0) / (air1 - air0);
                u = Math.max(0, Math.min(1, u));
                u = u * u * (3 - 2 * u);
                t = 0.06 + 0.88 * u;
            }
            const geo = lerpGeo(from, to, t);
            out.push({
                id: 'est:' + leg.orig + ':' + leg.date,
                flight: leg.orig,
                lat: geo.lat,
                lon: geo.lon,
                hdg: 0,
                alt: gnd ? 0 : 18000,
                spd: gnd ? 0 : cruiseKmh(leg.ac) / 1.852,
                orig: from.code || '',
                dest: to.code || '',
                callsign: leg.orig,
                gnd,
                estimated: true,
                at: now
            });
        });
        return out;
    }

    function applyLivePlanes(radarList) {
        const radar = (radarList || []).filter(p => flightOnBoard(p.flight));
        const seen = new Set();
        radar.forEach(p => {
            if (p.flight) {
                seen.add(p.flight);
                if (typeof getBaseFlight === 'function') seen.add(getBaseFlight(p.flight));
            }
        });
        const extra = buildEstimatedPlanes().filter(p => {
            if (seen.has(p.flight)) return false;
            const base = typeof getBaseFlight === 'function' ? getBaseFlight(p.flight) : '';
            return !(base && seen.has(base));
        });
        livePlanes = radar.concat(extra);
        liveBindDirty = true;
    }

    function startEstTick() {
        if (estTimer) return;
        estTimer = setInterval(() => {
            if (!isLiveDay() || !canvas) return;
            if (typeof currentTab !== 'undefined' && currentTab !== 'home') return;
            if (dragging && dragging.moved) return;
            applyLivePlanes(window.LiveKvFlights ? LiveKvFlights.getPlanes() : []);
            updateLiveBadge();
            redraw('overlay');
        }, 2500);
    }

    function stopEstTick() {
        if (estTimer) {
            clearInterval(estTimer);
            estTimer = 0;
        }
    }

    function bindLiveToLines() {
        const lines = projected.lines || [];
        livePlanes = livePlanes.filter(p => flightOnBoard(p.flight));
        livePlanes.forEach(p => {
            p._bind = matchPlaneToLine(p, lines);
        });
    }

    function geoProgress(from, to, lat, lon) {
        const dx = to.lon - from.lon, dy = to.lat - from.lat;
        const l2 = dx * dx + dy * dy || 1;
        return Math.max(0.06, Math.min(0.94, ((lon - from.lon) * dx + (lat - from.lat) * dy) / l2));
    }

    function planeDestCity(p) {
        const book = bookRoute(p.flight);
        if (book) return book.to;
        if (p._bind && p._bind.toCity) return p._bind.toCity;
        return cityNameFromIata(p.dest) || '';
    }

    function livePlaneLabel(p) {
        const code = p.flight || p.callsign || p.reg || 'KV';
        const book = bookRoute(p.flight);
        const route = book
            ? `${book.from} → ${book.to}`
            : (p._bind && p._bind.fromCity
                ? `${p._bind.fromCity} → ${p._bind.toCity}`
                : '');
        const alt = p.gnd ? 'на земле' : (p.estimated ? '' : (p.alt > 50 ? Math.round(p.alt / 100) * 100 + ' ft' : ''));
        const src = p.estimated ? 'по расписанию' : '';
        return [code, route, alt, src].filter(Boolean).join(' · ');
    }

    function liveScreenPos(raw) {
        const cur = window.LiveKvFlights ? LiveKvFlights.extrapolate(raw, Date.now()) : raw;
        const bind = raw._bind;
        if (!cur.gnd && bind && bind.item && bind.item.arcs && bind.item.arcs[0]) {
            const l = bind.item.l;
            const from = bind.fromA ? l.a : l.b;
            const to = bind.fromA ? l.b : l.a;
            let t = geoProgress(from, to, cur.lat, cur.lon);
            if (!bind.fromA) t = 1 - t;
            const arc = bind.item.arcs[0];
            const s = qPoint(arc.a, arc.ctrl, arc.b, t);
            const tan = qTan(arc.a, arc.ctrl, arc.b, t);
            let rot = Math.atan2(tan.dy, tan.dx);
            if (!bind.fromA) rot += Math.PI;
            return { p: cur, s, bind, rot, t };
        }
        return { p: cur, s: toScreen(projectLonLat(cur.lon, cur.lat)), bind, rot: null };
    }

    function drawLivePlanes(ctx) {
        if (!isLiveDay() || !livePlanes.length) return;
        livePlanes.forEach(raw => {
            const pos = liveScreenPos(raw);
            const { p, s } = pos;
            ctx.save();
            ctx.translate(s.x, s.y);
            const est = !!raw.estimated;
            if (p.gnd) {
                ctx.beginPath();
                ctx.arc(0, 0, 5, 0, Math.PI * 2);
                ctx.fillStyle = est ? '#64748b' : '#78716c';
                ctx.fill();
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 1.2;
                ctx.stroke();
            } else {
                const rot = pos.rot != null ? pos.rot : screenHeading(p.lon, p.lat, p.hdg);
                ctx.rotate(rot + Math.PI / 2);
                ctx.beginPath();
                ctx.moveTo(0, -9);
                ctx.lineTo(6.5, 8);
                ctx.lineTo(0, 4.5);
                ctx.lineTo(-6.5, 8);
                ctx.closePath();
                ctx.fillStyle = est ? HUB_NAVY : '#c2410c';
                ctx.fill();
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 1.2;
                ctx.stroke();
            }
            ctx.restore();
            const dest = planeDestCity(raw);
            const tag = dest && raw.flight
                ? raw.flight + ' → ' + dest + (est ? ' · расп.' : '')
                : (raw.flight || p.callsign || p.reg || '');
            if (!tag) return;
            ctx.font = '700 10px Inter, system-ui, sans-serif';
            const tw = ctx.measureText(tag).width;
            ctx.fillStyle = p.gnd
                ? 'rgba(87,83,78,0.92)'
                : (est ? 'rgba(1,42,74,0.92)' : 'rgba(194,65,12,0.92)');
            ctx.fillRect(s.x + 8, s.y - 12, tw + 6, 13);
            ctx.fillStyle = '#fff';
            ctx.fillText(tag, s.x + 11, s.y - 2);
        });
    }

    function drawData(ctx) {
        const { lines, cities } = projected;
        const later = [];
        const hotCities = new Set();
        if (selectedKey) {
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].l.key === selectedKey) {
                    hotCities.add(lines[i].l.a.city);
                    hotCities.add(lines[i].l.b.city);
                    break;
                }
            }
        }
        if (selectedCity) hotCities.add(selectedCity);
        if (hover && hover.type === 'city') hotCities.add(hover.city.city);
        if (hover && hover.line) {
            hotCities.add(hover.line.a.city);
            hotCities.add(hover.line.b.city);
        }
        for (let i = 0; i < lines.length; i++) {
            const item = lines[i];
            const mode = lineMode(item.l);
            if (mode === 'hot') later.push(item);
            else item.arcs.forEach(arc => strokeArc(ctx, arc, mode));
        }
        for (let i = 0; i < later.length; i++) {
            later[i].arcs.forEach(arc => strokeArc(ctx, arc, 'hot'));
        }
        cities.forEach(item => {
            const { c, p, lx, ly } = item;
            const hub = !!c.hub;
            const on = hotCities.has(c.city);
            if (hub) {
                ctx.beginPath();
                ctx.arc(p.x, p.y, on ? 11 : 9.2, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(1,42,74,0.14)';
                ctx.fill();
            }
            const r = hub ? (on ? 6.4 : 5.6) : (on ? 5.6 : (c.today ? 4.8 : 3.8));
            ctx.beginPath();
            ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
            ctx.fillStyle = hub || on ? HUB_NAVY : '#475569';
            ctx.fill();
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = hub ? 2 : 1.5;
            ctx.stroke();
            if (c.today) {
                const pr = r + 3.2 + Math.sin(pulseT / 280) * 1.8;
                ctx.beginPath();
                ctx.arc(p.x, p.y, pr, 0, Math.PI * 2);
                ctx.strokeStyle = 'rgba(16,185,129,0.65)';
                ctx.lineWidth = 1.8;
                ctx.stroke();
            }
            const showLabel = on || (!selectedCity && !selectedKey) || hub;
            if (!showLabel) return;
            ctx.font = (hub || on ? '700 12px' : '600 11px') + ' Inter, system-ui, sans-serif';
            const label = c.city || c.code;
            const tw = ctx.measureText(label).width;
            const x = lx || p.x + 8;
            const y = ly || p.y - 7;
            ctx.fillStyle = 'rgba(255,255,255,0.9)';
            ctx.fillRect(x - 3, y - 11, tw + 6, 14);
            ctx.fillStyle = HUB_NAVY;
            ctx.fillText(label, x, y);
        });
        drawLivePlanes(ctx);
    }

    function drawOverlay(w, h, dpr) {
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        drawData(ctx);
        if (!hover) return;
        ctx.font = '12px Inter, system-ui, sans-serif';
        const label = hover.label;
        const tw = ctx.measureText(label).width;
        const x = Math.min(w - tw - 16, Math.max(8, hover.x + 12));
        const y = Math.max(22, hover.y - 10);
        ctx.fillStyle = 'rgba(15,23,42,0.88)';
        ctx.fillRect(x - 6, y - 14, tw + 12, 20);
        ctx.fillStyle = '#fff';
        ctx.fillText(label, x, y);
    }

    function stageSize() {
        const host = canvas || baseCanvas;
        if (!host) return { w: 0, h: 0 };
        return { w: host.clientWidth, h: host.clientHeight };
    }

    function redraw(level) {
        if (!canvas) return;
        const { w, h } = stageSize();
        if (!w || !h) return;
        const dpr = window.devicePixelRatio || 1;
        const sizedOverlay = syncCanvasSize(canvas, w, h, dpr);
        const sizedBase = syncCanvasSize(baseCanvas, w, h, dpr);
        const data = buildAggregate();
        if (!view._fitted) fitView(w, h);
        if (geomDirty || !projected.lines) {
            rebuildProjected(data, w, h);
            liveBindDirty = true;
        }
        syncProjectedScreen();
        if (liveBindDirty) {
            bindLiveToLines();
            liveBindDirty = false;
        }
        if (level !== 'overlay' || baseDirty || sizedBase || sizedOverlay) {
            drawBase(w, h, dpr);
        }
        drawOverlay(w, h, dpr);
    }

    function hitTest(x, y) {
        let best = null;
        let bestD = 14;
        if (isLiveDay()) {
            livePlanes.forEach(raw => {
                const { p, s, bind } = liveScreenPos(raw);
                const d = Math.hypot(s.x - x, s.y - y);
                if (d < 16 && d < bestD) {
                    bestD = d;
                    const line = bind && bind.item ? bind.item.l : null;
                    best = {
                        type: 'plane',
                        key: line ? line.key : 'plane:' + p.id,
                        plane: p,
                        line,
                        x, y,
                        label: livePlaneLabel(raw)
                    };
                }
            });
        }
        projected.cities.forEach(item => {
            const d = Math.hypot(item.p.x - x, item.p.y - y);
            const pad = item.c.hub ? 16 : 14;
            if (d < Math.max(bestD, pad) && d < pad) {
                bestD = d;
                best = { type: 'city', key: item.c.code || item.c.city, city: item.c, x, y, label: item.c.city };
            }
        });
        projected.lines.forEach(item => {
            item.arcs.forEach(arc => {
                const d = distToCurve(x, y, arc.a, arc.ctrl, arc.b);
                if (d < bestD) {
                    bestD = d;
                    const l = item.l;
                    const tuda = l.zpkAb == null ? '—' : l.zpkAb + '%';
                    const obr = l.zpkBa == null ? '—' : l.zpkBa + '%';
                    const avg = l.avgZpk == null ? '—' : l.avgZpk + '%';
                    best = {
                        type: 'arc',
                        key: l.key,
                        line: l,
                        x, y,
                        label: `${l.a.city} — ${l.b.city} · ЗПК ${avg} · туда ${tuda} / обратно ${obr}`
                    };
                }
            });
        });
        return best;
    }

    function distToSeg(px, py, x1, y1, x2, y2) {
        const dx = x2 - x1, dy = y2 - y1;
        const l2 = dx * dx + dy * dy || 1;
        let t = ((px - x1) * dx + (py - y1) * dy) / l2;
        t = Math.max(0, Math.min(1, t));
        return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
    }

    function distToCurve(px, py, a, c, b) {
        if (!c) return distToSeg(px, py, a.x, a.y, b.x, b.y);
        let best = Infinity;
        let px0 = a.x, py0 = a.y;
        for (let i = 1; i <= 10; i++) {
            const t = i / 10;
            const u = 1 - t;
            const x = u * u * a.x + 2 * u * t * c.x + t * t * b.x;
            const y = u * u * a.y + 2 * u * t * c.y + t * t * b.y;
            const d = distToSeg(px, py, px0, py0, x, y);
            if (d < best) best = d;
            px0 = x;
            py0 = y;
        }
        return best;
    }

    function selectLine(line) {
        selectedKey = line.key;
        selectedCity = null;
        renderCard(line);
        redraw('overlay');
    }

    function selectCity(city) {
        selectedCity = city.city || city.code;
        selectedKey = null;
        const data = buildAggregate();
        const fromCity = data.lines.filter(l => lineTouchesCity(l, selectedCity));
        if (fromCity.length === 1) {
            selectLine(fromCity[0]);
            return;
        }
        renderCityCard(city, fromCity);
        redraw('overlay');
    }

    function renderCityCard(city, lines) {
        const el = document.getElementById('nmap-card');
        if (!el) return;
        const list = (lines || []).map(l => {
            const other = l.a.city === city.city ? l.b.city : l.a.city;
            const outbound = l.a.city === city.city ? l.zpkAb : l.zpkBa;
            const inbound = l.a.city === city.city ? l.zpkBa : l.zpkAb;
            const out = outbound == null ? '—' : outbound + '%';
            const inn = inbound == null ? '—' : inbound + '%';
            return `<button type="button" class="nmap-prob" data-key="${esc(l.key)}"><strong>${esc(other)}</strong> <span>туда ${out} · обратно ${inn}</span></button>`;
        }).join('');
        el.innerHTML = `
            <div class="nmap-card-title">${esc(city.city)}</div>
            <p class="nmap-card-sub">Направления из этого пункта. Нажмите линию или город в списке.</p>
            <div class="nmap-problems">${list || '<p class="nmap-muted">Нет рейсов на срезе</p>'}</div>
            <div class="nmap-card-actions">
                <button type="button" class="btn-secondary" data-nmap-goto="data">К загрузке</button>
                <button type="button" class="btn-secondary" data-nmap-goto="pair">К экономике</button>
            </div>
        `;
        el.querySelectorAll('[data-key]').forEach(btn => {
            btn.addEventListener('click', () => {
                const line = buildAggregate().lines.find(l => l.key === btn.dataset.key);
                if (line) selectLine(line);
            });
        });
        el.querySelectorAll('[data-nmap-goto]').forEach(btn => {
            btn.addEventListener('click', () => gotoWork(btn.dataset.nmapGoto, {
                city: city.city, query: city.city, iata: city.code,
                date: (period && period !== 'file') ? period : null
            }));
        });
    }

    function isHubName(name) {
        return typeof isHubCity === 'function' && isHubCity(name);
    }

    function searchQueryForLine(line) {
        if (!line) return '';
        const cities = [line.a.city, line.b.city].filter(Boolean);
        const nonHub = cities.filter(c => !isHubName(c));
        if (nonHub.length === 1) return nonHub[0];
        return cities.join(' ');
    }

    function filterFromLine(line) {
        if (!line) return { query: '' };
        return {
            city: searchQueryForLine(line),
            query: searchQueryForLine(line),
            flights: line.flights,
            iata: line.a.code,
            date: (period && period !== 'file') ? period : (line.nearest?.date || null)
        };
    }

    function legRemain(leg) {
        if (!leg || !leg.n) return null;
        return Math.max(0, (leg.au || 0) - (leg.sold || 0) - (leg.avs || 0));
    }

    function displayLegs(line) {
        const aHub = isHubName(line.a.city);
        const bHub = isHubName(line.b.city);
        if (bHub && !aHub) {
            return [
                { title: `Туда · ${line.b.city} → ${line.a.city}`, leg: line.ba },
                { title: `Обратно · ${line.a.city} → ${line.b.city}`, leg: line.ab }
            ];
        }
        return [
            { title: `Туда · ${line.a.city} → ${line.b.city}`, leg: line.ab },
            { title: `Обратно · ${line.b.city} → ${line.a.city}`, leg: line.ba }
        ];
    }

    function legBlockHtml(block) {
        const g = block.leg || {};
        const empty = !g.n;
        const zpkN = empty ? null : legAvg(g);
        const zpk = empty ? '—' : (zpkN == null ? '—' : zpkN + '%');
        const remain = empty ? '—' : formatNum(legRemain(g));
        const pip = zpkColor(zpkN);
        return `
            <div class="nmap-leg">
                <div class="nmap-leg-h"><i class="nmap-pip" style="background:${pip}"></i>${esc(block.title)}</div>
                <div class="nmap-card-grid">
                    <div><span>ЗПК</span><strong>${zpk}</strong></div>
                    <div><span>Кресел (AU)</span><strong>${empty ? '—' : formatNum(g.au)}</strong></div>
                    <div><span>Загрузка</span><strong>${empty ? '—' : formatNum(g.sold)}</strong></div>
                    <div><span>Остаток</span><strong>${remain}</strong></div>
                    <div><span>Спец. брони</span><strong>${empty ? '—' : formatNum(g.avs)}</strong></div>
                    <div><span>Ближайшая дата</span><strong>${esc(g.nearest?.date || '—')}</strong></div>
                </div>
            </div>`;
    }

    function renderCard(line) {
        const el = document.getElementById('nmap-card');
        if (!el) return;
        if (!line) {
            el.innerHTML = '<p class="nmap-card-empty">Нажмите линию или город</p>';
            return;
        }
        const legs = displayLegs(line);
        el.innerHTML = `
            <div class="nmap-card-title">${esc(line.a.city)} — ${esc(line.b.city)}</div>
            ${legs.map(legBlockHtml).join('')}
            <div class="nmap-card-actions">
                <button type="button" class="btn-secondary" data-nmap-goto="data">К загрузке</button>
                <button type="button" class="btn-secondary" data-nmap-goto="pair">К экономике</button>
            </div>
        `;
        el.querySelectorAll('[data-nmap-goto]').forEach(btn => {
            btn.addEventListener('click', () => gotoWork(btn.dataset.nmapGoto, filterFromLine(line)));
        });
    }

    function renderProblems(data) {
        const el = document.getElementById('nmap-problems');
        if (!el) return;
        const list = data.lines.filter(l => l.problem).sort((a, b) => (a.dtd ?? 99) - (b.dtd ?? 99) || (a.avgZpk ?? 99) - (b.avgZpk ?? 99));
        if (!list.length) {
            el.innerHTML = '<p class="nmap-muted">Нет проблемных направлений на срезе</p>';
            return;
        }
        el.innerHTML = list.slice(0, 16).map(l => {
            const legs = displayLegs(l);
            const fmt = block => {
                if (!block.leg || !block.leg.n) return '—';
                const z = legAvg(block.leg);
                return z == null ? '—' : z + '%';
            };
            return `
            <button type="button" class="nmap-prob" data-key="${esc(l.key)}">
                <strong>${esc(l.a.city)} — ${esc(l.b.city)}</strong>
                <span>DTD ${dash(l.dtd)} · туда ${fmt(legs[0])} / обратно ${fmt(legs[1])}</span>
            </button>`;
        }).join('');
    }

    function dash(v) { return v == null || v === '' ? '—' : String(v); }

    function renderUnknown(data) {
        const el = document.getElementById('nmap-unknown');
        if (!el) return;
        if (!data.unknown.length) { el.hidden = true; el.innerHTML = ''; return; }
        el.hidden = false;
        el.innerHTML = '<div class="nmap-unknown-title">Без точки на карте</div>'
            + data.unknown.map(u => `<span>${esc(u)}</span>`).join('');
    }

    function gotoWork(tab, filter) {
        window.networkMapFilter = filter || null;
        const codes = (filter && filter.flights) || [];
        const pick = codes[0]
            ? (typeof getBaseFlight === 'function' ? getBaseFlight(codes[0]) : codes[0])
            : null;
        if (pick) {
            currentFlight = pick;
            if (filter.date) lastSelectedDate = filter.date;
        }
        if (tab === 'data') {
            if (typeof dataSearchQuery !== 'undefined') dataSearchQuery = filter?.query || filter?.city || '';
            if (typeof invalidateDataBoardCache === 'function') invalidateDataBoardCache();
        }
        if (tab === 'main' && typeof invalidateTimelineCache === 'function') invalidateTimelineCache();
        if (typeof switchMainTab === 'function') switchMainTab(tab);
        if (tab === 'pair' && pick && typeof selectFlight === 'function') {
            selectFlight(pick, filter?.date || lastSelectedDate);
        }
    }

    function flightMatchesFilter(fl, row) {
        const f = window.networkMapFilter;
        if (!f) return true;
        const hasFlights = !!(f.flights && f.flights.length);
        let iata = String(f.iata || '').toUpperCase();
        if (iata === 'KCY') iata = 'KJA';
        const q = (f.city || f.query || '').trim().toLowerCase();
        if (!hasFlights && !iata && !q) return true;

        const code = typeof cleanFlight === 'function' ? cleanFlight(fl) : fl;
        if (hasFlights && f.flights.includes(code)) return true;

        const route = String(typeof getRouteFromRow === 'function' ? getRouteFromRow(row) : '');
        const routeU = route.toUpperCase();
        if (iata && (routeU.includes(iata) || (iata === 'KJA' && routeU.includes('KCY')))) return true;

        const dir = typeof getFlightDirection === 'function' ? getFlightDirection(code) : '';
        const token = q.split(/\s+/)[0];
        if (token && (dir.toLowerCase().includes(token) || route.toLowerCase().includes(token))) return true;
        return false;
    }

    function bindCanvas(cv) {
        canvas = cv;
        canvas.addEventListener('pointerdown', (e) => {
            dragging = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty, moved: false };
            canvas.setPointerCapture(e.pointerId);
        });
        canvas.addEventListener('pointermove', (e) => {
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            if (dragging) {
                const dx = e.clientX - dragging.x;
                const dy = e.clientY - dragging.y;
                if (Math.hypot(dx, dy) > 4) dragging.moved = true;
                if (dragging.moved) {
                    view.tx = dragging.tx + dx;
                    view.ty = dragging.ty + dy;
                    hover = null;
                    baseDirty = true;
                    requestViewRedraw();
                }
                return;
            }
            const hit = hitTest(x, y);
            const next = hit ? hit.key + (hit.label || '') : null;
            const prev = hover ? hover.key + (hover.label || '') : null;
            hover = hit;
            if (prev !== next || (hit && !raf)) redraw('overlay');
        });
        canvas.addEventListener('pointerup', (e) => {
            const moved = dragging?.moved;
            dragging = null;
            if (moved) return;
            const rect = canvas.getBoundingClientRect();
            const hit = hitTest(e.clientX - rect.left, e.clientY - rect.top);
            if (!hit) {
                selectedKey = null;
                selectedCity = null;
                renderCard(null);
                redraw('overlay');
                return;
            }
            if (hit.type === 'plane') {
                if (hit.line) selectLine(hit.line);
                return;
            }
            if (hit.type === 'arc' || hit.type === 'line') selectLine(hit.line);
            if (hit.type === 'city') selectCity(hit.city);
        });
        canvas.addEventListener('pointerleave', () => {
            if (hover) { hover = null; redraw('overlay'); }
        });
        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const rect = canvas.getBoundingClientRect();
            zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.14 : 1 / 1.14);
        }, { passive: false });
    }

    function updateLiveBadge() {
        const el = document.getElementById('nmap-live');
        if (!el) return;
        if (!isLiveDay()) {
            el.hidden = false;
            el.className = 'nmap-live is-off';
            el.textContent = 'Эфир выключен · не сегодня';
            return;
        }
        el.hidden = false;
        const n = livePlanes.length;
        const st = window.LiveKvFlights ? LiveKvFlights.getStatus() : 'off';
        const src = window.LiveKvFlights ? LiveKvFlights.getSource() : '';
        if (st === 'error') {
            el.className = 'nmap-live is-err';
            el.textContent = 'Эфир: нет связи';
            return;
        }
        if (st === 'wait') {
            el.className = 'nmap-live is-wait';
            el.textContent = 'Эфир: подключение…';
            return;
        }
        el.className = 'nmap-live is-on';
        const radar = livePlanes.filter(p => !p.estimated);
        const est = livePlanes.filter(p => p.estimated);
        if (!n) {
            el.textContent = 'Эфир KV/ЭК · сейчас не видно';
            return;
        }
        const bits = [];
        if (radar.length) bits.push(radar.length + ' радар');
        if (est.length) bits.push(est.length + ' по расписанию');
        el.textContent = `Эфир KV/ЭК · ${bits.join(', ')}${src && radar.length ? ' · ' + src : ''}`;
    }

    function onLiveUpdate(list) {
        applyLivePlanes(list);
        updateLiveBadge();
        if (canvas && typeof currentTab !== 'undefined' && currentTab === 'home') {
            redraw('overlay');
        }
    }

    function syncLive() {
        const on = isLiveDay()
            && canvas
            && (typeof currentTab === 'undefined' || currentTab === 'home')
            && !(typeof document !== 'undefined' && document.hidden);
        if (on) {
            if (window.LiveKvFlights) LiveKvFlights.start(onLiveUpdate);
            applyLivePlanes(window.LiveKvFlights ? LiveKvFlights.getPlanes() : []);
            startEstTick();
        } else {
            if (window.LiveKvFlights) LiveKvFlights.stop();
            stopEstTick();
            livePlanes = [];
        }
        updateLiveBadge();
    }

    function pauseLive() {
        if (window.LiveKvFlights) LiveKvFlights.stop();
        stopEstTick();
        livePlanes = [];
    }

    function loop() {
        if (typeof currentTab !== 'undefined' && currentTab !== 'home') {
            raf = 0;
            return;
        }
        if (typeof document !== 'undefined' && document.hidden) {
            raf = 0;
            return;
        }
        const data = aggCache.data;
        const needPulse = data && data.hasToday;
        if (needPulse) {
            const now = performance.now();
            if (now - lastPulseAt >= 140 && !(dragging && dragging.moved)) {
                lastPulseAt = now;
                pulseT = now;
                redraw('overlay');
            }
            raf = requestAnimationFrame(loop);
        } else {
            raf = 0;
        }
    }

    let mapDepsPromise = null;

    function loadClassicScript(src) {
        return new Promise((resolve, reject) => {
            const found = document.querySelector('script[data-map-dep="' + src + '"]');
            if (found && found.dataset.failed !== '1') {
                if (found.dataset.loaded === '1') resolve();
                else {
                    found.addEventListener('load', () => resolve(), { once: true });
                    found.addEventListener('error', () => reject(new Error(src)), { once: true });
                }
                return;
            }
            if (found) found.remove();
            const script = document.createElement('script');
            script.src = src;
            script.dataset.mapDep = src;
            script.onload = () => {
                script.dataset.loaded = '1';
                resolve();
            };
            script.onerror = () => {
                script.dataset.failed = '1';
                reject(new Error(src));
            };
            document.body.appendChild(script);
        });
    }

    function ensureMapDeps() {
        if (window.GEO_AIRPORTS && window.GEO_OUTLINE_FALLBACK && window.LiveKvFlights) {
            return Promise.resolve(true);
        }
        if (!mapDepsPromise) {
            mapDepsPromise = ['js/geo-airports.js', 'js/geo-outline.js', 'js/live-flights.js']
                .reduce((chain, src) => chain.then(() => loadClassicScript(src)), Promise.resolve())
                .then(() => !!(window.GEO_AIRPORTS && window.LiveKvFlights))
                .catch((e) => {
                    console.warn('карта', e);
                    mapDepsPromise = null;
                    return false;
                });
        }
        return mapDepsPromise;
    }

    function refresh() {
        if (!window.GEO_AIRPORTS || !window.LiveKvFlights) {
            ensureMapDeps().then((ok) => {
                if (ok && canvas && (typeof currentTab === 'undefined' || currentTab === 'home')) refresh();
            });
            return;
        }
        const sig = cacheSig();
        if (aggCache.sig === sig && aggCache.data && canvas && !geomDirty && projected.lines && projected.lines.length) {
            syncLive();
            if (!raf) raf = requestAnimationFrame(loop);
            redraw('all');
            return;
        }
        aggCache = { sig: '', data: null };
        geomDirty = true;
        projected._vs = null;
        baseDirty = true;
        const data = buildAggregate();
        renderProblems(data);
        renderUnknown(data);
        const stats = document.getElementById('nmap-stats');
        if (stats) {
            stats.textContent = `${periodCaption()} · ${data.lines.length} направлений · ${data.cities.length} пунктов`;
        }
        redraw('all');
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(loop);
        const sel = data.lines.find(l => l.key === selectedKey);
        if (sel) renderCard(sel);
        syncLive();
    }

    async function loadOutline() {
        if (outline) return;
        try {
            const r = await fetch('data/geo/siberia-base.geojson');
            if (r.ok) {
                outline = await r.json();
                landPaths = null;
                baseDirty = true;
                return;
            }
        } catch { /* file:// */ }
        outline = window.GEO_OUTLINE_FALLBACK || null;
        landPaths = null;
        baseDirty = true;
    }

    let mapMountGen = 0;

    function createView(host) {
        if (!host) return;
        const gen = ++mapMountGen;
        ensureMapDeps().then(() => {
            if (gen !== mapMountGen || !host.isConnected) return;
            mountMapView(host);
        });
    }

    function mountMapView(host) {
        if (raf) {
            cancelAnimationFrame(raf);
            raf = 0;
        }
        pauseLive();
        period = syncPeriod(period);
        host.innerHTML = `
            <div class="nmap-page">
                <aside class="nmap-side">
                    <h2 class="nmap-title">Сеть</h2>
                    <p id="nmap-stats" class="nmap-muted"></p>
                    <div class="nmap-filters">
                        <span class="nmap-label">Дата вылета</span>
                        <div class="nmap-days" id="nmap-period" role="group" aria-label="Дата вылета">
                            ${periodButtonsHtml()}
                        </div>
                        <span class="nmap-label">Слой</span>
                        <div class="nmap-seg" id="nmap-layer">
                            <button type="button" data-layer="load" class="is-on">Загрузка</button>
                            <button type="button" data-layer="problem">Проблемные</button>
                        </div>
                        <label class="nmap-check"><input type="checkbox" id="nmap-open-only" checked> Только открытые</label>
                    </div>
                    <div class="nmap-legend">
                        <span>ЗПК направления (среднее туда и обратно)</span>
                        <div class="nmap-legend-bar"></div>
                        <div class="nmap-legend-scale"><span>0%</span><span>50%</span><span>100%</span></div>
                        <p class="nmap-muted">Одна дуга на пару городов. Оранжевый борт — радар, тёмно-синий — оценка по расписанию и дальности. Эфир только сегодня.</p>
                    </div>
                    <div class="nmap-label">Проблемные направления</div>
                    <div id="nmap-problems" class="nmap-problems"></div>
                    <div id="nmap-unknown" class="nmap-unknown" hidden></div>
                    <div class="nmap-jumps">
                        <button type="button" class="btn-secondary" id="nmap-to-data">К загрузке</button>
                        <button type="button" class="btn-secondary" id="nmap-to-pair">К экономике</button>
                    </div>
                </aside>
                <div class="nmap-stage">
                    <div class="nmap-canvas-stack">
                        <canvas id="nmap-canvas-base" class="nmap-canvas-base" aria-hidden="true"></canvas>
                        <canvas id="nmap-canvas" class="nmap-canvas"></canvas>
                    </div>
                    <div class="nmap-zoom" role="group" aria-label="Масштаб карты">
                        <button type="button" id="nmap-zoom-in" title="Крупнее">+</button>
                        <button type="button" id="nmap-zoom-out" title="Мельче">−</button>
                        <span id="nmap-zoom-val">100%</span>
                    </div>
                    <div id="nmap-live" class="nmap-live is-off">Эфир KV/ЭК</div>
                    <div id="nmap-card" class="nmap-card"><p class="nmap-card-empty">Нажмите линию или город</p></div>
                </div>
            </div>
        `;
        baseCanvas = host.querySelector('#nmap-canvas-base');
        bindCanvas(host.querySelector('#nmap-canvas'));
        host.querySelectorAll('[data-period]').forEach(x => x.classList.toggle('is-on', x.dataset.period === period));
        host.querySelectorAll('[data-layer]').forEach(x => x.classList.toggle('is-on', x.dataset.layer === layer));
        const openCb = host.querySelector('#nmap-open-only');
        if (openCb) openCb.checked = openOnly;
        const stage = host.querySelector('.nmap-stage');
        host.querySelector('#nmap-zoom-in')?.addEventListener('click', () => {
            zoomAt((canvas.clientWidth || 400) / 2, (canvas.clientHeight || 300) / 2, 1.22);
        });
        host.querySelector('#nmap-zoom-out')?.addEventListener('click', () => {
            zoomAt((canvas.clientWidth || 400) / 2, (canvas.clientHeight || 300) / 2, 1 / 1.22);
        });
        if (resizeObs) resizeObs.disconnect();
        resizeObs = new ResizeObserver(() => {
            if (!canvas || currentTab !== 'home') return;
            const w = canvas.clientWidth, h = canvas.clientHeight;
            if (!w || !h) return;
            if (!view._fitted) fitView(w, h);
            baseDirty = true;
            requestViewRedraw();
        });
        if (stage) resizeObs.observe(stage);
        host.querySelector('#nmap-period').addEventListener('click', (e) => {
            const b = e.target.closest('[data-period]');
            if (!b) return;
            period = b.dataset.period;
            host.querySelectorAll('[data-period]').forEach(x => x.classList.toggle('is-on', x === b));
            refresh();
        });
        host.querySelector('#nmap-layer').addEventListener('click', (e) => {
            const b = e.target.closest('[data-layer]');
            if (!b) return;
            layer = b.dataset.layer;
            host.querySelectorAll('[data-layer]').forEach(x => x.classList.toggle('is-on', x === b));
            geomDirty = true;
            projected._vs = null;
            redraw('overlay');
            renderProblems(buildAggregate());
        });
        host.querySelector('#nmap-open-only').addEventListener('change', (e) => {
            openOnly = !!e.target.checked;
            refresh();
        });
        host.querySelector('#nmap-problems').addEventListener('click', (e) => {
            const b = e.target.closest('[data-key]');
            if (!b) return;
            const line = buildAggregate().lines.find(l => l.key === b.dataset.key);
            if (!line) return;
            selectLine(line);
            const a = toScreen(projectLonLat(line.a.lon, line.a.lat));
            const c = toScreen(projectLonLat(line.b.lon, line.b.lat));
            const cx = (a.x + c.x) / 2, cy = (a.y + c.y) / 2;
            view.tx += (canvas.clientWidth / 2 - cx);
            view.ty += (canvas.clientHeight / 2 - cy);
            baseDirty = true;
            redraw('all');
        });
        host.querySelector('#nmap-to-data')?.addEventListener('click', () => {
            const line = buildAggregate().lines.find(l => l.key === selectedKey);
            gotoWork('data', filterFromLine(line));
        });
        host.querySelector('#nmap-to-pair')?.addEventListener('click', () => {
            const line = buildAggregate().lines.find(l => l.key === selectedKey);
            gotoWork('pair', filterFromLine(line));
        });
        loadOutline().then(() => {
            geomDirty = true;
            baseDirty = true;
            refresh();
        });
        requestAnimationFrame(() => refresh());
    }

    if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                if (window.LiveKvFlights) LiveKvFlights.stop();
                stopEstTick();
                return;
            }
            if (typeof currentTab !== 'undefined' && currentTab !== 'home') return;
            syncLive();
            if (!raf && canvas) raf = requestAnimationFrame(loop);
        });
    }

    return { createView, refresh, pauseLive, flightMatchesFilter, gotoWork };
})();
