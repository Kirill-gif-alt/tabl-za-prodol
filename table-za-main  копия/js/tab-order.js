// Порядок и названия вкладок в верхней панели — у каждого профиля свои (localStorage).
window.TabOrder = (function () {
    const STORAGE_PREFIX = 'krasavia_tab_order_';
    const NAMES_PREFIX = 'krasavia_tab_names_';
    const NAME_MAX = 40;
    const DEFAULT_ORDER = ['today', 'home', 'main', 'table', 'pkz', 'pair', 'costs', 'data', 'rms', 'sales', 'creative', 'reports', 'stats'];

    // как на верхней панели (index.html)
    const LABELS = {
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
        stats: 'Статистика'
    };

    function profileId() {
        return (typeof ProfileAuth !== 'undefined' && ProfileAuth.getCurrentProfile()?.id) || 'guest';
    }

    // Свои названия вкладок: { table: 'Продажи', ... }; пустое — стандартное.
    function loadNames() {
        try {
            const raw = JSON.parse(localStorage.getItem(NAMES_PREFIX + profileId()) || '{}');
            const out = {};
            Object.keys(raw || {}).forEach(id => {
                const v = String(raw[id] || '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
                if (LABELS[id] && v && v !== LABELS[id]) out[id] = v;
            });
            return out;
        } catch {
            return {};
        }
    }

    function saveNames(names) {
        const clean = {};
        Object.keys(names || {}).forEach(id => {
            const v = String(names[id] || '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
            if (LABELS[id] && v && v !== LABELS[id]) clean[id] = v;
        });
        try {
            if (Object.keys(clean).length) localStorage.setItem(NAMES_PREFIX + profileId(), JSON.stringify(clean));
            else localStorage.removeItem(NAMES_PREFIX + profileId());
        } catch { /* ignore */ }
        apply();
        return clean;
    }

    function labelOf(id) {
        return loadNames()[id] || LABELS[id] || id;
    }

    function getStorageKey() {
        const id = (typeof ProfileAuth !== 'undefined' && ProfileAuth.getCurrentProfile()?.id) || 'guest';
        return STORAGE_PREFIX + id;
    }

    function load() {
        try {
            const raw = localStorage.getItem(getStorageKey());
            if (!raw) return [...DEFAULT_ORDER];
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return [...DEFAULT_ORDER];
            const merged = [...parsed];
            DEFAULT_ORDER.forEach(id => {
                if (!merged.includes(id)) merged.push(id);
            });
            return merged.filter(id => DEFAULT_ORDER.includes(id));
        } catch {
            return [...DEFAULT_ORDER];
        }
    }

    function save(order) {
        const clean = (order || []).filter(id => DEFAULT_ORDER.includes(id));
        DEFAULT_ORDER.forEach(id => {
            if (!clean.includes(id)) clean.push(id);
        });
        try {
            localStorage.setItem(getStorageKey(), JSON.stringify(clean));
        } catch { /* ignore */ }
        apply();
        return clean;
    }

    function reset() {
        try { localStorage.removeItem(getStorageKey()); } catch { /* ignore */ }
        try { localStorage.removeItem(NAMES_PREFIX + profileId()); } catch { /* ignore */ }
        apply();
        return [...DEFAULT_ORDER];
    }

    function apply() {
        const nav = document.querySelector('.tab-nav');
        if (!nav) return;
        const order = load();
        const names = loadNames();
        order.forEach(id => {
            const btn = document.getElementById('tab-' + id);
            if (!btn) return;
            nav.appendChild(btn);
            const label = names[id] || LABELS[id];
            if (label && btn.textContent !== label) btn.textContent = label;
            btn.title = names[id] ? LABELS[id] : '';
        });
    }

    function canShowTab(id) {
        if (id === 'home') {
            return typeof ProfileAuth !== 'undefined' && ProfileAuth.canAccessTab('home');
        }
        if (id === 'stats') {
            return !!(typeof ProfileAuth !== 'undefined' && ProfileAuth.getCurrentProfile()?.isAdmin);
        }
        if (typeof ProfileAuth !== 'undefined') return ProfileAuth.canAccessTab(id);
        return true;
    }

    function getEditableTabs() {
        return load().filter(id => (id !== 'stats' && id !== 'home') || canShowTab(id));
    }

    function moveTab(order, index, direction) {
        const next = [...order];
        const target = index + direction;
        if (target < 0 || target >= next.length) return next;
        [next[index], next[target]] = [next[target], next[index]];
        return next;
    }

    function esc(v) {
        return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // Редактор: порядок (▲ ▼) и своё название каждой вкладки. onNames(names) — при правке названий.
    function renderEditor(container, onChange, initialOrder, onNames, initialNames) {
        let order = initialOrder || getEditableTabs();
        let names = { ...(initialNames || loadNames()) };

        const render = () => {
            container.innerHTML = `
                <p class="tab-order-hint">Порядок — стрелками. Название можно написать своё: оно видно только в вашем профиле. Пустое поле — стандартное название.</p>
                <ul class="tab-order-list">
                    ${order.map((id, i) => `
                        <li class="tab-order-item" data-tab-id="${id}">
                            <input type="text" class="tab-order-name" data-tab-name="${id}" maxlength="${NAME_MAX}"
                                   value="${esc(names[id] || '')}" placeholder="${esc(LABELS[id] || id)}" title="Стандартное название: ${esc(LABELS[id] || id)}">
                            <span class="tab-order-actions">
                                <button type="button" class="tab-order-btn" data-move="up" data-index="${i}" ${i === 0 ? 'disabled' : ''} title="Выше">▲</button>
                                <button type="button" class="tab-order-btn" data-move="down" data-index="${i}" ${i === order.length - 1 ? 'disabled' : ''} title="Ниже">▼</button>
                            </span>
                        </li>
                    `).join('')}
                </ul>
                <button type="button" class="btn-secondary tab-order-reset-btn">Сбросить порядок и названия</button>
            `;

            container.querySelector('.tab-order-reset-btn')?.addEventListener('click', () => {
                order = DEFAULT_ORDER.filter(id => (id !== 'stats' && id !== 'home') || canShowTab(id));
                names = {};
                if (typeof onChange === 'function') onChange(order);
                if (typeof onNames === 'function') onNames(names);
                render();
            });

            container.querySelectorAll('.tab-order-name').forEach(inp => {
                inp.addEventListener('input', () => {
                    const v = inp.value.replace(/\s+/g, ' ').trim();
                    if (v) names[inp.dataset.tabName] = v;
                    else delete names[inp.dataset.tabName];
                    if (typeof onNames === 'function') onNames({ ...names });
                });
            });

            container.querySelectorAll('.tab-order-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const idx = parseInt(btn.dataset.index, 10);
                    const dir = btn.dataset.move === 'up' ? -1 : 1;
                    order = moveTab(order, idx, dir);
                    if (typeof onChange === 'function') onChange(order);
                    render();
                });
            });
        };

        render();
        return () => order;
    }

    return {
        load,
        save,
        reset,
        apply,
        LABELS,
        DEFAULT_ORDER,
        loadNames,
        saveNames,
        labelOf,
        renderEditor,
        getEditableTabs
    };
})();