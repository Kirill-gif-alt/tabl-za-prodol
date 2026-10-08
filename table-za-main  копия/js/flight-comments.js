// Общие комментарии к рейсам (shared/flight-comments.json)
window.FlightComments = (function () {
    const FILE = 'flight-comments.json';
    const LOCAL_KEY = 'krasavia_flight_comments';
    let cache = { version: 1, updatedAt: null, comments: {} };
    let loaded = false;

    function commentKey(flight, date) {
        const fl = typeof cleanFlight === 'function' ? cleanFlight(flight) : String(flight || '');
        const d = String(date || '').trim();
        return fl && d ? `${fl}|${d}` : '';
    }

    // Слияние по каждому рейсу: остаётся более свежая запись (удаление — запись с пустым текстом).
    function mergeComments(a, b) {
        const out = { ...(a && typeof a === 'object' ? a : {}) };
        Object.entries(b && typeof b === 'object' ? b : {}).forEach(([k, v]) => {
            if (!v) return;
            if (!out[k] || String(v.updatedAt || '') > String(out[k].updatedAt || '')) out[k] = v;
        });
        return out;
    }

    async function load() {
        let remote = null;
        if (typeof SharedStorage !== 'undefined' && typeof SharedStorage.readJsonFile === 'function') {
            remote = await SharedStorage.readJsonFile(FILE);
        } else if (typeof SharedStorage !== 'undefined' && location.protocol !== 'file:') {
            try {
                const res = await fetch(`./shared/${FILE}`, { cache: 'no-store' });
                if (res.ok) remote = await res.json();
            } catch { /* ignore */ }
        }
        let local = null;
        try {
            local = JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null');
        } catch { /* ignore */ }
        const merged = mergeComments(remote?.comments, local?.comments);
        if (remote?.comments || local?.comments) {
            cache = {
                version: 1,
                updatedAt: [remote?.updatedAt, local?.updatedAt].filter(Boolean).sort().pop() || null,
                comments: merged
            };
        }
        loaded = true;
        return cache;
    }

    function get(flight, date) {
        const k = commentKey(flight, date);
        if (!k) return '';
        return cache.comments[k]?.text || '';
    }

    function has(flight, date) {
        return !!String(get(flight, date) || '').trim();
    }

    function hasAnyForFlight(flightBase) {
        const base = String(flightBase || '');
        if (!base) return false;
        const prefix = base + '|';
        const n = parseInt(base.replace('KV-', ''), 10);
        return Object.keys(cache.comments).some(k => {
            if (!cache.comments[k]?.text?.trim()) return false;
            if (k.startsWith(prefix)) return true;
            if (n) {
                const fl = k.split('|')[0] || '';
                const fn = parseInt(String(fl).replace('KV-', ''), 10);
                return fn === n || (typeof getBaseFlight === 'function' && getBaseFlight(fl) === getBaseFlight(base));
            }
            return false;
        });
    }

    async function set(flight, date, text, author) {
        const k = commentKey(flight, date);
        if (!k) return false;
        const clean = typeof Security !== 'undefined'
            ? Security.sanitizeTextInput(String(text || ''), 2000)
            : String(text || '').trim().slice(0, 2000);

        const now = new Date().toISOString();
        const entry = {
            text: clean || '',
            updatedAt: now,
            author: author || (typeof ProfileAuth !== 'undefined' ? ProfileAuth.getCurrentProfile()?.name : '') || ''
        };
        // Перед записью перечитываем общий файл — иначе затрём комментарии, добавленные другими.
        let read = { ok: false };
        if (typeof SharedStorage !== 'undefined' && typeof SharedStorage.readJsonFileStrict === 'function') {
            read = await SharedStorage.readJsonFileStrict(FILE).catch(() => ({ ok: false }));
            if (read.ok && read.data?.comments) cache.comments = mergeComments(cache.comments, read.data.comments);
        }
        cache.comments[k] = entry;
        cache.updatedAt = now;

        try {
            localStorage.setItem(LOCAL_KEY, JSON.stringify(cache));
        } catch { /* ignore */ }

        if (read.ok && typeof SharedStorage.writeJsonFile === 'function') {
            await SharedStorage.writeJsonFile(FILE, cache);
        }
        return true;
    }

    function markRows(container) {
        if (!container) return;
        container.querySelectorAll('tr[data-date][data-flight-code]').forEach(tr => {
            const fl = tr.dataset.flightCode || tr.dataset.flightBase;
            const d = tr.dataset.date;
            const hasC = has(fl, d);
            tr.classList.toggle('has-flight-comment', hasC);
            const cell = tr.querySelector('td.col-comment');
            if (!cell) return;
            if (hasC) {
                const text = get(fl, d) || 'Есть комментарий';
                cell.innerHTML = `<span class="comment-mark" aria-label="Есть комментарий">!</span>`;
                cell.title = text;
                cell.classList.add('font-bold');
            } else {
                cell.innerHTML = `<span class="comment-mark-empty">—</span>`;
                cell.removeAttribute('title');
                cell.classList.remove('font-bold');
            }
        });
    }

    return { load, get, has, hasAnyForFlight, set, markRows, commentKey };
})();
