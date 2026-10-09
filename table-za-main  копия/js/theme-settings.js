// Настройки оформления — по вкладкам, per profile
window.ThemeSettings = (function () {
    const STORAGE_PREFIX = 'krasavia_theme_';
    let previewTimer = null;
    let formBuilt = false;
    let pendingTabOrder = null;

    const SECTIONS = [
        { id: 'general', label: 'Общее' },
        { id: 'main', label: 'Графический план' },
        { id: 'table', label: 'Динамика продаж' },
        { id: 'pair', label: 'Экономическая таблица' },
        { id: 'data', label: 'Загрузка рейсов' },
        { id: 'rms', label: 'RMS' },
        { id: 'sales', label: 'Управление продажами' },
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
        ]
    };

    const ALL_FIELDS = Object.values(FIELD_GROUPS).flat();

    const PRESETS = {
        // «Офис» — светлая спокойная тема по умолчанию (редизайн «Светлый офис»).
        office: {
            name: 'Офис (светлая)',
            mainOpen: '#24324a', mainOpenText: '#ffffff', mainLow: '#fff7ed', mainLowText: '#9a3412',
            mainFull: '#ecfdf5', mainFullText: '#047857', mainClosed: '#fef2f2', mainClosedText: '#991b1b',
            mainFlew: '#f1f1ee', mainFlewText: '#6b7280',
            primary: '#1f2328', navBg: '#1f2328', accent: '#2563eb', bg: '#f7f7f5', surface: '#ffffff',
            border: '#e7e7e3', text: '#1f2328', textMuted: '#6b7280',
            tableHead: '#2b2f36', tableRowEven: '#f4f4f1', tableRowOdd: '#ffffff',
            pairOutHead: '#2f4a6d', pairInHead: '#2d6a4f', pairOutBg: '#f3f6fa', pairInBg: '#f2f8f4',
            dataOut: '#f3f6fa', dataIn: '#f2f8f4', flewBg: '#ececea', dataCardHead: '#fafaf9',
            rmsHead: '#2b2f36', rmsRowEven: '#f6f6f3',
            smHead: '#2b2f36', smKeep: '#F7DC6F', smAttn: '#F5B7B1', smDown: '#8E1B2F', smUp: '#7DCEA0', smFlew: '#e5e5e2'
        },
        krasavia: {
            name: 'Стандартный',
            mainOpen: '#012A4A', mainOpenText: '#ffffff', mainLow: '#fff7ed', mainLowText: '#9a3412',
            mainFull: '#ecfdf5', mainFullText: '#047857', mainClosed: '#fef2f2', mainClosedText: '#991b1b',
            mainFlew: '#f1f5f9', mainFlewText: '#475569',
            primary: '#012A4A', navBg: '#012A4A', accent: '#10b981', bg: '#f0f4f8', surface: '#ffffff',
            border: '#e2e8f0', text: '#012A4A', textMuted: '#64748b',
            tableHead: '#012A4A', tableRowEven: '#dbeafe', tableRowOdd: '#ffffff',
            pairOutHead: '#1e40af', pairInHead: '#047857', pairOutBg: '#eff6ff', pairInBg: '#ecfdf5',
            dataOut: '#eff6ff', dataIn: '#ecfdf5', flewBg: '#e8ecf1', dataCardHead: '#f8fafc',
            rmsHead: '#012A4A', rmsRowEven: '#f1f5f9',
            smHead: '#012A4A', smKeep: '#F7DC6F', smAttn: '#F5B7B1', smDown: '#8E1B2F', smUp: '#7DCEA0', smFlew: '#D5D8DC'
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
            smHead: '#205493', smKeep: '#F7DC6F', smAttn: '#F5B7B1', smDown: '#8E1B2F', smUp: '#7DCEA0', smFlew: '#D5D8DC'
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
            smHead: '#3d434b', smKeep: '#F7DC6F', smAttn: '#F5B7B1', smDown: '#8E1B2F', smUp: '#7DCEA0', smFlew: '#D5D8DC'
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
            smHead: '#161b22', smKeep: '#F7DC6F', smAttn: '#F5B7B1', smDown: '#8E1B2F', smUp: '#7DCEA0', smFlew: '#30363d'
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

    // Палитра по умолчанию — под оформление: новое — «Офис», классическое — прежняя «Стандартная».
    function defaultsNow() {
        const classic = typeof AppShell !== 'undefined' && AppShell.layout() === 'classic';
        const p = { ...(classic ? PRESETS.krasavia : PRESETS.office) };
        delete p.name;
        return p;
    }

    function load() {
        try {
            const raw = localStorage.getItem(getStorageKey());
            if (!raw) return defaultsNow();
            const saved = JSON.parse(raw);
            const theme = { ...DEFAULTS, ...saved };
            const oldDown = String(saved.smDown || '').replace('#', '').toUpperCase();
            if (!Object.prototype.hasOwnProperty.call(saved, 'smAttn') && oldDown === 'F5B7B1') {
                theme.smDown = DEFAULTS.smDown;
                theme.smAttn = '#F5B7B1';
            }
            return theme;
        } catch {
            return defaultsNow();
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
        const surface = t.surface || DEFAULTS.surface;
        root.style.setProperty('--muted-bg', isDark ? shadeColor(surface, 10) : '#f8fafc');
        root.style.setProperty('--hover-bg', isDark ? shadeColor(surface, 18) : '#f1f5f9');
        [
            ['smKeep', '--sm-keep-text'],
            ['smAttn', '--sm-attn-text'],
            ['smDown', '--sm-down-text'],
            ['smUp', '--sm-up-text'],
            ['smFlew', '--sm-flew-text'],
            ['smHead', '--sm-head-text']
        ].forEach(([key, cssVar]) => {
            const hex = t[key] || DEFAULTS[key];
            if (hex) root.style.setProperty(cssVar, hexLuminance(hex) < 0.45 ? '#ffffff' : '#1c2833');
        });
        if (typeof AppShell !== 'undefined') AppShell.syncTheme();
        if (doRefresh) refreshViews();
    }

    // Быстрое переключение темы (кнопка в левом меню): свои цвета отметок УП сохраняются.
    function setPreset(id) {
        const p = PRESETS[id];
        if (!p) return;
        const cur = load();
        const next = { ...p };
        ['smKeep', 'smAttn', 'smDown', 'smUp'].forEach(k => { if (cur[k]) next[k] = cur[k]; });
        delete next.name;
        save(next);
        apply(next, true);
        if (typeof refreshCurrentView === 'function') refreshCurrentView();
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

    function buildFormOnce(container) {
        if (formBuilt && container.dataset.built) return;
        const t = load();
        const colorSections = SECTIONS.filter(s => FIELD_GROUPS[s.id] && s.id !== 'general').map(s => `
            <div class="theme-section-panel" data-section="${s.id}" hidden>
                <div class="theme-settings-grid ${s.id === 'main' ? 'theme-settings-grid-main' : ''}">
                    ${FIELD_GROUPS[s.id].map(f => fieldHtml(f, t)).join('')}
                </div>
                ${s.id === 'sales' ? '<div id="theme-sales-routes-wrap" class="theme-sales-routes" hidden></div><div id="theme-sales-ranges-wrap" class="theme-sales-routes" hidden></div>' : ''}
            </div>
        `).join('');

        const lay = typeof AppShell !== 'undefined' ? AppShell.layout() : 'classic';
        container.innerHTML = `
            <div class="ui-layout-pick" role="radiogroup" aria-label="Оформление">
                <button type="button" class="ui-layout-opt${lay === 'new' ? ' on' : ''}" data-ui-layout="new" role="radio" aria-checked="${lay === 'new'}">
                    <span class="ui-layout-thumb ui-layout-thumb-new"><i></i><b></b></span>
                    <span><strong>Новое оформление</strong><em>Меню слева по разделам, страница «Сегодня», светлая или тёмная тема</em></span>
                </button>
                <button type="button" class="ui-layout-opt${lay === 'classic' ? ' on' : ''}" data-ui-layout="classic" role="radio" aria-checked="${lay === 'classic'}">
                    <span class="ui-layout-thumb ui-layout-thumb-classic"><i></i><b></b></span>
                    <span><strong>Классическое</strong><em>Тёмная шапка и вкладки сверху — как было раньше</em></span>
                </button>
            </div>
            <div class="theme-presets">
                ${Object.entries(PRESETS).map(([id, p]) => `
                    <button type="button" class="theme-preset-btn" data-preset="${id}">${p.name}</button>
                `).join('')}
            </div>
            <div class="theme-settings-layout">
                <nav class="theme-section-nav">
                    ${SECTIONS.map((s, i) => `
                        <button type="button" class="theme-section-tab${i === 0 ? ' active' : ''}" data-section="${s.id}">${s.label}</button>
                    `).join('')}
                </nav>
                <div class="theme-section-panels">
                    <div class="theme-section-panel active" data-section="general">
                        <div class="theme-settings-grid">${FIELD_GROUPS.general.map(f => fieldHtml(f, t)).join('')}</div>
                        <label id="theme-home-map-wrap" class="profile-home-flag" hidden>
                            <input type="checkbox" id="theme-show-home-map"> Показывать главную страницу (карта сети) при входе
                        </label>
                    </div>
                    ${colorSections}
                    <div class="theme-section-panel" data-section="tabs" hidden>
                        <div id="theme-tab-order-editor"></div>
                    </div>
                    <div class="theme-section-panel" data-section="excel" hidden>
                        <div id="theme-excel-folders" class="theme-excel-folders"></div>
                    </div>
                    <div class="theme-section-panel" data-section="password" hidden>
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
                TabOrder.renderEditor(editor, (order) => { pendingTabOrder = order; }, pendingTabOrder || TabOrder.getEditableTabs());
            }
        }
        if (sectionId === 'excel') renderExcelFolders(container);
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
        container.addEventListener('click', (e) => {
            const layBtn = e.target.closest('[data-ui-layout]');
            if (layBtn && typeof AppShell !== 'undefined') {
                AppShell.setLayout(layBtn.dataset.uiLayout, true);
                container.querySelectorAll('[data-ui-layout]').forEach(b => {
                    const on = b === layBtn;
                    b.classList.toggle('on', on);
                    b.setAttribute('aria-checked', String(on));
                });
                updateInputsFromTheme(container, load());
                return;
            }
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
    }

    function openModal() {
        const modal = document.getElementById('profile-settings-modal');
        const body = document.getElementById('profile-settings-body');
        if (!modal || !body) return;
        pendingTabOrder = typeof TabOrder !== 'undefined' ? TabOrder.getEditableTabs() : null;
        buildFormOnce(body);
        syncAdminSettings(body);
        if (body.querySelector('.theme-section-panel[data-section="excel"].active')) renderExcelFolders(body);
        modal.classList.add('open');
    }

    function closeModal() {
        document.getElementById('profile-settings-modal')?.classList.remove('open');
    }

    function init() {
        apply(load(), false);
        if (typeof TabOrder !== 'undefined') TabOrder.apply();
        document.getElementById('profile-settings-btn')?.addEventListener('click', openModal);
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

    return { init, load, save, apply, reset, openModal, closeModal, setPreset, DEFAULTS, PRESETS };
})();