// Сверка продаж с загрузкой: билеты из файла продаж — к тому вылету, на котором люди реально летят.
// Файл продаж оставляет билет на старом номере и старой дате, когда рейс переносят или дают ему доп. номер:
// тогда у вылета загрузка 40, а продаж 2. Здесь (после загрузки данных и после снимка):
//  1. один день, основной и доп. номера рейса: лишние билеты (сверх загрузки номера и с номеров, которые
//     в этот день не летят) — на номер, где загрузка больше продаж, не больше, чем там не хватает;
//  2. перенос даты: билеты с даты, на которой этого рейса нет, — на ближайший вылет этого рейса (±7 дней),
//     где загрузка больше продаж, но не больше, чем там не хватает.
// У перенесённого билета остаётся пометка moved — «дд.мм.гггг|KV-…», где он был в файле. Каждый запуск
// сначала возвращает билеты на места из файла и считает заново — результат одинаков на всех ПК.
// Групповая бронь переносится целиком.
// По ней строится отчёт «Сверка» (reports-view → SalesReconcile.report).
window.SalesReconcile = (function () {
    const MOVE_DAYS = 7;
    let lastRun = { moved: 0, at: 0 };

    function loadsByDeparture() {
        // 'дата|код' → загрузка (на многосегментном рейсе — наибольшая по участкам), и по базовому рейсу → даты.
        const load = new Map();
        const byBase = new Map();
        let minTs = Infinity;
        let maxTs = -Infinity;
        Object.keys(typeof groupedData !== 'undefined' && groupedData ? groupedData : {}).forEach(base => {
            (groupedData[base] || []).forEach(row => {
                const code = cleanFlight(row[0]);
                const date = row[1];
                if (!code || !date) return;
                const key = date + '|' + code;
                const ts = parseLocalDate(date);
                if (ts) { minTs = Math.min(minTs, ts.getTime()); maxTs = Math.max(maxTs, ts.getTime()); }
                const v = getSoldFromRow(row);
                if (!load.has(key) || v > load.get(key)) load.set(key, v);
                if (!byBase.has(base)) byBase.set(base, new Map());
                const dates = byBase.get(base);
                if (!dates.has(date)) dates.set(date, new Set());
                dates.get(date).add(code);
            });
        });
        return { load, byBase, minTs, maxTs };
    }

    // Равномерно выбрать n билетов из списка (сохраняет форму кривой продаж).
    function takeEvenly(list, n) {
        if (n <= 0) return [];
        if (n >= list.length) return list.splice(0, list.length);
        const step = list.length / n;
        const idx = [];
        for (let i = 0; i < n; i++) idx.push(Math.min(list.length - 1, Math.floor(i * step + step / 2)));
        const picked = [];
        [...new Set(idx)].sort((a, b) => b - a).forEach(i => picked.push(list.splice(i, 1)[0]));
        return picked;
    }

    // Порядок билетов не зависит от того, в каком порядке они лежат в списке: по дате сделки, затем по тарифу.
    // Одинаковые по этим полям билеты для расчётов неотличимы — результат одинаков на всех ПК.
    function byDeal(a, b) {
        const da = parseLocalDate(a.dealDate);
        const db = parseLocalDate(b.dealDate);
        return ((da ? da.getTime() : 0) - (db ? db.getTime() : 0))
            || ((Number(a.fare) || 0) - (Number(b.fare) || 0))
            || ((Number(a.adjustedFare) || 0) - (Number(b.adjustedFare) || 0))
            || String(a.basicFareStr || '').localeCompare(String(b.basicFareStr || ''))
            || ((Number(a.grp) || 0) - (Number(b.grp) || 0))
            || String(a.grpId == null ? '' : a.grpId).localeCompare(String(b.grpId == null ? '' : b.grpId));
    }

    // Билеты одного заказа (групповая бронь) переносятся вместе: «единица» — заказ или одиночный билет.
    function unitsOf(list) {
        const units = [];
        const byGrp = new Map();
        list.forEach(s => {
            if (s && Number(s.grp) > 1 && s.grpId != null) {
                const g = String(s.grpId);
                if (!byGrp.has(g)) { const u = []; byGrp.set(g, u); units.push(u); }
                byGrp.get(g).push(s);
            } else units.push([s]);
        });
        return units;
    }

    // Выбрать из единиц не больше n билетов: сначала одиночные (равномерно — сохраняет форму кривой),
    // потом целые заказы, которые помещаются. Выбранное удаляется из units.
    function takeUnits(units, n, ok) {
        if (n <= 0 || !units.length) return [];
        const fits = ok ? units.filter(u => u.every(ok)) : units.slice();
        const singles = fits.filter(u => u.length === 1);
        const picked = takeEvenly(singles, Math.min(n, singles.length));
        let left = n - picked.length;
        fits.filter(u => u.length > 1).forEach(u => {
            if (u.length <= left) { picked.push(u); left -= u.length; }
        });
        const set = new Set(picked);
        for (let i = units.length - 1; i >= 0; i--) if (set.has(units[i])) units.splice(i, 1);
        return picked;
    }

    function count(units) {
        return units.reduce((a, u) => a + u.length, 0);
    }

    // Перенос: пометка moved — откуда; номер заказа — с префиксом исходного вылета, чтобы не совпасть
    // с заказом №1 на новом месте.
    function put(details, key, s, fromKey) {
        if (fromKey !== key && !s.moved) {
            s.moved = fromKey;
            if (s.grpId != null) s.grpId = fromKey + '#' + s.grpId;
        }
        (details[key] || (details[key] = [])).push(s);
    }

    // Вернуть все ранее перенесённые билеты на места из файла: расчёт всегда с нуля, поэтому повторный
    // запуск (снимок на другом ПК, правка справочника рейсов) даёт тот же результат.
    function restore(details) {
        let n = 0;
        Object.keys(details).forEach(k => {
            const list = details[k];
            if (!Array.isArray(list) || !list.some(s => s && s.moved)) return;
            const keep = [];
            list.forEach(s => {
                if (!s || !s.moved) { keep.push(s); return; }
                const from = s.moved;
                delete s.moved;
                const pre = from + '#';
                if (typeof s.grpId === 'string' && s.grpId.startsWith(pre)) {
                    const id = s.grpId.slice(pre.length);
                    s.grpId = /^\d+$/.test(id) ? parseInt(id, 10) : id;
                }
                if (from === k) { keep.push(s); return; }
                (details[from] || (details[from] = [])).push(s);
                n++;
            });
            if (keep.length) details[k] = keep;
            else delete details[k];
        });
        if (n && typeof FlightInsights !== 'undefined') {
            // Номера заказов по PNR — заново по вылетам, куда билеты вернулись.
            const withPnr = {};
            Object.keys(details).forEach(k => { if ((details[k] || []).some(s => s && s.pnr)) withPnr[k] = details[k]; });
            FlightInsights.annotateGroups(withPnr);
        }
        return n;
    }

    // Пересобрать salesDetails. Возвращает > 0, если что-то поменялось (переносы или их отмена).
    function run(details) {
        if (!details) return 0;
        const restored = restore(details);
        if (typeof groupedData === 'undefined' || !Object.keys(groupedData || {}).length) {
            lastRun = { moved: 0, at: Date.now() };
            return restored;
        }
        const { load, byBase, minTs, maxTs } = loadsByDeparture();
        let moved = 0;
        const sortedUnits = (key) => unitsOf((details[key] || []).slice().sort(byDeal));
        const store = (key, units) => {
            const list = [].concat(...units).sort(byDeal);
            if (list.length) details[key] = list;
            else delete details[key];
        };

        // Ключи продаж по базовому рейсу и дате.
        const salesByBaseDate = new Map();
        Object.keys(details).forEach(k => {
            const i = k.lastIndexOf('|');
            if (i < 0) return;
            const date = k.slice(0, i);
            const code = k.slice(i + 1);
            const bk = getBaseFlight(code) + '|' + date;
            if (!salesByBaseDate.has(bk)) salesByBaseDate.set(bk, []);
            salesByBaseDate.get(bk).push(code);
        });

        // 1. Один день, несколько номеров рейса: лишнее (сверх загрузки и с нелетящих номеров) —
        //    туда, где загрузка больше продаж, не больше нехватки. Номер, где продажи совпадают
        //    с загрузкой, не трогается.
        salesByBaseDate.forEach((codesWithSales, bk) => {
            const i = bk.indexOf('|');
            const base = bk.slice(0, i);
            const date = bk.slice(i + 1);
            const flying = byBase.get(base) && byBase.get(base).get(date);
            if (!flying || !flying.size) return;
            const codes = [...new Set([...flying, ...codesWithSales])].sort();
            if (codes.length < 2) return;
            const loadOf = (c) => load.get(date + '|' + c) || 0;
            const salesOf = (c) => (details[date + '|' + c] || []).length;
            const deficits = codes.filter(c => flying.has(c) && loadOf(c) > salesOf(c))
                .sort((a, b) => (loadOf(b) - salesOf(b)) - (loadOf(a) - salesOf(a)) || a.localeCompare(b));
            if (!deficits.length) return;
            const sources = codes.filter(c => salesOf(c) && (!flying.has(c) || salesOf(c) > loadOf(c)));
            if (!sources.length) return;
            // Котёл: сначала нелетящие номера, затем излишки.
            const pool = [];
            sources.sort((a, b) => (flying.has(a) - flying.has(b)) || a.localeCompare(b)).forEach(c => {
                const key = date + '|' + c;
                const units = sortedUnits(key);
                const extra = flying.has(c) ? takeUnits(units, salesOf(c) - loadOf(c)) : units.splice(0, units.length);
                store(key, units);
                extra.forEach(u => pool.push({ u, from: key }));
            });
            deficits.forEach(c => {
                const key = date + '|' + c;
                const need = loadOf(c) - salesOf(c);
                const units = pool.map(p => p.u);
                const got = new Set(takeUnits(units, need));
                for (let j = pool.length - 1; j >= 0; j--) {
                    if (!got.has(pool[j].u)) continue;
                    pool[j].u.forEach(s => { put(details, key, s, pool[j].from); moved++; });
                    pool.splice(j, 1);
                }
                if (details[key]) details[key].sort(byDeal);
            });
            // Не хватило места — остаются где были.
            pool.forEach(p => p.u.forEach(s => put(details, p.from, s, p.from)));
            pool.forEach(p => details[p.from].sort(byDeal));
        });

        // 2. Перенос даты: билеты на дату, где рейса нет, — на ближайший вылет с нехваткой продаж.
        Object.keys(details).sort().forEach(k => {
            const i = k.lastIndexOf('|');
            if (i < 0) return;
            const date = k.slice(0, i);
            const code = k.slice(i + 1);
            const dates = byBase.get(getBaseFlight(code));
            if (!dates || dates.has(date)) return;
            const d0 = parseLocalDate(date);
            // Дата вне файла загрузки (старые вылеты, дальние даты) — это не перенос, а просто нет данных загрузки.
            if (!d0 || d0.getTime() < minTs || d0.getTime() > maxTs) return;
            const targets = [];
            dates.forEach((codes, dt) => {
                const d = parseLocalDate(dt);
                if (!d) return;
                const gap = Math.round(Math.abs(d - d0) / 86400000);
                if (gap > MOVE_DAYS) return;
                codes.forEach(c => {
                    const tk = dt + '|' + c;
                    const deficit = (load.get(tk) || 0) - (details[tk] || []).length;
                    if (deficit > 0) targets.push({ tk, gap, deficit, ts: d.getTime(), later: d >= d0 });
                });
            });
            if (!targets.length) return;
            // Ближайший вылет; при равном расстоянии — более поздний (рейсы чаще переносят вперёд).
            targets.sort((a, b) => a.gap - b.gap || (b.later - a.later) || b.deficit - a.deficit || a.tk.localeCompare(b.tk));
            const units = sortedUnits(k);
            targets.forEach(t => {
                if (!units.length) return;
                const deficit = (load.get(t.tk) || 0) - (details[t.tk] || []).length;
                // Билет не может лететь вылетом, который улетел раньше, чем билет купили.
                const ok = (s) => { const dd = parseLocalDate(s.dealDate); return !dd || dd.getTime() <= t.ts; };
                takeUnits(units, deficit, ok).forEach(u => u.forEach(s => { put(details, t.tk, s, k); moved++; }));
                if (details[t.tk]) details[t.tk].sort(byDeal);
            });
            store(k, units);
        });

        lastRun = { moved, at: Date.now() };
        return moved + restored;
    }

    // Отчёт: будущие вылеты, где продажи и загрузка расходятся или билеты пришлось перенести.
    function report() {
        const details = typeof salesDetails !== 'undefined' ? salesDetails : {};
        const { load } = loadsByDeparture();
        const movedIn = new Map();
        const movedOut = new Map();
        Object.keys(details).forEach(k => (details[k] || []).forEach(s => {
            if (!s.moved || s.moved === k) return;
            if (!movedIn.has(k)) movedIn.set(k, new Map());
            const m = movedIn.get(k);
            m.set(s.moved, (m.get(s.moved) || 0) + 1);
            movedOut.set(s.moved, (movedOut.get(s.moved) || 0) + 1);
        }));
        const rows = [];
        let checked = 0;
        let fixedFlights = 0;
        let fixedTickets = 0;
        load.forEach((ld, key) => {
            const i = key.lastIndexOf('|');
            const date = key.slice(0, i);
            const code = key.slice(i + 1);
            const dtd = typeof getDaysUntil === 'function' ? getDaysUntil(date) : null;
            if (dtd == null || dtd < 0) return;
            checked++;
            const now = (details[key] || []).length;
            const inMap = movedIn.get(key);
            const inN = inMap ? [...inMap.values()].reduce((a, b) => a + b, 0) : 0;
            const outN = movedOut.get(key) || 0;
            const orig = now - inN + outN;
            const diff = ld - now;
            const big = Math.abs(diff) >= Math.max(3, Math.round(ld * 0.1));
            if (inN) { fixedFlights++; fixedTickets += inN; }
            if (!big && !inN && !outN) return;
            const sources = inMap ? [...inMap.entries()].map(([from, n]) => {
                const j = from.lastIndexOf('|');
                const fd = from.slice(0, j);
                const fc = from.slice(j + 1);
                return { from, n, sameDay: fd === date, text: fd === date ? `${n} с ${fc}` : `${n} с ${fd.slice(0, 5)}${fc !== code ? ' ' + fc : ''}` };
            }) : [];
            let reason = '';
            if (sources.some(s => s.sameDay)) reason = 'доп. номер: билеты были записаны на другой номер рейса';
            else if (sources.length) reason = 'перенос: билеты были на другой дате';
            if (outN && !reason) reason = 'отдал билеты другому номеру или дате';
            if (big) {
                const tail = diff > 0
                    ? 'в продажах меньше загрузки: билеты не найдены в файле (другой номер, дата или канал продаж)'
                    : 'в продажах больше загрузки: незакрытые возвраты или обмены';
                reason = reason ? reason + '; ' + tail : tail;
            }
            rows.push({ key, date, code, dtd, load: ld, orig, now, diff, inN, outN, sources, reason, big });
        });
        rows.sort((a, b) => (Math.abs(b.diff) - Math.abs(a.diff)) || a.dtd - b.dtd);
        return { rows, checked, fixedFlights, fixedTickets, divergent: rows.filter(r => r.big).length };
    }

    let onlyDivergent = false;

    function esc(v) {
        return typeof escHtml === 'function' ? escHtml(v) : String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function canView() {
        if (typeof ProfileAuth === 'undefined') return true;
        return ProfileAuth.canAccessTab('table') || ProfileAuth.canAccessTab('pair') || ProfileAuth.canAccessTab('sales')
            || !!(ProfileAuth.getCurrentProfile() && ProfileAuth.getCurrentProfile().isAdmin);
    }

    function hasSales() {
        return typeof salesDetails !== 'undefined' && salesDetails && Object.keys(salesDetails).length > 0;
    }

    function badge() {
        return hasSales() ? report().divergent : 0;
    }

    // «Отчёты» → «Сверка».
    function html() {
        if (!hasSales()) return '<p class="rp-note">Нет файла продаж — сверять не с чем.</p>';
        const r = report();
        const list = onlyDivergent ? r.rows.filter(x => x.big) : r.rows;
        const body = list.map(x => `
            <tr class="${x.big ? 'rc-row-big' : ''}">
                <td class="rp-nowrap">${esc(x.date)}<div class="rp-muted">${x.dtd === 0 ? 'сегодня' : x.dtd + ' дн.'}</div></td>
                <td><button type="button" class="filter-btn rp-open" data-open-base="${esc(getBaseFlight(x.code))}" data-open-code="${esc(x.code)}" data-open-date="${esc(x.date)}">${esc(x.code)}</button></td>
                <td class="rp-left">${esc(typeof getFlightDirection === 'function' ? getFlightDirection(x.code) : '')}</td>
                <td><strong>${x.load}</strong></td>
                <td>${x.orig}</td>
                <td><strong>${x.now}</strong></td>
                <td class="rp-left">${x.sources.length ? esc(x.sources.map(s => s.text).join(', ')) : (x.outN ? `отдано ${x.outN}` : '—')}</td>
                <td class="${x.big ? (x.diff > 0 ? 'dr-neg' : 'rc-more') : ''}">${x.diff > 0 ? '+' : ''}${x.diff}</td>
                <td class="rp-left">${esc(x.reason)}</td>
            </tr>`).join('');
        return `
            <section class="rp-card">
                <div class="rp-card-head"><h3 class="rp-card-title">Сверка продаж и загрузки</h3></div>
                <p class="rp-card-text">Будущие вылеты. <strong>Загрузка</strong> — из «загрузка таб», ей сайт верит. <strong>В файле</strong> — сколько билетов файл продаж
                    записал на этот номер и дату. Когда рейс переносят или дают доп. номер, файл оставляет билеты на старом месте — сайт переносит их сам:
                    в один день — между основным и доп. номером по загрузке, при переносе даты — на ближайший вылет этого рейса (±7 дней), где их не хватает.
                    <strong>После сверки</strong> — с чем считаются нормы, подсказки и прогноз. Красным — где расхождение осталось: билеты не нашлись в файле.</p>
                <div class="ref-toolbar">
                    <label class="ref-check-inline"><input type="checkbox" id="rc-only"${onlyDivergent ? ' checked' : ''}> только где осталось расхождение</label>
                    <span class="rp-muted">Вылетов проверено: ${r.checked} · исправлено автоматически: ${r.fixedFlights} (билетов перенесено: ${r.fixedTickets}) · осталось расхождение: ${r.divergent}</span>
                </div>
                ${body ? `<div class="rp-scroll"><table class="rp-table dr-table">
                    <thead><tr><th>Вылет</th><th>Рейс</th><th>Направление</th><th>Загрузка</th><th title="Сколько билетов файл продаж записал на этот номер и дату">В файле</th><th title="После переноса билетов">После сверки</th><th>Перенесено</th><th title="Загрузка − продажи после сверки">Разница</th><th>Причина</th></tr></thead>
                    <tbody>${body}</tbody></table></div>` : '<p class="rp-note">Расхождений нет: продажи совпадают с загрузкой.</p>'}
            </section>`;
    }

    function handleChange(target, rerender) {
        if (target.id !== 'rc-only') return false;
        onlyDivergent = !!target.checked;
        rerender();
        return true;
    }

    return { run, report, html, handleChange, canView, badge, lastRun: () => lastRun };
})();
