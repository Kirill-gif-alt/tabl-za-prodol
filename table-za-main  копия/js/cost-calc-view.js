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
                    <span class="table-page-hint">на пару рейсов: туда и обратно</span>
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
                if (typeof showToast === 'function') showToast(`Себестоимость и субсидии загружены (маршрутов и самолётов: ${r.costs / 2})` + (saved ? ' — записаны в справочник' : ' — в справочник не записаны (нет права на справочник субсидий)'));
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
    else if (!subsidized) { subVal = 'Не учитывается'; subHint = 'Выбрано «Нет» в поле «Есть ли субсидия»'; subNone = true; }
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
                    ? cell('cost-calc-kpi-rev', 'Доход', 'Не указан', 'Впишите его в поле слева', true)
                    : cell('cost-calc-kpi-rev', 'Доход', costCalcMoney(revenue), 'Выручка от продажи билетов')}
                ${fin == null
                    ? cell('cost-calc-kpi-fin', 'Фин. результат', 'Не рассчитан', noExp ? 'Нет данных о расходах' : 'Появится, когда введёте доход', true)
                    : cell('cost-calc-kpi-fin' + finCls, 'Фин. результат', costCalcSigned(finR), 'Доход + субсидия − расходы')}
            </div>
        </div>`;
}

// ---------- Данные сайта по маршруту: сколько мест в самолёте и по каким билетам продаём ----------
let costCalcMemo = null;

function costCalcCityKey(name) {
    return String(name || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]/gi, '');
}

function costCalcMedian(list) {
    if (!list.length) return null;
    const a = list.slice().sort((x, y) => x - y);
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// Места одного рейса по типу ВС из настроек (запасной вариант, когда рейсов этого типа на сайте нет).
function costCalcParamSeats(acKey) {
    if (typeof PV === 'undefined') return null;
    const v = acKey === 'atr72' ? PV.ATR72_CAPACITY : acKey === 'yak42' ? PV.YAK42_CAPACITY : acKey === 'atr42' ? PV.DEFAULT_AIRCRAFT_CAPACITY : null;
    return v > 0 ? v : null;
}

// Всё, что сайт знает про маршрут: рейсы, места по типам ВС, оплаченные билеты, предельные тарифы справочника.
function costCalcRouteData(fromKey, toKey) {
    const gd = typeof groupedData !== 'undefined' ? groupedData : null;
    const sd = typeof salesDetails !== 'undefined' ? salesDetails : null;
    const rev = typeof FareRefs !== 'undefined' && FareRefs.revision ? FareRefs.revision() : 0;
    const key = fromKey + '|' + toKey;
    const m = costCalcMemo;
    if (m && m.key === key && m.gd === gd && m.sd === sd && m.rev === rev) return m.data;

    const data = { flights: 0, seats: {}, fareN: 0, fareSum: 0, limits: [] };
    const codes = [];
    if (gd && typeof getCitiesFromFlight === 'function') {
        Object.keys(gd).forEach((code) => {
            const c = getCitiesFromFlight(code);
            if (!c || c.length < 2) return;
            const a = costCalcCityKey(c[0]), b = costCalcCityKey(c[1]);
            if ((a === fromKey && b === toKey) || (a === toKey && b === fromKey)) codes.push(code);
        });
    }
    data.flights = codes.length;
    const seatsList = Object.create(null);
    codes.forEach((code) => {
        (gd[code] || []).forEach((row) => {
            const ak = typeof getAircraftType === 'function' ? RouteCosts.acKey(getAircraftType(row[4])) : '';
            const n = typeof getSeatsOnSale === 'function' ? getSeatsOnSale(row) : 0;
            if (ak && n > 0) (seatsList[ak] = seatsList[ak] || []).push(n);
        });
    });
    Object.keys(seatsList).forEach((ak) => { data.seats[ak] = Math.round(costCalcMedian(seatsList[ak])); });
    if (sd && codes.length) {
        const set = new Set(codes);
        Object.keys(sd).forEach((k) => {
            const i = k.lastIndexOf('|');
            if (i < 0 || !set.has(k.slice(i + 1))) return;
            const list = sd[k] || [];
            for (let j = 0; j < list.length; j++) {
                const v = list[j].adjustedFare || list[j].fare || 0;
                if (v > 0) { data.fareN++; data.fareSum += v; }
            }
        });
    }
    if (codes.length && typeof FareRefs !== 'undefined' && FareRefs.list && (!FareRefs.canView || FareRefs.canView())) {
        const seen = Object.create(null);
        let list = [];
        try { list = FareRefs.list() || []; } catch { list = []; }
        list.forEach((e) => {
            if (!e || e.mode !== 'limit' || !(e.adult > 0)) return;
            if (!(e.flights || []).some(f => codes.indexOf(f) !== -1)) return;
            const v = Math.round(e.adult);
            if (!seen[v]) { seen[v] = true; data.limits.push(v); }
        });
        data.limits.sort((x, y) => x - y);
    }
    costCalcMemo = { key, gd, sd, rev, data };
    return data;
}

// Места одного рейса: { n, src } — из данных сайта, иначе из настроек; null, если неизвестно.
function costCalcSeatsOne(data, acKey) {
    if (data.seats[acKey] > 0) return { n: data.seats[acKey], src: 'site' };
    const p = costCalcParamSeats(acKey);
    return p ? { n: p, src: 'params' } : null;
}

// Круглые цены вокруг среднего билета: средняя ступень — ближайшая к среднему.
function costCalcFareLadder(avg) {
    const step = avg >= 6000 ? 1000 : (avg >= 2000 ? 500 : 200);
    const mid = Math.max(step, Math.round(avg / step) * step);
    const out = [];
    for (let k = -2; k <= 2; k++) {
        const v = mid + k * step;
        if (v > 0) out.push({ price: v, mid: k === 0 });
    }
    return out;
}

// Вывод словами: в плюс / в минус на сумму, либо просьба ввести доход.
function costCalcVerdict(expenses, subsidy, revenue) {
    const need = Math.max(0, Math.round(expenses - (subsidy || 0)));
    const needTxt = need > 0
        ? ` Чтобы не уйти в минус, нужно собрать с продаж не меньше <b>${costCalcMoney(need)}</b>.`
        : ' Субсидия покрывает все расходы: даже без продаж пара рейсов не уйдёт в минус.';
    if (revenue == null) {
        return `<div class="cost-calc-verdict cost-calc-verdict-none">
            <span class="cost-calc-verdict-label">Итог</span>
            <span class="cost-calc-verdict-val">Введите доход</span>
            <p class="cost-calc-verdict-text">Впишите слева, сколько денег ждёте от продаж, — увидите, в плюс или в минус выйдет пара рейсов.${needTxt}</p>
        </div>`;
    }
    const fin = Math.round(revenue - expenses + (subsidy || 0));
    const cls = fin > 0 ? 'cost-calc-pos' : (fin < 0 ? 'cost-calc-neg' : '');
    const words = fin > 0 ? `Пара рейсов <b>в плюс</b> на <b>${costCalcMoney(fin)}</b>.`
        : fin < 0 ? `Пара рейсов <b>в минус</b> на <b>${costCalcMoney(-fin)}</b>.`
        : 'Пара рейсов выходит <b>ровно в ноль</b>.';
    return `<div class="cost-calc-verdict ${cls}">
            <span class="cost-calc-verdict-label">Итог при доходе ${costCalcMoney(revenue)}</span>
            <span class="cost-calc-verdict-val">${costCalcSigned(fin)}</span>
            <p class="cost-calc-verdict-text">${words}${needTxt}</p>
        </div>`;
}

// Таблица: по какому билету сколько мест занять на пару рейсов, чтобы не уйти в минус.
function costCalcNeedTable(expenses, subsidy, acKey, data) {
    const need = Math.max(0, Math.round(expenses - (subsidy || 0)));
    const head = (sub) => `<div class="cost-calc-block-head"><h3>Сколько мест занять и по какому билету, чтобы не уйти в минус</h3><span class="cost-calc-block-sub">${sub}</span></div>`;
    if (need <= 0) {
        return `<section class="cost-calc-block card">${head('')}
            <p class="cost-calc-block-empty">Субсидия покрывает все расходы, поэтому занимать места ради «нуля» не нужно — любая продажа уже плюс.</p></section>`;
    }
    const one = costCalcSeatsOne(data, acKey);
    const total = one ? one.n * 2 : null;

    // Цены: справочник предельных тарифов, иначе круглые ступени вокруг среднего билета по продажам.
    const avg = data.fareN ? data.fareSum / data.fareN : null;
    let rows = [], priceNote = '';
    if (data.limits.length) {
        rows = data.limits.slice(0, 6).map(p => ({ price: p, tag: 'предельный тариф' }));
        priceNote = 'Цены — предельные тарифы из справочника тарифов для рейсов этого маршрута.'
            + (avg ? ` Средний проданный билет на маршруте: ${costCalcMoney(avg)} (по ${formatNum(data.fareN)} билетам).` : '');
    } else if (avg) {
        rows = costCalcFareLadder(avg).map(r => ({ price: r.price, tag: r.mid ? 'около среднего' : '' }));
        priceNote = `Цены — круглые ступени вокруг среднего проданного билета на маршруте: ${costCalcMoney(avg)} (по ${formatNum(data.fareN)} билетам).`;
    }
    const seatWord = (n) => costCalcPlural(n, 'место', 'места', 'мест');
    if (!rows.length) {
        const why = data.flights
            ? 'в продажах по этому маршруту нет оплаченных билетов, а в справочнике тарифов нет записи для его рейсов'
            : 'на сайте нет рейсов этого маршрута, а в справочнике тарифов для него нет записи';
        if (!total) {
            return `<section class="cost-calc-block card">${head('')}
                <p class="cost-calc-block-empty"><b>Таблицу показать не из чего:</b> ${why}. Не знаем и число мест в этом самолёте: рейсов этого типа на маршруте нет, а в настройках оно не задано. Загрузите продажи в «Отчётах» или внесите тариф маршрута в справочник тарифов.</p></section>`;
        }
        // Цен нет — показываем наоборот: какой средний билет нужен при каждой загрузке.
        const back = [50, 60, 70, 80, 90, 100].map((pct) => {
            const seats = Math.ceil(total * pct / 100);
            return `<tr><td><b>${pct}%</b></td><td class="cost-calc-num"><b>${formatNum(seats)}</b> ${seatWord(seats)}</td>
                <td class="cost-calc-num"><b class="cost-calc-price">${costCalcMoney(Math.ceil(need / seats))}</b></td></tr>`;
        }).join('');
        return `<section class="cost-calc-block card">${head(`пара рейсов, ${formatNum(total)} ${seatWord(total)} всего`)}
            <p class="cost-calc-block-empty cost-calc-block-lead"><b>Цен билета для этого маршрута сайт не знает:</b> ${why}. Поэтому показано наоборот: какой средний билет нужен при каждой загрузке.</p>
            <div class="cost-calc-table-wrap"><table class="cost-calc-table">
                <thead><tr><th>Загрузка самолёта</th><th class="cost-calc-num">Мест на пару рейсов</th><th class="cost-calc-num">Нужен средний билет</th></tr></thead>
                <tbody>${back}</tbody></table></div>
            <p class="cost-calc-block-note">${one.src === 'site' ? 'Места — по рейсам этого самолёта на сайте (в продаже), на пару рейсов — вдвое.' : 'Мест на сайте для этого самолёта пока нет, число взято из настроек сайта.'} Считаем, что каждое занятое место приносит одну цену, детские и бесплатные билеты не учтены.</p>
        </section>`;
    }

    const body = rows.map((r) => {
        const seats = Math.ceil(need / r.price);
        let load = '<span class="cost-calc-muted">нет данных</span>';
        let over = false;
        if (total) {
            const pct = Math.round(seats / total * 100);
            over = seats > total;
            load = over ? `<span class="cost-calc-neg">${pct}% — мест не хватит</span>` : `<b>${pct}%</b>`;
        }
        return `<tr class="${r.tag === 'около среднего' ? 'cost-calc-row-mid' : ''}${over ? ' cost-calc-row-over' : ''}">
            <td><b class="cost-calc-price">${costCalcMoney(r.price)}</b>${r.tag ? ` <span class="cost-calc-tag">${r.tag}</span>` : ''}</td>
            <td class="cost-calc-num"><b>${formatNum(seats)}</b> ${seatWord(seats)}</td>
            <td class="cost-calc-num">${load}</td>
        </tr>`;
    }).join('');

    let sub, seatNote = '';
    if (total) {
        sub = `пара рейсов, ${formatNum(total)} ${seatWord(total)} всего`;
        seatNote = one.src === 'site'
            ? 'Места — по рейсам этого самолёта на сайте (в продаже), на пару рейсов — вдвое.'
            : 'Мест на сайте для этого самолёта пока нет, число взято из настроек сайта.';
    } else {
        sub = 'число мест в самолёте неизвестно';
        seatNote = 'Сколько мест в этом самолёте, сайт не знает: рейсов этого типа на маршруте нет, а в настройках число мест для него не задано. Поэтому загрузка в процентах не посчитана.';
    }
    return `<section class="cost-calc-block card">${head(sub)}
        <div class="cost-calc-table-wrap"><table class="cost-calc-table">
            <thead><tr><th>Цена билета</th><th class="cost-calc-num">Занять мест на пару рейсов</th><th class="cost-calc-num">Загрузка самолёта</th></tr></thead>
            <tbody>${body}</tbody></table></div>
        <p class="cost-calc-block-note">${priceNote} Считаем, что каждое занятое место приносит цену билета, детские и бесплатные билеты не учтены. ${seatNote}</p>
    </section>`;
}

// Список самолётов маршрута: «Як-42 · 114 мест», если число мест известно.
function costCalcAcOptions(route, keep) {
    const data = costCalcRouteData(route.fromKey, route.toKey);
    return RouteCosts.listAircraft(route.fromKey, route.toKey).map((a) => {
        const one = costCalcSeatsOne(data, a.key);
        const label = one ? `${a.label} · ${one.n} ${costCalcPlural(one.n, 'место', 'места', 'мест')}` : a.label;
        return `<option value="${escAttr(a.key)}"${a.key === keep ? ' selected' : ''}>${escHtml(label)}</option>`;
    }).join('');
}

function refreshCostCalc() {
    const form = document.getElementById('cost-calc-form');
    const result = document.getElementById('cost-calc-result');
    if (!form || !result) return;
    costCalcMemo = null;

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
    const acOpts = costCalcAcOptions(route, ac);
    const formSig = routes.map(r => r.id).join(',') + '|' + ac + '|' + acOpts;
    if (form.dataset.built === formSig && form.childElementCount) {
        // Форма та же, но файл расходов мог обновиться — пересчитываем цифры.
        if (typeof paintCostCalcResult === 'function') paintCostCalcResult(loadCostCalcState());
        return;
    }
    form.dataset.built = formSig;

    const routeOpts = routes.map(r =>
        `<option value="${escAttr(r.id)}"${r.id === route.id ? ' selected' : ''}>${escHtml(r.label)}</option>`
    ).join('');

    form.innerHTML = `
        <div class="cost-calc-grid">
            <label class="cost-calc-field">
                <span>Маршрут</span>
                <select id="cost-calc-route" class="table-sort-select cost-calc-select">${routeOpts}</select>
            </label>
            <label class="cost-calc-field">
                <span>Самолёт</span>
                <select id="cost-calc-ac" class="table-sort-select cost-calc-select">${acOpts}</select>
            </label>
            <div class="cost-calc-field" role="group" aria-labelledby="cost-calc-sub-label">
                <span id="cost-calc-sub-label">Есть ли субсидия</span>
                <div class="cost-calc-chips">
                    <button type="button" class="cost-calc-chip${st.subsidized ? ' on' : ''}" data-sub="1" aria-pressed="${st.subsidized}">Есть</button>
                    <button type="button" class="cost-calc-chip${!st.subsidized ? ' on' : ''}" data-sub="0" aria-pressed="${!st.subsidized}">Нет</button>
                </div>
                <input type="hidden" id="cost-calc-sub" value="${st.subsidized ? '1' : '0'}">
            </div>
            <label class="cost-calc-field">
                <span>Сколько денег ждёте от продаж (доход), ₽</span>
                <input id="cost-calc-rev" type="text" inputmode="decimal" class="cost-calc-input cost-calc-input-big"
                    value="${escAttr(st.revenue)}" placeholder="Например, 1 500 000" autocomplete="off">
                <small class="cost-calc-field-hint">Не знаете — посмотрите таблицу справа: там видно, сколько нужно набрать.</small>
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
            acEl.innerHTML = costCalcAcOptions(picked, keep);
        }
        persistAndPaint();
    });
    form.querySelector('#cost-calc-ac')?.addEventListener('change', persistAndPaint);
    form.querySelectorAll('.cost-calc-chip').forEach((btn) => {
        btn.addEventListener('click', () => {
            const subEl = document.getElementById('cost-calc-sub');
            if (subEl) subEl.value = btn.dataset.sub;
            form.querySelectorAll('.cost-calc-chip').forEach((b) => {
                const on = b === btn;
                b.classList.toggle('on', on);
                b.setAttribute('aria-pressed', on ? 'true' : 'false');
            });
            persistAndPaint();
        });
    });
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
                ? 'Для этого маршрута и самолёта расходы есть без субсидии. В поле «Есть ли субсидия» выберите «Нет».'
                : 'Для этого маршрута и самолёта расходы есть с субсидией. В поле «Есть ли субсидия» выберите «Есть».')
            : 'Выберите другой маршрут или самолёт.';
        box.innerHTML = `
            <div class="table-empty-state">
                <div class="table-empty-title">Для этого выбора нет расходов</div>
                <div class="table-empty-hint">${hint}</div>
            </div>`;
        return;
    }

    const data = costCalcRouteData(fromKey, toKey);
    const sub = !!st.subsidized;
    const krai = q.krai ? '<p class="cost-calc-note">Краевой маршрут: субсидия 0 при любом выборе.</p>' : '';
    // Вывод словами, плитки и таблица «сколько мест занять» — по среднему за месяцы (или по единственной строке файла).
    const top = (title, exp, subs) => (exp == null ? '' : costCalcVerdict(exp, subs, revenue))
        + costCalcKpiRow(title, exp, subs, revenue, sub)
        + (exp == null ? '' : costCalcNeedTable(exp, subs, st.ac, data));

    // Файл по месяцам: строка на каждый месяц и средняя за них. Старый файл — одна строка.
    if (q.months && q.months.length) {
        const have = q.months.filter(x => x.expenses != null);
        const avg = (k) => have.reduce((a, x) => a + x[k], 0) / have.length;
        const fl = (n) => (n == null ? '' : ` · по ${n} ${costCalcFlightsWord(n)}`);
        const monthName = (m) => (COST_CALC_MONTHS[m - 1] ? COST_CALC_MONTHS[m - 1][0].toUpperCase() + COST_CALC_MONTHS[m - 1].slice(1) : `Месяц ${m}`);
        const rows = q.months.map(x => costCalcKpiRow(monthName(x.m) + fl(x.flights), x.expenses, x.subsidy, revenue, sub, true));
        const nAll = have.some(x => x.flights != null) ? have.reduce((a, x) => a + (x.flights || 0), 0) : null;
        const avgWord = `Среднее за ${have.length === q.months.length ? q.months.length : have.length + ' из ' + q.months.length} мес.`;
        const avgExp = have.length ? avg('expenses') : null;
        const avgSub = have.length ? avg('subsidy') : null;
        box.innerHTML = top(avgWord + fl(nAll), avgExp, avgSub) + krai
            + `<h3 class="cost-calc-months-head">По месяцам</h3>` + rows.join('');
        return;
    }
    box.innerHTML = top('', q.expenses, q.subsidy || 0) + krai;
}
