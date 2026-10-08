// «Отчёты» → «Справочник»: периоды и суммы субсидии, себестоимость, ПКЗ из NAV (тарифы субсидии —
// раздел из reports-view.js). Что видно и что можно менять — по правам, которые выдаёт админ.
window.ReferenceView = (function () {
    const SECTION_KEY = 'krasavia_ref_section';
    let section = '';
    try { section = localStorage.getItem(SECTION_KEY) || ''; } catch (e) { /* ignore */ }

    let periodEdit = null;   // { flights: [..], ranges: [{from,to}] } — открытая форма периодов
    let amountEdit = null;   // запись суммы в форме ({} — новая)
    let navEdit = null;      // { date, flight, value } — запись ПКЗ в форме
    let amountFilter = '';
    let navMonth = '';
    let navFlight = '';

    function esc(v) {
        return typeof escHtml === 'function' ? escHtml(v) : String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function has(perm) {
        return typeof ProfileAuth !== 'undefined' && ProfileAuth.hasPermission(perm);
    }

    function toast(msg, type) {
        if (typeof showToast === 'function') showToast(msg, type);
    }

    function isoOf(ru) {
        const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(ru || ''));
        return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
    }

    function ruOf(iso) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
        return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
    }

    function fmtK(v) {
        if (v == null || v === '') return '—';
        return Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 1 });
    }

    function fmtRub(v) {
        return typeof formatRub === 'function' ? formatRub(v) : Math.round(v).toLocaleString('ru-RU') + ' ₽';
    }

    function when(at) {
        if (!at) return '';
        const d = new Date(at);
        return isNaN(d) ? '' : d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    // ---------- права и разделы ----------

    const SECTIONS = [
        { id: 'fares', label: 'Тарифы субсидии', view: () => typeof FareRefs !== 'undefined' && FareRefs.canView() },
        { id: 'periods', label: 'Периоды субсидии', view: () => typeof SubsidyRef !== 'undefined' && SubsidyRef.canView() },
        { id: 'amounts', label: 'Суммы субсидии и себестоимость', view: () => typeof SubsidyRef !== 'undefined' && SubsidyRef.canView() },
        { id: 'nav', label: 'ПКЗ из NAV', view: () => has('view_pkz_nav') || has('edit_pkz_nav') }
    ];

    function visibleSections() {
        return SECTIONS.filter(s => s.view());
    }

    function canAny() {
        return visibleSections().length > 0;
    }

    // ---------- периоды субсидии ----------

    function flightNum(code) {
        return parseInt(String(code || '').replace(/[^0-9]/g, ''), 10) || 0;
    }

    function pairCodes(code) {
        if (typeof getFlightPair !== 'function') return [code];
        const p = getFlightPair(code);
        return [p.outbound, p.inbound].filter(Boolean);
    }

    function directionOf(code) {
        return typeof getFlightDirection === 'function' ? getFlightDirection(code) : code;
    }

    // Рейсы, для которых имеют смысл периоды: межрегиональные из данных и все, что уже есть в файле/справочнике.
    function periodFlights() {
        const set = new Set();
        Object.keys(window.FLIGHT_DIRECTIONS || {}).forEach(c => set.add(c));
        Object.keys(typeof groupedData !== 'undefined' && groupedData ? groupedData : {}).forEach(base => {
            (groupedData[base] || []).forEach(r => { if (r && r[0] && typeof cleanFlight === 'function') set.add(cleanFlight(r[0])); });
        });
        const file = typeof RouteCosts !== 'undefined' && RouteCosts.fileData ? RouteCosts.fileData().periodsByNum : {};
        Object.keys(file || {}).forEach(n => set.add('KV-' + n));
        Object.keys(typeof SubsidyRef !== 'undefined' ? SubsidyRef.periods() : {}).forEach(n => set.add('KV-' + n));
        return [...set].filter(c => {
            if (!/^KV-\d+$/.test(c)) return false;
            const n = flightNum(c);
            if (file && file[n]) return true;
            if (typeof SubsidyRef !== 'undefined' && SubsidyRef.periods()[n]) return true;
            if (typeof FlightChecks !== 'undefined' && FlightChecks.isNeverSubsidized && FlightChecks.isNeverSubsidized(c)) return false;
            return typeof getFlightRouteType !== 'function' || getFlightRouteType(c) === 'interregional';
        }).sort((a, b) => flightNum(a) - flightNum(b));
    }

    function rangesText(ranges) {
        if (!ranges || !ranges.length) return '<span class="ref-ok">коммерции нет — субсидия весь период</span>';
        return ranges.map(r => `<span class="ref-range">${esc(r.from)} – ${esc(r.to)}</span>`).join(' ');
    }

    function sourceBadge(src) {
        if (src === 'ref') return '<span class="ref-src ref-src-ref">справочник</span>';
        if (src === 'file') return '<span class="ref-src ref-src-file">файл</span>';
        return '<span class="ref-src">нет данных</span>';
    }

    function periodsHtml() {
        const can = SubsidyRef.canEdit();
        const ref = SubsidyRef.periods();
        const flights = periodFlights();
        // Пары туда/обратно в одной строке, если периоды у них одинаковые.
        const rows = [];
        const done = new Set();
        flights.forEach(code => {
            if (done.has(code)) return;
            const pair = pairCodes(code).filter(c => flights.includes(c));
            const list = pair.length ? pair : [code];
            const texts = list.map(c => JSON.stringify((RouteCosts.periodsFor(c) || []).map(r => [r.from, r.to])));
            const srcs = list.map(c => RouteCosts.periodSource(flightNum(c)));
            const same = texts.every(t => t === texts[0]) && srcs.every(s => s === srcs[0]);
            (same ? [list] : list.map(c => [c])).forEach(group => {
                group.forEach(c => done.add(c));
                const first = group[0];
                const n = flightNum(first);
                const e = ref[n];
                rows.push(`
                    <tr>
                        <td class="rp-left"><strong>${esc(group.join(' / '))}</strong><div class="rp-sub-line">${esc(directionOf(first))}</div></td>
                        <td class="rp-left">${rangesText(RouteCosts.periodsFor(first))}</td>
                        <td>${sourceBadge(RouteCosts.periodSource(n))}</td>
                        <td class="rp-left rp-muted">${e ? esc(e.by || '') + (e.at ? '<br>' + esc(when(e.at)) : '') : ''}</td>
                        ${can ? `<td class="rp-nowrap">
                            <button type="button" class="filter-btn rp-open" data-refp-edit="${esc(group.join(','))}">Изменить</button>
                            ${e ? `<button type="button" class="filter-btn rp-open rp-danger" data-refp-reset="${esc(group.join(','))}" title="Убрать запись справочника — снова действует файл">Сбросить</button>` : ''}
                        </td>` : ''}
                    </tr>`);
            });
        });
        const options = flights.map(c => `<option value="${esc(c)}"${periodEdit && periodEdit.flights[0] === c ? ' selected' : ''}>${esc(c)} · ${esc(directionOf(c))}</option>`).join('');
        const pe = periodEdit;
        const other = pe ? pairCodes(pe.flights[0]).find(c => c !== pe.flights[0]) : '';
        const form = can && pe ? `
            <div class="rp-ref-form" id="ref-period-form">
                <div class="rp-ref-form-title">Периоды коммерции (без субсидии)</div>
                <div class="rp-ref-grid">
                    <label>Рейс<select id="ref-p-flight" class="cr-input">${options}</select></label>
                    <label class="rp-check rp-ref-pair"><input type="checkbox" id="ref-p-pair"${pe.flights.length > 1 ? ' checked' : ''}${other ? '' : ' disabled'}> и обратный <strong>${esc(other || '—')}</strong></label>
                </div>
                <div class="ref-ranges">
                    ${pe.ranges.map((r, i) => `
                        <div class="ref-range-row" data-ref-range="${i}">
                            <span class="ref-range-n">${i + 1}.</span>
                            <label>с <input type="date" class="cr-input" data-ref-from value="${esc(isoOf(r.from))}"></label>
                            <label>по <input type="date" class="cr-input" data-ref-to value="${esc(isoOf(r.to))}"></label>
                            <button type="button" class="filter-btn rp-danger" data-refp-del="${i}" title="Убрать период">✕</button>
                        </div>`).join('') || '<p class="rp-note">Периодов нет — рейс субсидируется в любую дату.</p>'}
                    <button type="button" class="filter-btn" data-refp-add>+ период коммерции</button>
                </div>
                <div class="rp-ref-actions">
                    <button type="button" class="btn-primary rp-btn" data-refp-save>Сохранить</button>
                    <button type="button" class="filter-btn" data-refp-cancel>Отмена</button>
                    <span class="rp-ref-error" id="ref-p-error" role="alert"></span>
                </div>
            </div>` : '';
        return `
            <section class="rp-card">
                <div class="rp-card-head"><h3 class="rp-card-title">Периоды субсидии по рейсам</h3>
                    ${can && !pe ? '<button type="button" class="btn-primary rp-btn" data-refp-new>Добавить рейс</button>' : ''}</div>
                <p class="rp-card-text">Как в файле «Период субсидии»: указываются периоды <strong>коммерции</strong> — даты, когда субсидии нет.
                    Вне этих дат рейс субсидируется (если для маршрута задана сумма субсидии). Запись справочника важнее файла;
                    «Сбросить» — снова брать даты из файла.</p>
                ${importHtml()}
                ${form}
                ${rows.length ? `<div class="rp-scroll"><table class="rp-table rp-refs-table">
                    <thead><tr><th>Рейсы</th><th>Коммерция (без субсидии)</th><th>Откуда</th><th>Изменил</th>${can ? '<th></th>' : ''}</tr></thead>
                    <tbody>${rows.join('')}</tbody></table></div>` : '<p class="rp-note">Нет рейсов: загрузите данные или добавьте рейс.</p>'}
            </section>`;
    }

    function importHtml() {
        if (!SubsidyRef.canEdit() || typeof RouteCosts === 'undefined' || !RouteCosts.fileData) return '';
        const f = RouteCosts.fileData();
        const nP = Object.keys(f.periodsByNum || {}).length;
        const nA = (f.costRows || []).length;
        if (!nP && !nA) return '';
        // Всё из файлов уже в справочнике — большой блок не нужен, только короткая подсказка.
        const refP = SubsidyRef.periods();
        const refA = SubsidyRef.amounts();
        const leftP = Object.keys(f.periodsByNum || {}).filter(n => !refP[n]).length;
        const leftA = new Set((f.costRows || []).map(r => SubsidyRef.amountKey(r.from, r.to, r.ac)).filter(k => k && !refA[k])).size;
        if (!leftP && !leftA) {
            return '<p class="rp-note">Всё из файлов «Период субсидии» и «Расходы» уже в справочнике — файлы можно удалить из папки.</p>';
        }
        return `
            <div class="ref-import">
                <div><strong>Перенести из файлов</strong>
                    <div class="rp-sub-line">Не перенесено: периоды — ${leftP} рейс(ов), маршрутов — ${leftA}. Перенесите один раз — после этого файлы «Период субсидии» и «Расходы» можно удалить из папки.</div></div>
                <label class="rp-check"><input type="checkbox" id="ref-import-overwrite"> заменить уже внесённое</label>
                <button type="button" class="btn-primary rp-btn" data-ref-import>Перенести</button>
            </div>`;
    }

    function readRanges() {
        const out = [];
        document.querySelectorAll('#ref-period-form [data-ref-range]').forEach(row => {
            out.push({
                from: ruOf(row.querySelector('[data-ref-from]')?.value || ''),
                to: ruOf(row.querySelector('[data-ref-to]')?.value || '')
            });
        });
        return out;
    }

    function readPeriodFlights() {
        const code = document.getElementById('ref-p-flight')?.value || (periodEdit && periodEdit.flights[0]) || '';
        const pair = document.getElementById('ref-p-pair');
        const other = pairCodes(code).find(c => c !== code);
        return pair && pair.checked && other ? [code, other] : [code];
    }

    function startPeriodEdit(flights) {
        const first = flights[0];
        const ranges = (RouteCosts.periodsFor(first) || []).map(r => ({ from: r.from, to: r.to }));
        periodEdit = { flights, ranges };
    }

    // ---------- суммы субсидии и себестоимость ----------

    function amountsHtml() {
        const can = SubsidyRef.canEdit();
        const q = amountFilter.trim().toLowerCase();
        const all = RouteCosts.amountRows();
        const list = q ? all.filter(e => `${e.from} ${e.to} ${e.acLabel}`.toLowerCase().includes(q)) : all;
        const rows = list.map(e => `
            <tr>
                <td class="rp-left"><strong>${esc(e.from)} — ${esc(e.to)}</strong></td>
                <td>${esc(e.acLabel)}</td>
                <td>${e.subsidy ? `<strong>${fmtK(e.subsidy)}</strong><div class="rp-sub-line">≈ ${esc(fmtRub(e.subsidy / 2 * 1000))} на рейс</div>` : '—'}</td>
                <td>${fmtK(e.costSub)}</td>
                <td>${fmtK(e.costCom)}</td>
                <td>${sourceBadge(e.source)}</td>
                ${can ? `<td class="rp-nowrap">
                    <button type="button" class="filter-btn rp-open" data-refa-edit="${esc(e.key)}">Изменить</button>
                    ${e.source === 'ref' ? `<button type="button" class="filter-btn rp-open rp-danger" data-refa-del="${esc(e.key)}" title="Убрать запись справочника — снова действует файл (если есть)">Удалить</button>` : ''}
                </td>` : ''}
            </tr>`).join('');
        const cities = [...new Set(all.flatMap(e => [e.from, e.to]))].sort((a, b) => a.localeCompare(b, 'ru'));
        const acs = Object.values(RouteCosts.acLabels ? RouteCosts.acLabels() : {});
        all.forEach(e => { if (!acs.includes(e.acLabel)) acs.push(e.acLabel); });
        const ae = amountEdit;
        const form = can && ae ? `
            <div class="rp-ref-form" id="ref-amount-form">
                <div class="rp-ref-form-title">${ae.key ? 'Изменить маршрут' : 'Новый маршрут'}</div>
                <datalist id="ref-cities">${cities.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
                <div class="rp-ref-grid">
                    <label>Город 1<input id="ref-a-from" class="cr-input" list="ref-cities" maxlength="60" value="${esc(ae.from || '')}"></label>
                    <label>Город 2<input id="ref-a-to" class="cr-input" list="ref-cities" maxlength="60" value="${esc(ae.to || '')}"></label>
                    <label>Тип ВС<select id="ref-a-ac" class="cr-input">${acs.map(a => `<option${a === (ae.acLabel || ae.ac) ? ' selected' : ''}>${esc(a)}</option>`).join('')}</select></label>
                    <label>Субсидия, тыс. ₽<input id="ref-a-sub" class="cr-input" type="number" min="0" step="0.001" value="${esc(ae.subsidy != null ? ae.subsidy : '')}"></label>
                    <label>Себестоимость при субсидии, тыс. ₽<input id="ref-a-csub" class="cr-input" type="number" min="0" step="0.001" value="${esc(ae.costSub != null ? ae.costSub : '')}"></label>
                    <label>Себестоимость коммерческая, тыс. ₽<input id="ref-a-ccom" class="cr-input" type="number" min="0" step="0.001" value="${esc(ae.costCom != null ? ae.costCom : '')}"></label>
                </div>
                <div class="rp-ref-actions">
                    <button type="button" class="btn-primary rp-btn" data-refa-save>Сохранить</button>
                    <button type="button" class="filter-btn" data-refa-cancel>Отмена</button>
                    <span class="rp-ref-error" id="ref-a-error" role="alert"></span>
                </div>
            </div>` : '';
        return `
            <section class="rp-card">
                <div class="rp-card-head"><h3 class="rp-card-title">Суммы субсидии и себестоимость по маршрутам</h3>
                    ${can && !ae ? '<button type="button" class="btn-primary rp-btn" data-refa-new>Добавить маршрут</button>' : ''}</div>
                <p class="rp-card-text">Как в файле «Расходы»: суммы в <strong>тыс. ₽ за пару рейсов туда-обратно</strong> (на один рейс — половина).
                    Субсидия действует в даты вне периодов коммерции. Себестоимость при субсидии и коммерческая — для экономической таблицы и расчёта расходов.
                    Пустое поле — значение берётся из файла.</p>
                ${importHtml()}
                ${form}
                <div class="ref-toolbar"><input type="search" class="cr-input" id="ref-a-filter" placeholder="Поиск: город или тип ВС" value="${esc(amountFilter)}"></div>
                ${rows ? `<div class="rp-scroll"><table class="rp-table rp-refs-table">
                    <thead><tr><th>Маршрут</th><th>Тип ВС</th><th>Субсидия</th><th>Себест. при субсидии</th><th>Себест. коммерч.</th><th>Откуда</th>${can ? '<th></th>' : ''}</tr></thead>
                    <tbody>${rows}</tbody></table></div>` : `<p class="rp-note">${q ? 'Ничего не найдено.' : 'Нет данных: загрузите файл «Расходы» или добавьте маршрут.'}</p>`}
            </section>`;
    }

    // ---------- ПКЗ из NAV ----------

    function monthNow() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }

    function allFlightCodes() {
        const set = new Set();
        Object.keys(typeof groupedData !== 'undefined' && groupedData ? groupedData : {}).forEach(base => {
            (groupedData[base] || []).forEach(r => { if (r && r[0] && typeof cleanFlight === 'function') set.add(cleanFlight(r[0])); });
        });
        return [...set].filter(c => /^KV-\d+$/.test(c)).sort((a, b) => flightNum(a) - flightNum(b));
    }

    function navHtml() {
        const can = has('edit_pkz_nav');
        const month = navMonth || monthNow();
        const [y, m] = month.split('-');
        const all = typeof SharedOverrides !== 'undefined' && SharedOverrides.listPkzNav ? SharedOverrides.listPkzNav() : [];
        const list = all
            .filter(e => e.date.slice(3) === `${m}.${y}`)
            .filter(e => !navFlight || e.flight === navFlight)
            .sort((a, b) => (typeof compareDateStr === 'function' ? compareDateStr(a.date, b.date) : 0) || flightNum(a.flight) - flightNum(b.flight));
        const total = list.reduce((s, e) => s + (Number(e.value) || 0), 0);
        const codes = allFlightCodes();
        all.forEach(e => { if (!codes.includes(e.flight)) codes.push(e.flight); });
        const ne = navEdit;
        const form = can && ne ? `
            <div class="rp-ref-form" id="ref-nav-form">
                <div class="rp-ref-form-title">${ne.date ? 'Изменить ПКЗ' : 'Новое значение ПКЗ'}</div>
                <div class="rp-ref-grid">
                    <label>Дата вылета<input id="ref-n-date" class="cr-input" type="date" value="${esc(isoOf(ne.date))}"></label>
                    <label>Рейс<select id="ref-n-flight" class="cr-input">${codes.map(c => `<option${c === ne.flight ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
                    <label>ПКЗ из NAV, кг<input id="ref-n-value" class="cr-input" type="number" min="0" step="1" value="${esc(ne.value != null ? ne.value : '')}"></label>
                </div>
                <div class="rp-ref-actions">
                    <button type="button" class="btn-primary rp-btn" data-refn-save>Сохранить</button>
                    <button type="button" class="filter-btn" data-refn-cancel>Отмена</button>
                    <span class="rp-ref-error" id="ref-n-error" role="alert"></span>
                </div>
            </div>` : '';
        const rows = list.map(e => `
            <tr>
                <td>${esc(e.date)}</td>
                <td><strong>${esc(e.flight)}</strong><div class="rp-sub-line">${esc(directionOf(e.flight))}</div></td>
                <td><strong>${esc(Number(e.value).toLocaleString('ru-RU'))}</strong> кг</td>
                <td class="rp-left rp-muted">${esc(e.by || '')}${e.at ? '<br>' + esc(when(e.at)) : ''}</td>
                ${can ? `<td class="rp-nowrap">
                    <button type="button" class="filter-btn rp-open" data-refn-edit="${esc(e.date + '|' + e.flight)}">Изменить</button>
                    <button type="button" class="filter-btn rp-open rp-danger" data-refn-del="${esc(e.date + '|' + e.flight)}">Удалить</button>
                </td>` : ''}
            </tr>`).join('');
        return `
            <section class="rp-card">
                <div class="rp-card-head"><h3 class="rp-card-title">ПКЗ из NAV</h3>
                    ${can && !ne ? '<button type="button" class="btn-primary rp-btn" data-refn-new>Добавить</button>' : ''}</div>
                <p class="rp-card-text">Платная коммерческая загрузка по данным NAV, кг на вылет. Те же значения, что в столбце «ПКЗ из NAV» на вкладке «ПКЗ».</p>
                ${form}
                <div class="ref-toolbar">
                    <label>Месяц <input type="month" class="cr-input" id="ref-n-month" value="${esc(month)}"></label>
                    <label>Рейс <select class="cr-input" id="ref-n-filter"><option value="">все</option>${codes.map(c => `<option${c === navFlight ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
                    <span class="rp-muted">Записей: ${list.length}${list.length ? ` · всего ${esc(total.toLocaleString('ru-RU'))} кг` : ''}</span>
                </div>
                ${rows ? `<div class="rp-scroll"><table class="rp-table rp-refs-table">
                    <thead><tr><th>Дата</th><th>Рейс</th><th>ПКЗ</th><th>Изменил</th>${can ? '<th></th>' : ''}</tr></thead>
                    <tbody>${rows}</tbody></table></div>` : '<p class="rp-note">За этот месяц значений нет.</p>'}
            </section>`;
    }

    // ---------- общий каркас ----------

    function html(faresHtml) {
        const list = visibleSections();
        if (!list.length) return '<p class="rp-note">Нет доступа к справочнику — права выдаёт администратор.</p>';
        if (!list.some(s => s.id === section)) section = list[0].id;
        let body = '';
        if (section === 'fares') body = faresHtml();
        else if (section === 'periods') body = periodsHtml();
        else if (section === 'amounts') body = amountsHtml();
        else if (section === 'nav') body = navHtml();
        return `
            <div class="ref-sections" role="tablist">${list.map(s => `
                <button type="button" class="ref-section${s.id === section ? ' ref-section-on' : ''}" data-ref-section="${s.id}" aria-selected="${s.id === section}">${esc(s.label)}</button>`).join('')}
            </div>
            ${body}`;
    }

    function showError(id, msg) {
        const el = document.getElementById(id);
        if (el) el.textContent = msg || '';
        else if (msg) toast(msg, 'error');
    }

    async function run(btn, job, errId, after) {
        btn.disabled = true;
        try {
            const res = await job();
            if (!res || !res.ok) {
                showError(errId, (res && res.error) || 'Не удалось сохранить');
                return false;
            }
            if (after) after(res);
            return true;
        } catch (e) {
            console.error(e);
            showError(errId, 'Не удалось сохранить');
            return false;
        } finally {
            btn.disabled = false;
        }
    }

    function refreshAll() {
        if (typeof FlightChecks !== 'undefined' && FlightChecks.refreshViews) FlightChecks.refreshViews();
        if (typeof refreshCurrentView === 'function' && typeof currentTab !== 'undefined' && currentTab !== 'reports') refreshCurrentView();
    }

    // Клик по кнопке справочника. true — обработано (rerender — перерисовать вкладку).
    function handleClick(btn, rerender) {
        const d = btn.dataset;
        if (d.refSection) {
            section = d.refSection;
            try { localStorage.setItem(SECTION_KEY, section); } catch (e) { /* ignore */ }
            rerender();
            return true;
        }
        if (d.refImport != null) {
            const overwrite = !!document.getElementById('ref-import-overwrite')?.checked;
            if (!window.confirm(overwrite
                ? 'Перенести данные файлов в справочник и ЗАМЕНИТЬ уже внесённые записи?'
                : 'Перенести данные файлов в справочник? Уже внесённые записи не изменятся.')) return true;
            run(btn, () => SubsidyRef.importFromFiles({ overwrite }), null, (res) => {
                toast(`Перенесено: периоды — ${res.periods}, маршруты — ${res.amounts}. Теперь файлы можно удалить.`);
                refreshAll();
                rerender();
            });
            return true;
        }
        // периоды
        if (d.refpNew != null) {
            const first = periodFlights()[0];
            if (!first) { toast('Нет рейсов — загрузите данные', 'error'); return true; }
            startPeriodEdit(pairCodes(first).length > 1 ? pairCodes(first) : [first]);
            periodEdit.ranges = [];
            rerender();
            return true;
        }
        if (d.refpEdit) {
            startPeriodEdit(d.refpEdit.split(','));
            rerender();
            document.getElementById('ref-period-form')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return true;
        }
        if (d.refpAdd != null && periodEdit) {
            periodEdit.flights = readPeriodFlights();
            periodEdit.ranges = readRanges().concat([{ from: '', to: '' }]);
            rerender();
            return true;
        }
        if (d.refpDel != null && periodEdit) {
            periodEdit.flights = readPeriodFlights();
            const ranges = readRanges();
            ranges.splice(Number(d.refpDel), 1);
            periodEdit.ranges = ranges;
            rerender();
            return true;
        }
        if (d.refpCancel != null) { periodEdit = null; rerender(); return true; }
        if (d.refpSave != null) {
            const flights = readPeriodFlights();
            const ranges = readRanges();
            if (ranges.some(r => !r.from || !r.to)) { showError('ref-p-error', 'Заполните обе даты в каждом периоде'); return true; }
            run(btn, () => SubsidyRef.setPeriods(flights, ranges), 'ref-p-error', () => {
                periodEdit = null;
                toast('Периоды сохранены');
                refreshAll();
                rerender();
            });
            return true;
        }
        if (d.refpReset) {
            const flights = d.refpReset.split(',');
            if (!window.confirm(`Убрать периоды ${flights.join(' / ')} из справочника? Снова будут действовать даты из файла (если он загружен).`)) return true;
            run(btn, () => SubsidyRef.clearPeriods(flights), null, () => { refreshAll(); rerender(); });
            return true;
        }
        // суммы
        if (d.refaNew != null) { amountEdit = {}; rerender(); return true; }
        if (d.refaEdit) {
            const e = RouteCosts.amountRows().find(x => x.key === d.refaEdit);
            if (!e) return true;
            const own = SubsidyRef.amounts()[e.key];
            amountEdit = own ? { ...own, key: e.key, acLabel: e.acLabel } : { ...e };
            rerender();
            document.getElementById('ref-amount-form')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return true;
        }
        if (d.refaCancel != null) { amountEdit = null; rerender(); return true; }
        if (d.refaSave != null) {
            const val = (id) => document.getElementById(id)?.value ?? '';
            const entry = { from: val('ref-a-from'), to: val('ref-a-to'), ac: val('ref-a-ac'), subsidy: val('ref-a-sub'), costSub: val('ref-a-csub'), costCom: val('ref-a-ccom') };
            run(btn, () => SubsidyRef.setAmount(entry, amountEdit && amountEdit.key), 'ref-a-error', () => {
                amountEdit = null;
                toast('Маршрут сохранён');
                refreshAll();
                rerender();
            });
            return true;
        }
        if (d.refaDel) {
            if (!window.confirm('Удалить запись справочника по этому маршруту? Если маршрут есть в файле «Расходы», снова будут действовать суммы из файла.')) return true;
            run(btn, () => SubsidyRef.removeAmount(d.refaDel), null, () => { refreshAll(); rerender(); });
            return true;
        }
        // ПКЗ из NAV
        if (d.refnNew != null) { navEdit = { date: '', flight: navFlight || '', value: null }; rerender(); return true; }
        if (d.refnEdit) {
            const [date, flight] = d.refnEdit.split('|');
            navEdit = { date, flight, value: SharedOverrides.getPkzNav(date, flight) };
            rerender();
            document.getElementById('ref-nav-form')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return true;
        }
        if (d.refnCancel != null) { navEdit = null; rerender(); return true; }
        if (d.refnSave != null) {
            const date = ruOf(document.getElementById('ref-n-date')?.value || '');
            const flight = document.getElementById('ref-n-flight')?.value || '';
            const value = document.getElementById('ref-n-value')?.value ?? '';
            if (!date || !flight) { showError('ref-n-error', 'Укажите дату и рейс'); return true; }
            if (value === '' || !(Number(value) >= 0)) { showError('ref-n-error', 'Укажите ПКЗ в кг'); return true; }
            run(btn, async () => {
                // Сменили дату или рейс — старое значение убираем.
                if (navEdit && navEdit.date && (navEdit.date !== date || navEdit.flight !== flight)) {
                    await SharedOverrides.setPkzNav(navEdit.date, navEdit.flight, '');
                }
                const ok = await SharedOverrides.setPkzNav(date, flight, value);
                return ok ? { ok: true } : { ok: false, error: 'Нет права менять ПКЗ' };
            }, 'ref-n-error', () => {
                navEdit = null;
                navMonth = isoOf(date).slice(0, 7);
                toast('ПКЗ сохранено');
                refreshAll();
                rerender();
            });
            return true;
        }
        if (d.refnDel) {
            const [date, flight] = d.refnDel.split('|');
            if (!window.confirm(`Удалить ПКЗ ${flight} за ${date}?`)) return true;
            run(btn, async () => ({ ok: await SharedOverrides.setPkzNav(date, flight, '') }), null, () => { refreshAll(); rerender(); });
            return true;
        }
        return false;
    }

    function handleChange(target, rerender) {
        if (target.id === 'ref-p-flight' && periodEdit) {
            // Другой рейс — в форму его текущие периоды.
            const code = target.value;
            const other = pairCodes(code).find(c => c !== code);
            const withPair = !!other && document.getElementById('ref-p-pair')?.checked !== false;
            startPeriodEdit(withPair ? [code, other] : [code]);
            rerender();
            return true;
        }
        if (target.id === 'ref-n-month') { navMonth = target.value || ''; rerender(); return true; }
        if (target.id === 'ref-n-filter') { navFlight = target.value || ''; rerender(); return true; }
        return false;
    }

    let filterTimer = null;
    function handleInput(target, rerender) {
        if (target.id !== 'ref-a-filter') return false;
        amountFilter = target.value || '';
        clearTimeout(filterTimer);
        filterTimer = setTimeout(() => {
            rerender();
            const el = document.getElementById('ref-a-filter');
            if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
        }, 250);
        return true;
    }

    function openSection(id) {
        section = id;
        try { localStorage.setItem(SECTION_KEY, id); } catch (e) { /* ignore */ }
    }

    return { html, canAny, handleClick, handleChange, handleInput, openSection };
})();
