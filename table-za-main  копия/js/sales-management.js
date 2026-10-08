// Вкладка «Управление продажами»: своя таблица на номер рейса.
// Отметки и запомненные даты лежат в shared/sales-management.json. Их видят все, у кого есть эта вкладка:
// страница перечитывает файл каждые 30 минут. Запись проходит, если папка приложения подключена.
// «С» у строк и столбцов не сдвигается само. «По» у строк растёт до позднего вылета.
// Столбцы заполнения кончаются сегодня: слева сегодня, вправо более ранние дни. Завтра новый день встаёт слева.
// Вылет, который ещё не улетел, повторяет загрузку: перенос даты убирает старую строку, тип ВС берётся свежий.
// Улетевшие вылеты остаются как были.
window.SalesManagement = (function () {
    const FILE = 'sales-management.json';
    const LOCAL_KEY = 'krasavia_sales_mgmt_v1';
    const DEFAULT_ROWS_FROM = '18.09.2026';
    const DEFAULT_COLS_FROM = '01.10.2026';
    const STATUSES = {
        keep: { label: 'Проверено без изменений', short: 'Без изменений' },
        attn: { label: 'Обратить внимание', short: 'Внимание', sign: '!' },
        down: { label: 'Снижение', short: 'Снижение' },
        up: { label: 'Повышение', short: 'Повышение' }
    };

    const ADMIN_SIGNATURE = 'Лобанов К.И.';

    let cache = {
        version: 1,
        updatedAt: null,
        marks: {},
        enabledRoutes: null,
        routesUpdatedAt: null,
        historyFrom: null,
        rowsFrom: null,
        rowsTo: null,
        colsTo: null,
        rangesUpdatedAt: null,
        departures: {}
    };
    let loaded = false;
    let dirty = new Map();
    let routesDirty = false;
    let historyDirty = false;
    let holdEnds = false;
    let persistChain = Promise.resolve();
    let persistTimer = null;
    let retryTimer = null;
    let lastWriteOk = true;
    let loadedAt = 0;
    let builtFlights = null;
    let builtFlightKey = '';
    let liveSchedule = null;

    function statusOk(status) {
        return !!STATUSES[status];
    }

    function cleanAuthor(value) {
        const raw = typeof Security !== 'undefined'
            ? Security.sanitizeTextInput(value, 80)
            : String(value ?? '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').trim().slice(0, 80);
        return raw;
    }

    function markKey(flight, dep, check) {
        const fl = typeof cleanFlight === 'function' ? cleanFlight(flight) : String(flight || '');
        const d1 = typeof normalizeDate === 'function' ? normalizeDate(dep) : String(dep || '');
        const d2 = typeof normalizeDate === 'function' ? normalizeDate(check) : String(check || '');
        if (!/^KV-\d{1,6}$/.test(fl)) return '';
        if (typeof parseLocalDate !== 'function' || !parseLocalDate(d1) || !parseLocalDate(d2)) return '';
        return `${fl}|${d1}|${d2}`;
    }

    function canEdit() {
        return typeof ProfileAuth !== 'undefined' && ProfileAuth.hasPermission('edit_sales_mgmt');
    }

    function canView() {
        if (typeof ProfileAuth === 'undefined') return true;
        return ProfileAuth.canAccessTab('sales');
    }

    function authorSignature(value) {
        const name = cleanAuthor(value);
        if (name === 'Администратор') return ADMIN_SIGNATURE;
        return name;
    }

    function profileName() {
        if (typeof ProfileAuth === 'undefined' || typeof ProfileAuth.getCurrentProfile !== 'function') return '';
        const prof = ProfileAuth.getCurrentProfile();
        if (!prof) return '';
        if (prof.isAdmin || String(prof.name || '').trim() === 'Администратор') return ADMIN_SIGNATURE;
        return authorSignature(prof.name);
    }

    function normalizeRouteList(value) {
        if (!Array.isArray(value)) return null;
        const out = [];
        value.forEach(item => {
            const name = String(item || '').replace(/[\u0000-\u001F]/g, '').trim().slice(0, 120);
            if (name && out.indexOf(name) === -1) out.push(name);
        });
        return out;
    }

    function hasRouteField(src) {
        return !!(src && (Object.prototype.hasOwnProperty.call(src, 'enabledRoutes') || src.routesUpdatedAt));
    }

    function takeRoutes(remote, local) {
        const remoteHas = hasRouteField(remote);
        const localHas = hasRouteField(local);
        const remoteAt = (remote && remote.routesUpdatedAt) || '';
        const localAt = (local && local.routesUpdatedAt) || '';
        if (localHas && (!remoteHas || String(localAt) > String(remoteAt))) {
            return {
                enabledRoutes: normalizeRouteList(local.enabledRoutes),
                routesUpdatedAt: local.routesUpdatedAt || null,
                dirty: true
            };
        }
        if (remoteHas) {
            return {
                enabledRoutes: normalizeRouteList(remote.enabledRoutes),
                routesUpdatedAt: remote.routesUpdatedAt || null,
                dirty: false
            };
        }
        return { enabledRoutes: null, routesUpdatedAt: null, dirty: false };
    }

    function isFlownDate(dateStr, today) {
        if (typeof parseLocalDate !== 'function') return false;
        const fd = parseLocalDate(dateStr);
        if (!fd) return false;
        const t = today ? new Date(today.getTime()) : new Date();
        t.setHours(0, 0, 0, 0);
        return fd < t;
    }

    function checkDatesBetween(todayDate, maxDepDate, extraDates) {
        const out = [];
        if (todayDate && maxDepDate && maxDepDate >= todayDate) {
            const d = new Date(todayDate.getFullYear(), todayDate.getMonth(), todayDate.getDate());
            const end = new Date(maxDepDate.getFullYear(), maxDepDate.getMonth(), maxDepDate.getDate());
            while (d <= end) {
                out.push(formatDateRu(d));
                d.setDate(d.getDate() + 1);
            }
        }
        (extraDates || []).forEach(item => {
            const norm = typeof normalizeDate === 'function' ? normalizeDate(item) : String(item || '');
            if (norm && out.indexOf(norm) === -1 && typeof parseLocalDate === 'function' && parseLocalDate(norm)) {
                out.push(norm);
            }
        });
        if (typeof compareDateStr === 'function') out.sort(compareDateStr);
        return out;
    }

    function columnCheckDates(fromValue, todayValue) {
        const from = fromValue instanceof Date ? new Date(fromValue.getTime()) : (typeof parseLocalDate === 'function' ? parseLocalDate(fromValue) : null);
        const today = todayValue instanceof Date ? new Date(todayValue.getTime()) : (typeof parseLocalDate === 'function' ? parseLocalDate(todayValue) : null);
        const dates = checkDatesBetween(from, today, []);
        dates.reverse();
        return dates;
    }

    function columnTodayStr() {
        if (typeof getTodayDate === 'function') return getTodayDate();
        return typeof formatDateRu === 'function' ? formatDateRu(startOfToday()) : '';
    }

    function startOfToday() {
        const t = new Date();
        t.setHours(0, 0, 0, 0);
        return t;
    }

    function dateOnly(value) {
        const norm = typeof normalizeDate === 'function' ? normalizeDate(value) : String(value || '');
        if (!norm || typeof parseLocalDate !== 'function' || !parseLocalDate(norm)) return '';
        return norm;
    }

    function earlierDate(a, b) {
        if (!a) return b || '';
        if (!b) return a;
        if (typeof compareDateStr === 'function') return compareDateStr(a, b) <= 0 ? a : b;
        return a <= b ? a : b;
    }

    function laterDate(a, b) {
        if (!a) return b || '';
        if (!b) return a;
        if (typeof compareDateStr === 'function') return compareDateStr(a, b) >= 0 ? a : b;
        return a >= b ? a : b;
    }

    function rowsFromValue() {
        return dateOnly(cache.rowsFrom) || DEFAULT_ROWS_FROM;
    }

    function colsFromValue() {
        return dateOnly(cache.historyFrom) || DEFAULT_COLS_FROM;
    }

    function rowsToValue() {
        return dateOnly(cache.rowsTo) || rowsFromValue();
    }

    function colsToValue() {
        return dateOnly(cache.colsTo) || colsFromValue();
    }

    function dateNotAfter(start, end) {
        if (!start || !end || typeof compareDateStr !== 'function') return true;
        return compareDateStr(start, end) <= 0;
    }

    function normalizeDepartures(src) {
        const out = {};
        if (!src || typeof src !== 'object') return out;
        Object.keys(src).forEach(key => {
            const item = src[key] || {};
            const code = operatingCode(item.code || String(key).split('|')[0]);
            const date = dateOnly(item.date || String(key).split('|')[1]);
            if (!code || !date) return;
            const rawCraft = String(item.aircraft || '').replace(/[\u0000-\u001F]/g, '').trim().slice(0, 40);
            const aircraft = rawCraft && rawCraft !== '-' ? rawCraft : '—';
            const id = code + '|' + date;
            const prev = out[id];
            if (!prev) {
                out[id] = { code, date, aircraft };
                return;
            }
            if ((prev.aircraft === '—' || prev.aircraft === '-') && aircraft !== '—') prev.aircraft = aircraft;
        });
        return out;
    }

    function mergeDepartureMaps(into, extra) {
        const base = into || {};
        Object.keys(extra || {}).forEach(key => {
            const item = extra[key];
            if (!item) return;
            const prev = base[key];
            if (!prev) {
                base[key] = { code: item.code, date: item.date, aircraft: item.aircraft || '—' };
                return;
            }
            if ((prev.aircraft === '—' || prev.aircraft === '-') && item.aircraft && item.aircraft !== '—' && item.aircraft !== '-') {
                prev.aircraft = item.aircraft;
            }
        });
        return base;
    }

    function readLiveSchedule(grouped) {
        const items = new Map();
        let from = '';
        let to = '';
        Object.keys(grouped || {}).forEach(bucket => {
            (grouped[bucket] || []).forEach(row => {
                if (!row || !row[0] || !row[1]) return;
                const code = operatingCode(row[0]);
                const date = dateOnly(row[1]);
                if (!code || !date) return;
                const raw = typeof getAircraftType === 'function' ? getAircraftType(row[4]) : (row[4] || '—');
                const aircraft = raw && raw !== '-' ? raw : '—';
                const id = code + '|' + date;
                const prev = items.get(id);
                if (!prev) items.set(id, { code, date, aircraft });
                else if (prev.aircraft === '—' && aircraft !== '—') prev.aircraft = aircraft;
                from = earlierDate(from, date);
                to = laterDate(to, date);
            });
        });
        return items.size ? { items, from, to } : null;
    }

    // Не улетевшие вылеты в пределах дат загрузки сверяются с ней: лишние уходят, тип ВС переписывается.
    function syncWithLive(map) {
        if (!liveSchedule || !map || typeof compareDateStr !== 'function') return false;
        const today = startOfToday();
        let changed = false;
        Object.keys(map).forEach(id => {
            const item = map[id];
            if (!item || !item.date || isFlownDate(item.date, today)) return;
            if (compareDateStr(item.date, liveSchedule.from) < 0 || compareDateStr(item.date, liveSchedule.to) > 0) return;
            const live = liveSchedule.items.get(id);
            if (!live) {
                delete map[id];
                changed = true;
                return;
            }
            if (live.aircraft !== '—' && item.aircraft !== live.aircraft) {
                item.aircraft = live.aircraft;
                changed = true;
            }
        });
        return changed;
    }

    function departureSig(map) {
        return Object.keys(map || {}).sort().map(key => {
            const item = map[key] || {};
            return key + '=' + (item.aircraft || '');
        }).join('\n');
    }

    function resolveRanges(remote, local) {
        const remoteAt = (remote && remote.rangesUpdatedAt) || '';
        const localAt = (local && local.rangesUpdatedAt) || '';
        const preferLocal = String(localAt) > String(remoteAt);
        const primary = preferLocal ? local : remote;
        const secondary = preferLocal ? remote : local;
        const migrated = dateOnly(remote && remote.rowsFrom) || dateOnly(local && local.rowsFrom);
        const rowsFrom = migrated
            ? (dateOnly(primary && primary.rowsFrom) || dateOnly(secondary && secondary.rowsFrom) || DEFAULT_ROWS_FROM)
            : DEFAULT_ROWS_FROM;
        const historyFrom = migrated
            ? (dateOnly(primary && primary.historyFrom) || dateOnly(secondary && secondary.historyFrom) || DEFAULT_COLS_FROM)
            : DEFAULT_COLS_FROM;
        let rowsTo = laterDate(dateOnly(remote && remote.rowsTo), dateOnly(local && local.rowsTo));
        let colsTo = laterDate(dateOnly(remote && remote.colsTo), dateOnly(local && local.colsTo));
        if (remoteAt || localAt) {
            const winner = String(localAt) >= String(remoteAt) ? local : remote;
            rowsTo = dateOnly(winner && winner.rowsTo) || rowsTo;
            colsTo = dateOnly(winner && winner.colsTo) || colsTo;
        }
        const departures = normalizeDepartures(remote && remote.departures);
        mergeDepartureMaps(departures, normalizeDepartures(local && local.departures));
        const rangesUpdatedAt = String(localAt) > String(remoteAt) ? (localAt || null) : (remoteAt || null);
        const sameStarts = dateOnly(remote && remote.rowsFrom) === rowsFrom
            && dateOnly(remote && remote.historyFrom) === historyFrom;
        const sameEnds = (dateOnly(remote && remote.rowsTo) || '') === (rowsTo || '')
            && (dateOnly(remote && remote.colsTo) || '') === (colsTo || '');
        const sameDeps = departureSig(normalizeDepartures(remote && remote.departures)) === departureSig(departures);
        return {
            rowsFrom,
            historyFrom,
            rowsTo: rowsTo || '',
            colsTo: colsTo || '',
            departures,
            rangesUpdatedAt,
            dirty: !sameStarts || !sameEnds || !sameDeps
        };
    }

    function operatingCode(raw) {
        const code = typeof cleanFlight === 'function' ? cleanFlight(raw) : String(raw || '');
        return /^KV-\d{1,6}$/.test(code) ? code : '';
    }

    function baseCode(code) {
        const clean = operatingCode(code);
        if (!clean || typeof getBaseFlight !== 'function') return clean;
        const base = operatingCode(getBaseFlight(clean));
        return base || clean;
    }

    function isSalesAdmin() {
        if (typeof ProfileAuth === 'undefined' || typeof ProfileAuth.getCurrentProfile !== 'function') return true;
        const prof = ProfileAuth.getCurrentProfile();
        return !!(prof && prof.isAdmin);
    }

    function getRanges() {
        return {
            rowsFrom: rowsFromValue(),
            rowsTo: rowsToValue(),
            colsFrom: colsFromValue(),
            colsTo: colsToValue()
        };
    }

    function setRanges(next) {
        if (!isSalesAdmin()) return false;
        const rowsFrom = dateOnly(next && next.rowsFrom);
        const rowsTo = dateOnly(next && next.rowsTo);
        const colsFrom = dateOnly(next && next.colsFrom);
        const colsTo = dateOnly(next && next.colsTo);
        if (!rowsFrom || !rowsTo || !colsFrom || !colsTo) return false;
        if (!dateNotAfter(rowsFrom, rowsTo) || !dateNotAfter(colsFrom, colsTo)) return false;
        cache.rowsFrom = rowsFrom;
        cache.rowsTo = rowsTo;
        cache.historyFrom = colsFrom;
        cache.colsTo = colsTo;
        cache.rangesUpdatedAt = new Date().toISOString();
        historyDirty = true;
        holdEnds = true;
        builtFlights = null;
        try {
            const prev = JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null');
            const stored = (prev && typeof prev === 'object') ? prev : { version: 1, marks: {} };
            stored.rowsFrom = rowsFrom;
            stored.rowsTo = rowsTo;
            stored.historyFrom = colsFrom;
            stored.colsTo = colsTo;
            stored.rangesUpdatedAt = cache.rangesUpdatedAt;
            stored.departures = cache.departures || {};
            localStorage.setItem(LOCAL_KEY, JSON.stringify(stored));
        } catch (e) { /* ignore */ }
        schedulePersist();
        return true;
    }

    function absorbMarks(src, into, renamed) {
        Object.keys(src || {}).forEach(key => {
            const entry = src[key];
            if (!entry || !statusOk(entry.status)) return;
            const rawAuthor = cleanAuthor(entry.author || '');
            const author = authorSignature(rawAuthor);
            const prev = into[key];
            if (!prev || String(entry.updatedAt || '') >= String(prev.updatedAt || '')) {
                into[key] = {
                    status: entry.status,
                    author,
                    updatedAt: entry.updatedAt || ''
                };
                if (renamed) {
                    if (author !== rawAuthor) renamed.add(key);
                    else renamed.delete(key);
                }
            }
        });
    }

    async function readRemote() {
        if (typeof SharedStorage === 'undefined' || typeof SharedStorage.readJsonFile !== 'function') return null;
        try {
            return await SharedStorage.readJsonFile(FILE);
        } catch (e) {
            return null;
        }
    }

    function updateSaveStatus() {
        const el = document.getElementById('sm-save-status');
        if (!el) return;
        if (!dirty.size && lastWriteOk) {
            el.textContent = cache.updatedAt ? 'Отметки общие' : '';
            el.className = 'sm-save-status';
            return;
        }
        if (!lastWriteOk) {
            el.textContent = 'На этом компьютере сохранено. Подключите папку приложения, чтобы отметку увидели остальные';
            el.className = 'sm-save-status sm-save-warn';
            return;
        }
        el.textContent = 'Сохранение…';
        el.className = 'sm-save-status';
    }

    async function persistNow() {
        if (!dirty.size && !routesDirty && !historyDirty) return lastWriteOk;
        const batch = new Map(dirty);
        const saveRoutes = routesDirty;
        const saveHistory = historyDirty;
        const pinEnds = holdEnds;
        dirty.clear();
        routesDirty = false;
        historyDirty = false;
        holdEnds = false;
        const remote = await readRemote();
        const marks = { ...((remote && remote.marks) || {}) };
        batch.forEach((mark, key) => {
            if (!mark) {
                delete marks[key];
                return;
            }
            const remoteAt = marks[key] && marks[key].updatedAt || '';
            if (String(mark.updatedAt || '') >= String(remoteAt)) marks[key] = mark;
        });
        Object.keys(cache.marks).forEach(key => {
            if (batch.has(key) || dirty.has(key)) return;
            const local = cache.marks[key];
            if (!local) return;
            if (!marks[key]) {
                if (String(remote && remote.updatedAt || '') > String(local.updatedAt || '')) return;
                marks[key] = local;
            } else if (String(local.updatedAt || '') > String(marks[key].updatedAt || '')) {
                marks[key] = local;
            }
        });
        dirty.forEach((mark, key) => {
            if (!mark) delete marks[key];
            else marks[key] = mark;
        });
        cache.marks = marks;
        markRev++;
        if (!saveRoutes) {
            const remoteAt = (remote && remote.routesUpdatedAt) || '';
            if (String(remoteAt) > String(cache.routesUpdatedAt || '')) {
                cache.enabledRoutes = normalizeRouteList(remote && remote.enabledRoutes);
                cache.routesUpdatedAt = remote.routesUpdatedAt || null;
            }
        }
        if (remote && remote.departures) mergeDepartureMaps(cache.departures, normalizeDepartures(remote.departures));
        syncWithLive(cache.departures);
        if (!pinEnds && remote) {
            const raisedRows = laterDate(dateOnly(cache.rowsTo), dateOnly(remote.rowsTo));
            const raisedCols = laterDate(dateOnly(cache.colsTo), dateOnly(remote.colsTo));
            if (raisedRows) cache.rowsTo = raisedRows;
            if (raisedCols) cache.colsTo = raisedCols;
        }
        if (!saveHistory && remote && String(remote.rangesUpdatedAt || '') > String(cache.rangesUpdatedAt || '')) {
            const remoteRowsFrom = dateOnly(remote.rowsFrom);
            const remoteColsFrom = dateOnly(remote.historyFrom);
            if (remoteRowsFrom) cache.rowsFrom = remoteRowsFrom;
            if (remoteColsFrom) cache.historyFrom = remoteColsFrom;
            const remoteRowsTo = dateOnly(remote.rowsTo);
            const remoteColsTo = dateOnly(remote.colsTo);
            if (remoteRowsTo) cache.rowsTo = remoteRowsTo;
            if (remoteColsTo) cache.colsTo = remoteColsTo;
            cache.rangesUpdatedAt = remote.rangesUpdatedAt || null;
        }
        if (!dateOnly(cache.rowsFrom)) cache.rowsFrom = DEFAULT_ROWS_FROM;
        if (!dateOnly(cache.historyFrom)) cache.historyFrom = DEFAULT_COLS_FROM;
        cache.version = 1;
        cache.updatedAt = new Date().toISOString();
        const payload = {
            version: 1,
            updatedAt: cache.updatedAt,
            marks: cache.marks,
            enabledRoutes: Array.isArray(cache.enabledRoutes) ? cache.enabledRoutes.slice() : null,
            routesUpdatedAt: cache.routesUpdatedAt || null,
            historyFrom: colsFromValue(),
            rowsFrom: rowsFromValue(),
            rowsTo: dateOnly(cache.rowsTo) || null,
            colsTo: dateOnly(cache.colsTo) || null,
            rangesUpdatedAt: cache.rangesUpdatedAt || null,
            departures: cache.departures || {}
        };
        try { localStorage.setItem(LOCAL_KEY, JSON.stringify(cache)); } catch (e) { /* ignore */ }
        let ok = false;
        if (typeof SharedStorage !== 'undefined' && typeof SharedStorage.writeJsonFile === 'function') {
            ok = await SharedStorage.writeJsonFile(FILE, payload);
        }
        if (!ok) {
            batch.forEach((mark, key) => {
                if (!dirty.has(key)) dirty.set(key, mark);
            });
            if (saveRoutes) routesDirty = true;
            if (saveHistory) historyDirty = true;
            if (pinEnds) holdEnds = true;
            if (!retryTimer) {
                retryTimer = setTimeout(() => {
                    retryTimer = null;
                    if (dirty.size || routesDirty || historyDirty) schedulePersist();
                }, 5000);
            }
        }
        lastWriteOk = !!ok || (!ok && !batch.size && !saveRoutes && !canEdit());
        updateSaveStatus();
        builtFlights = null;
        return ok;
    }

    function schedulePersist() {
        updateSaveStatus();
        clearTimeout(persistTimer);
        persistTimer = setTimeout(() => {
            // Обнуляем: иначе hasPending() навсегда true и фоновая подгрузка чужих отметок не идёт.
            persistTimer = null;
            persistChain = persistChain.then(() => persistNow()).catch(() => {});
        }, 400);
    }

    async function flush() {
        clearTimeout(persistTimer);
        persistTimer = null;
        persistChain = persistChain.then(() => persistNow()).catch(() => {});
        await persistChain;
    }

    async function load(force) {
        if (loaded && !force && !dirty.size && !routesDirty && !historyDirty) return cache;
        await flush();
        const remote = await readRemote();
        let local = null;
        try { local = JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null'); } catch (e) { local = null; }
        const keepRoutes = routesDirty;
        const keepEnabled = cache.enabledRoutes;
        const keepAt = cache.routesUpdatedAt;
        const keepHistory = historyDirty;
        const keptRanges = {
            historyFrom: cache.historyFrom,
            rowsFrom: cache.rowsFrom,
            rowsTo: cache.rowsTo,
            colsTo: cache.colsTo,
            rangesUpdatedAt: cache.rangesUpdatedAt,
            departures: cache.departures
        };
        const renamed = new Set();
        const marks = {};
        absorbMarks(remote && remote.marks, marks, renamed);
        absorbMarks(local && local.marks, marks, renamed);
        const routeState = takeRoutes(remote, local);
        const rangeState = resolveRanges(remote, local);
        markRev++;
        cache = {
            version: 1,
            updatedAt: (remote && remote.updatedAt) || (local && local.updatedAt) || null,
            marks,
            enabledRoutes: routeState.enabledRoutes,
            routesUpdatedAt: routeState.routesUpdatedAt,
            historyFrom: rangeState.historyFrom,
            rowsFrom: rangeState.rowsFrom,
            rowsTo: rangeState.rowsTo || null,
            colsTo: rangeState.colsTo || null,
            rangesUpdatedAt: rangeState.rangesUpdatedAt,
            departures: rangeState.departures
        };
        if (keepRoutes) {
            cache.enabledRoutes = keepEnabled;
            cache.routesUpdatedAt = keepAt;
            routesDirty = true;
        }
        if (keepHistory) {
            cache.historyFrom = keptRanges.historyFrom;
            cache.rowsFrom = keptRanges.rowsFrom;
            cache.rowsTo = keptRanges.rowsTo;
            cache.colsTo = keptRanges.colsTo;
            cache.rangesUpdatedAt = keptRanges.rangesUpdatedAt;
            cache.departures = mergeDepartureMaps(keptRanges.departures || {}, rangeState.departures);
            historyDirty = true;
        }
        if (syncWithLive(cache.departures) && canEdit()) historyDirty = true;
        loaded = true;
        const localMarks = (local && local.marks) || {};
        Object.keys(localMarks).forEach(key => {
            const item = localMarks[key];
            const remoteItem = remote && remote.marks && remote.marks[key];
            if (item && statusOk(item.status) && (!remoteItem || String(item.updatedAt || '') > String(remoteItem.updatedAt || ''))) {
                dirty.set(key, cache.marks[key]);
            }
        });
        renamed.forEach(key => {
            if (cache.marks[key]) dirty.set(key, cache.marks[key]);
        });
        if (!keepRoutes && routeState.dirty) routesDirty = true;
        if (!keepHistory && rangeState.dirty && canEdit()) historyDirty = true;
        if (dirty.size || routesDirty || historyDirty) schedulePersist();
        else updateSaveStatus();
        loadedAt = Date.now();
        builtFlights = null;
        return cache;
    }

    function olderThan(ms) {
        return !loadedAt || (Date.now() - loadedAt) >= ms;
    }

    function flightListKey() {
        const grouped = typeof groupedData !== 'undefined' ? groupedData : {};
        const keys = Object.keys(grouped);
        let rows = 0;
        let sig = '';
        keys.forEach(key => {
            const list = grouped[key] || [];
            rows += list.length;
            const first = list[0];
            const last = list[list.length - 1];
            if (first) sig += '|' + key + first[0] + first[1] + (first[4] || '');
            if (last && last !== first) sig += '>' + last[0] + last[1] + (last[4] || '');
        });
        return [
            rows,
            keys.length,
            rowsFromValue(),
            rowsToValue(),
            colsFromValue(),
            colsToValue(),
            columnTodayStr(),
            Object.keys(cache.departures || {}).length,
            sig
        ].join(':');
    }

    function getMark(flight, dep, check) {
        const key = markKey(flight, dep, check);
        return key ? (cache.marks[key] || null) : null;
    }

    // Все отметки вылета (по датам проверки): [{ check, status, author, updatedAt }], от ранних к поздним.
    function marksFor(flight, dep) {
        const fl = typeof cleanFlight === 'function' ? cleanFlight(flight) : String(flight || '');
        const d1 = typeof normalizeDate === 'function' ? normalizeDate(dep) : String(dep || '');
        const prefix = `${fl}|${d1}|`;
        const out = [];
        Object.keys(cache.marks || {}).forEach(key => {
            if (key.indexOf(prefix) !== 0) return;
            const m = cache.marks[key];
            if (m && STATUSES[m.status]) out.push({ check: key.slice(prefix.length), status: m.status, author: m.author || '', updatedAt: m.updatedAt || '' });
        });
        return out.sort((a, b) => (parseLocalDate(a.check) || 0) - (parseLocalDate(b.check) || 0));
    }

    // Дешёвый счётчик изменений отметок (для подписи кэша таблиц).
    let markRev = 0;
    function markRevision() {
        return markRev + ':' + Object.keys(cache.marks || {}).length;
    }

    function putMark(flight, dep, check, status, author) {
        if (!canEdit()) return false;
        if (typeof salesCheckIsToday !== 'function' || !salesCheckIsToday(check)) return false;
        const key = markKey(flight, dep, check);
        if (!key || !statusOk(status)) return false;
        const mark = {
            status,
            author: authorSignature(author),
            updatedAt: new Date().toISOString()
        };
        cache.marks[key] = mark;
        markRev++;
        dirty.set(key, mark);
        schedulePersist();
        return true;
    }

    function clearMark(flight, dep, check) {
        if (!canEdit()) return false;
        if (typeof salesCheckIsToday !== 'function' || !salesCheckIsToday(check)) return false;
        const key = markKey(flight, dep, check);
        if (!key) return false;
        delete cache.marks[key];
        markRev++;
        dirty.set(key, null);
        schedulePersist();
        return true;
    }

    function rememberDeparture(code, date, aircraft) {
        if (!cache.departures) cache.departures = {};
        const id = code + '|' + date;
        const craft = aircraft && aircraft !== '-' ? aircraft : '—';
        const prev = cache.departures[id];
        if (!prev) {
            cache.departures[id] = { code, date, aircraft: craft || '—' };
            return true;
        }
        if ((prev.aircraft === '—' || prev.aircraft === '-') && craft && craft !== '—') {
            prev.aircraft = craft;
            return true;
        }
        return false;
    }

    function raiseRangeEnd(field, dateStr) {
        const next = dateOnly(dateStr);
        if (!next) return false;
        const floor = field === 'rowsTo' ? rowsFromValue() : colsFromValue();
        const bounded = laterDate(next, floor);
        const cur = dateOnly(cache[field]);
        if (cur && typeof compareDateStr === 'function' && compareDateStr(bounded, cur) <= 0) return false;
        if (cur && typeof compareDateStr !== 'function' && bounded <= cur) return false;
        cache[field] = bounded;
        return true;
    }

    function collectFlights() {
        const key = flightListKey();
        if (builtFlights && builtFlightKey === key) return builtFlights;
        let changed = false;
        if (!dateOnly(cache.rowsFrom)) {
            cache.rowsFrom = DEFAULT_ROWS_FROM;
            changed = true;
        }
        if (!dateOnly(cache.historyFrom)) {
            cache.historyFrom = DEFAULT_COLS_FROM;
            changed = true;
        }
        const grouped = typeof groupedData !== 'undefined' ? groupedData : {};
        liveSchedule = readLiveSchedule(grouped);
        if (liveSchedule) {
            liveSchedule.items.forEach(item => {
                if (rememberDeparture(item.code, item.date, item.aircraft)) changed = true;
                if (raiseRangeEnd('rowsTo', item.date)) changed = true;
            });
            if (syncWithLive(cache.departures)) changed = true;
        }
        const from = rowsFromValue();
        const to = rowsToValue();
        const checks = columnCheckDates(colsFromValue(), columnTodayStr());
        const map = new Map();
        Object.keys(cache.departures || {}).forEach(id => {
            const item = cache.departures[id];
            if (!item || !item.code || !item.date) return;
            if (typeof compareDateStr === 'function') {
                if (compareDateStr(item.date, from) < 0) return;
                if (compareDateStr(item.date, to) > 0) return;
            }
            const table = baseCode(item.code);
            if (!table) return;
            if (!map.has(table)) map.set(table, []);
            map.get(table).push(item);
        });
        const today = startOfToday();
        const flights = [];
        map.forEach((items, table) => {
            const route = typeof getFlightDirection === 'function' ? getFlightDirection(table) : table;
            const departures = items.map(item => {
                const parsed = parseLocalDate(item.date);
                return {
                    date: item.date,
                    code: item.code,
                    weekday: (typeof DAYS_RU !== 'undefined' && parsed) ? DAYS_RU[parsed.getDay()] : '',
                    aircraft: item.aircraft || '—',
                    route,
                    flown: isFlownDate(item.date, today)
                };
            });
            departures.sort((a, b) => {
                const byDate = typeof compareDateStr === 'function' ? compareDateStr(a.date, b.date) : 0;
                if (byDate) return byDate;
                return (parseInt(a.code.slice(3), 10) || 0) - (parseInt(b.code.slice(3), 10) || 0);
            });
            flights.push({ code: table, route, departures, checks });
        });
        flights.sort((a, b) => (parseInt(a.code.slice(3), 10) || 0) - (parseInt(b.code.slice(3), 10) || 0));
        if (changed) {
            historyDirty = true;
            schedulePersist();
        }
        builtFlightKey = flightListKey();
        builtFlights = flights;
        return flights;
    }

    function listFlights(options) {
        const all = collectFlights();
        if (options && options.all) return all;
        if (!Array.isArray(cache.enabledRoutes)) return all;
        return all.filter(flight => cache.enabledRoutes.indexOf(flight.route) !== -1);
    }

    function routeChoices() {
        const names = [];
        const push = (name) => {
            const text = String(name || '').trim();
            if (text && names.indexOf(text) === -1) names.push(text);
        };
        const flights = collectFlights();
        if (flights.length) flights.forEach(flight => push(flight.route));
        else if (typeof window !== 'undefined' && window.FLIGHT_DIRECTIONS) {
            Object.keys(window.FLIGHT_DIRECTIONS).forEach(code => push(window.FLIGHT_DIRECTIONS[code]));
        }
        names.sort((a, b) => a.localeCompare(b, 'ru'));
        return names;
    }

    function getEnabledRoutes() {
        return Array.isArray(cache.enabledRoutes) ? cache.enabledRoutes.slice() : null;
    }

    function setEnabledRoutes(list) {
        if (typeof ProfileAuth !== 'undefined' && typeof ProfileAuth.getCurrentProfile === 'function') {
            const prof = ProfileAuth.getCurrentProfile();
            if (!prof || !prof.isAdmin) return false;
        }
        cache.enabledRoutes = list == null ? null : (normalizeRouteList(list) || []);
        cache.routesUpdatedAt = new Date().toISOString();
        routesDirty = true;
        try {
            let prev = null;
            try { prev = JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null'); } catch (e) { prev = null; }
            const next = (prev && typeof prev === 'object') ? prev : { version: 1, marks: {} };
            next.version = 1;
            next.enabledRoutes = Array.isArray(cache.enabledRoutes) ? cache.enabledRoutes.slice() : null;
            next.routesUpdatedAt = cache.routesUpdatedAt;
            if (loaded) {
                next.marks = cache.marks;
                next.updatedAt = cache.updatedAt || next.updatedAt || null;
                next.historyFrom = colsFromValue();
                next.rowsFrom = rowsFromValue();
                next.rowsTo = dateOnly(cache.rowsTo) || null;
                next.colsTo = dateOnly(cache.colsTo) || null;
                next.rangesUpdatedAt = cache.rangesUpdatedAt || null;
                next.departures = cache.departures || {};
            }
            localStorage.setItem(LOCAL_KEY, JSON.stringify(next));
        } catch (e) { /* ignore */ }
        schedulePersist();
        return true;
    }

    function hasPending() {
        return dirty.size > 0 || routesDirty || historyDirty || !!persistTimer || !!retryTimer;
    }

    function revision() {
        const marks = cache.marks || {};
        const keys = Object.keys(marks).sort();
        let body = '';
        keys.forEach(key => {
            const mark = marks[key];
            body += key + '\t' + (mark && mark.status || '') + '\t' + (mark && mark.author || '') + '\t' + (mark && mark.updatedAt || '') + '\n';
        });
        const routes = Array.isArray(cache.enabledRoutes) ? cache.enabledRoutes.join('\n') : '*';
        return [
            cache.updatedAt || '',
            rowsFromValue(),
            rowsToValue(),
            colsFromValue(),
            colsToValue(),
            cache.rangesUpdatedAt || '',
            Object.keys(cache.departures || {}).length,
            cache.routesUpdatedAt || '',
            routes,
            body
        ].join('\u0001');
    }

    return {
        STATUSES,
        load,
        flush,
        canEdit,
        canView,
        profileName,
        authorSignature,
        isFlownDate,
        checkDatesBetween,
        columnCheckDates,
        getMark,
        marksFor,
        markRevision,
        putMark,
        clearMark,
        listFlights,
        routeChoices,
        getEnabledRoutes,
        setEnabledRoutes,
        getRanges,
        setRanges,
        rangeDefaults: function () {
            return { rowsFrom: DEFAULT_ROWS_FROM, colsFrom: DEFAULT_COLS_FROM };
        },
        baseCode,
        operatingCode,
        hasPending,
        revision,
        olderThan,
        flightListKey
    };
})();

let salesFlightPick = '';
let salesSearchQuery = '';
let salesPopCloser = null;

function salesEsc(value) {
    return typeof escHtml === 'function' ? escHtml(value) : String(value ?? '');
}

function salesAttr(value) {
    return typeof escAttr === 'function' ? escAttr(value) : String(value ?? '');
}

function salesShortDate(dateStr) {
    const d = typeof parseLocalDate === 'function' ? parseLocalDate(dateStr) : null;
    if (!d) return dateStr;
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    if (d.getFullYear() !== new Date().getFullYear()) {
        return `${dd}.${mm}.${String(d.getFullYear()).slice(2)}`;
    }
    return `${dd}.${mm}`;
}

function salesCheckIsToday(check) {
    const today = typeof getTodayDate === 'function' ? getTodayDate() : '';
    const day = typeof normalizeDate === 'function' ? normalizeDate(check) : String(check || '');
    return !!today && day === today;
}

function salesCellText(mark) {
    if (!mark || !SalesManagement.STATUSES[mark.status]) return '';
    const status = SalesManagement.STATUSES[mark.status];
    if (status.sign) return mark.author ? (status.sign + ' ' + mark.author) : status.sign;
    return mark.author || status.short;
}

function salesMarkExportText(mark, colored) {
    if (!mark || !SalesManagement.STATUSES[mark.status]) return '';
    const status = SalesManagement.STATUSES[mark.status];
    if (status.sign) return salesCellText(mark);
    if (colored) return mark.author || status.short;
    return status.short + (mark.author ? ' — ' + mark.author : '');
}

function paintSalesCell(td, mark) {
    td.classList.remove('sm-st-keep', 'sm-st-attn', 'sm-st-down', 'sm-st-up');
    if (mark && SalesManagement.STATUSES[mark.status]) {
        td.classList.add('sm-st-' + mark.status);
        td.textContent = salesCellText(mark);
        td.title = SalesManagement.STATUSES[mark.status].label + (mark.author ? ' · ' + mark.author : '');
    } else {
        td.textContent = '';
        td.title = td.dataset.edit === '1' ? 'Не проверен — нажмите, чтобы отметить' : 'Не проверен';
    }
}

function closeSalesPopover() {
    const pop = document.getElementById('sm-pop');
    if (pop) pop.hidden = true;
    if (salesPopCloser) {
        document.removeEventListener('pointerdown', salesPopCloser, true);
        salesPopCloser = null;
    }
}

function placeSalesPopover(anchor) {
    const pop = document.getElementById('sm-pop');
    if (!pop || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const width = 280;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    let top = rect.bottom + 6;
    pop.hidden = false;
    const height = pop.offsetHeight || 220;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
}

function openSalesPopover(td) {
    if (!td || td.dataset.edit !== '1' || !SalesManagement.canEdit()) return;
    const pop = document.getElementById('sm-pop');
    if (!pop) return;
    closeSalesPopover();
    const flight = td.dataset.flight;
    const dep = td.dataset.dep;
    const check = td.dataset.check;
    const mark = SalesManagement.getMark(flight, dep, check);
    pop.dataset.flight = flight;
    pop.dataset.dep = dep;
    pop.dataset.check = check;
    const title = document.getElementById('sm-pop-title');
    if (title) title.textContent = `${flight} · вылет ${dep} · проверка ${check}`;
    pop.querySelectorAll('[data-status]').forEach(btn => {
        btn.classList.toggle('sm-status-on', !!(mark && btn.dataset.status === mark.status));
    });
    const input = document.getElementById('sm-pop-author');
    if (input) {
        input.value = SalesManagement.profileName();
        input.dataset.touched = '';
        setTimeout(() => input.focus(), 0);
    }
    const clearBtn = document.getElementById('sm-pop-clear');
    if (clearBtn) clearBtn.hidden = !mark;
    placeSalesPopover(td);
    setTimeout(() => {
        salesPopCloser = (event) => {
            if (pop.contains(event.target) || event.target === td) return;
            closeSalesPopover();
        };
        document.addEventListener('pointerdown', salesPopCloser, true);
    }, 0);
}

function currentPopoverStatus() {
    const on = document.querySelector('#sm-pop [data-status].sm-status-on');
    return on ? on.dataset.status : '';
}

function applySalesPopover(closeAfter) {
    const pop = document.getElementById('sm-pop');
    if (!pop || pop.hidden) return;
    const status = currentPopoverStatus();
    const authorInput = document.getElementById('sm-pop-author');
    const author = authorInput && authorInput.dataset.touched === '1'
        ? (authorInput.value || '')
        : (SalesManagement.profileName() || '');
    const flight = pop.dataset.flight;
    const dep = pop.dataset.dep;
    const check = pop.dataset.check;
    if (!salesCheckIsToday(check)) {
        if (typeof showToast === 'function') showToast('Менять можно только в сегодняшнем столбце', 'error');
        return;
    }
    if (!status) {
        if (closeAfter && typeof showToast === 'function') showToast('Выберите, что сделано', 'error');
        return;
    }
    if (!SalesManagement.putMark(flight, dep, check, status, author)) {
        if (typeof showToast === 'function') showToast('Нет права менять эту таблицу', 'error');
        return;
    }
    const td = document.querySelector(`.sm-cell[data-flight="${salesQueryEscape(flight)}"][data-dep="${salesQueryEscape(dep)}"][data-check="${salesQueryEscape(check)}"]`);
    if (td) paintSalesCell(td, SalesManagement.getMark(flight, dep, check));
    const clearBtn = document.getElementById('sm-pop-clear');
    if (clearBtn) clearBtn.hidden = false;
    if (closeAfter) closeSalesPopover();
}

function ensureSalesPopover() {
    if (document.getElementById('sm-pop')) return;
    const pop = document.createElement('div');
    pop.id = 'sm-pop';
    pop.className = 'sm-pop';
    pop.hidden = true;
    pop.innerHTML = `
        <div class="sm-pop-title" id="sm-pop-title"></div>
        <div class="sm-pop-statuses">
            <button type="button" class="sm-status-btn sm-st-keep" data-status="keep">Проверено без изменений</button>
            <button type="button" class="sm-status-btn sm-st-attn" data-status="attn">! Обратить внимание</button>
            <button type="button" class="sm-status-btn sm-st-down" data-status="down">Снижение</button>
            <button type="button" class="sm-status-btn sm-st-up" data-status="up">Повышение</button>
        </div>
        <label class="sm-pop-author-label">Подпись
            <input id="sm-pop-author" class="sm-pop-author" maxlength="80" autocomplete="name">
        </label>
        <div class="sm-pop-actions">
            <button type="button" id="sm-pop-clear" class="filter-btn">Очистить</button>
            <button type="button" id="sm-pop-done" class="filter-btn sm-pop-done">Готово</button>
        </div>
    `;
    document.body.appendChild(pop);
    pop.addEventListener('click', (event) => {
        const statusBtn = event.target.closest('[data-status]');
        if (statusBtn) {
            pop.querySelectorAll('[data-status]').forEach(btn => btn.classList.toggle('sm-status-on', btn === statusBtn));
            applySalesPopover(true);
            return;
        }
        if (event.target.id === 'sm-pop-clear') {
            const flight = pop.dataset.flight;
            const dep = pop.dataset.dep;
            const check = pop.dataset.check;
            if (!salesCheckIsToday(check)) {
                if (typeof showToast === 'function') showToast('Менять можно только в сегодняшнем столбце', 'error');
                return;
            }
            SalesManagement.clearMark(flight, dep, check);
            const td = document.querySelector(`.sm-cell[data-flight="${salesQueryEscape(flight)}"][data-dep="${salesQueryEscape(dep)}"][data-check="${salesQueryEscape(check)}"]`);
            if (td) paintSalesCell(td, null);
            closeSalesPopover();
            return;
        }
        if (event.target.id === 'sm-pop-done') applySalesPopover(true);
    });
    pop.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            event.stopPropagation();
            closeSalesPopover();
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            applySalesPopover(true);
        }
    });
    document.getElementById('sm-pop-author')?.addEventListener('input', (event) => {
        event.target.dataset.touched = '1';
        if (currentPopoverStatus()) applySalesPopover(false);
    });
}

