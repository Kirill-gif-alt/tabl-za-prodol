// Журнал действий пользователей (локально + shared/activity.json)
window.ActivityLog = (function () {
    const LOCAL_KEY = 'krasavia_activity_v1';
    const MAX_EVENTS = 2000;   // как в общем файле (shared-storage.js)
    const MAX_TAB_EVENTS = 300;   // смены вкладок хранятся только здесь и не вытесняют остальные записи

    const ACTION_LABELS = {
        login: 'Вход',
        import: 'Импорт истории продаж',
        logout: 'Выход',
        tab: 'Вкладка',
        flight: 'Просмотр рейса',
        data_load: 'Загрузка данных',
        data_restore: 'Восстановление данных',
        data_share: 'Публикация данных',
        data_share_blocked: 'Публикация остановлена (подозрительные данные)',
        history_restore: 'Восстановление из резервной копии',
        sales_mark: 'Отметка «Управления продажами»',
        export: 'Выгрузка',
        fare_refs: 'Справочник тарифов',
        password_self: 'Смена своего пароля',
        password_admin: 'Смена пароля (админ)',
        profile_create: 'Создание профиля',
        profile_delete: 'Удаление профиля',
        profile_save: 'Сохранение профилей'
    };

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
        return typeof Security !== 'undefined' ? Security.escapeHtml(s) : String(s || '');
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
        const label = ACTION_LABELS[event.action] || event.action;
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

    function getUniqueProfiles(events) {
        const map = new Map();
        events.forEach(e => {
            if (e.profileId) map.set(e.profileId, e.profileName || e.profileId);
        });
        return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1], 'ru'));
    }

    function filterEvents(events, filters) {
        const { profileId, action, days, query } = filters;
        const now = Date.now();
        // «Сегодня» (1 день) — с полуночи, а не последние 24 часа.
        const from = days === 1 ? new Date().setHours(0, 0, 0, 0) : (days > 0 ? now - days * 86400000 : 0);

        return events.filter(e => {
            if (profileId && e.profileId !== profileId) return false;
            if (action === '!tab' ? e.action === 'tab' : (action && e.action !== action)) return false;
            if (from && new Date(e.ts).getTime() < from) return false;
            if (query) {
                const hay = [
                    e.profileName, e.profileId, e.detail,
                    ACTION_LABELS[e.action], formatDetail(e),
                    e.meta ? JSON.stringify(e.meta) : ''
                ].join(' ').toLowerCase();
                if (!hay.includes(query.toLowerCase())) return false;
            }
            return true;
        });
    }

    function buildStatsSummary(events) {
        const byUser = {};
        const byAction = {};
        events.forEach(e => {
            byUser[e.profileId] = (byUser[e.profileId] || 0) + 1;
            byAction[e.action] = (byAction[e.action] || 0) + 1;
        });
        return { byUser, byAction, total: events.length };
    }

    async function renderInto(container, state) {
        const seq = (container._statsSeq = (container._statsSeq || 0) + 1);
        // Журнал перечитываем при открытии вкладки и по кнопке «Обновить»; смена фильтра работает с тем, что уже загружено.
        const events = await loadAll(!container._statsLoaded);
        container._statsLoaded = true;
        if (seq !== container._statsSeq) return;   // пока читали журнал, запущена более новая отрисовка
        // Поиск набирается во время перерисовки — вернём фокус и курсор в поле.
        const qEl = container.querySelector('#stats-filter-query');
        const keepFocus = qEl && document.activeElement === qEl;
        const caret = keepFocus ? qEl.selectionStart : null;
        const liveQuery = qEl ? qEl.value : null;
        const filters = state || {
            profileId: '',
            action: '!tab',   // по умолчанию смены вкладок скрыты
            days: 7,
            query: ''
        };

        const filtered = filterEvents(events, filters);
        // Числа у имён — за выбранный период, действие и поиск (без выбора человека, чтобы остальные не обнулялись).
        const allSummary = buildStatsSummary(filterEvents(events, Object.assign({}, filters, { profileId: '' })));
        const profiles = getUniqueProfiles(events);

        const userCards = profiles.map(([id, name]) => {
            const count = allSummary.byUser[id] || 0;
            const active = filters.profileId === id;
            return `<button type="button" class="stats-user-chip${active ? ' active' : ''}" data-stats-user="${escHtml(id)}">
                <span class="stats-user-chip-name">${escHtml(name)}</span>
                <span class="stats-user-chip-count">${count || '—'}</span>
            </button>`;
        }).join('');

        const actionOptions = Object.entries(ACTION_LABELS).map(([key, label]) =>
            `<option value="${key}"${filters.action === key ? ' selected' : ''}>${escHtml(label)}</option>`
        ).join('');

        const rows = filtered.length ? filtered.map((e, i) => {
            const zebra = i % 2 ? 'stats-row-odd' : '';
            return `<tr class="stats-row ${zebra}">
                <td class="stats-col-ts">${escHtml(formatTs(e.ts))}</td>
                <td class="stats-col-user">${escHtml(e.profileName || e.profileId)}</td>
                <td class="stats-col-action"><span class="stats-action-badge stats-action-${escHtml(e.action)}">${escHtml(ACTION_LABELS[e.action] || e.action)}</span></td>
                <td class="stats-col-detail">${escHtml(formatDetail(e))}</td>
            </tr>`;
        }).join('') : `<tr><td colspan="4" class="stats-empty">Нет записей по выбранным фильтрам</td></tr>`;

        container.innerHTML = `
            <div class="stats-page table-page">
                <div class="table-page-hero stats-hero">
                    <div class="table-page-hero-main">
                        <h2 class="stats-hero-title">Журнал действий</h2>
                    </div>
                    <div class="stats-hero-meta">
                        <span class="stats-total-badge">${filtered.length} из ${events.length} ${pluralRu(events.length, 'записи', 'записей', 'записей')}</span>
                        <button type="button" class="filter-btn stats-refresh-btn" id="stats-refresh-btn">Обновить</button>
                    </div>
                </div>
                <div class="table-page-body">
                    <div class="stats-toolbar">
                        <div class="stats-filters">
                            <label class="stats-filter">
                                <span>Период</span>
                                <select id="stats-filter-days" class="stats-select">
                                    <option value="1"${filters.days === 1 ? ' selected' : ''}>Сегодня</option>
                                    <option value="7"${filters.days === 7 ? ' selected' : ''}>7 дней</option>
                                    <option value="30"${filters.days === 30 ? ' selected' : ''}>30 дней</option>
                                    <option value="0"${!filters.days ? ' selected' : ''}>Всё время</option>
                                </select>
                            </label>
                            <label class="stats-filter">
                                <span>Действие</span>
                                <select id="stats-filter-action" class="stats-select">
                                    <option value="">Все</option>
                                    <option value="!tab"${filters.action === '!tab' ? ' selected' : ''}>Все, кроме «Вкладка»</option>
                                    ${actionOptions}
                                </select>
                            </label>
                            <label class="stats-filter stats-filter-search">
                                <span>Поиск</span>
                                <input type="text" id="stats-filter-query" class="stats-search" placeholder="Рейс, пользователь…" value="${escHtml(filters.query)}">
                            </label>
                        </div>
                        <div class="stats-users-wrap">
                            <button type="button" class="stats-user-chip${!filters.profileId ? ' active' : ''}" data-stats-user="">Все</button>
                            ${userCards}
                        </div>
                    </div>
                    <div class="stats-table-wrap">
                        <table class="stats-table">
                            <thead>
                                <tr>
                                    <th>Время</th>
                                    <th>Пользователь</th>
                                    <th>Действие</th>
                                    <th>Детали</th>
                                </tr>
                            </thead>
                            <tbody>${rows}</tbody>
                        </table>
                    </div>
                </div>
            </div>
        `;

        const readFilters = () => ({
            profileId: container.querySelector('[data-stats-user].active')?.dataset.statsUser || '',
            action: container.querySelector('#stats-filter-action')?.value || '',
            days: parseInt(container.querySelector('#stats-filter-days')?.value || '7', 10),
            query: container.querySelector('#stats-filter-query')?.value?.trim() || ''
        });

        const rerender = () => renderInto(container, readFilters());

        container.querySelector('#stats-refresh-btn')?.addEventListener('click', () => {
            cache = null;
            rerender();
        });
        container.querySelector('#stats-filter-days')?.addEventListener('change', rerender);
        container.querySelector('#stats-filter-action')?.addEventListener('change', rerender);
        container.querySelector('#stats-filter-query')?.addEventListener('input', () => {
            clearTimeout(container._statsSearchTimer);
            container._statsSearchTimer = setTimeout(rerender, 280);
        });
        container.querySelectorAll('[data-stats-user]').forEach(btn => {
            btn.addEventListener('click', () => {
                container.querySelectorAll('[data-stats-user]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                rerender();
            });
        });
        const qNew = container.querySelector('#stats-filter-query');
        if (qNew && liveQuery != null && qNew.value !== liveQuery) qNew.value = liveQuery;
        if (qNew && keepFocus) { qNew.focus(); try { qNew.setSelectionRange(caret, caret); } catch (e) { /* ignore */ } }
    }

    return {
        log,
        startBackgroundSync,
        TAB_LABELS,
        renderInto
    };
})();

async function createStatsView(container) {
    container.innerHTML = '<div class="stats-loading">Загрузка журнала…</div>';
    await ActivityLog.renderInto(container);
}