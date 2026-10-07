// Эфир KV / ЭК / SSJ через JSONP Flightradar (без CORS). Только «сегодня».
window.LiveKvFlights = (function () {
    const POLL_MS = 15000;
    const FR24 = 'https://data-cloud.flightradar24.com/zones/fcgi/feed.js';
    const BOUNDS = '76.2,46.2,70,132';
    const FLEET = new Set([
        'RA-67604', 'RA-67605', 'RA-67607', 'RA-67608', 'RA-67610', 'RA-67611',
        'RA-22306', 'RA-88213',
        'RA-42340', 'RA-42370', 'RA-42380', 'RA-42384', 'RA-42388', 'RA-42389',
        'RA-42406', 'RA-42408', 'RA-42414', 'RA-42418', 'RA-42438', 'RA-42442'
    ]);

    let timer = 0;
    let inflight = false;
    let planes = [];
    let status = 'off';
    let source = '';
    let onChange = null;
    let wanted = false;
    let jsonpSeq = 0;

    function normReg(r) {
        return String(r || '').toUpperCase().replace(/\s+/g, '');
    }

    function kvFlight(raw) {
        const s = String(raw || '').trim();
        if (!s) return '';
        const compact = s.toUpperCase().replace(/[\s\-]/g, '');
        let m = compact.match(/^(?:KV|SSJ|EK)(\d{2,4})/);
        if (m) return 'KV-' + String(parseInt(m[1], 10));
        const cyr = s.replace(/[\s\-]/g, '');
        m = cyr.match(/^ЭК(\d{2,4})/i);
        if (m) return 'KV-' + String(parseInt(m[1], 10));
        return '';
    }

    function inFleet(reg) {
        const r = normReg(reg);
        if (!r) return false;
        if (FLEET.has(r)) return true;
        if (r.indexOf('-') < 0 && r.length >= 7) return FLEET.has(r.slice(0, 2) + '-' + r.slice(2));
        return FLEET.has(r.replace(/-/g, ''));
    }

    function isOurs(callsign, flightNo, airline, reg) {
        if (kvFlight(callsign) || kvFlight(flightNo)) return true;
        const a = String(airline || '').toUpperCase();
        if (a === 'SSJ' || a === 'KV') return true;
        return inFleet(reg);
    }

    function parseFr24(json) {
        const out = [];
        if (!json || typeof json !== 'object') return out;
        Object.keys(json).forEach(id => {
            if (id === 'full_count' || id === 'version') return;
            const a = json[id];
            if (!Array.isArray(a) || a.length < 14) return;
            const callsign = String(a[16] || '').trim();
            const flightNo = String(a[13] || '').trim();
            const airline = String(a[18] || '');
            const reg = String(a[9] || '');
            if (!isOurs(callsign, flightNo, airline, reg)) return;
            const lat = Number(a[1]);
            const lon = Number(a[2]);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
            const flight = kvFlight(flightNo) || kvFlight(callsign);
            out.push({
                id: String(id),
                lat, lon,
                hdg: Number(a[3]) || 0,
                alt: Number(a[4]) || 0,
                spd: Number(a[5]) || 0,
                type: String(a[8] || ''),
                reg: normReg(reg),
                orig: String(a[11] || '').toUpperCase(),
                dest: String(a[12] || '').toUpperCase(),
                callsign,
                flight,
                gnd: !!a[14],
                at: Date.now()
            });
        });
        return out;
    }

    function jsonp(url) {
        return new Promise((resolve, reject) => {
            const rand = Math.random().toString(36).slice(2, 10);
            const cb = 'kvFr24_' + (++jsonpSeq) + '_' + rand;
            let done = false;
            const finish = (fn, arg) => {
                if (done) return;
                done = true;
                try { delete window[cb]; } catch { window[cb] = undefined; }
                if (script && script.parentNode) script.parentNode.removeChild(script);
                clearTimeout(tid);
                fn(arg);
            };
            window[cb] = (data) => {
                if (!wanted) {
                    finish(reject, new Error('unwanted'));
                    return;
                }
                if (!data || typeof data !== 'object' || Array.isArray(data)) {
                    finish(reject, new Error('bad jsonp'));
                    return;
                }
                finish(resolve, data);
            };
            const script = document.createElement('script');
            script.async = true;
            script.referrerPolicy = 'no-referrer';
            script.src = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'callback=' + encodeURIComponent(cb);
            script.onerror = () => finish(reject, new Error('jsonp'));
            const tid = setTimeout(() => finish(reject, new Error('timeout')), 12000);
            (document.head || document.documentElement).appendChild(script);
        });
    }

    async function fetchFr24() {
        const q = new URLSearchParams({
            faa: '1', satellite: '1', mlat: '1', flarm: '0', adsb: '1',
            gnd: '1', air: '1', vehicles: '0', estimated: '1',
            maxage: '14400', gliders: '0', stats: '0',
            bounds: BOUNDS
        });
        const json = await jsonp(FR24 + '?' + q.toString());
        return parseFr24(json);
    }

    async function poll() {
        if (!wanted || inflight) return;
        if (typeof document !== 'undefined' && document.hidden) return;
        if (typeof currentTab !== 'undefined' && currentTab !== 'home') {
            stop();
            return;
        }
        inflight = true;
        try {
            const list = await fetchFr24();
            if (!wanted) return;
            planes = list;
            source = 'FR24';
            status = 'live';
            if (onChange) onChange(planes, status);
        } catch {
            if (!wanted) return;
            planes = [];
            status = 'error';
            source = '';
            if (onChange) onChange(planes, status);
        } finally {
            inflight = false;
        }
    }

    function start(cb) {
        onChange = cb || onChange;
        wanted = true;
        if (timer) return;
        status = status === 'live' ? 'live' : 'wait';
        poll();
        timer = setInterval(poll, POLL_MS);
    }

    function stop() {
        wanted = false;
        if (timer) {
            clearInterval(timer);
            timer = 0;
        }
        inflight = false;
        planes = [];
        status = 'off';
        source = '';
        if (onChange) onChange(planes, status);
    }

    function extrapolate(p, now) {
        if (!p || p.gnd || !p.spd || p.spd < 40) return p;
        const dt = Math.min(20, Math.max(0, (now - p.at) / 1000));
        if (dt < 0.4) return p;
        const km = p.spd * 1.852 * dt / 3600;
        const rad = (p.hdg || 0) * Math.PI / 180;
        const lat = p.lat + (km / 111.32) * Math.cos(rad);
        const cosLat = Math.cos(p.lat * Math.PI / 180) || 0.2;
        const lon = p.lon + (km / (111.32 * cosLat)) * Math.sin(rad);
        return { ...p, lat, lon };
    }

    return {
        start, stop, poll,
        getPlanes: () => planes,
        getStatus: () => status,
        getSource: () => source,
        extrapolate, kvFlight
    };
})();
