// задержанные рейсы: буква после номера в загрузке (KV-203S), номер везде KV-203, признак в r[13]
// карта рейс|исходная -> новая: отметки и билеты старой даты показываем у новой, файлы не трогаем
// исходная дата - ближайшая раньше новой (до 3 дней) с признаками полета: история УП, отметки, билеты, прежняя загрузка
window.DelayedFlights = (function () {
    const MAX_BACK = 3;
    const PREV_KEY = 'krasavia_delayed_prev_v1';
    const WORD = 'задержан';

    let stamp = '';
    let fastStamp = '';
    let any = false;
    let delayedSet = new Set();      // ключ "дата|KV-203", задержанные вылеты
    let originByNew = new Map();     // ключ "KV-203|новая дата" -> исходная дата
    let newByOrigin = new Map();     // ключ "KV-203|исходная дата" -> новая дата
    let building = false;
    let lastRows = null;
    let rev = 0;
    let prevSeen = null;             // вылеты прежней загрузки, ключ "дата|KV-203"

    function code(raw) {
        return typeof cleanFlight === 'function' ? cleanFlight(raw) : String(raw || '');
    }

    function addDays(dateStr, n) {
        const d = typeof parseLocalDate === 'function' ? parseLocalDate(dateStr) : null;
        if (!d) return '';
        d.setDate(d.getDate() + n);
        return String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + d.getFullYear();
    }

    function readPrev() {
        if (prevSeen) return prevSeen;
        prevSeen = new Set();
        try {
            const arr = JSON.parse(localStorage.getItem(PREV_KEY) || '[]');
            if (Array.isArray(arr)) arr.forEach(k => { if (typeof k === 'string') prevSeen.add(k); });
        } catch (e) { /* ignore */ }
        return prevSeen;
    }

    // перед новой загрузкой запоминаем вылеты старых данных (обычные строки): рейс летел по расписанию
    function rememberPrevious(rows) {
        try {
            const keep = readPrev();
            const t = typeof getTodayDate === 'function' ? parseLocalDate(getTodayDate()) : null;
            const floor = t ? t.getTime() - 10 * 86400000 : 0;
            (rows || []).forEach(r => {
                if (!r || r[13] || !r[0] || !r[1]) return;
                const d = parseLocalDate(r[1]);
                if (d && d.getTime() >= floor) keep.add(r[1] + '|' + code(r[0]));
            });
            keep.forEach(k => {
                const d = parseLocalDate(k.slice(0, k.indexOf('|')));
                if (!d || d.getTime() < floor) keep.delete(k);
            });
            localStorage.setItem(PREV_KEY, JSON.stringify([...keep]));
        } catch (e) { /* ignore */ }
    }

    function sm() {
        return typeof SalesManagement !== 'undefined' ? SalesManagement : null;
    }

    function hadTickets(c, date) {
        const k = date + '|' + c;
        if (typeof salesDetails !== 'undefined' && salesDetails && salesDetails[k] && salesDetails[k].length) return true;
        return typeof SalesReconcile !== 'undefined' && SalesReconcile.wasMovedFrom ? SalesReconcile.wasMovedFrom(k) : false;
    }

    // Есть ли признаки, что рейс c должен был лететь date.
    function plannedOn(c, date) {
        const s = sm();
        if (s && s.hadDeparture && s.hadDeparture(c, date)) return true;
        if (s && s.hasMarksOn && s.hasMarksOn(c, date)) return true;
        if (hadTickets(c, date)) return true;
        return readPrev().has(date + '|' + c);
    }

    function evidenceStamp() {
        const s = sm();
        return [typeof dataEpoch === 'number' ? dataEpoch : 0,
            s && s.rawMarkRevision ? s.rawMarkRevision() : '',
            s && s.departureCount ? s.departureCount() : 0,
            window.krasaviaIngestSeq || 0,
            typeof SalesReconcile !== 'undefined' && SalesReconcile.runCount ? SalesReconcile.runCount() : 0].join('|');
    }

    function build() {
        const delayed = [];
        const present = new Set();
        const rows = typeof allData !== 'undefined' && allData ? allData : [];
        for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            if (r && r[13] && r[0] && r[1]) delayed.push(r);
        }
        delayedSet = new Set();
        originByNew = new Map();
        newByOrigin = new Map();
        any = delayed.length > 0;
        if (!any) return;
        for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            if (r && r[0] && r[1]) present.add(r[1] + '|' + code(r[0]));
        }
        const seen = new Set();
        const list = [];
        delayed.forEach(r => {
            const k = r[1] + '|' + code(r[0]);
            delayedSet.add(k);
            if (!seen.has(k)) { seen.add(k); list.push({ c: code(r[0]), d: r[1] }); }
        });
        // сортируем по датам, чтобы результат не зависел от порядка строк
        list.sort((a, b) => ((parseLocalDate(a.d) || 0) - (parseLocalDate(b.d) || 0)) || a.c.localeCompare(b.c));
        list.forEach(it => {
            for (let back = 1; back <= MAX_BACK; back++) {
                const o = addDays(it.d, -back);
                if (!o || present.has(o + '|' + it.c) || newByOrigin.has(it.c + '|' + o)) continue;
                if (!plannedOn(it.c, o)) continue;
                originByNew.set(it.c + '|' + it.d, o);
                newByOrigin.set(it.c + '|' + o, it.d);
                break;
            }
        });
    }

    function ensure() {
        if (building) return;
        const rows = typeof allData !== 'undefined' ? allData : null;
        const fs = (typeof dataEpoch === 'number' ? dataEpoch : 0) + ':' + (rows ? rows.length : 0);
        if (rows === lastRows && fs === fastStamp && (!any || evidenceStamp() === stamp)) return;
        building = true;
        try {
            build();
        } finally {
            building = false;
        }
        lastRows = rows;
        fastStamp = fs;
        stamp = any ? evidenceStamp() : '';
        rev++;
    }

    function isDelayed(rowOrCode, date) {
        if (Array.isArray(rowOrCode)) {
            if (rowOrCode[13]) return true;
            return isDelayed(rowOrCode[0], rowOrCode[1]);
        }
        ensure();
        if (!any) return false;
        return delayedSet.has(date + '|' + code(rowOrCode));
    }

    function originOf(c, newDate) {
        ensure();
        if (!any) return '';
        return originByNew.get(code(c) + '|' + newDate) || '';
    }

    function movedTo(c, origDate) {
        ensure();
        if (!any) return '';
        return newByOrigin.get(code(c) + '|' + origDate) || '';
    }

    function revision() {
        ensure();
        return any ? rev : 0;
    }

    // метка у даты или номера, без исходной даты и подсказки
    function tag(rowOrCode, date) {
        return isDelayed(rowOrCode, date) ? ` <span class="delay-badge">${WORD}</span>` : '';
    }

    // для Excel: суффикс " (задержан)" к дате или номеру
    function xlSuffix(rowOrCode, date) {
        return isDelayed(rowOrCode, date) ? ` (${WORD})` : '';
    }

    return { isDelayed, originOf, movedTo, revision, tag, xlSuffix, rememberPrevious };
})();
