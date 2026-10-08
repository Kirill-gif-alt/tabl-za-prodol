// Карточка рейса — выдвижная панель справа: всё по вылету за один клик, не уходя с вкладки.
// Открывается кликом по рейсу на Графплане, в RMS и в «Загрузке рейсов».
// Включает админ в «Управлении профилями» → «Функции» (flight_card, по умолчанию выключена);
// сам сотрудник может спрятать её галочкой «Карточка» рядом со своим именем в шапке.
// Esc — закрыть, ←/→ — соседние даты этого рейса, ⇄ — обратный рейс.
window.FlightCard = (function () {
    const HIDE_KEY = 'krasavia_card_off_';
    let state = null; // { code, date }
    let chart = null;

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
    }

    function esc(v) { return typeof escHtml === 'function' ? escHtml(v) : String(v == null ? '' : v); }
    function attr(v) { return typeof escAttr === 'function' ? escAttr(v) : String(v == null ? '' : v); }

    function rowFor(code, date) {
        const base = getBaseFlight(code);
        return typeof getFlightRowForDate === 'function' ? getFlightRowForDate(base, date, code) : null;
    }

    // Даты вылета рейса по порядку (для ←/→).
    function datesOf(code) {
        const base = getBaseFlight(code);
        const set = new Set();
        (groupedData[base] || []).forEach(r => { if (cleanFlight(r[0]) === code && r[1]) set.add(r[1]); });
        return [...set].sort((a, b) => (parseLocalDate(a) || 0) - (parseLocalDate(b) || 0));
    }

    function pairOf(code) {
        if (typeof getFlightPair !== 'function') return '';
        const p = getFlightPair(code);
        const other = code === p.outbound ? p.inbound : p.outbound;
        return other && other !== code ? other : '';
    }

    function ensurePanel() {
        let panel = document.getElementById('flight-card');
        if (panel) return panel;
        panel = document.createElement('aside');
        panel.id = 'flight-card';
        panel.className = 'flight-card';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'Карточка рейса');
        panel.hidden = true;
        document.body.appendChild(panel);
        panel.addEventListener('click', onClick);
        return panel;
    }

    function tile(label, value, sub, cls) {
        return `<div class="fc-tile${cls ? ' ' + cls : ''}"><div class="fc-tile-label">${esc(label)}</div><div class="fc-tile-value">${value}</div>${sub ? `<div class="fc-tile-sub">${sub}</div>` : ''}</div>`;
    }

    function render() {
        const panel = ensurePanel();
        if (!state) return;
        const { code, date } = state;
        const base = getBaseFlight(code);
        const row = rowFor(code, date);
        if (!row) {
            panel.innerHTML = `<div class="fc-head"><div class="fc-title">${esc(code)} · ${esc(date)}</div><button type="button" class="fc-close" data-fc="close" aria-label="Закрыть">✕</button></div><p class="fc-empty">Нет данных по этому вылету.</p>`;
            return;
        }
        const m = typeof getRowMetrics === 'function' ? getRowMetrics(row, base) : null;
        const dates = datesOf(code);
        const idx = dates.indexOf(date);
        const other = pairOf(code);
        const salesReady = typeof hasSalesFileLoaded === 'function' ? hasSalesFileLoaded() : true;
        const mode = typeof FlightChecks !== 'undefined' && FlightChecks.modeBadge ? FlightChecks.modeBadge(code, date, row) : '';
        const issues = typeof FlightChecks !== 'undefined' && FlightChecks.enabled() ? FlightChecks.issuesFor(code, date) : [];
        const comment = typeof FlightComments !== 'undefined' ? FlightComments.get(code, date) : '';
        const dtdTxt = m && m.dtd != null ? (m.dtd < 0 ? 'улетел' : `DTD ${m.dtd}`) : '';
        const status = m && m.closed ? 'закрыт' : '';
        const deltaCls = m && m.delta != null ? (m.delta < 0 ? 'fc-neg' : (m.delta > 0 ? 'fc-pos' : '')) : '';
        const canTab = (t) => typeof ProfileAuth === 'undefined' || ProfileAuth.canAccessTab(t);
        const links = [['table', 'Динамика продаж'], ['pair', 'Экономика'], ['pkz', 'ПКЗ']]
            .filter(([t]) => canTab(t))
            .map(([t, l]) => `<button type="button" class="filter-btn" data-fc-tab="${t}">${l}</button>`).join('');

        panel.innerHTML = `
            <div class="fc-head">
                <div class="fc-title-wrap">
                    <div class="fc-title">${esc(code)} <span class="fc-dir">${esc(getFlightDirection(code))}</span></div>
                    <div class="fc-sub">${esc(getDayOfWeek(date))} ${esc(date)} · ${esc(getAircraftType(row[4]))}${dtdTxt ? ' · ' + esc(dtdTxt) : ''}${status ? ' · ' + esc(status) : ''} ${mode}</div>
                </div>
                <div class="fc-nav">
                    <button type="button" class="fc-nav-btn" data-fc="prev" ${idx > 0 ? '' : 'disabled'} title="Предыдущая дата (←)">←</button>
                    <button type="button" class="fc-nav-btn" data-fc="next" ${idx >= 0 && idx < dates.length - 1 ? '' : 'disabled'} title="Следующая дата (→)">→</button>
                    ${other ? `<button type="button" class="fc-nav-btn" data-fc="pair" title="Обратный рейс ${attr(other)}">⇄ ${esc(other)}</button>` : ''}
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
            <div class="fc-verdict" id="fc-verdict"></div>
            <div class="fc-chart-wrap"><canvas id="fc-chart"></canvas></div>
            <div class="fc-chart-note" id="fc-chart-note"></div>
            ${typeof PriceMarks !== 'undefined' ? PriceMarks.buttonsHtml(code, date) : ''}
            ${typeof PriceMarks !== 'undefined' ? PriceMarks.decisionsHtml(base, code, date) : ''}
            ${comment ? `<div class="fc-comment"><strong>Комментарий:</strong> ${esc(comment)}</div>` : ''}
            ${links ? `<div class="fc-links">Открыть: ${links}</div>` : ''}
        `;
        drawChart(base, code, date, row);
    }

    function drawChart(base, code, date, row) {
        if (chart) { try { chart.destroy(); } catch (e) { /* ignore */ } chart = null; }
        const canvas = document.getElementById('fc-chart');
        if (!canvas || typeof Chart === 'undefined' || typeof buildFlightDtdBookingSeries !== 'function') return;
        const c = buildFlightDtdBookingSeries(base, date, code, 30, row[4]);
        const verdict = document.getElementById('fc-verdict');
        if (verdict) { verdict.textContent = c.verdict; verdict.className = 'fc-verdict ' + c.verdictCls; }
        const datasets = [{
            label: 'Продано (билеты)', data: c.thisData, borderColor: '#1d4ed8', backgroundColor: 'rgba(29,78,216,0.08)',
            fill: true, tension: 0.15, pointRadius: 0, pointHoverRadius: 3, borderWidth: 2, spanGaps: true
        }];
        if (c.refData) datasets.push({ label: c.refLabel || 'Норма', data: c.refData, borderColor: '#64748b', borderDash: [5, 4], fill: false, pointRadius: 0, borderWidth: 2, spanGaps: true });
        if (c.expectedData) datasets.push({ label: 'Ожидаемая', data: c.expectedData, borderColor: '#d97706', borderDash: [6, 4], fill: false, pointRadius: 0, borderWidth: 2, spanGaps: true });
        // Загрузка по ежедневным срезам архива (с возвратами и бронями без билета).
        const slices = typeof SalesArchive !== 'undefined' ? SalesArchive.slicesFor(date, code) : [];
        if (slices.length) {
            const fly = parseLocalDate(date);
            const pts = c.dtds.map(t => {
                const hit = slices.find(s => { const d = parseLocalDate(s.day); return d && fly && Math.round((fly - d) / 86400000) === t; });
                return hit ? hit.sold : null;
            });
            if (pts.some(v => v != null)) datasets.push({ label: 'Загрузка по срезам', data: pts, borderColor: '#0d9488', backgroundColor: '#0d9488', showLine: false, pointRadius: 3, pointStyle: 'rectRot' });
        }
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
        const note = document.getElementById('fc-chart-note');
        if (note) note.textContent = c.caption;
    }

    function open(code, date) {
        const fl = cleanFlight(code);
        if (!fl || !date) return;
        state = { code: fl, date };
        const panel = ensurePanel();
        panel.hidden = false;
        document.body.classList.add('flight-card-open');
        render();
        if (typeof SalesArchive !== 'undefined' && SalesArchive.ensureSlices) {
            SalesArchive.ensureSlices().then(() => { if (state && state.code === fl && state.date === date) render(); }).catch(() => {});
        }
    }

    function close() {
        state = null;
        if (chart) { try { chart.destroy(); } catch (e) { /* ignore */ } chart = null; }
        const panel = document.getElementById('flight-card');
        if (panel) panel.hidden = true;
        document.body.classList.remove('flight-card-open');
    }

    function step(dir) {
        if (!state) return;
        const dates = datesOf(state.code);
        const i = dates.indexOf(state.date);
        const next = dates[i + dir];
        if (next) open(state.code, next);
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
        const b = e.target.closest('[data-fc], [data-fc-tab]');
        if (!b) return;
        if (b.dataset.fcTab) {
            const { code, date } = state || {};
            if (!code) return;
            currentFlight = getBaseFlight(code);
            lastSelectedDate = date;
            close();
            switchMainTab(b.dataset.fcTab);
            return;
        }
        const a = b.dataset.fc;
        if (a === 'close') close();
        else if (a === 'prev') step(-1);
        else if (a === 'next') step(1);
        else if (a === 'pair') swapPair();
    }

    document.addEventListener('keydown', (e) => {
        if (!state) return;
        const t = e.target;
        if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
        if (e.key === 'Escape') { close(); return; }
        if (e.ctrlKey || e.altKey || e.metaKey) return;
        if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    });

    // Отметка поставлена — обновить кнопки и маркеры в открытой карточке.
    document.addEventListener('krasavia:mark', () => { if (state) render(); });

    // Вызывается из обработчиков клика (Графплан, RMS, «Загрузка рейсов»).
    function maybeOpen(code, date) {
        if (!enabled()) return false;
        open(code, date);
        return true;
    }

    return { open, close, maybeOpen, syncToggle, enabled, isOpen: () => !!state };
})();
