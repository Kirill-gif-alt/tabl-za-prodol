// RMS: конструктор условий фильтрации (модальное окно)

const RMS_FILTER_FIELDS = {
    pct: { label: 'Загрузка %', step: 1 },
    free: { label: 'Пассажиров', step: 1 },
    delta: { label: 'Δ от прогноза', step: 1 },
    dtd: { label: 'Дней до вылета', step: 1 },
    pickup: { label: 'Pickup 1–2д (файл 14д)', step: 1 },
    remainder: { label: 'Остаток (AU−sold−avs)', step: 1 },
    salesToday: { label: 'Продажи сегодня', step: 1 },
    avg: { label: 'Ср. тариф ₽', step: 100 }
};

const RMS_FILTER_OPS = [
    { id: 'gte', label: '≥' },
    { id: 'lte', label: '≤' },
    { id: 'gt', label: '>' },
    { id: 'lt', label: '<' },
    { id: 'eq', label: '=' }
];

const RMS_PRESETS_KEY = 'krasavia_rms_presets';

let rmsActiveConditions = [];

function loadRmsPresets() {
    try {
        return JSON.parse(localStorage.getItem(RMS_PRESETS_KEY) || '[]');
    } catch {
        return [];
    }
}

function saveRmsPresets(presets) {
    try {
        localStorage.setItem(RMS_PRESETS_KEY, JSON.stringify(presets));
    } catch (e) {
        console.warn('saveRmsPresets', e);
    }
}

function normalizeRmsConditions(conditions) {
    return (conditions || [])
        .filter(c => c && c.field)
        .map(c => ({
            id: c.id || `c_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            field: c.field,
            op: c.op || 'gte',
            value: c.value === undefined || c.value === null ? '' : String(c.value)
        }));
}

function getRmsFlightFieldValue(f, field) {
    switch (field) {
        case 'pct': return f.pct;
        case 'free': return f.free;
        case 'delta': return f.delta;
        case 'dtd': return f.dtd;
        case 'pickup': return f.pickup;
        case 'remainder': return f.remainder;
        case 'salesToday':
            if (typeof hasSalesFileLoaded === 'function' && !hasSalesFileLoaded()) return null;
            return f.s?.today ?? 0;
        case 'avg': return f.avg;
        default: return null;
    }
}

function evaluateRmsCondition(f, cond) {
    const num = parseFloat(cond.value);
    if (isNaN(num)) return true;
    const actual = getRmsFlightFieldValue(f, cond.field);
    if (actual === null || actual === undefined) return false;
    switch (cond.op) {
        case 'gte': return actual >= num;
        case 'lte': return actual <= num;
        case 'gt': return actual > num;
        case 'lt': return actual < num;
        case 'eq': return actual === num;
        default: return true;
    }
}

function getActiveRmsConditions() {
    return rmsActiveConditions.filter(c => c.field && String(c.value).trim() !== '' && !isNaN(parseFloat(c.value)));
}

function applyRmsConditions(flights, conditions) {
    const active = getActiveRmsConditions();
    const list = conditions ? normalizeRmsConditions(conditions).filter(c => c.field && String(c.value).trim() !== '' && !isNaN(parseFloat(c.value))) : active;
    if (!list.length) return flights;
    return flights.filter(f => list.every(c => evaluateRmsCondition(f, c)));
}

function describeRmsCondition(cond) {
    const field = RMS_FILTER_FIELDS[cond.field]?.label || cond.field;
    const op = RMS_FILTER_OPS.find(o => o.id === cond.op)?.label || cond.op;
    return `${field} ${op} ${cond.value}`;
}

function countRmsRoutesByDateBase(flights) {
    const counts = {};
    flights.forEach(x => {
        const k = `${x.date}|${x.base}`;
        counts[k] = (counts[k] || 0) + 1;
    });
    return counts;
}

function shouldShowRmsRoute(f, flightsOrCounts) {
    const k = `${f.date}|${f.base}`;
    const counts = Array.isArray(flightsOrCounts) ? countRmsRoutesByDateBase(flightsOrCounts) : flightsOrCounts;
    if (!counts) return false;
    return (counts[k] || 0) >= 2;
}

function updateRmsConditionsBadge() {
    const badge = document.getElementById('rms-cond-badge');
    const btn = document.getElementById('rms-conditions-btn');
    const hint = document.getElementById('rms-active-hint');
    const active = getActiveRmsConditions();
    if (badge) badge.textContent = active.length ? String(active.length) : '';
    if (btn) btn.classList.toggle('rms-cond-btn-active', active.length > 0);
    if (hint) {
        hint.textContent = active.length ? active.map(describeRmsCondition).join(' • ') : '';
        hint.style.display = active.length ? '' : 'none';
    }
}

function ensureRmsConditionsModal() {
    if (document.getElementById('rms-conditions-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'rms-conditions-modal';
    modal.className = 'rms-modal';
    modal.innerHTML = `
        <div class="rms-modal-backdrop" onclick="closeRmsConditionsModal()"></div>
        <div class="rms-modal-panel" role="dialog" aria-labelledby="rms-modal-title">
            <div class="rms-modal-header">
                <div>
                    <h3 id="rms-modal-title">Условия отбора</h3>
                </div>
                <button type="button" class="rms-modal-close" onclick="closeRmsConditionsModal()" >✕</button>
            </div>
            <div id="rms-conditions-modal-body" class="rms-modal-body"></div>
            <div class="rms-modal-footer">
                <button type="button" onclick="addRmsCondition()" class="btn-secondary rms-cond-btn">+ Условие</button>
                <div class="rms-modal-footer-spacer"></div>
                <button type="button" onclick="clearRmsConditions()" class="btn-secondary rms-cond-btn">Сбросить</button>
                <button type="button" onclick="applyRmsConditionsAndClose()" class="btn-primary rms-cond-btn rms-cond-apply">Применить</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.classList.contains('rms-modal-open')) closeRmsConditionsModal();
    });
}