function salesFlightMatches(flight, query) {
    if (!query) return true;
    const numbers = (flight.departures || []).map(dep => dep.code).join(' ');
    const hay = `${flight.code} ${numbers} ${flight.route}`.toLowerCase();
    return hay.includes(query.toLowerCase());
}

function salesQueryEscape(value) {
    const text = String(value ?? '');
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(text);
    return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function ensureSalesPick(all) {
    if (all.some(flight => flight.code === salesFlightPick)) return;
    const want = typeof SalesManagement.baseCode === 'function' ? SalesManagement.baseCode(salesFlightPick) : salesFlightPick;
    if (want && all.some(flight => flight.code === want)) {
        salesFlightPick = want;
        return;
    }
    const cur = typeof currentFlight !== 'undefined' ? currentFlight : '';
    const byBase = cur && all.find(flight => {
        const base = typeof getBaseFlight === 'function' ? getBaseFlight(flight.code) : flight.code;
        return flight.code === cur || base === cur;
    });
    salesFlightPick = byBase ? byBase.code : (all[0] ? all[0].code : '');
}

function renderSalesFlightList() {
    const host = document.getElementById('sm-flight-list');
    if (!host) return;
    const universe = SalesManagement.listFlights({ all: true });
    const all = SalesManagement.listFlights();
    ensureSalesPick(all);
    const flights = all.filter(flight => salesFlightMatches(flight, salesSearchQuery.trim()));
    if (!flights.length) {
        const emptyText = salesSearchQuery.trim()
            ? 'Нет такого рейса'
            : (universe.length
                ? 'Нет маршрутов в управлении продажами. Администратор отмечает их в настройках.'
                : 'Нет рейсов. Сначала загрузите файлы загрузки — увиденные даты потом останутся.');
        host.innerHTML = `<div class="sm-list-empty">${emptyText}</div>`;
        return;
    }
    host.innerHTML = flights.map(flight => {
        const extras = [];
        (flight.departures || []).forEach(dep => {
            if (dep.code && dep.code !== flight.code && extras.indexOf(dep.code) === -1) extras.push(dep.code);
        });
        const extraText = extras.length ? ` · доп ${extras.join(', ')}` : '';
        return `
        <button type="button" class="sm-flight ${flight.code === salesFlightPick ? 'sm-flight-on' : ''}" data-code="${salesAttr(flight.code)}">
            <strong>${salesEsc(flight.code)}</strong>
            <span>${salesEsc(flight.route)}</span>
            <small>${flight.departures.length} дат${salesEsc(extraText)}</small>
        </button>`;
    }).join('');
}

function renderSalesGrid() {
    const host = document.getElementById('sm-grid');
    if (!host) return;
    closeSalesPopover();
    const scrollLeft = host.scrollLeft;
    const scrollTop = host.scrollTop;
    const universe = SalesManagement.listFlights({ all: true });
    const all = SalesManagement.listFlights();
    const flight = all.find(item => item.code === salesFlightPick) || null;
    const mode = document.getElementById('sm-mode');
    if (mode) {
        mode.textContent = SalesManagement.canEdit()
            ? 'Правится только сегодняшний столбец'
            : 'Только просмотр и выгрузка';
    }
    if (!universe.length) {
        host.innerHTML = `<div class="table-empty-state"><div class="table-empty-title">Нет рейсов за выбранный период</div><div class="table-empty-hint">Новые вылеты берутся из загрузки и остаются в таблице. Начало периода меняет администратор в настройках.</div></div>`;
        return;
    }
    if (!all.length) {
        host.innerHTML = `<div class="table-empty-state"><div class="table-empty-title">Маршруты не выбраны</div><div class="table-empty-hint">Администратор отмечает нужные маршруты в настройках. Пока список пуст, в Excel тоже нечего выгружать.</div></div>`;
        return;
    }
    if (!flight) {
        host.innerHTML = `<div class="table-empty-state"><div class="table-empty-title">Выберите рейс слева</div></div>`;
        return;
    }
    const today = typeof getTodayDate === 'function' ? getTodayDate() : '';
    const headDates = flight.checks.map(date => {
        const parsed = typeof parseLocalDate === 'function' ? parseLocalDate(date) : null;
        const dow = (typeof DAYS_RU !== 'undefined' && parsed) ? DAYS_RU[parsed.getDay()] : '';
        const isToday = !!today && date === today;
        const tag = isToday ? '<span class="sm-check-tag">сегодня</span>' : '';
        return `<th class="sm-check-head${isToday ? ' sm-check-today' : ''}" data-check="${salesAttr(date)}" title="${salesAttr(date)}"><span class="sm-check-date">${salesEsc(salesShortDate(date))}</span><span class="sm-check-dow">${salesEsc(dow)}</span>${tag}</th>`;
    }).join('');
    const editable = SalesManagement.canEdit();
    const body = flight.departures.map(dep => {
        const cells = flight.checks.map(check => {
            const mark = SalesManagement.getMark(dep.code, dep.date, check);
            const canCell = editable && !dep.flown && salesCheckIsToday(check);
            const cls = mark ? ` sm-st-${mark.status}` : '';
            const text = salesCellText(mark);
            const title = mark
                ? `${SalesManagement.STATUSES[mark.status].label}${mark.author ? ' · ' + mark.author : ''}`
                : (canCell ? 'Не проверен — нажмите, чтобы отметить' : (dep.flown ? 'Рейс уже выполнен' : 'Отметить можно только сегодня'));
            return `<td class="sm-cell${cls}" data-edit="${canCell ? '1' : '0'}" data-flight="${salesAttr(dep.code)}" data-dep="${salesAttr(dep.date)}" data-check="${salesAttr(check)}" title="${salesAttr(title)}">${salesEsc(text)}</td>`;
        }).join('');
        const rowClass = dep.flown ? 'sm-row-flew' : (salesNearDeparture(dep.date, today) ? 'sm-row-near' : '');
        return `<tr class="${rowClass}">
            <td class="sm-freeze sm-c0">${salesEsc(dep.date)}</td>
            <td class="sm-freeze sm-c1">${salesEsc(dep.code)}</td>
            <td class="sm-freeze sm-c2">${salesEsc(dep.weekday)}</td>
            <td class="sm-freeze sm-c3">${salesEsc(dep.aircraft)}</td>
            <td class="sm-freeze sm-c4">${salesEsc(dep.route)}</td>
            ${cells}
        </tr>`;
    }).join('');
    const emptyCols = flight.checks.length
        ? ''
        : '<p class="sm-grid-note">Дат заполнения нет: начало столбцов позже сегодняшнего дня.</p>';
    host.innerHTML = `
        ${emptyCols}
        <table class="sm-table">
            <thead>
                <tr>
                    <th class="sm-freeze sm-c0">Дата</th>
                    <th class="sm-freeze sm-c1">Номер рейса</th>
                    <th class="sm-freeze sm-c2">День недели</th>
                    <th class="sm-freeze sm-c3">Тип ВС</th>
                    <th class="sm-freeze sm-c4">Наименование маршрута</th>
                    ${headDates}
                </tr>
            </thead>
            <tbody>${body}</tbody>
        </table>
    `;
    if (salesSnapToToday) {
        salesSnapToToday = false;
        salesScrollToTodaySoon(host);
    } else {
        host.scrollLeft = scrollLeft;
        host.scrollTop = scrollTop;
    }
    salesViewStamp = currentSalesViewStamp();
}

let salesSnapToToday = false;

function salesFrozenWidth(host) {
    let width = 0;
    host.querySelectorAll('thead .sm-freeze').forEach(cell => {
        width += cell.getBoundingClientRect().width;
    });
    return width;
}

function salesPickCheckHead(host, today) {
    const heads = host.querySelectorAll('th.sm-check-head');
    if (!heads.length) return null;
    let exact = null;
    let before = null;
    let after = null;
    heads.forEach(th => {
        const date = th.getAttribute('data-check') || '';
        if (!date) return;
        if (today && date === today) {
            exact = th;
            return;
        }
        if (!today || typeof compareDateStr !== 'function') return;
        const cmp = compareDateStr(date, today);
        if (cmp < 0) before = th;
        else if (cmp > 0 && !after) after = th;
    });
    const head = exact || before || after || heads[0];
    return { head, exact: !!exact };
}

function scrollSalesGridToDate(host) {
    if (!host) return null;
    const today = typeof getTodayDate === 'function' ? getTodayDate() : '';
    const picked = salesPickCheckHead(host, today);
    if (!picked) return null;
    const zoom = parseFloat(host.style.zoom) || 1;
    const frozen = salesFrozenWidth(host);
    const delta = (picked.head.getBoundingClientRect().left - host.getBoundingClientRect().left - frozen) / zoom;
    host.scrollLeft = Math.max(0, host.scrollLeft + delta);
    return { exact: picked.exact };
}

function salesScrollToTodaySoon(host) {
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            if (!host || !host.isConnected) return;
            scrollSalesGridToDate(host);
        });
    });
}

