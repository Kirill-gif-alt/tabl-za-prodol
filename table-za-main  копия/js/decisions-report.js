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

    function summaryTable(title, groups, keyLabel) {
        if (!groups.length) return '';
        const rowsHtml = groups.slice(0, 12).map(g => `
            <tr>
                <td class="rp-left"><strong>${esc(g.key)}</strong></td>
                <td>${g.n}</td>
                <td>${g.done}</td>
                <td>${g.share == null ? '—' : `<span class="${g.share >= 50 ? 'dr-pos' : 'dr-neg'}">${g.share}%</span>`}</td>
                <td>${g.avg == null ? '—' : `<span class="${g.avg > 0 ? 'dr-pos' : (g.avg < 0 ? 'dr-neg' : '')}">${signed(g.avg)}</span>`}</td>
            </tr>`).join('');
        return `<div class="dr-sum">
            <div class="dr-sum-title">${esc(title)}</div>
            <table class="rp-table dr-sum-table"><thead><tr><th>${esc(keyLabel)}</th><th>Решений</th><th>С итогом</th><th title="Снижение — после него продаётся лучше обычного; повышение — продажи не просели против обычного">Сработало</th><th title="Средний итог: на сколько билетов после решения продавалось лучше (+) или хуже (−) обычного">Итог, бил.</th></tr></thead><tbody>${rowsHtml}</tbody></table>
            ${groups.length > 12 ? `<div class="rp-muted">и ещё ${groups.length - 12}</div>` : ''}
        </div>`;
    }

    function html() {
        if (!available()) return '<p class="rp-note">Журнал решений недоступен.</p>';
        const all = rows();
        const list = kindFilter ? all.filter(r => r.status === kindFilter) : all;
        const total = summarize(list);
        const head = `
            <div class="ref-toolbar">
                <label>Период <select class="cr-input" id="dr-period">${PERIODS.map(p => `<option value="${p}"${p === period ? ' selected' : ''}>${p} дней</option>`).join('')}</select></label>
                <label>Решения <select class="cr-input" id="dr-kind"><option value="">все</option><option value="down"${kindFilter === 'down' ? ' selected' : ''}>▼ снижение</option><option value="up"${kindFilter === 'up' ? ' selected' : ''}>▲ повышение</option></select></label>
                <span class="rp-muted">Решений: ${total.n} · с итогом: ${total.done}${total.share != null ? ` · сработало ${total.share}%` : ''}${total.avg != null ? ` · средний итог ${signed(total.avg)} ${plural(Math.round(total.avg), 'билет', 'билета', 'билетов')}` : ''}</span>
            </div>`;
        const body = list.map(r => {
            const e = r.e;
            const usual = (x) => (x ? ` <span class="rp-muted">(обычно ${x.value})</span>` : '');
            let verdict = '<span class="rp-muted">ещё идут 3 дня</span>';
            if (e && e.complete) {
                if (e.effect == null) verdict = '<span class="rp-muted">не с чем сравнить</span>';
                else if (r.status === 'up') verdict = e.effect >= 0
                    ? `<span class="dr-pos">спрос выдержал повышение${e.effect ? ' (' + signed(e.effect) + ')' : ''}</span>`
                    : `<span class="dr-neg">продажи просели против обычного ${signed(e.effect)}</span>`;
                else verdict = e.effect > 0
                    ? `<span class="dr-pos">продаётся лучше обычного ${signed(e.effect)}</span>`
                    : `<span class="dr-neg">${e.effect < 0 ? 'хуже обычного ' + signed(e.effect) : 'без изменений'}</span>`;
            }
            const fare = e && e.before.avg != null && e.after.avg != null
                ? `${Math.round(e.before.avg).toLocaleString('ru-RU')} → ${Math.round(e.after.avg).toLocaleString('ru-RU')} ₽` : '—';
            return `
                <tr>
                    <td class="rp-nowrap">${esc(r.check)}</td>
                    <td class="rp-left">${esc(r.author)}</td>
                    <td><button type="button" class="filter-btn rp-open" data-open-base="${esc(r.base)}" data-open-code="${esc(r.code)}" data-open-date="${esc(r.dep)}" title="Открыть вылет">${esc(r.code)}</button></td>
                    <td class="rp-left">${esc(r.direction)}</td>
                    <td class="rp-nowrap">${esc(r.dep.slice(0, 5))}</td>
                    <td><span class="pm-glyph pm-${esc(r.status)}">${esc(KIND[r.status] || r.status)}</span></td>
                    <td>${e ? e.before.n : '—'}${e ? usual(e.normBefore) : ''}</td>
                    <td>${e ? e.after.n : '—'}${e ? usual(e.normAfter) : ''}</td>
                    <td class="rp-nowrap">${fare}</td>
                    <td class="rp-left">${verdict}</td>
                </tr>`;
        }).join('');
        const sums = list.length ? `<div class="dr-sums">
            ${summaryTable('По типу решения', groupBy(list, r => KIND[r.status] || r.status), 'Решение')}
            ${summaryTable('По направлениям', groupBy(list, r => r.direction || r.code), 'Направление')}
            ${summaryTable('По людям', groupBy(list, r => r.author || '—'), 'Кто')}
        </div>` : '';
        return `
            <section class="rp-card">
                <div class="rp-card-head"><h3 class="rp-card-title">Журнал решений</h3></div>
                <p class="rp-card-text">Каждое «▼ Снижение» и «▲ Повышение» из «Управления продажами»: сколько билетов продали за 3 дня до решения и за 3 дня после,
                    и сколько обычно продаётся за эти же дни до вылета (норма по дням недели). <strong>Итог</strong> — на сколько билетов после решения продавалось
                    лучше или хуже обычного по сравнению с тем, что было до. <strong>Сработало</strong>: снижение — продажи пошли лучше обычного;
                    повышение — продажи не просели (спрос выдержал цену). Видны отметки за месяцы, загруженные в «Управлении продажами».</p>
                ${head}
                ${sums}
                ${body ? `<div class="rp-scroll"><table class="rp-table dr-table">
                    <thead><tr><th>Решение от</th><th>Кто</th><th>Рейс</th><th>Направление</th><th>Вылет</th><th>Решение</th><th title="Билетов за 3 дня до решения">До</th><th title="Билетов за 3 дня после решения">После</th><th>Ср. тариф до → после</th><th>Итог</th></tr></thead>
                    <tbody>${body}</tbody></table></div>` : '<p class="rp-note">За период решений «снижение/повышение» нет.</p>'}
            </section>`;
    }

    function handleChange(target, rerender) {
        if (target.id === 'dr-period') { period = parseInt(target.value, 10) || 60; rerender(); return true; }
        if (target.id === 'dr-kind') { kindFilter = target.value || ''; rerender(); return true; }
        return false;
    }

    return { canView, html, handleChange, summarize };
})();