function openRmsConditionsModal() {
    ensureRmsConditionsModal();
    renderRmsConditionsModalContent();
    const modal = document.getElementById('rms-conditions-modal');
    if (modal) modal.classList.add('rms-modal-open');
}

function closeRmsConditionsModal() {
    const modal = document.getElementById('rms-conditions-modal');
    if (modal) modal.classList.remove('rms-modal-open');
}

function applyRmsConditionsAndClose() {
    applyRmsConditionsNow();
    closeRmsConditionsModal();
}

function addRmsCondition() {
    rmsActiveConditions.push({
        id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        field: 'pct',
        op: 'lte',
        value: ''
    });
    renderRmsConditionsModalContent();
    if (typeof SessionStore !== 'undefined') SessionStore.saveUiSession();
}

function removeRmsCondition(id) {
    rmsActiveConditions = rmsActiveConditions.filter(c => c.id !== id);
    renderRmsConditionsModalContent();
    renderRmsWatchlist();
    if (typeof SessionStore !== 'undefined') SessionStore.saveUiSession();
}

function updateRmsCondition(id, key, value) {
    const c = rmsActiveConditions.find(x => x.id === id);
    if (!c) return;
    c[key] = value;
    if (document.getElementById('rms-conditions-modal')?.classList.contains('rms-modal-open')) {
        renderRmsConditionsModalContent();
    }
    if (typeof SessionStore !== 'undefined') SessionStore.saveUiSession();
}

function clearRmsConditions() {
    rmsActiveConditions = [];
    renderRmsConditionsModalContent();
    renderRmsWatchlist();
    if (typeof SessionStore !== 'undefined') SessionStore.saveUiSession();
}

function applyRmsConditionsNow() {
    renderRmsWatchlist();
    updateRmsConditionsBadge();
    if (typeof SessionStore !== 'undefined') SessionStore.saveUiSession();
}

function saveRmsPreset() {
    const name = prompt('Название набора условий:');
    if (!name || !name.trim()) return;
    const active = getActiveRmsConditions();
    if (!active.length) {
        showToast('Добавьте хотя бы одно условие с числом', 'error');
        return;
    }
    const presets = loadRmsPresets();
    presets.push({ name: name.trim(), conditions: active.map(c => ({ field: c.field, op: c.op, value: c.value })) });
    saveRmsPresets(presets);
    renderRmsConditionsModalContent();
    showToast('Набор условий сохранён');
}

function loadRmsPresetByName(name) {
    if (!name) {
        rmsActiveConditions = [];
        renderRmsConditionsModalContent();
        renderRmsWatchlist();
        return;
    }
    const preset = loadRmsPresets().find(p => p.name === name);
    if (!preset) return;
    rmsActiveConditions = normalizeRmsConditions(preset.conditions);
    renderRmsConditionsModalContent();
    renderRmsWatchlist();
    if (typeof SessionStore !== 'undefined') SessionStore.saveUiSession();
}