let salesViewStamp = '';

function currentSalesViewStamp() {
    if (typeof SalesManagement === 'undefined' || typeof SalesManagement.revision !== 'function') return '';
    const flights = typeof SalesManagement.flightListKey === 'function' ? SalesManagement.flightListKey() : '';
    return [
        salesFlightPick,
        salesSearchQuery,
        SalesManagement.revision(),
        flights,
        SalesManagement.canEdit && SalesManagement.canEdit() ? '1' : '0'
    ].join('|');
}

function refreshSalesManagement(force, snapToday) {
    if (!document.getElementById('sm-page')) return;
    if (snapToday === true) salesSnapToToday = true;
    const pull = force === true || (typeof SalesManagement.olderThan === 'function' && SalesManagement.olderThan(2 * 60 * 1000));
    const paint = () => {
        if (typeof currentTab !== 'undefined' && currentTab !== 'sales') return;
        const stamp = currentSalesViewStamp();
        const grid = document.getElementById('sm-grid');
        if (!force && stamp && stamp === salesViewStamp && grid && grid.childElementCount) {
            if (salesSnapToToday) {
                salesSnapToToday = false;
                salesScrollToTodaySoon(grid);
            }
            return;
        }
        renderSalesFlightList();
        renderSalesGrid();
    };
    SalesManagement.load(pull).then(paint).catch(paint);
}

