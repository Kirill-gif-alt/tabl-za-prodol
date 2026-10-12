// Профили доступа: 3 пользовательских + администратор
window.ProfileAuth = (function () {
    const STORE_KEY = 'krasavia_profiles_v1';
    const SESSION_KEY = 'krasavia_profile_session';
    const SESSION_TOKEN_KEY = 'krasavia_profile_token';
    const SESSION_NONCE_KEY = 'krasavia_profile_nonce';
    const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
    const PBKDF2_ITERATIONS = 120_000;

    // Права профиля. label — коротко, hint — что именно даёт (видно в «Управлении профилями» под названием).
    const PERMISSIONS = {
        tab_today: { label: 'Сегодня', group: 'Вкладки' },
        tab_main: { label: 'Графический план', group: 'Вкладки' },
        tab_table: { label: 'Динамика продаж', group: 'Вкладки' },
        tab_pkz: { label: 'ПКЗ', group: 'Вкладки' },
        tab_pair: { label: 'Экономическая таблица', group: 'Вкладки' },
        tab_costs: { label: 'Расчёт расходов', group: 'Вкладки' },
        tab_data: { label: 'Загрузка рейсов', group: 'Вкладки' },
        tab_rms: { label: 'RMS', group: 'Вкладки' },
        tab_sales: { label: 'Управление продажами', group: 'Вкладки' },
        tab_creative: { label: 'Творческая', group: 'Вкладки' },
        tab_reports: { label: 'Отчёты', group: 'Вкладки' },
        tab_stats: { label: 'Статистика', group: 'Вкладки', hint: 'журнал действий сотрудников' },
        load_data: { label: 'Загрузка данных', group: 'Данные', hint: 'кнопка «Загрузить»: файлы загрузки рейсов и продаж' },
        share_data: { label: 'Публикация данных для всех', group: 'Данные', hint: 'загруженные данные видят все; архив продаж, журнал прогноза, история продаж' },
        export_excel: { label: 'Выгрузки в Excel', group: 'Данные' },
        sales_detail: { label: 'Детализация продаж', group: 'Данные', hint: 'продажи рейса по дням, тарифы и брони' },
        edit_subsidy: { label: 'Правка субсидии', group: 'Данные', hint: 'отметки субсидии в таблицах' },
        edit_sales_mgmt: { label: 'Управление продажами — менять', group: 'Данные', hint: 'отметки решений ▲▼ и ячейки таблицы' },
        view_fare_refs: { label: 'Тарифы субсидии — видеть', group: 'Справочник', hint: 'без права раздел и суммы пределов скрыты' },
        edit_fare_refs: { label: 'Тарифы субсидии — менять', group: 'Справочник' },
        view_subsidy_ref: { label: 'Периоды, суммы субсидии и себестоимость — видеть', group: 'Справочник' },
        edit_subsidy_ref: { label: 'Периоды, суммы субсидии и себестоимость — менять', group: 'Справочник' },
        view_pkz_nav: { label: 'ПКЗ из NAV — видеть', group: 'Справочник' },
        edit_pkz_nav: { label: 'ПКЗ из NAV — менять', group: 'Справочник', hint: 'и в таблице ПКЗ' },
        edit_flights: { label: 'Справочник рейсов — менять', group: 'Справочник', hint: 'видят все' },
        edit_calendar: { label: 'Календарь событий — менять', group: 'Справочник', hint: 'праздники, каникулы; видят все' },
        view_forecast: { label: 'Прогноз загрузки и предупреждения', group: 'Отчёты', hint: 'отчёт «Прогноз и предупреждения», строка «Модель» в карточке рейса' },
        manage_profiles: { label: 'Управление профилями', group: 'Админ' }
    };

    // Справочник в редакторе профиля — строкой «видеть / менять».
    const REF_PAIRS = [
        { label: 'Тарифы субсидии', view: 'view_fare_refs', edit: 'edit_fare_refs', hint: 'без «видеть» раздел и суммы пределов скрыты' },
        { label: 'Периоды, суммы субсидии и себестоимость', view: 'view_subsidy_ref', edit: 'edit_subsidy_ref' },
        { label: 'ПКЗ из NAV', view: 'view_pkz_nav', edit: 'edit_pkz_nav', hint: '«менять» — и в таблице ПКЗ' },
        { label: 'Справочник рейсов', view: null, edit: 'edit_flights', hint: 'видят все' },
        { label: 'Календарь событий', view: null, edit: 'edit_calendar', hint: 'праздники и каникулы; видят все' }
    ];

    // Шаблоны доступа: быстро отметить типичный набор прав (потом можно поправить).
    const TEMPLATES = {
        view: { label: 'Только просмотр', perms: ['tab_main', 'tab_table', 'tab_rms', 'tab_reports', 'export_excel'] },
        sales: { label: 'Продажи', perms: ['tab_today', 'tab_main', 'tab_table', 'tab_rms', 'tab_sales', 'tab_reports', 'export_excel', 'sales_detail', 'edit_sales_mgmt'] },
        econ: { label: 'Экономика', perms: ['tab_main', 'tab_table', 'tab_pkz', 'tab_pair', 'tab_costs', 'tab_reports', 'export_excel', 'view_fare_refs', 'view_subsidy_ref', 'view_pkz_nav'] },
        all: { label: 'Всё, кроме профилей', perms: null }
    };

    // Функции, которые админ включает и выключает каждому профилю (и себе) в «Управлении профилями».
    // def — значение, пока админ ничего не менял. Хранятся в profile.features.
    const FEATURES = {
        flight_checks: { label: 'Проверка рейсов', hint: 'детский −50% и тариф выше субсидированного: «!», счётчик в шапке, раздел в «Отчётах»', def: true },
        subsidy_mode: { label: 'Метки «С» / «К» у дат вылета', hint: 'субсидия или коммерция — на Графплане, в «Динамике продаж» и RMS', def: true },
        flight_card: { label: 'Карточка рейса', hint: 'клик по рейсу открывает панель с графиком, прогнозом и отметкой решения', def: 'admin' },
        header_kpi: { label: 'Продажи за сегодня в шапке', hint: 'билеты и выручка', def: true },
        morning_summary: { label: 'Утренняя сводка', hint: 'при входе и значок «☀ N»: вылеты на 20 дней, решения, ошибки тарифов, пропуски справочника', def: 'admin' },
        rms_header_alerts: { label: 'Счётчик сигналов RMS «⚠» в шапке', def: true },
        live_flights: { label: 'Самолёты онлайн', hint: 'на карте «Сеть» (Flightradar)', def: true }
    };

    function normalizeFeatures(src) {
        const out = {};
        if (!src || typeof src !== 'object') return out;
        Object.keys(FEATURES).forEach(key => {
            if (typeof src[key] === 'boolean') out[key] = src[key];
        });
        return out;
    }

    function resolveFeature(profile, key) {
        const meta = FEATURES[key];
        if (!meta) return false;
        const f = profile && profile.features;
        if (f && typeof f[key] === 'boolean') return f[key];
        // def: 'admin' — по умолчанию включено только администратору, остальным админ включает сам.
        if (meta.def === 'admin') return !!(profile && profile.isAdmin);
        return meta.def;
    }

    function featureOn(key) {
        return resolveFeature(currentProfile, key);
    }

    const TAB_PERM = {
        today: 'tab_today',
        main: 'tab_main',
        table: 'tab_table',
        pkz: 'tab_pkz',
        pair: 'tab_pair',
        costs: 'tab_costs',
        data: 'tab_data',
        rms: 'tab_rms',
        sales: 'tab_sales',
        creative: 'tab_creative',
        reports: 'tab_reports'
    };

    const DEFAULT_PASSWORDS = {
        admin: '123',
        user1: 'profile1',
        user2: 'profile2',
        user3: 'profile3'
    };
    // Однократный сброс пароля admin → 123 (после поломки hashVer / локального кэша)
    const ADMIN_PWD_FIX_KEY = 'krasavia_admin_pwd_fix_v3';

    let currentProfile = null;
    let profilesCache = null;

    function randomSalt() {
        const arr = new Uint8Array(16);
        crypto.getRandomValues(arr);
        return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
    }

    async function hashPasswordLegacy(password, salt) {
        const data = new TextEncoder().encode(salt + String(password));
        const buf = await crypto.subtle.digest('SHA-256', data);
        return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
    }

    async function hashPasswordPbkdf2(password, salt) {
        const keyMaterial = await crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(String(password)),
            'PBKDF2',
            false,
            ['deriveBits']
        );
        const bits = await crypto.subtle.deriveBits(
            {
                name: 'PBKDF2',
                hash: 'SHA-256',
                salt: new TextEncoder().encode(salt),
                iterations: PBKDF2_ITERATIONS
            },
            keyMaterial,
            256
        );
        return Array.from(new Uint8Array(bits), b => b.toString(16).padStart(2, '0')).join('');
    }

    async function hashPassword(password, salt, hashVer = 2) {
        if (hashVer === 1) return hashPasswordLegacy(password, salt);
        return hashPasswordPbkdf2(password, salt);
    }

    async function makePasswordRecord(password) {
        const salt = randomSalt();
        const hash = await hashPassword(password, salt, 2);
        return { salt, hash, hashVer: 2 };
    }

    async function verifyPassword(password, record) {
        if (!record?.salt || !record?.hash) return false;
        const tryVer = async (ver) => {
            const hash = await hashPassword(password, record.salt, ver);
            if (typeof Security !== 'undefined') {
                return Security.timingSafeEqual(hash, record.hash);
            }
            return hash === record.hash;
        };
        // Явная версия хеша
        if (record.hashVer === 2) return tryVer(2);
        if (record.hashVer === 1) return tryVer(1);
        // Старые записи без hashVer: пробуем PBKDF2, затем legacy
        if (await tryVer(2)) return true;
        return tryVer(1);
    }

    /** Смена пароля самим пользователем — всегда минимум 8 */
    function minPasswordLenSelfChange() {
        return (typeof Security !== 'undefined' && Security.MIN_PASSWORD_LEN) || 8;
    }

    /** Сброс пароля админом (любому профилю) — от 3 символов */
    function minPasswordLenAdminReset() {
        return (typeof Security !== 'undefined' && Security.MIN_PASSWORD_LEN_ADMIN) || 3;
    }

    function minPasswordLenFor(profileOrAdminFlag) {
        // обратная совместимость: для сброса админом — 3; иначе 8
        if (profileOrAdminFlag === true || profileOrAdminFlag === 'admin-reset') {
            return minPasswordLenAdminReset();
        }
        return minPasswordLenSelfChange();
    }

    function applyPasswordRecord(profile, cred) {
        profile.salt = cred.salt;
        profile.hash = cred.hash;
        profile.hashVer = cred.hashVer || 2;
    }

    async function createSessionToken(profile) {
        const ts = Date.now();
        try {
            const nonceBytes = new Uint8Array(16);
            crypto.getRandomValues(nonceBytes);
            const nonce = Array.from(nonceBytes, b => b.toString(16).padStart(2, '0')).join('');
            const data = new TextEncoder().encode(`${profile.id}|${nonce}|${profile.hash || ''}|${ts}`);
            const buf = await crypto.subtle.digest('SHA-256', data);
            const token = Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
            sessionStorage.setItem(SESSION_KEY, profile.id);
            sessionStorage.setItem(SESSION_NONCE_KEY, nonce);
            sessionStorage.setItem(SESSION_TOKEN_KEY, `${ts}|${token}`);
        } catch (e) {
            sessionStorage.removeItem(SESSION_TOKEN_KEY);
            sessionStorage.removeItem(SESSION_NONCE_KEY);
            sessionStorage.setItem(SESSION_KEY, profile.id);
        }
    }

    async function verifySessionToken(profile) {
        const raw = sessionStorage.getItem(SESSION_TOKEN_KEY);
        const nonce = sessionStorage.getItem(SESSION_NONCE_KEY);
        if (!raw || !profile || !nonce) return false;
        if (raw.endsWith('|legacy')) return false;
        const sep = raw.indexOf('|');
        if (sep < 0) return false;
        const ts = parseInt(raw.slice(0, sep), 10);
        const token = raw.slice(sep + 1);
        if (!ts || !token || Date.now() - ts > SESSION_TTL_MS) return false;
        try {
            const data = new TextEncoder().encode(`${profile.id}|${nonce}|${profile.hash || ''}|${ts}`);
            const buf = await crypto.subtle.digest('SHA-256', data);
            const expected = Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
            return typeof Security !== 'undefined'
                ? Security.timingSafeEqual(token, expected)
                : token === expected;
        } catch (e) {
            return false;
        }
    }

    function defaultProfilesTemplate() {
        return [
            {
                id: 'admin',
                name: 'Администратор',
                isAdmin: true,
                permissions: ['*'],
                password: null
            },
            {
                id: 'user1',
                name: 'Профиль 1',
                isAdmin: false,
                permissions: ['tab_main', 'tab_table', 'tab_pkz', 'tab_data', 'tab_sales', 'load_data', 'export_excel', 'sales_detail', 'share_data'],
                password: null
            },
            {
                id: 'user2',
                name: 'Профиль 2',
                isAdmin: false,
                permissions: ['tab_pair', 'tab_costs', 'tab_data', 'tab_rms', 'tab_sales', 'sales_detail'],
                password: null
            },
            {
                id: 'user3',
                name: 'Профиль 3',
                isAdmin: false,
                permissions: ['tab_main', 'tab_data', 'tab_rms', 'tab_sales'],
                password: null
            }
        ];
    }

    async function buildDefaultStore() {
        const list = [];
        for (const tpl of defaultProfilesTemplate()) {
            const pwd = DEFAULT_PASSWORDS[tpl.id] || 'changeme';
            const cred = await makePasswordRecord(pwd);
            list.push({
                id: tpl.id,
                name: tpl.name,
                isAdmin: !!tpl.isAdmin,
                permissions: [...tpl.permissions],
                salt: cred.salt,
                hash: cred.hash,
                hashVer: cred.hashVer || 2
            });
        }
        return list;
    }

    async function ensureAdminPasswordFix() {
        try {
            if (localStorage.getItem(ADMIN_PWD_FIX_KEY) === '1') return;
            if (!profilesCache?.length) return;
            const admin = profilesCache.find(p => p.id === 'admin');
            if (!admin) return;
            admin.isAdmin = true;
            if (!admin.permissions?.length) admin.permissions = ['*'];
            if (!admin.hash) {
                const cred = await makePasswordRecord(DEFAULT_PASSWORDS.admin || '123');
                applyPasswordRecord(admin, cred);
                await saveProfiles(true);
            }
            localStorage.setItem(ADMIN_PWD_FIX_KEY, '1');
        } catch (e) {
            console.warn('ensureAdminPasswordFix', e);
        }
    }

    function migrateSalesViewPermission() {
        let changed = false;
        (profilesCache || []).forEach(p => {
            if (!p || p.salesPermMigrated) return;
            if (!Array.isArray(p.permissions)) p.permissions = [];
            if (!p.permissions.includes('*') && !p.permissions.includes('tab_sales')) {
                p.permissions.push('tab_sales');
            }
            p.salesPermMigrated = true;
            changed = true;
        });
        (profilesCache || []).forEach(p => {
            if (!p || p.tabsSplitMigrated || !Array.isArray(p.permissions)) return;
            if (p.permissions.includes('tab_table') && !p.permissions.includes('tab_pkz')) p.permissions.push('tab_pkz');
            if (p.permissions.includes('tab_pair') && !p.permissions.includes('tab_costs')) p.permissions.push('tab_costs');
            p.tabsSplitMigrated = true;
            changed = true;
        });
        return changed;
    }

    let profilesFromShared = false;

    async function loadProfiles() {
        if (profilesCache) return profilesCache;

        if (typeof SharedStorage !== 'undefined') {
            await SharedStorage.init();
            const shared = await SharedStorage.loadProfiles();
            if (shared?.length) {
                profilesCache = shared;
                profilesFromShared = true;
                persistLocalProfilesCache();
                await ensureAdminPasswordFix();
                if (migrateSalesViewPermission()) await saveProfiles(true);
                return profilesCache;
            }
        }

        try {
            const raw = localStorage.getItem(STORE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed) && parsed.length) {
                    const usable = parsed.some(p => p && p.hash && p.salt);
                    profilesCache = parsed;
                    profilesFromShared = false;
                    if (usable) await ensureAdminPasswordFix();
                    // Локальная копия может быть без паролей и устаревшей — в общий файл её не пишем.
                    if (migrateSalesViewPermission()) persistLocalProfilesCache();
                    return profilesCache;
                }
            }
        } catch (e) {
            console.warn('loadProfiles', e);
        }

        // Стандартные профили пишем в общую папку, только если файла профилей там точно нет.
        // Ошибка чтения или битый файл — не повод затирать все пароли и права.
        let read = { ok: false };
        if (typeof SharedStorage !== 'undefined' && SharedStorage.readJsonFileStrict) {
            read = await SharedStorage.readJsonFileStrict('profiles.json').catch(() => ({ ok: false }));
            if (read.ok && read.data?.profiles?.length) {
                profilesCache = read.data.profiles;
                profilesFromShared = true;
                persistLocalProfilesCache();
                return profilesCache;
            }
        }
        profilesCache = await buildDefaultStore();
        profilesFromShared = false;
        migrateSalesViewPermission();
        if (read.ok) await saveProfiles(true);
        else persistLocalProfilesCache();
        try { localStorage.setItem(ADMIN_PWD_FIX_KEY, '1'); } catch (e) { /* ignore */ }
        return profilesCache;
    }

    function persistLocalProfilesCache() {
        try {
            const linked = typeof SharedStorage !== 'undefined' && SharedStorage.isLinked && SharedStorage.isLinked();
            const payload = linked
                ? (profilesCache || []).map(p => ({
                    id: p.id,
                    name: p.name,
                    isAdmin: !!p.isAdmin,
                    permissions: Array.isArray(p.permissions) ? [...p.permissions] : [],
                    showHomeMap: p.showHomeMap,
                    showScreenWidgets: p.showScreenWidgets,
                    features: normalizeFeatures(p.features),
                    hashVer: p.hashVer || 2,
                    salesPermMigrated: p.salesPermMigrated === true ? true : undefined,
                    tabsSplitMigrated: p.tabsSplitMigrated === true ? true : undefined
                }))
                : profilesCache;
            localStorage.setItem(STORE_KEY, JSON.stringify(payload));
        } catch (e) { /* ignore */ }
    }

    // Запись профилей — поверх свежего файла: каждый ПК держит копию со входа, и запись копии целиком
    // откатывала бы чужие изменения (пароль, сменённый сотрудником после входа админа, права, снятые админом).
    // change: { update: { id: {поля} }, remove: [id], add: [профиль] } — только то, что поменял этот ПК.
    async function saveProfiles(silent, change) {
        if (change && typeof SharedStorage !== 'undefined' && SharedStorage.readJsonFileStrict) {
            const read = await SharedStorage.readJsonFileStrict('profiles.json').catch(() => ({ ok: false }));
            const fresh = read.ok && read.data && Array.isArray(read.data.profiles) ? read.data.profiles : null;
            if (fresh && fresh.length) {
                const removed = new Set(change.remove || []);
                const merged = fresh.filter(p => p && !removed.has(p.id)).map(p => ({ ...p }));
                Object.entries(change.update || {}).forEach(([id, fields]) => {
                    const t = merged.find(p => p.id === id);
                    if (t) Object.assign(t, fields);
                });
                (change.add || []).forEach(p => { if (!merged.some(x => x.id === p.id)) merged.push(p); });
                profilesCache = merged;
            }
        }
        persistLocalProfilesCache();
        if (typeof SharedStorage !== 'undefined') {
            await SharedStorage.saveProfiles(profilesCache, null, silent);
        }
    }

    function updateSharedStatus() {
        const el = document.getElementById('profile-shared-status');
        if (!el || typeof SharedStorage === 'undefined') return;
        if (SharedStorage.isLinked()) {
            el.textContent = 'Общая папка подключена';
            el.className = 'profile-shared-status profile-shared-ok';
        } else if (SharedStorage.needsLinkPrompt()) {
            el.textContent = 'Подключите папку — иначе изменения не увидят другие ПК';
            el.className = 'profile-shared-status profile-shared-warn';
        } else {
            el.textContent = '';
        }
    }

    async function handleLinkFolder(requireAdmin) {
        if (requireAdmin && !guardPermission('manage_profiles', 'Только администратор может управлять общей папкой')) return;
        if (typeof SharedStorage === 'undefined') return;
        const result = await SharedStorage.linkAppFolder();
        if (result.ok) {
            profilesCache = null;
            await loadProfiles();
            // Локальная копия хранится без паролей: если папка не прочиталась, писать её туда нельзя — сотрёт все пароли.
            if (hasPermission('manage_profiles') && profilesCache.every(p => p && p.hash && p.salt)) await saveProfiles(false);
            updateSharedStatus();
            const select = document.getElementById('login-profile-select');
            if (select) {
                select.innerHTML = getPublicProfiles().map(p =>
                    `<option value="${escAttr(p.id)}">${escAttr(p.name)}${p.isAdmin ? ' ★' : ''}</option>`
                ).join('');
            }
            if (typeof showToast === 'function') showToast('Папка приложения подключена');
        } else if (result.error && result.error !== 'Отменено' && typeof showToast === 'function') {
            showToast(result.error, 'error');
        }
    }

    function getPublicProfiles() {
        return (profilesCache || []).map(p => ({
            id: p.id,
            name: p.name,
            isAdmin: !!p.isAdmin
        }));
    }

    function escAttr(s) {
        return typeof Security !== 'undefined' ? Security.escapeAttr(s) : String(s || '');
    }

    function generateProfileId(name) {
        const slug = typeof Security !== 'undefined'
            ? Security.transliterateProfileSlug(name)
            : String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 24);
        let base = slug ? `user_${slug}` : `user_${Date.now()}`;
        let id = base;
        let i = 1;
        while (profilesCache.some(p => p.id === id)) {
            id = `${base}_${i++}`;
        }
        return id;
    }

    // Права в редакторе профиля: вкладки — плитками, данные — переключателями, справочник — «видеть / менять».
    // Каждое право — обычный checkbox с data-profile и data-perm: их читает сохранение и создание профиля.
    function permInput(profileId, key, perms, prefix) {
        return `<input type="checkbox" class="${prefix}profile-perm-cb" data-profile="${escAttr(profileId)}" data-perm="${key}" ${perms.includes(key) ? 'checked' : ''}>`;
    }

    function renderPermCheckboxes(profileId, permissions, prefix = '') {
        const perms = permissions || [];
        const keysOf = (group) => Object.keys(PERMISSIONS).filter(k => PERMISSIONS[k].group === group);
        const tabs = keysOf('Вкладки').map(k => `<label class="pa-chip">${permInput(profileId, k, perms, prefix)}<span>${PERMISSIONS[k].label}</span></label>`).join('');
        const sw = (k) => switchRow(permInput(profileId, k, perms, prefix), PERMISSIONS[k].label, PERMISSIONS[k].hint || '');
        const refs = REF_PAIRS.map(r => `<div class="pa-ref-row" data-pa-ref>
                <span class="pa-switch-text"><span class="pa-switch-label">${r.label}</span>${r.hint ? `<span class="pa-switch-hint">${r.hint}</span>` : ''}</span>
                <label class="pa-ref-opt${r.view ? '' : ' pa-ref-na'}">${r.view ? permInput(profileId, r.view, perms, prefix) + '<span>видеть</span>' : '<span>видят все</span>'}</label>
                <label class="pa-ref-opt">${permInput(profileId, r.edit, perms, prefix)}<span>менять</span></label>
            </div>`).join('');
        return paCard('Шаблон доступа', 'отметит типичный набор прав — потом можно поправить',
                `<div class="pa-templates">${Object.entries(TEMPLATES).map(([id, t]) => `<button type="button" class="pa-template" data-pa-template="${id}" data-pa-target="${escAttr(profileId)}">${t.label}</button>`).join('')}</div>`)
            + paCard('Вкладки', 'какие вкладки видит сотрудник', `<div class="pa-chips">${tabs}</div>`)
            + paCard('Данные и действия', '', `<div class="pa-switch-list">${keysOf('Данные').map(sw).join('')}</div>`)
            + paCard('Справочник', '«менять» включает и «видеть»', `<div class="pa-ref-list">${refs}</div>`)
            + paCard('Отчёты и прогноз', '', `<div class="pa-switch-list">${keysOf('Отчёты').map(sw).join('')}</div>`);
    }

    function hasPermission(perm) {
        if (!currentProfile) return false;
        if (currentProfile.isAdmin || currentProfile.permissions.includes('*')) return true;
        return currentProfile.permissions.includes(perm);
    }

    function resolveShowHomeMap(profile) {
        if (!profile) return false;
        if (profile.showHomeMap === true) return true;
        if (profile.showHomeMap === false) return false;
        return !!profile.isAdmin;
    }

    function resolveScreenWidgets(profile) {
        if (!profile) return false;
        if (profile.showScreenWidgets === true) return true;
        if (profile.showScreenWidgets === false) return false;
        return !!profile.isAdmin;
    }

    // Строка-переключатель: название, пояснение и сам переключатель (обычный checkbox — его читает сохранение).
    function switchRow(inputHtml, label, hint) {
        return `<label class="pa-switch-row">
            <span class="pa-switch-text"><span class="pa-switch-label">${label}</span>${hint ? `<span class="pa-switch-hint">${hint}</span>` : ''}</span>
            <span class="pa-switch">${inputHtml}<span class="pa-switch-ui" aria-hidden="true"></span></span>
        </label>`;
    }

    function featuresBlockHtml(profileId, profile) {
        const id = escAttr(profileId);
        const homeOn = resolveShowHomeMap(profile) ? 'checked' : '';
        const rows = [switchRow(`<input type="checkbox" class="profile-home-map-cb" data-home-map="${id}" ${homeOn}>`, 'Главная страница при входе', 'карта сети')]
            .concat(Object.entries(FEATURES).map(([key, meta]) => switchRow(
                `<input type="checkbox" class="profile-feature-cb" data-profile-feature="${id}" data-feature="${key}" ${resolveFeature(profile, key) ? 'checked' : ''}>`,
                meta.label, meta.hint || '')));
        return paCard('Функции на экране', 'что показывается сотруднику в шапке и на вкладках', `<div class="pa-switch-list">${rows.join('')}</div>`);
    }

    function paCard(title, hint, body, extraCls) {
        return `<section class="pa-card${extraCls ? ' ' + extraCls : ''}">
            <div class="pa-card-head"><h5 class="pa-card-title">${title}</h5>${hint ? `<span class="pa-card-hint">${hint}</span>` : ''}</div>
            ${body}
        </section>`;
    }

    function readFeatureBoxes(profileId) {
        const out = {};
        document.querySelectorAll(`.profile-feature-cb[data-profile-feature="${profileId}"]`).forEach(cb => {
            if (FEATURES[cb.dataset.feature]) out[cb.dataset.feature] = !!cb.checked;
        });
        return out;
    }

    function canAccessTab(tab) {
        if (tab === 'home') return resolveShowHomeMap(currentProfile);
        if (tab === 'stats') return hasPermission('tab_stats');
        const perm = TAB_PERM[tab];
        if (!perm) return false;
        // ПКЗ и «Расчёт расходов» — свои права (раньше открывались с «Динамикой продаж» / «Экономикой»;
        // старым профилям их один раз проставила миграция, дальше админ может их снять).
        return hasPermission(perm);
    }

    function getFirstAllowedTab() {
        const order = ['home', 'main', 'table', 'pkz', 'pair', 'costs', 'data', 'rms', 'sales', 'creative', 'reports', 'today', 'stats'];
        return order.find(t => canAccessTab(t)) || null;
    }

    async function saveSession(profile) {
        await createSessionToken(profile);
    }

    function clearSession() {
        sessionStorage.removeItem(SESSION_KEY);
        sessionStorage.removeItem(SESSION_TOKEN_KEY);
        sessionStorage.removeItem(SESSION_NONCE_KEY);
        currentProfile = null;
    }

    function isKnownProfileId(id) {
        if (!id || typeof id !== 'string') return false;
        if (typeof Security !== 'undefined' && Security.isProfileId(id)) return true;
        return (profilesCache || []).some(p => p.id === id);
    }

    async function login(profileId, password) {
        await loadProfiles();
        if (typeof Security !== 'undefined') {
            const gate = Security.checkLoginAllowed();
            if (!gate.ok) return { ok: false, error: gate.error };
            if (!isKnownProfileId(profileId)) {
                return { ok: false, error: 'Некорректный профиль' };
            }
        }
        const profile = profilesCache.find(p => p.id === profileId);
        if (!profile) return { ok: false, error: 'Профиль не найден' };
        if (!profile.hash || !profile.salt) {
            return { ok: false, error: 'Нет пароля профиля — подключите общую папку приложения' };
        }
        const ok = await verifyPassword(password, profile);
        if (!ok) {
            if (typeof Security !== 'undefined') Security.recordLoginFailure();
            return { ok: false, error: 'Неверный пароль' };
        }
        if (typeof Security !== 'undefined') Security.resetLoginFailures();
        currentProfile = {
            id: profile.id,
            name: profile.name,
            isAdmin: !!profile.isAdmin,
            permissions: [...(profile.permissions || [])],
            showHomeMap: resolveShowHomeMap(profile),
            showScreenWidgets: resolveScreenWidgets(profile),
            features: normalizeFeatures(profile.features)
        };
        await saveSession(profile);
        if (typeof ActivityLog !== 'undefined') {
            ActivityLog.log('login', profile.name);
        }
        return { ok: true };
    }

    async function tryRestoreSession() {
        await loadProfiles();
        const id = sessionStorage.getItem(SESSION_KEY);
        if (!id) return false;
        if (!isKnownProfileId(id)) {
            clearSession();
            return false;
        }
        const profile = profilesCache.find(p => p.id === id);
        if (!profile) {
            clearSession();
            return false;
        }
        if (!(await verifySessionToken(profile))) {
            clearSession();
            return false;
        }
        currentProfile = {
            id: profile.id,
            name: profile.name,
            isAdmin: !!profile.isAdmin,
            permissions: [...(profile.permissions || [])],
            showHomeMap: resolveShowHomeMap(profile),
            showScreenWidgets: resolveScreenWidgets(profile),
            features: normalizeFeatures(profile.features)
        };
        return true;
    }

    function logout() {
        if (typeof ActivityLog !== 'undefined' && currentProfile) {
            ActivityLog.log('logout', currentProfile.name);
        }
        if (typeof Security !== 'undefined') Security.resetLoginFailures();
        clearSession();
        const layout = document.querySelector('.main-layout');
        if (layout) layout.classList.add('app-locked');
        showLoginScreen();
        applyPermissions();
    }

    function applyPermissions() {
        const tabMap = {
            'tab-today': 'tab_today',
            'tab-main': 'tab_main',
            'tab-table': 'tab_table',
            'tab-pkz': 'tab_pkz',
            'tab-pair': 'tab_pair',
            'tab-costs': 'tab_costs',
            'tab-data': 'tab_data',
            'tab-rms': 'tab_rms',
            'tab-sales': 'tab_sales',
            'tab-creative': 'tab_creative',
            'tab-reports': 'tab_reports'
        };
        Object.entries(tabMap).forEach(([elId]) => {
            const btn = document.getElementById(elId);
            // Те же правила, что у доступа к вкладке (ПКЗ — и с «Динамикой продаж», расчёт расходов — и с экономикой).
            if (btn) btn.style.display = canAccessTab(elId.slice(4)) ? '' : 'none';
        });

        const loadBtn = document.getElementById('load-data-btn');
        const restoreBtn = document.getElementById('restore-data-btn');
        if (loadBtn) loadBtn.style.display = hasPermission('load_data') ? '' : 'none';
        if (restoreBtn && restoreBtn.style.display !== 'none' && !hasPermission('load_data')) {
            restoreBtn.style.display = 'none';
        }

        const adminBtn = document.getElementById('profile-admin-btn');
        if (adminBtn) {
            adminBtn.style.display = hasPermission('manage_profiles') ? '' : 'none';
        }
        const statsTab = document.getElementById('tab-stats');
        if (statsTab) {
            statsTab.style.display = canAccessTab('stats') ? '' : 'none';
        }
        const homeTab = document.getElementById('tab-home');
        if (homeTab) {
            homeTab.style.display = canAccessTab('home') ? '' : 'none';
        }

        if (typeof FlightCard !== 'undefined') FlightCard.syncToggle();
        const settingsBtn = document.getElementById('profile-settings-btn');
        if (settingsBtn) {
            settingsBtn.style.display = currentProfile ? '' : 'none';
        }

        const userChip = document.getElementById('profile-user-chip');
        if (userChip && currentProfile) {
            const name = String(currentProfile.name || '').trim() || 'Профиль';
            const initial = name.slice(0, 1).toUpperCase();
            userChip.replaceChildren();
            const av = document.createElement('span');
            av.className = 'profile-user-avatar';
            av.setAttribute('aria-hidden', 'true');
            av.textContent = initial;
            const nm = document.createElement('span');
            nm.className = 'profile-user-name';
            nm.textContent = name;
            userChip.append(av, nm);
            userChip.title = currentProfile.isAdmin ? 'Администратор' : 'Пользователь';
            userChip.classList.toggle('profile-chip-admin', !!currentProfile.isAdmin);
        }

        if (typeof updateFlightOpenModeUI === 'function') updateFlightOpenModeUI();
        if (typeof TabOrder !== 'undefined') TabOrder.apply();
    }

    function guardPermission(perm, message) {
        if (hasPermission(perm)) return true;
        if (typeof showToast === 'function') showToast(message || 'Недостаточно прав', 'error');
        return false;
    }

    function showLoginScreen() {
        const overlay = document.getElementById('login-overlay');
        if (!overlay) return;
        overlay.classList.add('open');
        const select = document.getElementById('login-profile-select');
        if (select) {
            select.innerHTML = getPublicProfiles().map(p =>
                `<option value="${escAttr(p.id)}">${escAttr(p.name)}${p.isAdmin ? ' ★' : ''}</option>`
            ).join('');
        }
        const err = document.getElementById('login-error');
        if (err) err.textContent = '';
        const pwd = document.getElementById('login-password');
        if (pwd) { pwd.value = ''; setTimeout(() => pwd.focus(), 100); }
    }

    function hideLoginScreen() {
        document.getElementById('login-overlay')?.classList.remove('open');
    }

    function bindLoginForm() {
        const form = document.getElementById('login-form');
        if (!form || form.dataset.bound) return;
        form.dataset.bound = '1';
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const profileId = document.getElementById('login-profile-select')?.value;
            const password = document.getElementById('login-password')?.value || '';
            // Доступ к общей папке Chrome возвращает только по клику: просим сразу, пока клик «свежий»,
            // а не после проверки пароля. Иначе после перезапуска браузера папка выглядит отключённой.
            const folderJob = typeof SharedStorage !== 'undefined'
                ? SharedStorage.restoreRootHandle().catch(() => null)
                : Promise.resolve(null);
            const err = document.getElementById('login-error');
            const btn = document.getElementById('login-submit-btn');
            if (btn) btn.disabled = true;
            // Если профили взяты из локальной копии (папка была недоступна), а доступ вернулся —
            // перечитываем общий файл: там актуальные пароли и права.
            await folderJob;
            if (!profilesFromShared && typeof SharedStorage !== 'undefined' && SharedStorage.isLinked()) {
                profilesCache = null;
            }
            const result = await login(profileId, password);
            if (btn) btn.disabled = false;
            if (!result.ok) {
                if (err) err.textContent = result.error;
                return;
            }
            hideLoginScreen();
            document.querySelector('.main-layout')?.classList.remove('app-locked');
            applyPermissions();
            if (typeof SharedStorage !== 'undefined') {
                await folderJob;
                if (!SharedStorage.isLinked() && SharedStorage.needsLinkPrompt()) {
                    await SharedStorage.ensureWritableLink();
                }
            }
            await onLoginSuccess();
        });
    }

    async function onLoginSuccess() {
        if (typeof ThemeSettings !== 'undefined') ThemeSettings.apply();
        if (typeof ActivityLog !== 'undefined') ActivityLog.startBackgroundSync();
        if (typeof loadPinnedFlights === 'function') loadPinnedFlights();
        if (typeof loadFlightOpenMode === 'function') loadFlightOpenMode();
        if (typeof startAppAfterLogin === 'function') {
            await startAppAfterLogin();
            return;
        }
        if (typeof SessionStore !== 'undefined') {
            await SessionStore.initOnStartup();
        } else if (typeof switchMainTab === 'function') {
            const tab = (typeof currentTab !== 'undefined' && canAccessTab(currentTab))
                ? currentTab
                : (getFirstAllowedTab() || 'main');
            switchMainTab(tab);
        }
        applyPermissions();
        if (resolveShowHomeMap(currentProfile) && typeof switchMainTab === 'function') {
            switchMainTab('home');
        }
    }

    let paSelected = 'admin';

    function initialOf(name) {
        return String(name || '?').trim().slice(0, 1).toUpperCase() || '?';
    }

    // «5 вкладок · 3 права» — для списка профилей.
    function permSummary(p) {
        if (p.isAdmin) return 'полный доступ';
        const perms = p.permissions || [];
        const tabs = perms.filter(k => PERMISSIONS[k] && PERMISSIONS[k].group === 'Вкладки').length;
        const other = perms.filter(k => PERMISSIONS[k] && PERMISSIONS[k].group !== 'Вкладки').length;
        const pl = (n, a, b, c) => { const m10 = n % 10; const m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? b : c); };
        return `${tabs} ${pl(tabs, 'вкладка', 'вкладки', 'вкладок')} · ${other} ${pl(other, 'право', 'права', 'прав')}`;
    }

    function editorHtml(p) {
        const isAdminProfile = p.id === 'admin';
        const head = `<header class="pa-head">
                <span class="pa-avatar pa-avatar-lg${p.isAdmin ? ' pa-avatar-admin' : ''}">${escAttr(initialOf(p.name))}</span>
                <div class="pa-head-text">
                    <h4 class="pa-head-name">${escAttr(p.name)}${p.isAdmin ? ' <span class="profile-admin-star">★ Админ</span>' : ''}</h4>
                    <div class="pa-head-sub">ID: ${escAttr(p.id)} · <span data-pa-summary="${escAttr(p.id)}">${permSummary(p)}</span></div>
                </div>
                ${isAdminProfile ? '' : `<button type="button" class="profile-delete-btn" data-delete-profile="${escAttr(p.id)}">Удалить профиль</button>`}
            </header>`;
        const basics = paCard('Основное', '', `<div class="profile-admin-fields">
                <label class="profile-field"><span>Имя (видно в шапке и в отметках решений)</span>
                    <input type="text" class="profile-name-input" data-profile="${escAttr(p.id)}" value="${escAttr(p.name)}"></label>
                <label class="profile-field"><span>Новый пароль — если нужно сбросить</span>
                    <input type="password" class="profile-pass-input" data-profile="${escAttr(p.id)}" placeholder="оставьте пустым, чтобы не менять" autocomplete="new-password"></label>
            </div>`);
        const perms = isAdminProfile
            ? paCard('Доступ', '', '<p class="profile-admin-note">Администратор видит всё, создаёт профили и меняет права других.</p>')
            : renderPermCheckboxes(p.id, p.permissions);
        return `<div class="pa-editor" data-pa-editor="${escAttr(p.id)}"${p.id === paSelected ? '' : ' hidden'}>${head}${basics}${perms}${featuresBlockHtml(p.id, p)}</div>`;
    }

    function newEditorHtml() {
        const basics = paCard('Новый профиль', 'имя и пароль для входа', `<div class="profile-admin-fields">
                <label class="profile-field"><span>Имя</span>
                    <input type="text" id="profile-create-name" class="profile-create-input" placeholder="Например, Иванов И.И."></label>
                <label class="profile-field"><span>Пароль (минимум ${minPasswordLenAdminReset()} символа)</span>
                    <input type="password" id="profile-create-pass" class="profile-create-input" placeholder="Пароль" autocomplete="new-password"></label>
            </div>`);
        return `<div class="pa-editor pa-editor-new" data-pa-editor="__new__"${paSelected === '__new__' ? '' : ' hidden'}>
            ${basics}
            ${renderPermCheckboxes('__new__', ['tab_main', 'tab_sales'], 'profile-create-')}
            ${featuresBlockHtml('__new__', { showHomeMap: false, showScreenWidgets: false })}
            <div class="pa-create-bar">
                <p id="profile-create-error" class="profile-create-error"></p>
                <button type="button" id="profile-admin-create" class="btn-primary profile-create-btn">Создать профиль</button>
            </div>
        </div>`;
    }

    function renderAdminPanel() {
        const body = document.getElementById('profile-admin-body');
        if (!body) return;
        if (paSelected !== '__new__' && !profilesCache.some(p => p.id === paSelected)) paSelected = 'admin';
        const list = profilesCache.map(p => `
            <button type="button" class="pa-item${p.id === paSelected ? ' active' : ''}" data-pa-select="${escAttr(p.id)}" data-pa-name="${escAttr(String(p.name || '').toLowerCase())}">
                <span class="pa-avatar${p.isAdmin ? ' pa-avatar-admin' : ''}">${escAttr(initialOf(p.name))}</span>
                <span class="pa-item-text"><span class="pa-item-name">${escAttr(p.name)}</span><span class="pa-item-sub" data-pa-summary="${escAttr(p.id)}">${permSummary(p)}</span></span>
            </button>`).join('');
        document.getElementById('profile-admin-modal')?.classList.toggle('pa-creating', paSelected === '__new__');
        body.innerHTML = `<div class="pa-layout">
            <aside class="pa-side">
                <button type="button" class="pa-new${paSelected === '__new__' ? ' active' : ''}" data-pa-select="__new__">＋ Новый профиль</button>
                ${profilesCache.length > 6 ? '<input type="search" class="pa-search" placeholder="Найти профиль" aria-label="Найти профиль">' : ''}
                <div class="pa-list">${list}</div>
                <p class="pa-side-note">Изменения прав сохраняются кнопкой «Сохранить изменения» внизу — сразу для всех профилей.</p>
            </aside>
            <div class="pa-main">${newEditorHtml()}${profilesCache.map(editorHtml).join('')}</div>
        </div>`;
    }

    // Новый профиль — в список и редактор без перерисовки всего окна; форма создания очищается.
    function insertProfileEditor(profile) {
        const body = document.getElementById('profile-admin-body');
        if (!body || !body.querySelector('.pa-layout')) { paSelected = profile.id; renderAdminPanel(); return; }
        const tmp = document.createElement('div');
        tmp.innerHTML = `<button type="button" class="pa-item" data-pa-select="${escAttr(profile.id)}" data-pa-name="${escAttr(String(profile.name || '').toLowerCase())}">
                <span class="pa-avatar">${escAttr(initialOf(profile.name))}</span>
                <span class="pa-item-text"><span class="pa-item-name">${escAttr(profile.name)}</span><span class="pa-item-sub" data-pa-summary="${escAttr(profile.id)}">${permSummary(profile)}</span></span>
            </button>`;
        body.querySelector('.pa-list').appendChild(tmp.firstElementChild);
        tmp.innerHTML = editorHtml(profile);
        body.querySelector('.pa-main').appendChild(tmp.firstElementChild);
        const fresh = document.createElement('div');
        fresh.innerHTML = newEditorHtml();
        body.querySelector('[data-pa-editor="__new__"]').replaceWith(fresh.firstElementChild);
        selectProfileEditor(profile.id);
    }

    function selectProfileEditor(id) {
        paSelected = id;
        const body = document.getElementById('profile-admin-body');
        if (!body) return;
        body.querySelectorAll('[data-pa-editor]').forEach(el => { el.hidden = el.dataset.paEditor !== id; });
        body.querySelectorAll('[data-pa-select]').forEach(el => el.classList.toggle('active', el.dataset.paSelect === id));
        const main = body.querySelector('.pa-main');
        if (main) main.scrollTop = 0;
        document.getElementById('profile-admin-modal')?.classList.toggle('pa-creating', id === '__new__');
        if (id === '__new__') setTimeout(() => document.getElementById('profile-create-name')?.focus(), 0);
    }

    function applyTemplate(id, target) {
        const t = TEMPLATES[id];
        const editor = document.querySelector(`[data-pa-editor="${CSS.escape(target)}"]`);
        if (!t || !editor) return;
        const set = new Set(t.perms || Object.keys(PERMISSIONS).filter(k => k !== 'manage_profiles'));
        editor.querySelectorAll('input[data-perm]').forEach(cb => { cb.checked = set.has(cb.dataset.perm); });
        refreshSummary(target);
    }

    function refreshSummary(id) {
        const editor = document.querySelector(`[data-pa-editor="${CSS.escape(id)}"]`);
        if (!editor || id === '__new__') return;
        const perms = [...editor.querySelectorAll('input[data-perm]')].filter(cb => cb.checked).map(cb => cb.dataset.perm);
        const text = permSummary({ permissions: perms });
        document.querySelectorAll(`[data-pa-summary="${CSS.escape(id)}"]`).forEach(el => { el.textContent = text; });
    }

    async function createProfile(name, password, permissions, showHomeMap, showScreenWidgets, features) {
        const trimmed = typeof Security !== 'undefined'
            ? Security.sanitizeTextInput(name, 80)
            : String(name || '').trim();
        if (!trimmed) return { ok: false, error: 'Укажите имя профиля' };
        // Создание профиля — админ задаёт пароль (мин. 3)
        const minLen = minPasswordLenAdminReset();
        if (!password || password.length < minLen) return { ok: false, error: `Пароль — минимум ${minLen} символа` };
        if (!permissions.length) return { ok: false, error: 'Выберите хотя бы одно право доступа' };

        const cred = await makePasswordRecord(password);
        const profile = {
            id: generateProfileId(trimmed),
            name: trimmed,
            isAdmin: false,
            permissions: [...permissions],
            salt: cred.salt,
            hash: cred.hash,
            hashVer: cred.hashVer || 2,
            showHomeMap: !!showHomeMap,
            showScreenWidgets: !!showScreenWidgets,
            features: normalizeFeatures(features),
            // Разовая миграция «Управления продажами» к новому профилю не относится: иначе снятая вкладка вернётся при входе.
            salesPermMigrated: true,
            tabsSplitMigrated: true
        };
        profilesCache.push(profile);
        await saveProfiles(false, { add: [profile] });
        if (typeof ActivityLog !== 'undefined') {
            await ActivityLog.log('profile_create', trimmed, { profileId: profile.id });
        }
        return { ok: true, profile };
    }

    async function handleCreateProfile() {
        if (!guardPermission('manage_profiles')) return;

        try {
            const name = document.getElementById('profile-create-name')?.value || '';
            const password = document.getElementById('profile-create-pass')?.value || '';
            const errEl = document.getElementById('profile-create-error');
            const perms = [];
            document.querySelectorAll('.profile-create-profile-perm-cb:checked').forEach(cb => {
                perms.push(cb.dataset.perm);
            });

            const homeCb = document.querySelector('.profile-home-map-cb[data-home-map="__new__"]');
            const widgetsCb = document.querySelector('.profile-screen-widgets-cb[data-screen-widgets="__new__"]');
            const result = await createProfile(
                name,
                password,
                perms,
                !!(homeCb && homeCb.checked),
                !!(widgetsCb && widgetsCb.checked),
                readFeatureBoxes('__new__')
            );
            if (!result.ok) {
                if (errEl) errEl.textContent = result.error;
                return;
            }

            if (errEl) errEl.textContent = '';
            document.getElementById('profile-create-name').value = '';
            document.getElementById('profile-create-pass').value = '';
            document.querySelectorAll('.profile-create-profile-perm-cb').forEach(cb => {
                cb.checked = cb.dataset.perm === 'tab_main' || cb.dataset.perm === 'tab_sales';
            });

            insertProfileEditor(result.profile);
            if (typeof showToast === 'function') {
                showToast(`Профиль «${result.profile.name}» создан`);
            }
        } catch (e) {
            console.error('handleCreateProfile', e);
            const errEl = document.getElementById('profile-create-error');
            if (errEl) errEl.textContent = 'Не удалось создать профиль';
            if (typeof showToast === 'function') showToast('Ошибка создания профиля', 'error');
        }
    }

    async function handleDeleteProfile(profileId) {
        if (!guardPermission('manage_profiles')) return;
        if (profileId === 'admin') {
            if (typeof showToast === 'function') showToast('Нельзя удалить администратора', 'error');
            return;
        }
        const profile = profilesCache.find(p => p.id === profileId);
        if (!profile) return;
        if (!confirm(`Удалить профиль «${profile.name}»?`)) return;

        try {
            profilesCache = profilesCache.filter(p => p.id !== profileId);
            await saveProfiles(false, { remove: [profileId] });
            if (typeof ActivityLog !== 'undefined') {
                await ActivityLog.log('profile_delete', profile.name, { profileId });
            }
            // Убираем только этот профиль — несохранённые правки остальных остаются на экране.
            document.querySelectorAll(`#profile-admin-body [data-pa-select="${CSS.escape(profileId)}"], #profile-admin-body [data-pa-editor="${CSS.escape(profileId)}"]`).forEach(el => el.remove());
            selectProfileEditor('admin');
            if (typeof showToast === 'function') showToast(`Профиль «${profile.name}» удалён`);
        } catch (e) {
            console.error('handleDeleteProfile', e);
            if (typeof showToast === 'function') showToast('Не удалось удалить профиль', 'error');
        }
    }

    function openAdminPanel() {
        if (!guardPermission('manage_profiles', 'Только администратор может управлять профилями')) return;
        if (!profilesCache.some(p => p.id === paSelected)) paSelected = 'admin';
        renderAdminPanel();
        updateSharedStatus();
        document.getElementById('profile-admin-modal')?.classList.add('open');
    }

    function closeAdminPanel() {
        document.getElementById('profile-admin-modal')?.classList.remove('open');
    }

    async function changeOwnPassword(currentPwd, newPwd, confirmPwd) {
        if (!currentProfile) return { ok: false, error: 'Не выполнен вход' };
        if (!currentPwd) return { ok: false, error: 'Введите текущий пароль' };
        // Самостоятельная смена — всегда ≥ 8 символов (даже для админа)
        const minLen = minPasswordLenSelfChange();
        if (!newPwd || newPwd.length < minLen) return { ok: false, error: `Новый пароль — минимум ${minLen} символов` };
        if (newPwd !== confirmPwd) return { ok: false, error: 'Новые пароли не совпадают' };

        await loadProfiles();
        const profile = profilesCache.find(p => p.id === currentProfile.id);
        if (!profile) return { ok: false, error: 'Профиль не найден' };

        const ok = await verifyPassword(currentPwd, profile);
        if (!ok) return { ok: false, error: 'Неверный текущий пароль' };

        const cred = await makePasswordRecord(newPwd);
        applyPasswordRecord(profile, cred);
        await saveProfiles(false, { update: { [profile.id]: { salt: profile.salt, hash: profile.hash, hashVer: profile.hashVer } } });

        if (typeof ActivityLog !== 'undefined') {
            await ActivityLog.log('password_self', 'Пароль изменён');
        }
        return { ok: true };
    }

    async function saveAdminPanel() {
        if (!guardPermission('manage_profiles')) return;

        try {
            // Сначала проверить всё, потом менять: иначе часть профилей изменится, а сохранение оборвётся на ошибке.
            const minLen = minPasswordLenAdminReset();
            for (const p of profilesCache) {
                const passInput = document.querySelector(`.profile-pass-input[data-profile="${p.id}"]`);
                const noPerms = p.id !== 'admin' && document.querySelector(`input[data-profile="${p.id}"][data-perm]`)
                    && !document.querySelector(`input[data-profile="${p.id}"][data-perm]:checked`);
                const badPass = passInput && passInput.value && passInput.value.length < minLen;
                if (noPerms || badPass) {
                    if (typeof selectProfileEditor === 'function') selectProfileEditor(p.id);
                    if (typeof showToast === 'function') showToast(noPerms ? `Профиль «${p.name}»: выберите хотя бы одно право` : `Пароль «${p.name}»: минимум ${minLen} символа`, 'error');
                    return;
                }
            }
            const passwordChanges = [];
            const passIds = new Set();

            for (const p of profilesCache) {
                const nameInput = document.querySelector(`.profile-name-input[data-profile="${p.id}"]`);
                if (nameInput?.value.trim()) {
                    p.name = typeof Security !== 'undefined'
                        ? Security.sanitizeTextInput(nameInput.value.trim(), 80)
                        : nameInput.value.trim();
                }

                const passInput = document.querySelector(`.profile-pass-input[data-profile="${p.id}"]`);
                if (passInput?.value) {
                    // Админ может выставить любому пароль от 3 символов
                    const minLen = minPasswordLenAdminReset();
                    if (passInput.value.length < minLen) {
                        if (typeof showToast === 'function') {
                            showToast(`Пароль «${p.name}»: минимум ${minLen} символа`, 'error');
                        }
                        return;
                    }
                    const cred = await makePasswordRecord(passInput.value);
                    applyPasswordRecord(p, cred);
                    passInput.value = '';
                    passwordChanges.push(p.name || p.id);
                    passIds.add(p.id);
                }

                if (p.id !== 'admin') {
                    const perms = [];
                    document.querySelectorAll(`input[data-profile="${p.id}"][data-perm]`).forEach(cb => {
                        if (cb.checked) perms.push(cb.dataset.perm);
                    });
                    if (!perms.length) {
                        if (typeof showToast === 'function') {
                            showToast(`Профиль «${p.name}»: выберите хотя бы одно право`, 'error');
                        }
                        return;
                    }
                    p.permissions = perms;
                    p.isAdmin = false;
                }
                const homeCb = document.querySelector(`.profile-home-map-cb[data-home-map="${p.id}"]`);
                if (homeCb) p.showHomeMap = !!homeCb.checked;
                const widgetsCb = document.querySelector(`.profile-screen-widgets-cb[data-screen-widgets="${p.id}"]`);
                if (widgetsCb) p.showScreenWidgets = !!widgetsCb.checked;
                if (document.querySelector(`.profile-feature-cb[data-profile-feature="${p.id}"]`)) {
                    p.features = { ...normalizeFeatures(p.features), ...readFeatureBoxes(p.id) };
                }
            }

            // В файл — только то, что в этой форме: имя, права, функции; пароль — только если его сейчас сменили.
            const update = {};
            profilesCache.forEach(p => {
                update[p.id] = { name: p.name, permissions: [...(p.permissions || [])], isAdmin: !!p.isAdmin,
                    showHomeMap: p.showHomeMap, showScreenWidgets: p.showScreenWidgets, features: p.features };
                if (passIds.has(p.id)) Object.assign(update[p.id], { salt: p.salt, hash: p.hash, hashVer: p.hashVer });
            });
            await saveProfiles(false, { update });

            if (typeof ActivityLog !== 'undefined') {
                await ActivityLog.log('profile_save', `Изменено профилей: ${profilesCache.length}`);
                for (const name of passwordChanges) {
                    await ActivityLog.log('password_admin', name);
                }
            }

            if (currentProfile) {
                const updated = profilesCache.find(x => x.id === currentProfile.id);
                if (updated) {
                    currentProfile.name = updated.name;
                    currentProfile.permissions = [...updated.permissions];
                    currentProfile.isAdmin = !!updated.isAdmin;
                    currentProfile.showHomeMap = resolveShowHomeMap(updated);
                    currentProfile.showScreenWidgets = resolveScreenWidgets(updated);
                    currentProfile.features = normalizeFeatures(updated.features);
                }
            }
            // Значки и шапка зависят от функций профиля — перерисовать открытые таблицы.
            if (typeof invalidateTabPanelState === 'function') invalidateTabPanelState();

            applyPermissions();
            updateSharedStatus();
            closeAdminPanel();
            if (typeof showToast === 'function') showToast('Профили сохранены — доступны всем на общем диске');

            const tab = typeof currentTab !== 'undefined' ? currentTab : 'main';
            if (!canAccessTab(tab)) {
                const fallback = getFirstAllowedTab();
                if (fallback && typeof switchMainTab === 'function') switchMainTab(fallback);
            }
            if (typeof refreshCurrentView === 'function') refreshCurrentView();
        } catch (e) {
            console.error('saveAdminPanel', e);
            if (typeof showToast === 'function') showToast('Не удалось сохранить профили', 'error');
        }
    }

    async function init() {
        bindLoginForm();
        document.getElementById('profile-logout-btn')?.addEventListener('click', logout);
        if (typeof ThemeSettings !== 'undefined') ThemeSettings.init();
        document.getElementById('profile-admin-btn')?.addEventListener('click', openAdminPanel);
        document.getElementById('profile-admin-close')?.addEventListener('click', closeAdminPanel);
        document.getElementById('profile-admin-save')?.addEventListener('click', saveAdminPanel);
        document.getElementById('profile-link-folder-btn')?.addEventListener('click', () => handleLinkFolder(true));
        document.getElementById('profile-history-btn')?.addEventListener('click', () => {
            if (typeof SharedHistory !== 'undefined') SharedHistory.open();
        });
        document.getElementById('login-link-folder')?.addEventListener('click', () => handleLinkFolder(false));
        document.getElementById('profile-admin-modal')?.addEventListener('click', (e) => {
            if (e.target.classList.contains('profile-admin-backdrop')) closeAdminPanel();
        });
        document.getElementById('profile-admin-body')?.addEventListener('click', (e) => {
            const createBtn = e.target.closest('#profile-admin-create');
            if (createBtn) {
                handleCreateProfile();
                return;
            }
            const delBtn = e.target.closest('[data-delete-profile]');
            if (delBtn) { handleDeleteProfile(delBtn.dataset.deleteProfile); return; }
            const sel = e.target.closest('[data-pa-select]');
            if (sel) { selectProfileEditor(sel.dataset.paSelect); return; }
            const tpl = e.target.closest('[data-pa-template]');
            if (tpl) applyTemplate(tpl.dataset.paTemplate, tpl.dataset.paTarget);
        });
        document.getElementById('profile-admin-body')?.addEventListener('change', (e) => {
            const cb = e.target.closest('input[data-perm]');
            if (!cb) return;
            // Справочник: «менять» без «видеть» не бывает.
            const row = cb.closest('[data-pa-ref]');
            if (row) {
                const boxes = row.querySelectorAll('input[data-perm]');
                const view = boxes.length > 1 ? boxes[0] : null;
                const edit = boxes[boxes.length - 1];
                if (cb === edit && edit.checked && view) view.checked = true;
                if (view && cb === view && !view.checked) edit.checked = false;
            }
            refreshSummary(cb.dataset.profile);
        });
        document.getElementById('profile-admin-body')?.addEventListener('input', (e) => {
            if (!e.target.classList.contains('pa-search')) return;
            const q = e.target.value.trim().toLowerCase();
            document.querySelectorAll('#profile-admin-body .pa-item').forEach(el => { el.hidden = !!q && !el.dataset.paName.includes(q); });
        });

        await loadProfiles();

        if (await tryRestoreSession()) {
            hideLoginScreen();
            document.querySelector('.main-layout')?.classList.remove('app-locked');
            if (typeof loadPinnedFlights === 'function') loadPinnedFlights();
            if (typeof loadFlightOpenMode === 'function') loadFlightOpenMode();
            if (typeof ActivityLog !== 'undefined' && currentProfile) {
                ActivityLog.log('login', currentProfile.name, { restored: true });
            }
            applyPermissions();
            if (typeof ThemeSettings !== 'undefined') ThemeSettings.apply();
            if (typeof ActivityLog !== 'undefined') ActivityLog.startBackgroundSync();
            return true;
        }

        document.querySelector('.main-layout')?.classList.add('app-locked');
        showLoginScreen();
        return false;
    }

    async function setShowHomeMap(value) {
        if (!currentProfile?.isAdmin) return false;
        await loadProfiles();
        const p = profilesCache.find(x => x.id === currentProfile.id);
        if (!p || !p.isAdmin) return false;
        p.showHomeMap = !!value;
        currentProfile.showHomeMap = resolveShowHomeMap(p);
        await saveProfiles(false, { update: { [p.id]: { showHomeMap: p.showHomeMap } } });
        applyPermissions();
        if (!canAccessTab('home') && typeof currentTab !== 'undefined' && currentTab === 'home') {
            const fb = getFirstAllowedTab() || 'main';
            if (typeof switchMainTab === 'function') switchMainTab(fb);
        }
        return true;
    }

    return {
        init,
        login,
        logout,
        hasPermission,
        canAccessTab,
        guardPermission,
        getFirstAllowedTab,
        applyPermissions,
        openAdminPanel,
        closeAdminPanel,
        getCurrentProfile: () => currentProfile,
        changeOwnPassword,
        setShowHomeMap,
        screenWidgetsOn: () => resolveScreenWidgets(currentProfile),
        featureOn,
        FEATURES,
        PERMISSIONS
    };
})();