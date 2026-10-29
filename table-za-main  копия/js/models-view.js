// «Отчёты» → «Модели»: две модели прогноза загрузки рядом.
//  • карточки моделей: статус, когда обучена, ошибка в пассажирах за 30 / 14 / 7 / 1–3 дня, вывод простыми словами;
//  • одна таблица «Ближайшие рейсы»: модель 1 (ForecastLab) и модель 2 (MlForecast), разница, сигналы, фильтры, «В Excel»;
//  • график «Точность по срокам»;
//  • свёрнутый блок «Подробно для аналитика» — всё остальное из бывшего «Прогноза и предупреждений» (рисуется при раскрытии).
// Новых расчётов здесь нет: сигналы считает ForecastLab (computeWarnings), модель 2 — MlForecast.compareFlights (кэш там же).
window.ModelsView = (function () {
    const PAGE = 100;                      // строк в таблице за раз; дальше — «Показать ещё»
    const KEYS = [['30', 'за 30 дн.'], ['14', 'за 14 дн.'], ['7', 'за 7 дн.'], ['1_3', 'за 1–3 дня']];
    const M2KEY = { '30': '30d', '14': '14d', '7': '7d', '1_3': '1_3d' };
    const FILTERS = [['all', 'Все'], ['alarm', 'Тревоги'], ['diff', 'Модели расходятся'], ['under', 'Недобор'], ['over', 'Перегруз'], ['pace', 'Необычный темп']];
    const SIGNAL = { under: ['Недобор', 'md-sg-under'], over: ['Перегруз', 'md-sg-over'], fast: ['Темп ↑', 'md-sg-pace'], slow: ['Темп ↓', 'md-sg-pace'] };

    // Состояние страницы (живёт, пока вкладка открыта; при выходе из сайта не сохраняется).
    const view = { filter: 'all', sort: 'default', shown: PAGE, open: new Set(), analyst: false };
    let uni = { sig: '', rows: [] };                       // вылеты горизонта (по данным сайта)
    let m1Map = { arr: null, map: null };                   // сигналы модели 1 по ключу «дата|рейс»
    const m2 = { sig: '', map: new Map(), running: '', done: '', token: 0 };   // модель 2 по ключу «дата|рейс»
    let lastRows = [];                                      // что сейчас на экране (с учётом фильтра), для «В Excel»
    let rowByKey = new Map();
    let chart = null;
    let themeObs = null;
    let clickTimer = 0;
    let renderTimer = 0;
    let mlStamp = '';
    let mounted = false;

    // ---------- общее ----------
    function esc(v) {
        return typeof escHtml === 'function' ? escHtml(v) : String(v == null ? '' : v);
    }
    function hasM1() { return typeof ForecastLab !== 'undefined' && ForecastLab.canView(); }
    function hasM2() { return typeof MlForecast !== 'undefined' && MlForecast.canView(); }
    function canView() { return hasM1() || hasM2(); }
    function alive() { return mounted && !!document.getElementById('md-root'); }
    function today() { return typeof getTodayDate === 'function' ? getTodayDate() : ''; }
    function toast(msg, type) { if (typeof showToast === 'function') showToast(msg, type); }
    function r1(v) { return (Math.round(v * 10) / 10).toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }
    function signed(n) { return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n); }
    function pad(n) { return String(n).padStart(2, '0'); }
    function plural(n, a, b, c) { return typeof pluralRu === 'function' ? pluralRu(n, a, b, c) : (n === 1 ? a : (n >= 2 && n <= 4 ? b : c)); }

    function settings() {
        if (typeof ForecastLab !== 'undefined' && ForecastLab.warnSettings) return ForecastLab.warnSettings();
        return { under: PV.WARN_UNDER, over: PV.WARN_OVER, days: PV.WARN_DAYS };
    }
    function diffLimit() { return (typeof PV !== 'undefined' && PV.MODELS_DIFF) || 5; }

    function when(ts) {
        const d = new Date(ts);
        if (isNaN(d.getTime())) return '';
        const same = typeof formatDateRu === 'function' ? formatDateRu(d) === formatDateRu(new Date()) : false;
        return `${same ? 'сегодня' : (typeof formatDateRu === 'function' ? formatDateRu(d) : d.toLocaleDateString('ru-RU'))} в ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    // ---------- вылеты горизонта ----------
    // Один вылет (рейс + дата) — одна строка. Список строится один раз на подпись данных (файл, день, горизонт).
    function universe(days) {
        const sig = [typeof dataEpoch === 'number' ? dataEpoch : 0, today(), days].join('|');
        if (uni.sig === sig) return uni.rows;
        const t0 = typeof parseLocalDate === 'function' ? parseLocalDate(today()) : null;
        const rows = [];
        if (t0 && typeof groupedData !== 'undefined' && groupedData) {
            const dates = new Map();
            for (let i = 1; i <= days; i++) dates.set(formatDateRu(new Date(t0.getFullYear(), t0.getMonth(), t0.getDate() + i)), i);
            const seen = new Set();
            Object.keys(groupedData).forEach(base => {
                (groupedData[base] || []).forEach(r => {
                    if (!r || !dates.has(r[1])) return;
                    const code = cleanFlight(r[0]);
                    const key = r[1] + '|' + code;
                    if (seen.has(key)) return;
                    const seats = typeof getSeatsOnSale === 'function' ? getSeatsOnSale(r) : 0;
                    if (!(seats > 0)) return;
                    seen.add(key);
                    const d = parseLocalDate(r[1]);
                    rows.push({
                        key, code, date: r[1], ts: d ? d.getTime() : 0, dtd: dates.get(r[1]),
                        dir: typeof getFlightDirection === 'function' ? getFlightDirection(code) : '',
                        sold: typeof getSoldFromRow === 'function' ? getSoldFromRow(r) : 0, seats
                    });
                });
            });
        }
        uni = { sig, rows };
        return rows;
    }

    function m1Lookup() {
        if (!hasM1()) return null;
        const arr = ForecastLab.signalsAll();
        if (!arr) return null;
        if (m1Map.arr !== arr) {
            const map = new Map();
            arr.forEach(w => map.set(w.date + '|' + w.code, w));
            m1Map = { arr, map };
        }
        return m1Map.map;
    }

    // Строки таблицы: вылет + модель 1 + модель 2 + сигналы. Только чтение готовых кэшей — дорогих расчётов здесь нет.
    function compose() {
        const cfg = settings();
        const base = universe(cfg.days);
        const lookup = m1Lookup();
        const state2 = hasM2() ? MlForecast.status() : 'off';
        const limit = diffLimit();
        return base.map(u => {
            const w = lookup ? lookup.get(u.key) : null;
            const r = { u, key: u.key, code: u.code, date: u.date, ts: u.ts, dtd: u.dtd, dir: u.dir, sold: u.sold, seats: u.seats, w };
            r.m1state = !hasM1() ? 'off' : (!lookup ? 'wait' : (w ? 'ok' : 'none'));
            r.m1 = w ? w.final : null;
            r.m1lf = w ? w.lf : null;
            r.kinds = w ? w.kinds : [];
            r.m2info = null;
            if (!hasM2()) r.m2state = 'off';
            else if (state2 === 'ready') {
                const x = m2.map.get(u.key);
                r.m2state = x ? (x.s === 'ok' ? 'ok' : (x.s === 'loading' ? 'wait' : 'none')) : 'wait';
                if (x && x.s === 'ok') r.m2info = x;
            } else r.m2state = state2 === 'training' || state2 === 'unknown' ? 'wait' : 'none';
            r.m2 = r.m2info ? r.m2info.pred : null;
            r.m2lf = r.m2info && u.seats ? Math.round(r.m2info.pred / u.seats * 100) : null;
            r.diff = r.m1 != null && r.m2 != null ? r.m2 - r.m1 : null;
            r.diverge = r.diff != null && Math.abs(r.diff) >= limit;
            r.alarm = r.kinds.length > 0;
            return r;
        });
    }

    const hasPace = (r) => r.kinds.includes('fast') || r.kinds.includes('slow');
    const MATCH = {
        all: () => true,
        alarm: (r) => r.alarm,
        diff: (r) => r.diverge,
        under: (r) => r.kinds.includes('under'),
        over: (r) => r.kinds.includes('over'),
        pace: hasPace
    };

    function codeNum(c) { return parseInt(String(c).slice(3), 10) || 0; }
    const SORTS = {
        // Тревоги и расхождения сверху, затем по дате; внутри даты — самые срочные.
        default: (a, b) => ((b.alarm || b.diverge ? 1 : 0) - (a.alarm || a.diverge ? 1 : 0)) || (a.ts - b.ts) || ((b.w ? b.w.urgency : 0) - (a.w ? a.w.urgency : 0)) || (codeNum(a.code) - codeNum(b.code)),
        date: (a, b) => (a.ts - b.ts) || (codeNum(a.code) - codeNum(b.code)),
        diff: (a, b) => (Math.abs(b.diff == null ? -1 : b.diff) - Math.abs(a.diff == null ? -1 : a.diff)) || (a.ts - b.ts),
        code: (a, b) => (codeNum(a.code) - codeNum(b.code)) || (a.ts - b.ts)
    };

    // ---------- «Коротко» и подробности ----------
    function shortText(r) {
        const w = r.w;
        const out = [];
        if (w && r.kinds.length) {
            const gap = w.paceGap;
            if (r.sold >= r.seats) out.push('распродан');
            else if (r.kinds.includes('under') && !(gap != null && gap <= -PV.PACE_GAP)) out.push(`занято ${Math.round(r.sold / r.seats * 100)}%`);
            if (gap != null && Math.abs(gap) >= PV.PACE_GAP) out.push(gap > 0 ? `+${gap} к обычному` : `отстаёт на ${Math.abs(gap)}`);
            if (r.kinds.includes('under')) out.push('стоит снижать');
            else if (r.kinds.includes('over') && r.sold < r.seats) out.push('стоит поднять цену');
            if (w.cal && w.cal[0]) out.push(String(w.cal[0]).toLowerCase());
        }
        if (r.diverge) out.push(r.diff > 0 ? 'модель 2 ждёт больше' : 'модель 2 ждёт меньше');
        if (!out.length) return r.m1state === 'ok' || r.m2state === 'ok' ? 'в норме' : '';
        return out.slice(0, 4).join(' · ');
    }

    function detailHtml(r) {
        const w = r.w;
        const rows = [];
        if (w) {
            rows.push(`<div><b>Модель 1:</b> ${w.final} из ${w.s} (${w.lf}%)${w.lo != null ? `, интервал ${w.lo}–${w.hi}${w.hiRaw > w.s ? ` (без учёта кресел до ${w.hiRaw})` : ''}` : ''}${w.method ? `, способ: ${esc(w.method)}` : ''}${w.err != null ? `, обычно ошибается на ±${esc(String(w.err).replace('.', ','))} пасс.` : ''}</div>`);
        }
        if (r.m2info) {
            const i = r.m2info;
            rows.push(`<div><b>Модель 2:</b> ${i.pred} из ${r.seats} (${r.m2lf}%)${i.closed ? '' : `, уверенность ${Math.round(i.conf * 100)}%`}${i.flags && i.flags.length ? `. Замечания: ${esc(i.flags.join('; '))}` : ''}.</div>`);
        }
        if (w && w.why && w.why.length) rows.push(`<div><b>Почему:</b> ${w.why.map(esc).join('; ')}.</div>`);
        if (w && w.act && w.act.length) rows.push(`<div><b>Что сделать:</b> ${w.act.map(esc).join('; ')}.</div>`);
        if (r.diverge) rows.push(`<div><b>Модели расходятся:</b> модель 2 ${r.diff > 0 ? 'ждёт больше' : 'ждёт меньше'} на ${Math.abs(r.diff)} пасс. (порог — ${diffLimit()}).</div>`);
        if (w && !r.kinds.length && !r.diverge) rows.push('<div class="md-muted">Сигналов нет: прогноз в пределах нормы.</div>');
        if (!rows.length) rows.push('<div class="md-muted">Прогноза по этому рейсу пока нет.</div>');
        return rows.join('');
    }

    // ---------- карточки моделей ----------
    function pill(cls, text) { return `<span class="md-pill md-pill-${cls}">${esc(text)}</span>`; }

    function m1Card() {
        const s = ForecastLab.summary();
        let pillHtml = pill('warn', 'Учится…');
        let sub = 'Проверяет себя на прошлых неделях. Это занимает несколько секунд, работать на сайте можно.';
        let err = null;
        let note = '';
        if (s.s === 'ok') {
            pillHtml = pill('ok', 'Работает');
            const bits = [`Обучена ${when(s.at)}`, `${(s.departures || 0).toLocaleString('ru-RU')} ${plural(s.departures || 0, 'вылет', 'вылета', 'вылетов')} с фактом`];
            if (s.lag > 1 && s.salesAt) bits.push(`данные продаж от ${formatDateRu(new Date(s.salesAt))}`);
            sub = bits.join(' · ');
            err = {};
            KEYS.forEach(([k]) => { err[k] = s.err[k] ? s.err[k].v : null; });
        } else if (s.s === 'few') {
            pillHtml = pill('warn', 'Мало данных');
            sub = `Обучена ${when(s.at)}`;
            note = `Улетевших вылетов пока мало (${s.departures || 0}) — честно проверить модель не на чем. Сравниваются только простые способы.`;
        }
        return { n: 1, title: 'Модель 1 · расчёт сайта', pill: pillHtml, sub, err, note, naive: s.s === 'ok' ? s.naive : null };
    }

    function m2Card() {
        const state = MlForecast.status();
        const h = MlForecast.health() || {};
        let pillHtml = pill('warn', 'Проверяю…');
        let sub = '';
        let err = null;
        let note = '';
        if (state === 'ready') {
            pillHtml = pill('ok', 'Работает');
            const bits = [];
            const tr = h.trained_at ? new Date(h.trained_at) : null;
            if (tr && !isNaN(tr.getTime())) bits.push(`Обучена ${when(tr.getTime())}`);
            if (h.n_flights) bits.push(`${Number(h.n_flights).toLocaleString('ru-RU')} ${plural(h.n_flights, 'вылет', 'вылета', 'вылетов')} в истории`);
            bits.push('переучивается раз в день сама');
            sub = bits.join(' · ');
            err = {};
            KEYS.forEach(([k]) => {
                const m = h.metrics && h.metrics[M2KEY[k]];
                const v = m && m.ensemble && m.ensemble.mae;
                err[k] = typeof v === 'number' ? v : null;
            });
        } else if (state === 'training') {
            pillHtml = pill('warn', `Учится ${Math.round((h.progress || 0) * 100)}%`);
            sub = 'Это бывает раз в день и занимает пару минут. Работать на сайте можно.';
        } else if (state === 'nomodel') {
            pillHtml = pill('warn', 'Мало данных');
            note = `Модели пока нечему учиться${h.detail ? ' (' + h.detail + ')' : ''}. Нужна история улетевших вылетов с продажами по дням — загрузите данные кнопкой «Загрузить».`;
        } else if (state === 'offline') {
            pillHtml = pill('bad', 'Недоступна');
            note = 'Модель сейчас не отвечает. Попробуйте открыть раздел ещё раз.';
        }
        let naive = null;
        if (state === 'ready' && h.metrics) {
            naive = {};
            KEYS.forEach(([k]) => { const m = h.metrics[M2KEY[k]]; const v = m && m._baseline_booked && m._baseline_booked.mae; naive[k] = typeof v === 'number' ? { v } : null; });
        }
        return { n: 2, title: 'Модель 2 · машинное обучение', pill: pillHtml, sub, err, note, naive };
    }

    function cardsData() {
        return { c1: hasM1() ? m1Card() : null, c2: hasM2() ? m2Card() : null };
    }

    function verdictText(c1, c2) {
        if (!c1 || !c2) return '';
        if (!c1.err || !c2.err) {
            const wait = !c1.err ? 'модель 1' : 'модель 2';
            return `Сравнение появится, когда ${wait} закончит обучение и проверку.`;
        }
        const wins = KEYS.map(([k, label]) => {
            const a = c1.err[k];
            const b = c2.err[k];
            if (a == null || b == null) return null;
            return { k, label, w: Math.abs(a - b) < 0.05 ? 0 : (a < b ? 1 : 2) };
        }).filter(Boolean);
        if (!wins.length) return 'Сравнить пока не по чему: у моделей нет ошибки на одних и тех же сроках.';
        const lab = (list) => list.map(x => x.label.replace('за ', '')).join(' и ');
        const w1 = wins.filter(x => x.w === 1);
        const w2 = wins.filter(x => x.w === 2);
        let text;
        if (!w1.length && !w2.length) text = 'На всех сроках модели ошибаются почти одинаково.';
        else if (!w2.length) text = w1.length === wins.length ? 'На всех сроках точнее модель 1.' : `Точнее модель 1 (${lab(w1)}), на остальных сроках — одинаково.`;
        else if (!w1.length) text = w2.length === wins.length ? 'На всех сроках точнее модель 2.' : `Точнее модель 2 (${lab(w2)}), на остальных сроках — одинаково.`;
        else {
            // Привычная картина: далеко до вылета точнее одна модель, близко к вылету — другая.
            const idx = (list) => list.map(x => wins.indexOf(x));
            const firstIsOne = wins.find(x => x.w !== 0).w === 1;
            const far = firstIsOne ? w1 : w2;
            const near = firstIsOne ? w2 : w1;
            if (Math.max(...idx(far)) < Math.min(...idx(near))) text = `Далеко до вылета (${lab(far)}) точнее модель ${firstIsOne ? 1 : 2}, ближе к вылету (${lab(near)}) — модель ${firstIsOne ? 2 : 1}.`;
            else text = `Модель 1 точнее ${lab(w1)}, модель 2 — ${lab(w2)}.`;
        }
        return text + ' Рамкой отмечена более точная на каждом сроке. Ошибка — в пассажирах, на вылетах, которых модель при обучении не видела.';
    }

    function cardsHtml() {
        const { c1, c2 } = cardsData();
        const list = [c1, c2].filter(Boolean);
        if (!list.length) return '';
        const best = {};
        if (c1 && c2 && c1.err && c2.err) {
            KEYS.forEach(([k]) => {
                const a = c1.err[k];
                const b = c2.err[k];
                if (a == null || b == null || Math.abs(a - b) < 0.05) return;
                best[k] = a < b ? 1 : 2;
            });
        }
        const card = (c) => {
            const cells = c.err
                ? `<div class="md-hz">${KEYS.map(([k, label]) => {
                    const v = c.err[k];
                    return `<div class="md-hz-i${best[k] === c.n ? ' md-best' : ''}"><i>${label}</i><b>${v == null ? '—' : '±' + r1(v)}</b><i>${v == null ? 'мало данных' : 'пасс.'}</i></div>`;
                }).join('')}</div>`
                : (c.note ? `<p class="md-model-note">${esc(c.note)}</p>` : '');
            return `<section class="rp-card md-model" data-md-model="${c.n}">
                <div class="md-model-head"><h3 class="md-model-title">${esc(c.title)}</h3>${c.pill}</div>
                ${c.sub ? `<div class="md-model-sub">${esc(c.sub)}</div>` : ''}
                ${cells}
            </section>`;
        };
        const verdict = verdictText(c1, c2);
        return `<div class="md-models md-models-${list.length}">${list.map(card).join('')}</div>
            ${verdict ? `<div class="rp-card md-verdict"><b>Вывод:</b> ${esc(verdict)}</div>` : ''}`;
    }

    // ---------- таблица ----------
    function modelCell(r, n) {
        const state = n === 1 ? r.m1state : r.m2state;
        const v = n === 1 ? r.m1 : r.m2;
        const lf = n === 1 ? r.m1lf : r.m2lf;
        if (v != null) return `${v} <span class="md-lf">${lf}%</span>`;
        if (state === 'wait') return '<span class="md-wait">считаю…</span>';
        return '<span class="md-wait">—</span>';
    }

    function signalCell(r) {
        const chips = r.kinds.map(k => `<span class="md-sg ${SIGNAL[k][1]}">${SIGNAL[k][0]}</span>`);
        if (r.diverge) chips.push('<span class="md-sg md-sg-diff">Модели расходятся</span>');
        return chips.length ? chips.join('') : '<span class="md-wait">—</span>';
    }

    function rowHtml(r, cols) {
        const short = shortText(r);
        const cls = r.diff == null ? '' : (r.diff > 0 ? ' md-pos' : (r.diff < 0 ? ' md-neg' : ''));
        const open = view.open.has(r.key);
        let html = `<tr data-md-key="${esc(r.key)}" tabindex="0" class="${open ? 'md-row-open' : ''}" title="Клик — карточка рейса, двойной клик — подробности">
            <td class="md-flight"><b>${esc(r.code)}</b> <span class="md-dir">${esc(r.dir)}</span></td>
            <td class="md-nw">${esc(r.date.slice(0, 5))} · ${r.dtd} дн.</td>
            <td class="md-num">${r.sold} / ${r.seats}</td>
            ${cols.m1 ? `<td class="md-num">${modelCell(r, 1)}</td>` : ''}
            ${cols.m2 ? `<td class="md-num">${modelCell(r, 2)}</td>` : ''}
            ${cols.m1 && cols.m2 ? `<td class="md-num${cls}">${r.diff == null ? '—' : (r.diff === 0 ? '0' : signed(r.diff))}</td>` : ''}
            ${cols.sig ? `<td class="md-nw">${signalCell(r)}</td><td class="md-short" title="${esc(short)}"><div class="md-short-in"><span>${esc(short) || '—'}</span><button type="button" class="md-expand" data-md-expand="${esc(r.key)}" aria-label="Подробности" aria-expanded="${open}">${open ? '▾' : '▸'}</button></div></td>` : ''}
        </tr>`;
        if (open) html += `<tr class="md-detail"><td colspan="${cols.n}"><div class="md-detail-body">${detailHtml(r)}</div></td></tr>`;
        return html;
    }

    function chipsHtml(all) {
        const cnt = (id) => all.filter(MATCH[id]).length;
        const ready = { all: true, alarm: hasM1() && m1Lookup() != null, under: hasM1() && m1Lookup() != null, over: hasM1() && m1Lookup() != null, pace: hasM1() && m1Lookup() != null,
            diff: hasM1() && hasM2() && m1Lookup() != null && MlForecast.status() === 'ready' && !all.some(r => r.m2state === 'wait') };
        return FILTERS.filter(([id]) => id === 'all' || (hasM1() && (id !== 'diff' || hasM2())))
            .map(([id, label]) => `<button type="button" class="md-chip${view.filter === id ? ' md-chip-on' : ''}" data-md-filter="${id}" aria-pressed="${view.filter === id}">${label}${ready[id] ? ` · ${cnt(id)}` : ''}</button>`).join('');
    }

    function listHtml() {
        const all = compose();
        const match = MATCH[view.filter] || MATCH.all;
        const filtered = all.filter(match).sort(SORTS[view.sort] || SORTS.default);
        lastRows = filtered;
        rowByKey = new Map(all.map(r => [r.key, r]));
        const cols = { m1: hasM1(), m2: hasM2(), sig: hasM1() };
        cols.n = 3 + (cols.m1 ? 1 : 0) + (cols.m2 ? 1 : 0) + (cols.m1 && cols.m2 ? 1 : 0) + (cols.sig ? 2 : 0);
        const shown = filtered.slice(0, view.shown);
        const sortMark = (k) => (view.sort === k ? ' md-sorted' : '');
        const head = `<tr><th>Рейс</th>
            <th class="md-sortable${sortMark('date')}" data-md-sort="date" title="Сортировать по дате">Вылет</th>
            <th class="md-num">Продано / мест</th>
            ${cols.m1 ? '<th class="md-num" title="Прогноз итоговой загрузки: расчёт сайта">Модель 1</th>' : ''}
            ${cols.m2 ? '<th class="md-num" title="Прогноз итоговой загрузки: машинное обучение">Модель 2</th>' : ''}
            ${cols.m1 && cols.m2 ? `<th class="md-num md-sortable${sortMark('diff')}" data-md-sort="diff" title="Модель 2 минус модель 1. Плюс — вторая ждёт больше пассажиров. Нажмите — сортировать по размеру разницы.">Разница</th>` : ''}
            ${cols.sig ? `<th class="md-sortable${sortMark('default')}" data-md-sort="default" title="Сначала рейсы с сигналом, затем по дате">Сигнал</th><th>Коротко</th>` : ''}</tr>`;
        const pending = [];
        if (hasM1() && m1Lookup() == null) pending.push('Считаю сигналы по модели 1…');
        if (hasM2() && MlForecast.status() === 'ready' && all.some(r => r.m2state === 'wait')) pending.push('Считаю модель 2…');
        else if (hasM2() && (MlForecast.status() === 'training' || MlForecast.status() === 'unknown')) pending.push('Модель 2 ещё учится');
        const body = shown.map(r => rowHtml(r, cols)).join('');
        const noRows = !all.length ? 'Рейсов на эти дни не найдено — загрузите данные.' : 'Нет рейсов по выбранному фильтру.';
        return `<div class="md-bar">
                <div class="md-chips">${chipsHtml(all)}</div>
                <span class="md-pending" aria-live="polite">${esc(pending.join(' · '))}</span>
                <button type="button" class="btn-primary rp-btn md-xlsx" id="md-xlsx"${filtered.length && typeof ProfileAuth !== 'undefined' && ProfileAuth.hasPermission('export_excel') ? '' : ' disabled'}>В Excel</button>
            </div>
            ${shown.length ? `<div class="rp-scroll md-scroll"><table class="rp-table md-table"><thead>${head}</thead><tbody>${body}</tbody></table></div>
                <div class="md-foot"><span class="md-muted">Показано ${shown.length} из ${filtered.length}</span>${filtered.length > shown.length ? `<button type="button" class="filter-btn" data-md-more="1">Показать ещё ${Math.min(PAGE, filtered.length - shown.length)}</button>` : ''}</div>`
        : `<p class="rp-note">${noRows}</p>`}`;
    }

    function cfgHtml() {
        const c = settings();
        const m1 = hasM1();
        return `<div class="md-cfg">
            ${m1 ? `<label>Недобор ниже <input type="number" id="md-w-under" min="10" max="95" value="${c.under}">%</label>
            <label>Перегруз выше <input type="number" id="md-w-over" min="50" max="100" value="${c.over}">%</label>` : ''}
            <label>На <input type="number" id="md-w-days" min="3" max="30" value="${c.days}"> дн. вперёд</label>
            <button type="button" class="filter-btn" id="md-w-apply">Применить</button>
        </div>`;
    }

    const FLIGHTS_HELP = 'Все вылеты на ближайшие дни в одной таблице. Модель 1 — расчёт сайта, модель 2 — машинное обучение. «Разница» — модель 2 минус модель 1: это не ошибка, обе модели угадывают будущее. Сигналы: недобор, перегруз и необычный темп считает модель 1; «Модели расходятся» — если прогнозы различаются не меньше порога (по умолчанию 5 пасс.). Сначала идут рейсы с сигналом, затем по дате. Клик по строке — карточка рейса, двойной клик — полный текст: почему и что сделать.';

    function flightsHtml() {
        const head = ReportsView.head('Ближайшие рейсы', FLIGHTS_HELP, cfgHtml());
        return `<section class="rp-card md-flights" id="md-flights">${head}<div id="md-list">${listHtml()}</div></section>`;
    }

    function renderList() {
        const box = document.getElementById('md-list');
        if (!box || !alive()) return;
        const sc = box.querySelector('.md-scroll');
        const top = sc ? sc.scrollTop : 0;
        box.innerHTML = listHtml();
        const sc2 = box.querySelector('.md-scroll');
        if (sc2 && top) sc2.scrollTop = top;
    }

    function softRender() {
        if (renderTimer) return;
        renderTimer = setTimeout(() => { renderTimer = 0; renderList(); }, 250);
    }

    function renderCards() {
        const box = document.getElementById('md-cards');
        if (box && alive()) box.innerHTML = cardsHtml();
        renderChart();
    }

    // ---------- график ----------
    function chartData() {
        const { c1, c2 } = cardsData();
        const naive = (c1 && c1.naive) || (c2 && c2.naive) || null;
        const arr = (c, pick) => KEYS.map(([k]) => {
            if (!c) return null;
            const v = pick(c, k);
            return v == null ? null : Math.round(v * 10) / 10;
        });
        return {
            m1: arr(c1, (c, k) => (c.err ? c.err[k] : null)),
            m2: arr(c2, (c, k) => (c.err ? c.err[k] : null)),
            naive: naive ? KEYS.map(([k]) => (naive[k] ? Math.round(naive[k].v * 10) / 10 : null)) : null
        };
    }

    function destroyChart() {
        if (chart) { try { chart.destroy(); } catch (e) { /* ignore */ } chart = null; }
    }

    function renderChart() {
        const canvas = document.getElementById('md-chart');
        const note = document.getElementById('md-chart-note');
        if (!canvas || !alive()) return;
        destroyChart();
        const d = chartData();
        const has = [d.m1, d.m2].some(a => a.some(v => v != null));
        canvas.parentElement.style.display = has ? '' : 'none';
        if (note) note.style.display = has ? 'none' : '';
        if (!has || typeof Chart === 'undefined') return;
        const dark = document.documentElement.getAttribute('data-theme') === 'dark';
        const css = getComputedStyle(document.documentElement);
        const text = (css.getPropertyValue('--text-muted') || '').trim() || (dark ? '#94a3b8' : '#64748b');
        const grid = dark ? 'rgba(148,163,184,.18)' : 'rgba(100,116,139,.18)';
        const modelMax = Math.max(...[...d.m1, ...d.m2].filter(v => v != null));
        const top = Math.max(2, Math.ceil(modelMax * 1.5));
        const sets = [];
        if (hasM1()) sets.push({ label: 'Модель 1', data: d.m1, borderColor: dark ? '#7dd3fc' : '#012A4A', backgroundColor: dark ? '#7dd3fc' : '#012A4A', borderWidth: 2.5, tension: 0.25, pointRadius: 4, spanGaps: true });
        if (hasM2()) sets.push({ label: 'Модель 2', data: d.m2, borderColor: dark ? '#5eead4' : '#0e7490', backgroundColor: dark ? '#5eead4' : '#0e7490', borderWidth: 2.5, borderDash: [6, 4], tension: 0.25, pointRadius: 4, spanGaps: true });
        if (d.naive) sets.push({ label: 'Просто текущие продажи', data: d.naive, borderColor: dark ? '#64748b' : '#cbd5e1', backgroundColor: dark ? '#64748b' : '#cbd5e1', borderWidth: 2, tension: 0.25, pointRadius: 3, spanGaps: true });
        chart = new Chart(canvas, {
            type: 'line',
            data: { labels: KEYS.map(([, l]) => l), datasets: sets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { position: 'top', align: 'end', labels: { color: text, boxWidth: 14, boxHeight: 3, font: { size: 11 } } },
                    tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ±${r1(c.parsed.y)} пасс.` } }
                },
                scales: {
                    y: { min: 0, max: top, ticks: { color: text, font: { size: 11 }, callback: (v) => v }, grid: { color: grid }, title: { display: false } },
                    x: { ticks: { color: text, font: { size: 11 } }, grid: { display: false } }
                }
            }
        });
    }

    function accuracyHtml() {
        return `<section class="rp-card md-acc" id="md-acc">
            <div class="md-acc-head"><h3 class="md-model-title">Точность по срокам</h3><span class="md-muted">ошибка в пассажирах, меньше — лучше</span></div>
            <div class="md-chart-wrap"><canvas id="md-chart" role="img" aria-label="Ошибка моделей в пассажирах по срокам до вылета"></canvas></div>
            <p class="rp-note" id="md-chart-note" style="display:none">График появится, когда модели посчитают ошибку.</p>
            <p class="rp-note">Серая линия — «просто текущие продажи»: что получится, если никто больше не купит билет. Она может уходить выше графика.</p>
        </section>`;
    }

    // ---------- «Подробно для аналитика» ----------
    function analystInner(rerender) {
        let html = '';
        if (typeof ForecastLab !== 'undefined' && hasM1()) html += ForecastLab.html(rerender, { analyst: true });
        else if (typeof PriceAdvisor !== 'undefined' && PriceAdvisor.canView()) html += PriceAdvisor.reportHtml(rerender);
        if (hasM2() && MlForecast.status() === 'ready') {
            html += `<section class="rp-card"><div class="rp-card-head"><div class="rp-card-heading"><h3 class="rp-card-title">Модель 2: ошибка по способам</h3></div>
                <button type="button" class="filter-btn" data-md-own="1" title="Откроется небольшое окно: вписать продано и мест — модель 2 назовёт итог">Посчитать свой рейс</button></div>
                ${MlForecast.qualityHtml()}</section>`;
        }
        return html || '<p class="rp-note">Подробностей пока нет.</p>';
    }

    function fillAnalyst() {
        const box = document.getElementById('md-analyst-body');
        if (!box || !alive()) return;
        box.innerHTML = analystInner(fillAnalyst);
    }

    function analystHtml(rerender) {
        return `<section class="rp-card md-analyst-card"><details class="md-analyst" id="md-analyst"${view.analyst ? ' open' : ''}>
            <summary>Подробно для аналитика: таблица по горизонтам, что влияет на прогноз, по неделям, где ошибается сильнее, что изменилось за неделю, насколько сигналам можно верить, формулы, история продаж</summary>
            <div class="md-analyst-body" id="md-analyst-body">${view.analyst ? analystInner(fillAnalyst) : ''}</div>
        </details></section>`;
    }

    // ---------- вход и расчёты в фоне ----------
    function html(rerender) {
        return `<div class="md-root" id="md-root">
            <div id="md-cards" class="md-cards">${cardsHtml()}</div>
            ${flightsHtml()}
            ${accuracyHtml()}
            ${analystHtml(rerender)}
        </div>`;
    }

    function kickM1() {
        if (!hasM1()) return;
        const go = () => ForecastLab.signalsAllAsync().then(() => { if (alive()) { renderList(); renderCards(); } }).catch(e => console.warn('ModelsView', e));
        ForecastLab.ensureLoaded().then(() => {
            if (!alive()) return;
            ForecastLab.startEvaluation(() => { if (alive()) { renderCards(); go(); } });
            go();
        }).catch(e => console.warn('ModelsView', e));
    }

    function kickM2() {
        if (!hasM2() || !alive()) return;
        if (MlForecast.status() !== 'ready') return;
        const h = MlForecast.health() || {};
        const cfg = settings();
        const sig = [typeof dataEpoch === 'number' ? dataEpoch : 0, today(), cfg.days, h.version || ''].join('|');
        if (m2.sig !== sig) { m2.sig = sig; m2.map = new Map(); m2.running = ''; m2.done = ''; m2.token++; }
        if (m2.running === sig || m2.done === sig) return;
        m2.running = sig;
        const token = ++m2.token;
        const items = universe(cfg.days).filter(u => !m2.map.has(u.key)).map(u => ({ code: u.code, date: u.date }));
        MlForecast.compareFlights(items, (part) => {
            part.forEach(p => m2.map.set(p.date + '|' + p.code, p.r));
            softRender();
        }, () => token !== m2.token || !alive()).then(() => {
            if (token !== m2.token) return;
            m2.running = '';
            if (alive()) { m2.done = sig; renderList(); }
        }).catch(e => { console.warn('ModelsView', e); if (token === m2.token) m2.running = ''; });
    }

    // Модель 2 сменила состояние (учится → готова) или версию — обновить карточки и таблицу.
    if (typeof MlForecast !== 'undefined' && MlForecast.onChange) {
        MlForecast.onChange(() => {
            if (!alive()) return;
            const h = MlForecast.health() || {};
            const stamp = [MlForecast.status(), h.version || '', Math.round((h.progress || 0) * 20)].join('|');
            if (stamp === mlStamp) return;
            mlStamp = stamp;
            renderCards();
            kickM2();
            renderList();
        });
    }

    function mount(root) {
        mounted = true;
        const h = hasM2() ? (MlForecast.health() || {}) : {};
        mlStamp = hasM2() ? [MlForecast.status(), h.version || '', Math.round((h.progress || 0) * 20)].join('|') : '';
        renderChart();
        kickM1();
        kickM2();
        if (hasM2() && MlForecast.refreshHealth) MlForecast.refreshHealth(false).then(() => { if (alive()) { renderCards(); kickM2(); renderList(); } }).catch(() => {});
        // Смена светлой/тёмной темы: перекрасить график.
        if (!themeObs && typeof MutationObserver === 'function') {
            themeObs = new MutationObserver(() => { if (alive()) renderChart(); });
            themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        }
        void root;
    }

    function unmount() {
        mounted = false;
        destroyChart();
        m2.token++;
        m2.running = '';
        clearTimeout(renderTimer);
        renderTimer = 0;
        clearTimeout(clickTimer);
        clickTimer = 0;
        if (themeObs) { themeObs.disconnect(); themeObs = null; }
    }

    // ---------- действия ----------
    function openCard(key) {
        const i = key.indexOf('|');
        const date = key.slice(0, i);
        const code = key.slice(i + 1);
        if (typeof FlightCard === 'undefined' || !FlightCard.maybeOpen) return;
        if (!FlightCard.maybeOpen(code, date)) toast('Карточка рейса скрыта — покажите её кнопкой ▤ у имени в шапке', 'info');
    }

    function toggleDetail(key) {
        if (view.open.has(key)) view.open.delete(key); else view.open.add(key);
        const tr = [...document.querySelectorAll('#md-list tr[data-md-key]')].find(t => t.dataset.mdKey === key);
        const r = rowByKey.get(key);
        if (!tr || !r) { renderList(); return; }
        const open = view.open.has(key);
        const next = tr.nextElementSibling;
        if (next && next.classList.contains('md-detail')) next.remove();
        if (open) {
            const cols = tr.children.length;
            tr.insertAdjacentHTML('afterend', `<tr class="md-detail"><td colspan="${cols}"><div class="md-detail-body">${detailHtml(r)}</div></td></tr>`);
        }
        tr.classList.toggle('md-row-open', open);
        const b = tr.querySelector('.md-expand');
        if (b) { b.textContent = open ? '▾' : '▸'; b.setAttribute('aria-expanded', String(open)); }
    }

    async function exportTable() {
        if (!lastRows.length) { toast('В таблице нет рейсов — выгружать нечего', 'error'); return; }
        const list = lastRows.map(r => {
            const w = r.w;
            return {
                code: r.code, dir: r.dir, date: r.date, dtd: r.dtd, kinds: r.kinds, diverge: r.diverge, sold: r.sold, s: r.seats,
                final: r.m1, lf: r.m1lf, lo: w ? w.lo : null, hi: w ? w.hi : null, hiRaw: w ? w.hiRaw : null, method: w ? w.method : '',
                why: w ? w.why : [], act: w ? w.act : [], urgency: w ? w.urgency : null, m2: r.m2, m2lf: r.m2lf, diff: r.diff
            };
        });
        await ForecastLab.exportWarnings({ list, ml: hasM2() });
        if (typeof ActivityLog !== 'undefined') ActivityLog.log('export', 'Модели: ближайшие рейсы');
    }

    function inRoot(el) { return !!(el && el.closest && el.closest('#md-root')); }

    function handleClick(event, rerender) {
        const t = event.target;
        if (!inRoot(t)) return false;
        const filter = t.closest('[data-md-filter]');
        if (filter) { view.filter = filter.dataset.mdFilter; view.shown = PAGE; renderList(); return true; }
        const sort = t.closest('[data-md-sort]');
        if (sort) { const k = sort.dataset.mdSort; view.sort = view.sort === k && k !== 'default' ? 'default' : k; renderList(); return true; }
        if (t.closest('[data-md-more]')) { view.shown += PAGE; renderList(); return true; }
        const ex = t.closest('[data-md-expand]');
        if (ex) { clearTimeout(clickTimer); toggleDetail(ex.dataset.mdExpand); return true; }
        if (t.closest('[data-md-own]')) { if (typeof MlForecast !== 'undefined') MlForecast.openWindow('own'); return true; }
        if (t.closest('#md-w-apply')) {
            const val = (id) => (document.getElementById(id) || {}).value;
            const cur = settings();
            ForecastLab.applyWarnSettings({ under: val('md-w-under') != null ? val('md-w-under') : cur.under, over: val('md-w-over') != null ? val('md-w-over') : cur.over, days: val('md-w-days') });
            view.shown = PAGE;
            renderList();
            const card = document.getElementById('md-flights');
            const head = card && card.querySelector('.md-cfg');
            if (head) head.outerHTML = cfgHtml();
            kickM1();
            kickM2();
            return true;
        }
        const x = t.closest('#md-xlsx');
        if (x) {
            if (x.disabled) return true;
            x.disabled = true;
            exportTable().catch(e => { console.error(e); toast('Ошибка выгрузки', 'error'); }).finally(() => { x.disabled = false; });
            return true;
        }
        // Клик по строке — карточка рейса (с короткой паузой: двойной клик раскрывает подробности и карточку не открывает).
        const tr = t.closest('tr[data-md-key]');
        if (tr && !t.closest('button, a, input, select')) {
            clearTimeout(clickTimer);
            const key = tr.dataset.mdKey;
            clickTimer = setTimeout(() => { clickTimer = 0; openCard(key); }, 240);
            return true;
        }
        void rerender;
        return false;
    }

    function handleDblClick(event) {
        const tr = event.target.closest && event.target.closest('#md-root tr[data-md-key]');
        if (!tr || event.target.closest('button, a, input, select')) return;
        clearTimeout(clickTimer);
        clickTimer = 0;
        toggleDetail(tr.dataset.mdKey);
    }

    function handleKey(event) {
        if (event.key !== 'Enter') return;
        const tr = event.target.closest && event.target.closest('#md-root tr[data-md-key]');
        if (!tr || event.target !== tr) return;
        event.preventDefault();
        if (event.shiftKey) toggleDetail(tr.dataset.mdKey); else openCard(tr.dataset.mdKey);
    }

    // Блок «Подробно для аналитика» раскрыли — рисуем его только сейчас.
    function handleToggle(target) {
        if (!target || target.id !== 'md-analyst') return;
        if (target.open === view.analyst) return;      // раскрыт при отрисовке страницы — уже заполнен
        view.analyst = target.open;
        if (target.open) fillAnalyst();
    }

    return { canView, html, mount, unmount, handleClick, handleDblClick, handleKey, handleToggle };
})();