const SALES_SYNC_MS = 30 * 60 * 1000;
let salesSyncTimer = null;

function salesSharedSyncMs() {
    return SALES_SYNC_MS;
}

function salesPopoverOpen() {
    const pop = document.getElementById('sm-pop');
    return !!(pop && !pop.hidden);
}

function pullSharedSales() {
    if (typeof SalesManagement === 'undefined' || typeof SalesManagement.load !== 'function') return;
    if (typeof SalesManagement.canView === 'function' && !SalesManagement.canView()) return;
    if (salesPopoverOpen()) return;
    if (typeof SalesManagement.hasPending === 'function' && SalesManagement.hasPending()) return;
    const page = document.getElementById('sm-page');
    const showing = !!page && (typeof currentTab === 'undefined' || currentTab === 'sales');
    const before = typeof SalesManagement.revision === 'function' ? SalesManagement.revision() : '';
    const job = SalesManagement.load(true);
    if (!showing) return;
    job.then(() => {
        if (typeof currentTab !== 'undefined' && currentTab !== 'sales') return;
        if (salesPopoverOpen()) return;
        if (typeof SalesManagement.hasPending === 'function' && SalesManagement.hasPending()) return;
        const after = typeof SalesManagement.revision === 'function' ? SalesManagement.revision() : '';
        const stamp = currentSalesViewStamp();
        if (before && after === before && stamp === salesViewStamp) return;
        renderSalesFlightList();
        renderSalesGrid();
    }).catch(() => {});
}

