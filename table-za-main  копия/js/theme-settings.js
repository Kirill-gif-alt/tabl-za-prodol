// Настройки оформления — по вкладкам, per profile
window.ThemeSettings = (function () {
    const STORAGE_PREFIX = 'krasavia_theme_';
    let previewTimer = null;
    let formBuilt = false;
    let pendingTabOrder = null;
    let pendingTabNames = null;

    // Меню настроек — по смыслу: оформление, работа, безопасность. Цвета отдельных вкладок — один пункт с выбором вкладки.
    const NAV = [
        { group: 'Оформление', items: [
            { id: 'general', label: 'Тема и основные цвета', hint: 'Готовая тема или свои цвета шапки, кнопок, фона и текста. Сохраняется для вашего профиля.' },
            { id: 'colors', label: 'Цвета вкладок', hint: 'Таблицы и плитки отдельной вкладки. Выберите вкладку — ниже её цвета.' }
        ] },
        { group: 'Работа', items: [
            { id: 'tabs', label: 'Вкладки: названия и порядок', hint: 'Свои названия и порядок кнопок в шапке — только у вас.' },
            { id: 'excel', label: 'Папки для Excel', hint: 'Куда сохранять выгрузки на этом компьютере.' },
            { id: 'salesAdmin', label: 'Управление продажами', hint: 'Направления и диапазоны таблицы — для всех. Видит только администратор.', admin: true },
            { id: 'params', label: 'Параметры расчётов', hint: 'Все числа, от которых зависят расчёты: с какого размера брони считается группа, пороги сигналов, модель прогноза, ценовой советник. Действуют у всех. Видит только администратор.', admin: true }
        ] },
        { group: 'Безопасность', items: [
            { id: 'password', label: 'Пароль', hint: 'Смена своего пароля: нужен текущий, новый — от 8 символов.' }
        ] }
    ];

    const SECTIONS = [
        { id: 'general', label: 'Общее' },
        { id: 'main', label: 'Графический план' },
        { id: 'table', label: 'Динамика продаж' },
        { id: 'pair', label: 'Экономическая таблица' },
        { id: 'data', label: 'Загрузка рейсов' },
        { id: 'rms', label: 'RMS' },
        { id: 'sales', label: 'Управление продажами' },
        { id: 'today', label: 'Сегодня' },
        { id: 'creative', label: 'Творческая' },
        { id: 'reports', label: 'Отчёты' },
        { id: 'excel', label: 'Выгрузка Excel' },
        { id: 'tabs', label: 'Вкладки' },
        { id: 'password', label: 'Пароль' }
    ];

    const FIELD_GROUPS = {
        general: [
            { key: 'primary', label: 'Основной', hint: 'Заголовки и акценты', css: '--primary' },
            { key: 'navBg', label: 'Шапка', hint: 'Верхняя панель', css: '--nav-bg' },
            { key: 'accent', label: 'Кнопки', hint: '«Загрузить данные» и акценты', css: '--accent' },
            { key: 'bg', label: 'Фон', hint: 'Фон рабочей области', css: '--bg' },
            { key: 'surface', label: 'Карточки', hint: 'Боковая панель и блоки', css: '--surface' },
            { key: 'border', label: 'Рамки', hint: 'Границы таблиц', css: '--border' },
            { key: 'text', label: 'Текст', hint: 'Основной текст', css: '--text' },
            { key: 'textMuted', label: 'Подписи', hint: 'Вторичный текст', css: '--text-muted' }
        ],
        main: [
            { key: 'mainOpen', label: 'Открытые', hint: 'Нормальная загрузка', css: '--main-chip-open-bg' },
            { key: 'mainOpenText', label: 'Текст открытых', hint: 'Номер и %', css: '--main-chip-open-text' },
            { key: 'mainLow', label: '<40%', hint: 'Низкая загрузка', css: '--main-chip-low-bg' },
            { key: 'mainLowText', label: 'Текст <40%', hint: 'Текст на чипах', css: '--main-chip-low-text' },
            { key: 'mainFull', label: '≥95%', hint: 'Почти полный', css: '--main-chip-full-bg' },
            { key: 'mainFullText', label: 'Текст полных', hint: 'Текст на полных', css: '--main-chip-full-text' },
            { key: 'mainClosed', label: 'Закрытые', hint: 'Закрыт для продаж', css: '--main-chip-closed-bg' },
            { key: 'mainClosedText', label: 'Текст закрытых', hint: '', css: '--main-chip-closed-text' },
            { key: 'mainFlew', label: 'Улетевшие', hint: 'Прошедшие даты', css: '--main-chip-flew-bg' },
            { key: 'mainFlewText', label: 'Текст улетевших', hint: '', css: '--main-chip-flew-text' }
        ],
        table: [
            { key: 'tableHead', label: 'Шапка таблицы', hint: 'Заголовки столбцов', css: '--table-head-bg' },
            { key: 'tableRowEven', label: 'Чётные строки', hint: 'Зебра — чётная неделя', css: '--table-row-even' },
            { key: 'tableRowOdd', label: 'Нечётные строки', hint: 'Зебра — нечётная неделя', css: '--table-row-odd' }
        ],
        pair: [
            { key: 'pairOutHead', label: 'Заголовок «туда»', hint: 'Шапка столбцов →', css: '--pair-out-head' },
            { key: 'pairInHead', label: 'Заголовок «обратно»', hint: 'Шапка столбцов ←', css: '--pair-in-head' },
            { key: 'pairOutBg', label: 'Ячейки «туда»', hint: 'Фон данных →', css: '--pair-leg-out-bg' },
            { key: 'pairInBg', label: 'Ячейки «обратно»', hint: 'Фон данных ←', css: '--pair-leg-in-bg' }
        ],
        data: [
            { key: 'dataOut', label: 'Колонки →', hint: 'Направление туда', css: '--data-leg-out' },
            { key: 'dataIn', label: 'Колонки ←', hint: 'Направление обратно', css: '--data-leg-in' },
            { key: 'flewBg', label: 'Улетевшие', hint: 'Прошедшие даты', css: '--data-flew-bg' },
            { key: 'dataCardHead', label: 'Шапка карточки', hint: 'Блок с кодом рейса', css: '--data-card-head-bg' }
        ],
        rms: [
            { key: 'rmsHead', label: 'Шапка RMS', hint: 'Заголовок таблицы RMS', css: '--rms-head-bg' },
            { key: 'rmsRowEven', label: 'Чётные строки', hint: 'Зебра в RMS', css: '--rms-row-even' }
        ],
        sales: [
            { key: 'smHead', label: 'Шапка', hint: 'Заголовки столбцов', css: '--sm-head-bg' },
            { key: 'smKeep', label: 'Без изменений', hint: 'Жёлтая отметка', css: '--sm-keep' },
            { key: 'smAttn', label: 'Обратить внимание', hint: 'Бледно-красная отметка и знак !', css: '--sm-attn' },
            { key: 'smDown', label: 'Снижение', hint: 'Насыщенно-красная отметка', css: '--sm-down' },
            { key: 'smUp', label: 'Повышение', hint: 'Зелёная отметка', css: '--sm-up' },
            { key: 'smFlew', label: 'Улетевшие', hint: 'Прошедшие даты', css: '--sm-flew' }
        ],
        today: [
            { key: 'todayHead', label: 'Шапка таблицы', hint: 'Заголовки «Ждут отметки», «Вылеты дня»', css: '--today-head-bg' },
            { key: 'todayCard', label: 'Плитки и дни', hint: 'Фон плиток и полосы дней', css: '--today-card-bg' },
            { key: 'todayActive', label: 'Выбранный день', hint: 'Рамка выбранного дня и вкладки', css: '--today-active' }
        ],
        creative: [
            { key: 'crHead', label: 'Шапка таблицы', hint: 'Заголовки столбцов', css: '--cr-head-bg' },
            { key: 'crTotals', label: 'Строка «Итого»', hint: 'Итоги под шапкой', css: '--cr-totals-bg' },
            { key: 'crRowEven', label: 'Чётные строки', hint: 'Зебра', css: '--cr-row-even' }
        ],
        reports: [
            { key: 'rpHead', label: 'Шапка таблиц', hint: 'Проверка, справочник, сверка, решения', css: '--rp-head-bg' },
            { key: 'rpRowEven', label: 'Чётные строки', hint: 'Зебра', css: '--rp-row-even' }
        ]
    };

    const ALL_FIELDS = Object.values(FIELD_GROUPS).flat();

    const PRESETS = {
        krasavia: {
            name: 'Стандартная',
            mainOpen: '#012A4A', mainOpenText: '#ffffff', mainLow: '#fff7ed', mainLowText: '#9a3412',
            mainFull: '#ecfdf5', mainFullText: '#047857', mainClosed: '#fef2f2', mainClosedText: '#991b1b',
            mainFlew: '#f1f5f9', mainFlewText: '#475569',
            primary: '#012A4A', navBg: '#012A4A', accent: '#10b981', bg: '#f0f4f8', surface: '#ffffff',
            border: '#e2e8f0', text: '#012A4A', textMuted: '#64748b',
            tableHead: '#012A4A', tableRowEven: '#dbeafe', tableRowOdd: '#ffffff',
            pairOutHead: '#1e40af', pairInHead: '#047857', pairOutBg: '#eff6ff', pairInBg: '#ecfdf5',
            dataOut: '#eff6ff', dataIn: '#ecfdf5', flewBg: '#e8ecf1', dataCardHead: '#f8fafc',
            rmsHead: '#012A4A', rmsRowEven: '#f1f5f9',
            smHead: '#012A4A', smKeep: '#F7DC6F', smAttn: '#F5B7B1', smDown: '#8E1B2F', smUp: '#7DCEA0', smFlew: '#D5D8DC',
            todayHead: '#012A4A', todayCard: '#ffffff', todayActive: '#012A4A', crHead: '#012A4A', crTotals: '#e2e8f0', crRowEven: '#f8fafc', rpHead: '#012A4A', rpRowEven: '#f4f8fe'
        },
        blue: {
            name: 'Синяя',
            mainOpen: '#205493', mainOpenText: '#ffffff', mainLow: '#fff7ed', mainLowText: '#9a3412',
            mainFull: '#ecfdf5', mainFullText: '#047857', mainClosed: '#fef2f2', mainClosedText: '#991b1b',
            mainFlew: '#eef2f6', mainFlewText: '#475569',
            primary: '#205493', navBg: '#205493', accent: '#10b981', bg: '#f4f7fb', surface: '#ffffff',
            border: '#d5dde6', text: '#1a2b3c', textMuted: '#5b6b7c',
            tableHead: '#205493', tableRowEven: '#eef3f8', tableRowOdd: '#ffffff',
            pairOutHead: '#2563a8', pairInHead: '#1b7a5a', pairOutBg: '#f3f7fb', pairInBg: '#f3faf6',
            dataOut: '#f3f7fb', dataIn: '#f3faf6', flewBg: '#e8eef4', dataCardHead: '#f7f9fc',
            rmsHead: '#205493', rmsRowEven: '#eef3f8',
            smHead: '#205493', smKeep: '#F7DC6F', smAttn: '#F5B7B1', smDown: '#8E1B2F', smUp: '#7DCEA0', smFlew: '#D5D8DC',
            todayHead: '#205493', todayCard: '#ffffff', todayActive: '#1a2b3c', crHead: '#205493', crTotals: '#e3e9f0', crRowEven: '#f6f9fc', rpHead: '#205493', rpRowEven: '#f6f9fc'
        },
        gray: {
            name: 'Серая',
            mainOpen: '#2F343B', mainOpenText: '#ffffff', mainLow: '#fff7ed', mainLowText: '#9a3412',
            mainFull: '#ecfdf5', mainFullText: '#047857', mainClosed: '#fef2f2', mainClosedText: '#991b1b',
            mainFlew: '#e8eaed', mainFlewText: '#5f6368',
            primary: '#2F343B', navBg: '#2F343B', accent: '#0f62fe', bg: '#F2F4F7', surface: '#ffffff',
            border: '#d8dce3', text: '#1F2328', textMuted: '#5f656d',
            tableHead: '#3d434b', tableRowEven: '#E8EAED', tableRowOdd: '#ffffff',
            pairOutHead: '#3d5a80', pairInHead: '#2d6a4f', pairOutBg: '#eef2f6', pairInBg: '#eef6f1',
            dataOut: '#eef2f6', dataIn: '#eef6f1', flewBg: '#e4e6ea', dataCardHead: '#f4f5f7',
            rmsHead: '#3d434b', rmsRowEven: '#eceef1',
            smHead: '#3d434b', smKeep: '#F7DC6F', smAttn: '#F5B7B1', smDown: '#8E1B2F', smUp: '#7DCEA0', smFlew: '#D5D8DC',
            todayHead: '#3d434b', todayCard: '#ffffff', todayActive: '#1F2328', crHead: '#3d434b', crTotals: '#e4e6ea', crRowEven: '#f6f7f9', rpHead: '#3d434b', rpRowEven: '#f6f7f9'
        },
        dark: {
            name: 'Тёмная',
            mainOpen: '#1f6feb', mainOpenText: '#ffffff', mainLow: '#9a3412', mainLowText: '#ffedd5',
            mainFull: '#0f766e', mainFullText: '#ccfbf1', mainClosed: '#991b1b', mainClosedText: '#fecaca',
            mainFlew: '#21262d', mainFlewText: '#c9d1d9',
            primary: '#e6edf3', navBg: '#010409', accent: '#238636', bg: '#0d1117', surface: '#161b22',
            border: '#30363d', text: '#e6edf3', textMuted: '#8b949e',
            tableHead: '#161b22', tableRowEven: '#1c2128', tableRowOdd: '#161b22',
            pairOutHead: '#1f6feb', pairInHead: '#238636', pairOutBg: '#12202e', pairInBg: '#12241c',
            dataOut: '#12202e', dataIn: '#12241c', flewBg: '#0d1117', dataCardHead: '#161b22',
            rmsHead: '#161b22', rmsRowEven: '#1c2128',
            smHead: '#161b22', smKeep: '#F7DC6F', smAttn: '#F5B7B1', smDown: '#8E1B2F', smUp: '#7DCEA0', smFlew: '#30363d',
            todayHead: '#161b22', todayCard: '#161b22', todayActive: '#e6edf3', crHead: '#161b22', crTotals: '#21262d', crRowEven: '#1c2128', rpHead: '#161b22', rpRowEven: '#1c2128'
        }
    };

    const DEFAULTS = { ...PRESETS.krasavia };

    const MAIN_BORDER_MAP = {
        mainOpen: '--main-chip-open-border',
        mainLow: '--main-chip-low-border',
        mainFull: '--main-chip-full-border',
        mainClosed: '--main-chip-closed-border',
        mainFlew: '--main-chip-flew-border'
    };

    function getStorageKey() {
        const id = (typeof ProfileAuth !== 'undefined' && ProfileAuth.getCurrentProfile()?.id) || 'guest';
        return STORAGE_PREFIX + id;
    }

    function load() {
        try {
            const raw = localStorage.getItem(getStorageKey());
            if (!raw) return { ...DEFAULTS };
            const saved = JSON.parse(raw);
            const theme = { ...DEFAULTS, ...saved };
            // Тема сохранена до появления цветов новых вкладок — берём их из её же цветов, а не из светлого шаблона.
            const has = (k) => Object.prototype.hasOwnProperty.call(saved, k);
            const dark = hexLuminance(theme.bg || DEFAULTS.bg) < 0.25;
            const derive = {
                todayHead: () => theme.tableHead,
                crHead: () => theme.tableHead,
                rpHead: () => theme.tableHead,
                todayCard: () => theme.surface,
                todayActive: () => theme.text,
                crRowEven: () => theme.rmsRowEven || theme.tableRowEven,
                rpRowEven: () => theme.rmsRowEven || theme.tableRowEven,
                crTotals: () => (dark ? shadeColor(theme.surface, 12) : '#e2e8f0')
            };
            Object.keys(derive).forEach(k => { if (!has(k)) { const v = derive[k](); if (v) theme[k] = v; } });
            const oldDown = String(saved.smDown || '').replace('#', '').toUpperCase();
            if (!Object.prototype.hasOwnProperty.call(saved, 'smAttn') && oldDown === 'F5B7B1') {
                theme.smDown = DEFAULTS.smDown;
                theme.smAttn = '#F5B7B1';
            }
            return theme;
        } catch {
            return { ...DEFAULTS };
        }
    }

    function save(theme) {
        const merged = { ...DEFAULTS, ...theme };
        try {
            localStorage.setItem(getStorageKey(), JSON.stringify(merged));
        } catch { /* ignore */ }
        apply(merged, true);
        if (pendingTabOrder && typeof TabOrder !== 'undefined') {
            const full = TabOrder.load();
            const merged = [...pendingTabOrder];
            if (full.includes('stats') && !merged.includes('stats')) merged.push('stats');
            TabOrder.save(merged);
            pendingTabOrder = null;
        }
        if (pendingTabNames && typeof TabOrder !== 'undefined') {
            TabOrder.saveNames(pendingTabNames);
            pendingTabNames = null;
        }
        return merged;
    }

    function shadeColor(hex, percent) {
        const num = parseInt(String(hex).replace('#', ''), 16);
        if (isNaN(num)) return hex;
        const r = Math.min(255, Math.max(0, (num >> 16) + percent));
        const g = Math.min(255, Math.max(0, ((num >> 8) & 0xff) + percent));
        const b = Math.min(255, Math.max(0, (num & 0xff) + percent));
        return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
    }

    function hexLuminance(hex) {
        const num = parseInt(String(hex).replace('#', ''), 16);
        if (isNaN(num)) return 1;
        const toLin = (c) => {
            const s = c / 255;
            return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * toLin(num >> 16) + 0.7152 * toLin((num >> 8) & 255) + 0.0722 * toLin(num & 255);
    }

    function apply(theme, doRefresh) {
        const t = theme || load();
        const root = document.documentElement;
        ALL_FIELDS.forEach(f => {
            const val = t[f.key] || DEFAULTS[f.key];
            if (val) root.style.setProperty(f.css, val);
        });
        Object.entries(MAIN_BORDER_MAP).forEach(([bgKey, cssVar]) => {
            const bg = t[bgKey] || DEFAULTS[bgKey];
            if (bg) root.style.setProperty(cssVar, shadeColor(bg, -18));
        });
        root.style.setProperty('--primary-light', shadeColor(t.navBg || t.primary || DEFAULTS.navBg, 18));
        root.style.setProperty('--accent-hover', shadeColor(t.accent || DEFAULTS.accent, -8));
        const bgHex = t.bg || DEFAULTS.bg;
        const isDark = hexLuminance(bgHex) < 0.25;
        root.dataset.theme = isDark ? 'dark' : 'light';
        root.style.colorScheme = isDark ? 'dark' : 'light';
        if (typeof applyChartThemeColors === 'function') setTimeout(applyChartThemeColors, 0);
        const surface = t.surface || DEFAULTS.surface;
        root.style.setProperty('--muted-bg', isDark ? shadeColor(surface, 10) : '#f8fafc');
        root.style.setProperty('--hover-bg', isDark ? shadeColor(surface, 18) : '#f1f5f9');
        [
            ['smKeep', '--sm-keep-text'],
            ['smAttn', '--sm-attn-text'],
            ['smDown', '--sm-down-text'],
            ['smUp', '--sm-up-text'],
            ['smFlew', '--sm-flew-text'],
            ['smHead', '--sm-head-text'],
            ['crTotals', '--cr-totals-text']
        ].forEach(([key, cssVar]) => {
            const hex = t[key] || DEFAULTS[key];
            if (hex) root.style.setProperty(cssVar, hexLuminance(hex) < 0.45 ? '#ffffff' : '#1c2833');
        });
        if (doRefresh) refreshViews();
    }

    function refreshViews() {
        if (typeof renderTimeline === 'function' && typeof currentTab !== 'undefined' && currentTab === 'main') {
            renderTimeline();
        }
    }

    function schedulePreview(container) {
        clearTimeout(previewTimer);
        previewTimer = setTimeout(() => {
            apply({ ...load(), ...readForm(container) }, false);
        }, 150);
    }

    function reset() {
        try { localStorage.removeItem(getStorageKey()); } catch { /* ignore */ }
        if (typeof TabOrder !== 'undefined') TabOrder.reset();
        pendingTabOrder = null;
        pendingTabNames = null;
        apply(DEFAULTS, true);
        return { ...DEFAULTS };
    }

    function fieldHtml(f, t) {
        return `
            <label class="theme-settings-field">
                <span class="theme-settings-field-head">
                    <span class="theme-settings-label">${f.label}</span>
                    <input type="color" class="theme-color-input" data-key="${f.key}" value="${t[f.key] || DEFAULTS[f.key]}">
                </span>

            </label>`;
    }

    function panelHead(id) {
        let item = null;
        NAV.forEach(g => g.items.forEach(it => { if (it.id === id) item = it; }));
        return item ? `<div class="theme-panel-head"><h4 class="theme-panel-title">${item.label}</h4><p class="theme-panel-hint">${item.hint}</p></div>` : '';
    }

    function buildFormOnce(container) {
        if (formBuilt && container.dataset.built) return;
        const t = load();
        const colorTabs = SECTIONS.filter(s => FIELD_GROUPS[s.id] && s.id !== 'general');
        const colorSub = colorTabs.map((s, i) => `
            <div class="theme-color-sub" data-color-panel="${s.id}"${i === 0 ? '' : ' hidden'}>
                <div class="theme-settings-grid ${s.id === 'main' ? 'theme-settings-grid-main' : ''}">
                    ${FIELD_GROUPS[s.id].map(f => fieldHtml(f, t)).join('')}
                </div>
            </div>
        `).join('');

        container.innerHTML = `
            <div class="theme-settings-layout">
                <nav class="theme-section-nav">
                    ${NAV.map(g => `<div class="theme-nav-group"${g.items.every(it => it.admin) ? ' data-admin-only' : ''}>
                        <div class="theme-nav-group-title">${g.group}</div>
                        ${g.items.map(it => `<button type="button" class="theme-section-tab${it.id === 'general' ? ' active' : ''}" data-section="${it.id}"${it.admin ? ' data-admin-only' : ''}>${it.label}</button>`).join('')}
                    </div>`).join('')}
                </nav>
                <div class="theme-section-panels">
                    <div class="theme-section-panel active" data-section="general">
                        ${panelHead('general')}
                        <div class="theme-presets">
                            ${Object.entries(PRESETS).map(([id, p]) => `
                                <button type="button" class="theme-preset-btn" data-preset="${id}">${p.name}</button>
                            `).join('')}
                        </div>
                        <div class="theme-settings-grid">${FIELD_GROUPS.general.map(f => fieldHtml(f, t)).join('')}</div>
                        <label id="theme-home-map-wrap" class="profile-home-flag" hidden>
                            <input type="checkbox" id="theme-show-home-map"> Показывать главную страницу (карта сети) при входе
                        </label>
                    </div>
                    <div class="theme-section-panel" data-section="colors" hidden>
                        ${panelHead('colors')}
                        <div class="theme-color-chips">${colorTabs.map((s, i) => `<button type="button" class="theme-color-chip${i === 0 ? ' active' : ''}" data-color-sub="${s.id}">${s.label}</button>`).join('')}</div>
                        ${colorSub}
                    </div>
                    <div class="theme-section-panel" data-section="tabs" hidden>
                        ${panelHead('tabs')}
                        <div id="theme-tab-order-editor"></div>
                    </div>
                    <div class="theme-section-panel" data-section="excel" hidden>
                        ${panelHead('excel')}
                        <div id="theme-excel-folders" class="theme-excel-folders"></div>
                    </div>
                    <div class="theme-section-panel" data-section="salesAdmin" hidden>
                        ${panelHead('salesAdmin')}
                        <div id="theme-sales-routes-wrap" class="theme-sales-routes" hidden></div>
                        <div id="theme-sales-ranges-wrap" class="theme-sales-routes" hidden></div>
                    </div>
                    <div class="theme-section-panel" data-section="params" hidden>
                        ${panelHead('params')}
                        <div id="theme-params-wrap" class="theme-params"></div>
                    </div>
                    <div class="theme-section-panel" data-section="password" hidden>
                        ${panelHead('password')}
                        <div class="theme-password-block">
                            <label class="theme-password-field"><span>Текущий пароль</span>
                                <input type="password" id="settings-pwd-current" class="theme-password-input" autocomplete="current-password"></label>
                            <label class="theme-password-field"><span>Новый пароль</span>
                                <input type="password" id="settings-pwd-new" class="theme-password-input" autocomplete="new-password" placeholder=""></label>
                            <label class="theme-password-field"><span>Повторите</span>
                                <input type="password" id="settings-pwd-confirm" class="theme-password-input" autocomplete="new-password"></label>
                            <p id="settings-pwd-error" class="theme-password-error"></p>
                            <button type="button" id="settings-pwd-save" class="btn-secondary theme-password-save-btn">Сменить пароль</button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        container.dataset.built = '1';
        formBuilt = true;
        bindFormEvents(container);
        showSection(container, 'general');
    }

    function showSection(container, sectionId) {
        container.querySelectorAll('.theme-section-tab').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.section === sectionId);
        });
        container.querySelectorAll('.theme-section-panel').forEach(panel => {
            const on = panel.dataset.section === sectionId;
            panel.hidden = !on;
            panel.classList.toggle('active', on);
        });
        if (sectionId === 'tabs' && typeof TabOrder !== 'undefined') {
            const editor = container.querySelector('#theme-tab-order-editor');
            if (editor) {
                TabOrder.renderEditor(editor, (order) => { pendingTabOrder = order; }, pendingTabOrder || TabOrder.getEditableTabs(),
                    (names) => { pendingTabNames = names; }, pendingTabNames || TabOrder.loadNames());
            }
        }
        if (sectionId === 'excel') renderExcelFolders(container);
        if (sectionId === 'params') renderParams(container);
        // «Сбросить цвета» — только в разделах оформления.
        const resetBtn = document.getElementById('profile-settings-reset');
        if (resetBtn) resetBtn.hidden = !(sectionId === 'general' || sectionId === 'colors');
    }

    // ---------- Параметры расчётов (только администратор) ----------
    let paramsFilter = '';

    function renderParams(container) {
        const wrap = container.querySelector('#theme-params-wrap');
        const prof = typeof ProfileAuth !== 'undefined' ? ProfileAuth.getCurrentProfile() : null;
        if (!wrap) return;
        if (typeof Params === 'undefined' || !prof || !prof.isAdmin) { wrap.innerHTML = '<p class="theme-section-hint">Только для администратора.</p>'; return; }
        const esc = (v) => (typeof escHtml === 'function' ? escHtml(v) : String(v));
        const fmtN = (v) => String(v).replace('.', ',');
        const q = paramsFilter.trim().toLowerCase();
        const defs = Params.defs().filter(d => !q || (d.group + ' ' + d.label + ' ' + d.hint + ' ' + d.key).toLowerCase().includes(q));
        const groups = [];
        defs.forEach(d => { let g = groups.find(x => x.name === d.group); if (!g) { g = { name: d.group, items: [] }; groups.push(g); } g.items.push(d); });
        const meta = Params.meta();
        const changed = Params.defs().filter(d => d.value !== d.def).length;
        wrap.innerHTML = `
            <div class="theme-params-bar">
                <input type="search" id="theme-params-search" class="theme-password-input" placeholder="Найти параметр…" value="${esc(paramsFilter)}">
                <span class="theme-section-hint">${changed ? `Изменено: ${changed}` : 'Все значения по умолчанию'}${meta.updatedAt ? ` · сохранено ${esc(new Date(meta.updatedAt).toLocaleString('ru-RU'))}${meta.by ? ', ' + esc(meta.by) : ''}` : ''}</span>
            </div>
            ${groups.map(g => `<div class="theme-params-group"><div class="theme-params-title">${esc(g.name)}</div>
                ${g.items.map(d => `<label class="theme-param${d.value !== d.def ? ' theme-param-changed' : ''}">
                    <span class="theme-param-label">${esc(d.label)}${d.hint ? `<span class="theme-param-hint">${esc(d.hint)}</span>` : ''}</span>
                    ${d.min === 0 && d.max === 1 && d.step === 1
        ? `<select class="theme-param-input" data-param="${d.key}"><option value="1"${d.value === 1 ? ' selected' : ''}>Включено</option><option value="0"${d.value === 0 ? ' selected' : ''}>Выключено</option></select>
                    <span class="theme-param-def">по умолч. ${d.def ? 'включено' : 'выключено'}</span>`
        : `<input type="number" class="theme-param-input" data-param="${d.key}" value="${d.value}" min="${d.min}" max="${d.max}" step="${d.step}">
                    <span class="theme-param-def">по умолч. ${fmtN(d.def)} · ${fmtN(d.min)}…${fmtN(d.max)}</span>`}
                    <button type="button" class="theme-param-reset" data-param-reset="${d.key}" title="Вернуть стандартное: ${fmtN(d.def)}"${d.value === d.def ? ' disabled' : ''}>↺</button>
                </label>`).join('')}</div>`).join('') || '<p class="theme-section-hint">Ничего не найдено.</p>'}
            <div class="theme-params-actions">
                <button type="button" class="btn-primary" id="theme-params-save">Сохранить параметры</button>
                <button type="button" class="btn-secondary" id="theme-params-defaults">Всё по умолчанию</button>
                <span id="theme-params-status" class="theme-section-hint"></span>
            </div>`;
        if (wrap.dataset.bound) return;
        wrap.dataset.bound = '1';
        wrap.addEventListener('input', (e) => {
            if (e.target.id !== 'theme-params-search') return;
            paramsFilter = e.target.value;
            const pos = e.target.selectionStart;
            renderParams(container);
            const s = wrap.querySelector('#theme-params-search');
            if (s) { s.focus(); try { s.setSelectionRange(pos, pos); } catch (err) { /* ignore */ } }
        });
        wrap.addEventListener('click', async (e) => {
            const r = e.target.closest('[data-param-reset]');
            if (r) {
                e.preventDefault();
                const d = Params.defs().find(x => x.key === r.dataset.paramReset);
                const inp = wrap.querySelector(`[data-param="${r.dataset.paramReset}"]`);
                if (d && inp) inp.value = d.def;
                return;
            }
            const id = e.target.id;
            if (id !== 'theme-params-save' && id !== 'theme-params-defaults') return;
            if (id === 'theme-params-defaults') {
                if (!confirm('Вернуть все параметры расчётов к значениям по умолчанию? Изменится у всех.')) return;
                wrap.querySelectorAll('[data-param]').forEach(inp => { const d = Params.defs().find(x => x.key === inp.dataset.param); if (d) inp.value = d.def; });
            }
            // Скрытые поиском параметры не трогаем — берём их нынешние значения.
            const vals = {};
            Params.defs().forEach(d => { vals[d.key] = d.value; });
            let empty = '';
            wrap.querySelectorAll('[data-param]').forEach(inp => {
                if (!String(inp.value).trim() || !isFinite(parseFloat(String(inp.value).replace(',', '.')))) {
                    if (!empty) empty = (Params.defs().find(x => x.key === inp.dataset.param) || {}).label || inp.dataset.param;
                    return;
                }
                vals[inp.dataset.param] = inp.value;
            });
            const st = wrap.querySelector('#theme-params-status');
            // Пустое поле не сбрасываем молча к значению по умолчанию — просим заполнить.
            if (empty) { if (typeof showToast === 'function') showToast(`Заполните: «${empty}»`, 'error'); if (st) st.textContent = ''; return; }
            if (st) st.textContent = 'Сохраняю…';
            const res = await Params.save(vals);
            if (res.invalid) { if (typeof showToast === 'function') showToast(res.error, 'error'); if (st) st.textContent = ''; return; }
            if (typeof showToast === 'function') showToast(res.ok ? 'Параметры сохранены — действуют у всех' : 'Параметры применены здесь, но не записаны в общую папку', res.ok ? 'success' : 'error');
            if (typeof refreshCurrentView === 'function') refreshCurrentView();
            renderParams(container);
        });
    }

    function renderExcelFolders(container) {
        const host = container.querySelector('#theme-excel-folders');
        if (!host || typeof excelFolderKinds !== 'function') return;
        const supported = typeof excelFoldersSupported !== 'function' || excelFoldersSupported();
        const paint = (items) => {
            host.innerHTML = `
                <p class="theme-excel-note">У каждого файла своя папка на этом компьютере. Утренняя и вечерняя выгрузка одного дня — один файл: вечерний заменяет утренний. Завтра сохраняется новый файл. Если сегодняшний файл открыт в Excel, закройте его перед повторной выгрузкой. Без выбранной папки браузер только скачивает копию и не может заменить уже скачанный файл.</p>
                ${supported ? '' : '<p class="theme-excel-note">Выбор папки работает в Chrome или Edge, когда сайт открыт через запуск КРАСАВИА, а не как файл с диска.</p>'}
                ${items.map(item => `
                    <div class="theme-excel-row">
                        <div>
                            <strong>${escSetting(item.label)}</strong>
                            <span class="theme-excel-path" data-excel-path="${escSettingAttr(item.id)}">${item.name ? escSetting(item.name) : 'Папка не выбрана — файл скачается'}</span>
                        </div>
                        <button type="button" class="filter-btn" data-excel-pick="${escSettingAttr(item.id)}"${supported ? '' : ' disabled'}>Выбрать папку</button>
                        <button type="button" class="filter-btn" data-excel-clear="${escSettingAttr(item.id)}"${item.name ? '' : ' disabled'}>Сброс</button>
                    </div>
                `).join('')}
            `;
        };
        paint(excelFolderKinds());
        if (typeof excelFolderCatalog !== 'function') return;
        excelFolderCatalog().then(paint).catch(() => {});
    }

    function updateInputsFromTheme(container, theme) {
        container.querySelectorAll('.theme-color-input').forEach(inp => {
            const key = inp.dataset.key;
            if (theme[key]) inp.value = theme[key];
        });
    }

    function readForm(container) {
        const theme = {};
        container.querySelectorAll('.theme-color-input').forEach(inp => {
            theme[inp.dataset.key] = inp.value;
        });
        return theme;
    }

    function bindFormEvents(container) {
        // Форма пересобирается («Сбросить»), а контейнер тот же — обработчики вешаем один раз.
        if (container.dataset.eventsBound) return;
        container.dataset.eventsBound = '1';
        container.addEventListener('click', (e) => {
            const presetBtn = e.target.closest('.theme-preset-btn');
            if (presetBtn) {
                const preset = PRESETS[presetBtn.dataset.preset];
                if (!preset) return;
                const merged = { ...load(), ...preset };
                updateInputsFromTheme(container, merged);
                apply(merged, false);
                return;
            }

            const sectionTab = e.target.closest('.theme-section-tab');
            if (sectionTab) {
                showSection(container, sectionTab.dataset.section);
                return;
            }

            const colorChip = e.target.closest('[data-color-sub]');
            if (colorChip) {
                const id = colorChip.dataset.colorSub;
                container.querySelectorAll('[data-color-sub]').forEach(b => b.classList.toggle('active', b === colorChip));
                container.querySelectorAll('[data-color-panel]').forEach(p => { p.hidden = p.dataset.colorPanel !== id; });
                return;
            }

            const pick = e.target.closest('[data-excel-pick]');
            if (pick && typeof excelPickFolder === 'function') {
                const kind = pick.dataset.excelPick;
                excelPickFolder(kind).then(name => {
                    const path = container.querySelector(`[data-excel-path="${kind}"]`);
                    if (path) path.textContent = name || 'Папка не выбрана — файл скачается';
                    const clear = container.querySelector(`[data-excel-clear="${kind}"]`);
                    if (clear) clear.disabled = !name;
                    if (name && typeof showToast === 'function') showToast('Папка для выгрузки: ' + name);
                }).catch(err => {
                    if (err && err.name === 'AbortError') return;
                    if (typeof showToast === 'function') {
                        showToast(err && err.message === 'unsupported'
                            ? 'Выбор папки доступен в Chrome или Edge при запуске через КРАСАВИА'
                            : 'Не удалось выбрать папку', 'error');
                    }
                });
                return;
            }

            const clearExcel = e.target.closest('[data-excel-clear]');
            if (clearExcel && typeof excelClearFolder === 'function') {
                const kind = clearExcel.dataset.excelClear;
                excelClearFolder(kind).then(() => {
                    const path = container.querySelector(`[data-excel-path="${kind}"]`);
                    if (path) path.textContent = 'Папка не выбрана — файл скачается';
                    clearExcel.disabled = true;
                    if (typeof showToast === 'function') showToast('Папка сброшена, файл будет скачиваться');
                }).catch(() => {
                    if (typeof showToast === 'function') showToast('Не удалось сбросить папку', 'error');
                });
                return;
            }

            if (e.target.id === 'settings-pwd-save') {
                handlePasswordSave(container);
            }
        });

        container.addEventListener('input', (e) => {
            if (e.target.classList.contains('theme-color-input')) {
                schedulePreview(container);
            }
        });
    }

    async function handlePasswordSave(container) {
        const errEl = container.querySelector('#settings-pwd-error');
        const btn = container.querySelector('#settings-pwd-save');
        const currentPwd = container.querySelector('#settings-pwd-current')?.value || '';
        const newPwd = container.querySelector('#settings-pwd-new')?.value || '';
        const confirmPwd = container.querySelector('#settings-pwd-confirm')?.value || '';

        if (typeof ProfileAuth === 'undefined' || typeof ProfileAuth.changeOwnPassword !== 'function') {
            if (errEl) errEl.textContent = 'Смена пароля недоступна';
            return;
        }
        if (btn) btn.disabled = true;
        const result = await ProfileAuth.changeOwnPassword(currentPwd, newPwd, confirmPwd);
        if (btn) btn.disabled = false;
        if (!result.ok) {
            if (errEl) errEl.textContent = result.error;
            return;
        }
        if (errEl) errEl.textContent = '';
        ['settings-pwd-current', 'settings-pwd-new', 'settings-pwd-confirm'].forEach(id => {
            const el = container.querySelector('#' + id);
            if (el) el.value = '';
        });
        if (typeof showToast === 'function') showToast('Пароль изменён');
    }

    function escSetting(value) {
        return typeof escHtml === 'function' ? escHtml(value) : String(value ?? '');
    }

    function escSettingAttr(value) {
        return typeof escAttr === 'function' ? escAttr(value) : String(value ?? '');
    }

    function fillSalesRoutes(body, prof) {
        const wrap = body.querySelector('#theme-sales-routes-wrap');
        if (!wrap) return;
        const isAdmin = !!(prof && prof.isAdmin);
        wrap.hidden = !isAdmin;
        if (!isAdmin || typeof SalesManagement === 'undefined' || typeof SalesManagement.routeChoices !== 'function') return;
        const choices = SalesManagement.routeChoices();
        const enabled = SalesManagement.getEnabledRoutes();
        const allOn = !Array.isArray(enabled);
        const boxes = choices.map(name => {
            const on = allOn || enabled.indexOf(name) !== -1;
            return `<label><input type="checkbox" class="theme-sales-route" value="${escSettingAttr(name)}"${on ? ' checked' : ''}> ${escSetting(name)}</label>`;
        }).join('');
        wrap.innerHTML = `
            <h3>Маршруты в управлении продажами</h3>
            <p>Отмеченные маршруты видны всем на вкладке и попадают в Excel. Если отмечены все, новые маршруты тоже будут в таблице.</p>
            <label class="theme-sales-routes-all"><input type="checkbox" id="theme-sales-routes-all"${allOn ? ' checked' : ''}> Все маршруты</label>
            <div class="theme-sales-routes-list">${boxes || '<span>Маршруты появятся после загрузки файлов.</span>'}</div>
        `;
        const master = wrap.querySelector('#theme-sales-routes-all');
        const inputs = Array.from(wrap.querySelectorAll('.theme-sales-route'));
        const syncMaster = () => {
            if (!master) return;
            const on = inputs.filter(box => box.checked).length;
            master.checked = inputs.length > 0 && on === inputs.length;
            master.indeterminate = on > 0 && on < inputs.length;
        };
        if (master) {
            master.addEventListener('change', () => {
                inputs.forEach(box => { box.checked = master.checked; });
                master.indeterminate = false;
            });
        }
        inputs.forEach(box => box.addEventListener('change', syncMaster));
        syncMaster();
    }

    function saveSalesRoutes(body) {
        const wrap = body?.querySelector('#theme-sales-routes-wrap');
        if (!wrap || wrap.hidden) return;
        const prof = typeof ProfileAuth !== 'undefined' ? ProfileAuth.getCurrentProfile() : null;
        if (!prof || !prof.isAdmin) return;
        if (typeof SalesManagement === 'undefined' || typeof SalesManagement.setEnabledRoutes !== 'function') return;
        const inputs = Array.from(wrap.querySelectorAll('.theme-sales-route'));
        if (!inputs.length) return;
        const master = wrap.querySelector('#theme-sales-routes-all');
        if (master && master.checked && !master.indeterminate) {
            SalesManagement.setEnabledRoutes(null);
        } else {
            const checked = inputs.filter(box => box.checked).map(box => box.value);
            const visible = new Set(inputs.map(box => box.value));
            const prev = SalesManagement.getEnabledRoutes();
            if (Array.isArray(prev)) {
                prev.forEach(name => {
                    if (!visible.has(name) && checked.indexOf(name) === -1) checked.push(name);
                });
            }
            SalesManagement.setEnabledRoutes(checked);
        }
        if (typeof currentTab !== 'undefined' && currentTab === 'sales' && typeof refreshSalesManagement === 'function') {
            refreshSalesManagement(false);
        }
    }

    function salesIsoToRu(iso) {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
        return match ? (match[3] + '.' + match[2] + '.' + match[1]) : '';
    }

    function salesRuToIso(ru) {
        const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(ru || ''));
        return match ? (match[3] + '-' + match[2] + '-' + match[1]) : '';
    }

    function fillSalesRanges(body, prof) {
        const wrap = body.querySelector('#theme-sales-ranges-wrap');
        if (!wrap) return;
        const isAdmin = !!(prof && prof.isAdmin);
        wrap.hidden = !isAdmin;
        if (!isAdmin || typeof SalesManagement === 'undefined' || typeof SalesManagement.getRanges !== 'function') return;
        const ranges = SalesManagement.getRanges();
        const field = (id, label, value) => `
            <label>${label}
                <input type="date" id="${id}" value="${escSettingAttr(salesRuToIso(value))}">
            </label>`;
        const todayIso = salesRuToIso(typeof getTodayDate === 'function' ? getTodayDate() : ranges.colsFrom);
        wrap.innerHTML = `
            <h3>Период строк и столбцов</h3>
            <p>Строки — даты вылета. «С» меняется только здесь, «По» доходит до самого позднего рейса в загрузке. Столбцы — даты заполнения: слева сегодня, вправо более ранние дни до даты «с». Завтра новый день встанет слева сам. Будущих дат в столбцах нет.</p>
            <div class="theme-sales-range-grid">
                ${field('theme-sales-rows-from', 'Строки, с', ranges.rowsFrom)}
                ${field('theme-sales-rows-to', 'Строки, по', ranges.rowsTo)}
                ${field('theme-sales-cols-from', 'Столбцы, с', ranges.colsFrom)}
                <label>Столбцы, по
                    <input type="date" id="theme-sales-cols-to" value="${escSettingAttr(todayIso)}" disabled>
                </label>
            </div>
        `;
    }

    function saveSalesRanges(body) {
        const wrap = body?.querySelector('#theme-sales-ranges-wrap');
        if (!wrap || wrap.hidden) return true;
        const prof = typeof ProfileAuth !== 'undefined' ? ProfileAuth.getCurrentProfile() : null;
        if (!prof || !prof.isAdmin) return true;
        if (typeof SalesManagement === 'undefined' || typeof SalesManagement.setRanges !== 'function') return true;
        const read = (id) => salesIsoToRu(wrap.querySelector('#' + id)?.value || '');
        const next = {
            rowsFrom: read('theme-sales-rows-from'),
            rowsTo: read('theme-sales-rows-to'),
            colsFrom: read('theme-sales-cols-from'),
            colsTo: read('theme-sales-cols-to')
        };
        if (next.colsFrom && next.colsTo && typeof compareDateStr === 'function' && compareDateStr(next.colsFrom, next.colsTo) > 0) {
            next.colsTo = next.colsFrom;
        }
        if (!next.rowsFrom || !next.rowsTo || !next.colsFrom || !next.colsTo) {
            if (typeof showToast === 'function') showToast('Укажите все четыре даты периода', 'error');
            return false;
        }
        if (!SalesManagement.setRanges(next)) {
            if (typeof showToast === 'function') showToast('Дата «с» должна быть не позже даты «по»', 'error');
            return false;
        }
        if (typeof currentTab !== 'undefined' && currentTab === 'sales' && typeof refreshSalesManagement === 'function') {
            refreshSalesManagement(false);
        }
        return true;
    }

    function syncAdminSettings(body) {
        if (!body) return;
        const prof = typeof ProfileAuth !== 'undefined' ? ProfileAuth.getCurrentProfile() : null;
        const homeWrap = body.querySelector('#theme-home-map-wrap');
        const homeCb = body.querySelector('#theme-show-home-map');
        if (homeWrap && homeCb) {
            const show = !!(prof && prof.isAdmin);
            homeWrap.hidden = !show;
            homeCb.checked = !!(prof && prof.isAdmin && prof.showHomeMap !== false);
        }
        fillSalesRoutes(body, prof);
        fillSalesRanges(body, prof);
        // Пункты «только для администратора» — в меню только у него.
        const isAdmin = !!(prof && prof.isAdmin);
        body.querySelectorAll('.theme-section-nav [data-admin-only]').forEach(el => { el.hidden = !isAdmin; });
        if (!isAdmin && body.querySelector('.theme-section-panel[data-section="salesAdmin"].active, .theme-section-panel[data-section="params"].active')) showSection(body, 'general');
        if (isAdmin && body.querySelector('.theme-section-panel[data-section="params"].active')) renderParams(body);
    }

    function openModal() {
        const modal = document.getElementById('profile-settings-modal');
        const body = document.getElementById('profile-settings-body');
        if (!modal || !body) return;
        pendingTabOrder = typeof TabOrder !== 'undefined' ? TabOrder.getEditableTabs() : null;
        pendingTabNames = null;
        // Раздел «Вкладки» мог остаться открытым с прошлого раза — перерисовать с сохранёнными данными.
        const tabsOpen = body.querySelector('.theme-section-panel[data-section="tabs"].active');
        if (tabsOpen) showSection(body, 'tabs');
        buildFormOnce(body);
        // Форма строится один раз — цвета в ней заполняем заново: после смены профиля там были бы чужие.
        updateInputsFromTheme(body, load());
        syncAdminSettings(body);
        if (body.querySelector('.theme-section-panel[data-section="excel"].active')) renderExcelFolders(body);
        modal.classList.add('open');
    }

    // Закрыли без «Сохранить» — убрать предпросмотр, вернуть сохранённые цвета.
    function closeModal() {
        const modal = document.getElementById('profile-settings-modal');
        if (!modal || !modal.classList.contains('open')) return;
        modal.classList.remove('open');
        clearTimeout(previewTimer);
        apply(load(), false);
    }

    function init() {
        apply(load(), false);
        if (typeof TabOrder !== 'undefined') TabOrder.apply();
        document.getElementById('profile-settings-btn')?.addEventListener('click', openModal);
        // Esc закрывает настройки, как и остальные окна.
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && document.getElementById('profile-settings-modal')?.classList.contains('open')) closeModal();
        });
        document.getElementById('profile-settings-close')?.addEventListener('click', closeModal);
        document.getElementById('profile-settings-save')?.addEventListener('click', () => {
            const bodyEl = document.getElementById('profile-settings-body');
            if (!saveSalesRanges(bodyEl)) return;
            save(readForm(bodyEl));
            const homeCb = bodyEl?.querySelector('#theme-show-home-map');
            if (homeCb && typeof ProfileAuth !== 'undefined' && ProfileAuth.setShowHomeMap) {
                ProfileAuth.setShowHomeMap(!!homeCb.checked);
            }
            saveSalesRoutes(bodyEl);
            closeModal();
            if (typeof showToast === 'function') showToast('Настройки сохранены');
        });
        document.getElementById('profile-settings-reset')?.addEventListener('click', () => {
            reset();
            const bodyEl = document.getElementById('profile-settings-body');
            if (bodyEl) {
                delete bodyEl.dataset.built;
                formBuilt = false;
                buildFormOnce(bodyEl);
                syncAdminSettings(bodyEl);
            }
            if (typeof showToast === 'function') showToast('Сброшено к стандартному шаблону');
        });
        document.getElementById('profile-settings-modal')?.addEventListener('click', (e) => {
            if (e.target.classList.contains('profile-admin-backdrop')) closeModal();
        });
    }

    return { init, load, save, apply, reset, openModal, closeModal, DEFAULTS, PRESETS };
})();