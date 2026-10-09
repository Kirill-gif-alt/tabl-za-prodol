// Карточка рейса — панель справа: всё по вылету без перехода на другую вкладку.
// Показывается и прячется только кнопкой ▤ рядом с именем в шапке. Пока она показана, клик по рейсу
// на Графплане, в RMS и в «Загрузке рейсов» меняет её содержимое; скрыта — клики её не открывают.
// Кнопка ⧉ — открыть карточку отдельным окном (например, на втором мониторе).
// Включает админ в «Управлении профилями» → «Функции» (flight_card; у администратора включена сразу).
// ←/→ — соседние даты этого рейса, ⇄ — обратный рейс.
window.FlightCard = (function () {
    const SHOWN_KEY = 'krasavia_card_shown_';
    const MODE_KEY = 'krasavia_card_mode';
    let state = null; // { code, date } — код рейса, как он летит в эту дату (например, KV-301)
    let chart = null;
    let mode = readMode(); // 'page' | 'window'
    let popup = null;

    function readMode() {
        try { return localStorage.getItem(MODE_KEY) === 'window' ? 'window' : 'page'; } catch (e) { return 'page'; }
    }

    function saveMode(m) {
        mode = m;
        try { localStorage.setItem(MODE_KEY, m); } catch (e) { /* ignore */ }
    }

    function profileId() {
        const p = typeof ProfileAuth !== 'undefined' && ProfileAuth.getCurrentProfile ? ProfileAuth.getCurrentProfile() : null;
        return p ? String(p.id || '') : '';
    }

    function allowed() {
        return typeof ProfileAuth !== 'undefined' && typeof ProfileAuth.featureOn === 'function' && ProfileAuth.featureOn('flight_card');
    }

    function shownSaved() {
        try { return localStorage.getItem(SHOWN_KEY + profileId()) === '1'; } catch (e) { return false; }
    }

    function isShown() {
        return allowed() && shownSaved();
    }

    function enabled() {
        return isShown();
    }

    // Кнопка ▤ рядом с именем: видна тем, кому админ включил карточку; нажали — показать, ещё раз — скрыть.
    function syncToggle() {
        const chip = document.getElementById('profile-user-chip');
        let label = document.getElementById('flight-card-toggle');
        if (!allowed()) {
            if (label) label.hidden = true;
            hidePanels();
            return;
        }
        if (!label && chip && chip.parentNode) {
            label = document.createElement('label');
            label.id = 'flight-card-toggle';
            label.className = 'flight-card-toggle';
            label.title = 'Карточка рейса: показать / скрыть';
            label.innerHTML = '<input type="checkbox" aria-label="Карточка рейса"><span class="flight-card-toggle-icon" aria-hidden="true">▤</span>';
            chip.parentNode.insertBefore(label, chip.nextSibling);
            label.querySelector('input').addEventListener('change', (e) => setShown(e.target.checked));
        }
        if (label) {
            label.hidden = false;
            label.querySelector('input').checked = shownSaved();
        }
        if (shownSaved()) show();
        else hidePanels();
    }

    function setShown(on) {
        try { localStorage.setItem(SHOWN_KEY + profileId(), on ? '1' : '0'); } catch (e) { /* ignore */ }
        const box = document.querySelector('#flight-card-toggle input');
        if (box) box.checked = !!on;
        if (on) show();
        else hidePanels();
    }

    // Последний выбранный рейс (currentFlight/lastSelectedDate) — чтобы карточка сразу была не пустой.
    function pickFromSelection() {
        if (state) return;
        const fl = typeof currentFlight !== 'undefined' ? currentFlight : null;
        const dt = typeof lastSelectedDate !== 'undefined' ? lastSelectedDate : null;
        if (fl && dt && typeof groupedData !== 'undefined' && groupedData[getBaseFlight(fl)]) {
            const hit = resolve(fl, dt);
            if (hit) state = { code: hit.code, date: hit.date };
        }
    }

    function show() {
        if (mode === 'window' && !popupAlive() && !openPopup()) saveMode('page');
        pickFromSelection();
        applyLayout();
        if (state) render();
        else renderEmpty();
    }

    function hidePanels() {
        if (popupAlive()) {
            const p = popup;
            popup = null;
            try { p.close(); } catch (e) { /* ignore */ }
        }
        if (chart) { try { chart.destroy(); } catch (e) { /* ignore */ } chart = null; }
        const panel = panelIn(document, false);
        if (panel) panel.hidden = true;
        document.body.classList.remove('flight-card-pinned', 'flight-card-open');
    }

    function esc(v) { return typeof escHtml === 'function' ? escHtml(v) : String(v == null ? '' : v); }
    function attr(v) { return typeof escAttr === 'function' ? escAttr(v) : String(v == null ? '' : v); }

    // В какой строке данных этот вылет. Рейс может лететь под другим номером (KV-301 вместо KV-101)
    // или обратный рейс — на следующий день (дата «07.10/08.10» в «Загрузке рейсов»).
    function resolve(code, date) {
        const fl = cleanFlight(code);
        const base = getBaseFlight(fl);
        const rows = groupedData[base] || [];
        let row = rows.find(r => r[1] === date && cleanFlight(r[0]) === fl)
            || rows.find(r => r[1] === date);
        if (!row) {
            const other = pairOf(base);
            const pairRows = other ? (groupedData[getBaseFlight(other)] || []) : [];
            row = pairRows.find(r => r[1] === date) || null;
        }
        if (!row) {
            const d = parseLocalDate(date);
            row = d ? rows.find(r => {
                const rd = parseLocalDate(r[1]);
                return rd && Math.abs(rd - d) <= 86400000;
            }) || null : null;
        }
        return row ? { code: cleanFlight(row[0]), date: row[1], row } : null;
    }

    // Даты вылета этого направления по порядку (для ←/→), под любым номером рейса.
    function datesOf(code) {
        const base = getBaseFlight(code);
        const set = new Set();
        (groupedData[base] || []).forEach(r => { if (r[1]) set.add(r[1]); });
        return [...set].sort((a, b) => (parseLocalDate(a) || 0) - (parseLocalDate(b) || 0));
    }

    function pairOf(code) {
        if (typeof getFlightPair !== 'function') return '';
        const base = getBaseFlight(code);
        const p = getFlightPair(base);
        const other = base === p.outbound ? p.inbound : p.outbound;
        return other && other !== base ? other : '';
    }

    // ---------- где рисуем: панель на странице или отдельное окно ----------

    function popupAlive() {
        try {
            return !!(popup && !popup.closed && popup.document && popup.document.body);
        } catch (e) {
            return false;
        }
    }

    function hostDoc() {
        return mode === 'window' && popupAlive() ? popup.document : document;
    }

    function panelIn(doc, create) {
        let panel = doc.getElementById('flight-card');
        if (panel || !create) return panel;
        panel = doc.createElement('aside');
        panel.id = 'flight-card';
        panel.className = 'flight-card flight-card-is-pinned';
        panel.setAttribute('aria-label', 'Карточка рейса');
        panel.hidden = true;
        doc.body.appendChild(panel);
        panel.addEventListener('click', onClick);
        return panel;
    }

    function ensurePanel() {
        return panelIn(hostDoc(), true);
    }

    function applyLayout() {
        const inPage = mode !== 'window' || !popupAlive();
        document.body.classList.toggle('flight-card-pinned', inPage && isShown());
        const local = panelIn(document, false);
        if (local && !inPage) local.hidden = true;
    }

    function openPopup() {
        let w = window.open('', 'krasavia-flight-card', 'width=500,height=900');
        if (!w) {
            if (typeof showToast === 'function') showToast('Браузер не дал открыть окно — разрешите всплывающие окна для этого сайта', 'error');
            return false;
        }
        // После F5 главной страницы окно с прошлого раза остаётся открытым: его документ создан
        // старой страницей (на file:// он может быть недоступен) — пересоздаём окно и подключаем заново.
        const fresh = popup !== w;
        let doc = null;
        try { doc = w.document; doc.getElementById('flight-card'); } catch (e) { doc = null; }
        if (!doc) {
            try { w.close(); } catch (e) { /* ignore */ }
            w = window.open('', 'krasavia-flight-card', 'width=500,height=900');
            if (!w) return false;
            try { doc = w.document; } catch (e) { return false; }
        }
        popup = w;
        if (fresh || !doc.getElementById('flight-card')) {
            if (chart && chart.canvas && chart.canvas.ownerDocument === doc) chart = null;
            const rootStyle = document.documentElement.getAttribute('style') || '';
            const rootCls = document.documentElement.className || '';
            const theme = document.documentElement.getAttribute('data-theme') || '';
            doc.open();
            doc.write(`<!doctype html><html lang="ru" class="${attr(rootCls)}"${theme ? ` data-theme="${attr(theme)}"` : ''} style="${attr(rootStyle)}"><head><meta charset="utf-8"><title>КРАСАВИА · Карточка рейса</title></head><body class="fc-window-body"></body></html>`);
            doc.close();
            // Стили — встроенной копией: подключить styles.css в такое окно Chrome не даёт (см. flight-card-window-css.js).
            const style = doc.createElement('style');
            style.textContent = window.FLIGHT_CARD_WINDOW_CSS || '';
            doc.head.appendChild(style);
            doc.addEventListener('keydown', onKey);
            // Окно закрыли — карточка возвращается на страницу (если она включена кнопкой ▤).
            // Событие закрытия приходит не всегда, поэтому ещё и проверяем раз в секунду.
            let done = false;
            const back = () => {
                if (done) return;
                done = true;
                clearInterval(watch);
                if (popup === w) popup = null;
                if (chart && chart.canvas && chart.canvas.ownerDocument === doc) chart = null;
                if (mode === 'window') saveMode('page');
                setTimeout(() => { if (isShown()) show(); }, 0);
            };
            const watch = setInterval(() => { if (w.closed) back(); }, 1000);
            w.addEventListener('beforeunload', back);
        }
        try { w.focus(); } catch (e) { /* ignore */ }
        return true;
    }

    function setMode(next) {
        if (next === 'window') {
            if (!openPopup()) return;
            saveMode('window');
            const local = panelIn(document, false);
            if (local) local.hidden = true;
        } else {
            saveMode('page');
            if (popupAlive()) {
                const p = popup;
                popup = null;
                try { p.close(); } catch (e) { /* ignore */ }
            }
        }
        applyLayout();
        if (state) render();
        else renderEmpty();
    }

    function modeButtons() {
        return mode === 'window' && popupAlive()
            ? '<button type="button" class="fc-nav-btn fc-on" data-fc="dock" title="Вернуть карточку в основное окно">⧉</button>'
            : '<button type="button" class="fc-nav-btn" data-fc="window" title="Открыть в отдельном окне (например, на втором мониторе)">⧉</button>';
    }

    function tile(label, value, sub, cls) {
        return `<div class="fc-tile${cls ? ' ' + cls : ''}"><div class="fc-tile-label">${esc(label)}</div><div class="fc-tile-value">${value}</div>${sub ? `<div class="fc-tile-sub">${sub}</div>` : ''}</div>`;
    }

    // Закреплённая карточка или окно без выбранного рейса.
    function renderEmpty() {
        const panel = ensurePanel();
        panel.hidden = false;
        panel.innerHTML = `
            <div class="fc-head">
                <div class="fc-title-wrap"><div class="fc-title">Карточка рейса</div></div>
                <div class="fc-nav">${modeButtons()}<button type="button" class="fc-close" data-fc="close" title="Закрыть" aria-label="Закрыть">✕</button></div>
            </div>
            <p class="fc-empty">Выберите рейс на Графплане, в RMS или «Загрузке рейсов».</p>`;
    }

    // Прогноз к вылету, безубыточность, группы (flight-insights.js).
    const INSIGHTS_KEY = 'fc_insights_open';

    function insightsOpen() {
        try { return localStorage.getItem(INSIGHTS_KEY) === '1'; } catch (e) { return false; }
    }

    // Прогноз к вылету и группы — плиткой; блок сворачивается (по умолчанию свёрнут, видна одна строка-итог).
    function insightsHtml(code, date) {
        if (typeof FlightInsights === 'undefined') return '';
        const FI = FlightInsights;
        const tiles = [];
        const summary = [];
        let advice = '';
        const f = FI.forecast(code, date);
        if (f && f.source !== 'flown') {
            const range = f.lo != null && f.hi != null && f.lo !== f.hi ? `разброс ${f.lo}–${f.hi}` : '';
            const src = f.source === 'history'
                ? `по ${f.n} ${FI.plural(f.n, 'прошлому вылету', 'прошлым вылетам', 'прошлым вылетам')} в этот день недели`
                : 'по файлу ожидаемой загрузки';
            const tone = f.lf >= 90 ? 'up' : (f.lf < 60 ? 'down' : '');
            tiles.push(`<div class="fc-it fc-it-${tone || 'plain'}">
                <div class="fc-it-label">Прогноз к вылету</div>
                <div class="fc-it-value">${f.final} <span class="fc-it-of">из ${f.seats}</span></div>
                <div class="fc-it-sub"><strong>${f.lf}%</strong>${range ? ' · ' + esc(range) : ''}</div>
                <div class="fc-it-note">${esc(src)}</div>
            </div>`);
            summary.push(`<span class="fc-ins-chip fc-ins-${tone || 'plain'}">прогноз ${f.final}/${f.seats} · ${f.lf}%</span>`);
            if (f.load >= f.seats) advice = '<div class="fc-advice fc-advice-up">✓ Уже распродан</div>';
            else if (f.soldOutDtd != null) advice = `<div class="fc-advice fc-advice-up">▲ ${f.soldOutDtd === 0 ? 'Распродастся к дню вылета' : `Распродастся примерно за ${f.soldOutDtd} дн. до вылета`} — можно поднимать тариф</div>`;
            else if (f.lf < 60) advice = '<div class="fc-advice fc-advice-down">▼ Не доберёт загрузку — стоит снижать тариф или продвигать</div>';
        }
        const g = FI.groupsFor(code, date);
        let groups = '';
        if (g.length) {
            const total = g.reduce((a, x) => a + x.n, 0);
            const pnrOk = typeof ProfileAuth === 'undefined' || (ProfileAuth.hasPermission('sales_detail') && ProfileAuth.hasPermission('load_data'));
            const items = g.map(x => `<span class="fc-grp-item"><strong>${x.n}</strong> ${FI.plural(x.n, 'человек', 'человека', 'человек')}${x.dealDate ? ' · от ' + esc(String(x.dealDate).slice(0, 5)) : ''}${x.pnr && pnrOk ? ' · ' + esc(x.pnr) : ''}</span>`).join('');
            groups = `<div class="fc-groups"><span class="fc-groups-title">${g.length === 1 ? 'Группа' : `Группы (${g.length})`}</span>${items}</div>`;
            summary.push(`<span class="fc-ins-chip fc-ins-group">${g.length === 1 ? 'группа' : 'группы'} ${total} чел.</span>`);
        }
        if (!tiles.length && !groups) return '';
        const open = insightsOpen();
        return `<div class="fc-insights${open ? ' fc-ins-open' : ''}">
            <button type="button" class="fc-ins-head" data-fc="insights" aria-expanded="${open}" title="${open ? 'Свернуть' : 'Показать прогноз'}">
                <span class="fc-ins-caret">${open ? '▾' : '▸'}</span>
                <span class="fc-ins-title">Прогноз к вылету</span>
                <span class="fc-ins-chips">${summary.join('')}</span>
            </button>
            ${open ? `<div class="fc-ins-body">
                ${tiles.length ? `<div class="fc-it-grid">${tiles.join('')}</div>` : ''}
                ${advice}
                ${groups}
            </div>` : ''}
        </div>`;
    }

    function render() {
        const panel = ensurePanel();
        if (!state) return;
        panel.hidden = false;
        const { code, date } = state;
        const base = getBaseFlight(code);
        const row = typeof getFlightRowForDate === 'function' ? getFlightRowForDate(base, date, code) : null;
        if (!row) {
            panel.innerHTML = `<div class="fc-head"><div class="fc-title">${esc(code)} · ${esc(date)}</div><div class="fc-nav">${modeButtons()}<button type="button" class="fc-close" data-fc="close" aria-label="Закрыть">✕</button></div></div><p class="fc-empty">Нет данных по этому вылету.</p>`;
            return;
        }
        const m = typeof getRowMetrics === 'function' ? getRowMetrics(row, base) : null;
        const dates = datesOf(code);
        const idx = dates.indexOf(date);
        const other = pairOf(code);
        const salesReady = typeof hasSalesFileLoaded === 'function' ? hasSalesFileLoaded() : true;
        const modeMark = typeof FlightChecks !== 'undefined' && FlightChecks.modeBadge ? FlightChecks.modeBadge(code, date, row) : '';
        const issues = typeof FlightChecks !== 'undefined' && FlightChecks.enabled() ? FlightChecks.issuesFor(code, date) : [];
        const comment = typeof FlightComments !== 'undefined' ? FlightComments.get(code, date) : '';
        const dtdTxt = m && m.dtd != null ? (m.dtd < 0 ? 'улетел' : `DTD ${m.dtd}`) : '';
        const status = m && m.closed ? 'закрыт' : '';
        const deltaCls = m && m.delta != null ? (m.delta < 0 ? 'fc-neg' : (m.delta > 0 ? 'fc-pos' : '')) : '';
        const canTab = (t) => typeof ProfileAuth === 'undefined' || ProfileAuth.canAccessTab(t);
        const links = [['table', 'Динамика продаж'], ['pair', 'Экономика'], ['pkz', 'ПКЗ']]
            .filter(([t]) => canTab(t))
            .map(([t, l]) => `<button type="button" class="filter-btn" data-fc-tab="${t}">${l}</button>`).join('');
        const calName = typeof CalendarEvents !== 'undefined' ? CalendarEvents.label(date) : '';
        const altNumber = code !== base ? ` <span class="fc-alt" title="В эту дату рейс ${attr(base)} летит под номером ${attr(code)}">вместо ${esc(base)}</span>` : '';

        panel.innerHTML = `
            <div class="fc-head">
                <div class="fc-title-wrap">
                    <div class="fc-title">${esc(code)}${altNumber} <span class="fc-dir">${esc(getFlightDirection(code))}</span></div>
                    <div class="fc-sub">${esc(getDayOfWeek(date))} ${esc(date)} · ${esc(getAircraftType(row[4]))}${dtdTxt ? ' · ' + esc(dtdTxt) : ''}${status ? ' · ' + esc(status) : ''}${calName ? ` · <span class="fc-cal">${esc(calName)}</span>` : ''} ${modeMark}</div>
                </div>
                <div class="fc-nav">
                    <button type="button" class="fc-nav-btn" data-fc="prev" ${idx > 0 ? '' : 'disabled'} title="Предыдущая дата (←)">←</button>
                    <button type="button" class="fc-nav-btn" data-fc="next" ${idx >= 0 && idx < dates.length - 1 ? '' : 'disabled'} title="Следующая дата (→)">→</button>
                    ${other ? `<button type="button" class="fc-nav-btn" data-fc="pair" title="Обратный рейс ${attr(other)}">⇄ ${esc(other)}</button>` : ''}
                    ${modeButtons()}
                    <button type="button" class="fc-close" data-fc="close" title="Скрыть карточку (как кнопка ▤ у имени)" aria-label="Скрыть">✕</button>
                </div>
            </div>
            ${issues.length ? `<div class="fc-issues">${issues.map(i => `<div>! ${esc(i.title)}: ${esc(i.detail)}</div>`).join('')}</div>` : ''}
            <div class="fc-tiles">
                ${tile('Загрузка', m && m.pct != null ? m.pct + '%' : '—', m ? `${m.free} из ${m.total}` : '')}
                ${tile('Ожидаемая', m && m.evR != null ? String(m.evR) : '—', '')}
                ${tile('Δ к ожидаемой', m && m.delta != null ? `<span class="${deltaCls}">${m.delta > 0 ? '+' : ''}${m.delta}</span>` : '—', '')}
                ${tile('Остаток', m && m.remainder != null ? String(m.remainder) : '—', '')}
                ${tile('Pickup 1–2 дн.', m && m.pickup != null && salesReady ? String(m.pickup) : '—', '')}
                ${tile('Ср. тариф', m && m.avg && salesReady ? esc(formatRub(m.avg)) : '—', '')}
            </div>
            ${insightsHtml(code, date)}
            <div class="fc-verdict" data-fc-part="verdict"></div>
            <div class="fc-chart-wrap"><canvas data-fc-part="chart"></canvas></div>
            ${typeof PriceMarks !== 'undefined' ? PriceMarks.buttonsHtml(code, date) : ''}
            ${typeof PriceMarks !== 'undefined' ? PriceMarks.decisionsHtml(base, code, date) : ''}
            ${comment ? `<div class="fc-comment"><strong>Комментарий:</strong> ${esc(comment)}</div>` : ''}
            ${links ? `<div class="fc-links">Открыть: ${links}</div>` : ''}
        `;
        drawChart(panel, base, code, date, row);
    }

    function drawChart(panel, base, code, date, row) {
        if (chart) { try { chart.destroy(); } catch (e) { /* ignore */ } chart = null; }
        const canvas = panel.querySelector('[data-fc-part="chart"]');
        if (!canvas || typeof Chart === 'undefined' || typeof buildFlightDtdBookingSeries !== 'function') return;
        const c = buildFlightDtdBookingSeries(base, date, code, 30, row[4]);
        const verdict = panel.querySelector('[data-fc-part="verdict"]');
        if (verdict) { verdict.innerHTML = c.verdictHtml; verdict.className = 'fc-verdict booking-curve-verdict ' + c.verdictCls; }
        const datasets = [{
            label: 'Продано (билеты)', data: c.thisData, borderColor: '#1d4ed8', backgroundColor: 'rgba(29,78,216,0.08)',
            fill: true, tension: 0.15, pointRadius: 0, pointHoverRadius: 3, borderWidth: 2, spanGaps: true
        }];
        if (c.refData) datasets.push({ label: c.refLabel || 'Норма', data: c.refData, borderColor: '#64748b', borderDash: [5, 4], fill: false, pointRadius: 0, borderWidth: 2, spanGaps: true });
        if (c.expectedData) datasets.push({ label: 'Ожидаемая', data: c.expectedData, borderColor: '#d97706', borderDash: [6, 4], fill: false, pointRadius: 0, borderWidth: 2, spanGaps: true });
        const fly = parseLocalDate(date);
        chart = new Chart(canvas, {
            type: 'line',
            data: { labels: c.dtds.map(t => t + 'д'), datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { labels: { boxWidth: 10, font: { size: 10 } } },
                    tooltip: { callbacks: { title: (items) => `${c.dtds[items[0].dataIndex]} дн. до вылета` } },
                    priceMarks: {
                        items: typeof PriceMarks !== 'undefined'
                            ? PriceMarks.chartItems(code, date, mk => { const d = parseLocalDate(mk.check); return d && fly ? c.dtds.indexOf(Math.round((fly - d) / 86400000)) : -1; })
                            : []
                    }
                },
                scales: {
                    y: { beginAtZero: true, ticks: { font: { size: 10 } } },
                    x: { ticks: { font: { size: 9 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 10 }, grid: { display: false } }
                }
            }
        });
    }

    function open(code, date) {
        const hit = resolve(code, date);
        state = hit ? { code: hit.code, date: hit.date } : { code: cleanFlight(code), date };
        if (!isShown()) return;
        if (mode === 'window' && !popupAlive()) saveMode('page');
        applyLayout();
        render();
    }

    function close() {
        setShown(false);
    }

    function step(dir) {
        if (!state) return;
        const dates = datesOf(state.code);
        const i = dates.indexOf(state.date);
        const next = dates[i + dir];
        if (next) open(getBaseFlight(state.code), next);
    }

    function swapPair() {
        if (!state) return;
        const other = pairOf(state.code);
        if (!other) return;
        const dates = datesOf(other);
        if (!dates.length) return;
        const target = parseLocalDate(state.date) || new Date();
        // Та же дата или ближайшая следующая (обратный рейс часто на следующий день).
        const next = dates.find(d => (parseLocalDate(d) || 0) >= target) || dates[dates.length - 1];
        open(other, next);
    }

    function onClick(e) {
        const set = e.target.closest('[data-pm-set]');
        if (set && typeof PriceMarks !== 'undefined') {
            // В отдельном окне общий обработчик страницы кнопки не видит — отмечаем отсюда.
            if (hostDoc() !== document) PriceMarks.setToday(set.dataset.pmCode, set.dataset.pmDate, set.dataset.pmSet || null);
            return;
        }
        const b = e.target.closest('[data-fc], [data-fc-tab]');
        if (!b) return;
        if (b.dataset.fcTab) {
            const { code, date } = state || {};
            if (!code) return;
            currentFlight = getBaseFlight(code);
            lastSelectedDate = date;
            switchMainTab(b.dataset.fcTab);
            try { window.focus(); } catch (err) { /* ignore */ }
            return;
        }
        const a = b.dataset.fc;
        if (a === 'close') close();
        else if (a === 'prev') step(-1);
        else if (a === 'next') step(1);
        else if (a === 'pair') swapPair();
        else if (a === 'window') setMode('window');
        else if (a === 'dock') setMode('page');
        else if (a === 'insights') {
            try { localStorage.setItem(INSIGHTS_KEY, insightsOpen() ? '0' : '1'); } catch (err) { /* ignore */ }
            render();
        }
    }

    function onKey(e) {
        if (!state || !isShown()) return;
        const t = e.target;
        if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
        if (e.ctrlKey || e.altKey || e.metaKey) return;
        // Стрелки листают даты, только когда фокус в самой карточке (или в её окне) — таблицам не мешаем.
        const inCard = t && t.closest && t.closest('#flight-card');
        if (!inCard && hostDoc() === document) return;
        if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    }

    document.addEventListener('keydown', onKey);

    // Отметка поставлена — обновить кнопки и маркеры в открытой карточке.
    document.addEventListener('krasavia:mark', () => { if (state && isShown()) render(); });

    // Вызывается из обработчиков клика (Графплан, RMS, «Загрузка рейсов»): карточку не открывает,
    // только меняет содержимое, если она показана кнопкой ▤.
    function maybeOpen(code, date) {
        if (!allowed()) return false;
        open(code, date);
        return isShown();
    }

    return { open, close, maybeOpen, syncToggle, setShown, enabled, resolve, isOpen: () => isShown(), mode: () => mode };
})();