function startSalesSharedSync() {
    if (salesSyncTimer) return;
    salesSyncTimer = setInterval(pullSharedSales, SALES_SYNC_MS);
}

startSalesSharedSync();

function createSalesManagementView(panel) {
    panel.innerHTML = `
        <div class="sm-page table-page" id="sm-page">
            <div class="table-page-hero">
                <div class="table-page-hero-main">
                    <h2 class="rms-hero-title">Управление продажами</h2>
                </div>
            </div>
            <div class="table-page-body">
                <div class="table-controls-wrap">
                    <div class="table-controls-bar sm-controls">
                        <input id="sm-search" class="sm-search" type="search" placeholder="Рейс или маршрут" aria-label="Найти рейс">
                        <span id="sm-mode" class="sm-mode"></span>
                        <span id="sm-save-status" class="sm-save-status"></span>
                        <span class="table-controls-spacer"></span>
                        <button type="button" id="sm-today" class="filter-btn filter-btn-active">Сегодня</button>
                        <button type="button" id="sm-reload" class="filter-btn">Обновить</button>
                        <button type="button" id="sm-export" class="filter-btn">В Excel</button>
                    </div>
                    <div class="sm-legend" aria-hidden="true">
                        <span class="sm-legend-item sm-st-keep">Проверено без изменений</span>
                        <span class="sm-legend-item sm-st-attn">! Обратить внимание</span>
                        <span class="sm-legend-item sm-st-down">Снижение</span>
                        <span class="sm-legend-item sm-st-up">Повышение</span>
                        <span class="sm-legend-item sm-legend-gray">Улетел</span>
                        <span class="sm-legend-item sm-legend-empty">Не проверен</span>
                    </div>
                </div>
                <div class="sm-layout">
                    <div id="sm-flight-list" class="sm-list" role="listbox" aria-label="Рейсы"></div>
                    <div id="sm-grid" class="table-wrapper sm-grid" data-zoom-target="sales"></div>
                </div>
            </div>
        </div>
    `;
    ensureSalesPopover();
    const search = document.getElementById('sm-search');
    let salesSearchTimer = null;
    search?.addEventListener('input', () => {
        salesSearchQuery = search.value || '';
        clearTimeout(salesSearchTimer);
        salesSearchTimer = setTimeout(() => renderSalesFlightList(), 120);
    });
    document.getElementById('sm-flight-list')?.addEventListener('click', (event) => {
        const btn = event.target.closest('[data-code]');
        if (!btn) return;
        salesFlightPick = btn.dataset.code || '';
        renderSalesFlightList();
        salesSnapToToday = true;
        renderSalesGrid();
    });
    document.getElementById('sm-grid')?.addEventListener('click', (event) => {
        const td = event.target.closest('.sm-cell');
        if (!td) return;
        openSalesPopover(td);
    });
    document.getElementById('sm-grid')?.addEventListener('scroll', () => closeSalesPopover(), { passive: true });
    document.getElementById('sm-today')?.addEventListener('click', () => {
        const host = document.getElementById('sm-grid');
        const result = scrollSalesGridToDate(host);
        if (!result) {
            if (typeof showToast === 'function') showToast('В таблице нет столбцов с датами', 'error');
            return;
        }
        if (!result.exact && typeof showToast === 'function') {
            showToast('Сегодняшней даты в столбцах нет — показана ближайшая');
        }
    });
    document.getElementById('sm-reload')?.addEventListener('click', () => refreshSalesManagement(true));
    document.getElementById('sm-export')?.addEventListener('click', () => exportSalesManagementExcel());
    if (typeof applyViewZoom === 'function') applyViewZoom('sales');
    const cur = typeof currentFlight !== 'undefined' ? currentFlight : '';
    if (!salesFlightPick && cur) salesFlightPick = cur;
    refreshSalesManagement(true, true);
}

