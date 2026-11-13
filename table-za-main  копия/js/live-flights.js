// эфир KV / ЭК / SSJ с Flightradar, только на сегодня; запрос из изолированной рамки live-frame.html
window.LiveKvFlights = (function () {
    const POLL_MS = 15000;
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
    const MAX_FAILS = 3;     // неудач подряд, после которых опрос останавливается
    let fails = 0;
    let down = false;        // радар недоступен до следующего захода на вкладку "Сеть"

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

    // Flightradar отдаёт JSONP (код), чужой код на странице с данными не выполняем
    // запрос в изолированной рамке (sandbox, без доступа к странице и паролям), сюда приходит только ответ как данные
    // адрес и параметры заданы в самой рамке
    let frame = null;
    let frameReady = null;
    let frameReadyDone = null;
    let reqSeq = 0;
    const waiting = new Map();   // номер запроса -> { resolve, reject, tid }

    function onFrameMessage(e) {
        if (!frame || e.source !== frame.contentWindow || e.origin !== 'null') return;
        const m = e.data;
        if (!m || m.type !== 'kv-radar' || typeof m.id !== 'number') return;
        if (m.id === 0) { if (frameReadyDone) frameReadyDone(); return; }
        const w = waiting.get(m.id);
        if (!w) return;
        waiting.delete(m.id);
        clearTimeout(w.tid);
        if (m.ok && m.data && typeof m.data === 'object' && !Array.isArray(m.data)) w.resolve(m.data);
        else w.reject(new Error('radar'));
    }

    function dropFrame() {
        window.removeEventListener('message', onFrameMessage);
        waiting.forEach(w => { clearTimeout(w.tid); w.reject(new Error('unwanted')); });
        waiting.clear();
        if (frame && frame.parentNode) frame.parentNode.removeChild(frame);
        frame = null;
        frameReady = null;
        frameReadyDone = null;
    }

    function ensureFrame() {
        if (frameReady) return frameReady;
        frameReady = new Promise((resolve, reject) => {
            const el = document.createElement('iframe');
            el.setAttribute('sandbox', 'allow-scripts');
            el.setAttribute('aria-hidden', 'true');
            el.tabIndex = -1;
            el.referrerPolicy = 'no-referrer';
            el.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
            const tid = setTimeout(() => { reject(new Error('frame')); if (frame === el) dropFrame(); }, 8000);
            frameReadyDone = () => { clearTimeout(tid); resolve(); };
            window.addEventListener('message', onFrameMessage);
            frame = el;
            el.src = 'live-frame.html';
            document.body.appendChild(el);
        });
        return frameReady;
    }

    function radarRequest() {
        return ensureFrame().then(() => new Promise((resolve, reject) => {
            if (!frame || !frame.contentWindow) { reject(new Error('frame')); return; }
            const id = ++reqSeq;
            const tid = setTimeout(() => { waiting.delete(id); reject(new Error('timeout')); }, 14000);
            waiting.set(id, { resolve, reject, tid });
            frame.contentWindow.postMessage({ type: 'kv-radar-get', id }, '*');
        }));
    }

    async function fetchFr24() {
        return parseFr24(await radarRequest());
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
            fails = 0;
            if (onChange) onChange(planes, status);
        } catch {
            if (!wanted) return;
            planes = [];
            fails++;
            status = 'error';
            source = '';
            // три неудачи подряд (нет интернета, закрытая сеть) - не стучимся, пока не зайдут на вкладку снова
            if (fails >= MAX_FAILS) {
                down = true;
                status = 'down';
                if (timer) { clearInterval(timer); timer = 0; }
            }
            if (onChange) onChange(planes, status);
        } finally {
            inflight = false;
        }
    }

    function start(cb) {
        onChange = cb || onChange;
        wanted = true;
        if (down) { status = 'down'; return; }
        if (timer) return;
        status = status === 'live' ? 'live' : 'wait';
        poll();
        timer = setInterval(poll, POLL_MS);
    }

    function stop() {
        wanted = false;
        // ушли с вкладки - при заходе пробуем снова; пауза на той же вкладке недоступность не снимает
        if (typeof currentTab === 'undefined' || currentTab !== 'home') { down = false; fails = 0; }
        if (timer) {
            clearInterval(timer);
            timer = 0;
        }
        inflight = false;
        planes = [];
        status = 'off';
        source = '';
        dropFrame();
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
        start, stop,
        getPlanes: () => planes,
        getStatus: () => status,
        getSource: () => source,
        extrapolate
    };
})();
