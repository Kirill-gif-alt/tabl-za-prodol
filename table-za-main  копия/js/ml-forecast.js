// Вторая модель прогноза загрузки (машинное обучение) — показ в сайте. Сама модель — ml-model.js: она работает
// прямо в браузере, учится на истории сайта и ничего не требует устанавливать.
//  • прогноз для карточки рейса считается по запросу и кэшируется;
//  • окно «Сравнение моделей»: ближайшие рейсы, модель 1 рядом с моделью 2, качество модели 2, проверка своего рейса.
// Включает админ в «Управлении профилями» → «Функции» («Вторая модель прогноза»).
window.MlForecast = (function () {
    const BASE = '/__krasavia/ml/';
    const HZ = [
        { key: '30d', center: 30, label: 'за 30 дн.' },
        { key: '14d', center: 14, label: 'за 14 дн.' },
        { key: '7d', center: 7, label: 'за 7 дн.' },
        { key: '1_3d', center: 2, label: 'за 1–3 дня' }
    ];
    const TTL = { ready: 30000, offline: 45000, nomodel: 20000, training: 1500, unknown: 0 };
    const RESULT_TTL = 15 * 60 * 1000;
    const BATCH = 150;

    let st = { state: 'unknown', health: null, at: 0, pending: null };
    const cache = new Map();       // ключ -> { s: 'loading' | 'ok' | 'err', res, err, at }
    const listeners = new Set();
    let queue = [];
    let queueTimer = null;

    function esc(v) {
        return typeof escHtml === 'function' ? escHtml(v) : String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function canView() {
        return typeof ProfileAuth !== 'undefined' && typeof ProfileAuth.featureOn === 'function' && ProfileAuth.featureOn('ml_forecast');
    }

    function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
    function notify() { listeners.forEach(fn => { try { fn(); } catch (e) { console.warn('MlForecast listener', e); } }); }

    // ---------- связь с моделью ----------
    // Ответы — того же вида, что у прежней службы: { ok, data } / { ok: false, offline }.
    async function call(path, body) {
        if (typeof MlModel === 'undefined') return { ok: false, offline: true };
        if (path === 'health') { await Promise.resolve(); return { ok: true, data: MlModel.health() }; }
        if (path === 'predict_batch') return { ok: true, data: { results: MlModel.predictMany(body.items) } };
        if (path === 'predict') {
            const r = MlModel.predictMany([body])[0];
            return r.ok ? { ok: true, data: r.result } : { ok: false, data: { detail: r.error } };
        }
        return { ok: false, offline: true };
    }

    // Проверка службы: не чаще раза в 30–45 секунд; параллельные вызовы ждут один ответ.
    function refreshHealth(force) {
        if (st.pending) return st.pending;
        if (!force && st.state !== 'unknown' && Date.now() - st.at < TTL[st.state]) return Promise.resolve(st.state);
        if (typeof MlModel !== 'undefined' && canView()) MlModel.ensure();
        st.pending = call('health').then(r => {
            const prev = st.state;
            if (!r || r.offline || !r.data) st = { state: 'offline', health: null, at: Date.now(), pending: null };
            else {
                const h = r.data;
                const ready = h.model_loaded === true || h.status === 'ok';
                st = { state: ready ? 'ready' : (h.status === 'training' ? 'training' : 'nomodel'), health: h, at: Date.now(), pending: null };
            }
            if (st.state !== prev) {
                if (st.state !== 'ready') cache.forEach((v, k) => { if (v.s === 'loading') cache.delete(k); });
                else cache.clear();       // модель переучилась — прежние ответы устарели
                notify();
            }
            return st.state;
        });
        return st.pending;
    }

    function status() {
        if (st.state === 'unknown' || Date.now() - st.at >= TTL[st.state]) refreshHealth(false);
        return st.state;
    }
    function health() { return st.health; }

    // ---------- вход для прогноза ----------
    function inputOf(code, date) {
        if (typeof getFlightRowForDate !== 'function' || typeof getBaseFlight !== 'function') return null;
        const row = getFlightRowForDate(getBaseFlight(code), date, code);
        if (!row) return null;
        const seats = typeof getSeatsOnSale === 'function' ? getSeatsOnSale(row) : 0;
        const sold = typeof getSoldFromRow === 'function' ? getSoldFromRow(row) : 0;
        const dtd = typeof getDaysUntil === 'function' ? getDaysUntil(date) : null;
        if (!(seats > 0) || dtd == null || dtd < 0 || dtd > 180) return null;
        return { reis: String(code).toUpperCase(), flydate: date, current_booked: Math.max(0, Math.round(sold)), total_au: Math.round(seats), dtd };
    }
    function keyOf(i) { return [i.reis, i.flydate, i.current_booked, i.total_au, i.dtd, st.health && st.health.version || ''].join('|'); }

    function entry(inp) {
        const e = cache.get(keyOf(inp));
        if (e && Date.now() - e.at > RESULT_TTL) { cache.delete(keyOf(inp)); return null; }
        return e || null;
    }

    // Прогноз вылета: { s: 'loading'|'ok'|'err'|'off'|'none', ... }. Сам запрос уходит в фон.
    function forFlight(code, date) {
        if (!canView()) return { s: 'hidden' };
        const state = status();
        if (state === 'offline') return { s: 'off' };
        if (state === 'training') return { s: 'training', progress: st.health && st.health.progress || 0 };
        if (state === 'nomodel') return { s: 'nomodel', detail: st.health && st.health.detail || '' };
        const inp = inputOf(code, date);
        if (!inp) return { s: 'none' };
        if (state === 'unknown') return { s: 'loading', inp };
        const e = entry(inp);
        if (e) return Object.assign({ inp }, e);
        enqueue(inp);
        return { s: 'loading', inp };
    }

    function enqueue(inp) {
        const k = keyOf(inp);
        cache.set(k, { s: 'loading', at: Date.now() });
        queue.push({ k, inp });
        if (!queueTimer) queueTimer = setTimeout(flush, 30);
    }

    async function flush() {
        queueTimer = null;
        const part = queue.splice(0, BATCH);
        if (queue.length) queueTimer = setTimeout(flush, 30);
        if (!part.length) return;
        const r = await call('predict_batch', { items: part.map(p => p.inp) });
        const list = r && r.ok && r.data && r.data.results;
        part.forEach((p, i) => {
            const x = list && list[i];
            if (x && x.ok) cache.set(p.k, { s: 'ok', res: x.result, at: Date.now() });
            else cache.set(p.k, { s: 'err', err: x && x.error ? x.error : (r && r.offline ? 'служба не отвечает' : 'ошибка расчёта'), at: Date.now() });
        });
        if (r && r.offline) refreshHealth(true);
        notify();
    }

    // Запросить сразу много рейсов (окно сравнения); возвращает Promise, когда все ответы в кэше.
    async function ensureMany(inps) {
        const need = inps.filter(i => !entry(i));
        need.forEach(i => cache.set(keyOf(i), { s: 'loading', at: Date.now() }));
        for (let n = 0; n < need.length; n += BATCH) {
            const part = need.slice(n, n + BATCH);
            const r = await call('predict_batch', { items: part });
            const list = r && r.ok && r.data && r.data.results;
            part.forEach((inp, i) => {
                const x = list && list[i];
                cache.set(keyOf(inp), x && x.ok ? { s: 'ok', res: x.result, at: Date.now() }
                    : { s: 'err', err: x && x.error ? x.error : 'ошибка расчёта', at: Date.now() });
            });
        }
    }

    // ---------- разбор ответа ----------
    function nearestKey(dtd) {
        let best = HZ[0];
        HZ.forEach(h => { if (Math.abs(h.center - dtd) < Math.abs(best.center - dtd)) best = h; });
        return best.key;
    }

    // Главное число: прогноз горизонта, ближайшего к сегодняшнему дню до вылета.
    function headline(res, dtd) {
        if (!res || !res.horizons) return null;
        const key = nearestKey(dtd);
        const h = res.horizons[key];
        if (!h) return null;
        return { key, pred: h.pred, conf: h.confidence, ok: !res.critic || res.critic.ok !== false,
            flags: res.critic && res.critic.flags || [], chosen: res.critic && res.critic.chosen_model || '' };
    }

    // Обычная ошибка модели 2 на этом сроке (в пассажирах) — из проверки на вылетах, которых она не видела.
    function mae(key) {
        const m = st.health && st.health.metrics && st.health.metrics[key];
        const v = m && m.ensemble && m.ensemble.mae;
        return typeof v === 'number' ? v : null;
    }

    const FLAG_TEXT = {
        far_from_horizon: 'срок далёк от точки, на которой модель точнее всего, — оценка грубее',
        sparse_route: 'по рейсу мало истории — взяты общие данные по направлению',
        clipped_to_capacity: 'модель дала больше мест, чем есть, — число обрезано до мест',
        clipped_to_booked: 'модель дала меньше, чем уже продано, — поднято до проданного',
        total_au_below_booked: 'мест меньше, чем уже продано, — проверьте данные рейса',
        total_au_zero: 'число мест равно нулю — проверьте данные рейса',
        fallback_model: 'лучшая модель не подошла — взята запасная',
        critic_error: 'сбой при расчёте — показано число проданных',
        service_error: 'сбой при расчёте — показано число проданных'
    };
    function flagTexts(flags) {
        const seen = new Set();
        const out = [];
        (flags || []).forEach(f => {
            const base = String(f).replace(/^[0-9a-z_]+d:/i, '').replace(/^1_3d:/, '');
            const name = base.split(':')[0];
            let txt = FLAG_TEXT[name];
            if (!txt && /^non_finite_model|^negative_model|^bad_input/.test(name)) txt = 'одна из моделей дала неверное число — она пропущена';
            if (txt && !seen.has(txt)) { seen.add(txt); out.push(txt); }
        });
        return out;
    }

    const MODEL_NAME = { hmean: 'по средним (добавка к проданному)', ratio: 'по доле продаж', gbm: 'градиентный бустинг (деревья)', ensemble: 'итог (сочетание трёх)', _baseline_booked: 'просто текущие продажи' };
    function modelName(k) { return MODEL_NAME[k] || k; }

    function pluralRu(n, a, b, c) {
        const m10 = n % 10, m100 = n % 100;
        if (m10 === 1 && m100 !== 11) return a;
        if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return b;
        return c;
    }

    // ---------- плитка для карточки рейса ----------
    // Возвращает { tile, chip }: HTML плитки (рядом с моделью 1) и короткая подпись для свёрнутой строки.
    function cardParts(code, date) {
        const f = forFlight(code, date);
        if (f.s === 'hidden' || f.s === 'none') return { tile: '', chip: '' };
        const tag = '<div class="fc-it-label">Модель 2</div>';
        const open = '<button type="button" class="fc-ml-link" data-fc="ml-window">Сравнение моделей</button>';
        if (f.s === 'off') {
            return { tile: `<div class="fc-it fc-it-muted">${tag}<div class="fc-it-note">Недоступна. ${open}</div></div>`, chip: '' };
        }
        if (f.s === 'training') {
            return { tile: `<div class="fc-it fc-it-muted">${tag}<div class="fc-it-note">Учится на истории продаж: ${Math.round((f.progress || 0) * 100)}%. Это бывает раз в день, пару минут.</div></div>`, chip: '<span class="fc-ins-chip fc-ins-muted">модель 2: учится…</span>' };
        }
        if (f.s === 'nomodel') {
            return { tile: `<div class="fc-it fc-it-muted">${tag}<div class="fc-it-note">Пока нечему учиться${f.detail ? ' (' + esc(f.detail) + ')' : ''}. ${open}</div></div>`, chip: '' };
        }
        if (f.s === 'loading') {
            return { tile: `<div class="fc-it fc-it-muted">${tag}<div class="fc-it-note">считаю…</div></div>`, chip: '<span class="fc-ins-chip fc-ins-muted">модель 2: считаю…</span>' };
        }
        if (f.s === 'err') {
            return { tile: `<div class="fc-it fc-it-muted">${tag}<div class="fc-it-note">Не получилось: ${esc(f.err)}</div></div>`, chip: '' };
        }
        const h = headline(f.res, f.inp.dtd);
        if (!h) return { tile: '', chip: '' };
        const seats = f.inp.total_au;
        const lf = Math.round(h.pred / seats * 100);
        const err = mae(h.key);
        const hz = HZ.find(x => x.key === h.key);
        const all = HZ.map(x => `${x.label}: ${f.res.horizons[x.key] ? f.res.horizons[x.key].pred : '—'}`).join('\n');
        const warn = flagTexts(h.flags);
        const tip = [
            'Вторая модель (машинное обучение): по кривой продаж этого рейса, по прошлым вылетам рейса и направления, дню недели и сезону.',
            `Прогноз с точки «${hz.label}» — она ближе всего к сегодняшнему дню.`,
            err != null ? `На вылетах, которых модель не видела, она ошибалась в среднем на ${String(Math.round(err * 10) / 10).replace('.', ',')} пасс.` : '',
            `Все точки:\n${all}`,
            warn.length ? 'Замечания:\n' + warn.join('\n') : ''
        ].filter(Boolean).join('\n');
        const tone = lf >= 90 ? 'up' : (lf < 60 ? 'down' : 'plain');
        const m1 = typeof FlightInsights !== 'undefined' ? FlightInsights.forecast(code, date) : null;
        let diff = '';
        if (m1 && m1.final != null && m1.source !== 'flown') {
            const d = h.pred - m1.final;
            diff = d === 0 ? ' · как у модели 1' : ` · ${d > 0 ? '+' : '−'}${Math.abs(d)} к модели 1`;
        }
        const tile = `<div class="fc-it fc-it-${tone}" title="${esc(tip)}">${tag}
            <div class="fc-it-value">${h.pred} <span class="fc-it-of">из ${seats}</span></div>
            <div class="fc-it-sub"><strong>${lf}%</strong>${esc(diff)}</div>
            <div class="fc-it-note">${err != null ? `обычно ошибается на ±${esc(String(Math.round(err * 10) / 10).replace('.', ','))} · ` : ''}уверенность ${Math.round(h.conf * 100)}%${warn.length ? ' · есть замечания' : ''}</div>
            <div class="fc-it-note">${open}</div>
        </div>`;
        return { tile, chip: `<span class="fc-ins-chip fc-ins-ml">модель 2: ${h.pred}/${seats} · ${lf}%</span>` };
    }

    // ---------- окно «Сравнение моделей» ----------
    let win = null;
    let wstate = { tab: 'compare', days: 7, minDiff: 0, rows: [], building: 0, sort: 'diff', own: null, ownRes: null };

    function today() { return typeof getTodayDate === 'function' ? getTodayDate() : ''; }

    function upcoming(days) {
        const dates = new Set();
        const t0 = typeof parseLocalDate === 'function' ? parseLocalDate(today()) : null;
        if (!t0) return [];
        for (let i = 0; i <= days; i++) {
            const d = new Date(t0.getFullYear(), t0.getMonth(), t0.getDate() + i);
            dates.add(formatDateRu(d));
        }
        const out = [];
        const seen = new Set();
        Object.keys(typeof groupedData !== 'undefined' && groupedData || {}).forEach(base => {
            (groupedData[base] || []).forEach(r => {
                if (!r || !dates.has(r[1])) return;
                const code = cleanFlight(r[0]);
                const k = code + '|' + r[1];
                if (seen.has(k)) return;
                seen.add(k);
                out.push({ code, date: r[1] });
            });
        });
        return out;
    }

    function dateTs(s) { const d = parseLocalDate(s); return d ? d.getTime() : 0; }

    async function buildCompare() {
        const token = ++wstate.building;
        wstate.rows = [];
        wstate.status = 'считаю…';
        renderWin();
        const list = upcoming(wstate.days).map(x => ({ x, inp: inputOf(x.code, x.date) })).filter(z => z.inp);
        await refreshHealth(true);
        if (token !== wstate.building) return;
        if (st.state !== 'ready') { wstate.status = ''; renderWin(); return; }
        await ensureMany(list.map(z => z.inp));
        if (token !== wstate.building) return;
        // Модель 1 считаем порциями, чтобы окно не подвисало.
        const rows = [];
        for (let i = 0; i < list.length; i += 20) {
            list.slice(i, i + 20).forEach(z => {
                const e = entry(z.inp);
                const m2 = e && e.s === 'ok' ? headline(e.res, z.inp.dtd) : null;
                let m1 = null;
                try { m1 = typeof FlightInsights !== 'undefined' ? FlightInsights.forecast(z.x.code, z.x.date) : null; } catch (err) { m1 = null; }
                const m1v = m1 && m1.final != null ? m1.final : null;
                rows.push({ code: z.x.code, date: z.x.date, ts: dateTs(z.x.date), dir: typeof getFlightDirection === 'function' ? getFlightDirection(z.x.code) : '',
                    sold: z.inp.current_booked, seats: z.inp.total_au, dtd: z.inp.dtd, m1: m1v, m2: m2 ? m2.pred : null,
                    diff: m1v != null && m2 ? m2.pred - m1v : null, err: e && e.s === 'err' ? e.err : '', flags: m2 ? flagTexts(m2.flags) : [] });
            });
            if (token !== wstate.building) return;
            await new Promise(r => setTimeout(r, 0));
        }
        wstate.rows = rows;
        wstate.status = '';
        renderWin();
    }

    function signed(n) { return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n); }

    function statusStrip() {
        const h = st.health || {};
        const map = {
            ready: ['ml-ok', 'Работает'],
            offline: ['ml-bad', 'Не запущена'],
            nomodel: ['ml-warn', 'Мало данных'],
            training: ['ml-warn', 'Учится…'],
            unknown: ['ml-warn', 'Проверяю…']
        };
        const [cls, txt] = map[st.state] || map.unknown;
        const bits = [];
        if (st.state === 'training') bits.push(`обучение: ${Math.round((h.progress || 0) * 100)}%`);
        if (st.state === 'ready') {
            if (h.trained_at) bits.push('обучена ' + String(h.trained_at).slice(0, 10).split('-').reverse().join('.'));
            if (h.n_flights) bits.push(`${Number(h.n_flights).toLocaleString('ru-RU')} ${pluralRu(h.n_flights, 'вылет', 'вылета', 'вылетов')} в истории`);
            if (h.data_period && h.data_period.from) bits.push(`период ${String(h.data_period.from).split('-').reverse().join('.')} — ${String(h.data_period.to).split('-').reverse().join('.')}`);
        }
        return `<div class="mlw-status"><span class="mlw-pill ${cls}">${txt}</span><span class="mlw-status-text">${esc(bits.join(' · '))}</span>
            <button type="button" class="mlw-btn" data-mlw="recheck">Проверить ещё раз</button></div>`;
    }

    function helpHtml() {
        if (st.state === 'ready') return '';
        if (st.state === 'training') {
            return `<div class="mlw-help"><strong>Модель учится на истории продаж.</strong>
                <p>Ничего устанавливать не нужно. Это бывает раз в день и занимает пару минут; работать на сайте можно как обычно.</p></div>`;
        }
        return `<div class="mlw-help"><strong>Модели пока нечему учиться.</strong>
            <p>${esc((st.health && st.health.detail) || '')}</p>
            <p>Ей нужна история улетевших вылетов с продажами по дням (архив продаж). Загрузите данные кнопкой «Загрузить» и откройте окно снова.</p></div>`;
    }

    function compareHtml() {
        if (st.state !== 'ready') return helpHtml();
        const opts = [3, 7, 10, 14, 30].map(d => `<option value="${d}"${d === wstate.days ? ' selected' : ''}>${d} ${pluralRu(d, 'день', 'дня', 'дней')}</option>`).join('');
        const diffOpts = [[0, 'все'], [3, 'от 3 пасс.'], [5, 'от 5 пасс.'], [10, 'от 10 пасс.']].map(([v, l]) => `<option value="${v}"${v === wstate.minDiff ? ' selected' : ''}>${l}</option>`).join('');
        let rows = wstate.rows.slice();
        const withBoth = rows.filter(r => r.diff != null);
        const avgAbs = withBoth.length ? withBoth.reduce((a, r) => a + Math.abs(r.diff), 0) / withBoth.length : 0;
        if (wstate.minDiff) rows = rows.filter(r => r.diff != null && Math.abs(r.diff) >= wstate.minDiff);
        rows.sort(wstate.sort === 'diff'
            ? (a, b) => (Math.abs(b.diff == null ? -1 : b.diff) - Math.abs(a.diff == null ? -1 : a.diff)) || a.ts - b.ts
            : (a, b) => a.ts - b.ts || (parseInt(a.code.slice(3), 10) || 0) - (parseInt(b.code.slice(3), 10) || 0));
        const body = rows.map(r => {
            const cls = r.diff == null ? '' : (r.diff > 0 ? 'mlw-up' : r.diff < 0 ? 'mlw-down' : '');
            const lf = (v) => v != null && r.seats ? ` <span class="mlw-lf">${Math.round(v / r.seats * 100)}%</span>` : '';
            return `<tr data-mlw-open="${esc(r.code)}|${esc(r.date)}" title="${esc(r.flags.join('\n'))}">
                <td>${esc(r.date.slice(0, 5))}</td><td><strong>${esc(r.code)}</strong></td><td class="mlw-dir">${esc(r.dir)}</td>
                <td class="mlw-num">${r.sold} / ${r.seats}</td><td class="mlw-num">${r.dtd}</td>
                <td class="mlw-num">${r.m1 != null ? r.m1 + lf(r.m1) : '—'}</td>
                <td class="mlw-num">${r.m2 != null ? r.m2 + lf(r.m2) : (r.err ? '<span class="mlw-err">' + esc(r.err) + '</span>' : '—')}</td>
                <td class="mlw-num ${cls}">${r.diff == null ? '—' : (r.diff === 0 ? '0' : signed(r.diff))}</td></tr>`;
        }).join('');
        const sum = wstate.status ? wstate.status : (withBoth.length
            ? `Рейсов с двумя прогнозами: ${withBoth.length}. В среднем модели расходятся на ${String(Math.round(avgAbs * 10) / 10).replace('.', ',')} пасс.`
            : (wstate.rows.length ? 'Не по всем рейсам есть оба прогноза.' : 'Рейсов на эти дни не найдено — загрузите данные.'));
        return `<div class="mlw-bar">
                <label>Смотреть вперёд на <select data-mlw="days">${opts}</select></label>
                <label>Показать расхождение <select data-mlw="mindiff">${diffOpts}</select></label>
                <label>Сортировка <select data-mlw="sort"><option value="diff"${wstate.sort === 'diff' ? ' selected' : ''}>где модели расходятся сильнее</option><option value="date"${wstate.sort === 'date' ? ' selected' : ''}>по дате</option></select></label>
            </div>
            <p class="mlw-sum">${esc(sum)}</p>
            <div class="mlw-table-wrap"><table class="mlw-table"><thead><tr>
                <th>Дата</th><th>Рейс</th><th>Направление</th><th class="mlw-num">Продано / мест</th><th class="mlw-num">Дней до вылета</th>
                <th class="mlw-num" title="Прогноз итоговой загрузки (пассажиров) модели 1 — той, что сайт считал раньше">Модель 1</th>
                <th class="mlw-num" title="Прогноз второй модели (машинное обучение)">Модель 2</th>
                <th class="mlw-num" title="Модель 2 минус модель 1. Плюс — вторая ждёт больше пассажиров.">Разница</th></tr></thead>
                <tbody>${body || '<tr><td colspan="8" class="mlw-empty">Нет строк по выбранным условиям.</td></tr>'}</tbody></table></div>
            <p class="mlw-note">Клик по строке — карточка рейса (если она показана кнопкой ▤ у имени). «Разница» — это не ошибка: обе модели угадывают будущее, а настоящий итог станет известен после вылета.</p>`;
    }

    function qualityHtml() {
        if (st.state !== 'ready') return helpHtml();
        const m = (st.health && st.health.metrics) || {};
        const cols = ['_baseline_booked', 'hmean', 'ratio', 'gbm', 'ensemble'];
        const fmt = (v) => v == null ? '—' : String(Math.round(v * 10) / 10).replace('.', ',');
        const rows = HZ.map(h => {
            const r = m[h.key] || {};
            const vals = cols.map(c => r[c] && typeof r[c].mae === 'number' ? r[c].mae : null);
            const best = Math.min(...vals.filter(v => v != null));
            const base = vals[0];
            const tds = cols.map((c, i) => {
                const v = vals[i];
                const bar = v != null && base ? `<span class="mlw-bar-mini"><i style="width:${Math.min(100, Math.round(v / base * 100))}%"></i></span>` : '';
                return `<td class="mlw-num${v != null && v === best ? ' mlw-best' : ''}">${fmt(v)}${bar}</td>`;
            }).join('');
            return `<tr><td>${h.label}</td>${tds}</tr>`;
        }).join('');
        return `<p class="mlw-lead">Ошибка в пассажирах: насколько в среднем прогноз отличался от настоящего итога. Меньше — лучше. Проверка шла на вылетах, которых модель при обучении не видела.</p>
            <div class="mlw-table-wrap"><table class="mlw-table"><thead><tr><th>Срок</th>${cols.map(c => `<th class="mlw-num">${esc(modelName(c))}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>
            <p class="mlw-note">«Итог» — сочетание трёх способов с весами, подобранными на проверке. Модель учится сама на истории продаж сайта и переучивается раз в день. Ошибка модели 1 видна в карточке рейса («обычно ошибается на ±…») — считается по её собственной проверке, поэтому прямое сравнение чисел здесь не делаем.</p>`;
    }

    function ownHtml() {
        if (st.state !== 'ready') return helpHtml();
        const o = wstate.own || { reis: '', date: today(), sold: '', seats: '', dtd: '' };
        let res = '';
        const r = wstate.ownRes;
        if (r && r.error) res = `<p class="mlw-err">${esc(r.error)}</p>`;
        else if (r && r.result) {
            const rows = HZ.map(h => {
                const x = r.result.horizons[h.key];
                return `<tr><td>${h.label}</td><td class="mlw-num">${x.pred}</td><td class="mlw-num">${Math.round(x.confidence * 100)}%</td></tr>`;
            }).join('');
            const warn = flagTexts(r.result.critic.flags);
            res = `<table class="mlw-table mlw-narrow"><thead><tr><th>Точка прогноза</th><th class="mlw-num">Итог, пасс.</th><th class="mlw-num">Уверенность</th></tr></thead><tbody>${rows}</tbody></table>
                ${warn.length ? `<ul class="mlw-warn">${warn.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}`;
        }
        return `<p class="mlw-lead">Любой рейс, даже если его нет в таблицах: впишите, сколько продано и сколько мест, — вторая модель назовёт итог по четырём срокам.</p>
            <div class="mlw-form">
                <label>Рейс<input data-mlw-own="reis" value="${esc(o.reis)}" placeholder="KV-150"></label>
                <label>Дата вылета<input data-mlw-own="date" value="${esc(o.date)}" placeholder="ДД.ММ.ГГГГ"></label>
                <label>Продано<input data-mlw-own="sold" type="number" min="0" value="${esc(o.sold)}"></label>
                <label>Мест на продаже<input data-mlw-own="seats" type="number" min="1" value="${esc(o.seats)}"></label>
                <label>Дней до вылета<input data-mlw-own="dtd" type="number" min="0" max="180" value="${esc(o.dtd)}"></label>
                <button type="button" class="mlw-btn mlw-btn-main" data-mlw="own-go">Посчитать</button>
            </div>${res}`;
    }

    function renderWin() {
        if (!win) return;
        const tabs = [['compare', 'Сравнение рейсов'], ['quality', 'Качество модели 2'], ['own', 'Свой рейс']];
        win.querySelector('.mlw-body').innerHTML = `${statusStrip()}
            <div class="mlw-tabs">${tabs.map(([k, l]) => `<button type="button" class="mlw-tab${wstate.tab === k ? ' on' : ''}" data-mlw-tab="${k}">${l}</button>`).join('')}</div>
            <div class="mlw-pane">${wstate.tab === 'compare' ? compareHtml() : wstate.tab === 'quality' ? qualityHtml() : ownHtml()}</div>`;
    }

    function winClick(e) {
        const t = e.target;
        if (t.closest('[data-mlw="close"]') || t.classList.contains('mlw-backdrop')) return closeWindow();
        const tab = t.closest('[data-mlw-tab]');
        if (tab) { wstate.tab = tab.dataset.mlwTab; renderWin(); if (wstate.tab === 'compare' && !wstate.rows.length && !wstate.building) buildCompare(); return; }
        const act = t.closest('[data-mlw]');
        if (act && act.dataset.mlw === 'recheck') {
            refreshHealth(true).then(() => { renderWin(); if (st.state === 'ready' && wstate.tab === 'compare') buildCompare(); });
            return;
        }
        if (act && act.dataset.mlw === 'own-go') return ownGo();
        const row = t.closest('[data-mlw-open]');
        if (row && typeof FlightCard !== 'undefined') {
            const [code, date] = row.dataset.mlwOpen.split('|');
            if (!FlightCard.maybeOpen(code, date) && typeof showToast === 'function') showToast('Карточка рейса скрыта — покажите её кнопкой ▤ у имени в шапке', 'info');
        }
    }

    function winChange(e) {
        const t = e.target;
        const k = t.dataset && t.dataset.mlw;
        if (k === 'days') { wstate.days = parseInt(t.value, 10) || 7; wstate.rows = []; buildCompare(); }
        else if (k === 'mindiff') { wstate.minDiff = parseInt(t.value, 10) || 0; renderWin(); }
        else if (k === 'sort') { wstate.sort = t.value; renderWin(); }
        else if (t.dataset && t.dataset.mlwOwn) { wstate.own = Object.assign(wstate.own || {}, { [t.dataset.mlwOwn]: t.value }); }
    }

    async function ownGo() {
        const o = Object.assign({ reis: '', date: today(), sold: '', seats: '', dtd: '' }, wstate.own || {});
        const dt = parseLocalDate(o.date);
        let dtd = o.dtd === '' ? null : parseInt(o.dtd, 10);
        if (dtd == null && dt && typeof getDaysUntil === 'function') dtd = getDaysUntil(o.date);
        const fail = (m) => { wstate.ownRes = { error: m }; renderWin(); };
        if (!/^[A-Za-z]{2}-?\d{1,5}$/.test(o.reis.trim())) return fail('Впишите номер рейса, например KV-150.');
        if (!dt) return fail('Дата — в виде ДД.ММ.ГГГГ.');
        if (!(parseInt(o.seats, 10) > 0)) return fail('Впишите число мест на продаже.');
        if (!(parseInt(o.sold, 10) >= 0)) return fail('Впишите, сколько уже продано.');
        if (dtd == null || !(dtd >= 0 && dtd <= 180)) return fail('Дней до вылета — от 0 до 180.');
        const reis = o.reis.trim().toUpperCase().replace(/^([A-Z]{2})(\d)/, '$1-$2');
        wstate.ownRes = { result: null, error: '' };
        const r = await call('predict', { reis, flydate: o.date, current_booked: parseInt(o.sold, 10), total_au: parseInt(o.seats, 10), dtd });
        if (!r || r.offline) return fail('Служба не отвечает.');
        if (!r.ok) return fail(r.data && r.data.detail ? String(r.data.detail) : 'Не удалось посчитать.');
        wstate.ownRes = { result: r.data };
        renderWin();
    }

    function onKey(e) { if (e.key === 'Escape' && win) closeWindow(); }

    function openWindow(tab) {
        if (!canView()) return false;
        if (!win) {
            win = document.createElement('div');
            win.id = 'ml-window';
            win.className = 'mlw';
            win.setAttribute('role', 'dialog');
            win.setAttribute('aria-modal', 'true');
            win.setAttribute('aria-label', 'Сравнение моделей прогноза');
            win.innerHTML = `<div class="mlw-backdrop"></div>
                <div class="mlw-panel">
                    <div class="mlw-head"><div><h3>Сравнение моделей прогноза</h3>
                        <p>Модель 1 — расчёт сайта по прошлым вылетам. Модель 2 — машинное обучение.</p></div>
                        <button type="button" class="mlw-close" data-mlw="close" aria-label="Закрыть">✕</button></div>
                    <div class="mlw-body"></div>
                </div>`;
            document.body.appendChild(win);
            win.addEventListener('click', winClick);
            win.addEventListener('change', winChange);
            document.addEventListener('keydown', onKey);
        }
        win.classList.add('open');
        if (tab) wstate.tab = tab;
        renderWin();
        refreshHealth(true).then(() => {
            renderWin();
            if (st.state === 'ready' && wstate.tab === 'compare' && !wstate.rows.length) buildCompare();
        });
        return true;
    }

    function closeWindow() {
        if (win) win.classList.remove('open');
        wstate.building++;      // отменяет незаконченный расчёт
    }

    // Новая загрузка данных: расчёты устарели.
    function reset() { cache.clear(); wstate.rows = []; }

    // Ход обучения: обновляем состояние не чаще раза в 400 мс.
    let modelTimer = 0;
    if (typeof MlModel !== 'undefined') {
        MlModel.onChange(() => {
            if (modelTimer) return;
            modelTimer = setTimeout(() => { modelTimer = 0; st.at = 0; st.pending = null; refreshHealth(true).then(() => { if (win && win.classList.contains('open')) renderWin(); notify(); }); }, 400);
        });
    }

    document.addEventListener('click', e => {
        const b = e.target.closest && e.target.closest('#ml-window-btn');
        if (b) openWindow('compare');
    });

    return { canView, status, health, forFlight, cardParts, headline, openWindow, closeWindow, onChange, refreshHealth, reset, flagTexts };
})();
