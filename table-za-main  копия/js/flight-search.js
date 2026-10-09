// Поиск рейса: по номеру (101, кв101, KV-301 — доп. номер ведёт к основному) и по городам маршрута
// («абак», «томск стреж», даже в английской раскладке: «fofr» → «абак»).
// • Поле на панели «Динамики продаж», «Экономики», «ПКЗ»: подсказки прямо под полем.
// • Ctrl+K на любой вкладке: окно поиска по центру — недавние рейсы и совпадения.
//   Enter — открыть на текущей вкладке (или в «Динамике продаж»), Shift+Enter — в «Экономической таблице».
window.FlightSearch = (function () {
    const RECENT_KEY = 'krasavia_recent_flights_';
    const RECENT_MAX = 8;
    const LIMIT = 8;
    const EN = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`";
    const RU = 'йцукенгшщзхъфывапролджэячсмитьбюё';
    let memo = { sig: '', list: [] };
    let dropdown = null;     // { el, input, items, active, onPick }
    let palette = null;      // { ov, input, list, items, active }

    function esc(v) {
        return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function norm(s) {
        return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[—–-]/g, ' ').replace(/\s+/g, ' ').trim();
    }

    function toRu(s) {
        return String(s || '').toLowerCase().split('').map(ch => { const i = EN.indexOf(ch); return i >= 0 ? RU[i] : ch; }).join('');
    }

    function num(code) {
        return String(code || '').replace(/^KV-/i, '');
    }

    function profileId() {
        const p = typeof ProfileAuth !== 'undefined' && ProfileAuth.getCurrentProfile ? ProfileAuth.getCurrentProfile() : null;
        return p ? String(p.id || 'guest') : 'guest';
    }

    function canOpen(tab) {
        return typeof ProfileAuth === 'undefined' || ProfileAuth.canAccessTab(tab);
    }

    function tabName(tab) {
        return typeof TabOrder !== 'undefined' && TabOrder.labelOf ? TabOrder.labelOf(tab) : ({ table: 'Динамика продаж', pair: 'Экономическая таблица', pkz: 'ПКЗ' }[tab] || tab);
    }

    // ---------- справочник рейсов для поиска ----------

    function ts(d) {
        if (typeof PerfCache !== 'undefined' && PerfCache.dateTsMemo) return PerfCache.dateTsMemo(d);
        const x = typeof parseLocalDate === 'function' ? parseLocalDate(d) : null;
        return x ? x.getTime() : null;
    }

    function index() {
        const sig = [typeof dataEpoch === 'number' ? dataEpoch : 0, typeof FlightRegistry !== 'undefined' && FlightRegistry.revision ? FlightRegistry.revision() : 0,
            typeof getTodayDate === 'function' ? getTodayDate() : ''].join('|');
        if (memo.sig === sig) return memo.list;
        const bases = typeof getValidFlightBases === 'function' ? getValidFlightBases() : [];
        const today = typeof getTodayDate === 'function' ? ts(getTodayDate()) : Date.now();
        const list = bases.map(code => {
            const rows = (typeof groupedData !== 'undefined' && groupedData[code]) || [];
            const extras = [...new Set(rows.map(r => cleanFlight(r[0])).filter(c => c && c !== code))]
                .sort((a, b) => (parseInt(num(a), 10) || 0) - (parseInt(num(b), 10) || 0));
            // Ближайший вылет: дата и загрузка — чтобы видеть, тот ли это рейс, не открывая.
            let next = null;
            rows.forEach(r => {
                const t = ts(r[1]);
                if (t == null || t < today) return;
                if (!next || t < next.t) next = { t, row: r };
            });
            let nextTxt = '';
            let lf = null;
            if (next) {
                const seats = typeof getSeatsOnSale === 'function' ? getSeatsOnSale(next.row) : 0;
                const sold = typeof getSoldFromRow === 'function' ? getSoldFromRow(next.row) : 0;
                lf = seats > 0 ? Math.round(sold / seats * 100) : null;
                nextTxt = String(next.row[1]).slice(0, 5);
            }
            const dir = typeof getFlightDirection === 'function' ? getFlightDirection(code) : '';
            const pair = typeof getFlightPair === 'function' ? getFlightPair(code) : null;
            const back = pair ? (pair.outbound === code ? pair.inbound : pair.outbound) : '';
            return {
                code, dir, extras, back, n: rows.length, next: nextTxt, lf,
                nums: [num(code)].concat(extras.map(num)),
                words: norm(dir).split(' ').filter(Boolean),
                text: norm(dir)
            };
        });
        memo = { sig, list };
        return list;
    }

    // Счёт совпадения: номер важнее города, точное — важнее начала, начало слова — важнее середины.
    function scoreOf(f, terms) {
        let total = 0;
        for (const t of terms) {
            const digits = t.replace(/^(kv|кв)-?/, '');
            let best = 0;
            if (/^\d+$/.test(digits)) {
                if (f.nums[0] === digits) best = 100;
                else if (f.nums.slice(1).includes(digits)) best = 90;
                else if (f.nums[0].startsWith(digits)) best = 75;
                else if (f.nums.some(n => n.startsWith(digits))) best = 65;
                else if (f.nums.some(n => n.includes(digits))) best = 35;
            } else {
                if (f.words.some(w => w === t)) best = 70;
                else if (f.words.some(w => w.startsWith(t))) best = 60;
                else if (f.text.includes(t)) best = 30;
            }
            if (!best) return 0;
            total += best;
        }
        return total;
    }

    // «KV-247», «kv 247», «кв247» → «247».
    function stripPrefix(q) {
        return q.replace(/(^|\s)(kv|кв|rd)\s*(?=\d)/g, '$1').trim();
    }

    function search(query) {
        const q = stripPrefix(norm(query));
        if (!q) return [];
        const run = (qq) => {
            const terms = qq.split(' ').filter(Boolean);
            return index().map(f => ({ f, s: scoreOf(f, terms) })).filter(x => x.s > 0);
        };
        let res = run(q);
        // Набрано в английской раскладке («fofrfy» → «абакан»).
        if (!res.length && /[a-z\[\];',.`]/.test(q)) res = run(stripPrefix(norm(toRu(q))));
        return res.sort((a, b) => b.s - a.s || (parseInt(a.f.nums[0], 10) || 0) - (parseInt(b.f.nums[0], 10) || 0)).map(x => x.f);
    }

    function find(code) {
        return index().find(f => f.code === code) || null;
    }

    // ---------- недавние ----------

    function recent() {
        try {
            const raw = JSON.parse(localStorage.getItem(RECENT_KEY + profileId()) || '[]');
            return (Array.isArray(raw) ? raw : []).map(find).filter(Boolean);
        } catch (e) {
            return [];
        }
    }

    function remember(code) {
        const base = typeof getBaseFlight === 'function' ? getBaseFlight(code) : code;
        if (!base) return;
        try {
            let raw = JSON.parse(localStorage.getItem(RECENT_KEY + profileId()) || '[]');
            if (!Array.isArray(raw)) raw = [];
            raw = [base].concat(raw.filter(c => c !== base)).slice(0, RECENT_MAX);
            localStorage.setItem(RECENT_KEY + profileId(), JSON.stringify(raw));
        } catch (e) { /* ignore */ }
    }

    // ---------- открыть рейс ----------

    // tab: 'here' — текущая вкладка, если на ней выбирают рейс, иначе «Динамика продаж»; или имя вкладки.
    function open(code, tab) {
        const f = find(code) || { code };
        const base = f.code;
        remember(base);
        const cur = typeof currentTab !== 'undefined' ? currentTab : '';
        let target = tab === 'here' ? (['table', 'pair', 'pkz'].includes(cur) ? cur : '') : tab;
        if (!target || !canOpen(target)) target = ['table', 'pair', 'pkz'].find(canOpen) || '';
        if (!target) return;
        if (target === cur) {
            if (typeof selectFlight === 'function') selectFlight(base);
        } else {
            currentFlight = base;
            lastSelectedDate = null;
            if (typeof switchMainTab === 'function') switchMainTab(target);
        }
    }

    // ---------- строки списка ----------

    function hl(text, q) {
        const s = String(text || '');
        const terms = stripPrefix(norm(q)).split(' ').filter(t => t && !/^\d+$/.test(t));
        if (!terms.length) return esc(s);
        // Подсветка начала слов, совпавших с запросом (без учёта регистра и «ё»).
        const lower = s.toLowerCase().replace(/ё/g, 'е');
        const marks = new Array(s.length).fill(false);
        terms.forEach(t => {
            let i = lower.indexOf(t);
            while (i >= 0) { for (let k = i; k < i + t.length; k++) marks[k] = true; i = lower.indexOf(t, i + 1); }
        });
        let out = '';
        let open = false;
        for (let i = 0; i < s.length; i++) {
            if (marks[i] && !open) { out += '<mark>'; open = true; }
            if (!marks[i] && open) { out += '</mark>'; open = false; }
            out += esc(s[i]);
        }
        return out + (open ? '</mark>' : '');
    }

    function hlCode(code, q) {
        const digits = stripPrefix(norm(q)).split(' ').find(t => /^\d+$/.test(t));
        const n = num(code);
        if (!digits || !n.includes(digits)) return esc(code);
        const i = n.indexOf(digits);
        return 'KV-' + esc(n.slice(0, i)) + '<mark>' + esc(digits) + '</mark>' + esc(n.slice(i + digits.length));
    }

    function lfCls(lf) {
        if (lf == null) return '';
        return lf >= 85 ? 'fs-lf-hi' : (lf < 50 ? 'fs-lf-lo' : 'fs-lf-mid');
    }

    function itemHtml(f, q, i, active, aside) {
        const extras = f.extras.length ? `<span class="fs-extra">доп. ${f.extras.map(e => hlCode(e, q)).join(', ')}</span>` : '';
        const next = f.next ? `<span class="fs-next" title="Ближайший вылет и его загрузка">${esc(f.next)}${f.lf != null ? ` <b class="${lfCls(f.lf)}">${f.lf}%</b>` : ''}</span>` : '<span class="fs-next fs-muted">нет вылетов впереди</span>';
        return `<div class="fs-item${i === active ? ' fs-on' : ''}" role="option" aria-selected="${i === active}" data-fs-i="${i}" data-fs-code="${esc(f.code)}">
            <span class="fs-code">${hlCode(f.code, q)}</span>
            <span class="fs-main"><span class="fs-dir">${hl(f.dir, q)}</span>${extras}</span>
            ${next}
            ${aside || ''}
        </div>`;
    }

    // ---------- поле с подсказками ----------

    function closeDropdown() {
        if (!dropdown) return;
        dropdown.el.remove();
        if (dropdown.input) dropdown.input.setAttribute('aria-expanded', 'false');
        dropdown = null;
    }

    function placeDropdown() {
        if (!dropdown) return;
        const r = dropdown.input.getBoundingClientRect();
        if (!r.width) { closeDropdown(); return; }
        const w = Math.max(r.width, 440);
        const left = Math.min(r.left, window.innerWidth - w - 12);
        dropdown.el.style.left = Math.max(8, left) + 'px';
        dropdown.el.style.top = (r.bottom + 6) + 'px';
        dropdown.el.style.width = w + 'px';
    }

    function renderDropdown() {
        if (!dropdown) return;
        const q = dropdown.input.value;
        const rec = !norm(q);
        const items = rec ? recent().slice(0, 6) : search(q).slice(0, LIMIT);
        dropdown.items = items;
        if (dropdown.active >= items.length) dropdown.active = items.length - 1;
        if (dropdown.active < 0 && items.length) dropdown.active = 0;
        let body;
        if (!items.length) {
            body = rec
                ? '<div class="fs-empty">Начните вводить номер (101, 301) или город (Абакан, томск)</div>'
                : `<div class="fs-empty">Ничего не нашлось по «${esc(q)}». Попробуйте номер или часть названия города.</div>`;
        } else {
            body = (rec ? '<div class="fs-sec">Недавние</div>' : '') + items.map((f, i) => itemHtml(f, q, i, dropdown.active)).join('');
        }
        dropdown.el.innerHTML = body + '<div class="fs-foot"><span><kbd>↑</kbd><kbd>↓</kbd> выбрать</span><span><kbd>Enter</kbd> открыть</span><span><kbd>Esc</kbd> закрыть</span><span class="fs-foot-right" title="Окно поиска рейса открывается с любой вкладки"><kbd>Ctrl</kbd>+<kbd>K</kbd> везде</span></div>';
        placeDropdown();
    }

    function openDropdown(input, onPick) {
        if (dropdown && dropdown.input === input) { renderDropdown(); return; }
        closeDropdown();
        const el = document.createElement('div');
        el.className = 'fs-drop';
        el.setAttribute('role', 'listbox');
        el.addEventListener('mousedown', (e) => {
            e.preventDefault(); // не уводить фокус из поля
            const it = e.target.closest('[data-fs-code]');
            if (it) pick(it.dataset.fsCode);
        });
        el.addEventListener('mousemove', (e) => {
            const it = e.target.closest('[data-fs-i]');
            if (!it || !dropdown) return;
            const i = parseInt(it.dataset.fsI, 10);
            if (i === dropdown.active) return;
            dropdown.active = i;
            el.querySelectorAll('.fs-item').forEach(n => n.classList.toggle('fs-on', parseInt(n.dataset.fsI, 10) === i));
        });
        document.body.appendChild(el);
        dropdown = { el, input, items: [], active: 0, onPick };
        input.setAttribute('aria-expanded', 'true');
        renderDropdown();
    }

    function pick(code) {
        if (!dropdown) return;
        const { input, onPick } = dropdown;
        closeDropdown();
        input.value = '';
        input.blur();
        if (onPick) onPick(code);
    }

    function move(state, d, rerender) {
        if (!state.items.length) return;
        state.active = (state.active + d + state.items.length) % state.items.length;
        rerender();
        const on = (state.el || state.list).querySelector('.fs-on');
        if (on) on.scrollIntoView({ block: 'nearest' });
    }

    // Подключить поле поиска (панель таблиц). onPick(code) — открыть рейс.
    function attach(input, onPick) {
        if (!input || input.dataset.fsBound) return;
        input.dataset.fsBound = '1';
        input.setAttribute('autocomplete', 'off');
        input.setAttribute('role', 'combobox');
        input.setAttribute('aria-expanded', 'false');
        const pickFn = onPick || ((code) => open(code, 'here'));
        input.addEventListener('focus', () => openDropdown(input, pickFn));
        input.addEventListener('input', () => {
            if (!dropdown || dropdown.input !== input) openDropdown(input, pickFn);
            else { dropdown.active = 0; renderDropdown(); }
        });
        input.addEventListener('keydown', (e) => {
            if (!dropdown || dropdown.input !== input) {
                if (e.key === 'ArrowDown') { openDropdown(input, pickFn); e.preventDefault(); }
                return;
            }
            if (e.key === 'ArrowDown') { e.preventDefault(); move(dropdown, 1, renderDropdown); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); move(dropdown, -1, renderDropdown); }
            else if (e.key === 'Enter') {
                e.preventDefault();
                const f = dropdown.items[dropdown.active];
                if (f) pick(f.code);
                else if (typeof showToast === 'function' && norm(input.value)) showToast('Рейс не найден: ' + input.value.trim(), 'error');
            } else if (e.key === 'Escape') { e.preventDefault(); closeDropdown(); input.blur(); }
        });
        input.addEventListener('blur', () => setTimeout(() => { if (dropdown && dropdown.input === input && document.activeElement !== input) closeDropdown(); }, 120));
    }

    window.addEventListener('resize', placeDropdown);
    document.addEventListener('scroll', (e) => {
        if (dropdown && !(e.target && e.target.nodeType === 1 && dropdown.el.contains(e.target))) placeDropdown();
    }, true);

    // ---------- окно Ctrl+K ----------

    function paletteTabs() {
        return ['table', 'pair', 'pkz'].filter(canOpen);
    }

    function renderPalette() {
        if (!palette) return;
        const q = palette.input.value;
        const rec = !norm(q);
        const items = rec ? recent() : search(q).slice(0, 12);
        palette.items = items;
        if (palette.active >= items.length) palette.active = items.length - 1;
        if (palette.active < 0 && items.length) palette.active = 0;
        const tabs = paletteTabs();
        const aside = (f) => `<span class="fs-tabs">${tabs.map(t => `<button type="button" class="fs-tab-btn" data-fs-open="${esc(f.code)}" data-fs-tab="${t}" title="Открыть в «${esc(tabName(t))}»">${esc(tabName(t))}</button>`).join('')}</span>`;
        let html;
        if (!items.length) {
            html = rec
                ? '<div class="fs-empty">Недавних рейсов пока нет. Введите номер (101, 301) или город (Абакан, томск).</div>'
                : `<div class="fs-empty">Ничего не нашлось по «${esc(q)}».</div>`;
        } else {
            html = `<div class="fs-sec">${rec ? 'Недавние' : `Найдено: ${items.length === 12 ? '12+' : items.length}`}</div>`
                + items.map((f, i) => itemHtml(f, q, i, palette.active, aside(f))).join('');
        }
        palette.list.innerHTML = html;
        const cur = typeof currentTab !== 'undefined' ? currentTab : '';
        const here = ['table', 'pair', 'pkz'].includes(cur) && canOpen(cur) ? cur : tabs[0];
        palette.hint.innerHTML = `<span><kbd>Enter</kbd> открыть в «${esc(tabName(here || 'table'))}»</span>`
            + (canOpen('pair') && here !== 'pair' ? `<span><kbd>Shift</kbd>+<kbd>Enter</kbd> в «${esc(tabName('pair'))}»</span>` : '')
            + '<span><kbd>↑</kbd><kbd>↓</kbd> выбрать</span>';
    }

    function openPalette() {
        if (!paletteTabs().length) return;
        if (palette) { palette.input.focus(); palette.input.select(); return; }
        closeDropdown();
        const ov = document.createElement('div');
        ov.className = 'fs-ov';
        ov.innerHTML = `<div class="fs-pal" role="dialog" aria-modal="true" aria-label="Поиск рейса">
            <div class="fs-pal-head">
                <svg class="fs-pal-icon" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="8.5" cy="8.5" r="6"/><path d="M13 13l5 5"/></svg>
                <input type="text" class="fs-pal-input" placeholder="Номер рейса или город: 101, 301, абакан, томск стреж…" autocomplete="off" aria-label="Поиск рейса">
                <kbd class="fs-pal-esc">Esc</kbd>
            </div>
            <div class="fs-pal-list" role="listbox"></div>
            <div class="fs-foot fs-pal-hint"></div>
        </div>`;
        document.body.appendChild(ov);
        const input = ov.querySelector('.fs-pal-input');
        palette = { ov, input, list: ov.querySelector('.fs-pal-list'), hint: ov.querySelector('.fs-pal-hint'), items: [], active: 0 };
        ov.addEventListener('mousedown', (e) => {
            if (e.target === ov) { closePalette(); return; }
            const tb = e.target.closest('[data-fs-open]');
            if (tb) { e.preventDefault(); const c = tb.dataset.fsOpen; const t = tb.dataset.fsTab; closePalette(); open(c, t); return; }
            const it = e.target.closest('[data-fs-code]');
            if (it) { e.preventDefault(); const c = it.dataset.fsCode; closePalette(); open(c, 'here'); }
        });
        palette.list.addEventListener('mousemove', (e) => {
            const it = e.target.closest('[data-fs-i]');
            if (!it || !palette) return;
            const i = parseInt(it.dataset.fsI, 10);
            if (i === palette.active) return;
            palette.active = i;
            palette.list.querySelectorAll('.fs-item').forEach(n => n.classList.toggle('fs-on', parseInt(n.dataset.fsI, 10) === i));
        });
        input.addEventListener('input', () => { palette.active = 0; renderPalette(); });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); move(palette, 1, renderPalette); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); move(palette, -1, renderPalette); }
            else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
            else if (e.key === 'Enter') {
                e.preventDefault();
                const f = palette.items[palette.active];
                if (!f) return;
                closePalette();
                open(f.code, e.shiftKey && canOpen('pair') ? 'pair' : 'here');
            }
        });
        renderPalette();
        requestAnimationFrame(() => input.focus());
    }

    function closePalette() {
        if (!palette) return;
        palette.ov.remove();
        palette = null;
    }

    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K' || e.key === 'л' || e.key === 'Л' || e.code === 'KeyK')) {
            const loggedIn = typeof ProfileAuth === 'undefined' || (ProfileAuth.getCurrentProfile && ProfileAuth.getCurrentProfile());
            const hasData = typeof groupedData !== 'undefined' && groupedData && Object.keys(groupedData).length;
            if (!loggedIn || !hasData) return;
            e.preventDefault();
            if (palette) closePalette();
            else openPalette();
        }
    });

    return { attach, search, open, openPalette, closePalette, remember, recent };
})();
