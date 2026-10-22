// «Отчёты» → «Решения»: журнал ценовых решений и их итог в рублях (единственное место на сайте, где показаны деньги по решениям).
// Эффект = выручка в окне после решения минус ожидаемое число билетов × прежняя цена; делится на объём и цену.
// «Помогло / навредило» только при диапазоне без нуля и эффекте выше порога, иначе слабее («скорее», «чуть») или без эффекта (расчёт — js/decision-money.js).
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
    let toneFilter = '';
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

    function pv(name, d) { return typeof PV !== 'undefined' && typeof PV[name] === 'number' ? PV[name] : d; }
    function dayDiff(a, b) {
        const da = parseLocalDate(a); const db = parseLocalDate(b);
        return da && db ? Math.round((da.getTime() - db.getTime()) / 86400000) : null;
    }
    function ruNum(n) { return Number(n).toLocaleString('ru-RU'); }
    function daysWord(n, forms) { return n + ' ' + pluralRu(n, forms[0], forms[1], forms[2]); }
    // Вероятность попадания в диапазон при ширине z (в процентах, целое).
    function confPct(z) { return typeof DecisionMoney !== 'undefined' && DecisionMoney.erf ? Math.round(100 * DecisionMoney.erf(z / Math.SQRT2)) : 94; }

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
        // Подпись — только по данным и отметкам: запись итогов в общий файл её не меняет, иначе расчёт шёл бы по кругу.
        const s = sig();
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
        if (n == null || n === '' || !Number.isFinite(Number(n))) return '—';
        const v = Math.round(n);
        return (v > 0 ? '+' : (v < 0 ? '−' : '')) + Math.abs(v).toLocaleString('ru-RU') + ' ₽';
    }

    function rubPlain(n) { return n == null || !Number.isFinite(Number(n)) ? '—' : Math.round(n).toLocaleString('ru-RU') + ' ₽'; }

    // Состояние денежной оценки одного решения для экрана и Excel.
    function moneyState(r) {
        const m = moneyOf(r);
        if (!m) return { cls: 'wait', text: money.loading ? 'считаем…' : '—', short: '', m: null };
        if (m.stage === 'na') return { cls: 'none', text: 'мало данных', short: 'мало данных', reason: m.reason, m };
        if (m.stage === 'wait') return { cls: 'wait', text: 'ждём итога', short: 'ждём итога', reason: m.reason, m };
        if (m.stage === 'prelim') return { cls: 'wait', text: 'ждём итога, пока ' + rub(m.delta), short: 'ждём итога', reason: m.reason, m };
        if (m.verdict === 'weak_pos') return { cls: 'wpos', text: 'чуть помогло', short: 'чуть помогло', m };
        if (m.verdict === 'weak_neg') return { cls: 'wneg', text: 'чуть навредило', short: 'чуть навредило', m };
        if (m.verdict === 'flat') return { cls: 'flat', text: 'без заметного эффекта', short: 'без эффекта', m };
        if (m.verdict === 'lean_pos') return { cls: 'lpos', text: 'скорее помогло', short: 'скорее помогло', m };
        if (m.verdict === 'lean_neg') return { cls: 'lneg', text: 'скорее навредило', short: 'скорее навредило', m };
        if (m.verdict === 'worked') return { cls: 'pos', text: 'помогло', short: 'помогло', m };
        if (m.verdict === 'failed') return { cls: 'neg', text: 'навредило', short: 'навредило', m };
        return { cls: 'none', text: 'мало данных', short: 'мало данных', reason: m.reason || 'диапазон включает ноль или эффект ниже порога', m };
    }

    // Итоги пулом: «по определённым» — только твёрдые «помогло / навредило»; «по всем оценённым» (sumAll) — все решения с оценкой.
    function moneyTotals(list) {
        const t = { n: list.length, finalN: 0, worked: 0, failed: 0, unclear: 0, na: 0, wait: 0, sum: 0, lo: 0, hi: 0, definite: 0, sumAll: 0, approx: 0, approxSum: 0, weakPos: 0, weakNeg: 0, flat: 0, varSum: 0, lean: 0, leanSum: 0, leanPos: 0, leanNeg: 0, series: 0, reasons: {} };
        list.forEach(r => {
            const st = moneyState(r);
            const m = st.m;
            if (!m || m.stage === 'wait' || m.stage === 'prelim') { t.wait++; return; }
            if (m.stage === 'na') { t.na++; const k = String(m.reason || 'без причины').split(':')[0]; t.reasons[k] = (t.reasons[k] || 0) + 1; return; }
            t.finalN++;
            t.sumAll += m.delta || 0;
            t.varSum += Math.pow(m.sd != null ? m.sd : ((m.hi || 0) - (m.lo || 0)) / 2 / 1.9, 2);
            if ((m.verdict === 'worked' || m.verdict === 'failed') && m.grade === 'C') { t.approx++; t.approxSum += m.delta; if (m.delta > 0) t.leanPos++; else t.leanNeg++; }
            else if (m.verdict === 'weak_pos') t.weakPos++;
            else if (m.verdict === 'weak_neg') t.weakNeg++;
            else if (m.verdict === 'flat') t.flat++;
            else if (m.verdict === 'lean_pos' || m.verdict === 'lean_neg') { t.lean++; t.leanSum += m.delta; if (m.verdict === 'lean_pos') t.leanPos++; else t.leanNeg++; }
            else if (m.verdict === 'worked') { t.worked++; t.definite++; t.sum += m.delta; }
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

    const LEAD = ['1–3 дня', '4–7 дней', '8–14 дней', 'Больше 14 дней'];
    function leadOf(r) { const n = dayDiff(r.dep, r.check); return n == null ? '—' : (n <= 3 ? LEAD[0] : (n <= 7 ? LEAD[1] : (n <= 14 ? LEAD[2] : LEAD[3]))); }
    function leadSort(x, y) { return LEAD.indexOf(x.key) - LEAD.indexOf(y.key); }

    function groupBy(list, keyFn, sortFn) {
        const map = new Map();
        list.forEach(r => {
            const k = keyFn(r);
            if (!map.has(k)) map.set(k, []);
            map.get(k).push(r);
        });
        return [...map.entries()].map(([k, l]) => ({ key: k, ...summarize(l) })).sort(sortFn || ((a, b) => b.n - a.n));
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
                <td class="rp-nowrap">${g.money.definite ? `<span class="${g.money.sum >= 0 ? 'dr-pos' : 'dr-neg'}">${rub(g.money.sum)}</span>` : '—'}${g.money.finalN ? `<div class="dr-usual">все оценённые ${rub(g.money.sumAll)}</div>` : ''}</td>
                <td>${g.money.approx}</td>
                <td>${g.money.unclear + g.money.na + g.money.wait}</td>
            </tr>`).join('');
        return `<div class="dr-sum">
            <div class="dr-sum-title">${esc(title)}</div>
            <table class="rp-table dr-sum-table"><thead><tr><th>${esc(keyLabel)}</th><th>Решений</th><th title="Решения с твёрдым итогом «помогло / навредило» (диапазон не включает ноль и эффект выше порога)">Определено</th><th title="Сверху — сумма только по твёрдым итогам, снизу — по всем оценённым решениям">Эффект</th><th title="Помогло или навредило, но данных мало (доверие низкое): в первую сумму не входят">Ориент.</th><th title="Мало данных, ждём итога или не считаем: в сумму не входят">Мало данных</th></tr></thead><tbody>${rowsHtml}</tbody></table>
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
            ${kpi('Определённый итог', mt.definite ? String(mt.definite) : '—', mt.definite ? `помогло ${mt.worked} · навредило ${mt.failed}` : (money.loading ? 'считаем…' : 'пока нет'))}
            ${kpi('Эффект по определённым', mt.definite ? `<span class="${sumCls}">${rub(mt.sum)}</span>` : '—', mt.finalN ? `по всем оценённым ${rub(mt.sumAll)} (диапазон ${rub(mt.lo)} … ${rub(mt.hi)})` : '')}
            ${kpi('Мало данных', String(mt.unclear), 'диапазон включает ноль или эффект ниже порога; в сумму не входят')}
            ${!kindFilter ? kpi('▼ Снижения', String(down.n), down.money.definite ? `${rub(down.money.sum)} по определённым` : '', 'dr-kpi-down') : ''}
            ${!kindFilter ? kpi('▲ Повышения', String(up.n), up.money.definite ? `${rub(up.money.sum)} по определённым` : '', 'dr-kpi-up') : ''}
        </div>`;
        const minPct = pv('MONEY_MIN_PCT', 15); const minRub = ruNum(pv('MONEY_MIN_RUB', 20000));
        const nbDays = pv('MONEY_NEIGHBOR_DAYS', 5); const wMax = pv('MONEY_WINDOW_MAX', 10); const leanP = Math.round(pv('MONEY_LEAN_P', 0.75) * 100);
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
        const fmtD = (x) => String(x).slice(0, 5);
        const numRu = (x) => String(x).replace('.', ',');
        const cards = list.map(r => {
            const st = moneyState(r);
            const m = st.m;
            const up = r.status === 'up';
            const hasNum = m && (m.stage === 'final' || m.stage === 'prelim') && m.delta != null;
            let tone = 'na'; let big = 'мало данных';
            const approx = m && m.grade === 'C';
            if (st.cls === 'pos') { tone = 'pos'; big = (approx ? '≈ ' : '') + rub(m.delta); }
            else if (st.cls === 'neg') { tone = 'neg'; big = (approx ? '≈ ' : '') + rub(m.delta); }
            else if (st.cls === 'lpos' || st.cls === 'lneg' || st.cls === 'wpos' || st.cls === 'wneg' || st.cls === 'flat') { tone = st.cls; big = '≈ ' + rub(m.delta); }
            else if (m && m.stage === 'final') { tone = 'unk'; big = 'примерно ' + rub(m.delta); }
            else if (m && (m.stage === 'prelim' || m.stage === 'wait')) { tone = 'wait'; big = hasNum ? 'пока ' + rub(m.delta) : '—'; }
            else if (!m) { tone = money.loading ? 'wait' : 'na'; big = money.loading ? 'считаем…' : 'мало данных'; }
            const lines = [];
            let say = ''; let range = ''; const tags = [];
            if (hasNum) {
                // выручка без решения и по факту: из расчёта (у старых зафиксированных записей — из округлённых величин, не ниже нуля)
                const exp = m.expRev != null ? m.expRev : m.nExpPaid * m.priceBefore;
                const fact = m.revFact != null ? m.revFact : Math.max(0, exp + m.delta);
                lines.push(m.remainder
                    ? `От дня после решения до вылета продали <b>${m.factAll}</b> билетов, обычно за это время — около <b>${numRu(m.expAll)}</b>.`
                    : `За ${m.w} дн. после решения продали <b>${m.factAll}</b> билетов, обычно в такие дни — около <b>${numRu(m.expAll)}</b>.`);
                lines.push(m.nCf != null
                    ? `Если бы тариф не трогали (был ${rubPlain(m.priceBefore)}), продали бы ${up ? 'не меньше' : 'не больше'} <b>${numRu(m.nCf)}</b> билетов — около <b>${rubPlain(exp)}</b>. По факту — около <b>${rubPlain(fact)}</b>.`
                    : `Если бы тариф не трогали (был ${rubPlain(m.priceBefore)}), выручка была бы около <b>${rubPlain(exp)}</b>. По факту — около <b>${rubPlain(fact)}</b>.`);
                lines.push(m.volPure != null
                    ? `Разница <b>${rub(m.delta)}</b>: из-за цены ${rub(m.priceEffect)}, из-за количества билетов ${rub(m.volPure)}${Math.abs(m.corr || 0) >= 500 ? `, поправка на шум и сдвиг ${rub(m.corr)}` : ''}.`
                    : `Разница <b>${rub(m.delta)}</b>: из-за количества билетов ${rub(m.volume)}, из-за цены ${rub(m.priceEffect)}.`);
                range = DecisionsViz.rangeBar(m.lo, m.delta, m.hi, rub) + `<div class="dp-exp">Диапазон — где настоящий результат с вероятностью около ${confPct(pv('MONEY_NOISE_Z', 1.9))}%.</div>`;
                if (tone === 'pos') say = approx ? 'Ориентировочно помогло: даже в худшем случае плюс, но данных мало (доверие низкое).' : 'Помогло: даже в худшем случае заработали больше, чем без решения.';
                else if (tone === 'neg') say = approx ? 'Ориентировочно навредило: даже в лучшем случае минус, но данных мало (доверие низкое).' : 'Навредило: даже в лучшем случае заработали меньше, чем без решения.';
                else if (tone === 'unk') say = 'Мало данных: результат мог быть и плюсом, и минусом. В твёрдую сумму такое решение не входит.';
                else if (tone === 'wpos') say = `Чуть помогло: эффект есть, но слабый (вероятность плюса около ${m.pPos}%). Одно такое решение ничего не доказывает, смотрите общий итог.`;
                else if (tone === 'wneg') say = `Чуть навредило: эффект есть, но слабый (вероятность минуса около ${100 - m.pPos}%). Одно такое решение ничего не доказывает, смотрите общий итог.`;
                else if (tone === 'flat') say = `Без заметного эффекта: разница меньше порога значимости (${minPct}% выручки или ${minRub} ₽, берётся большее).`;
                else if (tone === 'lpos') say = `Скорее помогло: вероятность плюса около ${m.pPos}%, но диапазон включает ноль, наверняка сказать нельзя.`;
                else if (tone === 'lneg') say = `Скорее навредило: вероятность минуса около ${100 - m.pPos}%, но диапазон включает ноль — наверняка сказать нельзя.`;
                else say = 'Ждём итога: зафиксируем, когда пройдёт окно или вылет.';
                tags.push(`Доверие: ${m.grade === 'A' ? 'высокое' : (m.grade === 'B' ? 'среднее' : 'низкое')} (${m.k} ${m.k === 1 ? 'похожий вылет' : (m.k < 5 ? 'похожих вылета' : 'похожих вылетов')})`);
                if (!m.frozen) tags.push('не зафиксировано');
            }
            if (m && m.flags && m.flags.length) lines.push('<span class="dp-flags">Почему доверие низкое: ' + m.flags.map(esc).join('; ') + '.</span>');
            if (tone === 'wait' && st.reason && hasNum) lines.push(esc(st.reason) + '.');
            if (tone === 'na' && st.reason) say = 'Не считаем: ' + esc(st.reason) + '.';
            if (m && m.cfAdj > 0) lines.push(up
                ? `Билеты сверх обычного (${numRu(m.cfAdj)}) повышению не засчитаны: повышение цены не приводит новых покупателей, они купили бы и по старой цене.`
                : `Нехватку билетов (${numRu(m.cfAdj)}) снижению в вину не ставим: снижение цены не могло уменьшить число покупателей.`);
            if (m && m.tailExp != null) lines.push(`После окна рейс продал ${m.tailFact} билетов (обычно ${numRu(m.tailExp)})${m.fullFlight ? ', рейс заполнился' : ''}.`);
            tags.push(`<button type="button" class="filter-btn rp-open" data-open-base="${esc(r.base)}" data-open-code="${esc(r.code)}" data-open-date="${esc(r.dep)}">Открыть вылет →</button>`);
            const short = hasNum ? `продали ${m.factAll} вместо ${numRu(m.expAll)}` : (st.reason ? esc(st.reason) : '');
            return DecisionsViz.plainRow({
                tone,
                key: [r.code, r.dep, r.check, r.status].join('|'),
                head: `<span class="dp-code">${esc(r.code)}</span> <span class="dp-dir">${esc(r.direction)}</span>`,
                dep: esc(fmtD(r.dep)),
                act: `<span class="dp-ud dp-ud-${up ? 'up' : 'down'}" title="${up ? 'Повышение' : 'Снижение'}">${up ? '▲' : '▼'} ${esc(fmtD(r.check))}${r.author ? ' · ' + esc(r.author) : ''}</span>`,
                big: tone === 'unk' ? '≈ ' + rub(m.delta) : big, short, say, range, lines, tags
            });
        });
        const good = mt.worked + mt.leanPos + mt.weakPos; const bad = mt.failed + mt.leanNeg + mt.weakNeg;
        const tot = mt.sumAll; const tsd = Math.sqrt(mt.varSum) * pv('MONEY_NOISE_Z', 1.9);   // ошибки разных решений почти не связаны (проверено на вылетах без решений): складываем как независимые
        const nOc = mt.finalN;
        const summary = list.length ? DecisionsViz.strip([{ label: 'Решений', value: total.n }, { label: 'Помогло', value: good, cls: 'dr-pos' }, { label: 'Навредило', value: bad, cls: 'dr-neg' }, { label: 'Без заметного эффекта', value: mt.flat }, { label: 'Мало данных', value: mt.unclear + mt.na }, { label: 'Ждём итога', value: mt.wait }]
            .concat(!kindFilter ? [{ label: 'Снижения', value: down.money.finalN ? rub(down.money.sumAll) : '—', cls: down.money.sumAll > 0 ? 'dr-pos' : (down.money.sumAll < 0 ? 'dr-neg' : '') }, { label: 'Повышения', value: up.money.finalN ? rub(up.money.sumAll) : '—', cls: up.money.sumAll > 0 ? 'dr-pos' : (up.money.sumAll < 0 ? 'dr-neg' : '') }] : [])
            .concat([{ label: 'Общий итог по оценённым', value: mt.finalN ? rub(tot) : '—', cls: tot > 0 ? 'dr-pos' : (tot < 0 ? 'dr-neg' : '') }])) + (mt.finalN ? `<div class="dp-reasons">Общий итог по ${nOc} ${pluralRu(nOc, 'оценённому решению', 'оценённым решениям', 'оценённым решениям')}: ${rub(tot)}, диапазон ${rub(tot - tsd)} … ${rub(tot + tsd)} (около ${confPct(pv('MONEY_NOISE_Z', 1.9))}%). Диапазон суммы уже, чем у отдельных решений: ошибки разных решений почти не связаны и частично гасят друг друга. Твёрдых «помогло / навредило» ${mt.definite}, их сумма ${mt.definite ? rub(mt.sum) : '—'} (остальные в неё не входят). Ещё ${mt.leanPos + mt.leanNeg} «скорее», ${mt.weakPos + mt.weakNeg} «чуть», ${mt.unclear} без вывода (мало данных). Снижения и повышения считаются по всем оценённым решениям.</div>` : '') : '';
        const reasonNote = mt.na ? `<div class="dp-reasons">Не считаем (${mt.na}): ${Object.entries(mt.reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => esc(k) + ' — ' + v).join('; ')}.</div>` : '';
        const sts = list.map(moneyState);
        // График по направлениям: 8 лучших и 3 худших по сумме, в порядке убывания модуля эффекта.
        const dirAll = groupBy(list, r => r.direction || r.code).filter(g => g.money.definite).sort((a, b) => b.money.sum - a.money.sum);
        const dirCut = dirAll.length > 11;
        const byDir = (dirCut ? dirAll.slice(0, 8).concat(dirAll.slice(-3)) : dirAll).sort((a, b) => Math.abs(b.money.sum) - Math.abs(a.money.sum));
        const leadGroups = groupBy(list, leadOf, leadSort);   // за сколько дней до вылета принято решение
        const weeks = new Map();
        list.forEach((r, i) => {
            const m = sts[i].m;
            if (!m || m.stage !== 'final' || m.grade === 'C' || (m.verdict !== 'worked' && m.verdict !== 'failed')) return;
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
        const dash = list.length ? `<div class="dv-grid dv-grid2">
            ${DecisionsViz.stack('Итог решений', [
                { label: 'Помогло', value: mt.worked, cls: 'dv-pos' },
                { label: 'Скорее помогло', value: mt.leanPos, cls: 'dv-lpos' },
                { label: 'Чуть помогло', value: mt.weakPos, cls: 'dv-wpos' },
                { label: 'Без заметного эффекта', value: mt.flat, cls: 'dv-flat' },
                { label: 'Чуть навредило', value: mt.weakNeg, cls: 'dv-wneg' },
                { label: 'Скорее навредило', value: mt.leanNeg, cls: 'dv-lneg' },
                { label: 'Навредило', value: mt.failed, cls: 'dv-neg' },
                { label: 'Мало данных', value: mt.unclear + mt.na, cls: 'dv-na' },
                { label: 'Ждём итога', value: mt.wait, cls: 'dv-wait' }])}
            ${DecisionsViz.bars('Эффект по направлениям (твёрдые итоги)', byDir.map(g => ({ label: g.key, value: g.money.sum, text: rub(g.money.sum), sub: `решений ${g.money.definite}` })), 'Рубли за окно после решения против ожидаемого по прежней цене' + (dirCut ? '. Показаны 8 лучших и 3 худших направления' : ''))}
        </div>` : '';
        const sums = list.length ? `<div class="dr-sums">
            ${summaryTable('По направлениям', groupBy(list, r => r.direction || r.code), 'Направление')}
            ${summaryTable('По типу решения', groupBy(list, r => KIND[r.status] || r.status), 'Решение')}
            ${summaryTable('За сколько дней до вылета принято решение', leadGroups, 'Срок')}
        </div>` : '';
        return `
            <section class="rp-card dr-card">
                <div class="rp-card-head">
                    <h3 class="rp-card-title">Журнал решений</h3>
                    ${canExport() ? `${moneyAvailable() && DecisionMoney.canFreeze() && list.length ? '<button type="button" class="filter-btn" data-dr-recompute="1" title="Пересчитать зафиксированные итоги с текущими параметрами">Пересчитать</button>' : ''}<button type="button" class="btn-primary rp-btn" id="dr-export"${list.length ? '' : ' disabled'}>В Excel</button>` : ''}
                </div>
                <details class="dr-help"><summary>Как считается</summary>
                    <p><strong>Что считаем.</strong> Решение — это когда вы повысили или снизили тариф. Мы смотрим, сколько денег рейс собрал после решения, и сравниваем с тем, сколько он собрал бы, если бы тариф не трогали. Разница — результат в рублях.</p>
                    <p><strong>Откуда берём «что было бы».</strong> Берём похожие вылеты: тот же рейс, тот же день недели, ближайшие недели${nbDays > 0 ? `, а также вылеты этого рейса в соседние дни (до ${daysWord(nbDays, ['дня', 'дней', 'дней'])} в стороны) — их билеты пересчитываем на день недели нашего вылета` : ''}. Свежие вылеты весят больше старых, а если все последние вылеты продавали выше обычного, ожидание поднимаем. Смотрим, сколько билетов они продавали в такие же дни до вылета, и умножаем на прежний тариф.</p>
                    <p><strong>Из чего состоит результат.</strong> Из двух частей: «из-за цены» — сколько дала смена тарифа на ожидаемые билеты, «из-за количества» — всё остальное: продали больше или меньше билетов, чем обычно. Вместе они дают весь результат.</p>
                    <p><strong>За какой срок.</strong> Смотрим ${daysWord(moneyWindow(), ['день', 'дня', 'дней'])} после решения (день самого решения не берём). Если продаж мало, срок растёт, но не больше ${daysWord(wMax, ['дня', 'дней', 'дней'])}. Итог записывается на следующий день после срока и дальше не меняется. У повышения через ${daysWord(moneyWindow(), ['день', 'дня', 'дней'])} видна только предварительная цифра, окончательная будет после вылета: при дорогих билетах люди покупают позже.</p>
                    <p><strong>Что значат метки.</strong></p>
                    <ul>
                        <li><strong>ПОМОГЛО / НАВРЕДИЛО</strong> — результат почти точно не случайный. «Помогло» подтверждаем строже, чем «навредило»: на вылетах без решений случайные плюсы встречаются чаще случайных минусов.</li>
                        <li><strong>СКОРЕЕ ПОМОГЛО / СКОРЕЕ НАВРЕДИЛО</strong> — вероятность не меньше ${leanP}%, но гарантии нет.</li>
                        <li><strong>ЧУТЬ ПОМОГЛО / ЧУТЬ НАВРЕДИЛО</strong> — разница есть, но небольшая.</li>
                        <li><strong>БЕЗ ЭФФЕКТА</strong> — разница меньше порога: ${minPct}% выручки или ${minRub} ₽ (берётся большее). Ею можно пренебречь.</li>
                        <li><strong>МАЛО ДАННЫХ</strong> — оценить нельзя или вывода нет.</li>
                        <li><strong>ЖДЁМ ИТОГА</strong> — срок после решения ещё не прошёл.</li>
                    </ul>
                    <p><strong>Диапазон.</strong> Рядом с суммой показан диапазон: настоящий результат лежит в нём с вероятностью около ${confPct(pv('MONEY_NOISE_Z', 1.9))}%. Если в диапазон входит ноль, твёрдого вывода нет.</p>
                    <p><strong>Доверие.</strong> Высокое — похожих вылетов много и данных достаточно. Низкое — данных мало: рядом праздник, решение за 1–2 дня до вылета, мало похожих вылетов или до решения не было продаж. Такие решения тоже считаются, но им верим меньше, поэтому они стоят отдельно от твёрдых.</p>
                    <p><strong>Несколько решений подряд.</strong> Если по одному вылету решений несколько, у каждого свой срок: от него до следующего решения. Одни и те же дни не считаются дважды. Сроки получаются короткие, поэтому доверие ниже.</p>
                    <p><strong>Когда не считаем.</strong> Только если не из чего: доп. рейс или чартер, решение в день вылета, нет билетов этого вылета в данных, нет похожих вылетов.</p>
                    <p><strong>Что важно помнить.</strong></p>
                    <ul>
                        <li>Считаем все билеты с тарифом больше нуля: взрослые, детские, групповые. Деньги берём по тому, сколько заплатили. Нулевые тарифы не считаем.</li>
                        <li>Повышение цены не приводит новых покупателей: если продали больше обычного, лишние билеты повышению в плюс не идут, считаем по факту. Если продали меньше обычного, нехватка идёт в минус решению. Для снижения наоборот: прибавка билетов идёт в плюс, а нехватку билетов снижению в вину не ставим.</li>
                        <li>Погоду, конкурентов и события мы не видим, поэтому это оценка, а не точный факт.</li>
                        <li>На вылетах без решений метод давал небольшой сдвиг: тариф сам меняется ближе к вылету, а обычные продажи оцениваются с перекосом. Из результата вычитается поправка по таким вылетам (настраивается в «Параметрах»).</li>
                        <li>Одному решению верить меньше, чем сумме многих, поэтому смотрите «Общий итог» вверху. Он считается по всем оценённым решениям, а рядом отдельно показана сумма только по твёрдым.</li>
                    </ul>
                </details>
                ${toolbar}
                ${summary}
                ${reasonNote}
                ${DecisionsViz.howToRead('<span class="dp-chip dp-wait">ЖДЁМ ИТОГА</span> срок после решения не прошёл')}
                ${dash}
                ${body ? `<div class="dr-list-title">Все решения <span class="rp-muted">· ${list.length}</span></div>${DecisionsViz.toneBar(cards, toneFilter, 'dp-tone')}${DecisionsViz.list(cards, toneFilter)}<details class="dp-more"><summary>Сводки и подробная таблица</summary>${sums}<div class="dv-grid">${DecisionsViz.columns('Эффект по неделям решений', weekItems, 'Неделя начинается с даты внизу; только определённые решения')}</div><div class="rp-scroll"><table class="rp-table dr-table">
                    <thead><tr><th>Решение</th><th>Рейс</th><th>Вылет</th><th>Что</th><th title="Класс до → после (из отметки или по продажам)">Класс</th><th title="Билетов в окне после решения / сколько ожидали">Билетов</th><th>Ср. тариф до → после</th><th title="Выручка в окне минус ожидаемая по прежней цене; в строке — диапазон ≈90%">Эффект</th><th>Объём / цена</th><th>Итог</th></tr></thead>
                    <tbody>${body}</tbody></table></div></details>` : '<p class="rp-note">За период решений «снижение/повышение» нет.</p>'}
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
            byLead: groupBy(list, leadOf, leadSort),
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
                    grade: fin ? (m.grade === 'A' ? 'высокое' : (m.grade === 'B' ? 'среднее' : 'низкое')) : '', clsBefore: m ? (m.clsBefore || '') : '', clsAfter: m ? (m.clsAfter || '') : '',
                    expAll: m && m.expAll != null ? m.expAll : '', factAll: m && m.factAll != null ? m.factAll : '', analogs: m && m.k != null ? m.k : '',
                    method: m && m.v != null ? m.v : '', verdict: st.short, text: (st.reason ? (st.reason.indexOf(st.text) === 0 ? st.reason : st.text + ': ' + st.reason) : st.text) + (m && m.flags && m.flags.length ? ' [' + m.flags.join('; ') + ']' : '')
                };
            })
        };
    }

    function moneyClick(btn, rerender) {
        if (btn.dataset.dpTone != null) { toneFilter = btn.dataset.dpTone; rerender(); return true; }
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
