// Задержанные рейсы. В файле загрузки задержанный рейс идёт с буквой после номера («KV-203S», «KV-204D»):
// он вылетает позже, чем должен был. Номер везде остаётся KV-203, а признак лежит в строке: r[13] = буква.
// Здесь — карта «рейс|исходная дата → новая дата»: по ней отметки «Управления продажами» и билеты
// исходной даты показываются у новой. Файлы отметок не переписываются, сопоставление только при чтении.
// Исходная дата — ближайшая дата раньше новой (не дальше 3 дней), на которую этот рейс должен был лететь,
// но его строки в файле нет. «Должен был» видно по: истории вылетов «Управления продажами», отметкам на этой дате,
// билетам файла продаж на неё, прежней загрузке (запоминается при каждой новой загрузке).
// Карта строится один раз на данные; без задержанных рейсов проверка — сравнение трёх значений.
window.DelayedFlights = (function () {
    const MAX_BACK = 3;
    const PREV_KEY = 'krasavia_delayed_prev_v1';
    const WORD = 'задержан';

    let stamp = '';
    let fastStamp = '';
    let any = false;
    let delayedSet = new Set();      // 'дата|KV-203' — задержанные вылеты
    let originByNew = new Map();     // 'KV-203|новая дата' → исходная дата
    let newByOrigin = new Map();     // 'KV-203|исходная дата' → новая дата
    let building = false;
    let lastRows = null;
    let rev = 0;
    let prevSeen = null;             // Set 'дата|KV-203' — вылеты прежней загрузки

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

    // Перед новой загрузкой: вылеты прежних данных (обычные строки) — свидетельство, что рейс летел по расписанию.
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
        // По порядку дат: так результат один и тот же при любом порядке строк.
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

    // Метка рядом с датой или номером: без исходной даты и без подсказки.
    function tag(rowOrCode, date) {
        return isDelayed(rowOrCode, date) ? ` <span class="delay-badge">${WORD}</span>` : '';
    }

    // Для выгрузок в Excel: « (задержан)» к дате или номеру.
    function xlSuffix(rowOrCode, date) {
        return isDelayed(rowOrCode, date) ? ` (${WORD})` : '';
    }

    return { isDelayed, originOf, movedTo, revision, tag, xlSuffix, rememberPrevious };
})();
