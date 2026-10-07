// Порядок вкладок в верхней панели — per profile
window.TabOrder = (function () {
    const STORAGE_PREFIX = 'krasavia_tab_order_';
    const DEFAULT_ORDER = ['home', 'main', 'table', 'pkz', 'pair', 'costs', 'data', 'rms', 'sales', 'stats'];

    // как на верхней панели (index.html)
    const LABELS = {
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
        apply();
        return [...DEFAULT_ORDER];
    }

    function apply() {
        const nav = document.querySelector('.tab-nav');
        if (!nav) return;
        const order = load();
        order.forEach(id => {
            const btn = document.getElementById('tab-' + id);
            if (btn) nav.appendChild(btn);
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

    function renderEditor(container, onChange, initialOrder) {
        let order = initialOrder || getEditableTabs();

        const render = () => {
            container.innerHTML = `
                <ul class="tab-order-list">
                    ${order.map((id, i) => `
                        <li class="tab-order-item" data-tab-id="${id}">
                            <span class="tab-order-label">${LABELS[id] || id}</span>
                            <span class="tab-order-actions">
                                <button type="button" class="tab-order-btn" data-move="up" data-index="${i}" ${i === 0 ? 'disabled' : ''}>▲</button>
                                <button type="button" class="tab-order-btn" data-move="down" data-index="${i}" ${i === order.length - 1 ? 'disabled' : ''}>▼</button>
                            </span>
                        </li>
                    `).join('')}
                </ul>
                <button type="button" class="btn-secondary tab-order-reset-btn">Сбросить порядок</button>
            `;

            container.querySelector('.tab-order-reset-btn')?.addEventListener('click', () => {
                order = DEFAULT_ORDER.filter(id => (id !== 'stats' && id !== 'home') || canShowTab(id));
                if (typeof onChange === 'function') onChange(order);
                render();
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
        renderEditor,
        getEditableTabs
    };
})();