// Вкладка «Творческая»: конструктор своей таблицы из данных остальных вкладок.
// Строка — один вылет (рейс + дата + участок) или группа вылетов, если выбрана группировка.
// Столбцы берутся из тех же расчётов, что и на вкладках-источниках; группа столбцов видна,
// только если у профиля есть доступ хотя бы к одной из её вкладок.
// Настройка хранится по профилю в браузере; шаблон можно сделать общим (shared/creative-layouts.json).
window.CreativeView = (function () {
    const STORE_PREFIX = 'krasavia_creative_v1_';
    const SHARED_FILE = 'creative-layouts.json';
    const MONTHS_RU = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
    const ALERT_LABELS = { 3: 'Критично', 2: 'Внимание', 1: 'Инфо' };

    const GROUPS = [
        { id: 'flight', label: 'Рейс', perms: null },
        { id: 'load', label: 'Загрузка рейсов', perms: ['tab_data', 'tab_table', 'tab_pair', 'tab_rms'] },
        { id: 'sales', label: 'Продажи', perms: ['tab_table', 'tab_pair'] },
        { id: 'rms', label: 'RMS и прогноз', perms: ['tab_rms', 'tab_main'] },
        { id: 'econ', label: 'Экономическая таблица', perms: ['tab_pair', 'tab_costs'] },
        { id: 'pkz', label: 'ПКЗ', perms: ['tab_pkz', 'tab_table'] },
        { id: 'mgmt', label: 'Управление продажами', perms: ['tab_sales'] }
    ];

    const PERIODS = [
        { id: 'today', label: 'Сегодня' },
        { id: 'next7', label: '7 дней' },
        { id: 'next30', label: '30 дней' },
        { id: 'next90', label: '90 дней' },
        { id: 'past30', label: 'Прошедшие 30' },
        { id: 'all', label: 'Всё' }
    ];

    const OPS = [
        { id: 'gt', label: '>' },
        { id: 'ge', label: '≥' },
        { id: 'lt', label: '<' },
        { id: 'le', label: '≤' },
        { id: 'eq', label: '=' },
        { id: 'ne', label: '≠' },
        { id: 'has', label: 'содержит' },
        { id: 'empty', label: 'пусто' },
        { id: 'filled', label: 'не пусто' }
    ];

    // ---------- контекст строки: расчёты из других вкладок, лениво ----------

    function lazy(c, key, fn) {
        if (!Object.prototype.hasOwnProperty.call(c.memo, key)) c.memo[key] = fn();
        return c.memo[key];
    }

    function metricsOf(c) {
        return lazy(c, 'm', () => (typeof getRowMetrics === 'function' ? getRowMetrics(c.row, c.base) : null));
    }

    function salesReady() {
        return typeof hasSalesFileLoaded === 'function' ? hasSalesFileLoaded() : false;
    }

    // На многосегментном рейсе продажи висят только на первом участке — как в «Экономической таблице».
    function salesBucket(c) {
        return lazy(c, 'sb', () => {
            if (!salesReady() || !c.attach || typeof getSalesMapForRow !== 'function') return null;
            return getSalesMapForRow(c.row) || null;
        });
    }

    function salesAgg(c) {
        return lazy(c, 'sa', () => {
            if (!salesReady() || !c.attach || typeof getSalesAggForKey !== 'function' || typeof resolveSalesKey !== 'function') return null;
            return getSalesAggForKey(resolveSalesKey(c.row));
        });
    }

    function salesCount(c) {
        return lazy(c, 'sc', () => {
            if (!salesReady() || !c.attach || typeof getSalesDetailsForRow !== 'function') return null;
            return (getSalesDetailsForRow(c.row) || []).length;
        });
    }

    function revenueOf(c) {
        return lazy(c, 'rev', () => {
            if (!salesReady() || !c.attach || typeof getRevenueForRow !== 'function') return null;
            return getRevenueForRow(c.row, c.first) || 0;
        });
    }

    function econOf(c) {
        return lazy(c, 'econ', () => (typeof RouteCosts !== 'undefined' && RouteCosts.lookup ? RouteCosts.lookup(c.row, c.code, c.date) : null));
    }

    function subsidyOf(c) {
        if (typeof SharedOverrides !== 'undefined' && SharedOverrides.hasSubsidy(c.code, c.date)) {
            return SharedOverrides.getSubsidy(c.code, c.date) || 0;
        }
        const econ = econOf(c);
        return econ ? (econ.subsidyOneWay || 0) : null;
    }

    function costOf(c) {
        const econ = econOf(c);
        return econ && econ.unitCost != null ? econ.unitCost : null;
    }

    function pkzOf(c) {
        return lazy(c, 'pkz', () => (typeof getPkzFlightDetails === 'function' ? getPkzFlightDetails(c.row, c.code, { showSales: false }) : null));
    }

    function navOf(c) {
        if (typeof getPkzNavValue !== 'function') return null;
        const v = getPkzNavValue(c.date, c.code);
        return v == null || isNaN(v) ? null : Number(v);
    }

    function parsedDate(c) {
        return lazy(c, 'pd', () => (typeof parseLocalDate === 'function' ? parseLocalDate(c.date) : null));
    }

    function bucketValue(c, key) {
        const s = salesBucket(c);
        return s ? (s[key] || 0) : null;
    }

    function numOrNull(v) {
        return v == null || v === '' || isNaN(v) ? null : Number(v);
    }

    // ---------- каталог столбцов ----------
    // type: text | date | num | rub | pct | kg. agg: sum | avg | min | max | ratio (num/den) | text.

    const FIELDS = [
        { key: 'date', group: 'flight', label: 'Дата', type: 'date', agg: 'text', get: c => c.date },
        { key: 'dow', group: 'flight', label: 'День недели', type: 'text', agg: 'text', get: c => { const d = parsedDate(c); return d && typeof DAYS_RU !== 'undefined' ? DAYS_RU[d.getDay()] : ''; } },
        { key: 'code', group: 'flight', label: 'Номер рейса', type: 'text', agg: 'text', get: c => c.code },
        { key: 'base', group: 'flight', label: 'Базовый рейс', type: 'text', agg: 'text', get: c => c.base },
        { key: 'direction', group: 'flight', label: 'Направление', type: 'text', agg: 'text', get: c => (typeof getFlightDirection === 'function' ? getFlightDirection(c.base) : c.base) },
        { key: 'segment', group: 'flight', label: 'Участок', type: 'text', agg: 'text', get: c => { const r = typeof getRouteFromRow === 'function' ? getRouteFromRow(c.row) : (c.row[3] || ''); return typeof formatRouteDisplay === 'function' ? formatRouteDisplay(r) : r; } },
        { key: 'routeType', group: 'flight', label: 'Тип маршрута', type: 'text', agg: 'text', get: c => (typeof getFlightRouteTypeLabel === 'function' ? getFlightRouteTypeLabel(c.code) : '') },
        { key: 'aircraft', group: 'flight', label: 'Тип ВС', type: 'text', agg: 'text', get: c => (typeof getAircraftType === 'function' ? getAircraftType(c.row[4]) : c.row[4]) },
        { key: 'depTime', group: 'flight', label: 'Время вылета', type: 'text', agg: 'text', get: c => (typeof getDepTime === 'function' ? getDepTime(c.row) : c.row[11]) || '' },
        { key: 'arrTime', group: 'flight', label: 'Время прилёта', type: 'text', agg: 'text', get: c => (typeof getArrTime === 'function' ? getArrTime(c.row) : c.row[12]) || '' },
        { key: 'dtd', group: 'flight', label: 'Дней до вылета', type: 'num', agg: 'min', get: c => { const m = metricsOf(c); return m ? m.dtd : null; } },
        { key: 'status', group: 'flight', label: 'Статус', type: 'text', agg: 'text', get: c => { const m = metricsOf(c); if (!m) return ''; return m.closed ? 'Закрыт' : (m.flew ? 'Улетел' : 'Открыт'); } },
        { key: 'week', group: 'flight', label: 'Неделя', type: 'text', agg: 'text', sortBy: c => { const d = parsedDate(c); return d && typeof getWeekNumber === 'function' ? d.getFullYear() * 100 + getWeekNumber(d) : 0; }, get: c => { const d = parsedDate(c); return d && typeof getWeekNumber === 'function' ? String(getWeekNumber(d)) : ''; } },
        { key: 'month', group: 'flight', label: 'Месяц', type: 'text', agg: 'text', sortBy: c => { const d = parsedDate(c); return d ? d.getFullYear() * 12 + d.getMonth() : 0; }, get: c => { const d = parsedDate(c); return d ? `${MONTHS_RU[d.getMonth()]} ${d.getFullYear()}` : ''; } },
        { key: 'comment', group: 'flight', label: 'Комментарий к рейсу', type: 'text', agg: 'text', get: c => { if (typeof FlightComments === 'undefined') return ''; return String(FlightComments.get(c.base, c.date) || FlightComments.get(c.code, c.date) || '').trim(); } },

        { key: 'au', group: 'load', label: 'AU снимка', type: 'num', agg: 'sum', get: c => (typeof getAuFromRow === 'function' ? getAuFromRow(c.row) : null) },
        { key: 'spec', group: 'load', label: 'Спец. брони', type: 'num', agg: 'sum', get: c => (typeof getSpecBookings === 'function' ? getSpecBookings(c.row) : null) },
        { key: 'seats', group: 'load', label: 'Кресла в продаже', type: 'num', agg: 'sum', get: c => (typeof getSeatsOnSale === 'function' ? getSeatsOnSale(c.row) : null) },
        { key: 'sold', group: 'load', label: 'Загрузка, пасс.', type: 'num', agg: 'sum', get: c => (typeof getSoldFromRow === 'function' ? getSoldFromRow(c.row) : null) },
        { key: 'zpk', group: 'load', label: 'ЗПК, %', type: 'pct', agg: 'ratio', num: 'sold', den: 'seats', scale: 100, get: c => { const m = metricsOf(c); return m ? m.pct : null; } },
        { key: 'remainder', group: 'load', label: 'Остаток мест', type: 'num', agg: 'sum', get: c => (typeof getSeatRemainder === 'function' ? getSeatRemainder(c.row) : null) },

        { key: 'salesToday', group: 'sales', label: 'Продано сегодня', type: 'num', agg: 'sum', get: c => bucketValue(c, 'today') },
        { key: 'salesYesterday', group: 'sales', label: 'Продано вчера', type: 'num', agg: 'sum', get: c => bucketValue(c, 'yesterday') },
        { key: 'salesDay2', group: 'sales', label: 'Продано позавчера', type: 'num', agg: 'sum', get: c => bucketValue(c, 'day2') },
        { key: 'sales7', group: 'sales', label: 'Продано за 7 дней', type: 'num', agg: 'sum', get: c => bucketValue(c, 'd7') },
        { key: 'sales14', group: 'sales', label: 'Продано за 14 дней', type: 'num', agg: 'sum', get: c => bucketValue(c, 'd14') },
        { key: 'sales30', group: 'sales', label: 'Продано за 30 дней', type: 'num', agg: 'sum', get: c => bucketValue(c, 'd30') },
        { key: 'pickup', group: 'sales', label: 'Подбор (сегодня + вчера)', type: 'num', agg: 'sum', get: c => { const s = salesBucket(c); return s ? (s.today || 0) + (s.yesterday || 0) : null; } },
        { key: 'tickets', group: 'sales', label: 'Билетов в файле продаж', type: 'num', agg: 'sum', get: c => salesCount(c) },
        { key: 'avgFare', group: 'sales', label: 'Средний тариф', type: 'rub', agg: 'ratio', num: 'revenue', den: 'tickets', scale: 1, get: c => { const a = salesAgg(c); return a && a.avg ? a.avg : null; } },
        { key: 'lastFare', group: 'sales', label: 'Последний тариф', type: 'rub', agg: 'avg', get: c => { const a = salesAgg(c); return a && a.last ? a.last : null; } },
        { key: 'revenue', group: 'sales', label: 'Выручка', type: 'rub', agg: 'sum', get: c => revenueOf(c) },

        { key: 'expected', group: 'rms', label: 'Прогноз загрузки', type: 'num', agg: 'sum', get: c => { const m = metricsOf(c); return m ? m.evR : null; } },
        { key: 'delta', group: 'rms', label: 'Отклонение от прогноза', type: 'num', agg: 'sum', get: c => { const m = metricsOf(c); return m ? m.delta : null; } },
        { key: 'alert', group: 'rms', label: 'Сигнал RMS', type: 'text', agg: 'text', get: c => { const m = metricsOf(c); return m ? (ALERT_LABELS[m.alertLevel] || '') : ''; } },
        { key: 'alertReason', group: 'rms', label: 'Причина сигнала', type: 'text', agg: 'text', get: c => { const m = metricsOf(c); return m ? (m.alertReason || '') : ''; } },

        { key: 'cost', group: 'econ', label: 'Себестоимость', type: 'rub', agg: 'sum', get: c => costOf(c) },
        { key: 'subsidy', group: 'econ', label: 'Субсидия', type: 'rub', agg: 'sum', get: c => subsidyOf(c) },
        { key: 'subsidized', group: 'econ', label: 'Субсидируемый', type: 'text', agg: 'text', get: c => { const e = econOf(c); return e ? (e.subsidized ? 'Да' : 'Нет') : ''; } },
        { key: 'fin', group: 'econ', label: 'Фин. результат', type: 'rub', agg: 'sum', get: c => { const cost = costOf(c); const sub = subsidyOf(c); const rev = revenueOf(c); if (cost == null && sub == null && rev == null) return null; return (rev || 0) - (cost || 0) + (sub || 0); } },

        { key: 'adults', group: 'pkz', label: 'Взрослых', type: 'num', agg: 'sum', get: c => { const p = pkzOf(c); return p ? p.adults : null; } },
        { key: 'children', group: 'pkz', label: 'Детей', type: 'num', agg: 'sum', get: c => { const p = pkzOf(c); return p ? p.children : null; } },
        { key: 'bagKg', group: 'pkz', label: 'Багаж на пассажира', type: 'kg', agg: 'avg', get: c => { const p = pkzOf(c); return p ? numOrNull(p.baggageKg) : null; } },
        { key: 'pkz', group: 'pkz', label: 'ПКЗ расчётный', type: 'kg', agg: 'sum', get: c => { const p = pkzOf(c); return p ? numOrNull(p.pkzKg) : null; } },
        { key: 'pkzNav', group: 'pkz', label: 'ПКЗ из NAV', type: 'kg', agg: 'sum', get: c => navOf(c) },
        { key: 'vacancy', group: 'pkz', label: 'Вакансия', type: 'kg', agg: 'sum', get: c => { const nav = navOf(c); const p = pkzOf(c); const kg = p ? numOrNull(p.pkzKg) : null; return nav != null && kg != null ? nav - kg : null; } },

        { key: 'mgmtToday', group: 'mgmt', label: 'Отметка сегодня', type: 'text', agg: 'text', get: c => {
            if (typeof SalesManagement === 'undefined' || typeof getTodayDate !== 'function') return '';
            const mark = SalesManagement.getMark(c.code, c.date, getTodayDate());
            if (!mark || !SalesManagement.STATUSES[mark.status]) return '';
            return SalesManagement.STATUSES[mark.status].short + (mark.author ? ' · ' + mark.author : '');
        } }
    ];

    const FIELD_BY_KEY = {};
    FIELDS.forEach(f => { FIELD_BY_KEY[f.key] = f; });

    const GROUP_BY = [
        { key: '', label: 'Без группировки — каждый вылет' },
        { key: 'code', label: 'По номеру рейса' },
        { key: 'base', label: 'По базовому рейсу' },
        { key: 'direction', label: 'По направлению' },
        { key: 'date', label: 'По дате' },
        { key: 'dow', label: 'По дню недели' },
        { key: 'week', label: 'По неделе' },
        { key: 'month', label: 'По месяцу' },
        { key: 'aircraft', label: 'По типу ВС' },
        { key: 'routeType', label: 'По типу маршрута' },
        { key: 'status', label: 'По статусу' },
        { key: 'subsidized', label: 'По субсидии' }
    ];

    const BUILTIN = {
        'Загрузка и экономика': {
            cols: ['date', 'dow', 'code', 'direction', 'aircraft', 'seats', 'sold', 'zpk', 'revenue', 'subsidy', 'cost', 'fin'],
            period: 'next30', groupBy: '', sort: { key: 'date', dir: 'asc' }
        },
        'Продажи по рейсам': {
            cols: ['code', 'direction', 'sold', 'seats', 'zpk', 'salesToday', 'sales7', 'pickup', 'avgFare', 'revenue'],
            period: 'next30', groupBy: 'code', sort: { key: 'sales7', dir: 'desc' }
        },
        'RMS: отстают от прогноза': {
            cols: ['date', 'code', 'direction', 'dtd', 'sold', 'expected', 'delta', 'alert', 'alertReason'],
            period: 'next30', groupBy: '', sort: { key: 'delta', dir: 'asc' },
            conds: [{ field: 'delta', op: 'lt', value: '0' }]
        },
        'ПКЗ на неделю': {
            cols: ['date', 'code', 'segment', 'aircraft', 'adults', 'children', 'bagKg', 'pkz', 'pkzNav', 'vacancy'],
            period: 'next7', groupBy: '', sort: { key: 'date', dir: 'asc' }
        },
        'Итоги по направлениям': {
            cols: ['direction', 'seats', 'sold', 'zpk', 'revenue', 'subsidy', 'cost', 'fin'],
            period: 'next30', groupBy: 'direction', sort: { key: 'fin', dir: 'asc' }
        }
    };

    // ---------- состояние ----------

    let layout = null;
    let activeRef = '';
    let saved = {};
    let shared = {};
    let sharedLoaded = false;
    let panelOpen = true;
    let fieldSearch = '';
    const collapsed = new Set();
    let loadedFor = '';
    let built = { sig: '', result: null };
    let saveTimer = null;
    let host = null;

    function defaultLayout() {
        return normalizeLayout(BUILTIN['Загрузка и экономика']);
    }

    function normalizeLayout(src) {
        const s = src && typeof src === 'object' ? src : {};
        const cols = Array.isArray(s.cols) ? s.cols.filter(k => FIELD_BY_KEY[k]) : [];
        const period = PERIODS.some(p => p.id === s.period) || s.period === 'custom' ? s.period : 'next30';
        const status = s.status && typeof s.status === 'object' ? s.status : {};
        return {
            cols: cols.filter((k, i) => cols.indexOf(k) === i),
            period,
            from: cleanDate(s.from),
            to: cleanDate(s.to),
            search: String(s.search || '').slice(0, 80),
            routeType: ['all', 'krai', 'interregional'].indexOf(s.routeType) !== -1 ? s.routeType : 'all',
            status: {
                open: status.open !== false,
                closed: status.closed !== false,
                flew: s.period === 'past30' || s.period === 'all' ? status.flew !== false : !!status.flew
            },
            conds: (Array.isArray(s.conds) ? s.conds : [])
                .filter(c => c && FIELD_BY_KEY[c.field] && OPS.some(o => o.id === c.op))
                .map(c => ({ field: c.field, op: c.op, value: String(c.value == null ? '' : c.value).slice(0, 60) }))
                .slice(0, 12),
            groupBy: GROUP_BY.some(g => g.key === s.groupBy) ? s.groupBy : '',
            sort: s.sort && FIELD_BY_KEY[s.sort.key] || (s.sort && s.sort.key === '__count')
                ? { key: s.sort.key, dir: s.sort.dir === 'desc' ? 'desc' : 'asc' }
                : { key: '', dir: 'asc' },
            totals: s.totals !== false
        };
    }

    function cleanDate(value) {
        const norm = typeof normalizeDate === 'function' ? normalizeDate(value) : String(value || '');
        return norm && typeof parseLocalDate === 'function' && parseLocalDate(norm) ? norm : '';
    }

    function profileId() {
        return (typeof ProfileAuth !== 'undefined' && ProfileAuth.getCurrentProfile && ProfileAuth.getCurrentProfile()?.id) || 'guest';
    }

    function profileName() {
        const p = typeof ProfileAuth !== 'undefined' && ProfileAuth.getCurrentProfile ? ProfileAuth.getCurrentProfile() : null;
        return p ? String(p.name || p.id || '') : '';
    }

    function isAdmin() {
        const p = typeof ProfileAuth !== 'undefined' && ProfileAuth.getCurrentProfile ? ProfileAuth.getCurrentProfile() : null;
        return !!(p && p.isAdmin);
    }

    function hasPerm(perm) {
        if (typeof ProfileAuth === 'undefined' || typeof ProfileAuth.hasPermission !== 'function') return true;
        return ProfileAuth.hasPermission(perm);
    }

    function groupAllowed(groupId) {
        const g = GROUPS.find(item => item.id === groupId);
        if (!g || !g.perms) return true;
        return g.perms.some(hasPerm);
    }

    function fieldAllowed(key) {
        const f = FIELD_BY_KEY[key];
        return !!f && groupAllowed(f.group);
    }

    function loadState() {
        loadedFor = profileId();
        let stored = null;
        try { stored = JSON.parse(localStorage.getItem(STORE_PREFIX + profileId()) || 'null'); } catch (e) { stored = null; }
        saved = {};
        if (stored && stored.saved && typeof stored.saved === 'object') {
            Object.keys(stored.saved).forEach(name => { saved[name] = normalizeLayout(stored.saved[name]); });
        }
        layout = stored && stored.current ? normalizeLayout(stored.current) : defaultLayout();
        activeRef = stored && typeof stored.activeRef === 'string' ? stored.activeRef : (stored ? '' : 'b:Загрузка и экономика');
    }

    function persistState() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            try {
                localStorage.setItem(STORE_PREFIX + profileId(), JSON.stringify({ current: layout, saved, activeRef }));
            } catch (e) { /* ignore */ }
        }, 200);
    }

    let sharedSeen = false;

    async function loadShared() {
        if (typeof SharedStorage === 'undefined' || typeof SharedStorage.readJsonFile !== 'function') return;
        let remote = null;
        try { remote = await SharedStorage.readJsonFile(SHARED_FILE); } catch (e) { remote = null; }
        if (remote && remote.layouts && Object.keys(remote.layouts).length) sharedSeen = true;
        shared = {};
        const items = remote && remote.layouts && typeof remote.layouts === 'object' ? remote.layouts : {};
        Object.keys(items).forEach(name => {
            const item = items[name];
            if (!item || !item.layout) return;
            shared[name] = { layout: normalizeLayout(item.layout), author: String(item.author || ''), updatedAt: String(item.updatedAt || '') };
        });
        sharedLoaded = true;
    }

    async function writeShared(mutate) {
        if (typeof SharedStorage === 'undefined' || typeof SharedStorage.writeJsonFile !== 'function') return false;
        let remote = null;
        try { remote = await SharedStorage.readJsonFile(SHARED_FILE); } catch (e) { remote = null; }
        // Файл раньше читался, а сейчас нет — не записываем, иначе пропадут чужие общие шаблоны.
        if (!remote && sharedSeen) return false;
        const layouts = remote && remote.layouts && typeof remote.layouts === 'object' ? { ...remote.layouts } : {};
        mutate(layouts);
        const ok = await SharedStorage.writeJsonFile(SHARED_FILE, { version: 1, updatedAt: new Date().toISOString(), layouts });
        if (ok) await loadShared();
        return !!ok;
    }

    // ---------- данные ----------

    function startOfDay(d) {
        const t = new Date(d.getTime());
        t.setHours(0, 0, 0, 0);
        return t;
    }

    function addDays(d, n) {
        return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
    }

    function periodBounds() {
        const today = startOfDay(new Date());
        switch (layout.period) {
            case 'today': return { from: today, to: today };
            case 'next7': return { from: today, to: addDays(today, 7) };
            case 'next30': return { from: today, to: addDays(today, 30) };
            case 'next90': return { from: today, to: addDays(today, 90) };
            case 'past30': return { from: addDays(today, -30), to: addDays(today, -1) };
            case 'custom': {
                const from = layout.from && parseLocalDate(layout.from);
                const to = layout.to && parseLocalDate(layout.to);
                return { from: from || null, to: to || null };
            }
            default: return { from: null, to: null };
        }
    }

    function dataSignature() {
        const epoch = typeof dataEpoch === 'number' ? dataEpoch : 0;
        const rows = typeof allData !== 'undefined' && allData ? allData.length : 0;
        const today = typeof getTodayDate === 'function' ? getTodayDate() : '';
        // Версия отметок без первого поля (время записи файла): оно меняется при каждой попытке записи.
        const fullRev = typeof SalesManagement !== 'undefined' && SalesManagement.revision ? SalesManagement.revision() : '';
        const marks = fullRev.slice(fullRev.indexOf('\u0001') + 1);
        const ov = typeof SharedOverrides !== 'undefined' && SharedOverrides.subsidyRevision
            ? SharedOverrides.subsidyRevision() + ':' + (SharedOverrides.navRevision ? SharedOverrides.navRevision() : 0)
            : '';
        return [epoch, rows, today, ov, JSON.stringify(layout), marks].join('|');
    }

    function collectContexts() {
        const grouped = typeof groupedData !== 'undefined' && groupedData ? groupedData : {};
        const bounds = periodBounds();
        const fromT = bounds.from ? bounds.from.getTime() : -Infinity;
        const toT = bounds.to ? bounds.to.getTime() : Infinity;
        const todayStart = startOfDay(new Date());
        const query = layout.search.trim().toLowerCase();
        const out = [];
        Object.keys(grouped).forEach(base => {
            if (typeof isValidFlightBase === 'function' && !isValidFlightBase(base)) return;
            const rows = grouped[base] || [];
            const first = typeof buildFirstSalesRowByKey === 'function' ? buildFirstSalesRowByKey(rows) : new Map();
            const direction = typeof getFlightDirection === 'function' ? String(getFlightDirection(base) || '') : '';
            rows.forEach(row => {
                if (!row || !row[0] || !row[1]) return;
                const d = parseLocalDate(row[1]);
                if (!d) return;
                const t = d.getTime();
                if (t < fromT || t > toT) return;
                const code = cleanFlight(row[0]);
                if (layout.routeType !== 'all' && typeof flightMatchesRouteTypeFilter === 'function' && !flightMatchesRouteTypeFilter(code, layout.routeType)) return;
                if (query) {
                    const hay = `${code} ${base} ${direction} ${row[3] || ''}`.toLowerCase();
                    if (hay.indexOf(query) === -1) return;
                }
                const c = {
                    row,
                    base,
                    code,
                    date: row[1],
                    first,
                    todayStart,
                    attach: typeof shouldAttachSalesToRowCached === 'function' ? shouldAttachSalesToRowCached(row, first) : true,
                    memo: {}
                };
                const m = metricsOf(c);
                const state = m ? (m.closed ? 'closed' : (m.flew ? 'flew' : 'open')) : 'open';
                if (!layout.status[state]) return;
                c.state = state;
                out.push(c);
            });
        });
        return out;
    }

    function valueOf(c, key) {
        const memoKey = 'f:' + key;
        if (Object.prototype.hasOwnProperty.call(c.memo, memoKey)) return c.memo[memoKey];
        const f = FIELD_BY_KEY[key];
        let v = null;
        try { v = f ? f.get(c) : null; } catch (e) { v = null; }
        if (f && f.type !== 'text' && f.type !== 'date') v = numOrNull(v);
        if (v === undefined) v = null;
        c.memo[memoKey] = v;
        return v;
    }

    function sortValueOf(c, key) {
        const f = FIELD_BY_KEY[key];
        if (f && f.sortBy) return f.sortBy(c);
        if (f && f.type === 'date') {
            const d = parsedDate(c);
            return d ? d.getTime() : null;
        }
        return valueOf(c, key);
    }

    function condMatches(c, cond) {
        const f = FIELD_BY_KEY[cond.field];
        const v = valueOf(c, cond.field);
        const blank = v == null || v === '';
        if (cond.op === 'empty') return blank;
        if (cond.op === 'filled') return !blank;
        if (cond.op === 'has') return !blank && String(v).toLowerCase().indexOf(String(cond.value).toLowerCase()) !== -1;
        if (f.type === 'text') {
            const a = String(v == null ? '' : v).toLowerCase();
            const b = String(cond.value).toLowerCase();
            if (cond.op === 'eq') return a === b;
            if (cond.op === 'ne') return a !== b;
            return false;
        }
        let left = v;
        let right = parseFloat(String(cond.value).replace(',', '.'));
        if (f.type === 'date') {
            const d = parseLocalDate(c.date);
            const r = parseLocalDate(cleanDate(cond.value));
            left = d ? d.getTime() : null;
            right = r ? r.getTime() : NaN;
        }
        if (left == null || isNaN(right)) return false;
        switch (cond.op) {
            case 'gt': return left > right;
            case 'ge': return left >= right;
            case 'lt': return left < right;
            case 'le': return left <= right;
            case 'eq': return left === right;
            case 'ne': return left !== right;
            default: return true;
        }
    }

    function aggregate(key, ctxs) {
        const f = FIELD_BY_KEY[key];
        if (!f) return null;
        if (f.agg === 'text') {
            const seen = [];
            ctxs.forEach(c => {
                const v = valueOf(c, key);
                if (v == null || v === '') return;
                const text = String(v);
                if (seen.indexOf(text) === -1) seen.push(text);
            });
            if (!seen.length) return null;
            if (seen.length <= 3) return seen.join(', ');
            return `${seen.length} знач.`;
        }
        if (f.agg === 'ratio') {
            let num = 0;
            let den = 0;
            let any = false;
            ctxs.forEach(c => {
                const a = valueOf(c, f.num);
                const b = valueOf(c, f.den);
                if (a == null || b == null) return;
                num += a;
                den += b;
                any = true;
            });
            if (!any || !den) return null;
            return Math.round(num / den * (f.scale || 1));
        }
        const vals = [];
        ctxs.forEach(c => {
            const v = valueOf(c, key);
            if (v != null) vals.push(v);
        });
        if (!vals.length) return null;
        if (f.agg === 'sum') return vals.reduce((a, b) => a + b, 0);
        if (f.agg === 'avg') return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10;
        if (f.agg === 'min') return Math.min.apply(null, vals);
        if (f.agg === 'max') return Math.max.apply(null, vals);
        return null;
    }

    function visibleCols() {
        return layout.cols.filter(fieldAllowed);
    }

    function buildResult() {
        const sig = dataSignature();
        if (built.sig === sig && built.result) return built.result;
        const cols = visibleCols();
        let ctxs = collectContexts();
        // Условие без значения (только что добавленное) не применяется, иначе таблица пустеет.
        const conds = layout.conds.filter(cond => fieldAllowed(cond.field)
            && (cond.op === 'empty' || cond.op === 'filled' || String(cond.value == null ? '' : cond.value).trim() !== ''));
        if (conds.length) ctxs = ctxs.filter(c => conds.every(cond => condMatches(c, cond)));

        let rows;
        const groupKey = layout.groupBy && fieldAllowed(layout.groupBy) ? layout.groupBy : '';
        if (groupKey) {
            const map = new Map();
            ctxs.forEach(c => {
                const v = valueOf(c, groupKey);
                const id = v == null || v === '' ? '—' : String(v);
                if (!map.has(id)) map.set(id, []);
                map.get(id).push(c);
            });
            rows = [];
            map.forEach((list, id) => {
                const values = {};
                cols.forEach(key => {
                    values[key] = key === groupKey ? id : aggregate(key, list);
                });
                values[groupKey] = id;
                values.__count = list.length;
                const sortProbe = list[0];
                rows.push({ values, list, groupId: id, groupSort: sortValueOf(sortProbe, groupKey) });
            });
        } else {
            rows = ctxs.map(c => {
                const values = {};
                cols.forEach(key => { values[key] = valueOf(c, key); });
                return { values, ctx: c, state: c.state };
            });
        }

        const sortKey = layout.sort.key && (layout.sort.key === '__count' || cols.indexOf(layout.sort.key) !== -1)
            ? layout.sort.key
            : (groupKey || (cols.indexOf('date') !== -1 ? 'date' : ''));
        const dir = layout.sort.dir === 'desc' ? -1 : 1;
        const sortVal = (r) => {
            if (sortKey === '__count') return r.values.__count;
            if (groupKey && sortKey === groupKey) return r.groupSort;
            if (!groupKey && r.ctx) return sortValueOf(r.ctx, sortKey);
            return r.values[sortKey];
        };
        const fallback = (a, b) => {
            const ca = a.ctx || (a.list && a.list[0]);
            const cb = b.ctx || (b.list && b.list[0]);
            const da = ca ? sortValueOf(ca, 'date') : 0;
            const db = cb ? sortValueOf(cb, 'date') : 0;
            if (da !== db) return (da || 0) - (db || 0);
            return String(ca ? ca.code : '').localeCompare(String(cb ? cb.code : ''), 'ru', { numeric: true });
        };
        if (sortKey) {
            rows.sort((a, b) => {
                const va = sortVal(a);
                const vb = sortVal(b);
                const aBlank = va == null || va === '';
                const bBlank = vb == null || vb === '';
                if (aBlank && bBlank) return fallback(a, b);
                if (aBlank) return 1;
                if (bBlank) return -1;
                if (typeof va === 'number' && typeof vb === 'number') return va === vb ? fallback(a, b) : (va - vb) * dir;
                const cmp = String(va).localeCompare(String(vb), 'ru', { numeric: true });
                return cmp ? cmp * dir : fallback(a, b);
            });
        } else {
            rows.sort(fallback);
        }

        const totals = {};
        cols.forEach(key => {
            const f = FIELD_BY_KEY[key];
            totals[key] = f.agg === 'text' ? null : aggregate(key, ctxs);
        });
        totals.__count = ctxs.length;

        const result = { cols, rows, totals, groupKey, flights: ctxs.length };
        built = { sig, result };
        return result;
    }

    // ---------- вывод ----------

    function esc(v) {
        return typeof escHtml === 'function' ? escHtml(v) : String(v == null ? '' : v);
    }

    function attr(v) {
        return typeof escAttr === 'function' ? escAttr(v) : String(v == null ? '' : v);
    }

    function fmtNumber(n, digits) {
        if (n == null || isNaN(n)) return '—';
        const opts = { maximumFractionDigits: digits == null ? 0 : digits };
        return Number(n).toLocaleString('ru-RU', opts);
    }

    function formatValue(key, v) {
        const f = FIELD_BY_KEY[key];
        if (key === '__count') return fmtNumber(v);
        if (v == null || v === '') return f && f.type === 'text' ? '' : '—';
        if (!f) return esc(v);
        switch (f.type) {
            case 'rub': return typeof formatRub === 'function' ? formatRub(v) : fmtNumber(v) + ' ₽';
            case 'pct': return fmtNumber(v) + '%';
            case 'kg': return fmtNumber(v, 1) + ' кг';
            case 'num': return fmtNumber(v, f.agg === 'avg' ? 1 : 0);
            default: return String(v);
        }
    }

    function cellClass(key, v) {
        const f = FIELD_BY_KEY[key];
        const numeric = key === '__count' || (f && f.type !== 'text' && f.type !== 'date');
        let cls = numeric ? 'cr-num' : 'cr-text';
        if (numeric && typeof v === 'number') {
            if ((key === 'fin' || key === 'delta' || key === 'vacancy') && v < 0) cls += ' cr-neg';
            if ((key === 'fin' || key === 'vacancy') && v > 0) cls += ' cr-pos';
        }
        return cls;
    }

    // При группировке столбец группы показывается всегда, даже если его убрали из списка столбцов.
    function headerCols(result) {
        const list = result.cols.slice();
        if (result.groupKey) {
            if (list.indexOf(result.groupKey) === -1) list.unshift(result.groupKey);
            list.splice(list.indexOf(result.groupKey) + 1, 0, '__count');
        }
        return list;
    }

    function colLabel(key) {
        if (key === '__count') return 'Вылетов';
        const f = FIELD_BY_KEY[key];
        if (!f) return key;
        return f.type === 'kg' ? f.label + ', кг' : f.label;
    }

    function renderTable() {
        const wrap = document.getElementById('cr-grid');
        if (!wrap) return;
        const count = document.getElementById('cr-count');
        const hasData = typeof groupedData !== 'undefined' && groupedData && Object.keys(groupedData).length > 0;
        if (!hasData) {
            if (typeof TableVirtual !== 'undefined') TableVirtual.destroyHandle(wrap);
            wrap.innerHTML = '<div class="table-empty-state"><div class="table-empty-title">Нет данных</div><div class="table-empty-hint">Загрузите файлы кнопкой «Загрузить» или откройте «Последние» — конструктор строится из них.</div></div>';
            if (count) count.textContent = '';
            return;
        }
        const result = buildResult();
        if (!result.cols.length) {
            if (typeof TableVirtual !== 'undefined') TableVirtual.destroyHandle(wrap);
            wrap.innerHTML = '<div class="table-empty-state"><div class="table-empty-title">Столбцы не выбраны</div><div class="table-empty-hint">Отметьте нужные данные в панели «Настройка» слева.</div></div>';
            if (count) count.textContent = '';
            return;
        }
        const cols = headerCols(result);
        const sortKey = layout.sort.key;
        const arrow = (key) => (sortKey === key ? (layout.sort.dir === 'desc' ? ' ▼' : ' ▲') : '');
        const head = cols.map(key => `<th class="cr-th ${cellClass(key, null)}${sortKey === key ? ' cr-sorted' : ''}" data-sort="${attr(key)}" title="Сортировать">${esc(colLabel(key))}${arrow(key)}</th>`).join('');
        const totals = layout.totals
            ? `<tr class="cr-totals">${cols.map((key, i) => {
                const v = result.totals[key];
                const text = i === 0 && (v == null || v === '') ? 'Итого' : (v == null ? '' : formatValue(key, v));
                return `<th class="${cellClass(key, v)}">${esc(text)}</th>`;
            }).join('')}</tr>`
            : '';
        const openTable = `<table class="cr-table"><thead><tr>${head}</tr>${totals}</thead><tbody>`;
        const rowHtml = result.rows.map(r => {
            const cls = r.state === 'flew' ? 'cr-row-flew' : (r.state === 'closed' ? 'cr-row-closed' : '');
            const cells = cols.map(key => {
                const v = r.values[key];
                return `<td class="${cellClass(key, v)}">${esc(formatValue(key, v))}</td>`;
            }).join('');
            return `<tr class="${cls}">${cells}</tr>`;
        });
        if (!rowHtml.length) {
            if (typeof TableVirtual !== 'undefined') TableVirtual.destroyHandle(wrap);
            wrap.innerHTML = openTable + `<tr><td class="cr-empty" colspan="${cols.length}">Ничего не подходит под период и условия</td></tr></tbody></table>`;
        } else if (typeof TableVirtual !== 'undefined') {
            TableVirtual.mount({ container: wrap, openTable, rows: rowHtml, rowHeight: 30 });
        } else {
            wrap.innerHTML = openTable + rowHtml.join('') + '</tbody></table>';
        }
        if (count) {
            count.textContent = result.groupKey
                ? `Групп: ${fmtNumber(result.rows.length)} · вылетов: ${fmtNumber(result.flights)}`
                : `Вылетов: ${fmtNumber(result.rows.length)}`;
        }
    }

    // ---------- панель настройки ----------

    function fieldOptions(selected, filter) {
        return FIELDS.filter(f => fieldAllowed(f.key) && (!filter || filter(f))).map(f => {
            const g = GROUPS.find(item => item.id === f.group);
            return `<option value="${attr(f.key)}"${f.key === selected ? ' selected' : ''}>${esc(f.label)} · ${esc(g ? g.label : '')}</option>`;
        }).join('');
    }

    function renderPanel() {
        const panel = document.getElementById('cr-panel');
        if (!panel) return;
        panel.hidden = !panelOpen;
        const grid = panel.parentElement;
        if (grid) grid.classList.toggle('cr-layout-full', !panelOpen);
        const toggle = document.getElementById('cr-panel-toggle');
        if (toggle) toggle.classList.toggle('filter-btn-active', panelOpen);
        if (!panelOpen) return;
        const chosen = layout.cols.filter(fieldAllowed).map((key, i, list) => `
            <li class="cr-chosen" draggable="true" data-key="${attr(key)}">
                <span class="cr-grip" aria-hidden="true">⋮⋮</span>
                <span class="cr-chosen-label">${esc(colLabel(key))}</span>
                <button type="button" class="cr-mini" data-move="-1" data-key="${attr(key)}" title="Выше"${i === 0 ? ' disabled' : ''}>↑</button>
                <button type="button" class="cr-mini" data-move="1" data-key="${attr(key)}" title="Ниже"${i === list.length - 1 ? ' disabled' : ''}>↓</button>
                <button type="button" class="cr-mini" data-remove="${attr(key)}" title="Убрать">✕</button>
            </li>`).join('');
        const q = fieldSearch.trim().toLowerCase();
        const groups = GROUPS.filter(g => groupAllowed(g.id)).map(g => {
            const items = FIELDS.filter(f => f.group === g.id && (!q || f.label.toLowerCase().indexOf(q) !== -1 || g.label.toLowerCase().indexOf(q) !== -1));
            if (!items.length) return '';
            const boxes = items.map(f => `
                <label class="cr-field">
                    <input type="checkbox" data-field="${attr(f.key)}"${layout.cols.indexOf(f.key) !== -1 ? ' checked' : ''}>
                    <span>${esc(colLabel(f.key))}</span>
                </label>`).join('');
            return `<details class="cr-group" data-group="${attr(g.id)}"${collapsed.has(g.id) && !q ? '' : ' open'}><summary>${esc(g.label)}</summary><div class="cr-fields">${boxes}</div></details>`;
        }).join('');
        const conds = layout.conds.map((cond, i) => `
            <div class="cr-cond" data-index="${i}">
                <select class="cr-input" data-cond="field">${fieldOptions(cond.field)}</select>
                <select class="cr-input cr-op" data-cond="op">${OPS.map(o => `<option value="${o.id}"${o.id === cond.op ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>
                <input class="cr-input cr-cond-value" data-cond="value" value="${attr(cond.value)}" placeholder="значение"${cond.op === 'empty' || cond.op === 'filled' ? ' hidden' : ''}>
                <button type="button" class="cr-mini" data-cond-remove="${i}" title="Убрать условие">✕</button>
            </div>`).join('');
        panel.innerHTML = `
            <section class="cr-section">
                <h3 class="cr-section-title">Столбцы в таблице</h3>
                ${chosen ? `<ol class="cr-chosen-list" id="cr-chosen">${chosen}</ol>` : '<p class="cr-note">Пока пусто — отметьте данные ниже.</p>'}
            </section>
            <section class="cr-section">
                <h3 class="cr-section-title">Добавить данные</h3>
                <input type="search" id="cr-field-search" class="cr-input cr-field-search" placeholder="Найти показатель" value="${attr(fieldSearch)}">
                ${groups || '<p class="cr-note">Ничего не найдено</p>'}
            </section>
            <section class="cr-section">
                <h3 class="cr-section-title">Условия</h3>
                ${conds || '<p class="cr-note">Без условий — показаны все вылеты периода.</p>'}
                <button type="button" class="filter-btn cr-add-cond" id="cr-add-cond">+ Условие</button>
                <p class="cr-note">Даты в условиях — ДД.ММ.ГГГГ. Условия проверяются по каждому вылету до группировки.</p>
            </section>
        `;
    }

    function renderToolbar() {
        const bar = document.getElementById('cr-filters');
        if (!bar) return;
        const periodBtns = PERIODS.map(p => `<button type="button" class="filter-btn${layout.period === p.id ? ' filter-btn-active' : ''}" data-period="${p.id}">${esc(p.label)}</button>`).join('');
        const b = periodBounds();
        const iso = (d) => (d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '');
        bar.innerHTML = `
            <div class="cr-filter-row">
                <span class="cr-label">Период</span>
                ${periodBtns}
                <label class="cr-date">с <input type="date" id="cr-from" class="cr-input" value="${iso(b.from)}"></label>
                <label class="cr-date">по <input type="date" id="cr-to" class="cr-input" value="${iso(b.to)}"></label>
            </div>
            <div class="cr-filter-row">
                <input type="search" id="cr-search" class="cr-input cr-search" placeholder="Рейс или маршрут" value="${attr(layout.search)}">
                <select id="cr-route-type" class="cr-input">
                    <option value="all"${layout.routeType === 'all' ? ' selected' : ''}>Все маршруты</option>
                    <option value="krai"${layout.routeType === 'krai' ? ' selected' : ''}>Краевые</option>
                    <option value="interregional"${layout.routeType === 'interregional' ? ' selected' : ''}>Межрегиональные</option>
                </select>
                <label class="cr-check"><input type="checkbox" data-status="open"${layout.status.open ? ' checked' : ''}> открытые</label>
                <label class="cr-check"><input type="checkbox" data-status="closed"${layout.status.closed ? ' checked' : ''}> закрытые</label>
                <label class="cr-check"><input type="checkbox" data-status="flew"${layout.status.flew ? ' checked' : ''}> улетевшие</label>
                <span class="cr-label">Группировка</span>
                <select id="cr-group" class="cr-input">${GROUP_BY.filter(g => !g.key || fieldAllowed(g.key)).map(g => `<option value="${attr(g.key)}"${layout.groupBy === g.key ? ' selected' : ''}>${esc(g.label)}</option>`).join('')}</select>
                <label class="cr-check"><input type="checkbox" id="cr-totals"${layout.totals ? ' checked' : ''}> итоги</label>
                <span class="table-controls-spacer"></span>
                <span id="cr-count" class="cr-count"></span>
            </div>
        `;
    }

    function templateOptions() {
        const opt = (ref, label) => `<option value="${attr(ref)}"${activeRef === ref ? ' selected' : ''}>${esc(label)}</option>`;
        const builtins = Object.keys(BUILTIN).map(name => opt('b:' + name, name)).join('');
        const mine = Object.keys(saved).sort((a, b) => a.localeCompare(b, 'ru')).map(name => opt('m:' + name, name)).join('');
        const common = Object.keys(shared).sort((a, b) => a.localeCompare(b, 'ru')).map(name => opt('s:' + name, name + (shared[name].author ? ' — ' + shared[name].author : ''))).join('');
        return `${activeRef ? '' : '<option value="" selected>— своя настройка —</option>'}
            <optgroup label="Готовые">${builtins}</optgroup>
            ${mine ? `<optgroup label="Мои">${mine}</optgroup>` : ''}
            ${common ? `<optgroup label="Общие">${common}</optgroup>` : ''}`;
    }

    function renderTemplates() {
        const sel = document.getElementById('cr-template');
        if (sel) sel.innerHTML = templateOptions();
        const del = document.getElementById('cr-delete');
        if (del) {
            const ref = activeRef;
            const canDelete = ref.indexOf('m:') === 0
                || (ref.indexOf('s:') === 0 && (isAdmin() || (shared[ref.slice(2)] && shared[ref.slice(2)].author === profileName())));
            del.disabled = !canDelete;
        }
        const exp = document.getElementById('cr-export');
        if (exp) exp.hidden = !hasPerm('export_excel');
    }

    function renderAll() {
        renderTemplates();
        renderToolbar();
        renderPanel();
        renderTable();
    }

    // ---------- изменения ----------

    function changed(opts) {
        const o = opts || {};
        if (!o.keepTemplate) activeRef = '';
        persistState();
        if (o.templates !== false) renderTemplates();
        if (o.toolbar) renderToolbar();
        if (o.panel) renderPanel();
        renderTable();
    }

    function applyTemplate(ref) {
        const kind = ref.slice(0, 2);
        const name = ref.slice(2);
        let src = null;
        if (kind === 'b:') src = BUILTIN[name];
        else if (kind === 'm:') src = saved[name];
        else if (kind === 's:') src = shared[name] && shared[name].layout;
        if (!src) return;
        layout = normalizeLayout(JSON.parse(JSON.stringify(src)));
        activeRef = ref;
        persistState();
        renderAll();
    }

    function toast(msg, type) {
        if (typeof showToast === 'function') showToast(msg, type);
    }

    function askName(def) {
        const name = window.prompt('Название шаблона', def || '');
        if (name == null) return '';
        return String(name).replace(/[\u0000-\u001F]/g, '').trim().slice(0, 60);
    }

    function saveMine(asNew) {
        let name = !asNew && activeRef.indexOf('m:') === 0 ? activeRef.slice(2) : '';
        if (!name) name = askName(activeRef ? activeRef.slice(2) : '');
        if (!name) return;
        if (asNew && saved[name] && !window.confirm(`Шаблон «${name}» уже есть. Заменить?`)) return;
        saved[name] = normalizeLayout(JSON.parse(JSON.stringify(layout)));
        activeRef = 'm:' + name;
        persistState();
        renderTemplates();
        toast(`Шаблон «${name}» сохранён`);
    }

    async function shareCurrent() {
        const def = activeRef ? activeRef.slice(2) : '';
        const name = askName(def);
        if (!name) return;
        const existing = shared[name];
        if (existing && existing.author !== profileName() && !isAdmin()) {
            toast(`Общий шаблон «${name}» принадлежит ${existing.author || 'другому профилю'} — выберите другое название`, 'error');
            return;
        }
        const payload = { layout: JSON.parse(JSON.stringify(layout)), author: profileName(), updatedAt: new Date().toISOString() };
        const ok = await writeShared(layouts => { layouts[name] = payload; });
        if (!ok) {
            toast('Не удалось записать общий шаблон. Подключите папку приложения.', 'error');
            return;
        }
        activeRef = 's:' + name;
        persistState();
        renderTemplates();
        toast(`Шаблон «${name}» теперь виден всем`);
    }

    async function deleteActive() {
        const ref = activeRef;
        const name = ref.slice(2);
        if (!name || !window.confirm(`Удалить шаблон «${name}»?`)) return;
        if (ref.indexOf('m:') === 0) {
            delete saved[name];
        } else if (ref.indexOf('s:') === 0) {
            const ok = await writeShared(layouts => { delete layouts[name]; });
            if (!ok) {
                toast('Не удалось изменить общий файл. Подключите папку приложения.', 'error');
                return;
            }
        } else {
            return;
        }
        activeRef = '';
        persistState();
        renderTemplates();
        toast(`Шаблон «${name}» удалён`);
    }

    function moveCol(key, delta) {
        const list = layout.cols;
        const i = list.indexOf(key);
        const j = i + delta;
        if (i === -1 || j < 0 || j >= list.length) return;
        list.splice(j, 0, list.splice(i, 1)[0]);
        changed({ panel: true });
    }

    function isoToRu(value) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
        return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
    }

    function bind(root) {
        root.addEventListener('click', (event) => {
            const t = event.target;
            const period = t.closest('[data-period]');
            if (period) {
                layout.period = period.dataset.period;
                if (layout.period === 'past30' || layout.period === 'all') layout.status.flew = true;
                changed({ toolbar: true });
                return;
            }
            const sortTh = t.closest('th[data-sort]');
            if (sortTh) {
                const key = sortTh.dataset.sort;
                if (layout.sort.key === key) layout.sort.dir = layout.sort.dir === 'asc' ? 'desc' : 'asc';
                else layout.sort = { key, dir: 'asc' };
                changed({ keepTemplate: true });
                return;
            }
            if (t.dataset.move) { moveCol(t.dataset.key, parseInt(t.dataset.move, 10)); return; }
            if (t.dataset.remove) {
                layout.cols = layout.cols.filter(k => k !== t.dataset.remove);
                changed({ panel: true });
                return;
            }
            if (t.dataset.condRemove != null) {
                layout.conds.splice(parseInt(t.dataset.condRemove, 10), 1);
                changed({ panel: true });
                return;
            }
            if (t.id === 'cr-add-cond') {
                const first = layout.cols.find(k => { const f = FIELD_BY_KEY[k]; return f && f.type !== 'text' && fieldAllowed(k); }) || 'sold';
                layout.conds.push({ field: first, op: 'gt', value: '' });
                changed({ panel: true });
                return;
            }
            if (t.id === 'cr-panel-toggle') {
                panelOpen = !panelOpen;
                renderPanel();
                return;
            }
            if (t.id === 'cr-save') { saveMine(false); return; }
            if (t.id === 'cr-save-as') { saveMine(true); return; }
            if (t.id === 'cr-share') { shareCurrent(); return; }
            if (t.id === 'cr-delete') { deleteActive(); return; }
            if (t.id === 'cr-export') { exportExcel(); return; }
            if (t.id === 'cr-reset') {
                layout = defaultLayout();
                activeRef = 'b:Загрузка и экономика';
                persistState();
                renderAll();
            }
        });

        root.addEventListener('change', (event) => {
            const t = event.target;
            if (t.id === 'cr-template') { if (t.value) applyTemplate(t.value); return; }
            if (t.dataset.field) {
                const key = t.dataset.field;
                if (t.checked && layout.cols.indexOf(key) === -1) layout.cols.push(key);
                if (!t.checked) layout.cols = layout.cols.filter(k => k !== key);
                changed({ panel: true });
                return;
            }
            if (t.dataset.status) {
                layout.status[t.dataset.status] = t.checked;
                changed();
                return;
            }
            if (t.id === 'cr-route-type') { layout.routeType = t.value; changed(); return; }
            if (t.id === 'cr-group') {
                layout.groupBy = t.value;
                if (t.value && layout.cols.indexOf(t.value) === -1) layout.cols.unshift(t.value);
                layout.sort = { key: t.value || '', dir: 'asc' };
                changed({ panel: true });
                return;
            }
            if (t.id === 'cr-totals') { layout.totals = t.checked; changed({ keepTemplate: true }); return; }
            if (t.id === 'cr-from' || t.id === 'cr-to') {
                const b = periodBounds();
                const fmt = (d) => (d && typeof formatDateRu === 'function' ? formatDateRu(d) : '');
                if (layout.period !== 'custom') {
                    layout.from = fmt(b.from);
                    layout.to = fmt(b.to);
                    layout.period = 'custom';
                }
                const ru = isoToRu(t.value);
                if (t.id === 'cr-from') layout.from = ru;
                else layout.to = ru;
                changed({ toolbar: true });
                return;
            }
            const cond = t.closest('.cr-cond');
            if (cond && t.dataset.cond) {
                const item = layout.conds[parseInt(cond.dataset.index, 10)];
                if (!item) return;
                item[t.dataset.cond] = t.value;
                changed({ panel: t.dataset.cond !== 'value' });
            }
        });

        let searchTimer = null;
        root.addEventListener('input', (event) => {
            const t = event.target;
            if (t.id === 'cr-search') {
                clearTimeout(searchTimer);
                searchTimer = setTimeout(() => {
                    layout.search = t.value || '';
                    changed();
                }, 200);
                return;
            }
            if (t.id === 'cr-field-search') {
                fieldSearch = t.value || '';
                const pos = t.selectionStart;
                renderPanel();
                const again = document.getElementById('cr-field-search');
                if (again) {
                    again.focus();
                    try { again.setSelectionRange(pos, pos); } catch (e) { /* ignore */ }
                }
            }
        });

        let dragKey = '';
        root.addEventListener('dragstart', (event) => {
            const li = event.target.closest && event.target.closest('.cr-chosen');
            if (!li) return;
            dragKey = li.dataset.key;
            li.classList.add('cr-dragging');
            try { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', dragKey); } catch (e) { /* ignore */ }
        });
        root.addEventListener('dragover', (event) => {
            if (!dragKey) return;
            const li = event.target.closest && event.target.closest('.cr-chosen');
            if (!li) return;
            event.preventDefault();
        });
        root.addEventListener('drop', (event) => {
            if (!dragKey) return;
            const li = event.target.closest && event.target.closest('.cr-chosen');
            if (!li) return;
            event.preventDefault();
            const target = li.dataset.key;
            const list = layout.cols;
            const from = list.indexOf(dragKey);
            const to = list.indexOf(target);
            dragKey = '';
            if (from === -1 || to === -1 || from === to) return;
            list.splice(to, 0, list.splice(from, 1)[0]);
            changed({ panel: true });
        });
        root.addEventListener('dragend', () => { dragKey = ''; });
        root.addEventListener('toggle', (event) => {
            const d = event.target;
            if (!d || !d.dataset || !d.dataset.group || fieldSearch.trim()) return;
            if (d.open) collapsed.delete(d.dataset.group);
            else collapsed.add(d.dataset.group);
        }, true);
    }

    // ---------- Excel ----------

    async function exportExcel() {
        if (!hasPerm('export_excel')) {
            toast('Экспорт недоступен для вашего профиля', 'error');
            return;
        }
        const result = buildResult();
        if (!result.cols.length || !result.rows.length) {
            toast('В таблице нечего выгружать', 'error');
            return;
        }
        const folder = typeof excelPrepareFolder === 'function' ? await excelPrepareFolder('creative') : null;
        const styled = typeof loadStyledXlsx === 'function' ? await loadStyledXlsx() : null;
        const lib = styled || (typeof XLSX !== 'undefined' ? XLSX : null);
        if (!lib) {
            toast('Библиотека Excel не загружена', 'error');
            return;
        }
        const cols = headerCols(result);
        const cellOut = (key, v) => {
            const f = FIELD_BY_KEY[key];
            if (v == null || v === '') return '';
            if (key === '__count' || (f && f.type !== 'text' && f.type !== 'date')) return v;
            return String(v);
        };
        const aoa = [cols.map(colLabel)];
        if (layout.totals) aoa.push(cols.map((key, i) => { const v = result.totals[key]; return i === 0 && (v == null || v === '') ? 'Итого' : cellOut(key, v); }));
        result.rows.forEach(r => aoa.push(cols.map(key => cellOut(key, r.values[key]))));
        const safe = aoa.map(row => (typeof excelSafeRow === 'function' ? excelSafeRow(row) : row));
        const ws = lib.utils.aoa_to_sheet(safe);
        ws['!cols'] = cols.map(key => ({ wch: Math.max(10, Math.min(40, colLabel(key).length + 2)) }));
        ws['!views'] = [{ state: 'frozen', ySplit: layout.totals ? 2 : 1, topLeftCell: layout.totals ? 'A3' : 'A2', activePane: 'bottomLeft' }];
        if (styled && ws['!ref']) {
            const range = lib.utils.decode_range(ws['!ref']);
            for (let c = 0; c <= range.e.c; c++) {
                const addr = lib.utils.encode_cell({ r: 0, c });
                if (ws[addr]) ws[addr].s = { fill: { patternType: 'solid', fgColor: { rgb: '012A4A' } }, font: { bold: true, color: { rgb: 'FFFFFF' } }, alignment: { horizontal: 'center', vertical: 'center', wrapText: true } };
                if (layout.totals) {
                    const t = lib.utils.encode_cell({ r: 1, c });
                    if (ws[t]) ws[t].s = { fill: { patternType: 'solid', fgColor: { rgb: 'E2E8F0' } }, font: { bold: true } };
                }
            }
        }
        const wb = lib.utils.book_new();
        lib.utils.book_append_sheet(wb, ws, 'Творческая');
        const now = new Date();
        const stamp = `${typeof formatDateRu === 'function' ? formatDateRu(now) : ''} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        const filename = typeof excelDailyFilename === 'function'
            ? excelDailyFilename('КРАСАВИА_творческая', stamp)
            : `КРАСАВИА_творческая_${stamp.slice(0, 10).replace(/\./g, '-')}.xlsx`;
        try {
            const savedFile = typeof excelSaveWorkbook === 'function'
                ? await excelSaveWorkbook(lib, wb, filename, folder)
                : (lib.writeFile(wb, filename), { where: 'download' });
            if (typeof ActivityLog !== 'undefined') ActivityLog.log('export', 'Творческая');
            const msg = `Файл готов: ${result.rows.length} строк`;
            if (typeof excelAnnounceSaved === 'function') excelAnnounceSaved(savedFile, msg);
            else toast(msg);
        } catch (e) {
            console.error(e);
            toast('Ошибка выгрузки', 'error');
        }
    }

    // ---------- вход ----------

    function create(panel) {
        loadState();
        panel.innerHTML = `
            <div class="cr-page table-page" id="cr-page">
                <div class="table-page-hero">
                    <div class="table-page-hero-main">
                        <h2 class="rms-hero-title">Творческая</h2>
                        <span class="table-page-hint">Своя таблица из данных всех вкладок: выберите столбцы, период, условия и группировку</span>
                    </div>
                </div>
                <div class="table-page-body">
                    <div class="table-controls-wrap">
                        <div class="table-controls-bar cr-controls">
                            <button type="button" id="cr-panel-toggle" class="filter-btn filter-btn-active">Настройка</button>
                            <span class="cr-label">Шаблон</span>
                            <select id="cr-template" class="cr-input cr-template"></select>
                            <button type="button" id="cr-save" class="filter-btn">Сохранить</button>
                            <button type="button" id="cr-save-as" class="filter-btn">Сохранить как…</button>
                            <button type="button" id="cr-share" class="filter-btn" title="Записать шаблон в общую папку — увидят все">Сделать общим</button>
                            <button type="button" id="cr-delete" class="filter-btn">Удалить</button>
                            <button type="button" id="cr-reset" class="filter-btn" title="Вернуть готовый шаблон «Загрузка и экономика»">Сброс</button>
                            <span class="table-controls-spacer"></span>
                            <button type="button" id="cr-export" class="filter-btn">В Excel</button>
                        </div>
                        <div id="cr-filters" class="cr-filters"></div>
                    </div>
                    <div class="cr-layout">
                        <aside id="cr-panel" class="cr-panel" aria-label="Настройка таблицы"></aside>
                        <div id="cr-grid" class="table-wrapper cr-grid" data-zoom-target="creative"></div>
                    </div>
                </div>
            </div>
        `;
        host = panel.querySelector('#cr-page');
        bind(host);
        renderAll();
        if (typeof applyViewZoom === 'function') applyViewZoom('creative');
        loadShared().then(() => {
            if (activeRef.indexOf('s:') === 0 && !shared[activeRef.slice(2)]) activeRef = '';
            renderTemplates();
        });
    }

    function refresh() {
        if (!document.getElementById('cr-page')) return;
        if (loadedFor !== profileId()) {
            onProfileChange();
            return;
        }
        if (built.sig === dataSignature() && document.querySelector('#cr-grid table')) return;
        renderToolbar();
        renderTable();
    }

    function onProfileChange() {
        if (!document.getElementById('cr-page')) return;
        loadState();
        built = { sig: '', result: null };
        renderAll();
    }

    return {
        create,
        refresh,
        onProfileChange,
        FIELDS,
        GROUPS,
        BUILTIN,
        _buildResult: () => buildResult(),
        _setLayout: (next) => { layout = normalizeLayout(next); built = { sig: '', result: null }; }
    };
})();

function createCreativeView(panel) {
    CreativeView.create(panel);
}
