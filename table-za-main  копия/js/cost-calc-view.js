// Вкладка «Расчёт расходов»: маршрут + ВС + субсидия + доход → расходы и фин. рез. туда+обратно.
// В файле сумма на пару; здесь × 1000 без деления на 2. Экономическая таблица не меняется.

const COST_CALC_STORE = 'krasavia_cost_calc_v1';

function loadCostCalcState() {
    try {
        const raw = localStorage.getItem(COST_CALC_STORE);
        if (!raw) return { routeId: '', ac: '', subsidized: true, revenue: '' };
        const o = JSON.parse(raw);
        return {
            routeId: String(o.routeId || ''),
            ac: String(o.ac || ''),
            subsidized: o.subsidized !== false,
            revenue: o.revenue == null ? '' : String(o.revenue)
        };
    } catch {
        return { routeId: '', ac: '', subsidized: true, revenue: '' };
    }
}

function saveCostCalcState(state) {
    try {
        localStorage.setItem(COST_CALC_STORE, JSON.stringify(state));
    } catch { /* ignore */ }
}

function parseCostCalcRevenue(raw) {
    const s = String(raw || '').trim().replace(/\s/g, '').replace(',', '.');
    if (s === '') return null;
    const n = parseFloat(s);
    return isNaN(n) ? null : n;
}

function createCostCalcView(c) {
    c.innerHTML = `
        <div class="table-page cost-calc-page">
            <div class="table-page-hero card cost-calc-hero">
                <div class="table-page-hero-main">
                    <h2 class="cost-calc-title">Расчёт расходов</h2>
                </div>
            </div>
            <div class="table-page-body cost-calc-body">
                <div id="cost-calc-form" class="cost-calc-form card"></div>
                <div id="cost-calc-result" class="cost-calc-result" aria-live="polite"></div>
            </div>
        </div>
    `;
    refreshCostCalc();
}

// Загрузка файла себестоимости и субсидий (кнопка в «Отчётах»): выбор файла → разбор → общий снимок для всех ПК.
function uploadCostsFile() {
    return new Promise((resolve) => {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = '.xlsx,.xls';
        inp.id = 'cost-calc-file';
        inp.hidden = true;
        document.body.appendChild(inp);
        inp.addEventListener('change', async () => {
            const file = inp.files && inp.files[0];
            inp.remove();
            if (!file || typeof RouteCosts === 'undefined') return resolve(false);
            try {
                const r = await RouteCosts.loadFiles(file, null);
                if (!r.costs) { if (typeof showToast === 'function') showToast('В файле не нашлось маршрутов с себестоимостью', 'error'); return resolve(false); }
                const form = document.getElementById('cost-calc-form');
                if (form) form.dataset.built = '';
                refreshCostCalc();
                if (typeof SessionStore !== 'undefined' && SessionStore.saveSnapshot) SessionStore.saveSnapshot(true);
                if (typeof ActivityLog !== 'undefined') ActivityLog.log('costs_upload', file.name);
                if (typeof showToast === 'function') showToast(`Себестоимость и субсидии загружены: ${r.costs / 2} маршрутов и ВС`);
                resolve(true);
            } catch (e) {
                if (typeof showToast === 'function') showToast('Не удалось прочитать файл', 'error');
                resolve(false);
            }
        });
        inp.addEventListener('cancel', () => { inp.remove(); resolve(false); });
        inp.click();
    });
}

const COST_CALC_MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

function costCalcKpiRow(title, expenses, subsidy, revenue, subsidized) {
    const fin = revenue == null || expenses == null ? null : (revenue - expenses + (subsidy || 0));
    const finCls = fin == null ? '' : (fin > 0 ? ' cost-calc-pos' : (fin < 0 ? ' cost-calc-neg' : ''));
    const cell = (label, val, extra = '') => `<div class="cost-calc-kpi${extra}"><span class="cost-calc-kpi-label">${label}</span><span class="cost-calc-kpi-val">${val}</span></div>`;
    return `<div class="cost-calc-month">
            ${title ? `<div class="cost-calc-month-title">${escHtml(title)}</div>` : ''}
            <div class="cost-calc-kpis">
                ${cell('Расходы', expenses == null ? 'нет данных' : formatRub(expenses))}
                ${cell('Субсидия', expenses == null ? '—' : (subsidized ? (subsidy ? formatRub(subsidy) : '0 ₽') : '—'))}
                ${cell('Доход', revenue == null ? '—' : formatRub(revenue))}
                ${cell('Фин. рез.', fin == null ? '—' : formatRubSigned(fin), ' cost-calc-kpi-fin' + finCls)}
            </div>
        </div>`;
}

