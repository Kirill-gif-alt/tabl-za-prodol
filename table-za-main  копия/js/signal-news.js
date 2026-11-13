// метка "новое": сигнал появился сегодня, а раньше его не было (attention.js, советы снизить/повысить)
// снимок по дням в shared/signals-days.json (7 дней), пишет тот, у кого share_data; иначе localStorage, 3 дня
// в первый день меток нет; вылет, который выпал из окна подсчёта, "новым" не считаем
window.SignalNews = (function () {
    const KEY = 'krasavia_signal_days_v1';
    const KEEP = 3;           // дней в запасном снимке (браузер)
    const KEEP_SHARED = 7;    // дней в общем файле
    const FILE = 'signals-days.json';
    let remote = {};          // дни из общего файла
    let remoteLoad = null;
    let remoteLoadedDay = '';
    let sharedText = '';
    let sharedTimer = 0;

    let advice = [];        // сегодняшние советы up/down: [{ code, date, status, dtd }]
    let adviceAhead = 0;    // на сколько дней вперёд посчитаны, 0 - не считались
    let lastSaved = '';
    let memo = { al: null, sig: '', set: new Set(), base: false };
    let rev = 0;

    function today() { return typeof getTodayDate === 'function' ? getTodayDate() : ''; }

    function load() {
        try {
            const o = JSON.parse(localStorage.getItem(KEY) || '{}');
            return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
        } catch (e) { return {}; }
    }

    function dayNum(dateStr) {
        const d = typeof parseLocalDate === 'function' ? parseLocalDate(dateStr) : null;
        return d ? Math.round(d.getTime() / 86400000) : null;
    }

    // Последний снимок за день ДО сегодняшнего: { d, gap, a: Set, s: Set, h } или null.
    function baseline() {
        const t = dayNum(today());
        if (t == null) return null;
        const all = Object.assign({}, load(), remote);     // общий файл главнее запасного
        let best = null;
        Object.keys(all).forEach(d => {
            const n = dayNum(d);
            if (n != null && n < t && (!best || n > best.n)) best = { n, d };
        });
        if (!best) return null;
        const e = all[best.d] || {};
        return { d: best.d, gap: t - best.n, a: new Set(e.a || []), s: new Set(e.s || []), h: e.h || {} };
    }

    // принять советы от "Сегодня" (ahead - окно дней, 0 если подсказки выключены или недоступны)
    function setAdvice(list, ahead) {
        advice = (list || []).filter(a => a && (a.status === 'up' || a.status === 'down'));
        adviceAhead = ahead || 0;
        rev++;
    }

    // новые за сегодня: Set "рейс|дата", пересчёт только когда сменились сигналы или день
    function fresh() {
        const al = typeof Attention !== 'undefined' ? Attention.list() : [];
        const sig = rev + '|' + today() + '|' + (typeof dataEpoch === 'number' ? dataEpoch : 0);
        if (memo.al === al && memo.sig === sig) return memo;
        const base = baseline();
        const set = new Set();
        if (base) {
            const ha = base.h.a || 0;
            const hs = base.h.s || 0;
            al.forEach(m => {
                if (m.dtd + base.gap <= ha - 1 && !base.a.has(m.orig + '|' + m.date + '|attn')) set.add(m.orig + '|' + m.date);
            });
            advice.forEach(a => {
                if (a.dtd != null && a.dtd + base.gap <= hs && !base.s.has(a.code + '|' + a.date + '|' + a.status)) set.add(a.code + '|' + a.date);
            });
        }
        memo = { al, sig, set, base: !!base };
        return memo;
    }

    function isNew(code, date) { return fresh().set.has(code + '|' + date); }
    function hasBaseline() { return fresh().base; }
    function revision() { const m = fresh(); return m.sig + '|' + m.set.size; }

    // записать снимок за сегодня (прошлые дни не трогаем), зовёт "Сегодня" когда всё посчитано
    function record() {
        try {
            if (typeof Attention === 'undefined' || !today()) return;
            const all = load();
            const entry = {
                a: [...new Set(Attention.list().map(m => m.orig + '|' + m.date + '|attn'))],
                s: advice.map(a => a.code + '|' + a.date + '|' + a.status),
                h: { a: Attention.HORIZON, s: adviceAhead }
            };
            all[today()] = entry;
            const days = Object.keys(all).sort((x, y) => (dayNum(y) || 0) - (dayNum(x) || 0)).slice(0, KEEP);
            const out = {};
            days.forEach(d => { out[d] = all[d]; });
            const str = JSON.stringify(out);
            if (str !== lastSaved) { localStorage.setItem(KEY, str); lastSaved = str; }
        } catch (e) { /* localStorage недоступен — остаётся общий файл */ }
        publishSoon(entryForShared());
    }

    function entryForShared() {
        if (typeof Attention === 'undefined') return null;
        return {
            a: [...new Set(Attention.list().map(m => m.orig + '|' + m.date + '|attn'))],
            s: advice.map(a => a.code + '|' + a.date + '|' + a.status),
            h: { a: Attention.HORIZON, s: adviceAhead }
        };
    }

    function canPublish() {
        return typeof ProfileAuth !== 'undefined' && ProfileAuth.hasPermission && ProfileAuth.hasPermission('share_data') && typeof SharedStorage !== 'undefined';
    }

    // запись в общий файл в фоне, не чаще раза на изменение; чужие дни не трогаем
    function publishSoon(entry) {
        if (!entry || !canPublish()) return;
        const day = today();
        const text = day + JSON.stringify(entry);
        if (text === sharedText) return;
        clearTimeout(sharedTimer);
        sharedTimer = setTimeout(async () => {
            try {
                if (!(await SharedStorage.canWrite())) return;
                const res = await SharedStorage.updateJsonFile(FILE, (cur) => {
                    const days = Object.assign({}, cur && cur.days);
                    days[day] = entry;
                    const keep = Object.keys(days).sort((x, y) => (dayNum(y) || 0) - (dayNum(x) || 0)).slice(0, KEEP_SHARED);
                    const out = {};
                    keep.forEach(d => { out[d] = days[d]; });
                    return { version: 1, updatedAt: new Date().toISOString(), days: out };
                });
                if (res && res.ok) { sharedText = text; remote = Object.assign({}, res.data.days); rev++; }
            } catch (e) { console.warn('SignalNews', e); }
        }, 3000);
    }

    // читаем общий файл в фоне, раз в день и после входа; onDone - перерисовать метки
    function loadShared(onDone) {
        if (typeof SharedStorage === 'undefined' || remoteLoad || remoteLoadedDay === today()) return;
        remoteLoad = SharedStorage.readJsonFileStrict(FILE).then(r => {
            if (r && r.ok && r.data && r.data.days && typeof r.data.days === 'object') { remote = Object.assign({}, r.data.days); rev++; }
            remoteLoadedDay = today();
        }).catch(() => {}).finally(() => { remoteLoad = null; if (onDone) onDone(); });
    }

    // после входа и публикации, в простое: все читают общий файл, публикующий досчитывает советы и пишет снимок
    // без отрисовки "Сегодня"
    function backgroundSoon() {
        const run = () => {
            loadShared(() => {
                if (typeof currentTab !== 'undefined' && currentTab === 'rms' && typeof refreshCurrentView === 'function') refreshCurrentView();
            });
            if (canPublish() && typeof TodayView !== 'undefined' && TodayView.backgroundSignals) {
                TodayView.backgroundSignals().catch(e => console.warn('SignalNews', e));
            }
        };
        if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 30000 });
        else setTimeout(run, 4000);
    }

    return { setAdvice, isNew, hasBaseline, revision, record, loadShared, backgroundSoon };
})();
