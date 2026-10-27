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
    // Не число или нереально огромное («1e999») — как пустое поле: на экране не должно быть «Infinity» и «1e+21».
    return !isFinite(n) || Math.abs(n) > 1e13 ? null : n;
}

function createCostCalcView(c) {
    c.innerHTML = `
        <div class="table-page cost-calc-page">
            <div class="table-page-hero card cost-calc-hero">
                <div class="table-page-hero-main">
                    <h2 class="cost-calc-title">Расчёт расходов</h2>
                    <span class="table-page-hint">Расчёт на пару рейсов: туда и обратно. Введите доход — увидите результат.</span>
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
                // Записываем в справочник («Суммы субсидии и себестоимость») — он общий для всех и главнее файлов.
                let saved = false;
                if (typeof SubsidyRef !== 'undefined' && SubsidyRef.canEdit && SubsidyRef.canEdit() && RouteCosts.pivotEntries) {
                    const entries = RouteCosts.pivotEntries();
                    if (entries.length) {
                        const res = await SubsidyRef.applyImport({ amounts: entries });
                        saved = !!(res && res.ok);
                    }
                }
                if (typeof SessionStore !== 'undefined' && SessionStore.saveSnapshot) SessionStore.saveSnapshot(true);
                if (typeof ActivityLog !== 'undefined') ActivityLog.log('costs_upload', file.name);
                if (typeof showToast === 'function') showToast(`Себестоимость и субсидии загружены (маршрутов и типов ВС: ${r.costs / 2})` + (saved ? ' — записаны в справочник' : ' — в справочник не записаны (нет права на справочник субсидий)'));
                resolve(true);
            } catch (e) {
                if (typeof showToast === 'function') showToast('Не удалось прочитать файл', 'error');
                resolve(false);
            }
        });
        inp.addEventListener('cancel', () => { inp.remove(); resolve(false); });
        // Браузеры без события cancel: после закрытия диалога окно получает фокус.
        window.addEventListener('focus', () => {
            setTimeout(() => {
                if (inp.isConnected && !(inp.files && inp.files.length)) { inp.remove(); resolve(false); }
            }, 1000);
        }, { once: true });
        inp.click();
    });
}

function costCalcFlightsWord(n) {
    const a = n % 10, b = n % 100;
    if (a === 1 && b !== 11) return 'вылету';
    return 'вылетам';
}

const COST_CALC_MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

// Рубли для экрана: ноль — «0 ₽», а не прочерк. Знак минус — настоящий («−»).
function costCalcMoney(n) {
    if (n == null || isNaN(n)) return '';
    const v = Math.round(Number(n));
    return (v < 0 ? '−' : '') + formatNum(Math.abs(v)) + ' ₽';
}

// То же, но у прибыли стоит «+».
function costCalcSigned(n) {
    const v = Math.round(Number(n));
    return (v > 0 ? '+' : '') + costCalcMoney(v);
}

function costCalcPlural(n, one, few, many) {
    const a = n % 10, b = n % 100;
    if (a === 1 && b !== 11) return one;
    if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
    return many;
}

function costCalcKpiRow(title, expenses, subsidy, revenue, subsidized, compact) {
    const noExp = expenses == null;
    const fin = revenue == null || noExp ? null : (revenue - expenses + (subsidy || 0));
    const finR = fin == null ? null : Math.round(fin);
    const finCls = finR == null ? '' : (finR > 0 ? ' cost-calc-pos' : (finR < 0 ? ' cost-calc-neg' : ''));
    // Плитка: подпись, крупное значение, пояснение мелким серым. Если значения нет — понятный текст вместо прочерка.
    const cell = (cls, label, val, hint, none) => `<div class="cost-calc-kpi ${cls}${none ? ' cost-calc-kpi-none' : ''}">
                    <span class="cost-calc-kpi-label">${label}</span>
                    <span class="cost-calc-kpi-val">${val}</span>
                    <span class="cost-calc-kpi-hint">${hint}</span>
                </div>`;
    let subVal, subHint, subNone = false;
    if (noExp) { subVal = 'Нет данных'; subHint = 'Нет расходов — нечего сравнивать'; subNone = true; }
    else if (!subsidized) { subVal = 'Не учитывается'; subHint = 'В поле «Субсидия» выбрано «Нет»'; subNone = true; }
    else if (subsidy > 0) {
        const share = Math.round(subsidy / expenses * 100);
        subVal = costCalcMoney(subsidy);
        subHint = share >= 100 ? 'Покрывает все расходы' : `Покрывает ${share}% расходов`;
    } else { subVal = '0 ₽'; subHint = 'Субсидии на этом маршруте нет'; }
    return `<div class="cost-calc-month${compact ? ' cost-calc-month-compact' : ''}">
            ${title ? `<div class="cost-calc-month-title">${escHtml(title)}</div>` : ''}
            <div class="cost-calc-kpis">
                ${noExp
                    ? cell('cost-calc-kpi-exp', 'Расходы', 'Нет данных', 'В файле нет расходов', true)
                    : cell('cost-calc-kpi-exp', 'Расходы', costCalcMoney(expenses), 'Пара рейсов: туда и обратно')}
                ${cell('cost-calc-kpi-sub', 'Субсидия', subVal, subHint, subNone)}
                ${revenue == null
                    ? cell('cost-calc-kpi-rev', 'Доход', 'Не указан', 'Введите его в поле «Доход, ₽» выше', true)
                    : cell('cost-calc-kpi-rev', 'Доход', costCalcMoney(revenue), 'Выручка от продажи билетов')}
                ${fin == null
                    ? cell('cost-calc-kpi-fin', 'Фин. результат', 'Не рассчитан', noExp ? 'Нет данных о расходах' : 'Появится, когда введёте доход', true)
                    : cell('cost-calc-kpi-fin' + finCls, 'Фин. результат', costCalcSigned(finR), 'Доход + субсидия − расходы')}
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
                <div class="table-empty-hint">Загрузите файл с расходами в разделе «Отчёты».</div>
            </div>`;
        return;
    }

    const routes = RouteCosts.listRoutes();
    if (!routes.length) {
        form.innerHTML = '';
        result.innerHTML = `
            <div class="table-empty-state">
                <div class="table-empty-title">В файле нет маршрутов</div>
                <div class="table-empty-hint">Проверьте файл с расходами в разделе «Отчёты».</div>
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
                    value="${escAttr(st.revenue)}" placeholder="Например, 1 500 000" autocomplete="off">
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
        // Расходы могут быть в файле только с другим значением субсидии — подсказываем, что переключить.
        const other = RouteCosts.quote(fromKey, toKey, st.ac, !st.subsidized);
        const hint = other.found
            ? (st.subsidized
                ? 'Для этого маршрута и типа ВС расходы есть без субсидии. В поле «Субсидия» выберите «Нет».'
                : 'Для этого маршрута и типа ВС расходы есть с субсидией. В поле «Субсидия» выберите «Есть».')
            : 'Выберите другой маршрут или тип ВС.';
        box.innerHTML = `
            <div class="table-empty-state">
                <div class="table-empty-title">Для этого выбора нет расходов</div>
                <div class="table-empty-hint">${hint}</div>
            </div>`;
        return;
    }

    // Файл по месяцам: строка на каждый месяц и средняя за них. Старый файл — одна строка.
    if (q.months && q.months.length) {
        const have = q.months.filter(x => x.expenses != null);
        const avg = (k) => have.reduce((a, x) => a + x[k], 0) / have.length;
        const fl = (n) => (n == null ? '' : ` · по ${n} ${costCalcFlightsWord(n)}`);
        const monthName = (m) => (COST_CALC_MONTHS[m - 1] ? COST_CALC_MONTHS[m - 1][0].toUpperCase() + COST_CALC_MONTHS[m - 1].slice(1) : `Месяц ${m}`);
        const rows = q.months.map(x => costCalcKpiRow(monthName(x.m) + fl(x.flights), x.expenses, x.subsidy, revenue, !!st.subsidized, true));
        const nAll = have.some(x => x.flights != null) ? have.reduce((a, x) => a + (x.flights || 0), 0) : null;
        const avgWord = `Среднее за ${have.length === q.months.length ? q.months.length : have.length + ' из ' + q.months.length} мес.`;
        const avgExp = have.length ? avg('expenses') : null;
        const avgSub = have.length ? avg('subsidy') : null;
        // Сначала среднее и расчёт по нему (блоки считаются по среднему: в них одно число, а не три), месяцы — ниже, мельче.
        box.innerHTML = costCalcKpiRow(avgWord + fl(nAll), avgExp, avgSub, revenue, !!st.subsidized)
            + (q.krai ? '<p class="cost-calc-note">Краевой маршрут: субсидия 0 при любом выборе.</p>' : '')
            + `<h3 class="cost-calc-months-head">По месяцам</h3>` + rows.join('');
        return;
    }
    box.innerHTML = costCalcKpiRow('', q.expenses, q.subsidy || 0, revenue, !!st.subsidized)
        + (q.krai ? '<p class="cost-calc-note">Краевой маршрут: субсидия 0 при любом выборе.</p>' : '');
}

