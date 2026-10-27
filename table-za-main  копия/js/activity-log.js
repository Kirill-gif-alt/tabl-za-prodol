// Журнал действий пользователей (локально + shared/activity.json)
window.ActivityLog = (function () {
    const LOCAL_KEY = 'krasavia_activity_v1';
    const MAX_EVENTS = 2000;   // как в общем файле (shared-storage.js)
    const MAX_TAB_EVENTS = 300;   // смены вкладок хранятся только здесь и не вытесняют остальные записи

    const ACTION_LABELS = {
        login: 'Вход',
        import: 'Импорт истории продаж',
        logout: 'Выход',
        tab: 'Переход по вкладке',
        flight: 'Просмотр рейса',
        data_load: 'Загрузка данных',
        data_restore: 'Восстановление данных',
        data_share: 'Публикация данных',
        data_share_blocked: 'Публикация остановлена (подозрительные данные)',
        history_restore: 'Восстановление из резервной копии',
        sales_mark: 'Отметка «Управления продажами»',
        export: 'Выгрузка',
        fare_refs: 'Справочник тарифов',
        costs_upload: 'Загрузка расходов',
        password_self: 'Смена своего пароля',
        password_admin: 'Смена пароля (админ)',
        profile_create: 'Создание профиля',
        profile_delete: 'Удаление профиля',
        profile_save: 'Сохранение профилей'
    };

    // Цветовая группа значка действия (сами цвета — в css/ux-journal.css, классы jr-t-*).
    const ACTION_TONE = {
        login: 'in', logout: 'out', tab: 'tab', flight: 'view', export: 'export',
        data_load: 'load', import: 'load', costs_upload: 'load',
        data_restore: 'restore', history_restore: 'restore', data_share: 'share',
        sales_mark: 'edit', fare_refs: 'edit', profile_save: 'edit', password_self: 'edit', password_admin: 'edit',
        profile_create: 'create', profile_delete: 'danger', data_share_blocked: 'danger'
    };

    const PERIOD_TEXT = { 1: 'сегодня', 7: '7 дней', 30: '30 дней', 0: 'всё время' };
    const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
    const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
    const BATCH = 250;         // строк за раз: дальше — кнопка «Показать ещё»
    const LONG_DETAIL = 70;    // с такой длины текст деталей может не влезть в 2 строки

    const TAB_LABELS = {
        today: 'Сегодня',
        home: 'Сеть',
        main: 'Графический план',
        table: 'Динамика продаж',
        pkz: 'ПКЗ',
        pair: 'Экономическая таблица',
        costs: 'Расчёт расходов',
        data: 'Загрузка рейсов',
        rms: 'RMS',
        sales: 'Управление продажами',
        creative: 'Творческая',
        reports: 'Отчёты',
        lowreq: 'Запрос на понижение',
        stats: 'Журнал действий'
    };

    let cache = null;
    let persistQueue = Promise.resolve();
    let syncStarted = false;
    let syncIntervalId = null;
    let lastPushedHeadId = '';
    let persistTimer = null;

    function escHtml(s) {
        if (typeof Security !== 'undefined') return Security.escapeHtml(s);
        return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    let tsFormat = null;
    function formatTs(iso) {
        if (!iso) return '—';
        try {
            if (!tsFormat) {
                tsFormat = new Intl.DateTimeFormat('ru-RU', {
                    day: '2-digit', month: '2-digit', year: 'numeric',
                    hour: '2-digit', minute: '2-digit', second: '2-digit'
                });
            }
            return tsFormat.format(new Date(iso));
        } catch {
            return iso;
        }
    }

    // Список от новых к старым: не больше MAX_EVENTS записей, из них смен вкладок не больше MAX_TAB_EVENTS.
    function trimEvents(list) {
        let tabs = 0;
        const out = [];
        for (const e of list) {
            if (e.action === 'tab' && ++tabs > MAX_TAB_EVENTS) continue;
            out.push(e);
            if (out.length >= MAX_EVENTS) break;
        }
        return out;
    }

    function mergeEvents(a, b) {
        const map = new Map();
        [...(a || []), ...(b || [])].forEach(e => {
            if (e?.id) map.set(e.id, e);
        });
        return trimEvents([...map.values()]
            .map(e => ({ e, t: new Date(e.ts).getTime() }))
            .sort((x, y) => y.t - x.t)
            .map(x => x.e));
    }

    // Несколько вызовов подряд при старте ждут одну загрузку, а не качают файл каждый раз.
    let loadingAll = null;

    function loadAll(force) {
        if (cache && !force) return Promise.resolve(cache);
        if (loadingAll) return loadingAll;
        loadingAll = loadAllNow().finally(() => { loadingAll = null; });
        return loadingAll;
    }

    async function loadAllNow() {

        let local = [];
        try {
            const raw = localStorage.getItem(LOCAL_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                local = Array.isArray(parsed) ? parsed : (parsed.events || []);
            }
        } catch { /* ignore */ }

        let shared = [];
        if (typeof SharedStorage !== 'undefined') {
            try {
                shared = await SharedStorage.loadActivity() || [];
                if (typeof SalesSync !== 'undefined') {
                    const dataDir = SalesSync.getDataRootHandle?.() || await SalesSync.restoreDataFolderHandle?.();
                    if (dataDir && SharedStorage.loadActivityFromDataRoot) {
                        const extra = await SharedStorage.loadActivityFromDataRoot(dataDir);
                        shared = mergeEvents(shared, extra);
                    }
                }
            } catch (e) { console.warn('ActivityLog.loadAll', e); }
        }

        // Пока ждали сеть, log() мог дописать событие в cache — сохраняем и его.
        const before = cache;
        cache = mergeEvents(cache || [], mergeEvents(local, shared));
        const same = before && before.length === cache.length && (!cache.length || (before[0].id === cache[0].id && before[before.length - 1].id === cache[cache.length - 1].id));
        if (!same) {
            try {
                localStorage.setItem(LOCAL_KEY, JSON.stringify(cache));
            } catch { /* ignore */ }
        }
        return cache;
    }

    // Запись в общий файл идёт по одной: повтор с тем же последним событием ждёт текущую,
    // а с новым событием встаёт в очередь за ней.
    let pushing = null;
    let pushingHead = '';

    function pushToShared() {
        const head = cache && cache[0] ? (cache[0].id || '') : '';
        if (pushing && pushingHead === head) return pushing;
        const prev = pushing || Promise.resolve();
        const job = prev.catch(() => false).then(() => pushToSharedNow());
        pushing = job;
        pushingHead = head;
        job.finally(() => { if (pushing === job) pushing = null; }).catch(() => {});
        return job;
    }

    async function pushToSharedNow() {
        if (!cache || typeof SharedStorage === 'undefined') return false;
        const headId = cache[0]?.id || '';
        if (headId && headId === lastPushedHeadId) return true;
        let ok = false;
        await SharedStorage.restoreRootHandle();
        if (SharedStorage.isLinked()) {
            ok = await SharedStorage.saveActivity(cache.filter(e => e.action !== 'tab')) || ok;
        }
        if (typeof SalesSync !== 'undefined' && SharedStorage.saveActivityToDataRoot) {
            const dataDir = SalesSync.getDataRootHandle?.() || await SalesSync.restoreDataFolderHandle?.();
            if (dataDir) ok = await SharedStorage.saveActivityToDataRoot(dataDir, cache.filter(e => e.action !== 'tab')) || ok;
        }
        if (ok) lastPushedHeadId = headId;
        return ok;
    }

    function queuePersist(forceShared) {
        persistQueue = persistQueue.then(async () => {
            if (!cache) return;
            try {
                localStorage.setItem(LOCAL_KEY, JSON.stringify(cache));
            } catch { /* ignore */ }
            const heavy = forceShared || (cache[0] && !['tab', 'flight'].includes(cache[0].action));
            if (heavy) await pushToShared();
        }).catch(() => { /* тихая синхронизация */ });
        return persistQueue;
    }

    async function syncWithShared() {
        await loadAll(true);
        await pushToShared();
    }

    async function tryEnsureSharedWrite(fromUserGesture) {
        if (typeof SharedStorage === 'undefined') return;
        await SharedStorage.restoreRootHandle();
        if (SharedStorage.isLinked()) {
            await syncWithShared();
            return;
        }
        if (!fromUserGesture) return;
        if (typeof SalesSync !== 'undefined') {
            await SalesSync.restoreDataFolderHandle?.();
        }
        await syncWithShared();
    }

    function startBackgroundSync() {
        if (syncStarted) return;
        syncStarted = true;

        syncWithShared();

        if (!syncIntervalId) {
            syncIntervalId = setInterval(() => syncWithShared(), 180000);
        }

        if (!window._activityUnloadBound) {
            window._activityUnloadBound = true;
            window.addEventListener('beforeunload', () => {
                try {
                    if (cache) localStorage.setItem(LOCAL_KEY, JSON.stringify(cache));
                } catch { /* ignore */ }
            });
        }

        if (!window._activityGestureBound) {
            window._activityGestureBound = true;
            const onGesture = () => {
                document.removeEventListener('pointerdown', onGesture, true);
                document.removeEventListener('keydown', onGesture, true);
                tryEnsureSharedWrite(true);
            };
            document.addEventListener('pointerdown', onGesture, { once: true, capture: true });
            document.addEventListener('keydown', onGesture, { once: true, capture: true });
        }
    }

    function log(action, detail, meta) {
        const profile = typeof ProfileAuth !== 'undefined' ? ProfileAuth.getCurrentProfile() : null;
        if (!profile) return Promise.resolve();

        const entry = {
            id: `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            ts: new Date().toISOString(),
            profileId: profile.id,
            profileName: profile.name,
            action,
            detail: String(detail || '').slice(0, 240),
            meta: meta || null
        };

        const apply = () => {
            if (!cache) cache = [];
            cache.unshift(entry);
            if (cache.length > MAX_EVENTS) cache = trimEvents(cache);
            if (action === 'tab' || action === 'flight') {
                if (persistTimer) clearTimeout(persistTimer);
                persistTimer = setTimeout(() => queuePersist(false), 1500);
                return Promise.resolve();
            }
            return queuePersist(true);
        };
        if (cache) return apply();
        return loadAll().then(apply);
    }

    function formatDetail(event) {
        const label = actionLabel(event.action);
        let text = event.detail || '';
        if (event.action === 'tab' && !text && event.meta?.tab) {
            text = TAB_LABELS[event.meta.tab] || event.meta.tab;
        }
        if (event.meta?.date && event.action === 'flight') {
            text = text ? `${text} · ${event.meta.date}` : event.meta.date;
        }
        if (event.meta?.mode && event.action === 'flight') {
            const modeLabel = event.meta.mode === 'pair' ? 'экономическая' : 'таблица';
            text = text ? `${text} (${modeLabel})` : modeLabel;
        }
        return text || label;
    }

    // Имя пользователя: берём самое свежее из записей (список идёт от новых к старым).
    function getUniqueProfiles(events) {
        const map = new Map();
        events.forEach(e => {
            if (e.profileId && !map.has(e.profileId)) map.set(e.profileId, e.profileName || e.profileId);
        });
        return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1], 'ru'));
    }

    // ---------- отбор записей ----------

    // Период — календарные дни, как «7 дней» на других вкладках: сегодня и ещё N−1 прошлых, с полуночи.
    // Не «последние N×24 часа»: иначе первый день окна обрезан по времени и не совпадает с подписью дня в списке.
    function periodStart(days) {
        if (!(days > 0)) return 0;
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        d.setDate(d.getDate() - (days - 1));
        return d.getTime();
    }

    // Строка для поиска считается один раз на запись (записи живут в кэше, а поиск набирается по буквам).
    const hayCache = new WeakMap();
    function hayOf(e) {
        let h = hayCache.get(e);
        if (h === undefined) {
            h = [
                e.profileName, e.profileId, e.detail,
                ACTION_LABELS[e.action], formatDetail(e),
                e.meta ? JSON.stringify(e.meta) : ''
            ].join(' ').toLowerCase();
            hayCache.set(e, h);
        }
        return h;
    }

    // Один проход по журналу: подходящие записи + числа для подписей.
    //   inPeriod — сколько записей за выбранный период (до остальных фильтров);
    //   byUser/noUser — числа у имён: период, действие и поиск, но без выбора человека (чтобы остальные не обнулялись).
    function analyze(events, filters) {
        const { profileId, action, days, query } = filters;
        const from = periodStart(days);
        const q = (query || '').toLowerCase();
        const filtered = [];
        const times = [];
        const byUser = Object.create(null);
        let inPeriod = 0;
        let noUser = 0;
        for (const e of events) {
            const t = new Date(e.ts).getTime();
            if (from && t < from) continue;
            inPeriod++;
            if (action === '!tab' ? e.action === 'tab' : (action && e.action !== action)) continue;
            if (q && !hayOf(e).includes(q)) continue;
            noUser++;
            byUser[e.profileId] = (byUser[e.profileId] || 0) + 1;
            if (profileId && e.profileId !== profileId) continue;
            filtered.push(e);
            times.push(t);
        }
        return { filtered, times, byUser, noUser, inPeriod };
    }

    // ---------- подписи ----------

    function actionLabel(action) {
        return ACTION_LABELS[action] || 'Другое действие';
    }

    function initialOf(name) {
        const ch = Array.from(String(name || '').trim())[0];
        return ch ? ch.toUpperCase() : '?';
    }

    function timeText(t) {
        if (t !== t) return '—';
        const d = new Date(t);
        return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }

    function dayKeyOf(t) {
        if (t !== t) return 0;
        const d = new Date(t);
        return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
    }

    // «Сегодня», «Вчера», «25 октября, суббота» (с годом, если он не текущий).
    function dayLabel(t, nowD) {
        if (t !== t) return 'Без даты';
        const d = new Date(t);
        const midnight = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
        const diff = Math.round((midnight(nowD) - midnight(d)) / 86400000);
        if (diff === 0) return 'Сегодня';
        if (diff === 1) return 'Вчера';
        let s = d.getDate() + ' ' + MONTHS_GEN[d.getMonth()];
        if (d.getFullYear() !== nowD.getFullYear()) s += ' ' + d.getFullYear();
        return s + ', ' + WEEKDAYS[d.getDay()];
    }

    function recordsText(n) {
        return n + ' ' + pluralRu(n, 'запись', 'записи', 'записей');
    }

    // ---------- состояние вкладки ----------
    // Живёт на контейнере: фоновое обновление вкладки перерисовывает журнал, но фильтры,
    // раскрытые детали и число выведенных строк при этом не сбрасываются.
    function getView(container) {
        if (!container._jr) {
            container._jr = {
                filters: { profileId: '', action: '!tab', days: 7, query: '' },   // по умолчанию смены вкладок скрыты
                expanded: new Set(),
                limit: BATCH,
                shown: 0,
                list: [], times: [], keys: [], dayCounts: new Map(), lastDay: -1,
                inPeriod: 0, headId: '', resizeTimer: 0, ro: null
            };
        }
        return container._jr;
    }

    // ---------- вёрстка ----------

    function rowHtml(e, t, v) {
        const name = e.profileName || e.profileId || '—';
        const text = formatDetail(e);
        const open = v.expanded.has(e.id);
        const long = text.length >= LONG_DETAIL;
        const tone = ACTION_TONE[e.action] || 'other';
        return `<tr class="jr-row" data-eid="${escHtml(e.id)}">
            <td class="jr-c-time" title="${escHtml(formatTs(e.ts))}">${timeText(t)}</td>
            <td class="jr-c-user"><span class="jr-ava" aria-hidden="true">${escHtml(initialOf(name))}</span><span class="jr-uname">${escHtml(name)}</span></td>
            <td class="jr-c-act"><span class="jr-badge jr-t-${tone}">${escHtml(actionLabel(e.action))}</span></td>
            <td class="jr-c-det${open ? ' has-more' : ''}"><div class="jr-det${open ? ' is-open' : ''}"${long ? ' data-long' : ''}>${escHtml(text)}</div>${long ? `<button type="button" class="jr-more" data-jr-more aria-expanded="${open}">${open ? 'свернуть' : 'ещё'}</button>` : ''}</td>
        </tr>`;
    }

    // Строки [from, to) списка. Каждый день — своя секция (<tbody>) с разделителем и числом записей за день:
    // так разделитель «прилипает» только на время прокрутки своего дня.
    // cont — строки, продолжающие уже выведенный день (при «Показать ещё»), groups — новые секции.
    function rowsHtml(v, from, to) {
        const nowD = new Date();
        let cont = '';
        let groups = '';
        let open = false;
        for (let i = from; i < to; i++) {
            const key = v.keys[i];
            if (key !== v.lastDay) {
                if (open) groups += '</tbody>';
                v.lastDay = key;
                groups += `<tbody class="jr-group"><tr class="jr-day"><td colspan="4"><span class="jr-day-name">${escHtml(dayLabel(v.times[i], nowD))}</span><span class="jr-day-count">${recordsText(v.dayCounts.get(key) || 0)}</span></td></tr>`;
                open = true;
            }
            if (open) groups += rowHtml(v.list[i], v.times[i], v);
            else cont += rowHtml(v.list[i], v.times[i], v);
        }
        if (open) groups += '</tbody>';
        return { cont, groups };
    }

    function shellHtml() {
        const periodOpts = [[1, 'Сегодня'], [7, '7 дней'], [30, '30 дней'], [0, 'Всё время']]
            .map(([d, l]) => `<option value="${d}">${l}</option>`).join('');
        const actionOpts = Object.entries(ACTION_LABELS)
            .map(([k, l]) => `<option value="${escHtml(k)}">${escHtml(l)}</option>`).join('');
        return `
            <div class="stats-page table-page jr-page">
                <div class="table-page-hero stats-hero">
                    <div class="table-page-hero-main">
                        <h2 class="stats-hero-title">Журнал действий</h2>
                    </div>
                    <div class="stats-hero-meta">
                        <span class="stats-total-badge" id="stats-total-badge" aria-live="polite"></span>
                        <button type="button" class="filter-btn stats-refresh-btn" id="stats-refresh-btn">Обновить</button>
                    </div>
                </div>
                <div class="table-page-body">
                    <div class="jr-panel">
                        <div class="jr-filters">
                            <label class="jr-field">
                                <span class="jr-field-label">Период</span>
                                <select id="stats-filter-days" class="jr-select">${periodOpts}</select>
                            </label>
                            <label class="jr-field">
                                <span class="jr-field-label">Действие</span>
                                <select id="stats-filter-action" class="jr-select jr-select-action">
                                    <option value="">Все действия</option>
                                    <option value="!tab">Все, кроме переходов по вкладкам</option>
                                    ${actionOpts}
                                </select>
                            </label>
                            <label class="jr-field jr-field-search">
                                <span class="jr-field-label">Поиск</span>
                                <input type="text" id="stats-filter-query" class="jr-search" placeholder="Рейс, пользователь…" autocomplete="off">
                            </label>
                        </div>
                        <div class="jr-users" id="jr-users" role="group" aria-label="Пользователи"></div>
                    </div>
                    <div class="jr-list" id="jr-list">
                        <table class="jr-table">
                            <colgroup><col class="jr-col-time"><col class="jr-col-user"><col class="jr-col-act"><col></colgroup>
                            <thead>
                                <tr>
                                    <th>Время</th>
                                    <th>Пользователь</th>
                                    <th>Действие</th>
                                    <th>Детали</th>
                                </tr>
                            </thead>
                        </table>
                        <div class="jr-empty" id="jr-empty" hidden></div>
                        <div class="jr-foot" id="jr-foot" hidden></div>
                    </div>
                </div>
            </div>`;
    }

    function chipsHtml(profiles, res, f) {
        const chips = [`<button type="button" class="jr-chip jr-chip-all${!f.profileId ? ' is-active' : ''}" data-stats-user="" aria-pressed="${!f.profileId}">
                <span class="jr-chip-name">Все</span><span class="jr-chip-n">${res.noUser}</span>
            </button>`];
        profiles.forEach(([id, name]) => {
            const n = res.byUser[id] || 0;
            const active = f.profileId === id;
            chips.push(`<button type="button" class="jr-chip${active ? ' is-active' : ''}${n ? '' : ' is-empty'}" data-stats-user="${escHtml(id)}" aria-pressed="${active}">
                <span class="jr-ava" aria-hidden="true">${escHtml(initialOf(name))}</span><span class="jr-chip-name">${escHtml(name)}</span><span class="jr-chip-n">${n}</span>
            </button>`);
        });
        return chips.join('');
    }

    function updateBadge(container, v) {
        const badge = container.querySelector('#stats-total-badge');
        if (!badge) return;
        const period = PERIOD_TEXT[v.filters.days] || PERIOD_TEXT[0];
        // «Из» — сколько записей подходит под условия (их число совпадает с чипом «Все»), а не всё за период:
        // иначе при скрытых переходах по вкладкам выходит «показано 40 из 120», хотя скрывать больше нечего.
        const n = v.list.length;
        const hidden = v.inPeriod - n;
        badge.textContent = `Показано ${v.shown} из ${n} ${pluralRu(n, 'записи', 'записей', 'записей')} за ${period}`;
        badge.title = `За период: ${v.inPeriod}. Подходят под условия: ${n}${hidden > 0 ? ` (скрыто фильтрами: ${hidden})` : ''}. На экране: ${v.shown}.`;
    }

    function updateFoot(container, v) {
        const foot = container.querySelector('#jr-foot');
        if (!foot) return;
        const rest = v.list.length - v.shown;
        if (rest <= 0) { foot.hidden = true; foot.innerHTML = ''; return; }
        foot.hidden = false;
        foot.innerHTML = `<button type="button" class="jr-btn" data-jr-next>Показать ещё ${Math.min(BATCH, rest)}</button><span class="jr-foot-note">Осталось записей: ${rest}</span>`;
    }

    // Пустой список: что именно сузило выбор — период, пользователь, действие или поиск.
    function emptyHtml(events, f, v, byUserName) {
        let hint = '';
        let fix = '';
        if (!events.length) {
            hint = 'В журнале пока нет ни одной записи.';
        } else if (!v.inPeriod) {
            const next = f.days === 1 ? 7 : (f.days === 7 ? 30 : 0);
            hint = 'Записей за этот период нет. Выберите период побольше.';
            if (f.days !== 0) fix = `<button type="button" class="jr-btn" data-jr-days="${next}">Показать за ${PERIOD_TEXT[next]}</button>`;
        } else {
            const parts = [];
            if (f.profileId) parts.push({ key: 'profileId', text: `пользователь «${byUserName}»` });
            if (f.action) parts.push({ key: 'action', text: `действие «${f.action === '!tab' ? 'Все, кроме переходов по вкладкам' : actionLabel(f.action)}»` });
            if (f.query) parts.push({ key: 'query', text: `поиск «${f.query}»` });
            // Фильтр виноват, если без него записи находятся.
            const culprits = parts.filter(p => analyze(events, Object.assign({}, f, { [p.key]: '' })).filtered.length > 0);
            const names = (culprits.length ? culprits : parts).map(p => p.text).join(', ');
            hint = culprits.length
                ? `За этот период записи есть (${v.inPeriod}). Выбор сузили: ${names}.`
                : `За этот период записи есть (${v.inPeriod}), но вместе условия их скрывают: ${names}.`;
            const keys = (culprits.length ? culprits : parts).map(p => p.key).join(',');
            const oneLabel = { profileId: 'Показать всех пользователей', action: 'Показать все действия', query: 'Очистить поиск' };
            if (keys) fix = `<button type="button" class="jr-btn" data-jr-fix="${keys}">${(culprits.length || parts.length) === 1 ? oneLabel[keys] : 'Сбросить фильтры'}</button>`;
        }
        const title = !events.length ? 'Записей пока нет' : (v.inPeriod ? 'По выбранным условиям записей нет' : 'За выбранный период записей нет');
        return `<div class="jr-empty-title">${title}</div><div class="jr-empty-hint">${escHtml(hint)}</div>${fix}`;
    }

    // Кнопка «ещё» нужна только там, где текст реально не помещается в 2 строки (зависит от ширины окна).
    function measureClamps(container) {
        const list = container.querySelector('#jr-list');
        if (!list || container.hidden || !list.clientWidth) return;   // вкладка скрыта — измерять нечего (сделаем при показе)
        const els = list.querySelectorAll('.jr-det[data-long]');
        const flags = [];
        for (const el of els) flags.push(el.classList.contains('is-open') || el.scrollHeight > el.clientHeight + 1);
        els.forEach((el, i) => el.parentNode.classList.toggle('has-more', flags[i]));
    }

    function paint(container, v, events) {
        const f = v.filters;
        const profiles = getUniqueProfiles(events);
        if (f.profileId && !profiles.some(p => p[0] === f.profileId)) f.profileId = '';
        const res = analyze(events, f);

        v.list = res.filtered;
        v.times = res.times;
        v.inPeriod = res.inPeriod;
        v.headId = events[0] ? (events[0].id || '') : '';
        v.dayCounts = new Map();
        v.keys = res.times.map(t => {
            const k = dayKeyOf(t);
            v.dayCounts.set(k, (v.dayCounts.get(k) || 0) + 1);
            return k;
        });
        v.shown = Math.min(v.list.length, v.limit);
        v.lastDay = -1;

        const q = container.querySelector('#stats-filter-query');
        const dSel = container.querySelector('#stats-filter-days');
        const aSel = container.querySelector('#stats-filter-action');
        if (dSel && dSel.value !== String(f.days)) dSel.value = String(f.days);
        if (aSel && aSel.value !== f.action) aSel.value = f.action;
        if (q && document.activeElement !== q && q.value.trim() !== f.query) q.value = f.query;

        container.querySelector('#jr-users').innerHTML = chipsHtml(profiles, res, f);

        const list = container.querySelector('#jr-list');
        const table = list.querySelector('.jr-table');
        const empty = list.querySelector('#jr-empty');
        const top = list.scrollTop;
        [...table.tBodies].forEach(tb => tb.remove());
        if (v.list.length) {
            table.hidden = false;
            empty.hidden = true;
            table.insertAdjacentHTML('beforeend', rowsHtml(v, 0, v.shown).groups);
        } else {
            table.hidden = true;
            const who = (profiles.find(p => p[0] === f.profileId) || [])[1] || f.profileId;
            empty.innerHTML = emptyHtml(events, f, v, who);
            empty.hidden = false;
        }
        updateFoot(container, v);
        updateBadge(container, v);
        measureClamps(container);
        if (top) list.scrollTop = top;
    }

    // ---------- события (один набор обработчиков на всю вкладку) ----------

    function setFilters(container, patch) {
        const v = getView(container);
        Object.assign(v.filters, patch);
        v.limit = BATCH;
        const list = container.querySelector('#jr-list');
        if (list) list.scrollTop = 0;
        return renderInto(container);
    }

    function showMore(container) {
        const v = getView(container);
        const to = Math.min(v.list.length, v.shown + BATCH);
        if (to <= v.shown) return;
        const table = container.querySelector('.jr-table');
        const { cont, groups } = rowsHtml(v, v.shown, to);
        if (cont) table.tBodies[table.tBodies.length - 1].insertAdjacentHTML('beforeend', cont);
        if (groups) table.insertAdjacentHTML('beforeend', groups);
        v.shown = to;
        v.limit = to;
        updateFoot(container, v);
        updateBadge(container, v);
        measureClamps(container);
    }

    function toggleDetail(container, btn) {
        const v = getView(container);
        const id = btn.closest('tr')?.dataset.eid;
        if (id == null) return;
        const open = !v.expanded.has(id);
        if (open) v.expanded.add(id); else v.expanded.delete(id);
        btn.closest('.jr-c-det').querySelector('.jr-det').classList.toggle('is-open', open);
        btn.setAttribute('aria-expanded', String(open));
        btn.textContent = open ? 'свернуть' : 'ещё';
    }

    async function reload(container) {
        const btn = container.querySelector('#stats-refresh-btn');
        if (btn) { btn.disabled = true; btn.textContent = 'Обновляю…'; }
        cache = null;
        try {
            await renderInto(container);
        } finally {
            const b = container.querySelector('#stats-refresh-btn');
            if (b) { b.disabled = false; b.textContent = 'Обновить'; }
        }
    }

    function bindOnce(container) {
        if (container._jrBound) return;
        container._jrBound = true;

        if (typeof MutationObserver !== 'undefined') {
            new MutationObserver(() => { if (!container.hidden) onShown(container); })
                .observe(container, { attributes: true, attributeFilter: ['hidden'] });
        }

        container.addEventListener('click', ev => {
            const t = ev.target;
            if (!(t instanceof Element)) return;
            const more = t.closest('[data-jr-more]');
            if (more) { toggleDetail(container, more); return; }
            const chip = t.closest('[data-stats-user]');
            if (chip) { setFilters(container, { profileId: chip.dataset.statsUser || '' }); return; }
            if (t.closest('[data-jr-next]')) { showMore(container); return; }
            const days = t.closest('[data-jr-days]');
            if (days) { setFilters(container, { days: parseInt(days.dataset.jrDays, 10) || 0 }); return; }
            const fix = t.closest('[data-jr-fix]');
            if (fix) {
                const patch = {};
                fix.dataset.jrFix.split(',').forEach(k => { patch[k] = ''; });
                setFilters(container, patch);
                return;
            }
            if (t.closest('#stats-refresh-btn')) reload(container);
        });

        container.addEventListener('change', ev => {
            const t = ev.target;
            if (t.id === 'stats-filter-days') setFilters(container, { days: parseInt(t.value, 10) || 0 });
            else if (t.id === 'stats-filter-action') setFilters(container, { action: t.value });
        });

        container.addEventListener('input', ev => {
            const t = ev.target;
            if (t.id !== 'stats-filter-query') return;
            clearTimeout(container._statsSearchTimer);
            container._statsSearchTimer = setTimeout(() => setFilters(container, { query: t.value.trim() }), 250);
        });
    }

    // Каркас строится один раз; потом обновляются только подписи, чипы и список (поле поиска не теряет фокус).
    function ensureShell(container, v) {
        if (container.querySelector('.jr-page')) return;
        container.innerHTML = shellHtml();
        const list = container.querySelector('#jr-list');
        const q = container.querySelector('#stats-filter-query');
        if (q) q.value = v.filters.query;
        if (v.ro) { try { v.ro.disconnect(); } catch { /* ignore */ } v.ro = null; }
        if (typeof ResizeObserver !== 'undefined' && list) {
            v.ro = new ResizeObserver(() => {
                if (container.hidden) return;
                clearTimeout(v.resizeTimer);
                v.resizeTimer = setTimeout(() => measureClamps(container), 120);   // ширина изменилась — «ещё» нужно не везде
            });
            v.ro.observe(list);
        }
    }

    // Скрытая вкладка «замораживается» (не перерисовывается), поэтому при возврате смотрим сами:
    // если за это время в журнале появились записи — покажем их, иначе только пересчитаем кнопки «ещё».
    function onShown(container) {
        const v = getView(container);
        clearTimeout(v.resizeTimer);
        v.resizeTimer = setTimeout(() => {
            if (!container.isConnected || container.hidden) return;
            if (cache && (cache[0] ? cache[0].id || '' : '') !== v.headId) { renderInto(container); return; }
            measureClamps(container);
        }, 60);
    }

    async function renderInto(container, state) {
        const seq = (container._statsSeq = (container._statsSeq || 0) + 1);
        const v = getView(container);
        if (state) Object.assign(v.filters, state);
        // Журнал перечитываем при открытии вкладки и по кнопке «Обновить»; смена фильтра работает с тем, что уже загружено.
        const events = await loadAll(!container._statsLoaded);
        container._statsLoaded = true;
        if (seq !== container._statsSeq) return;   // пока читали журнал, запущена более новая отрисовка
        bindOnce(container);
        ensureShell(container, v);
        paint(container, v, events);
    }

    return {
        log,
        startBackgroundSync,
        TAB_LABELS,
        renderInto
    };
})();

async function createStatsView(container) {
    // Уже нарисованный журнал не гасим «Загрузкой»: фоновое обновление вкладки не должно сбрасывать фильтры и прокрутку.
    if (!container.querySelector('.jr-page')) container.innerHTML = '<div class="stats-loading">Загрузка журнала…</div>';
    await ActivityLog.renderInto(container);
}
