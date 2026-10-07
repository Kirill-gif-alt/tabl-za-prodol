// Общие утилиты безопасности (XSS, валидация, защита входа)
window.Security = (function () {
    const LOGIN_MAX_ATTEMPTS = 8;
    const LOGIN_LOCK_MS = 60_000;
    const LOGIN_LOCK_KEY = 'krasavia_login_lock';
    const MAX_UPLOAD_FILES = 500;
    const MAX_FILE_BYTES = 50 * 1024 * 1024;
    const MAX_SNAPSHOT_ROWS = 250_000;
    const MAX_SNAPSHOT_SALES = 200_000;
    const PROFILE_ID_RE = /^[a-z][a-z0-9_]{0,31}$/;
    /** Номер рейса: KV- + 1–6 цифр (защита от мусорных значений) */
    const FLIGHT_BASE_RE = /^KV-\d{1,6}$/;
    const DATE_RE = /^\d{2}\.\d{2}\.\d{4}$/;
    const TIME_RE = /^\d{2}:\d{2}$/;
    const MIN_PASSWORD_LEN = 8;
    /** Админ может задавать себе/сбрасывать пароли от 3 символов */
    const MIN_PASSWORD_LEN_ADMIN = 3;

    let loginState = { fails: 0, lockUntil: 0 };

    function loadLoginState() {
        try {
            const raw = localStorage.getItem(LOGIN_LOCK_KEY) || sessionStorage.getItem(LOGIN_LOCK_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object') loginState = parsed;
            }
        } catch (e) { /* ignore */ }
    }

    function persistLoginState() {
        try {
            localStorage.setItem(LOGIN_LOCK_KEY, JSON.stringify(loginState));
        } catch (e) { /* ignore */ }
    }

    loadLoginState();

    function escapeHtml(s) {
        return String(s ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function escapeAttr(s) {
        return escapeHtml(s).replace(/`/g, '&#96;');
    }

    function timingSafeEqual(a, b) {
        if (typeof a !== 'string' || typeof b !== 'string') return false;
        const len = Math.max(a.length, b.length);
        let diff = a.length ^ b.length;
        for (let i = 0; i < len; i++) {
            diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
        }
        return diff === 0;
    }

    function isProfileId(id) {
        return typeof id === 'string' && PROFILE_ID_RE.test(id);
    }

    function transliterateProfileSlug(name) {
        const map = {
            'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e', 'ж': 'zh', 'з': 'z',
            'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r',
            'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'h', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'sch',
            'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya'
        };
        return String(name || '').toLowerCase().split('').map(ch => map[ch] ?? ch).join('')
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 24);
    }

    function isFlightBase(base) {
        return typeof base === 'string' && FLIGHT_BASE_RE.test(base.trim());
    }

    function isFlightDate(date) {
        return typeof date === 'string' && DATE_RE.test(date.trim());
    }

    /** HH:MM после normalizeTimeStr (без +1 и мусора) */
    function isFlightTime(t) {
        return typeof t === 'string' && TIME_RE.test(t.trim());
    }

    function checkLoginAllowed() {
        if (Date.now() < loginState.lockUntil) {
            const sec = Math.ceil((loginState.lockUntil - Date.now()) / 1000);
            return { ok: false, error: `Слишком много попыток. Подождите ${sec} сек.` };
        }
        return { ok: true };
    }

    function recordLoginFailure() {
        loginState.fails += 1;
        if (loginState.fails >= LOGIN_MAX_ATTEMPTS) {
            loginState.lockUntil = Date.now() + LOGIN_LOCK_MS;
            loginState.fails = 0;
        }
        persistLoginState();
    }

    function resetLoginFailures() {
        loginState.fails = 0;
        loginState.lockUntil = 0;
        persistLoginState();
    }

    function validateFileList(fileList) {
        if (!fileList || !fileList.length) return { ok: false, error: 'Файлы не выбраны' };
        if (fileList.length > MAX_UPLOAD_FILES) {
            return { ok: false, error: `Слишком много файлов (макс. ${MAX_UPLOAD_FILES})` };
        }
        for (let i = 0; i < fileList.length; i++) {
            const f = fileList[i];
            if (f.size > MAX_FILE_BYTES) {
                return { ok: false, error: `Файл слишком большой: ${escapeHtml(f.name)}` };
            }
        }
        return { ok: true };
    }

    function sanitizeTextInput(s, maxLen = 200) {
        return String(s ?? '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').trim().slice(0, maxLen);
    }

    function validateSnapshotPayload(snap) {
        if (!snap || typeof snap !== 'object') return false;
        const rows = snap.allData;
        if (Array.isArray(rows) && rows.length > MAX_SNAPSHOT_ROWS) return false;
        let salesCount = 0;
        const details = snap.salesDetails || snap.data?.salesDetails;
        if (details && typeof details === 'object') {
            Object.values(details).forEach(list => {
                if (Array.isArray(list)) salesCount += list.length;
            });
        }
        if (salesCount > MAX_SNAPSHOT_SALES) return false;
        return true;
    }

    function redactSalesDetails(details) {
        if (!details || typeof details !== 'object') return {};
        const out = {};
        Object.keys(details).forEach(key => {
            const list = details[key];
            if (!Array.isArray(list)) return;
            out[key] = list.map(s => ({
                dealDate: s.dealDate,
                fare: s.fare,
                adjustedFare: s.adjustedFare,
                basicFareStr: s.basicFareStr,
                flyDate: s.flyDate
            }));
        });
        return out;
    }

    function stripSalesPii(details) {
        return redactSalesDetails(details);
    }

    return {
        escapeHtml,
        escapeAttr,
        timingSafeEqual,
        isProfileId,
        transliterateProfileSlug,
        isFlightBase,
        isFlightDate,
        isFlightTime,
        checkLoginAllowed,
        recordLoginFailure,
        resetLoginFailures,
        validateFileList,
        validateSnapshotPayload,
        redactSalesDetails,
        stripSalesPii,
        sanitizeTextInput,
        MAX_FILE_BYTES,
        MAX_UPLOAD_FILES,
        MIN_PASSWORD_LEN,
        MIN_PASSWORD_LEN_ADMIN
    };
})();