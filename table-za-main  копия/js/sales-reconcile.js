// сверка продаж с загрузкой: билеты переносим на вылет, где люди реально летят (файл держит старый номер и дату)
// 1) один день, основной и доп. номера: лишние билеты туда, где продано меньше загрузки; 2) перенос даты - на ближайший вылет ±7 дней
// каждый запуск с нуля от файла, поэтому результат одинаков на всех ПК; групповая бронь едет целиком; отчёт Сверка - reports-view
window.SalesReconcile = (function () {
    let lastRun = { moved: 0, at: 0 };
    let runs = 0;
    let movedFromKeys = new Set();   // 'дата|код', откуда уехали билеты (задержанный рейс помнит исходную дату)

    function loadsByDeparture() {
        // 'дата|код' -> загрузка (на многосегментном - максимум по участкам); по базовому рейсу - даты
        const load = new Map();
        const byBase = new Map();
        let minTs = Infinity;
        let maxTs = -Infinity;
        Object.keys(typeof groupedData !== 'undefined' && groupedData ? groupedData : {}).forEach(base => {
            (groupedData[base] || []).forEach(row => {
                if (row.segKey) return;   // участок доп. посадки в чужом рейсе: свои билеты по откуда / куда
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

    // равномерно берём n билетов из списка, форма кривой сохраняется
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

    // порядок: дата сделки, потом тариф, не зависит от порядка в списке
    // одинаковые по этим полям билеты неотличимы, результат одинаков на всех ПК
    function byDeal(a, b) {
        const da = parseLocalDate(a.dealDate);
        const db = parseLocalDate(b.dealDate);
        return ((da ? da.getTime() : 0) - (db ? db.getTime() : 0))
            || ((Number(a.fare) || 0) - (Number(b.fare) || 0))
            || ((Number(a.adjustedFare) || 0) - (Number(b.adjustedFare) || 0))
            || String(a.basicFareStr || '').localeCompare(String(b.basicFareStr || ''))
            || ((Number(a.grp) || 0) - (Number(b.grp) || 0))
            || String(a.grpId == null ? '' : a.grpId).localeCompare(String(b.grpId == null ? '' : b.grpId))
            // последним номер билета и заказа (видны не всем), тоже одинаково на всех ПК
            || String(a.bsonum || '').localeCompare(String(b.bsonum || ''))
            || String(a.pnr || '').localeCompare(String(b.pnr || ''));
    }

    // билеты одного заказа едут вместе; единица - заказ или одиночный билет
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

    // берём не больше n: сначала одиночные (равномерно, форма кривой), потом целые заказы, которые помещаются
    // выбранное удаляем из units
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

    // пометка moved - откуда; номер заказа с префиксом исходного вылета, чтобы не совпал с заказом №1 на новом месте
    function put(details, key, s, fromKey) {
        if (fromKey !== key && !s.moved) {
            s.moved = fromKey;
            movedFromKeys.add(fromKey);
            if (s.grpId != null) s.grpId = fromKey + '#' + s.grpId;
        }
        (details[key] || (details[key] = [])).push(s);
    }

    // вернуть перенесённые билеты на места из файла, расчёт всегда с нуля
    // поэтому повторный запуск (другой ПК, правка справочника рейсов) даёт тот же результат
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
            // номера заказов по PNR заново по вылетам, куда вернулись билеты
            const withPnr = {};
            Object.keys(details).forEach(k => { if ((details[k] || []).some(s => s && s.pnr)) withPnr[k] = details[k]; });
            FlightInsights.annotateGroups(withPnr);
        }
        return n;
    }

    // пересобираем salesDetails; > 0, если что-то поменялось
    function run(details) {
        if (!details) return 0;
        runs++;
        movedFromKeys = new Set();
        const restored = restore(details)
            + (typeof SegmentSplit !== 'undefined' ? SegmentSplit.unsplitSales(details) : 0);
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

        // 1. один день, несколько номеров: лишнее (сверх загрузки и с нелетящих номеров) - туда, где нехватка
        // не больше нехватки; номер, где продажи равны загрузке, не трогаем
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
            // котёл: сначала нелетящие номера, потом излишки
            const pool = [];
            sources.sort((a, b) => (flying.has(a) - flying.has(b)) || a.localeCompare(b)).forEach(c => {
                const key = date + '|' + c;
                const units = sortedUnits(key);
                const extra = flying.has(c) ? takeUnits(units, salesOf(c) - loadOf(c)) : units.splice(0, units.length);
                store(key, units);
                extra.forEach(u => pool.push({ u, from: key, orphan: !flying.has(c) }));
            });
            deficits.forEach(c => {
                const key = date + '|' + c;
                let need = loadOf(c) - salesOf(c);
                // сначала билеты нелетящих номеров (им больше некуда), потом излишки
                [true, false].forEach(orphan => {
                    if (need <= 0) return;
                    const part = pool.filter(p => p.orphan === orphan);
                    const got = new Set(takeUnits(part.map(p => p.u), need));
                    for (let j = pool.length - 1; j >= 0; j--) {
                        if (!got.has(pool[j].u)) continue;
                        pool[j].u.forEach(s => { put(details, key, s, pool[j].from); moved++; need--; });
                        pool.splice(j, 1);
                    }
                });
                if (details[key]) details[key].sort(byDeal);
            });
            // не хватило места - остаются на месте
            pool.forEach(p => p.u.forEach(s => put(details, p.from, s, p.from)));
            pool.forEach(p => details[p.from].sort(byDeal));
        });

        // 2. перенос даты: билеты с даты, где рейса нет, на ближайший вылет с нехваткой
        // даты сравниваем как даты, а не как текст дд.мм.гггг
        const keyTs = (k) => { const d = parseLocalDate(k.slice(0, k.lastIndexOf('|'))); return d ? d.getTime() : 0; };
        Object.keys(details).sort((a, b) => keyTs(a) - keyTs(b) || a.localeCompare(b)).forEach(k => {
            const i = k.lastIndexOf('|');
            if (i < 0) return;
            const date = k.slice(0, i);
            const code = k.slice(i + 1);
            const dates = byBase.get(getBaseFlight(code));
            if (!dates || dates.has(date)) return;
            const d0 = parseLocalDate(date);
            // дата вне файла загрузки - не перенос, просто нет данных загрузки
            if (!d0 || d0.getTime() < minTs || d0.getTime() > maxTs) return;
            const targets = [];
            dates.forEach((codes, dt) => {
                const d = parseLocalDate(dt);
                if (!d) return;
                const gap = Math.round(Math.abs(d - d0) / 86400000);
                if (gap > PV.RECONCILE_MOVE_DAYS) return;
                codes.forEach(c => {
                    const tk = dt + '|' + c;
                    const deficit = (load.get(tk) || 0) - (details[tk] || []).length;
                    // задержанный рейс: билеты исходной даты едут на его новую дату
                    const pref = typeof DelayedFlights !== 'undefined' && DelayedFlights.movedTo(code, date) === dt && code === c;
                    if (deficit > 0) targets.push({ tk, gap, deficit, ts: d.getTime(), later: d >= d0, pref });
                });
            });
            if (!targets.length) return;
            // ближайший вылет; при равном расстоянии более поздний (рейсы чаще переносят вперёд)
            targets.sort((a, b) => (b.pref - a.pref) || a.gap - b.gap || (b.later - a.later) || b.deficit - a.deficit || a.tk.localeCompare(b.tk));
            const units = sortedUnits(k);
            targets.forEach(t => {
                if (!units.length) return;
                const deficit = (load.get(t.tk) || 0) - (details[t.tk] || []).length;
                // билет не может лететь вылетом раньше даты покупки
                const ok = (s) => { const dd = parseLocalDate(s.dealDate); return !dd || dd.getTime() <= t.ts; };
                takeUnits(units, deficit, ok).forEach(u => u.forEach(s => { put(details, t.tk, s, k); moved++; }));
                if (details[t.tk]) details[t.tk].sort(byDeal);
            });
            store(k, units);
        });

        // билеты участков доп. посадки - к рейсу, куда ушёл участок (segment-split.js)
        if (typeof SegmentSplit !== 'undefined') moved += SegmentSplit.splitSales(details);
        lastRun = { moved, at: Date.now() };
        return moved + restored;
    }

    function wasMovedFrom(key) { return movedFromKeys.has(key); }

    // отчёт: будущие вылеты, где продажи и загрузка расходятся или билеты перенесли
    let reportMemo = { sig: '', v: null };

    function report() {
        const details = typeof salesDetails !== 'undefined' ? salesDetails : {};
        // пересчёт только при новых данных: Отчёты спрашивают отчёт на каждой перерисовке
        const sig = `${typeof dataEpoch === 'number' ? dataEpoch : 0}|${typeof getTodayDate === 'function' ? getTodayDate() : ''}|${lastRun.at}`;
        if (reportMemo.sig === sig && reportMemo.details === details) return reportMemo.v;
        const v = buildReport(details);
        reportMemo = { sig, details, v };
        return v;
    }

    function buildReport(details) {
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

    function esc(v) { return escHtml(v); }

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

    // Отчёты / Проверки: плитки в общий ряд сверху (tileList), блок Расхождения - card()
    function tileList() {
        if (!hasSales()) return [];
        const r = report();
        const less = r.rows.filter(x => x.big && x.diff > 0).length;
        const more = r.rows.filter(x => x.big && x.diff < 0).length;
        return [
            { label: 'Сверка: расхождений осталось', value: String(r.divergent), tone: r.divergent ? 'bad' : '' },
            { label: 'Сверка: продаж меньше загрузки', value: String(less), sub: 'билеты не найдены в файле', tone: less ? 'bad' : '' },
            { label: 'Сверка: продаж больше загрузки', value: String(more), sub: 'незакрытые возвраты или обмены', tone: more ? 'warn' : '' }
        ];
    }

    function card() {
        if (!hasSales()) return '<section class="rp-card" id="rp-reconcile"><p class="rp-note">Нет файла продаж — сверять не с чем.</p></section>';
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
                <td class="${x.big ? (x.diff > 0 ? 'dr-neg' : 'rc-more') : ''}">${x.diff > 0 ? '+' : ''}${String(x.diff).replace('-', '−')}</td>
                <td class="rp-left">${esc(x.reason)}</td>
            </tr>`).join('');
        const help = `Проверяем будущие вылеты. Загрузку берём из файла «загрузка таб». <strong>В файле</strong> — сколько билетов файл продаж
                    записал на этот номер и дату. Если рейс перенесли или дали доп. номер, файл оставляет билеты на старом месте.
                    Сайт переносит их сам: в один день — между основным и доп. номером, при переносе даты — на ближайший вылет рейса (±${typeof PV !== 'undefined' && PV.RECONCILE_MOVE_DAYS ? PV.RECONCILE_MOVE_DAYS : 7} дн.).
                    <strong>После сверки</strong> — с этими числами считаются нормы, подсказки и прогноз. Красным — где расхождение осталось.`;
        return `
            <section class="rp-card" id="rp-reconcile">
                ${ReportsView.head('Расхождения продаж и загрузки', help)}
                <p class="rp-card-text">Сверяем продажи с загрузкой на будущие вылеты. Красным — где расхождение осталось.</p>
                <div class="ref-toolbar">
                    <label class="rp-filter"><input type="checkbox" id="rc-only"${onlyDivergent ? ' checked' : ''}> только где осталось расхождение</label>
                    <span class="rp-muted">Вылетов проверено: ${r.checked} · в таблице: ${list.length} · исправлено автоматически: ${r.fixedFlights} (билетов перенесено: ${r.fixedTickets})</span>
                </div>
                ${body ? `<div class="rp-scroll"><table class="rp-table dr-table">
                    <thead><tr><th>Вылет</th><th>Рейс</th><th>Направление</th><th>Загрузка</th><th title="Сколько билетов файл продаж записал на этот номер и дату">В файле</th><th title="После переноса билетов">После сверки</th><th>Перенесено</th><th title="Загрузка − продажи после сверки">Разница</th><th>Причина</th></tr></thead>
                    <tbody>${body}</tbody></table></div>` : '<p class="rp-ok">Расхождений нет: продажи совпадают с загрузкой.</p>'}
            </section>`;
    }

    function handleChange(target, rerender) {
        if (target.id !== 'rc-only') return false;
        onlyDivergent = !!target.checked;
        rerender();
        return true;
    }

    return { run, card, tileList, handleChange, canView, badge, hasSales, wasMovedFrom, runCount: () => runs };
})();
