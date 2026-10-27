// Общие комментарии к рейсам (shared/flight-comments.json)
window.FlightComments = (function () {
    const FILE = 'flight-comments.json';
    const LOCAL_KEY = 'krasavia_flight_comments';
    let cache = { version: 1, updatedAt: null, comments: {} };

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
        cache.comments[k] = entry;
        cache.updatedAt = now;
        const saveLocal = () => {
            try {
                localStorage.setItem(LOCAL_KEY, JSON.stringify(cache));
            } catch { /* ignore */ }
        };
        saveLocal();   // на этом компьютере комментарий сохранён сразу, что бы ни случилось с общим файлом

        // Общий файл: перечитать → слить со своим → записать «только если файл не менялся с прочтения».
        // Комментарии, которые другие успели добавить между чтением и записью, не теряются (при расхождении — заново).
        let res = { ok: false, readFailed: true };
        if (typeof SharedStorage !== 'undefined' && typeof SharedStorage.updateJsonFile === 'function') {
            res = await SharedStorage.updateJsonFile(FILE, (cur) => ({
                version: 1,
                updatedAt: now,
                comments: mergeComments(cur && cur.comments, cache.comments)
            })).catch(() => ({ ok: false, readFailed: true }));
        }
        if (res.ok && res.data && res.data.comments) {
            cache.comments = mergeComments(cache.comments, res.data.comments);   // заодно видим чужие комментарии
            saveLocal();
        } else if (typeof showToast === 'function') {
            showToast(res.readFailed
                ? 'Общий файл комментариев недоступен — комментарий виден только на этом компьютере'
                : (res.conflict
                    ? 'Комментарий не записан: файл комментариев часто меняют другие. Нажмите «Сохранить» ещё раз'
                    : 'Комментарий не записан в общую папку — виден только на этом компьютере'), 'error');
        }
        return { ok: true, shared: !!res.ok };
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
            // Ячейка уже в нужном состоянии (окно таблицы перерисовывается при каждой прокрутке) — не трогаем.
            const state = hasC ? '1|' + (get(fl, d) || 'Есть комментарий') : '0';
            if (cell.dataset.cm === state) return;
            cell.dataset.cm = state;
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

    return { load, get, has, set, markRows, commentKey };
})();
