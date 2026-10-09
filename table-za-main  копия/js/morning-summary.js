// Утренняя сводка: что требует внимания сегодня. Открывается сама один раз в день (на профиль),
// потом — по значку «☀ N» в шапке. Считается после старта в фоне, порциями (не тормозит вход).
//  • ждут решения: вылеты из «Управления продажами» на 15 дней с подсказкой (▼ / ! / ▲) и без отметки за сегодня;
//  • ошибки тарифов: рейсы до вылета с ошибкой проверки;
//  • пропуски справочника (только тем, кто видит справочник).
window.MorningSummary = (function () {
    const SEEN_KEY = 'krasavia_morning_seen_';
    let advice = [];          // все подсказки окна (до фильтра по отметкам)
    let builtFor = '';
    let building = null;

    function esc(v) {
        return typeof escHtml === 'function' ? escHtml(v) : String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function profile() {
        return typeof ProfileAuth !== 'undefined' && ProfileAuth.getCurrentProfile ? ProfileAuth.getCurrentProfile() : null;
    }

    function enabled() {
        return !!profile() && typeof ProfileAuth.featureOn === 'function' && ProfileAuth.featureOn('morning_summary');
    }

    function canTab(t) {
        return typeof ProfileAuth === 'undefined' || ProfileAuth.canAccessTab(t);
    }

    function aheadDays() {
        return typeof SalesAdvice !== 'undefined' ? SalesAdvice.DAYS_AHEAD : 15;
    }

    function today() {
        return typeof getTodayDate === 'function' ? getTodayDate() : '';
    }

    function sig() {
        return [typeof dataEpoch === 'number' ? dataEpoch : 0, today(), profile() ? profile().id : '',
            typeof allData !== 'undefined' && allData ? allData.length : 0, salesDepartures().size].join('|');
    }

    function hasData() {
        return typeof groupedData !== 'undefined' && groupedData && Object.keys(groupedData).length > 0;
    }

    // Вылеты, которые есть во вкладке «Управление продажами» (с учётом выбранных там маршрутов).
    // Список УП тот же (кэш в SalesManagement) — набор вылетов не пересобираем.
    let depCache = { list: null, set: new Set() };
    function salesDepartures() {
        if (typeof SalesManagement === 'undefined' || !SalesManagement.listFlights) return new Set();
        try {
            const list = SalesManagement.listFlights();
            if (depCache.list === list) return depCache.set;
            const set = new Set();
            list.forEach(f => (f.departures || []).forEach(d => set.add(d.code + '|' + d.date)));
            depCache = { list, set };
            return set;
        } catch (e) {
            console.warn('MorningSummary.salesDepartures', e);
            return new Set();
        }
    }

    // Подсказки только по вылетам из «Управления продажами», по которым сегодня ещё никто не отметился.
    function pending() {
        const t = today();
        const inSales = salesDepartures();
        return advice.filter(a => inSales.has(a.code + '|' + a.date)
            && !SalesManagement.getMarks(a.code, a.date, t).length);
    }

    function fareErrors() {
        if (typeof FlightChecks === 'undefined' || !FlightChecks.enabled()) return 0;
        return new Set(FlightChecks.list().filter(i => i.state !== 'Улетел').map(i => i.code + '|' + i.date)).size;
    }

    function refGaps() {
        return typeof ReferenceView !== 'undefined' && ReferenceView.completenessCount ? ReferenceView.completenessCount() : 0;
    }

    function adviceAllowed() {
        return canTab('sales') && typeof SalesManagement !== 'undefined';
    }

    async function build() {
        if (!enabled() || !hasData()) return;
        const s = sig();
        if (builtFor === s) return;
        if (building) return building;
        building = (async () => {
            advice = adviceAllowed() && typeof SalesAdvice !== 'undefined' ? await SalesAdvice.scanAll(salesDepartures()) : [];
            builtFor = s;
            if (typeof updateHeaderStatus === 'function') updateHeaderStatus();
        })().finally(() => { building = null; });
        return building;
    }

    function seenToday() {
        try { return localStorage.getItem(SEEN_KEY + (profile() ? profile().id : '')) === today(); } catch (e) { return false; }
    }

    function markSeen() {
        try { localStorage.setItem(SEEN_KEY + (profile() ? profile().id : ''), today()); } catch (e) { /* ignore */ }
    }

    function total() {
        return pending().length + fareErrors() + refGaps();
    }

    // После входа: посчитать и, если есть что показать и сегодня ещё не показывали, открыть.
    async function afterStart() {
        if (!enabled()) return;
        await new Promise(r => setTimeout(r, 1200));
        await build();
        if (!enabled() || seenToday() || !total()) return;
        open();
    }

    function headerChip() {
        if (!enabled() || builtFor !== sig()) return null;
        const n = pending().length;
        if (!n) return null;
        const chip = document.createElement('span');
        chip.className = 'header-kpi-morning';
        chip.textContent = '☀ ' + n;
        chip.title = `Сводка: ${n} вылет(ов) на ${aheadDays()} дней ждут решения сегодня. Нажмите, чтобы открыть.`;
        chip.addEventListener('click', open);
        return chip;
    }

    const ORDER = { down: 0, attn: 1, up: 2 };

    function render() {
        const box = document.getElementById('morning-body');
        if (!box) return;
        const list = pending().sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.dtd - b.dtd || String(a.code).localeCompare(String(b.code), 'ru', { numeric: true }));
        const counts = { down: 0, attn: 0, up: 0 };
        list.forEach(a => { counts[a.status]++; });
        const fe = fareErrors();
        const gaps = refGaps();
        const shown = list.slice(0, 40);
        const label = typeof SalesAdvice !== 'undefined' ? SalesAdvice.LABEL : {};
        const dir = (code) => (typeof getFlightDirection === 'function' ? getFlightDirection(code) : '');
        const rows = shown.map(a => `
            <tr class="ms-row" data-ms-code="${esc(a.code)}" data-ms-date="${esc(a.date)}">
                <td><span class="ms-badge sm-suggest-${a.status}">${esc(label[a.status] || a.status)}</span></td>
                <td class="ms-nowrap"><strong>${esc(a.code)}</strong> ${esc(a.date)}</td>
                <td class="ms-muted">${esc(dir(a.code))}</td>
                <td>${esc(a.text)}</td>
                <td class="ms-nowrap"><button type="button" class="filter-btn rp-open" data-ms-sales="${esc(a.code)}" data-ms-date="${esc(a.date)}">В УП</button></td>
            </tr>`).join('');
        box.innerHTML = `
            <div class="ms-tiles">
                ${adviceAllowed() ? `<div class="ms-tile"><div class="ms-tile-n">${list.length}</div><div class="ms-tile-l">ждут решения<br><span class="ms-muted">▼ ${counts.down} · ! ${counts.attn} · ▲ ${counts.up}</span></div></div>` : ''}
                ${typeof FlightChecks !== 'undefined' && FlightChecks.enabled() ? `<button type="button" class="ms-tile ms-tile-btn" data-ms-open="checks"><div class="ms-tile-n${fe ? ' ms-bad' : ''}">${fe}</div><div class="ms-tile-l">рейсов с ошибкой тарифа<br><span class="ms-muted">открыть проверку →</span></div></button>` : ''}
                ${typeof SubsidyRef !== 'undefined' && SubsidyRef.canView() ? `<button type="button" class="ms-tile ms-tile-btn" data-ms-open="refs"><div class="ms-tile-n${gaps ? ' ms-warn' : ''}">${gaps}</div><div class="ms-tile-l">пропусков в справочнике<br><span class="ms-muted">открыть проверку →</span></div></button>` : ''}
            </div>
            ${adviceAllowed() ? (list.length ? `
                <p class="ms-note">Вылеты из «Управления продажами» на ${aheadDays()} дней, где продажи заметно расходятся с нормой и планом, а отметки за сегодня ещё нет. Нажмите строку — карточка рейса, «В УП» — поставить отметку.</p>
                <div class="ms-scroll"><table class="ms-table"><tbody>${rows}</tbody></table></div>
                ${list.length > shown.length ? `<p class="ms-note">Показаны первые ${shown.length} из ${list.length}.</p>` : ''}`
                : '<p class="ms-note ms-ok">По вылетам на ' + aheadDays() + ' дней всё в норме или уже отмечено сегодня.</p>') : ''}`;
    }

    function ensureModal() {
        let m = document.getElementById('morning-modal');
        if (m) return m;
        m = document.createElement('div');
        m.id = 'morning-modal';
        m.className = 'profile-admin-modal morning-modal';
        m.innerHTML = `
            <div class="profile-admin-backdrop" data-ms-close></div>
            <div class="profile-admin-panel morning-panel" role="dialog" aria-label="Сводка на сегодня">
                <div class="profile-admin-header">
                    <h3 id="morning-title">Сводка</h3>
                    <button type="button" class="profile-admin-close" data-ms-close>✕</button>
                </div>
                <div class="profile-admin-body" id="morning-body"></div>
            </div>`;
        document.body.appendChild(m);
        m.addEventListener('click', onClick);
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && m.classList.contains('open')) close(); });
        return m;
    }

    function close() {
        document.getElementById('morning-modal')?.classList.remove('open');
    }

    async function open() {
        if (!enabled()) return;
        const m = ensureModal();
        const title = document.getElementById('morning-title');
        if (title) title.textContent = `Сводка на ${today()}`;
        m.classList.add('open');
        markSeen();
        if (builtFor !== sig()) {
            const box = document.getElementById('morning-body');
            if (box) box.innerHTML = '<p class="ms-note">Считаю…</p>';
            await build();
        }
        render();
    }

    function onClick(e) {
        if (e.target.closest('[data-ms-close]')) { close(); return; }
        const sales = e.target.closest('[data-ms-sales]');
        if (sales) {
            close();
            if (typeof openSalesManagementFor === 'function') openSalesManagementFor(sales.dataset.msSales, sales.dataset.msDate);
            return;
        }
        const op = e.target.closest('[data-ms-open]');
        if (op) {
            close();
            if (typeof ReportsView !== 'undefined') {
                if (op.dataset.msOpen === 'refs' && typeof ReferenceView !== 'undefined') {
                    ReportsView.showSubtab('refs');
                    ReferenceView.openSection('check');
                } else {
                    ReportsView.showSubtab('checks');
                }
            }
            if (typeof switchMainTab === 'function') switchMainTab('reports');
            return;
        }
        const row = e.target.closest('[data-ms-code]');
        if (row && typeof FlightCard !== 'undefined') FlightCard.maybeOpen(row.dataset.msCode, row.dataset.msDate);
    }

    // Отметка поставлена — счётчик в шапке и открытая сводка обновляются.
    document.addEventListener('krasavia:mark', () => {
        if (typeof updateHeaderStatus === 'function') updateHeaderStatus();
        if (document.getElementById('morning-modal')?.classList.contains('open')) render();
    });

    return { afterStart, build, open, close, headerChip, pending };
})();
