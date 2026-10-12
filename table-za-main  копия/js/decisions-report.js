// «Отчёты» → «Решения»: журнал ценовых решений и их итог.
// Каждая отметка «▼ Снижение» / «▲ Повышение» из «Управления продажами»: сколько билетов и по какому тарифу
// продали за 3 дня до решения и за 3 дня после, и сколько обычно продаётся за те же дни (норма по дням недели).
// Итог — в рублях: выручка после решения против той, что была бы без него (столько билетов, сколько продали бы
// по старому тарифу, × старый тариф). Повышение с чуть меньшими продажами, но большим тарифом — не провал.
// Сводка по типу решения, по направлениям и по людям. Те же расчёты, что в карточке рейса (price-marks.js).
window.DecisionsReport = (function () {
    const PERIODS = [30, 60, 90];
    const KIND = { down: '▼ Снижение', up: '▲ Повышение', attn: '! Внимание' };
    let period = 60;
    let kindFilter = '';
    let memo = { sig: '', rows: null };

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

    function sig() {
        return [typeof dataEpoch === 'number' ? dataEpoch : 0, typeof getTodayDate === 'function' ? getTodayDate() : '',
            SalesManagement.markRevision ? SalesManagement.markRevision() : '',
            typeof SalesArchive !== 'undefined' && SalesArchive.revision ? SalesArchive.revision() : 0, period].join('|');
    }

    function daysAgo(dateStr) {
        const d = parseLocalDate(dateStr);
        if (!d) return null;
        const t = new Date();
        t.setHours(0, 0, 0, 0);
        return Math.round((t - d) / 86400000);
    }

    // Строки журнала (решения «снижение/повышение» за период), с итогом.
    function rows() {
        const s = sig();
        if (memo.sig === s && memo.rows) return memo.rows;
        const out = [];
        SalesManagement.allMarks().forEach(m => {
            if (m.status !== 'down' && m.status !== 'up') return;
            const ago = daysAgo(m.check);
            if (ago == null || ago < 0 || ago > period) return;
            const code = m.flight;
            const base = typeof getBaseFlight === 'function' ? getBaseFlight(code) : code;
            let e = null;
            try { e = PriceMarks.effectFor(base, code, m.dep, { check: m.check, status: m.status }); } catch (err) { e = null; }
            out.push({
                code, base, dep: m.dep, check: m.check, status: m.status, author: m.author || '',
                direction: typeof getFlightDirection === 'function' ? getFlightDirection(code) : '',
                e,
                done: !!(e && e.complete && e.effect != null),
                money: e && e.complete && e.money ? e.money.delta : null
            });
        });
        out.sort((a, b) => (parseLocalDate(b.check) - parseLocalDate(a.check)) || String(a.code).localeCompare(String(b.code), 'ru', { numeric: true }));
        memo = { sig: s, rows: out };
        return out;
    }

    function plural(n, one, few, many) {
        const m10 = Math.abs(n) % 10, m100 = Math.abs(n) % 100;
        if (m10 === 1 && m100 !== 11) return one;
        if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
        return many;
    }

    function signed(n) {
        if (n == null) return '—';
        return (n > 0 ? '+' : (n < 0 ? '−' : '')) + Math.abs(n);
    }

    // «Сработало» — по выручке (PriceMarks.judge); «рано судить» в долю не входит.
    function worked(r) {
        return verdictOf(r).worked;
    }

    // Сводка: решений, с итогом, «сработало», средний итог в билетах и сумма в рублях к «без решения».
    function summarize(list) {
        const done = list.filter(r => r.done);
        const judged = done.filter(r => worked(r) != null);
        const good = judged.filter(r => worked(r) === true).length;
        const avg = done.length ? done.reduce((a, r) => a + r.e.effect, 0) / done.length : null;
        // Рубли — только по решениям, о которых можно судить (как и «сработало»).
        const withMoney = judged.filter(r => r.money != null);
        const money = withMoney.length ? withMoney.reduce((a, r) => a + r.money, 0) : null;
        const waiting = list.filter(r => !(r.e && r.e.complete)).length;
        return { n: list.length, done: done.length, waiting, noNorm: list.length - done.length - waiting, judged: judged.length, good, share: judged.length ? Math.round(good / judged.length * 100) : null, avg: avg == null ? null : Math.round(avg * 10) / 10, money };
    }

    function rubSigned(v) {
        if (v == null) return '—';
        const t = typeof formatRub === 'function' ? formatRub(Math.abs(v)) : Math.round(Math.abs(v)).toLocaleString('ru-RU') + ' ₽';
        return (v > 0 ? '+' : (v < 0 ? '−' : '')) + t;
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

    function summaryTable(title, groups, keyLabel, noMoney) {
        if (!groups.length) return '';
        const rowsHtml = groups.slice(0, 10).map(g => `
            <tr>
                <td class="rp-left"><strong>${esc(g.key)}</strong></td>
                <td>${g.n}</td>
                <td class="dr-share-cell">${shareBar(g.share)}</td>
                ${noMoney ? '' : `<td class="rp-nowrap">${g.money == null ? '—' : `<span class="${g.money > 0 ? 'dr-pos' : (g.money < 0 ? 'dr-neg' : '')}">${rubSigned(g.money)}</span>`}</td>`}
            </tr>`).join('');
        return `<div class="dr-sum">
            <div class="dr-sum-title">${esc(title)}</div>
            <table class="rp-table dr-sum-table"><thead><tr><th>${esc(keyLabel)}</th><th>Решений</th><th title="Из решений, по которым можно судить: выручка после решения не ниже, чем была бы без него">Сработало</th>${noMoney ? '' : '<th title="Сумма: на сколько рублей выручка после решений больше (+) или меньше (−), чем была бы без них (за 3 дня после каждого)">Итог, ₽</th>'}</tr></thead><tbody>${rowsHtml}</tbody></table>
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

    function html() {
        if (!available()) return '<p class="rp-note">Журнал решений недоступен.</p>';
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
        const avgTxt = (t) => (t.avg == null ? '—' : `<span class="${t.avg > 0 ? 'dr-pos' : (t.avg < 0 ? 'dr-neg' : '')}">${signed(t.avg)}</span>`);
        const kpis = `<div class="dr-kpis">
            ${kpi('Решений', String(total.n), [`с итогом ${total.done}`, total.waiting ? `ждут 3 дня: ${total.waiting}` : '', total.noNorm ? `не с чем сравнить: ${total.noNorm}` : ''].filter(Boolean).join(' · '))}
            ${kpi('Сработало', total.share == null ? '—' : `<span class="${total.share >= 50 ? 'dr-pos' : 'dr-neg'}">${total.share}%</span>`, total.judged ? `${total.good} из ${total.judged}${total.done - total.judged ? ` · рано судить ${total.done - total.judged}` : ''}` : 'пока нет итогов')}
            ${kpi('Выручка к «без решений»', total.money == null ? '—' : `<span class="${total.money > 0 ? 'dr-pos' : (total.money < 0 ? 'dr-neg' : '')}">${rubSigned(total.money)}</span>`, total.avg != null ? `билетов к обычному: ${avgTxt(total)} в среднем` : '')}
            ${!kindFilter ? kpi('▼ Снижения', String(down.n), down.share != null ? `сработало ${down.share}% · ${rubSigned(down.money)}` : '', 'dr-kpi-down') : ''}
            ${!kindFilter ? kpi('▲ Повышения', String(up.n), up.share != null ? `сработало ${up.share}% · ${rubSigned(up.money)}` : '', 'dr-kpi-up') : ''}
        </div>`;
        const body = list.map(r => {
            const e = r.e;
            const v = verdictOf(r);
            const usual = (x) => (x ? `<span class="dr-usual">обычно ${x.value}</span>` : '');
            const fare = e && e.before.avg != null && e.after.avg != null
                ? `${Math.round(e.before.avg).toLocaleString('ru-RU')} → ${Math.round(e.after.avg).toLocaleString('ru-RU')} ₽` : '—';
            const m = e && e.complete ? e.money : null;
            const rev = m ? `${Math.round(m.r0).toLocaleString('ru-RU')} → ${Math.round(m.r1).toLocaleString('ru-RU')} ₽<div class="dr-usual">без решения → с решением</div>` : '—';
            return `
                <tr>
                    <td class="rp-nowrap"><strong>${esc(r.check.slice(0, 5))}</strong><div class="dr-usual">${esc(r.author || '—')}</div></td>
                    <td class="rp-left"><button type="button" class="filter-btn rp-open" data-open-base="${esc(r.base)}" data-open-code="${esc(r.code)}" data-open-date="${esc(r.dep)}" title="Открыть вылет">${esc(r.code)}</button><div class="dr-usual">${esc(r.direction)}</div></td>
                    <td class="rp-nowrap">${esc(r.dep.slice(0, 5))}</td>
                    <td><span class="dr-kind dr-kind-${esc(r.status)}">${esc(KIND[r.status] || r.status)}</span></td>
                    <td><strong>${e ? e.before.n : '—'}</strong>${e ? usual(e.normBefore) : ''}</td>
                    <td><strong>${e ? e.after.n : '—'}</strong>${e ? usual(e.normAfter) : ''}</td>
                    <td class="rp-nowrap">${fare}</td>
                    <td class="rp-nowrap">${rev}</td>
                    <td class="rp-left"><span class="dr-verdict dr-verdict-${v.cls}">${esc(v.text)}</span></td>
                </tr>`;
        }).join('');
        const sums = list.length ? `<div class="dr-sums">
            ${summaryTable('По направлениям', groupBy(list, r => r.direction || r.code), 'Направление')}
            ${summaryTable('По людям', groupBy(list, r => r.author || '—'), 'Кто', true)}
        </div>` : '';
        return `
            <section class="rp-card dr-card">
                <div class="rp-card-head">
                    <h3 class="rp-card-title">Журнал решений</h3>
                    ${canExport() ? `<button type="button" class="btn-primary rp-btn" id="dr-export"${list.length ? '' : ' disabled'}>В Excel</button>` : ''}
                </div>
                <details class="dr-help"><summary>Как считается</summary>
                    <p>Каждое «▼ Снижение» и «▲ Повышение» из «Управления продажами» сравнивается по <strong>выручке</strong> за 3 дня после решения.</p>
                    <p><strong>Без решения</strong> продали бы столько билетов, сколько обычно продаётся в эти дни (норма по дням недели), с поправкой на то,
                    как рейс шёл до решения (отклонение от нормы — наполовину: за 3 дня оно часто случайное), — по старому тарифу. <strong>С решением</strong> — сколько продали на самом деле по новому тарифу.
                    <strong>Итог</strong> = выручка с решением − выручка без решения.</p>
                    <p>Поэтому повышение, после которого продали чуть меньше, но дороже, — не провал: например, 1 билет за 35 525 ₽ вместо ожидаемых
                    2 по 20 175 ₽ — это −4 825 ₽, а не «продажи просели». Для повышения видно, со скольких билетов оно окупилось бы.
                    Если билетов за оба окна меньше 4, вывод делать рано — такие решения в «Сработало» не считаются.
                    Если после повышения рейс заполнился (от 95%), повышение места не стоило и считается сработавшим.</p>
                </details>
                ${toolbar}
                ${kpis}
                ${sums}
                ${body ? `<div class="dr-list-title">Все решения <span class="rp-muted">· ${list.length}</span></div><div class="rp-scroll"><table class="rp-table dr-table">
                    <thead><tr><th>Решение</th><th>Рейс</th><th>Вылет</th><th>Что</th><th title="Билетов за 3 дня до решения">До</th><th title="Билетов за 3 дня после решения">После</th><th>Ср. тариф до → после</th><th title="За 3 дня после решения: сколько было бы без него (билетов, как обычно, по старому тарифу) и сколько вышло">Выручка</th><th>Итог</th></tr></thead>
                    <tbody>${body}</tbody></table></div>` : '<p class="rp-note">За период решений «снижение/повышение» нет.</p>'}
            </section>`;
    }

    // Данные для выгрузки в Excel (reports-view.js → exportDecisions).
    function exportData() {
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
                const v = verdictOf(r);
                return {
                    check: r.check, author: r.author, code: r.code, direction: r.direction, dep: r.dep,
                    kind: KIND[r.status] || r.status,
                    before: e ? e.before.n : '', normBefore: e && e.normBefore ? e.normBefore.value : '',
                    after: e ? e.after.n : '', normAfter: e && e.normAfter ? e.normAfter.value : '',
                    fareBefore: e && e.before.avg != null ? Math.round(e.before.avg) : '',
                    fareAfter: e && e.after.avg != null ? Math.round(e.after.avg) : '',
                    effect: e && e.complete && e.effect != null ? e.effect : '',
                    revBefore: e && e.complete && e.money ? e.money.r0 : '',
                    revAfter: e && e.complete && e.money ? e.money.r1 : '',
                    revDelta: e && e.complete && e.money ? e.money.delta : '',
                    verdict: v.short, text: v.text
                };
            })
        };
    }

    function handleClick(btn, rerender) {
        if (btn.dataset.drPeriod != null) { period = parseInt(btn.dataset.drPeriod, 10) || 60; rerender(); return true; }
        if (btn.dataset.drKind != null) { kindFilter = btn.dataset.drKind || ''; rerender(); return true; }
        return false;
    }

    function handleChange() {
        return false;
    }

    return { canView, html, handleChange, handleClick, exportData, summarize };
})();
