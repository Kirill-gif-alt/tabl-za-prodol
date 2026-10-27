// Общие комментарии к рейсам (shared/flight-comments.json)
window.FlightComments = (function () {
    const FILE = 'flight-comments.json';
    const LOCAL_KEY = 'krasavia_flight_comments';
    const RETRY_FIRST_MS = 15000;
    const RETRY_MAX_MS = 120000;
    let cache = { version: 1, updatedAt: null, comments: {} };
    // Есть комментарии, которые ещё не попали в общий файл (нет связи, папка закрыта на запись): запись повторяется сама.
    let unsynced = false;
    let inflight = 0;
    let retryTimer = null;
    let retryMs = RETRY_FIRST_MS;

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

    // Файл мог быть восстановлен из резервной копии (restoredAt): записи старше этого момента, оставшиеся
    // в кэше браузера, не должны вернуть ошибочное содержимое обратно.
    function newerThan(map, since) {
        if (!since) return map;
        const out = {};
        Object.entries(map && typeof map === 'object' ? map : {}).forEach(([k, v]) => {
            if (v && String(v.updatedAt || '') >= String(since)) out[k] = v;
        });
        return out;
    }

    function saveLocal() {
        try {
            localStorage.setItem(LOCAL_KEY, JSON.stringify({ ...cache, unsynced }));
        } catch { /* ignore */ }
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
        const merged = mergeComments(remote?.comments, newerThan(local?.comments, remote?.restoredAt));
        if (remote?.comments || local?.comments) {
            cache = {
                version: 1,
                updatedAt: [remote?.updatedAt, local?.updatedAt].filter(Boolean).sort().pop() || null,
                comments: merged
            };
        }
        // Прошлый сеанс не успел записать комментарии в общий файл — дописываем сейчас.
        if (local && local.unsynced) {
            unsynced = true;
            scheduleRetry(1500);
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

    // Время последней правки комментария: страница запоминает его при показе и передаёт в set(opts.base),
    // чтобы заметить, что за это время комментарий уже изменил кто-то другой.
    function updatedAtOf(flight, date) {
        const k = commentKey(flight, date);
        return (k && cache.comments[k]?.updatedAt) || '';
    }

    function pushShared(mutateExtra) {
        if (typeof SharedStorage === 'undefined' || typeof SharedStorage.updateJsonFile !== 'function') {
            return Promise.resolve({ ok: false, readFailed: true });
        }
        // Перечитать общий файл → слить со своим → записать «только если файл не менялся с прочтения».
        // Комментарии, которые другие успели добавить между чтением и записью, не теряются (при расхождении — заново).
        return SharedStorage.updateJsonFile(FILE, (cur) => {
            if (mutateExtra) {
                const stop = mutateExtra(cur);
                if (stop) return false;
            }
            const since = cur && cur.restoredAt ? String(cur.restoredAt) : '';
            const payload = { version: 1, updatedAt: new Date().toISOString(), comments: mergeComments(cur && cur.comments, newerThan(cache.comments, since)) };
            if (since) payload.restoredAt = since;
            return payload;
        }).catch(() => ({ ok: false, readFailed: true }));
    }

    function markSynced(data) {
        if (data && data.comments) cache.comments = mergeComments(newerThan(cache.comments, data.restoredAt), data.comments);   // заодно видим чужие комментарии
        if (!inflight) { unsynced = false; retryMs = RETRY_FIRST_MS; }
        saveLocal();
    }

    function scheduleRetry(ms) {
        if (retryTimer) return;
        retryTimer = setTimeout(async () => {
            retryTimer = null;
            if (!unsynced || inflight) return;
            inflight++;
            let res;
            try { res = await pushShared(); } finally { inflight--; }
            if (res.ok) {
                markSynced(res.data);
                if (typeof showToast === 'function') showToast('Комментарии записаны в общую папку');
            } else {
                retryMs = Math.min(retryMs * 3, RETRY_MAX_MS);
                scheduleRetry();
            }
        }, ms || retryMs);
    }

    // Результат: false — рейс не распознан; { ok: true, shared } — комментарий сохранён (shared — и в общем файле);
    // { ok: false, conflict: { text, author, updatedAt } } — пока вы правили, комментарий изменил другой человек:
    // ничего не записано, чужой текст показан, свой остаётся у вас в окне.
    async function set(flight, date, text, author, opts) {
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
        const base = opts && typeof opts.base === 'string' ? opts.base : null;   // null — не проверяем
        const prevUnsynced = unsynced;
        cache.comments[k] = entry;
        cache.updatedAt = now;
        unsynced = true;
        saveLocal();   // на этом компьютере комментарий сохранён сразу, что бы ни случилось с общим файлом

        let conflict = null;
        inflight++;
        let res;
        try {
            res = await pushShared((cur) => {
                conflict = null;
                const theirs = cur && cur.comments && cur.comments[k];
                // Комментарий к этому рейсу после того, как вы его открыли, изменил другой человек, и текст у него иной.
                if (base !== null && theirs && String(theirs.updatedAt || '') > base && String(theirs.text || '') !== entry.text) {
                    conflict = theirs;
                    return true;
                }
                return false;
            });
        } finally {
            inflight--;
        }

        if (conflict) {
            // Ничего не записано: возвращаем прежнее состояние и показываем чужую запись.
            cache.comments[k] = conflict;
            unsynced = prevUnsynced;
            saveLocal();
            return { ok: false, conflict: { text: String(conflict.text || ''), author: String(conflict.author || ''), updatedAt: String(conflict.updatedAt || '') } };
        }
        if (res.ok) {
            markSynced(res.data);
            return { ok: true, shared: true };
        }
        saveLocal();
        if (typeof showToast === 'function') {
            showToast(res.readFailed
                ? 'Общий файл комментариев недоступен — комментарий виден только на этом компьютере, запись повторится сама'
                : (res.conflict
                    ? 'Комментарий не записан: файл комментариев часто меняют другие. Запись повторится сама'
                    : 'Комментарий не записан в общую папку — виден только на этом компьютере, запись повторится сама'), 'error');
        }
        scheduleRetry();
        return { ok: true, shared: false };
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

    return { load, get, has, set, markRows, commentKey, updatedAtOf };
})();
