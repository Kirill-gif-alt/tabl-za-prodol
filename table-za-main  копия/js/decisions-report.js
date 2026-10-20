// «Отчёты» → «Решения»: журнал ценовых решений и их итог в рублях (единственное место на сайте, где показаны деньги по решениям).
// Эффект = выручка в окне после решения минус ожидаемое число билетов × прежняя цена; делится на объём и цену.
// «Сработало» только при интервале без нуля и эффекте выше порога, иначе «неопределённо» (расчёт — js/decision-money.js).
// Билеты до/после и норма — те же, что в карточке рейса (price-marks.js).
window.DecisionsReport = (function () {
    const PERIODS = [30, 60, 90];
    const KIND = { down: '▼ Снижение', up: '▲ Повышение', attn: '! Внимание' };
    let period = 60;
    let kindFilter = '';
    let memo = { sig: '', rows: null };
    const VIEW_KEY = 'krasavia_decisions_view';
    let view = 'tickets';
    try { view = localStorage.getItem(VIEW_KEY) === 'money' ? 'money' : 'tickets'; } catch (e) { /* ignore */ }
    let money = { sig: '', map: null, loading: false, done: 0 };

    function esc(v) {
        return typeof escHtml === 'function' ? escHtml(v) : String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function canView() {
        if (typeof ProfileAuth === 'undefined') return true;
        return ProfileAuth.canAccessTab('sales') || !!(ProfileAuth.getCurrentProfile() && ProfileAuth.getCurrentProfile().isAdmin);
    }

    function available() {
        return typeof SalesManagement !== 'undefined' && SalesManagement.allMarks && typeof PriceMarks !== 'undefined' && PriceMarks.effectFor;
    }

    function moneyWindow() { return typeof PV !== 'undefined' && typeof PV.DECISION_WINDOW_MONEY === 'number' ? PV.DECISION_WINDOW_MONEY : 4; }

    function wd() { return typeof PriceMarks !== 'undefined' && PriceMarks.winDays ? PriceMarks.winDays() : '3 дня'; }

    function sig() {
        return [typeof dataEpoch === 'number' ? dataEpoch : 0, typeof getTodayDate === 'function' ? getTodayDate() : '',
            SalesManagement.markRevision ? SalesManagement.markRevision() : '',
            typeof SalesArchive !== 'undefined' && SalesArchive.revision ? SalesArchive.revision() : 0, period,
            typeof Params !== 'undefined' ? Params.revision() : 0].join('|');
    }

    function daysAgo(dateStr) {
        const d = parseLocalDate(dateStr);
        if (!d) return null;
        const t = new Date();
        t.setHours(0, 0, 0, 0);
        return Math.round((t - d) / 86400000);
    }


    // ---------- деньги (только здесь, нигде больше на сайте) ----------

    function moneyAvailable() { return typeof DecisionMoney !== 'undefined'; }

    function ensureMoney(rerender) {
        if (!moneyAvailable()) return;
        const list = rows();
        const s = sig() + '|' + (DecisionMoney.revision ? DecisionMoney.revision() : 0);
        if (money.sig === s || money.loading) return;
        money.loading = true;
        money.done = 0;
        DecisionMoney.resolveAll(list, (d) => { money.done = d; })
            .then(map => { money = { sig: s, map, loading: false, done: list.length }; })
            .catch(err => { console.warn('DecisionsReport money', err); money = { sig: s, map: new Map(), loading: false, done: 0 }; })
            .then(() => { if (typeof rerender === 'function') rerender(); });
    }

    function moneyOf(r) {
        return money.map ? (money.map.get(DecisionMoney.keyOf(r)) || null) : null;
    }

    function rub(n) {
        if (n == null || n === '') return '—';
        const v = Math.round(n);
        return (v > 0 ? '+' : (v < 0 ? '−' : '')) + Math.abs(v).toLocaleString('ru-RU') + ' ₽';
    }

    function rubPlain(n) { return n == null ? '—' : Math.round(n).toLocaleString('ru-RU') + ' ₽'; }

    // Состояние денежной оценки одного решения для экрана и Excel.
    function moneyState(r) {
        const m = moneyOf(r);
        if (!m) return { cls: 'wait', text: money.loading ? 'считаем…' : '—', short: '', m: null };
        if (m.stage === 'na') return { cls: 'none', text: 'не оценивается', short: 'не оценивается', reason: m.reason, m };
        if (m.stage === 'wait') return { cls: 'wait', text: 'ждём данные', short: 'ждём данные', reason: m.reason, m };
        if (m.stage === 'prelim') return { cls: 'wait', text: 'предв.: ' + rub(m.delta), short: 'предварительно', reason: m.reason, m };
        if (m.verdict === 'worked') return { cls: 'pos', text: 'сработало', short: 'сработало', m };
        if (m.verdict === 'failed') return { cls: 'neg', text: 'не сработало', short: 'не сработало', m };
        return { cls: 'none', text: 'неопределённо', short: 'неопределённо', reason: m.reason || 'интервал включает ноль или эффект ниже порога', m };
    }

    // Итоги пулом: суммы только по решениям с определённым итогом; неопределённые — отдельно.
    function moneyTotals(list) {
        const t = { n: list.length, finalN: 0, worked: 0, failed: 0, unclear: 0, na: 0, wait: 0, sum: 0, lo: 0, hi: 0, definite: 0, sumAll: 0 };
        list.forEach(r => {
            const st = moneyState(r);
            const m = st.m;
            if (!m || m.stage === 'wait' || m.stage === 'prelim') { t.wait++; return; }
            if (m.stage === 'na') { t.na++; return; }
            t.finalN++;
            t.sumAll += m.delta || 0;
            if (m.verdict === 'worked') { t.worked++; t.definite++; t.sum += m.delta; }
            else if (m.verdict === 'failed') { t.failed++; t.definite++; t.sum += m.delta; }
            else t.unclear++;
            t.lo += m.lo || 0;
            t.hi += m.hi || 0;
        });
        return t;
    }

    // Строки журнала (решения «снижение/повышение» за период), с итогом.
    function rows() {
        const s = sig();
        if (memo.sig === s && memo.rows) return memo.rows;
        const out = [];
        // Одно решение, отмеченное двумя людьми, — одна строка (иначе его билеты и рубли посчитаются дважды).
        const seen = new Map();
        SalesManagement.allMarks().forEach(m => {
            if (m.status !== 'down' && m.status !== 'up') return;
            const dk = [m.flight, m.dep, m.check, m.status].join('|');
            if (seen.has(dk)) {
                const r0 = seen.get(dk);
                if (!r0.clsFrom && m.clsFrom) r0.clsFrom = m.clsFrom;
                if (!r0.clsTo && m.clsTo) r0.clsTo = m.clsTo;
                if (m.author && !r0.author.split(' / ').includes(m.author)) r0.author = r0.author ? r0.author + ' / ' + m.author : m.author;
                return;
            }
            const ago = daysAgo(m.check);
            if (ago == null || ago < 0 || ago > period) return;
            const code = m.flight;
            const base = typeof getBaseFlight === 'function' ? getBaseFlight(code) : code;
            let e = null;
            try { e = PriceMarks.effectFor(base, code, m.dep, { check: m.check, status: m.status }); } catch (err) { e = null; }
            out.push({
                code, base, dep: m.dep, check: m.check, status: m.status, author: m.author || '',
                clsFrom: m.clsFrom || '', clsTo: m.clsTo || '',
                direction: typeof getFlightDirection === 'function' ? getFlightDirection(code) : '',
                e,
                done: !!(e && e.complete && e.effect != null)
            });
            seen.set(dk, out[out.length - 1]);
        });
        out.sort((a, b) => (parseLocalDate(b.check) - parseLocalDate(a.check)) || String(a.code).localeCompare(String(b.code), 'ru', { numeric: true }));
        memo = { sig: s, rows: out };
        return out;
    }

    function signed(n) {
        if (n == null) return '—';
        return (n > 0 ? '+' : (n < 0 ? '−' : '')) + String(Math.abs(n)).replace('.', ',');
    }

    // «Сработало» — по билетам против нормы (PriceMarks.judge); «рано судить» в долю не входит.
    function worked(r) {
        return verdictOf(r).worked;
    }

    // Сводка: решений, с итогом, «сработало», средний итог в билетах.
    function summarize(list) {
        const done = list.filter(r => r.done);
        const judged = done.filter(r => worked(r) != null);
        const good = judged.filter(r => worked(r) === true).length;
        const avg = done.length ? done.reduce((a, r) => a + r.e.effect, 0) / done.length : null;
        const waiting = list.filter(r => !(r.e && r.e.complete)).length;
        const mt = moneyTotals(list);
        return { money: mt, n: list.length, done: done.length, waiting, noNorm: list.length - done.length - waiting, judged: judged.length, good, share: judged.length ? Math.round(good / judged.length * 100) : null, avg: avg == null ? null : Math.round(avg * 10) / 10 };
    }

    function groupBy(list, keyFn) {
        const map = new Map();
        list.forEach(r => {
            const k = keyFn(r);
            if (!map.has(k)) map.set(k, []);
            map.get(k).push(r);
        });
        return [...map.entries()].map(([k, l]) => ({ key: k, ...summarize(l) })).sort((a, b) => b.n - a.n);
    }

    // Итог одной строки: вердикт для экрана и для Excel.
    function verdictOf(r) {
        return PriceMarks.judge(r.e, r.status);
    }

    function shareBar(share) {
        if (share == null) return '<span class="rp-muted">—</span>';
        return `<span class="dr-bar" title="Сработало ${share}%"><span class="dr-bar-fill ${share >= 50 ? 'dr-bar-pos' : 'dr-bar-neg'}" style="width:${Math.max(0, Math.min(100, share))}%"></span></span><span class="${share >= 50 ? 'dr-pos' : 'dr-neg'}">${share}%</span>`;
    }

    function summaryTable(title, groups, keyLabel) {
        if (!groups.length) return '';
        const rowsHtml = groups.slice(0, 10).map(g => `
            <tr>
                <td class="rp-left"><strong>${esc(g.key)}</strong></td>
                <td>${g.n}</td>
                <td>${g.money.definite}${g.money.definite ? ` <span class="dr-usual">${g.money.worked} / ${g.money.failed}</span>` : ''}</td>
                <td class="rp-nowrap">${g.money.definite ? `<span class="${g.money.sum >= 0 ? 'dr-pos' : 'dr-neg'}">${rub(g.money.sum)}</span>` : '—'}</td>
                <td>${g.money.unclear + g.money.na + g.money.wait}</td>
            </tr>`).join('');
        return `<div class="dr-sum">
            <div class="dr-sum-title">${esc(title)}</div>
            <table class="rp-table dr-sum-table"><thead><tr><th>${esc(keyLabel)}</th><th>Решений</th><th title="Решения с определённым итогом (интервал не включает ноль и эффект выше порога)">Определено</th><th title="Сумма эффекта только по решениям с определённым итогом">Эффект</th><th title="Решения, по которым итог неопределённый, в сумму не входят">Неопред.</th></tr></thead><tbody>${rowsHtml}</tbody></table>
            ${groups.length > 10 ? `<div class="rp-muted">и ещё ${groups.length - 10} — полный список в Excel</div>` : ''}
        </div>`;
    }

    function kpi(label, value, sub, cls) {
        return `<div class="dr-kpi${cls ? ' ' + cls : ''}"><div class="dr-kpi-label">${esc(label)}</div><div class="dr-kpi-value">${value}</div>${sub ? `<div class="dr-kpi-sub">${sub}</div>` : ''}</div>`;
    }

    function canExport() {
        return typeof ProfileAuth === 'undefined' || ProfileAuth.hasPermission('export_excel');
    }

    function filtered() {
        const all = rows();
        return kindFilter ? all.filter(r => r.status === kindFilter) : all;
    }

    function moneyHtml(rerender) {
        if (!available()) return '<p class="rp-note">Журнал решений недоступен.</p>';
        ensureMoney(rerender);
        const list = filtered();
        const total = summarize(list);
        const down = summarize(list.filter(r => r.status === 'down'));
        const up = summarize(list.filter(r => r.status === 'up'));
        const seg = (attr, val, cur, text) => `<button type="button" class="filter-btn${String(val) === String(cur) ? ' filter-btn-active' : ''}" data-${attr}="${val}">${text}</button>`;
        const toolbar = `
            <div class="dr-toolbar">
                <div class="dr-seg"><span class="dr-seg-label">Период</span>${PERIODS.map(p => seg('dr-period', p, period, p + ' дн.')).join('')}</div>
                <div class="dr-seg"><span class="dr-seg-label">Решения</span>${seg('dr-kind', '', kindFilter, 'все')}${seg('dr-kind', 'down', kindFilter, '▼ снижение')}${seg('dr-kind', 'up', kindFilter, '▲ повышение')}</div>
            </div>`;
        const mt = total.money;
        const sumCls = mt.sum > 0 ? 'dr-pos' : (mt.sum < 0 ? 'dr-neg' : '');
        const kpis = `<div class="dr-kpis">
            ${kpi('Решений', String(total.n), [`оценено ${mt.finalN}`, mt.wait ? `ждут данных: ${mt.wait}` : '', mt.na ? `не оценивается: ${mt.na}` : ''].filter(Boolean).join(' · '))}
            ${kpi('Определённый итог', mt.definite ? String(mt.definite) : '—', mt.definite ? `сработало ${mt.worked} · не сработало ${mt.failed}` : (money.loading ? 'считаем…' : 'пока нет'))}
            ${kpi('Эффект по определённым', mt.definite ? `<span class="${sumCls}">${rub(mt.sum)}</span>` : '—', mt.finalN ? `по всем оценённым ${rub(mt.sumAll)} (диапазон ${rub(mt.lo)} … ${rub(mt.hi)})` : '')}
            ${kpi('Неопределённо', String(mt.unclear), 'интервал включает ноль или эффект ниже порога; в сумму не входят')}
            ${!kindFilter ? kpi('▼ Снижения', String(down.n), down.money.definite ? `${rub(down.money.sum)} по определённым` : '', 'dr-kpi-down') : ''}
            ${!kindFilter ? kpi('▲ Повышения', String(up.n), up.money.definite ? `${rub(up.money.sum)} по определённым` : '', 'dr-kpi-up') : ''}
        </div>`;
        const body = list.map(r => {
            const e = r.e;
            const st = moneyState(r);
            const m = st.m;
            const usual = (x) => (x ? `<span class="dr-usual">обычно ${x.value}</span>` : '');
            const fare = e && e.before.avg != null && e.after.avg != null
                ? `${Math.round(e.before.avg).toLocaleString('ru-RU')} → ${Math.round(e.after.avg).toLocaleString('ru-RU')} ₽` : '—';
            const cls = m && (m.clsBefore || m.clsAfter) ? `${esc(m.clsBefore || '?')} → ${esc(m.clsAfter || '?')}` : (r.clsFrom || r.clsTo ? `${esc(r.clsFrom || '?')} → ${esc(r.clsTo || '?')}` : '—');
            const hasNum = m && (m.stage === 'final' || m.stage === 'prelim') && m.delta != null;
            const effect = hasNum ? `<strong class="${m.delta >= 0 ? 'dr-pos' : 'dr-neg'}">${rub(m.delta)}</strong><div class="dr-usual">${rub(m.lo)} … ${rub(m.hi)}</div>` : '—';
            const split = hasNum ? `<span class="dr-usual">объём ${rub(m.volume)}</span><span class="dr-usual">цена ${rub(m.priceEffect)}</span>` : '';
            const tix = m && m.expAll != null ? `<strong>${m.factAll}</strong><span class="dr-usual">ожидали ${String(m.expAll).replace('.', ',')}</span>` : '—';
            const reliab = m && m.grade && (m.stage === 'final' || m.stage === 'prelim') ? `<span class="dr-usual">надёжность ${m.grade}${m.frozen ? '' : ' · не зафиксировано'}</span>` : '';
            const tail = m && m.tailExp != null ? `<span class="dr-usual">после окна ${m.tailFact} (обычно ${String(m.tailExp).replace('.', ',')})${m.fullFlight ? ', рейс заполнен' : ''}</span>` : '';
            return `
                <tr>
                    <td class="rp-nowrap"><strong>${esc(r.check.slice(0, 5))}</strong><div class="dr-usual">${esc(r.author || '—')}</div></td>
                    <td class="rp-left"><button type="button" class="filter-btn rp-open" data-open-base="${esc(r.base)}" data-open-code="${esc(r.code)}" data-open-date="${esc(r.dep)}" title="Открыть вылет">${esc(r.code)}</button><div class="dr-usual">${esc(r.direction)}</div></td>
                    <td class="rp-nowrap">${esc(r.dep.slice(0, 5))}</td>
                    <td><span class="dr-kind dr-kind-${esc(r.status)}">${esc(KIND[r.status] || r.status)}</span></td>
                    <td class="rp-nowrap">${cls}</td>
                    <td>${tix}</td>
                    <td class="rp-nowrap">${fare}</td>
                    <td class="rp-nowrap">${effect}</td>
                    <td>${split}</td>
                    <td class="rp-left"><span class="dr-verdict dr-verdict-${st.cls}">${esc(st.text)}</span>${st.reason ? `<span class="dr-usual" style="white-space:normal">${esc(st.reason)}</span>` : ''}${reliab}${tail}</td>
                </tr>`;
        }).join('');
        const sts = list.map(moneyState);
        const cnt = (f) => sts.filter(f).length;
        const byDir = groupBy(list, r => r.direction || r.code).filter(g => g.money.definite).slice(0, 8);
        const weeks = new Map();
        list.forEach((r, i) => {
            const m = sts[i].m;
            if (!m || m.stage !== 'final' || (m.verdict !== 'worked' && m.verdict !== 'failed')) return;
            const d = parseLocalDate(r.check);
            if (!d) return;
            d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
            const k = d.getTime();
            weeks.set(k, (weeks.get(k) || 0) + m.delta);
        });
        const weekItems = [...weeks.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => {
            const d = new Date(k);
            return { label: String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0'), value: v, text: rub(v) };
        });
        const dash = list.length ? `<div class="dv-grid">
            ${DecisionsViz.stack('Итог решений', [
                { label: 'Сработало', value: cnt(x => x.cls === 'pos'), cls: 'dv-pos' },
                { label: 'Не сработало', value: cnt(x => x.cls === 'neg'), cls: 'dv-neg' },
                { label: 'Неопределённо', value: cnt(x => x.text === 'неопределённо'), cls: 'dv-unk' },
                { label: 'Ждём данные', value: cnt(x => x.cls === 'wait'), cls: 'dv-wait' },
                { label: 'Не оценивается', value: cnt(x => x.text === 'не оценивается'), cls: 'dv-na' }])}
            ${DecisionsViz.bars('Эффект по направлениям (определённые решения)', byDir.map(g => ({ label: g.key, value: g.money.sum, text: rub(g.money.sum), sub: `решений ${g.money.definite}` })), 'Рубли за окно после решения против ожидаемого по прежней цене')}
            ${DecisionsViz.columns('Эффект по неделям решений', weekItems, 'Неделя начинается с даты внизу; только определённые решения')}
        </div>` : '';
        const sums = list.length ? `<div class="dr-sums">
            ${summaryTable('По направлениям', groupBy(list, r => r.direction || r.code), 'Направление')}
            ${summaryTable('По типу решения', groupBy(list, r => KIND[r.status] || r.status), 'Решение')}
        </div>` : '';
        return `
            <section class="rp-card dr-card">
                <div class="rp-card-head">
                    <h3 class="rp-card-title">Журнал решений</h3>
                    ${canExport() ? `${moneyAvailable() && DecisionMoney.canFreeze() && list.length ? '<button type="button" class="filter-btn" data-dr-recompute="1" title="Пересчитать зафиксированные итоги с текущими параметрами">Пересчитать</button>' : ''}<button type="button" class="btn-primary rp-btn" id="dr-export"${list.length ? '' : ' disabled'}>В Excel</button>` : ''}
                </div>
                <details class="dr-help"><summary>Как считается</summary>
                    <p><strong>Эффект в рублях</strong> = выручка по взрослым платным билетам в окне после решения минус то, что продали бы по прежней цене: ожидаемое число билетов (норма аналогичных вылетов того же рейса и дня недели) × цена прежнего класса. Он делится на <em>объём</em> (больше или меньше билетов, чем ожидали) и <em>цену</em> (другой тариф). Сумма двух частей равна эффекту.</p>
                    <p><strong>Окно</strong>: ${moneyWindow()} дн. после решения (день решения не считается), при малых продажах до 10 дней. Итог фиксируется на следующий день после окна и потом не меняется.</p>
                    <p><strong>«Сработало» / «не сработало»</strong> — только если интервал (≈90%) не включает ноль и эффект не меньше большего из 15% ожидаемой выручки и 20 000 ₽. Иначе — «неопределённо»: по одному вылету это частый и честный ответ. Суммы считаются только по определённым решениям, неопределённые показаны отдельно.</p>
                    <p><strong>«Не оценивается»</strong>: доп. рейсы и чартеры, решение за менее чем 3 дня до вылета, серия решений по вылету, праздники и события, нет продаж до решения, цена не менялась, мало аналогов. Надёжность A / B — по числу аналогов и ожидаемых билетов.</p>
                    <p><strong>▲ Повышение</strong>: через окно — только предварительный сигнал; итог после вылета по остатку продаж, с учётом свободных мест. Если рейс заполнился, учитывается только эффект цены.</p>
                    <p>Выручка в рублях — по ценам билетов без допов и без групп. Это оценка относительно нормы, а не доказанная причина: на неё влияют погода, конкуренты и события, которых в данных нет. Проверка на вылетах без решений показала, что «сработало» метод иногда выдаёт и там (естественный рост цены ближе к вылету), поэтому читайте итог как ориентир, а не как факт.</p>
                </details>
                ${toolbar}
                ${kpis}
                ${dash}
                ${sums}
                ${body ? `<div class="dr-list-title">Все решения <span class="rp-muted">· ${list.length}</span></div><div class="rp-scroll"><table class="rp-table dr-table">
                    <thead><tr><th>Решение</th><th>Рейс</th><th>Вылет</th><th>Что</th><th title="Класс до → после (из отметки или по продажам)">Класс</th><th title="Билетов в окне после решения / сколько ожидали">Билетов</th><th>Ср. тариф до → после</th><th title="Выручка в окне минус ожидаемая по прежней цене; в строке — диапазон ≈90%">Эффект</th><th>Объём / цена</th><th>Итог</th></tr></thead>
                    <tbody>${body}</tbody></table></div>` : '<p class="rp-note">За период решений «снижение/повышение» нет.</p>'}
            </section>`;
    }

    // Данные для выгрузки в Excel (reports-view.js → exportDecisions).
    function moneyExport() {
        const list = filtered();
        const g = (fn) => groupBy(list, fn);
        return {
            period,
            kind: kindFilter ? KIND[kindFilter] : 'все',
            total: summarize(list),
            byKind: g(r => KIND[r.status] || r.status),
            byDir: g(r => r.direction || r.code),
            byAuthor: g(r => r.author || '—'),
            rows: list.map(r => {
                const e = r.e;
                const st = moneyState(r);
                const m = st.m;
                const fin = m && (m.stage === 'final' || m.stage === 'prelim') && m.delta != null;
                return {
                    check: r.check, author: r.author, code: r.code, direction: r.direction, dep: r.dep,
                    kind: KIND[r.status] || r.status,
                    before: e ? e.before.n : '', normBefore: e && e.normBefore ? e.normBefore.value : '',
                    after: e ? e.after.n : '', normAfter: e && e.normAfter ? e.normAfter.value : '',
                    fareBefore: e && e.before.avg != null ? Math.round(e.before.avg) : '',
                    fareAfter: e && e.after.avg != null ? Math.round(e.after.avg) : '',
                    effect: fin ? m.delta : '', lo: fin ? m.lo : '', hi: fin ? m.hi : '', volume: fin ? m.volume : '', priceEffect: fin ? m.priceEffect : '',
                    grade: fin ? m.grade : '', clsBefore: m ? (m.clsBefore || '') : '', clsAfter: m ? (m.clsAfter || '') : '',
                    expAll: m && m.expAll != null ? m.expAll : '', factAll: m && m.factAll != null ? m.factAll : '', analogs: m && m.k != null ? m.k : '',
                    method: m && m.v != null ? m.v : '', verdict: st.short, text: st.text + (st.reason ? ': ' + st.reason : '')
                };
            })
        };
    }

    function moneyClick(btn, rerender) {
        if (btn.dataset.drRecompute) {
            if (!moneyAvailable() || money.loading) return true;
            const list = rows().filter(r => { const m = moneyOf(r); return m && m.stage !== 'na'; });
            money.loading = true;
            btn.disabled = true;
            (async () => { for (const r of list) { try { await DecisionMoney.recompute(r); } catch (err) { console.warn(err); } } })()
                .then(() => { money = { sig: '', map: null, loading: false, done: 0 }; rerender(); });
            return true;
        }
        if (btn.dataset.drPeriod != null) { period = parseInt(btn.dataset.drPeriod, 10) || 60; rerender(); return true; }
        if (btn.dataset.drKind != null) { kindFilter = btn.dataset.drKind || ''; rerender(); return true; }
        return false;
    }

    function setView(v) {
        view = v === 'money' ? 'money' : 'tickets';
        try { localStorage.setItem(VIEW_KEY, view); } catch (e) { /* ignore */ }
    }

    function html(rerender) {
        const sw = `<div class="dr-viewseg" role="tablist"><button type="button" role="tab" class="${view === 'tickets' ? 'on' : ''}" data-dr-view="tickets">По билетам</button><button type="button" role="tab" class="${view === 'money' ? 'on' : ''}" data-dr-view="money">В рублях</button></div>`;
        return sw + (view === 'money' ? moneyHtml(rerender) : DecisionsTickets.html());
    }

    function handleClick(btn, rerender) {
        if (btn.dataset.drView) { setView(btn.dataset.drView); rerender(); return true; }
        return view === 'money' ? moneyClick(btn, rerender) : DecisionsTickets.handleClick(btn, rerender);
    }

    return { canView, html, handleClick, view: () => view, exportData: () => (view === 'money' ? moneyExport() : DecisionsTickets.exportData()), summarize };
})();