function salesSheetName(code, used) {
    let name = String(code || 'Рейс').replace(/[:\\/?*[\]]/g, ' ').trim() || 'Рейс';
    if (name.length > 31) name = name.slice(0, 31);
    let next = name;
    let i = 2;
    while (used.has(next)) {
        const suffix = ' ' + (i++);
        next = name.slice(0, Math.max(1, 31 - suffix.length)) + suffix;
    }
    used.add(next);
    return next;
}

function salesStyle(fill, color, bold, horizontal, wrap, border) {
    const style = {
        fill: { patternType: 'solid', fgColor: { rgb: fill } },
        font: { name: 'Calibri', sz: 11, bold: !!bold, color: { rgb: color || '1C2833' } },
        alignment: { horizontal: horizontal || 'center', vertical: 'center', wrapText: !!wrap }
    };
    if (border) {
        const edge = { style: 'thin', color: { rgb: '5D6D7E' } };
        const seam = { style: 'thin', color: { rgb: fill || 'FFFFFF' } };
        const hide = border === true ? {} : border;
        style.border = {
            top: edge,
            bottom: edge,
            left: hide.left === false ? seam : edge,
            right: hide.right === false ? seam : edge
        };
    }
    return style;
}

function salesThemeFill(kind) {
    const themed = { keep: 'smKeep', attn: 'smAttn', down: 'smDown', up: 'smUp', gray: 'smFlew', head: 'smHead', sub: 'smHead' };
    const base = SALES_FILLS[kind] || ['FFFFFF', '1C2833'];
    const key = themed[kind];
    if (!key || typeof ThemeSettings === 'undefined' || typeof ThemeSettings.load !== 'function') return base;
    try {
        const raw = String(ThemeSettings.load()[key] || '').replace('#', '').trim();
        if (!/^[0-9A-Fa-f]{6}$/.test(raw)) return base;
        const hex = raw.toUpperCase();
        const ink = typeof excelInk === 'function' ? excelInk(hex) : base[1];
        return [hex, ink];
    } catch (e) {
        return base;
    }
}