function deleteRmsPreset(name) {
    if (!name || !confirm(`Удалить набор «${name}»?`)) return;
    saveRmsPresets(loadRmsPresets().filter(p => p.name !== name));
    renderRmsConditionsModalContent();
    showToast('Набор удалён');
}

function loadRmsPresetFromSelect() {
    const name = document.getElementById('rms-preset-select')?.value;
    if (!name) {
        showToast('Выберите набор в списке', 'error');
        return;
    }
    loadRmsPresetByName(name);
}

function deleteRmsPresetFromSelect() {
    const name = document.getElementById('rms-preset-select')?.value;
    if (!name) {
        showToast('Выберите набор в списке', 'error');
        return;
    }
    deleteRmsPreset(name);
}

function buildRmsConditionsModalContent() {
    const presets = loadRmsPresets();
    const active = getActiveRmsConditions();
    const presetOptions = presets.map(p =>
        `<option value="${escHtml(p.name)}">${escHtml(p.name)} (${p.conditions.length})</option>`
    ).join('');

    const rows = rmsActiveConditions.length ? rmsActiveConditions.map(c => {
        const fieldOpts = Object.entries(RMS_FILTER_FIELDS).map(([id, f]) =>
            `<option value="${id}" ${c.field === id ? 'selected' : ''}>${f.label}</option>`
        ).join('');
        const opOpts = RMS_FILTER_OPS.map(o =>
            `<option value="${o.id}" ${c.op === o.id ? 'selected' : ''}>${o.label}</option>`
        ).join('');
        const step = RMS_FILTER_FIELDS[c.field]?.step || 1;
        return `
            <div class="rms-cond-row" data-cond-id="${c.id}">
                <select class="rms-cond-field" onchange="updateRmsCondition('${c.id}','field',this.value)">${fieldOpts}</select>
                <select class="rms-cond-op" onchange="updateRmsCondition('${c.id}','op',this.value)">${opOpts}</select>
                <input type="number" class="rms-cond-value" step="${step}" value="${escHtml(c.value)}"
                    placeholder="значение" onchange="updateRmsCondition('${c.id}','value',this.value)">
                <button type="button" class="rms-cond-remove" onclick="removeRmsCondition('${c.id}')">✕</button>
            </div>
        `;
    }).join('') : '<div class="rms-cond-empty">Добавьте условие — без условий показаны все рейсы по периоду</div>';

    return `
        <div class="rms-cond-list">${rows}</div>
        ${active.length ? `<div class="rms-cond-active">Будет применено: ${active.map(describeRmsCondition).join(' • ')}</div>` : ''}
        <div class="rms-cond-presets">
            <select id="rms-preset-select" class="rms-cond-field" style="min-width:200px">
                <option value="">Сохранённые наборы...</option>
                ${presetOptions}
            </select>
            <button type="button" onclick="loadRmsPresetFromSelect()" class="btn-secondary rms-cond-btn">Загрузить</button>
            <button type="button" onclick="saveRmsPreset()" class="btn-secondary rms-cond-btn">Сохранить</button>
            <button type="button" onclick="deleteRmsPresetFromSelect()" class="btn-secondary rms-cond-btn">Удалить</button>
        </div>
    `;
}

function renderRmsConditionsModalContent() {
    const el = document.getElementById('rms-conditions-modal-body');
    if (el) el.innerHTML = buildRmsConditionsModalContent();
}

function getRmsRouteTypeFilter() {
    return document.getElementById('rms-route-type-filter')?.value || 'all';
}

function applyRmsRouteTypeFilter(flights) {
    const typeFilter = getRmsRouteTypeFilter();
    if (typeFilter === 'all' || typeof flightMatchesRouteTypeFilter !== 'function') return flights;
    return flights.filter(f => {
        const code = f.orig || f.base;
        return flightMatchesRouteTypeFilter(code, typeFilter);
    });
}

function getRmsFilteredFlights() {
    const days = parseInt(document.getElementById('rms-days-filter')?.value || '30', 10);
    const alertOnly = document.getElementById('rms-alert-filter')?.value === 'alerts';
    let flights = getAllUpcomingFlights(days);
    if (alertOnly) {
        flights = flights.filter(f => f.alertLevel >= 2);
    }
    flights = applyRmsRouteTypeFilter(flights);
    return applyRmsConditions(flights);
}