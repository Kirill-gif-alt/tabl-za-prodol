// Подсветка ног на «Загрузке рейсов» по пользовательским правилам.
// Жёлтый 100% ЗПК не трогаем — это отдельная логика. Красим только подходящую ногу.

window.DataBoardFilters = (function () {
    const STORE_KEY = 'krasavia_data_hl_rules_v2';
    const STORE_KEY_V1 = 'krasavia_data_hl_rules_v1';
    const FIELDS = {
        dtd: { label: 'Дней до вылета', step: 1 },
        pct: { label: 'ЗПК %', step: 1 },
        load: { label: 'Загрузка (пасс.)', step: 1 },
        seats: { label: 'Кресла в продаже', step: 1 }
    };
    const OPS = [
        { id: 'lte', label: '≤' },
        { id: 'lt', label: '<' },
        { id: 'gte', label: '≥' },
        { id: 'gt', label: '>' },
        { id: 'eq', label: '=' }
    ];
    const COLORS = ['#dc2626', '#ea580c', '#d97706', '#7c3aed', '#2563eb', '#0891b2'];

    let rules = null;

    function uid() {
        return `r_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    }

    function sanitizeColor(c) {
        const s = String(c || '').trim();
        return /^#[0-9a-fA-F]{6}$/.test(s) ? s : '#dc2626';
    }

    function normalizeRule(r) {
        if (!r || typeof r !== 'object') return null;
        const conditions = Array.isArray(r.conditions) ? r.conditions : [];
        return {
            id: String(r.id || uid()).slice(0, 40),
            name: String(r.name || 'Правило').slice(0, 80),
            color: sanitizeColor(r.color),
            enabled: r.enabled !== false,
            conditions: conditions.filter(c => c && FIELDS[c.field]).map(c => ({
                field: c.field,
                op: OPS.some(o => o.id === c.op) ? c.op : 'lte',
                value: String(c.value ?? '')
            }))
        };
    }

    function fromStored(raw) {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return null;
        return parsed.map(normalizeRule).filter(Boolean).filter(r => r.id !== 'attn_10_50');
    }

    function load() {
        if (rules) return rules;
        try {
            const raw = localStorage.getItem(STORE_KEY);
            if (raw) {
                const next = fromStored(raw);
                if (next) {
                    rules = next;
                    return rules;
                }
            }
            const legacy = localStorage.getItem(STORE_KEY_V1);
            if (legacy) {
                const next = fromStored(legacy);
                if (next) {
                    rules = next;
                    return rules;
                }
            }
        } catch { /* ignore */ }
        rules = [];
        return rules;
    }

    function save() {
        try {
            localStorage.setItem(STORE_KEY, JSON.stringify(load()));
        } catch { /* ignore */ }
        if (typeof SessionStore !== 'undefined') SessionStore.saveUiSession();
    }

    function getRules() {
        return load();
    }

    function setRules(next) {
        rules = (next || []).map(normalizeRule).filter(Boolean);
        save();
    }

    function signature() {
        return JSON.stringify(load().filter(r => r.enabled && r.conditions.some(c => String(c.value).trim() !== '')));
    }

    function compare(actual, op, num) {
        switch (op) {
            case 'gte': return actual >= num;
            case 'lte': return actual <= num;
            case 'gt': return actual > num;
            case 'lt': return actual < num;
            case 'eq': return actual === num;
            default: return false;
        }
    }

    function legValues(row) {
        if (!row) return null;
        const m = typeof getDataLegMetrics === 'function' ? getDataLegMetrics(row) : null;
        if (!m) return null;
        const dtd = typeof getDaysUntil === 'function' ? getDaysUntil(row[1]) : null;
        const pct = m.zpk !== null ? m.zpk : ((m.seats > 0 && (m.load || 0) === 0) ? 0 : null);
        return {
            dtd,
            pct,
            load: m.load,
            seats: m.seats
        };
    }

    function condsActive(rule) {
        return (rule.conditions || []).filter(c => c.field && String(c.value).trim() !== '' && !isNaN(parseFloat(c.value)));
    }

    function legMatches(leg, conds) {
        if (!leg) return false;
        return conds.every(c => {
            const num = parseFloat(c.value);
            let actual = leg[c.field];
            if (actual === null || actual === undefined) return false;
            if (c.field === 'dtd' && actual < 0) return false;
            return compare(actual, c.op, num);
        });
    }

    /** Первое включённое подходящее правило для одной ноги (туда или обратно). */
    function highlightForLeg(row) {
        const leg = legValues(row);
        if (!leg) return null;
        const list = load();
        for (let i = 0; i < list.length; i++) {
            const rule = list[i];
            if (!rule.enabled) continue;
            const conds = condsActive(rule);
            if (!conds.length) continue;
            if (legMatches(leg, conds)) return rule;
        }
        return null;
    }

    function describe(rule) {
        const bits = condsActive(rule).map(c => {
            const field = FIELDS[c.field]?.label || c.field;
            const op = OPS.find(o => o.id === c.op)?.label || c.op;
            return `${field} ${op} ${c.value}`;
        });
        return bits.join(' и ') || 'нет условий';
    }

    function esc(s) {
        return typeof escHtml === 'function' ? escHtml(s) : String(s || '').replace(/[&<>"]/g, '');
    }

    function ensureModal() {
        if (document.getElementById('data-hl-modal')) return;
        const modal = document.createElement('div');
        modal.id = 'data-hl-modal';
        modal.className = 'rms-modal';
        modal.innerHTML = `
            <div class="rms-modal-backdrop" data-data-hl-close></div>
            <div class="rms-modal-panel data-hl-panel" role="dialog" aria-labelledby="data-hl-title">
                <div class="rms-modal-header">
                    <div>
                        <h3 id="data-hl-title">Подсветка</h3>
                    </div>
                    <button type="button" class="rms-modal-close" data-data-hl-close>✕</button>
                </div>
                <div id="data-hl-modal-body" class="rms-modal-body"></div>
                <div class="rms-modal-footer">
                    <button type="button" class="btn-secondary rms-cond-btn" data-data-hl-add>+ Правило</button>
                    <div class="rms-modal-footer-spacer"></div>
                    <button type="button" class="btn-primary rms-cond-btn" data-data-hl-apply>Готово</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        modal.addEventListener('click', (e) => {
            if (e.target.closest('[data-data-hl-close]')) closeModal();
            if (e.target.closest('[data-data-hl-add]')) addRule();
            if (e.target.closest('[data-data-hl-apply]')) closeModal();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal.classList.contains('rms-modal-open')) closeModal();
        });
    }

    function fieldOpts(selected) {
        return Object.entries(FIELDS).map(([id, f]) =>
            `<option value="${id}"${selected === id ? ' selected' : ''}>${esc(f.label)}</option>`
        ).join('');
    }

    function opOpts(selected) {
        return OPS.map(o =>
            `<option value="${o.id}"${selected === o.id ? ' selected' : ''}>${o.label}</option>`
        ).join('');
    }

    function renderBody() {
        const el = document.getElementById('data-hl-modal-body');
        if (!el) return;
        const list = load();
        el.innerHTML = list.map((r, idx) => {
            const conds = r.conditions.length ? r.conditions.map((c, ci) => `
                <div class="rms-cond-row" data-rule="${idx}" data-cond="${ci}">
                    <select class="rms-cond-field" data-hl-field>${fieldOpts(c.field)}</select>
                    <select class="rms-cond-op" data-hl-op>${opOpts(c.op)}</select>
                    <input type="number" class="rms-cond-value" data-hl-val step="${FIELDS[c.field]?.step || 1}" value="${esc(c.value)}" placeholder="значение">
                    <button type="button" class="rms-cond-remove" data-hl-del-cond>✕</button>
                </div>
            `).join('') : '<div class="rms-cond-empty">Добавьте условие</div>';
            const swatches = COLORS.map(col =>
                `<button type="button" class="data-hl-swatch${r.color === col ? ' is-on' : ''}" data-hl-color="${col}" style="background:${col}"></button>`
            ).join('');
            return `
                <div class="data-hl-rule" data-rule="${idx}">
                    <div class="data-hl-rule-head">
                        <label class="data-hide-flew-label">
                            <input type="checkbox" data-hl-on${r.enabled ? ' checked' : ''}> Вкл.
                        </label>
                        <input type="text" class="data-hl-name" data-hl-name value="${esc(r.name)}" maxlength="80" placeholder="Название">
                        <div class="data-hl-colors">${swatches}</div>
                        <button type="button" class="rms-cond-remove" data-hl-del-rule>✕</button>
                    </div>
                    <div class="rms-cond-list">${conds}</div>
                    <button type="button" class="btn-secondary rms-cond-btn data-hl-add-cond" data-hl-add-cond>+ Условие</button>
                    <p class="data-hl-preview">${esc(describe(r))}</p>
                </div>
            `;
        }).join('') || '<div class="rms-cond-empty">Нет правил — нажмите «+ Правило»</div>';

        el.querySelectorAll('.data-hl-rule').forEach((box) => {
            const idx = parseInt(box.getAttribute('data-rule'), 10);
            const rule = load()[idx];
            if (!rule) return;
            box.querySelector('[data-hl-on]')?.addEventListener('change', (e) => {
                rule.enabled = !!e.target.checked;
                save();
                renderBody();
            });
            box.querySelector('[data-hl-name]')?.addEventListener('change', (e) => {
                rule.name = String(e.target.value || 'Правило').slice(0, 80);
                save();
            });
            box.querySelectorAll('[data-hl-color]').forEach((btn) => {
                btn.addEventListener('click', () => {
                    rule.color = sanitizeColor(btn.getAttribute('data-hl-color'));
                    save();
                    renderBody();
                });
            });
            box.querySelector('[data-hl-del-rule]')?.addEventListener('click', () => {
                load().splice(idx, 1);
                save();
                renderBody();
            });
            box.querySelector('[data-hl-add-cond]')?.addEventListener('click', () => {
                rule.conditions.push({ field: 'dtd', op: 'lte', value: '' });
                save();
                renderBody();
            });
            box.querySelectorAll('[data-cond]').forEach((row) => {
                const ci = parseInt(row.getAttribute('data-cond'), 10);
                const cond = rule.conditions[ci];
                if (!cond) return;
                row.querySelector('[data-hl-field]')?.addEventListener('change', (e) => {
                    cond.field = e.target.value;
                    save();
                    renderBody();
                });
                row.querySelector('[data-hl-op]')?.addEventListener('change', (e) => {
                    cond.op = e.target.value;
                    save();
                });
                row.querySelector('[data-hl-val]')?.addEventListener('change', (e) => {
                    cond.value = e.target.value;
                    save();
                    renderBody();
                });
                row.querySelector('[data-hl-del-cond]')?.addEventListener('click', () => {
                    rule.conditions.splice(ci, 1);
                    save();
                    renderBody();
                });
            });
        });
    }

    function addRule() {
        load().push({
            id: uid(),
            name: 'Новое правило',
            color: COLORS[load().length % COLORS.length],
            enabled: true,
            conditions: [{ field: 'dtd', op: 'lte', value: '10' }]
        });
        save();
        renderBody();
    }

    function openModal() {
        ensureModal();
        renderBody();
        document.getElementById('data-hl-modal')?.classList.add('rms-modal-open');
    }

    function closeModal() {
        document.getElementById('data-hl-modal')?.classList.remove('rms-modal-open');
        apply();
    }

    function apply() {
        if (typeof invalidateDataBoardCache === 'function') invalidateDataBoardCache();
        if (typeof renderDataBoard === 'function') renderDataBoard();
        updateBadge();
    }

    function updateBadge() {
        const badge = document.getElementById('data-hl-badge');
        const btn = document.getElementById('data-hl-btn');
        const n = load().filter(r => r.enabled && condsActive(r).length).length;
        if (badge) badge.textContent = n ? String(n) : '';
        if (btn) btn.classList.toggle('rms-cond-btn-active', n > 0);
    }

    function restore(list) {
        if (!Array.isArray(list)) return;
        try {
            if (localStorage.getItem(STORE_KEY)) return;
        } catch { /* ignore */ }
        rules = list.map(normalizeRule).filter(Boolean).filter(r => r.id !== 'attn_10_50');
    }

    function toSession() {
        return load();
    }

    return {
        load,
        getRules,
        setRules,
        restore,
        toSession,
        signature,
        highlightForLeg,
        openModal,
        updateBadge,
        apply
    };
})();
