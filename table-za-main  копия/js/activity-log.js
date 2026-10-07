// Журнал действий пользователей (локально + shared/activity.json)
window.ActivityLog = (function () {
    const LOCAL_KEY = 'krasavia_activity_v1';
    const MAX_EVENTS = 800;

    const ACTION_LABELS = {
        login: 'Вход',
        logout: 'Выход',
        tab: 'Вкладка',
        flight: 'Просмотр рейса',
        data_load: 'Загрузка данных',
        data_restore: 'Восстановление данных',
        data_share: 'Публикация данных',
        export: 'Экспорт',
        password_self: 'Смена своего пароля',
        password_admin: 'Смена пароля (админ)',
        profile_create: 'Создание профиля',
        profile_delete: 'Удаление профиля',
        profile_save: 'Сохранение профилей'
    };

    const TAB_LABELS = {
        home: 'Сеть',
        main: 'Графический план',
        table: 'Динамика продаж',
        pkz: 'ПКЗ',
        pair: 'Экономическая таблица',
        costs: 'Расчёт расходов',
        data: 'Загрузка рейсов',
        rms: 'RMS',
        sales: 'Управление продажами',
        stats: 'Статистика'
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

    function formatTs(iso) {
        if (!iso) return '—';
        try {
            return new Date(iso).toLocaleString('ru-RU', {
                day: '2-digit', month: '2-digit', year: 'numeric',
                hour: '2-digit', minute: '2-digit', second: '2-digit'
            });
        } catch {
            return iso;
        }
    }

    function mergeEvents(a, b) {
        const map = new Map();
        [...(a || []), ...(b || [])].forEach(e => {
            if (e?.id) map.set(e.id, e);
        });
        return [...map.values()]
            .sort((x, y) => new Date(y.ts) - new Date(x.ts))
            .slice(0, MAX_EVENTS);
    }

    async function loadAll(force) {
        if (cache && !force) return cache;

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
            shared = await SharedStorage.loadActivity() || [];
            if (typeof SalesSync !== 'undefined') {
                const dataDir = SalesSync.getDataRootHandle?.() || await SalesSync.restoreDataFolderHandle?.();
                if (dataDir && SharedStorage.loadActivityFromDataRoot) {
                    const extra = await SharedStorage.loadActivityFromDataRoot(dataDir);
                    shared = mergeEvents(shared, extra);
                }
            }
        }

        cache = mergeEvents(local, shared);
        try {
            localStorage.setItem(LOCAL_KEY, JSON.stringify(cache));
        } catch { /* ignore */ }
        return cache;
    }

    async function pushToShared() {
        if (!cache || typeof SharedStorage === 'undefined') return false;
        const headId = cache[0]?.id || '';
        if (headId && headId === lastPushedHeadId) return true;
        let ok = false;
        await SharedStorage.restoreRootHandle();
        if (SharedStorage.isLinked()) {
            ok = await SharedStorage.saveActivity(cache) || ok;
        }
        if (typeof SalesSync !== 'undefined' && SharedStorage.saveActivityToDataRoot) {
            const dataDir = SalesSync.getDataRootHandle?.() || await SalesSync.restoreDataFolderHandle?.();
            if (dataDir) ok = await SharedStorage.saveActivityToDataRoot(dataDir, cache) || ok;
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
            if (cache.length > MAX_EVENTS) cache = cache.slice(0, MAX_EVENTS);
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
        const dayMs = days > 0 ? days * 86400000 : 0;

        return events.filter(e => {
            if (profileId && e.profileId !== profileId) return false;
            if (action && e.action !== action) return false;
            if (dayMs && (now - new Date(e.ts).getTime()) > dayMs) return false;
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
        const events = await loadAll(true);
        const filters = state || {
            profileId: '',
            action: '',
            days: 7,
            query: ''
        };

        const filtered = filterEvents(events, filters);
        const allSummary = buildStatsSummary(events);
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
                        <h2 class="stats-hero-title">Статистика активности</h2>
                    </div>
                    <div class="stats-hero-meta">
                        <span class="stats-total-badge">${filtered.length} из ${events.length} записей</span>
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
    }

    return {
        log,
        loadAll,
        syncWithShared,
        startBackgroundSync,
        ACTION_LABELS,
        TAB_LABELS,
        renderInto
    };
})();

async function createStatsView(container) {
    container.innerHTML = '<div class="stats-loading">Загрузка журнала…</div>';
    await ActivityLog.renderInto(container);
}