function salesCellStyle(kind, col, row) {
    const swatch = kind.indexOf('swatch-') === 0 ? kind.slice(7) : '';
    const legend = kind === 'legend';
    const palette = salesThemeFill(swatch || (legend ? 'title' : kind));
    const horizontal = kind === 'title' ? 'center' : (legend ? 'left' : (col === 4 ? 'left' : 'center'));
    const bold = !legend && !swatch && (kind === 'head' || kind === 'sub' || kind === 'title');
    return salesStyle(palette[0], palette[1], bold, horizontal, false, true);
}

function salesLegendModel() {
    const items = [
        ['gray', 'Улетел', ''],
        ['empty', 'Не проверен', ''],
        ['keep', 'Проверено без изменений', ''],
        ['attn', 'Обратить внимание', '!'],
        ['down', 'Снижение', ''],
        ['up', 'Повышение', '']
    ];
    const rows = items.map(([status, label, sign]) => ({
        cells: [sign, label],
        kinds: ['swatch-' + status, 'legend']
    }));
    return { rows, count: rows.length };
}

function salesSheetFreeze(legendCount) {
    const ySplit = legendCount + 3;
    return { xSplit: 5, ySplit, topLeft: 'F' + (ySplit + 1) };
}

const SALES_FILLS = {
    keep: ['F7DC6F', '3D3206'],
    attn: ['F5B7B1', '7B241C'],
    down: ['8E1B2F', 'FFFFFF'],
    up: ['7DCEA0', '145A32'],
    gray: ['D5D8DC', '2C3E50'],
    near: ['F0F4F8', '1C2833'],
    head: ['012A4A', 'FFFFFF'],
    sub: ['1A5276', 'FFFFFF'],
    title: ['FFFFFF', '012A4A']
};

function salesNearDeparture(dateStr, todayStr) {
    const today = todayStr || (typeof getTodayDate === 'function' ? getTodayDate() : '');
    if (!dateStr || !today || typeof compareDateStr !== 'function') return false;
    if (compareDateStr(dateStr, today) < 0) return false;
    if (typeof parseLocalDate !== 'function' || typeof formatDateRu !== 'function') return false;
    const start = parseLocalDate(today);
    if (!start) return false;
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 14);
    return compareDateStr(dateStr, formatDateRu(end)) <= 0;
}

function salesExportStamp() {
    const now = new Date();
    const date = typeof formatDateRu === 'function' ? formatDateRu(now) : '';
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    return `${date} ${hh}:${mm}`;
}

const SALES_HOME_SHEET = 'Главная';