function refreshCostCalc() {
    const form = document.getElementById('cost-calc-form');
    const result = document.getElementById('cost-calc-result');
    if (!form || !result) return;

    if (typeof RouteCosts === 'undefined' || !RouteCosts.loaded) {
        form.innerHTML = '';
        result.innerHTML = `
            <div class="table-empty-state">
                <div class="table-empty-icon">📂</div>
                <div class="table-empty-title">Нет файла расходов</div>
            </div>`;
        return;
    }

    const routes = RouteCosts.listRoutes();
    if (!routes.length) {
        form.innerHTML = '';
        result.innerHTML = `
            <div class="table-empty-state">
                <div class="table-empty-title">В файле нет маршрутов</div>
            </div>`;
        return;
    }

    const st = loadCostCalcState();
    let route = routes.find(r => r.id === st.routeId) || routes[0];
    const aircraft = RouteCosts.listAircraft(route.fromKey, route.toKey);
    let ac = aircraft.find(a => a.key === st.ac)?.key || aircraft[0]?.key || '';
    const formSig = routes.map(r => r.id).join(',') + '|' + ac;
    if (form.dataset.built === formSig && form.childElementCount) {
        // Форма та же, но файл расходов мог обновиться — пересчитываем цифры.
        if (typeof paintCostCalcResult === 'function') paintCostCalcResult(loadCostCalcState());
        return;
    }
    form.dataset.built = formSig;

    const routeOpts = routes.map(r =>
        `<option value="${escAttr(r.id)}"${r.id === route.id ? ' selected' : ''}>${escHtml(r.label)}</option>`
    ).join('');
    const acOpts = aircraft.map(a =>
        `<option value="${escAttr(a.key)}"${a.key === ac ? ' selected' : ''}>${escHtml(a.label)}</option>`
    ).join('');

    form.innerHTML = `
        <div class="cost-calc-grid">
            <label class="cost-calc-field">
                <span>Маршрут</span>
                <select id="cost-calc-route" class="table-sort-select cost-calc-select">${routeOpts}</select>
            </label>
            <label class="cost-calc-field">
                <span>Тип ВС</span>
                <select id="cost-calc-ac" class="table-sort-select cost-calc-select">${acOpts}</select>
            </label>
            <label class="cost-calc-field">
                <span>Субсидия</span>
                <select id="cost-calc-sub" class="table-sort-select cost-calc-select">
                    <option value="1"${st.subsidized ? ' selected' : ''}>Есть</option>
                    <option value="0"${!st.subsidized ? ' selected' : ''}>Нет</option>
                </select>
            </label>
            <label class="cost-calc-field">
                <span>Доход, ₽</span>
                <input id="cost-calc-rev" type="text" inputmode="decimal" class="cost-calc-input"
                    value="${escAttr(st.revenue)}" placeholder="0" autocomplete="off">
            </label>
        </div>`;

    const persistAndPaint = () => {
        const routeEl = document.getElementById('cost-calc-route');
        const acEl = document.getElementById('cost-calc-ac');
        const subEl = document.getElementById('cost-calc-sub');
        const revEl = document.getElementById('cost-calc-rev');
        const next = {
            routeId: routeEl?.value || '',
            ac: acEl?.value || '',
            subsidized: subEl?.value !== '0',
            revenue: revEl?.value || ''
        };
        saveCostCalcState(next);
        paintCostCalcResult(next);
    };

    form.querySelector('#cost-calc-route')?.addEventListener('change', () => {
        const routeEl = document.getElementById('cost-calc-route');
        const picked = routes.find(r => r.id === routeEl.value) || routes[0];
        const list = RouteCosts.listAircraft(picked.fromKey, picked.toKey);
        const acEl = document.getElementById('cost-calc-ac');
        if (acEl) {
            const keep = list.some(a => a.key === acEl.value) ? acEl.value : (list[0]?.key || '');
            acEl.innerHTML = list.map(a =>
                `<option value="${escAttr(a.key)}"${a.key === keep ? ' selected' : ''}>${escHtml(a.label)}</option>`
            ).join('');
        }
        persistAndPaint();
    });
    form.querySelector('#cost-calc-ac')?.addEventListener('change', persistAndPaint);
    form.querySelector('#cost-calc-sub')?.addEventListener('change', persistAndPaint);
    form.querySelector('#cost-calc-rev')?.addEventListener('input', persistAndPaint);

    persistAndPaint();
}

function paintCostCalcResult(st) {
    const box = document.getElementById('cost-calc-result');
    if (!box || typeof RouteCosts === 'undefined') return;
    const [fromKey, toKey] = String(st.routeId || '').split('|');
    const q = RouteCosts.quote(fromKey, toKey, st.ac, !!st.subsidized);
    const revenue = parseCostCalcRevenue(st.revenue);

    if (!q.found) {
        box.innerHTML = `
            <div class="table-empty-state">
                <div class="table-empty-title">Нет строки в «Расходах»</div>
            </div>`;
        return;
    }

    // Файл по месяцам: строка на каждый месяц и средняя за них. Старый файл — одна строка.
    if (q.months && q.months.length) {
        const have = q.months.filter(x => x.expenses != null);
        const avg = (k) => have.reduce((a, x) => a + x[k], 0) / have.length;
        const rows = q.months.map(x => costCalcKpiRow(COST_CALC_MONTHS[x.m - 1] ? COST_CALC_MONTHS[x.m - 1][0].toUpperCase() + COST_CALC_MONTHS[x.m - 1].slice(1) : `Месяц ${x.m}`, x.expenses, x.subsidy, revenue, !!st.subsidized));
        rows.push(costCalcKpiRow(`Среднее за ${have.length === q.months.length ? q.months.length : have.length + ' из ' + q.months.length} мес.`, have.length ? avg('expenses') : null, have.length ? avg('subsidy') : null, revenue, !!st.subsidized));
        box.innerHTML = rows.join('') + (q.krai ? '<p class="cost-calc-note">Краевой маршрут: субсидия 0 при любом выборе.</p>' : '');
        return;
    }
    box.innerHTML = costCalcKpiRow('', q.expenses, q.subsidy || 0, revenue, !!st.subsidized);
}

