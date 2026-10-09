// Календарь событий: праздники, школьные каникулы и свои события (концерт, форум, отмена рейсов…).
// • Встроены нерабочие праздничные дни РФ 2025–2027 (по постановлениям о переносе выходных) и школьные
//   каникулы по рекомендациям Минпросвещения (регион может сдвигать — даты правятся в «Справочнике»).
// • Свои события и правки встроенных — в shared/calendar.json, общие для всех; правка по записи (at),
//   удалённое помечается deleted и не «воскресает» с другого ПК.
// • Норма продаж (sales-report.js → collectSameWeekdayCohort) не смешивает особые даты с обычными:
//   для обычного вылета праздничные вылеты исключаются, для праздничного — берутся такие же праздничные.
window.CalendarEvents = (function () {
    const FILE = 'calendar.json';
    const TYPES = {
        holiday: { label: 'Праздник', short: 'праздник' },
        school: { label: 'Школьные каникулы', short: 'каникулы' },
        event: { label: 'Событие', short: 'событие' }
    };

    // id встроенных записей постоянные: по ним хранятся правки и удаления.
    const BUILTIN = [
        // 2025
        ['h2025-ny', '01.01.2025', '08.01.2025', 'holiday', 'Новогодние каникулы'],
        ['h2025-feb', '22.02.2025', '23.02.2025', 'holiday', 'День защитника Отечества'],
        ['h2025-mar', '08.03.2025', '09.03.2025', 'holiday', 'Международный женский день'],
        ['h2025-may1', '01.05.2025', '04.05.2025', 'holiday', 'Праздник Весны и Труда'],
        ['h2025-may9', '09.05.2025', '11.05.2025', 'holiday', 'День Победы'],
        ['h2025-jun', '12.06.2025', '12.06.2025', 'holiday', 'День России'],
        ['h2025-nov', '01.11.2025', '04.11.2025', 'holiday', 'День народного единства'],
        ['h2025-dec31', '31.12.2025', '31.12.2025', 'holiday', 'Новогодние каникулы'],
        // 2026
        ['h2026-ny', '01.01.2026', '11.01.2026', 'holiday', 'Новогодние каникулы'],
        ['h2026-feb', '21.02.2026', '23.02.2026', 'holiday', 'День защитника Отечества'],
        ['h2026-mar', '07.03.2026', '09.03.2026', 'holiday', 'Международный женский день'],
        ['h2026-may1', '01.05.2026', '03.05.2026', 'holiday', 'Праздник Весны и Труда'],
        ['h2026-may9', '09.05.2026', '11.05.2026', 'holiday', 'День Победы'],
        ['h2026-jun', '12.06.2026', '14.06.2026', 'holiday', 'День России'],
        ['h2026-nov', '04.11.2026', '04.11.2026', 'holiday', 'День народного единства'],
        ['h2026-dec31', '31.12.2026', '31.12.2026', 'holiday', 'Новогодние каникулы'],
        // 2027
        ['h2027-ny', '01.01.2027', '10.01.2027', 'holiday', 'Новогодние каникулы'],
        ['h2027-feb', '21.02.2027', '23.02.2027', 'holiday', 'День защитника Отечества'],
        ['h2027-mar', '06.03.2027', '08.03.2027', 'holiday', 'Международный женский день'],
        ['h2027-may1', '01.05.2027', '03.05.2027', 'holiday', 'Праздник Весны и Труда'],
        ['h2027-may9', '08.05.2027', '10.05.2027', 'holiday', 'День Победы'],
        ['h2027-jun', '12.06.2027', '14.06.2027', 'holiday', 'День России'],
        ['h2027-nov', '04.11.2027', '07.11.2027', 'holiday', 'День народного единства'],
        ['h2027-dec31', '31.12.2027', '31.12.2027', 'holiday', 'Новогодние каникулы'],
        // Школьные каникулы (рекомендации Минпросвещения, четверти)
        ['s2025-summer', '27.05.2025', '31.08.2025', 'school', 'Летние каникулы'],
        ['s2025-autumn', '25.10.2025', '04.11.2025', 'school', 'Осенние каникулы'],
        ['s2026-winter', '31.12.2025', '11.01.2026', 'school', 'Зимние каникулы'],
        ['s2026-spring', '28.03.2026', '05.04.2026', 'school', 'Весенние каникулы'],
        ['s2026-summer', '27.05.2026', '31.08.2026', 'school', 'Летние каникулы'],
        ['s2026-autumn', '26.10.2026', '04.11.2026', 'school', 'Осенние каникулы'],
        ['s2027-winter', '31.12.2026', '10.01.2027', 'school', 'Зимние каникулы'],
        ['s2027-spring', '27.03.2027', '04.04.2027', 'school', 'Весенние каникулы'],
        ['s2027-summer', '27.05.2027', '31.08.2027', 'school', 'Летние каникулы']
    ].map(([id, from, to, type, name]) => ({
        id, from, to, type, name, builtin: true,
        // Лето — это сезон (его уже учитывает норма по соседним неделям), а не «особые дни».
        norm: !(type === 'school' && /Летние/.test(name))
    }));

    let custom = {};      // id → { from, to, type, name, norm, deleted, at, by }
    let loaded = false;
    let rev = 0;
    let memo = { rev: -1, list: [], byDay: new Map() };

    function profileName() {
        const p = typeof ProfileAuth !== 'undefined' && ProfileAuth.getCurrentProfile ? ProfileAuth.getCurrentProfile() : null;
        return p ? String(p.name || p.id || '') : '';
    }

    function canEdit() {
        return typeof ProfileAuth !== 'undefined' && ProfileAuth.hasPermission('edit_calendar');
    }

    function ts(dateStr) {
        if (typeof PerfCache !== 'undefined' && PerfCache.dateTsMemo) return PerfCache.dateTsMemo(dateStr);
        const d = typeof parseLocalDate === 'function' ? parseLocalDate(dateStr) : null;
        return d ? d.getTime() : null;
    }

    function normEntry(e) {
        if (!e || typeof e !== 'object') return null;
        if (e.deleted) return { deleted: true, at: String(e.at || ''), by: String(e.by || '') };
        const from = String(e.from || '').trim();
        const to = String(e.to || from).trim();
        if (ts(from) == null || ts(to) == null) return null;
        const type = TYPES[e.type] ? e.type : 'event';
        return {
            from: ts(from) <= ts(to) ? from : to,
            to: ts(from) <= ts(to) ? to : from,
            type,
            name: String(e.name || TYPES[type].label).slice(0, 120),
            norm: e.norm !== false,
            at: String(e.at || ''),
            by: String(e.by || '')
        };
    }

    // Все действующие события: встроенные (с правками) + свои, без удалённых.
    function list() {
        if (memo.rev === rev) return memo.list;
        const out = [];
        BUILTIN.forEach(b => {
            const own = custom[b.id];
            if (own && own.deleted) return;
            out.push(own ? { ...b, ...own, id: b.id, builtin: true, edited: true } : b);
        });
        Object.keys(custom).forEach(id => {
            if (BUILTIN.some(b => b.id === id)) return;
            const e = custom[id];
            if (!e || e.deleted) return;
            out.push({ ...e, id, builtin: false });
        });
        out.sort((a, b) => ts(a.from) - ts(b.from) || ts(a.to) - ts(b.to));
        memo = { rev, list: out, byDay: new Map() };
        return out;
    }

    // События на дату: [{ id, type, name, norm }].
    function on(dateStr) {
        const t = ts(dateStr);
        if (t == null) return [];
        list();
        if (memo.byDay.has(t)) return memo.byDay.get(t);
        const hit = memo.list.filter(e => ts(e.from) <= t && t <= ts(e.to));
        memo.byDay.set(t, hit);
        return hit;
    }

    // Ключ «особости» даты для нормы: '' — обычный день, иначе тип (праздник важнее каникул).
    function normKey(dateStr) {
        const ev = on(dateStr).filter(e => e.norm);
        if (!ev.length) return '';
        if (ev.some(e => e.type === 'holiday')) return 'holiday';
        if (ev.some(e => e.type === 'school')) return 'school';
        return 'event';
    }

    // Подпись для карточки, полосы дней, Графплана.
    function label(dateStr) {
        const ev = on(dateStr);
        if (!ev.length) return '';
        return ev.map(e => e.name).filter((v, i, a) => a.indexOf(v) === i).join(', ');
    }

    // Когорта вылетов для нормы: особые даты не смешиваются с обычными.
    // Обычный вылет — без праздничных/каникулярных; особый — такие же особые, а если их мало — обычные.
    function filterCohort(cohort, flyDateStr) {
        if (!Array.isArray(cohort) || cohort.length < 2) return cohort;
        const key = normKey(flyDateStr);
        const same = cohort.filter(c => normKey(c.date) === key);
        if (key && same.length >= 2) return same;
        if (key) return cohort.filter(c => !normKey(c.date)).length >= 2 ? cohort.filter(c => !normKey(c.date)) : cohort;
        return same.length >= 2 ? same : cohort;
    }

    // ---------- общий файл ----------

    function mergeInto(target, remote) {
        Object.keys(remote || {}).forEach(id => {
            const e = normEntry(remote[id]);
            if (!e) return;
            if (!target[id] || String(e.at) >= String(target[id].at || '')) target[id] = e;
        });
        return target;
    }

    async function load() {
        if (typeof SharedStorage === 'undefined') return;
        const r = await SharedStorage.readJsonFileStrict(FILE).catch(() => ({ ok: false }));
        if (!r.ok) return;
        custom = mergeInto({}, r.data && r.data.events);
        loaded = true;
        rev++;
    }

    // Изменение: перечитать файл, слить, записать (как справочник субсидий).
    async function apply(id, entry) {
        if (!canEdit()) return { ok: false, error: 'Нет права менять календарь' };
        if (typeof SharedStorage === 'undefined') return { ok: false, error: 'Общая папка не подключена' };
        const r = await SharedStorage.readJsonFileStrict(FILE).catch(() => ({ ok: false }));
        if (!r.ok) return { ok: false, error: 'Не удалось прочитать calendar.json — изменения не сохранены' };
        const merged = mergeInto({}, r.data && r.data.events);
        merged[id] = { ...entry, at: new Date().toISOString(), by: profileName() };
        const okWrite = await SharedStorage.writeJsonFile(FILE, { version: 1, updatedAt: new Date().toISOString(), events: merged });
        if (!okWrite) return { ok: false, error: 'Не удалось записать calendar.json' };
        custom = mergeInto({}, merged);
        loaded = true;
        rev++;
        if (typeof invalidateMetricsCache === 'function') invalidateMetricsCache();
        return { ok: true };
    }

    function save(entry, id) {
        const e = normEntry(entry);
        if (!e || e.deleted) return Promise.resolve({ ok: false, error: 'Укажите даты события' });
        if (!String(entry.name || '').trim()) return Promise.resolve({ ok: false, error: 'Укажите название' });
        const newId = id || ('c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
        return apply(newId, e);
    }

    function remove(id) {
        return apply(id, { deleted: true });
    }

    // Вернуть встроенную запись к исходным датам (убрать правку).
    function restore(id) {
        if (!BUILTIN.some(b => b.id === id)) return Promise.resolve({ ok: false, error: 'Это не встроенная запись' });
        const b = BUILTIN.find(x => x.id === id);
        return apply(id, { from: b.from, to: b.to, type: b.type, name: b.name, norm: b.norm });
    }

    function deletedBuiltins() {
        return BUILTIN.filter(b => custom[b.id] && custom[b.id].deleted);
    }

    return { TYPES, list, on, label, normKey, filterCohort, load, save, remove, restore, deletedBuiltins, canEdit, isLoaded: () => loaded, revision: () => rev };
})();
