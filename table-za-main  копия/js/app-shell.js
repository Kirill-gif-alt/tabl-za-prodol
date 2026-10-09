// Каркас «Светлый офис»: левое меню по разделам вместо ряда вкладок, переключатель темы.
// Кнопки вкладок те же (id tab-*), они только переносятся в группы меню — права, порядок
// (TabOrder) и горячие клавиши работают как раньше.
window.AppShell = (function () {
    const COLLAPSE_KEY = 'krasavia_nav_collapsed';
    // Оформление: 'new' — меню слева («Светлый офис»), 'classic' — вкладки сверху, как раньше.
    // Выбор хранится на профиль; до входа берётся последний выбор на этом компьютере.
    const LAYOUT_KEY = 'krasavia_ui_layout';

    const GROUPS = [
        { id: 'start', title: '', tabs: ['today'] },
        { id: 'flights', title: 'Рейсы', tabs: ['main', 'data', 'pkz', 'home'] },
        { id: 'sales', title: 'Продажи', tabs: ['table', 'rms', 'sales'] },
        { id: 'econ', title: 'Экономика', tabs: ['pair', 'costs', 'creative'] },
        { id: 'data', title: 'Данные', tabs: ['reports', 'stats'] }
    ];

    const P = (d) => `<svg class="sn-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
    const ICONS = {
        today: P('M12 3v2M12 19v2M5 12H3M21 12h-2M6.3 6.3 4.9 4.9M19.1 19.1l-1.4-1.4M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z'),
        main: P('M4 6h16M4 12h16M4 18h16M8 4v4M14 10v4M10 16v4'),
        data: P('M4 5h16v14H4zM4 10h16M10 10v9'),
        pkz: P('M6 7h12l-1 13H7L6 7zM9 7V5a3 3 0 0 1 6 0v2'),
        home: P('M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11zM12 8.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z'),
        table: P('M4 19V5M4 19h16M8 15l3-4 3 2 5-6'),
        rms: P('M12 3l9 16H3L12 3zM12 10v4M12 17v.5'),
        sales: P('M5 4h14v16H5zM9 9h6M9 13h6M9 17h3'),
        pair: P('M12 3v18M16 7H10a3 3 0 0 0 0 6h4a3 3 0 0 1 0 6H8'),
        costs: P('M6 3h12v18H6zM9 7h6M9 11h6M9 15h2M13 15h2M9 18h2M13 18h2'),
        creative: P('M4 5h7v7H4zM13 5h7v4h-7zM13 11h7v8h-7zM4 14h7v5H4z'),
        reports: P('M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6'),
        stats: P('M5 20V10M10 20V4M15 20v-7M20 20v-11')
    };

    let built = false;

    // По умолчанию — классическое оформление; новое только если профиль сам выбрал его в «⚙ Настройках».
    function layout() {
        try {
            const pid = currentProfileId();
            const v = pid ? localStorage.getItem(LAYOUT_KEY + '_' + pid) : localStorage.getItem(LAYOUT_KEY);
            return v === 'new' ? 'new' : 'classic';
        } catch (e) {
            return 'classic';
        }
    }

    // Страница «Сегодня» — часть нового оформления; в классическом её вкладки нет, как раньше.
    function syncTodayTab() {
        const btn = document.getElementById('tab-today');
        if (btn) btn.style.display = layout() === 'new' ? '' : 'none';
    }

    function currentProfileId() {
        const p = typeof ProfileAuth !== 'undefined' && ProfileAuth.getCurrentProfile ? ProfileAuth.getCurrentProfile() : null;
        return p ? p.id : '';
    }

    // Переключение оформления (из «⚙ Настройки»). withTheme — заодно сменить палитру: «Офис» / «Стандартная».
    function setLayout(mode, withTheme) {
        const v = mode === 'classic' ? 'classic' : 'new';
        try {
            localStorage.setItem(LAYOUT_KEY, v);
            const pid = currentProfileId();
            if (pid) localStorage.setItem(LAYOUT_KEY + '_' + pid, v);
        } catch (e) { /* ignore */ }
        if (v === 'new') build();
        else teardown();
        syncTodayTab();
        if (v === 'classic' && typeof currentTab !== 'undefined' && currentTab === 'today' && typeof switchMainTab === 'function') {
            const first = typeof ProfileAuth !== 'undefined' ? ProfileAuth.getFirstAllowedTab() : null;
            if (first) switchMainTab(first);
        }
        if (withTheme && typeof ThemeSettings !== 'undefined' && ThemeSettings.setPreset) {
            ThemeSettings.setPreset(v === 'new' ? 'office' : 'krasavia');
        }
        if (typeof refreshCurrentView === 'function') setTimeout(refreshCurrentView, 0);
    }

    // После входа: оформление того профиля, который вошёл.
    function applyForProfile() {
        syncTodayTab();
        const want = layout();
        if (want === 'new' && !built) build();
        else if (want === 'classic' && built) teardown();
        else if (built) place();
    }

    // Вернуть вкладки сверху: кнопки обратно в верхнюю панель, без значков.
    function teardown() {
        if (!built) return;
        const nav = document.querySelector('.tab-nav');
        if (nav) {
            document.querySelectorAll('.side-nav .tab-btn').forEach(btn => {
                const label = btn.dataset.snLabel || btn.textContent.trim();
                btn.textContent = label;
                nav.appendChild(btn);
            });
            nav.hidden = false;
        }
        document.querySelector('.side-nav')?.remove();
        document.getElementById('sn-burger')?.remove();
        document.querySelector('.main-layout')?.classList.remove('has-side-nav');
        document.body.classList.remove('sn-open', 'sn-collapsed');
        built = false;
        if (typeof TabOrder !== 'undefined') TabOrder.apply();
    }

    function profileId() {
        const p = typeof ProfileAuth !== 'undefined' && ProfileAuth.getCurrentProfile ? ProfileAuth.getCurrentProfile() : null;
        return p ? p.id : 'guest';
    }

    function collapsed() {
        try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch (e) { return false; }
    }

    function build() {
        if (built || layout() !== 'new') return;
        const host = document.querySelector('.main-layout');
        const nav = document.querySelector('.tab-nav');
        if (!host || !nav) return;
        built = true;
        const aside = document.createElement('aside');
        aside.className = 'side-nav';
        aside.setAttribute('aria-label', 'Разделы');
        aside.innerHTML = `
            <div class="sn-brand">
                <span class="sn-logo"><img src="assets/favicon.svg" alt="" width="22" height="22"></span>
                <span class="sn-brand-text">КРАСАВИА</span>
                <button type="button" class="sn-collapse" id="sn-collapse" title="Свернуть меню" aria-label="Свернуть меню">‹</button>
            </div>
            <nav class="sn-groups">${GROUPS.map(g => `
                <div class="sn-group" data-sn-group="${g.id}">
                    ${g.title ? `<div class="sn-group-title">${g.title}</div>` : ''}
                    <div class="sn-list"></div>
                </div>`).join('')}
            </nav>
            <div class="sn-foot">
                <button type="button" class="sn-theme" id="sn-theme" title="Светлая / тёмная тема"><span class="sn-theme-ico">☾</span><span class="sn-label">Тёмная тема</span></button>
            </div>`;
        host.insertBefore(aside, host.firstChild);
        host.classList.add('has-side-nav');

        // Кнопки вкладок: значок + подпись, перенос в свои группы.
        nav.querySelectorAll('.tab-btn').forEach(btn => {
            const id = btn.id.replace(/^tab-/, '');
            if (!btn.querySelector('.sn-label')) {
                const label = btn.textContent.trim();
                btn.dataset.snLabel = label;
                btn.title = label;
                btn.innerHTML = `${ICONS[id] || P('M5 12h14')}<span class="sn-label">${label}</span>`;
            }
        });
        place();
        nav.hidden = true;

        // Кнопка меню для узких экранов.
        const bar = document.querySelector('.top-nav-bar');
        if (bar && !document.getElementById('sn-burger')) {
            const b = document.createElement('button');
            b.type = 'button';
            b.id = 'sn-burger';
            b.className = 'sn-burger';
            b.setAttribute('aria-label', 'Меню');
            b.textContent = '☰';
            bar.insertBefore(b, bar.firstChild);
            b.addEventListener('click', () => document.body.classList.toggle('sn-open'));
        }
        aside.addEventListener('click', (e) => {
            if (e.target.closest('.tab-btn')) document.body.classList.remove('sn-open');
            if (e.target.closest('#sn-collapse')) toggleCollapse();
            if (e.target.closest('#sn-theme')) toggleTheme();
        });
        document.addEventListener('click', (e) => {
            if (document.body.classList.contains('sn-open') && !e.target.closest('.side-nav') && !e.target.closest('#sn-burger')) {
                document.body.classList.remove('sn-open');
            }
        });
        applyCollapse();
        syncTheme();
    }

    // Порядок кнопок внутри групп — как в настройках профиля (TabOrder).
    function place() {
        const order = typeof TabOrder !== 'undefined' ? TabOrder.load() : [];
        GROUPS.forEach(g => {
            const list = document.querySelector(`.sn-group[data-sn-group="${g.id}"] .sn-list`);
            if (!list) return;
            const ids = g.tabs.slice().sort((a, b) => {
                const ia = order.indexOf(a);
                const ib = order.indexOf(b);
                return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
            });
            ids.forEach(id => {
                const btn = document.getElementById('tab-' + id);
                if (btn) list.appendChild(btn);
            });
        });
        sync();
    }

    // Группа без видимых кнопок (нет прав) не показывается.
    function sync() {
        document.querySelectorAll('.sn-group').forEach(g => {
            const any = [...g.querySelectorAll('.tab-btn')].some(b => b.style.display !== 'none');
            g.hidden = !any;
        });
    }

    function applyCollapse() {
        const on = collapsed();
        document.body.classList.toggle('sn-collapsed', on);
        const b = document.getElementById('sn-collapse');
        if (b) {
            b.textContent = on ? '›' : '‹';
            b.title = on ? 'Развернуть меню' : 'Свернуть меню';
        }
    }

    function toggleCollapse() {
        try { localStorage.setItem(COLLAPSE_KEY, collapsed() ? '0' : '1'); } catch (e) { /* ignore */ }
        applyCollapse();
    }

    function isDark() {
        return document.documentElement.dataset.theme === 'dark';
    }

    function syncTheme() {
        const b = document.getElementById('sn-theme');
        if (!b) return;
        const dark = isDark();
        b.querySelector('.sn-theme-ico').textContent = dark ? '☀' : '☾';
        b.querySelector('.sn-label').textContent = dark ? 'Светлая тема' : 'Тёмная тема';
    }

    // Переключение между светлой («Офис») и тёмной темой; остальные цвета — в «⚙ Настройках».
    function toggleTheme() {
        if (typeof ThemeSettings === 'undefined' || !ThemeSettings.setPreset) return;
        ThemeSettings.setPreset(isDark() ? 'office' : 'dark');
        syncTheme();
    }

    return { build, teardown, place, sync, syncTheme, layout, setLayout, applyForProfile, isNew: () => built, GROUPS, profileId };
})();

// Меню строится сразу: кнопки вкладок уже есть в разметке (скрипты подключены в конце страницы).
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => AppShell.applyForProfile());
else AppShell.applyForProfile();
