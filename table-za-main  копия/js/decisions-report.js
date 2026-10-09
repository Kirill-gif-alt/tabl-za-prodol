// «Отчёты» → «Решения»: журнал ценовых решений и их итог.
// Каждая отметка «▼ Снижение» / «▲ Повышение» из «Управления продажами»: сколько билетов продали за 3 дня
// до решения и за 3 дня после — в сравнении с тем, сколько обычно продаётся за те же дни (норма по дням
// недели). Итог = (после − обычно) − (до − обычно), в билетах. Через месяц-два видно, где решения работают:
// сводка по типу решения, по направлениям и по людям. Те же расчёты, что в карточке рейса (price-marks.js).
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
                done: !!(e && e.complete && e.effect != null)
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

    // «Сработало»: снижение — после него продаётся лучше обычного; повышение — продажи не просели
    // против обычного (спрос выдержал более высокую цену).
    function worked(r) {
        return r.status === 'up' ? r.e.effect >= 0 : r.e.effect > 0;
    }

    // Сводка: решений, с итогом, «сработало», средний итог в билетах.
    function summarize(list) {
        const done = list.filter(r => r.done);
        const good = done.filter(worked).length;
        const avg = done.length ? done.reduce((a, r) => a + r.e.effect, 0) / done.length : null;
        return { n: list.length, done: done.length, good, share: done.length ? Math.round(good / done.length * 100) : null, avg: avg == null ? null : Math.round(avg * 10) / 10 };
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
        const e = r.e;
        if (!e || !e.complete) return { cls: 'wait', text: 'ещё идут 3 дня', short: 'ждём' };
        if (e.effect == null) return { cls: 'none', text: 'не с чем сравнить', short: '—' };
        if (r.status === 'up') {
            return e.effect >= 0
                ? { cls: 'pos', text: `спрос выдержал повышение${e.effect ? ' (' + signed(e.effect) + ')' : ''}`, short: 'сработало' }
                : { cls: 'neg', text: `продажи просели против обычного ${signed(e.effect)}`, short: 'не сработало' };
        }
        if (e.effect > 0) return { cls: 'pos', text: `продаётся лучше обычного ${signed(e.effect)}`, short: 'сработало' };
        return { cls: 'neg', text: e.effect < 0 ? 'хуже обычного ' + signed(e.effect) : 'без изменений', short: 'не сработало' };
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
                <td class="dr-share-cell">${shareBar(g.share)}</td>
                <td>${g.avg == null ? '—' : `<span class="${g.avg > 0 ? 'dr-pos' : (g.avg < 0 ? 'dr-neg' : '')}">${signed(g.avg)}</span>`}</td>
            </tr>`).join('');
        return `<div class="dr-sum">
            <div class="dr-sum-title">${esc(title)}</div>
            <table class="rp-table dr-sum-table"><thead><tr><th>${esc(keyLabel)}</th><th>Решений</th><th title="Из решений с итогом. Снижение — после него продаётся лучше обычного; повышение — продажи не просели">Сработало</th><th title="Средний итог: на сколько билетов после решения продавалось лучше (+) или хуже (−) обычного">Итог, бил.</th></tr></thead><tbody>${rowsHtml}</tbody></table>
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
            ${kpi('Решений', String(total.n), `с итогом ${total.done}${total.n - total.done ? ` · ждут ${total.n - total.done}` : ''}`)}
            ${kpi('Сработало', total.share == null ? '—' : `<span class="${total.share >= 50 ? 'dr-pos' : 'dr-neg'}">${total.share}%</span>`, total.done ? `${total.good} из ${total.done}` : 'пока нет итогов')}
            ${kpi('Средний итог', avgTxt(total), total.avg != null ? plural(Math.round(Math.abs(total.avg)) || 0, 'билет', 'билета', 'билетов') + ' к обычному' : '')}
            ${!kindFilter ? kpi('▼ Снижения', String(down.n), down.share != null ? `сработало ${down.share}% · итог ${avgTxt(down)}` : '', 'dr-kpi-down') : ''}
            ${!kindFilter ? kpi('▲ Повышения', String(up.n), up.share != null ? `сработало ${up.share}% · итог ${avgTxt(up)}` : '', 'dr-kpi-up') : ''}
        </div>`;
        const body = list.map(r => {
            const e = r.e;
            const v = verdictOf(r);
            const usual = (x) => (x ? `<span class="dr-usual">обычно ${x.value}</span>` : '');
            const fare = e && e.before.avg != null && e.after.avg != null
                ? `${Math.round(e.before.avg).toLocaleString('ru-RU')} → ${Math.round(e.after.avg).toLocaleString('ru-RU')} ₽` : '—';
            return `
                <tr>
                    <td class="rp-nowrap"><strong>${esc(r.check.slice(0, 5))}</strong><div class="dr-usual">${esc(r.author || '—')}</div></td>
                    <td class="rp-left"><button type="button" class="filter-btn rp-open" data-open-base="${esc(r.base)}" data-open-code="${esc(r.code)}" data-open-date="${esc(r.dep)}" title="Открыть вылет">${esc(r.code)}</button><div class="dr-usual">${esc(r.direction)}</div></td>
                    <td class="rp-nowrap">${esc(r.dep.slice(0, 5))}</td>
                    <td><span class="dr-kind dr-kind-${esc(r.status)}">${esc(KIND[r.status] || r.status)}</span></td>
                    <td><strong>${e ? e.before.n : '—'}</strong>${e ? usual(e.normBefore) : ''}</td>
                    <td><strong>${e ? e.after.n : '—'}</strong>${e ? usual(e.normAfter) : ''}</td>
                    <td class="rp-nowrap">${fare}</td>
                    <td class="rp-left"><span class="dr-verdict dr-verdict-${v.cls}">${esc(v.text)}</span></td>
                </tr>`;
        }).join('');
        const sums = list.length ? `<div class="dr-sums">
            ${summaryTable('По направлениям', groupBy(list, r => r.direction || r.code), 'Направление')}
            ${summaryTable('По людям', groupBy(list, r => r.author || '—'), 'Кто')}
        </div>` : '';
        return `
            <section class="rp-card dr-card">
                <div class="rp-card-head">
                    <h3 class="rp-card-title">Журнал решений</h3>
                    ${canExport() ? `<button type="button" class="btn-primary rp-btn" id="dr-export"${list.length ? '' : ' disabled'}>В Excel</button>` : ''}
                </div>
                <details class="dr-help"><summary>Как считается</summary>
                    <p>Каждое «▼ Снижение» и «▲ Повышение» из «Управления продажами»: сколько билетов продали за 3 дня до решения и за 3 дня после,
                    и сколько обычно продаётся за эти же дни до вылета (норма по дням недели). <strong>Итог</strong> — на сколько билетов после решения продавалось
                    лучше или хуже обычного по сравнению с тем, что было до. <strong>Сработало</strong>: снижение — продажи пошли лучше обычного;
                    повышение — продажи не просели (спрос выдержал цену). Видны отметки за месяцы, загруженные в «Управлении продажами».</p>
                </details>
                ${toolbar}
                ${kpis}
                ${sums}
                ${body ? `<div class="dr-list-title">Все решения <span class="rp-muted">· ${list.length}</span></div><div class="rp-scroll"><table class="rp-table dr-table">
                    <thead><tr><th>Решение</th><th>Рейс</th><th>Вылет</th><th>Что</th><th title="Билетов за 3 дня до решения">До</th><th title="Билетов за 3 дня после решения">После</th><th>Ср. тариф до → после</th><th>Итог</th></tr></thead>
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