function salesSheetTarget(name) {
    const safe = String(name || SALES_HOME_SHEET).replace(/'/g, "''");
    return "#'" + safe + "'!A1";
}

function salesLinkStyle(horizontal) {
    const style = salesStyle('FFFFFF', '0563C1', false, horizontal || 'left', false, true);
    style.font.underline = true;
    return style;
}

function salesSetLink(cell, sheetName, tooltip) {
    if (!cell) return cell;
    cell.l = {
        Target: salesSheetTarget(sheetName),
        Tooltip: tooltip || String(sheetName || SALES_HOME_SHEET)
    };
    return cell;
}

function salesAttachHomeLink(lib, ws, colored) {
    const cell = ws.C1 || { t: 's', v: '' };
    cell.t = 's';
    cell.v = '← Главная';
    salesSetLink(cell, SALES_HOME_SHEET, 'На главную');
    if (colored) cell.s = salesLinkStyle('left');
    ws.C1 = cell;
}

function buildSalesIndexSheet(lib, entries, stamp, colored) {
    const aoa = [
        ['Управление продажами — ' + stamp, ''],
        ['Номер рейса', 'Наименование маршрута']
    ];
    (entries || []).forEach(entry => aoa.push([entry.code || '', entry.route || '']));
    const safeRows = aoa.map(row => (typeof excelSafeRow === 'function' ? excelSafeRow(row) : row));
    const ws = lib.utils.aoa_to_sheet(safeRows);
    ws['!cols'] = [{ wch: 22 }, { wch: 46 }];
    ws['!rows'] = [{ hpt: 22 }, { hpt: 22 }].concat((entries || []).map(() => ({ hpt: 18 })));
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }];
    ws['!views'] = [{
        state: 'frozen',
        ySplit: 2,
        topLeftCell: 'A3',
        activePane: 'bottomLeft'
    }];
    if (colored && ws['!ref']) {
        const range = lib.utils.decode_range(ws['!ref']);
        for (let r = 0; r <= range.e.r; r++) {
            for (let c = 0; c <= 1; c++) {
                const addr = lib.utils.encode_cell({ r, c });
                const cell = ws[addr] || { t: 's', v: '' };
                if (r === 0) {
                    const border = c === 0 ? { right: false } : { left: false };
                    cell.s = salesStyle('FFFFFF', '012A4A', true, 'center', false, border);
                } else if (r === 1) {
                    cell.s = salesCellStyle('head', 0, r);
                } else if (c === 0) {
                    cell.s = salesLinkStyle('center');
                } else {
                    cell.s = salesStyle('FFFFFF', '1C2833', false, 'left', false, true);
                }
                ws[addr] = cell;
            }
        }
    }
    (entries || []).forEach((entry, i) => {
        const addr = lib.utils.encode_cell({ r: i + 2, c: 0 });
        const cell = ws[addr];
        if (!cell) return;
        salesSetLink(cell, entry.sheet, entry.code || entry.sheet);
    });
    return ws;
}

function salesFlightWorksheet(lib, flight, stamp, colored) {
    const header = ['Дата', 'Номер рейса', 'День недели', 'Тип ВС', 'Наименование маршрута']
        .concat(flight.checks);
    const dowRow = ['', '', '', '', ''].concat(flight.checks.map(date => {
        const d = parseLocalDate(date);
        return (d && typeof DAYS_RU !== 'undefined') ? DAYS_RU[d.getDay()] : '';
    }));
    const legend = salesLegendModel();
    const aoa = legend.rows.map(row => row.cells.slice());
    const kinds = legend.rows.map(row => row.kinds.slice());
    aoa.push([`Дата выгрузки: ${stamp}`, '', '', '', '']);
    kinds.push(['title', 'title', 'title', 'title', 'title']);
    aoa.push(header);
    kinds.push(header.map(() => 'head'));
    aoa.push(dowRow);
    kinds.push(header.map(() => 'head'));
    flight.departures.forEach(dep => {
        const row = [dep.date, dep.code, dep.weekday, dep.aircraft, dep.route];
        const near = !dep.flown && salesNearDeparture(dep.date);
        const baseKind = dep.flown ? 'gray' : (near ? 'near' : 'id');
        const kind = [baseKind, baseKind, baseKind, baseKind, baseKind];
        flight.checks.forEach(check => {
            const mark = SalesManagement.getMark(dep.code, dep.date, check);
            if (!mark) {
                row.push('');
                kind.push(dep.flown ? 'gray' : (near ? 'near' : 'empty'));
                return;
            }
            const text = salesMarkExportText(mark, colored);
            row.push(text);
            kind.push(mark.status);
        });
        aoa.push(row);
        kinds.push(kind);
    });
    const safeRows = aoa.map(row => (typeof excelSafeRow === 'function' ? excelSafeRow(row) : row));
    const ws = lib.utils.aoa_to_sheet(safeRows);
    const tableCols = header.length;
    const stampRow = legend.count;
    const freeze = salesSheetFreeze(legend.count);
    const cols = [
        { wch: 14 }, { wch: 22 }, { wch: 14 }, { wch: 12 }, { wch: 38 }
    ].concat(flight.checks.map(() => ({ wch: 18 })));
    ws['!cols'] = cols;
    ws['!rows'] = legend.rows.map(() => ({ hpt: 18 })).concat([{ hpt: 20 }, { hpt: 22 }, { hpt: 18 }]);
    ws['!merges'] = [{ s: { r: stampRow, c: 0 }, e: { r: stampRow, c: 4 } }];
    ws['!views'] = [{
        state: 'frozen',
        xSplit: freeze.xSplit,
        ySplit: freeze.ySplit,
        topLeftCell: freeze.topLeft,
        activePane: 'bottomRight'
    }];
    if (colored && ws['!ref']) {
        const range = lib.utils.decode_range(ws['!ref']);
        for (let r = range.s.r; r <= range.e.r; r++) {
            const kindRow = kinds[r] || [];
            const lastCol = r < legend.count ? 1 : (r === stampRow ? 4 : tableCols - 1);
            for (let c = 0; c <= Math.max(range.e.c, lastCol); c++) {
                if (c > lastCol) continue;
                const addr = lib.utils.encode_cell({ r, c });
                const cell = ws[addr] || { t: 's', v: '' };
                const kind = kindRow[c] || (r === stampRow ? 'title' : 'empty');
                if (r === stampRow) {
                    const border = c === 0 ? { right: false } : (c === 4 ? { left: false } : { left: false, right: false });
                    cell.s = salesStyle('FFFFFF', '012A4A', true, 'center', false, border);
                } else {
                    cell.s = salesCellStyle(kind, c, r);
                    if (cell.v === '!') cell.s.font.bold = true;
                }
                ws[addr] = cell;
            }
        }
    }
    salesAttachHomeLink(lib, ws, colored);
    return ws;
}

function buildSalesWorkbook(lib, flights, stamp, colored) {
    const used = new Set([SALES_HOME_SHEET]);
    const named = (flights || []).map(flight => ({
        flight,
        sheet: salesSheetName(flight.code, used)
    }));
    const wb = lib.utils.book_new();
    const index = buildSalesIndexSheet(lib, named.map(item => ({
        code: item.flight.code,
        route: item.flight.route || '',
        sheet: item.sheet
    })), stamp, !!colored);
    lib.utils.book_append_sheet(wb, index, SALES_HOME_SHEET);
    named.forEach(item => {
        lib.utils.book_append_sheet(wb, salesFlightWorksheet(lib, item.flight, stamp, colored), item.sheet);
    });
    return wb;
}

async function exportSalesManagementExcel() {
    if (!SalesManagement.canView()) {
        if (typeof showToast === 'function') showToast('Вкладка недоступна для вашего профиля', 'error');
        return;
    }
    if (typeof XLSX === 'undefined') {
        if (typeof showToast === 'function') showToast('Библиотека Excel не загружена', 'error');
        return;
    }
    const folder = typeof excelPrepareFolder === 'function' ? await excelPrepareFolder('sales') : null;
    await SalesManagement.flush();
    const flights = SalesManagement.listFlights();
    if (!flights.length) {
        if (typeof showToast === 'function') showToast('Нет рейсов для выгрузки', 'error');
        return;
    }
    if (typeof showToast === 'function') showToast('Готовлю Excel…');
    const styled = await loadStyledXlsx();
    const lib = styled || XLSX;
    const colored = !!styled;
    const stamp = salesExportStamp();
    const wb = buildSalesWorkbook(lib, flights, stamp, colored);
    const filename = typeof excelDailyFilename === 'function'
        ? excelDailyFilename('КРАСАВИА_управление_продажами', stamp)
        : `КРАСАВИА_управление_продажами_${stamp.slice(0, 10).replace(/\./g, '-')}.xlsx`;
    try {
        const saved = typeof excelSaveWorkbook === 'function'
            ? await excelSaveWorkbook(lib, wb, filename, folder)
            : (lib.writeFile(wb, filename), { where: 'download' });
        if (typeof ActivityLog !== 'undefined') ActivityLog.log('export', 'Управление продажами');
        if (typeof excelAnnounceSaved === 'function') {
            excelAnnounceSaved(saved, `Файл готов: ${flights.length} рейсов, дата выгрузки ${stamp}`);
        } else if (typeof showToast === 'function') {
            showToast(`Файл готов: ${flights.length} рейсов, дата выгрузки ${stamp}`);
        }
    } catch (e) {
        console.error(e);
        if (typeof showToast === 'function') showToast('Ошибка выгрузки', 'error');
    }
}
