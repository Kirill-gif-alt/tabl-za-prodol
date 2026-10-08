// Карточка рейса — выдвижная панель справа: всё по вылету за один клик, не уходя с вкладки.
// Открывается кликом по рейсу на Графплане, в RMS и в «Загрузке рейсов».
// Включает админ в «Управлении профилями» → «Функции» (flight_card; у администратора включена сразу);
// сам сотрудник может спрятать её значком ▤ рядом со своим именем в шапке.
// Esc — закрыть, ←/→ — соседние даты этого рейса, ⇄ — обратный рейс.
// Три режима: выдвижная панель (по умолчанию), «закреплена» — всегда справа и не закрывается
// при смене вкладки, «в отдельном окне» — своё окно браузера, например на втором мониторе.
// Окно рисуется отсюда же (данные не грузятся второй раз) и обновляется по кликам в основном окне.
window.FlightCard = (function () {
    const HIDE_KEY = 'krasavia_card_off_';
    const MODE_KEY = 'krasavia_card_mode';
    let state = null; // { code, date } — код рейса, как он летит в эту дату (например, KV-301)
    let chart = null;
    let mode = readMode(); // 'drawer' | 'pinned' | 'window'
    let popup = null;

    function readMode() {
        try {
            const m = localStorage.getItem(MODE_KEY);
            return m === 'pinned' || m === 'window' ? m : 'drawer';
        } catch (e) {
            return 'drawer';
        }
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

    function hiddenByUser() {
        try { return localStorage.getItem(HIDE_KEY + profileId()) === '1'; } catch (e) { return false; }
    }

    function enabled() {
        return allowed() && !hiddenByUser();
    }

    // Галочка «Карточка» рядом с именем: видна только тем, кому админ включил функцию.
    function syncToggle() {
        const chip = document.getElementById('profile-user-chip');
        let label = document.getElementById('flight-card-toggle');
        if (!allowed()) {
            if (label) label.hidden = true;
            close();
            return;
        }
        if (!label && chip && chip.parentNode) {
            label = document.createElement('label');
            label.id = 'flight-card-toggle';
            label.className = 'flight-card-toggle';
            label.title = 'Карточка рейса: открывать по клику на Графплане, в RMS и «Загрузке рейсов» (снимите, чтобы не открывалась)';
            label.innerHTML = '<input type="checkbox" aria-label="Карточка рейса"><span class="flight-card-toggle-icon" aria-hidden="true">▤</span>';
            chip.parentNode.insertBefore(label, chip.nextSibling);
            label.querySelector('input').addEventListener('change', (e) => {
                try { localStorage.setItem(HIDE_KEY + profileId(), e.target.checked ? '0' : '1'); } catch (err) { /* ignore */ }
                if (!e.target.checked) close();
            });
        }
        if (label) {
            label.hidden = false;
            label.querySelector('input').checked = !hiddenByUser();
        }
        restoreMode();
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
        return !!(popup && !popup.closed && popup.document && popup.document.body);
    }

    function hostDoc() {
        return mode === 'window' && popupAlive() ? popup.document : document;
    }

    function panelIn(doc, create) {
        let panel = doc.getElementById('flight-card');
        if (panel || !create) return panel;
        panel = doc.createElement('aside');
        panel.id = 'flight-card';
        panel.className = 'flight-card';
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
        const local = panelIn(document, false);
        const pinned = mode === 'pinned';
        document.body.classList.toggle('flight-card-pinned', pinned && enabled());
        if (local) {
            local.classList.toggle('flight-card-is-pinned', pinned);
            if (mode === 'window' && popupAlive()) local.hidden = true;
        }
    }

    function openPopup() {
        const w = window.open('', 'krasavia-flight-card', 'width=500,height=900');
        if (!w) {
            if (typeof showToast === 'function') showToast('Браузер не дал открыть окно — разрешите всплывающие окна для этого сайта', 'error');
            return false;
        }
        popup = w;
        const doc = w.document;
        if (!doc.getElementById('flight-card')) {
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
            w.addEventListener('beforeunload', () => {
                // Окно закрыли — карточка снова открывается на странице.
                if (mode === 'window') saveMode('drawer');
                popup = null;
                if (chart && chart.canvas && chart.canvas.ownerDocument === doc) chart = null;
                applyLayout();
            });
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
            if (mode === 'window' && popupAlive()) {
                const p = popup;
                saveMode(next);
                popup = null;
                try { p.close(); } catch (e) { /* ignore */ }
            }
            saveMode(next);
        }
        applyLayout();
        if (state) render();
        else if (next !== 'drawer') renderEmpty();
    }

    function modeButtons() {
        const pinOn = mode === 'pinned';
        return `
            <button type="button" class="fc-nav-btn${pinOn ? ' fc-on' : ''}" data-fc="pin" title="${pinOn ? 'Открепить: карточка снова выдвижная' : 'Закрепить справа: карточка всегда на экране и не закрывается при смене вкладки'}">📌</button>
            ${mode === 'window'
                ? '<button type="button" class="fc-nav-btn fc-on" data-fc="dock" title="Вернуть карточку в основное окно">⧉</button>'
                : '<button type="button" class="fc-nav-btn" data-fc="window" title="Открыть в отдельном окне (например, на втором мониторе)">⧉</button>'}`;
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
        const altNumber = code !== base ? ` <span class="fc-alt" title="В эту дату рейс ${attr(base)} летит под номером ${attr(code)}">вместо ${esc(base)}</span>` : '';

        panel.innerHTML = `
            <div class="fc-head">
                <div class="fc-title-wrap">
                    <div class="fc-title">${esc(code)}${altNumber} <span class="fc-dir">${esc(getFlightDirection(code))}</span></div>
                    <div class="fc-sub">${esc(getDayOfWeek(date))} ${esc(date)} · ${esc(getAircraftType(row[4]))}${dtdTxt ? ' · ' + esc(dtdTxt) : ''}${status ? ' · ' + esc(status) : ''} ${modeMark}</div>
                </div>
                <div class="fc-nav">
                    <button type="button" class="fc-nav-btn" data-fc="prev" ${idx > 0 ? '' : 'disabled'} title="Предыдущая дата (←)">←</button>
                    <button type="button" class="fc-nav-btn" data-fc="next" ${idx >= 0 && idx < dates.length - 1 ? '' : 'disabled'} title="Следующая дата (→)">→</button>
                    ${other ? `<button type="button" class="fc-nav-btn" data-fc="pair" title="Обратный рейс ${attr(other)}">⇄ ${esc(other)}</button>` : ''}
                    ${modeButtons()}
                    <button type="button" class="fc-close" data-fc="close" title="Закрыть (Esc)" aria-label="Закрыть">✕</button>
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
            <div class="fc-verdict" data-fc-part="verdict"></div>
            <div class="fc-chart-wrap"><canvas data-fc-part="chart"></canvas></div>
            <div class="fc-chart-note" data-fc-part="note"></div>
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
        if (verdict) { verdict.textContent = c.verdict; verdict.className = 'fc-verdict ' + c.verdictCls; }
        const datasets = [{
            label: 'Продано (билеты)', data: c.thisData, borderColor: '#1d4ed8', backgroundColor: 'rgba(29,78,216,0.08)',
            fill: true, tension: 0.15, pointRadius: 0, pointHoverRadius: 3, borderWidth: 2, spanGaps: true
        }];
        if (c.refData) datasets.push({ label: c.refLabel || 'Норма', data: c.refData, borderColor: '#64748b', borderDash: [5, 4], fill: false, pointRadius: 0, borderWidth: 2, spanGaps: true });
        if (c.expectedData) datasets.push({ label: 'Ожидаемая', data: c.expectedData, borderColor: '#d97706', borderDash: [6, 4], fill: false, pointRadius: 0, borderWidth: 2, spanGaps: true });
        // Загрузка по ежедневным срезам архива (с возвратами и бронями без билета).
        const slices = typeof SalesArchive !== 'undefined' ? SalesArchive.slicesFor(date, code) : [];
        const fly = parseLocalDate(date);
        if (slices.length) {
            const pts = c.dtds.map(t => {
                const hit = slices.find(s => { const d = parseLocalDate(s.day); return d && fly && Math.round((fly - d) / 86400000) === t; });
                return hit ? hit.sold : null;
            });
            if (pts.some(v => v != null)) datasets.push({ label: 'Загрузка по срезам', data: pts, borderColor: '#0d9488', backgroundColor: '#0d9488', showLine: false, pointRadius: 3, pointStyle: 'rectRot' });
        }
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
        const note = panel.querySelector('[data-fc-part="note"]');
        if (note) note.textContent = c.caption;
    }

    function open(code, date) {
        const hit = resolve(code, date);
        state = hit ? { code: hit.code, date: hit.date } : { code: cleanFlight(code), date };
        if (mode === 'window' && !popupAlive()) {
            // Окно закрыли вручную — показываем на странице.
            saveMode('drawer');
        }
        if (mode !== 'window') document.body.classList.add('flight-card-open');
        applyLayout();
        render();
        const want = state;
        if (typeof SalesArchive !== 'undefined' && SalesArchive.ensureSlices) {
            SalesArchive.ensureSlices().then(() => { if (state === want) render(); }).catch(() => {});
        }
    }

    function close() {
        if (mode === 'window' && popupAlive()) {
            const p = popup;
            popup = null;
            saveMode('drawer');
            try { p.close(); } catch (e) { /* ignore */ }
        } else if (mode === 'pinned') {
            saveMode('drawer');
        }
        state = null;
        if (chart) { try { chart.destroy(); } catch (e) { /* ignore */ } chart = null; }
        const panel = panelIn(document, false);
        if (panel) panel.hidden = true;
        document.body.classList.remove('flight-card-open');
        applyLayout();
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
            if (mode === 'drawer') close();
            switchMainTab(b.dataset.fcTab);
            try { window.focus(); } catch (err) { /* ignore */ }
            return;
        }
        const a = b.dataset.fc;
        if (a === 'close') close();
        else if (a === 'prev') step(-1);
        else if (a === 'next') step(1);
        else if (a === 'pair') swapPair();
        else if (a === 'pin') setMode(mode === 'pinned' ? 'drawer' : 'pinned');
        else if (a === 'window') setMode('window');
        else if (a === 'dock') setMode('pinned');
    }

    function onKey(e) {
        if (!state) return;
        const t = e.target;
        if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
        if (e.key === 'Escape') {
            if (mode === 'drawer') close();
            return;
        }
        if (e.ctrlKey || e.altKey || e.metaKey) return;
        if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    }

    document.addEventListener('keydown', onKey);

    // Отметка поставлена — обновить кнопки и маркеры в открытой карточке.
    document.addEventListener('krasavia:mark', () => { if (state) render(); });

    // Вызывается из обработчиков клика (Графплан, RMS, «Загрузка рейсов»).
    function maybeOpen(code, date) {
        if (!enabled()) return false;
        open(code, date);
        return true;
    }

    // После входа: закреплённая карточка сразу на месте (окно браузер сам не откроет — нужен клик).
    function restoreMode() {
        if (!allowed() || hiddenByUser()) return;
        if (mode === 'window') saveMode('pinned');
        if (mode === 'pinned' && !state) {
            applyLayout();
            renderEmpty();
        }
    }

    return { open, close, maybeOpen, syncToggle, enabled, restoreMode, resolve, isOpen: () => !!state, mode: () => mode };
})();
