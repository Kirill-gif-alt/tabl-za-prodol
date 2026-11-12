// Вкладка «Вертолёты»: карточки по парам рейсов (туда / обратно), загрузка по отрезкам маршрута,
// двойной щелчок по строке — «маршрутный лист». Данные — js/heli-data.js (самолётные данные не затрагиваются).
// Стили — css/ux-heli.css; таблица рисуется теми же классами, что «Загрузка рейсов» (data-board-table).
window.HeliView = (function () {
    const UI_KEY = 'krasavia_heli_ui';
    const DOW = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
    const LEGEND = 'Плашки — сколько человек на каждом отрезке; жирная цифра с чертой — самый загруженный; двойной щелчок — подробности.';

    let ui = { base: 'all', q: '', hideFlew: false, day: false, attn: false };
    let uiLoaded = false;
    let open = new Set();          // раскрытые строки: «KV-781|25.11.2026»
    let renderSig = '';
    let pointsPromise = null;
    let searchTimer = null;

    function esc(s) { return escHtml(s); }
    function nm(code) { return HeliData.points.name(code); }
    function plural(n, a, b, c) { return typeof pluralRu === 'function' ? pluralRu(n, a, b, c) : (n % 10 === 1 && n % 100 !== 11 ? a : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? b : c)); }

    function loadUi() {
        if (uiLoaded) return;
        uiLoaded = true;
        try {
            const raw = JSON.parse(localStorage.getItem(UI_KEY) || 'null');
            if (raw && typeof raw === 'object') {
                if (typeof raw.base === 'string') ui.base = raw.base.slice(0, 12);
                if (typeof raw.q === 'string') ui.q = raw.q.slice(0, 80);
                ui.hideFlew = !!raw.hideFlew;
                ui.day = !!raw.day;
            }
        } catch (e) { /* без сохранённых настроек */ }
    }

    function saveUi() {
        try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch (e) { /* ignore */ }
    }

    function canEditPoints() {
        return typeof ProfileAuth !== 'undefined' && ProfileAuth.hasPermission('share_data');
    }

    function canExport() {
        return typeof ProfileAuth === 'undefined' || ProfileAuth.hasPermission('export_excel');
    }

    function todayTs() {
        const t = new Date();
        t.setHours(0, 0, 0, 0);
        return t.getTime();
    }

    // Закрыт, если закрыты все пары в файле загрузки или рейс (дата|номер) есть в файле закрытых рейсов.
    function isClosed(F) {
        return !!(F && (F.closedAll || (typeof closedFlights !== 'undefined' && closedFlights && closedFlights.has(F.key))));
    }

    // ---------- «Внимание»: вылеты завтра с пустым «лишним» отрезком ----------
    function tomorrowTs() {
        const d = new Date(todayTs());
        d.setDate(d.getDate() + 1);
        return d.getTime();
    }

    // Пара туда/обратно одной даты. Пустой (на борту 0) отрезок, кроме разворотных, — внимание.
    // Разворотные: последний отрезок «туда» и первый «обратно» (у рейса без остановок это и есть единственные отрезки):
    // внимание, только если пусты оба. Закрытые и неполные пары не считаются.
    function attnOf(e) {
        if (!e || !e.out || !e.in || e.ts !== tomorrowTs() || isClosed(e.out) || isClosed(e.in)) return null;
        const o = e.out.segs, i = e.in.segs;
        if (!o.length || !i.length) return null;
        const res = { out: new Set(), in: new Set(), turn: false };
        for (let k = 0; k < o.length - 1; k++) if (!o[k]) res.out.add(k);
        for (let k = 1; k < i.length; k++) if (!i[k]) res.in.add(k);
        if (!o[o.length - 1] && !i[0]) { res.turn = true; res.out.add(o.length - 1); res.in.add(0); }
        return res.out.size || res.in.size ? res : null;
    }

    // ---------- расчёт строки ----------
    function sideState(F, today) {
        if (!F) return null;
        return {
            F,
            flew: F.ts !== null && F.ts < today,
            closed: isClosed(F),
            full: !isClosed(F) && F.ts !== null && F.ts >= today && F.pct >= 100
        };
    }

    // ЗПК пары по местам: загрузка туда + обратно / места туда + обратно; закрытое направление не считается.
    function entryAvg(e) {
        let sold = 0, seats = 0;
        [e.out, e.in].forEach(F => {
            if (!F || isClosed(F) || !(F.seats > 0)) return;
            sold += F.max;
            seats += F.seats;
        });
        return seats > 0 ? Math.round(sold / seats * 100) : null;
    }

    function matchesQuery(card, q) {
        if (!q) return true;
        const hay = (card.outNo + ' ' + card.inNo + ' ' + card.outPts.concat(card.inPts).map(c => c + ' ' + nm(c)).join(' ')).toLowerCase();
        const tokens = q.toLowerCase().split(/[\s,;/|–—]+/).map(t => t.trim()).filter(t => t.length >= 2);
        return tokens.length ? tokens.every(t => hay.includes(t)) : hay.includes(q.toLowerCase());
    }

    function baseOptions(cards) {
        const seen = new Map();
        cards.forEach(c => { if (c.base) seen.set(HeliData.canon(c.base), c.base); });
        const order = ['ТРЛ', 'BKA', 'VAQ', 'HTG'].map(HeliData.canon);
        const list = [...seen.entries()].sort((a, b) => {
            const ia = order.indexOf(a[0]), ib = order.indexOf(b[0]);
            if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
            return nm(a[1]).localeCompare(nm(b[1]), 'ru');
        });
        return list.map(([, code]) => ({ code, name: nm(code) }));
    }

    function visibleEntries(card, today) {
        return card.entries.filter(e => {
            if (ui.attn && !attnOf(e)) return false;
            if (!ui.hideFlew) return true;
            const legs = [e.out, e.in].filter(Boolean);
            return legs.some(F => !(F.ts !== null && F.ts < today));
        });
    }

    // ---------- плашки ----------
    function plaqueHtml(cell, F, st, isMax, attn) {
        if (!cell) return '<span class="heli-pl heli-pl-na">–</span>';
        const v = cell.v;
        if (!v) return `<span class="heli-pl heli-pl-z${attn && attn.has(cell.seg) ? ' heli-pl-attn' : ''}">0</span>`;
        const p = F.seats > 0 ? Math.round(v / F.seats * 100) : 0;
        const t = Math.min(1, p / 60);
        let cls = 'heli-pl';
        if (st.closed || st.flew) cls += ' heli-pl-off';
        else if (cell.closed) cls += ' heli-pl-closed';
        else if (p >= 100) cls += ' heli-pl-full';
        else if (t >= 0.55) cls += ' heli-pl-hi';
        if (isMax) cls += ' heli-pl-mx';
        if (attn && attn.has(cell.seg)) cls += ' heli-pl-attn';
        return `<span class="${cls}" style="--t:${t.toFixed(2)}">${v}</span>`;
    }

    function plaquesCell(F, st, cellCls, attn) {
        let used = false;
        const items = F.cells.map(c => {
            const isMax = !!(c && c.first && !used && F.max > 0 && c.v === F.max && !c.closed);
            if (isMax) used = true;
            return plaqueHtml(c, F, st, isMax, attn);
        }).join('');
        return `<td class="${cellCls} heli-pl-cell"><div class="heli-pl-row">${items}</div></td>`;
    }

    // ---------- строка таблицы ----------
    function legCells(F, st, isOut, side, attn) {
        const block = isOut ? 'data-block-out' : 'data-block-in';
        const legCls = isOut ? 'pair-leg-out' : 'pair-leg-in';
        const nCols = side.cols;
        const emptyCell = (extra) => `<td class="${legCls} ${block} font-semibold data-leg-closed data-leg-none${extra || ''}">—</td>`;
        const cells = [];
        if (!F) {
            for (let i = 0; i < nCols; i++) {
                cells.push(emptyCell((!isOut && i === 0 ? ' pair-split-start' : '') + (isOut && i === nCols - 1 ? ' pair-split-end' : '')));
            }
            return cells.join('');
        }
        const base = `pair-leg-cell ${legCls} ${block} font-semibold${st.closed ? ' data-leg-closed' : ''}${!st.closed && st.flew ? ' data-leg-flew' : ''}${st.full ? ' data-block-zpk-full' : ''}`;
        const parts = [];
        parts.push(formatNum(F.seats));
        parts.push(`<b class="heli-zag">${formatNum(F.max)}</b>`);
        if (ui.day) {
            let dv = '—';
            if (HeliData.hasSales()) { const y = HeliData.flightSales(F).yesterday; dv = y ? formatNum(y) : '—'; }
            parts.push(dv);
        }
        parts.push(st.closed ? '<span class="closed-text">ЗАКРЫТ</span>' : `${F.pct}%`);
        const out = parts.map((html, i) => {
            const extra = (!isOut && i === 0 ? ' pair-split-start' : '') + (isOut && i === nCols - 1 && !side.multi ? ' pair-split-end' : '');
            return `<td class="${base}${extra}">${html}</td>`;
        });
        if (side.multi) out.push(plaquesCell(F, st, base + (isOut ? ' pair-split-end' : ''), attn));
        return out.join('');
    }

    function rowHtml(card, e, today, sideOut, sideIn, zebra) {
        const so = sideState(e.out, today), si = sideState(e.in, today);
        const bothClosed = !!(so && si && so.closed && si.closed);
        const bothFlew = (!so || so.flew) && (!si || si.flew) && !!(so || si);
        const avg = entryAvg(e);
        let rowCls = 'data-row-clickable heli-row ' + zebra;
        if (bothClosed) rowCls = 'data-row-clickable heli-row closed-flight data-row-both-closed';
        else if (bothFlew) rowCls = 'data-row-clickable heli-row flew-flight';
        const key = (e.out || e.in).no + '|' + e.date;
        const wd = e.ts !== null ? DOW[new Date(e.ts).getDay()] : '';
        const yellowAvg = !bothFlew && !bothClosed && avg !== null && avg >= 100;
        const avgHtml = bothClosed ? '<span class="closed-text">ЗАКРЫТ</span>' : (avg !== null ? `${avg}%` : '—');
        const isOpen = open.has(key);
        const at = attnOf(e);
        let html = `<tr class="${rowCls}${isOpen ? ' heli-row-open' : ''}" data-card="${card.key}" data-date="${esc(e.date)}" tabindex="0">
            <td class="col-date data-block-info font-semibold">${esc(e.date)}${at ? '<span class="heli-attn-tag">внимание</span>' : ''}</td>
            <td class="font-medium data-block-info">${wd}</td>
            ${legCells(e.out, so, true, sideOut, at && at.out)}${legCells(e.in, si, false, sideIn, at && at.in)}
            <td class="font-bold data-board-avg-cell data-block-avg pair-split-start${yellowAvg ? ' data-block-zpk-full' : ''}">${avgHtml}</td></tr>`;
        if (isOpen) html += sheetRow(card, e, sideOut.cols + sideIn.cols + 3);
        return html;
    }

    // ---------- маршрутный лист ----------
    function soldLine(F) {
        if (!HeliData.hasSales()) return '';
        const s = HeliData.flightSales(F);
        if (!s.total) return '';
        let h = `<div class="heli-sold">Продано билетов: сегодня <b>${s.today}</b> · вчера <b>${s.yesterday}</b> · за 7 дней <b>${s.d7}</b></div>`;
        if (s.yesterday) {
            const parts = [];
            F.pairs.forEach(p => {
                const b = s.byPair.get(p.key);
                if (b && b.yesterday) parts.push(`${esc(nm(F.pts[p.a - 1]))} → ${esc(nm(F.pts[p.b - 1]))} ${b.yesterday}`);
            });
            if (parts.length) h += `<div class="heli-sold heli-sold-pairs">Вчера по парам: ${parts.join(' · ')}</div>`;
        }
        return h;
    }

    function sheetCol(F, isOut, attn) {
        const cls = isOut ? 'heli-col-out' : 'heli-col-in';
        const title = `${isOut ? 'Туда' : 'Обратно'} · ${esc(F ? F.no : '')}${isClosed(F) ? ' · закрыт' : ''}`;
        if (!F) return `<div class="heli-col ${cls}"><div class="heli-col-title">${isOut ? 'Туда' : 'Обратно'}</div><div class="heli-col-none">Рейса в этот день нет</div></div>`;
        const n = F.n;
        const names = F.pts.map(nm);
        const gen = (code) => HeliData.points.has(code) ? HeliData.genitive(nm(code)) : String(code);
        let used = false;
        let h = `<div class="heli-col ${cls}"><div class="heli-col-title">${title}</div>`;
        for (let j = 1; j <= n; j++) {
            const boards = F.pairs.filter(p => p.a === j && p.sold > 0).sort((a, b) => a.b - b.b);
            const leaves = F.pairs.filter(p => p.b === j && p.sold > 0).sort((a, b) => a.a - b.a);
            const bt = boards.reduce((s, p) => s + p.sold, 0), lt = leaves.reduce((s, p) => s + p.sold, 0);
            let mv = '';
            if (bt) mv += `<span class="heli-plus">+${bt}</span>`;
            if (lt) mv += `<span class="heli-minus">−${lt}</span>`;
            if (!mv) mv = '<span class="heli-nil">—</span>';
            const sub = [];
            if (attn && attn.turn && ((isOut && j === n) || (!isOut && j === 1))) sub.push('<span class="heli-attn-note">никто не летит — можно убрать</span>');
            if (boards.length) sub.push('до ' + boards.map(p => `${esc(gen(F.pts[p.b - 1]))} ${p.sold}`).join(' · до '));
            if (leaves.length) sub.push('из ' + leaves.map(p => `${esc(gen(F.pts[p.a - 1]))} ${p.sold}`).join(' · из '));
            const closedHere = F.closedPairs.filter(p => p.a === j && p.sold === 0);
            if (closedHere.length) sub.push('закрыто: ' + closedHere.map(p => esc(nm(F.pts[p.b - 1]))).join(', '));
            const time = j < n ? 'вылет ' + (F.depAt[j - 1] || '—') : 'прилёт ' + (F.arrAt[j - 2] || F.arr || '—');
            h += `<div class="heli-stop${j === 1 ? ' heli-first' : ''}${j === n ? ' heli-last' : ''}">
                <div class="heli-line"><i class="heli-dot"></i></div>
                <div class="heli-pn"><b>${esc(names[j - 1])}</b> <span class="heli-g">${esc(F.pts[j - 1])} · ${esc(time)}</span></div>
                <div class="heli-mv">${mv}${sub.length ? `<span class="heli-g heli-mv-sub">${sub.join(' · ')}</span>` : ''}</div>
                <div class="heli-ab">${j < n ? `<span>на борту</span><b>${F.segs[j - 1]}</b>` : '<span>рейс завершён</span>'}</div></div>`;
            if (j < n) {
                const s = F.segs[j - 1];
                const p = F.seats > 0 ? Math.round(s / F.seats * 100) : 0;
                const isMax = !used && s === F.max && s > 0;
                if (isMax) used = true;
                const t = Math.min(1, p / 60);
                h += `<div class="heli-stop heli-seg"><div class="heli-line"></div>
                    <div class="heli-sb"><span class="heli-cd">${esc(F.pts[j - 1])}→${esc(F.pts[j])}</span>
                    <div class="heli-trk"><i class="${p >= 100 ? 'heli-fill-full' : ''}" style="width:${s ? Math.max(p, 4) : 0}%;--t:${t.toFixed(2)}"></i></div>
                    <span class="heli-sn${isMax ? ' heli-sn-mx' : ''}">${s} из ${F.seats} · ${p}%</span>${attn && attn.set.has(j - 1) && !attn.turn ? '<span class="heli-attn-note heli-attn-seg">пусто — можно не садиться</span>' : ''}</div></div>`;
            }
        }
        h += soldLine(F);
        return h + '</div>';
    }

    function attnFor(e, isOut) {
        const a = attnOf(e);
        return a ? { set: isOut ? a.out : a.in, turn: a.turn } : null;
    }

    function sheetRow(card, e, colspan) {
        return `<tr class="heli-exp-row" data-exp="${esc((e.out || e.in).no + '|' + e.date)}"><td colspan="${colspan}" class="heli-exp"><div class="heli-sheet-wrap"><div class="heli-sheet">${sheetCol(e.out, true, attnFor(e, true))}${sheetCol(e.in, false, attnFor(e, false))}</div></div></td></tr>`;
    }

    // ---------- карточка ----------
    function cardHtml(card, today, stat) {
        const entries = visibleEntries(card, today);
        if (!entries.length) return '';
        stat.cards++;
        stat.rows += entries.length;
        const multiOut = card.outPts.length > 2, multiIn = card.inPts.length > 2;
        const mkSide = (multi) => ({ multi, cols: 3 + (ui.day ? 1 : 0) + (multi ? 1 : 0) });
        const sideOut = mkSide(multiOut), sideIn = mkSide(multiIn);
        const total = sideOut.cols + sideIn.cols + 3;

        const simple = !card.multi;
        const outNames = card.outPts.map(nm), inNames = card.inPts.map(nm);
        const capHtml = simple
            ? `<span class="data-board-cap-out">${esc(outNames.join(' — '))}</span><span class="data-board-cap-sep">⇄</span><span class="data-board-cap-in">${esc(inNames.join(' — '))}</span>`
            : `<span class="data-board-cap-out">${esc(outNames.join(' → '))}</span><span class="data-board-cap-sep">⇄</span><span class="data-board-cap-in">обратно</span>`;

        const labels = (pts, side, isOut) => {
            if (!side.multi) return '';
            const items = pts.slice(0, -1).map((c, j) => `<span>${esc(c)}<br>${esc(pts[j + 1])}</span>`).join('');
            return `<th class="pair-sub-${isOut ? 'out' : 'in'} heli-pll-th${isOut ? ' pair-split-end' : ''}"><div class="heli-pll">${items}</div></th>`;
        };
        const subHead = (isOut, side, pts) => {
            const c = isOut ? 'out' : 'in';
            return `<th class="pair-sub-${c}${!isOut ? ' pair-split-start' : ''}">Крес.</th><th class="pair-sub-${c}">Загр.</th>`
                + (ui.day ? `<th class="pair-sub-${c} data-col-bookings">За сутки</th>` : '')
                + `<th class="pair-sub-${c}${isOut && !side.multi ? ' pair-split-end' : ''}">Занято, %</th>` + labels(pts, side, isOut);
        };

        // строка «Итого за сутки» (как в «Загрузке рейсов»)
        let daySum = '';
        if (ui.day) {
            let so = 0, si = 0;
            entries.forEach(e => {
                if (e.out && HeliData.hasSales()) so += HeliData.flightSales(e.out).yesterday;
                if (e.in && HeliData.hasSales()) si += HeliData.flightSales(e.in).yesterday;
            });
            const leg = (isOut, sum, side) => {
                const cls = isOut ? 'pair-leg-out data-block-out' : 'pair-leg-in data-block-in';
                const cells = ['', '', `<strong>${formatNum(sum)}</strong>`, ''];
                if (side.multi) cells.push('');
                return cells.map((c, i) => `<td class="${cls} data-day-sum-cell${!isOut && i === 0 ? ' pair-split-start' : ''}${isOut && i === cells.length - 1 ? ' pair-split-end' : ''}">${c}</td>`).join('');
            };
            daySum = `<tr class="data-day-sum-row"><td colspan="2" class="data-block-info font-semibold">Итого за сутки</td>${leg(true, so, sideOut)}${leg(false, si, sideIn)}<td class="data-block-avg pair-split-start"><strong>${formatNum(so + si)}</strong></td></tr>`;
        }

        let zebraN = -1, lastWeek = null;
        const body = entries.map(e => {
            const wk = typeof getWeekNumber === 'function' ? getWeekNumber(e.date) : 0;
            if (wk !== lastWeek) { zebraN++; lastWeek = wk; }
            return rowHtml(card, e, today, sideOut, sideIn, wk % 2 === 0 ? 'week-even' : 'week-odd');
        }).join('');

        const cap = card.cap || 22;
        // Карточка, которой тесно в половине ширины (много отрезков + колонка «За сутки»), занимает весь ряд.
        return `<div class="data-route-block data-type-krai heli-card" data-card="${card.key}">
            <div class="data-route-table-wrap table-wrapper heli-wrap">
            <table class="data-table pair-table data-board-table heli-table${ui.day ? ' heli-with-day' : ''}">
                <caption class="data-board-caption"><div class="data-board-caption-inner"><div class="data-board-caption-routes">${capHtml}</div><span class="data-board-cap-badge">Ми-8 · ${cap} ${plural(cap, 'место', 'места', 'мест')}</span></div></caption>
                <thead>
                    <tr class="pair-head-main data-board-head-main">
                        <th rowspan="2" class="data-board-th-date col-date"><span class="data-board-th-label">Дата</span><span class="data-board-th-sub">рейса</span></th>
                        <th rowspan="2" class="data-board-th-dow"><span class="data-board-th-label">День</span></th>
                        <th colspan="${sideOut.cols}" class="pair-dir-head pair-dir-out data-board-dir-head"><span class="data-board-dir-arrow">→</span><span class="data-board-dir-side">Туда</span><span class="data-board-dir-code">${esc(card.outNo)}</span></th>
                        <th colspan="${sideIn.cols}" class="pair-dir-head pair-dir-in data-board-dir-head pair-split-start"><span class="data-board-dir-arrow">←</span><span class="data-board-dir-side">Обратно</span><span class="data-board-dir-code">${esc(card.inNo)}</span></th>
                        <th rowspan="2" class="data-board-avg-head pair-split-start"><span class="data-board-th-label">Среднее</span><span class="data-board-th-sub">занято, %</span></th>
                    </tr>
                    <tr class="pair-head-sub data-board-head-sub">${subHead(true, sideOut, card.outPts)}${subHead(false, sideIn, card.inPts)}</tr>
                </thead>
                <tbody>${daySum}${body}</tbody>
            </table></div>
            ${card.multi ? `<div class="heli-legend">${LEGEND}</div>` : ''}</div>`;
    }

    // ---------- вывод страницы ----------
    function currentSig() {
        return [HeliData.getEpoch(), HeliData.points.rev(), ui.base, ui.q, ui.hideFlew ? 1 : 0, ui.day ? 1 : 0, ui.attn ? 1 : 0, HeliData.dayStrings().today, (typeof closedFlights !== 'undefined' && closedFlights ? closedFlights.size : 0), canExport() ? 1 : 0].join('|');
    }

    function filteredCards(model) {
        return model.cards.filter(c => (ui.base === 'all' || HeliData.canon(c.base) === HeliData.canon(ui.base)) && matchesQuery(c, ui.q));
    }

    function render(force) {
        const grid = document.getElementById('heli-grid');
        const stats = document.getElementById('heli-stats');
        if (!grid) return;
        const sig = currentSig();
        if (!force && sig === renderSig && grid.childElementCount > 0) return;
        if (!HeliData.hasData()) {
            const loaded = typeof groupedData !== 'undefined' && Object.keys(groupedData || {}).length > 0;
            grid.innerHTML = `<div class="heli-empty">${loaded
                ? 'Вертолётный файл не загружен. Положите его в папку «загрузка таб» вместе с самолётными (в строках конфигурация MIH) и нажмите «Загрузить».'
                : 'Загрузите данные, чтобы увидеть вертолёты'}</div>`;
            if (stats) stats.textContent = '';
            fillBaseSelect([]);
            renderSig = sig;
            return;
        }
        const model = HeliData.model();
        fillBaseSelect(baseOptions(model.cards));
        let nAttn = 0;
        model.cards.forEach(c => c.entries.forEach(e => { if (attnOf(e)) nAttn++; }));
        const ab = document.getElementById('heli-attn');
        if (ab) { ab.textContent = 'Внимание · ' + nAttn; ab.classList.toggle('heli-attn-on', ui.attn); ab.setAttribute('aria-pressed', ui.attn ? 'true' : 'false'); }
        const today = todayTs();
        const stat = { cards: 0, rows: 0 };
        const html = filteredCards(model).map(c => cardHtml(c, today, stat)).filter(Boolean).join('');
        grid.innerHTML = html || '<div class="heli-empty">Нет рейсов по выбранным фильтрам</div>';
        if (stats) stats.textContent = `${stat.cards} ${plural(stat.cards, 'маршрут', 'маршрута', 'маршрутов')} · ${stat.rows} ${plural(stat.rows, 'дата', 'даты', 'дат')}`;
        renderSig = sig;
    }

    function fillBaseSelect(options) {
        const sel = document.getElementById('heli-base');
        if (!sel) return;
        const want = JSON.stringify(options.map(o => o.code));
        if (sel.dataset.opts !== want) {
            sel.dataset.opts = want;
            sel.innerHTML = '<option value="all">Все базы</option>' + options.map(o => `<option value="${esc(o.code)}">${esc(o.name)}</option>`).join('');
        }
        if (ui.base !== 'all' && !options.some(o => HeliData.canon(o.code) === HeliData.canon(ui.base))) ui.base = 'all';
        sel.value = ui.base;
    }

    // ---------- раскрытие строки ----------
    function toggleRow(tr) {
        if (!tr || !tr.classList.contains('heli-row')) return;
        const model = HeliData.model();
        const card = model.cards.find(c => String(c.key) === tr.dataset.card);
        const entry = card && card.entries.find(e => e.date === tr.dataset.date);
        if (!entry) return;
        const key = (entry.out || entry.in).no + '|' + entry.date;
        const next = tr.nextElementSibling;
        if (open.has(key)) {
            open.delete(key);
            tr.classList.remove('heli-row-open');
            if (next && next.classList.contains('heli-exp-row')) next.remove();
            return;
        }
        open.add(key);
        tr.classList.add('heli-row-open');
        if (!(next && next.classList.contains('heli-exp-row'))) {
            const colspan = tr.children.length;
            tr.insertAdjacentHTML('afterend', sheetRow(card, entry, colspan));
        }
    }

    function bindGrid(grid) {
        if (grid.dataset.bound) return;
        grid.dataset.bound = '1';
        grid.addEventListener('dblclick', (e) => {
            const tr = e.target.closest('tr.heli-row');
            if (!tr) return;
            const sel = window.getSelection && window.getSelection();
            if (sel && sel.removeAllRanges) sel.removeAllRanges();
            toggleRow(tr);
        });
        grid.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const tr = e.target.closest && e.target.closest('tr.heli-row');
            if (!tr || e.target !== tr) return;
            e.preventDefault();
            toggleRow(tr);
        });
    }

    // Перетаскивание мышью вбок — как initDataBoardDrag в «Загрузке рейсов».
    function initDrag(box) {
        if (!box || box.dataset.dragInit) return;
        box.dataset.dragInit = '1';
        let down = false, dragged = false, sx = 0, sl = 0;
        box.addEventListener('mousedown', (e) => {
            if (e.button !== 0 || e.target.closest('.heli-exp, input, button, select')) return;
            down = true; dragged = false; sx = e.pageX; sl = box.scrollLeft;
        });
        box.addEventListener('mousemove', (e) => {
            if (!down) return;
            const dx = e.pageX - sx;
            if (!dragged && Math.abs(dx) > 6) { dragged = true; box.classList.add('data-board-dragging'); }
            if (!dragged) return;
            e.preventDefault();
            box.scrollLeft = sl - dx;
        });
        const stop = () => { down = false; dragged = false; box.classList.remove('data-board-dragging'); };
        box.addEventListener('mouseup', stop);
        box.addEventListener('mouseleave', stop);
    }

    // ---------- справочник пунктов ----------
    let hp = null;   // { rows: [{code, name, isNew}], editable, q }

    function ensureModal() {
        let modal = document.getElementById('heli-points-modal');
        if (modal) return modal;
        modal = document.createElement('div');
        modal.id = 'heli-points-modal';
        modal.className = 'rms-modal heli-points-modal';
        modal.innerHTML = `
            <div class="rms-modal-backdrop" data-hp-close></div>
            <div class="rms-modal-panel heli-points-panel" role="dialog" aria-modal="true" aria-labelledby="heli-points-title">
                <div class="rms-modal-header">
                    <div><h3 id="heli-points-title">Справочник пунктов</h3>
                    <p class="heli-points-sub">Код пункта в файле загрузки и его название на сайте. Общий для всех пользователей.</p></div>
                    <button type="button" class="rms-modal-close" data-hp-close aria-label="Закрыть">✕</button>
                </div>
                <div class="rms-modal-body">
                    <div class="heli-points-bar"><input type="search" id="heli-points-search" class="heli-points-search" placeholder="Код или название" autocomplete="off"><span id="heli-points-count" class="heli-points-count"></span></div>
                    <div id="heli-points-cols" class="heli-points-cols"></div>
                    <p id="heli-points-note" class="heli-points-note"></p>
                </div>
                <div class="rms-modal-footer">
                    <button type="button" class="btn-secondary rms-cond-btn" data-hp-add>+ Добавить пункт</button>
                    <div class="rms-modal-footer-spacer"></div>
                    <button type="button" class="btn-secondary rms-cond-btn" data-hp-close>Отмена</button>
                    <button type="button" class="btn-primary rms-cond-btn heli-points-save" data-hp-save>Сохранить для всех</button>
                </div>
            </div>`;
        document.body.appendChild(modal);
        if (typeof enhanceModalA11y === 'function') enhanceModalA11y(modal, modal.querySelector('.rms-modal-panel'), 'rms-modal-open');
        modal.addEventListener('click', (e) => {
            if (e.target.closest('[data-hp-close]')) closePoints();
            else if (e.target.closest('[data-hp-add]')) addPoint();
            else if (e.target.closest('[data-hp-save]')) savePoints();
            else {
                const del = e.target.closest('[data-hp-del]');
                if (del && hp) { hp.rows.splice(parseInt(del.dataset.hpDel, 10), 1); paintPoints(); }
            }
        });
        modal.addEventListener('input', (e) => {
            if (!hp) return;
            if (e.target.id === 'heli-points-search') { hp.q = e.target.value; paintPoints(); return; }
            const el = e.target.closest('[data-hp-code],[data-hp-name]');
            if (!el) return;
            const i = parseInt(el.dataset.hpCode != null ? el.dataset.hpCode : el.dataset.hpName, 10);
            if (!hp.rows[i]) return;
            if (el.dataset.hpCode != null) hp.rows[i].code = el.value; else hp.rows[i].name = el.value;
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal.classList.contains('rms-modal-open')) closePoints();
        });
        return modal;
    }

    function paintPoints() {
        const cols = document.getElementById('heli-points-cols');
        if (!cols || !hp) return;
        const q = hp.q.trim().toLowerCase();
        const list = hp.rows.map((r, i) => ({ r, i })).filter(x => !q || x.r.code.toLowerCase().includes(q) || x.r.name.toLowerCase().includes(q));
        const half = Math.ceil(list.length / 2);
        const table = (items) => `<table class="heli-points-table"><thead><tr><th>Код</th><th>Название</th>${hp.editable ? '<th></th>' : ''}</tr></thead><tbody>${items.map(({ r, i }) => `<tr>
            <td class="heli-pt-code">${hp.editable && r.isNew ? `<input class="heli-pt-in" data-hp-code="${i}" value="${esc(r.code)}" maxlength="12" placeholder="Код">` : `<b>${esc(r.code)}</b>`}</td>
            <td>${hp.editable ? `<input class="heli-pt-in" data-hp-name="${i}" value="${esc(r.name)}" maxlength="60" placeholder="Название">` : esc(r.name)}</td>
            ${hp.editable ? `<td class="heli-pt-del"><button type="button" class="heli-pt-del-btn" data-hp-del="${i}">Убрать</button></td>` : ''}</tr>`).join('')}</tbody></table>`;
        cols.innerHTML = list.length
            ? table(list.slice(0, half)) + (list.length > half ? table(list.slice(half)) : '')
            : '<div class="heli-points-none">Ничего не найдено</div>';
        const cnt = document.getElementById('heli-points-count');
        if (cnt) cnt.textContent = `Пунктов: ${hp.rows.length}`;
    }

    async function openPoints() {
        const modal = ensureModal();
        await HeliData.points.load().catch(() => {});
        const map = HeliData.points.map();
        const editable = canEditPoints();
        hp = { rows: Object.keys(map).map(c => ({ code: c, name: map[c], isNew: false })), editable, q: '' };
        const search = document.getElementById('heli-points-search');
        if (search) search.value = '';
        modal.querySelector('[data-hp-add]').style.display = editable ? '' : 'none';
        const save = modal.querySelector('[data-hp-save]');
        save.style.display = editable ? '' : 'none';
        save.disabled = false;
        modal.querySelector('.rms-modal-footer .btn-secondary[data-hp-close]').textContent = editable ? 'Отмена' : 'Закрыть';
        const note = document.getElementById('heli-points-note');
        if (note) note.textContent = editable ? '' : 'Менять справочник могут администратор и сотрудники с правом публикации данных. Вам он доступен для просмотра.';
        paintPoints();
        modal.classList.add('rms-modal-open');
    }

    function closePoints() {
        const modal = document.getElementById('heli-points-modal');
        if (modal) modal.classList.remove('rms-modal-open');
        hp = null;
    }

    function addPoint() {
        if (!hp || !hp.editable) return;
        hp.q = '';
        const search = document.getElementById('heli-points-search');
        if (search) search.value = '';
        hp.rows.unshift({ code: '', name: '', isNew: true });
        paintPoints();
        const first = document.querySelector('#heli-points-cols [data-hp-code]');
        if (first) first.focus();
    }

    async function savePoints() {
        if (!hp || !hp.editable) return;
        const out = {};
        const seen = new Set();
        for (const r of hp.rows) {
            const code = HeliData.points.clean.code(r.code), name = HeliData.points.clean.name(r.name);
            if (!code && !name) continue;
            if (!code || !name) { showToast('У каждого пункта должны быть и код, и название', 'error'); return; }
            const k = HeliData.canon(code);
            if (seen.has(k)) { showToast(`Код «${code}» повторяется`, 'error'); return; }
            seen.add(k);
            out[code] = name;
        }
        const btn = document.querySelector('#heli-points-modal [data-hp-save]');
        if (btn) btn.disabled = true;
        const res = await HeliData.points.save(out);
        if (btn) btn.disabled = false;
        if (!res.ok) {
            showToast(res.reason === 'no-storage' ? 'Общая папка недоступна' : 'Не удалось сохранить справочник: общая папка недоступна или занята. Попробуйте ещё раз.', 'error');
            return;
        }
        if (typeof ActivityLog !== 'undefined') ActivityLog.log('heli_points', `Пунктов: ${Object.keys(out).length}`);
        showToast('Справочник пунктов сохранён для всех');
        closePoints();
        render(true);
    }

    // ---------- страница ----------
    function createView(c) {
        loadUi();
        const exportOn = canExport();
        c.innerHTML = `
            <div class="data-page heli-page">
                <div class="table-page-hero data-hero data-hero-compact">
                    <div class="data-hero-main-row">
                        <div class="table-page-hero-main"><h2 class="data-hero-title">Вертолёты</h2></div>
                        <div class="data-hero-toolbar data-hero-toolbar-top-right">
                            <input type="search" id="heli-search" class="data-search-input data-ctrl-sm" placeholder="Поиск" autocomplete="off" aria-label="Поиск">
                            <select id="heli-base" class="table-sort-select data-ctrl-sm" aria-label="База"><option value="all">Все базы</option></select>
                            <label class="data-hide-flew-label data-ctrl-sm"><input type="checkbox" id="heli-hide-flew"> Скрыть улет.</label>
                            <label class="data-hide-flew-label data-ctrl-sm"><input type="checkbox" id="heli-day"> Продажа за сутки</label>
                            <button type="button" id="heli-attn" class="filter-btn data-ctrl-sm heli-attn-btn" aria-pressed="false">Внимание · 0</button>
                            <button type="button" id="heli-points-btn" class="filter-btn data-ctrl-sm">Справочник пунктов</button>
                            ${exportOn ? '<button type="button" id="heli-export" class="filter-btn data-export-btn data-ctrl-sm">В Excel</button>' : ''}
                            <span id="heli-stats" class="data-board-stats"></span>
                        </div>
                    </div>
                </div>
                <div id="heli-scroll" class="heli-scroll data-board-scroll"><div id="heli-grid" class="heli-grid data-board-track" data-zoom-target="heli"></div></div>
            </div>`;
        const search = c.querySelector('#heli-search');
        search.value = ui.q;
        search.addEventListener('input', () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                ui.q = typeof Security !== 'undefined' ? Security.sanitizeTextInput(search.value, 80) : String(search.value || '').trim().slice(0, 80);
                saveUi();
                render();
            }, 250);
        });
        search.addEventListener('keydown', (e) => { if (e.key === 'Escape') { search.value = ''; ui.q = ''; saveUi(); render(); } });
        const base = c.querySelector('#heli-base');
        base.addEventListener('change', () => { ui.base = base.value; saveUi(); render(); });
        const hide = c.querySelector('#heli-hide-flew');
        hide.checked = ui.hideFlew;
        hide.addEventListener('change', () => { ui.hideFlew = hide.checked; saveUi(); render(); });
        const day = c.querySelector('#heli-day');
        day.checked = ui.day;
        day.addEventListener('change', () => { ui.day = day.checked; saveUi(); render(); });
        c.querySelector('#heli-attn').addEventListener('click', () => { ui.attn = !ui.attn; render(true); });
        c.querySelector('#heli-points-btn').addEventListener('click', () => { openPoints(); });
        const exp = c.querySelector('#heli-export');
        if (exp) exp.addEventListener('click', exportExcel);
        bindGrid(c.querySelector('#heli-grid'));
        initDrag(c.querySelector('#heli-scroll'));
        render(true);
        loadPointsThenRender();
        if (typeof applyViewZoom === 'function') applyViewZoom('heli');
    }

    // Общий справочник читается один раз; после чтения названия в таблице обновляются.
    function loadPointsThenRender() {
        if (!pointsPromise) {
            pointsPromise = HeliData.points.load().catch(() => {});
        }
        pointsPromise.then(() => render());
    }

    function refresh() {
        const grid = document.getElementById('heli-grid');
        if (!grid) return;
        render();
        if (typeof applyViewZoom === 'function') applyViewZoom('heli');
    }

    // ---------- Excel ----------
    function exFill(p) {
        const t = Math.min(1, p / 60);
        const mix = (a, b) => Math.round(a + (b - a) * t);
        const lo = [226, 236, 248], hi = [29, 95, 168];
        return [0, 1, 2].map(i => mix(lo[i], hi[i]).toString(16).padStart(2, '0')).join('').toUpperCase();
    }

    function buildSheet(lib, cards, today) {
        const stamp = typeof excelExportStamp === 'function' ? excelExportStamp() : '';
        const ws = {};
        const merges = [];
        const day = ui.day && HeliData.hasSales();
        const prepared = cards.map(card => ({ card, entries: visibleEntries(card, today) })).filter(x => x.entries.length);
        if (!prepared.length) return { ws, stamp, cards: 0 };
        const legW = (pts) => 3 + (day ? 1 : 0) + (pts.length > 2 ? pts.length - 1 : 0);
        const widths = prepared.map(x => 2 + legW(x.card.outPts) + legW(x.card.inPts) + 1);
        const origins = [];
        let cur = 0;
        widths.forEach((w, i) => { origins.push(cur); cur += w + 1; });
        const lastCol = cur - 2;
        const maxEntries = Math.max(...prepared.map(x => x.entries.length));
        const sumRow = day ? 1 : 0;
        const maxR = 3 + sumRow + maxEntries;
        dataBoardPaint(lib, ws, merges, 0, 0, 0, lastCol, `Дата выгрузки: ${stamp}`, 'FFFFFF', '012A4A', true, 'left', false, { quiet: true });
        const navy = '012A4A', white = 'FFFFFF', outFill = '1E40AF', inFill = '047857', slate = '0F172A';
        const colWidths = [];
        prepared.forEach((x, idx) => {
            const { card, entries } = x;
            const o = origins[idx];
            const wOut = legW(card.outPts), wIn = legW(card.inPts);
            const outStart = o + 2, inStart = outStart + wOut, avgCol = inStart + wIn;
            const simple = !card.multi;
            const cap = simple
                ? `${card.outPts.map(nm).join(' — ')}  ⇄  ${card.inPts.map(nm).join(' — ')}`
                : `${card.outPts.map(nm).join(' → ')}  ⇄  обратно`;
            dataBoardPaint(lib, ws, merges, 1, o, 1, avgCol, `${cap}   ·   МИ-8 · ${card.cap || 22} МЕСТА`, navy, white, true, 'left', true, { border: true });
            dataBoardPaint(lib, ws, merges, 2, o, 3, o, 'ДАТА\nрейса', navy, white, true, 'left', true, { border: true });
            dataBoardPaint(lib, ws, merges, 2, o + 1, 3, o + 1, 'ДЕНЬ', navy, white, true, 'center', true, { border: true });
            dataBoardPaint(lib, ws, merges, 2, outStart, 2, outStart + wOut - 1, `→\nТУДА\n${card.outNo}`, outFill, white, true, 'center', true, { border: true, splitRight: true });
            dataBoardPaint(lib, ws, merges, 2, inStart, 2, inStart + wIn - 1, `←\nОБРАТНО\n${card.inNo}`, inFill, white, true, 'center', true, { border: true, splitLeft: true });
            dataBoardPaint(lib, ws, merges, 2, avgCol, 3, avgCol, 'СР.\nзанято', navy, white, true, 'center', true, { border: true, splitLeft: true });
            const subLabels = (pts) => {
                const l = ['КРЕС.', 'ЗАГР.'];
                if (day) l.push('ЗА СУТКИ');
                l.push('ЗАНЯТО, %');
                if (pts.length > 2) pts.slice(0, -1).forEach((c, j) => l.push(`${c}\n${pts[j + 1]}`));
                return l;
            };
            const lo = subLabels(card.outPts), li = subLabels(card.inPts);
            lo.forEach((l, i) => dataBoardPaint(lib, ws, merges, 3, outStart + i, 3, outStart + i, l, outFill, white, true, 'center', true, { border: true, splitRight: i === lo.length - 1 }));
            li.forEach((l, i) => dataBoardPaint(lib, ws, merges, 3, inStart + i, 3, inStart + i, l, inFill, white, true, 'center', true, { border: true, splitLeft: i === 0 }));
            if (sumRow) {
                let so = 0, si = 0;
                entries.forEach(e => { if (e.out) so += HeliData.flightSales(e.out).yesterday; if (e.in) si += HeliData.flightSales(e.in).yesterday; });
                const kOut = lo.indexOf('ЗА СУТКИ'), kIn = li.indexOf('ЗА СУТКИ');
                dataBoardPaint(lib, ws, merges, 4, o, 4, o + 1, 'Итого за сутки', 'E2E8F0', navy, true, 'left', false, { border: true });
                lo.forEach((l, i) => dataBoardPaint(lib, ws, merges, 4, outStart + i, 4, outStart + i, i === kOut ? so : '', 'E2E8F0', navy, true, 'center', false, { border: true, splitRight: i === lo.length - 1 }));
                li.forEach((l, i) => dataBoardPaint(lib, ws, merges, 4, inStart + i, 4, inStart + i, i === kIn ? si : '', 'E2E8F0', navy, true, 'center', false, { border: true, splitLeft: i === 0 }));
                dataBoardPaint(lib, ws, merges, 4, avgCol, 4, avgCol, so + si, 'E2E8F0', navy, true, 'center', false, { border: true, splitLeft: true });
            }
            entries.forEach((e, k) => {
                const r = 4 + sumRow + k;
                const so = sideState(e.out, today), si = sideState(e.in, today);
                const wk = typeof getWeekNumber === 'function' ? getWeekNumber(e.date) : 0;
                const zebra = wk % 2 === 0 ? 'DBEAFE' : 'FFFFFF';
                const bothClosed = !!(so && si && so.closed && si.closed);
                const bothFlew = (!so || so.flew) && (!si || si.flew);
                const avg = entryAvg(e);
                const rowFill = (bothClosed || bothFlew) ? '94A3B8' : zebra;
                const wd = e.ts !== null ? DOW[new Date(e.ts).getDay()] : '—';
                dataBoardPaint(lib, ws, merges, r, o, r, o, e.date, rowFill, '1C2833', false, 'left', false, { border: true });
                dataBoardPaint(lib, ws, merges, r, o + 1, r, o + 1, wd, rowFill, '1C2833', false, 'center', false, { border: true });
                const paintSide = (F, st, start, w, isOut) => {
                    const total = w;
                    if (!F) {
                        for (let i = 0; i < total; i++) dataBoardPaint(lib, ws, merges, r, start + i, r, start + i, '—', '94A3B8', slate, false, 'center', false, { border: true, splitRight: isOut && i === total - 1, splitLeft: !isOut && i === 0 });
                        return;
                    }
                    const gray = st.closed || st.flew;
                    const base = gray ? '94A3B8' : (st.full ? 'FACC15' : zebra);
                    const vals = [{ v: F.seats }, { v: F.max, bold: true }];
                    if (day) vals.push({ v: HeliData.flightSales(F).yesterday || '—' });
                    vals.push({ v: st.closed ? 'ЗАКРЫТ' : `${F.pct}%` });
                    if (F.cells && F.cells.length && w > vals.length) {
                        let used = false;
                        F.cells.forEach(c => {
                            if (!c) { vals.push({ v: '–', fill: base }); return; }
                            const p = F.seats > 0 ? Math.round(c.v / F.seats * 100) : 0;
                            const isMax = !used && c.first && F.max > 0 && c.v === F.max && !c.closed;
                            if (isMax) used = true;
                            let fill = base, color = slate;
                            if (!gray && c.v) {
                                if (c.closed) fill = '94A3B8';
                                else if (p >= 100) fill = 'FACC15';
                                else { fill = exFill(p); color = p >= 33 ? 'FFFFFF' : '16406B'; }
                            }
                            vals.push({ v: c.v, fill, color, bold: isMax });
                        });
                    }
                    vals.forEach((c, i) => dataBoardPaint(lib, ws, merges, r, start + i, r, start + i, c.v, c.fill || base, c.color || slate, !!c.bold, 'center', false, { border: true, splitRight: isOut && i === total - 1, splitLeft: !isOut && i === 0 }));
                };
                paintSide(e.out, so, outStart, wOut, true);
                paintSide(e.in, si, inStart, wIn, false);
                const avgText = bothClosed ? 'ЗАКРЫТ' : (avg !== null ? `${avg}%` : '—');
                const yellow = !bothFlew && !bothClosed && avg !== null && avg >= 100;
                dataBoardPaint(lib, ws, merges, r, avgCol, r, avgCol, avgText, yellow ? 'FACC15' : rowFill, slate, true, 'center', false, { border: true, splitLeft: true });
            });
            const blank = dataBoardExcelStyle('FFFFFF', 'FFFFFF', false, 'center', false, { quiet: true });
            for (let r = 4 + sumRow + entries.length; r <= maxR; r++) for (let c = o; c <= avgCol; c++) dataBoardPutCell(lib, ws, r, c, '', blank);
            if (idx) colWidths.push({ wch: 3 });
            colWidths.push({ wch: 24 }, { wch: 12 });
            const plain = 3 + (day ? 1 : 0);
            [wOut, wIn].forEach(w => { for (let i = 0; i < w; i++) colWidths.push({ wch: i < plain ? 10 : 9 }); });
            colWidths.push({ wch: 11 });
        });
        const gap = dataBoardExcelStyle('FFFFFF', 'FFFFFF', false, 'center', false, { quiet: true });
        for (let i = 0; i < origins.length - 1; i++) for (let r = 1; r <= maxR; r++) dataBoardPutCell(lib, ws, r, origins[i] + widths[i], '', gap);
        ws['!merges'] = merges;
        ws['!cols'] = colWidths;
        const rowMeta = [{ hpt: 22 }, { hpt: 40 }, { hpt: 48 }, { hpt: 34 }];
        for (let r = 4; r <= maxR; r++) rowMeta[r] = { hpt: 18 };
        ws['!rows'] = rowMeta;
        ws['!ref'] = lib.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: lastCol } });
        ws['!views'] = [{ state: 'frozen', xSplit: 0, ySplit: 4 + sumRow, topLeftCell: sumRow ? 'A6' : 'A5', activePane: 'bottomLeft' }];
        return { ws, stamp, cards: prepared.length };
    }

    async function exportExcel() {
        if (typeof ProfileAuth !== 'undefined' && !ProfileAuth.guardPermission('export_excel', 'Выгрузка недоступна для вашего профиля')) return;
        if (!HeliData.hasData()) { showToast('Нет данных для выгрузки', 'error'); return; }
        if (typeof ActivityLog !== 'undefined') ActivityLog.log('export', 'Вертолёты');
        try {
            const folder = await excelPrepareFolder('heli');
            if (!(await loadPlainXlsx())) { showToast('Библиотека Excel не загружена', 'error'); return; }
            showToast('Готовлю Excel…');
            const styled = await loadStyledXlsx();
            const lib = styled || XLSX;
            const model = HeliData.model();
            const built = buildSheet(lib, filteredCards(model), todayTs());
            if (!built.cards) { showToast('Нет данных для выгрузки', 'error'); return; }
            const wb = lib.utils.book_new();
            lib.utils.book_append_sheet(wb, built.ws, 'Вертолёты');
            if (typeof excelSafeWorkbook === 'function') excelSafeWorkbook(wb);
            const fileDate = typeof getTodayDate === 'function' ? getTodayDate() : built.stamp;
            const saved = await excelSaveWorkbook(lib, wb, excelDailyFilename('КРАСАВИА_вертолёты', fileDate), folder);
            excelAnnounceSaved(saved, `Файл готов, дата выгрузки ${built.stamp}`);
        } catch (e) {
            console.error(e);
            showToast('Ошибка выгрузки', 'error');
        }
    }

    return { createView, refresh };
})();
