// «Отчёты» → «Справочник»: периоды и суммы субсидии, себестоимость, ПКЗ из NAV (тарифы субсидии —
// раздел из reports-view.js). Что видно и что можно менять — по правам, которые выдаёт админ.
window.ReferenceView = (function () {
    const SECTION_KEY = 'krasavia_ref_section';
    let section = '';
    try { section = localStorage.getItem(SECTION_KEY) || ''; } catch (e) { /* ignore */ }

    let periodEdit = null;   // { flights: [..], ranges: [{from,to}] } — открытая форма периодов
    let amountEdit = null;   // запись суммы в форме ({} — новая)
    let navEdit = null;      // правило ПКЗ в форме ({ id, from, to, direction, ac, value })
    let amountFilter = '';
    let navFlight = '';      // фильтр по направлению

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
        { id: 'check', label: 'Проверка полноты', view: () => typeof SubsidyRef !== 'undefined' && SubsidyRef.canView() },
        { id: 'fares', label: 'Тарифы субсидии', view: () => typeof FareRefs !== 'undefined' && FareRefs.canView() },
        { id: 'periods', label: 'Периоды субсидии', view: () => typeof SubsidyRef !== 'undefined' && SubsidyRef.canView() },
        { id: 'amounts', label: 'Суммы субсидии и себестоимость', view: () => typeof SubsidyRef !== 'undefined' && SubsidyRef.canView() },
        { id: 'nav', label: 'ПКЗ из NAV', view: () => typeof SubsidyRef !== 'undefined' && SubsidyRef.canViewPkz() }
    ];

    function visibleSections() {
        return SECTIONS.filter(s => s.view());
    }

    function hasDataNow() {
        return typeof groupedData !== 'undefined' && groupedData && Object.keys(groupedData).length > 0;
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
        // Только базовые номера: доп. рейс (KV-301, KV-355…) — тот же рейс, у него свои периоды не ведутся.
        const bases = new Set([...set].map(c => (/^KV-\d+$/.test(c) && typeof getBaseFlight === 'function' ? getBaseFlight(c) : c)));
        return [...bases].filter(c => {
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
                <td>${fmtK(e.cost)}${e.cost != null ? `<div class="rp-sub-line">≈ ${esc(fmtRub(e.cost / 2 * 1000))} на рейс</div>` : ''}</td>
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
                    <label>Себестоимость, тыс. ₽<input id="ref-a-cost" class="cr-input" type="number" min="0" step="0.001" value="${esc(ae.cost != null ? ae.cost : '')}"></label>
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
                    Субсидия действует в даты вне периодов коммерции. Себестоимость одна на маршрут и тип ВС — для экономической таблицы и расчёта расходов.
                    Пустое поле — значение берётся из файла.</p>
                ${importHtml()}
                ${form}
                <div class="ref-toolbar"><input type="search" class="cr-input" id="ref-a-filter" placeholder="Поиск: город или тип ВС" value="${esc(amountFilter)}"></div>
                ${rows ? `<div class="rp-scroll"><table class="rp-table rp-refs-table">
                    <thead><tr><th>Маршрут</th><th>Тип ВС</th><th>Субсидия</th><th>Себестоимость</th><th>Откуда</th>${can ? '<th></th>' : ''}</tr></thead>
                    <tbody>${rows}</tbody></table></div>` : `<p class="rp-note">${q ? 'Ничего не найдено.' : 'Нет данных: загрузите файл «Расходы» или добавьте маршрут.'}</p>`}
            </section>`;
    }

    // ---------- ПКЗ из NAV: правила «период + тип ВС + направление» ----------

    function dataRows() {
        const out = [];
        Object.keys(typeof groupedData !== 'undefined' && groupedData ? groupedData : {}).forEach(base => {
            (groupedData[base] || []).forEach(r => { if (r && r[0]) out.push(r); });
        });
        return out;
    }

    // Направления в одну сторону — по базовым рейсам из данных и из уже заведённых правил.
    function directionOptions() {
        const set = new Set();
        dataRows().forEach(r => {
            const code = typeof cleanFlight === 'function' ? cleanFlight(r[0]) : r[0];
            const base = typeof getBaseFlight === 'function' ? getBaseFlight(code) : code;
            const d = directionOf(base);
            if (d && d !== base) set.add(d);
        });
        Object.values(SubsidyRef.pkzRules()).forEach(r => set.add(r.direction));
        return [...set].sort((a, b) => a.localeCompare(b, 'ru'));
    }

    function acOptions() {
        const set = new Set();
        dataRows().forEach(r => {
            const ac = typeof getAircraftType === 'function' ? getAircraftType(r[4]) : r[4];
            if (ac && ac !== '-') set.add(ac);
        });
        Object.values(SubsidyRef.pkzRules()).forEach(r => { if (r.ac) set.add(r.ac); });
        return [...set].sort((a, b) => a.localeCompare(b, 'ru'));
    }

    // Сколько вылетов в загруженных данных получат это правило (с учётом более точных правил).
    function pkzMatches(id) {
        let n = 0;
        dataRows().forEach(r => {
            const code = typeof cleanFlight === 'function' ? cleanFlight(r[0]) : r[0];
            const rule = SubsidyRef.pkzRules()[id];
            if (!rule || typeof compareDateStr !== 'function') return;
            if (compareDateStr(r[1], rule.from) < 0 || compareDateStr(r[1], rule.to) > 0) return;
            if (SubsidyRef.pkzFor(r[1], code, r[4]) === rule.value) n++;
        });
        return n;
    }

    function navHtml() {
        const can = SubsidyRef.canEditPkz();
        const rules = SubsidyRef.pkzRules();
        const dirs = directionOptions();
        const acs = acOptions();
        const list = Object.keys(rules).map(id => ({ id, ...rules[id] }))
            .filter(r => !navFlight || r.direction === navFlight)
            .sort((a, b) => a.direction.localeCompare(b.direction, 'ru') || (typeof compareDateStr === 'function' ? compareDateStr(a.from, b.from) : 0));
        const ne = navEdit;
        const form = can && ne ? `
            <div class="rp-ref-form" id="ref-nav-form">
                <div class="rp-ref-form-title">${ne.id ? 'Изменить правило' : 'Новое правило ПКЗ'}</div>
                <div class="rp-ref-grid">
                    <label>Период с<input id="ref-n-from" class="cr-input" type="date" value="${esc(isoOf(ne.from))}"></label>
                    <label>по<input id="ref-n-to" class="cr-input" type="date" value="${esc(isoOf(ne.to))}"></label>
                    <label>Направление (в одну сторону)<select id="ref-n-dir" class="cr-input">${dirs.map(d => `<option${d === ne.direction ? ' selected' : ''}>${esc(d)}</option>`).join('')}</select></label>
                    <label>Тип ВС<select id="ref-n-ac" class="cr-input"><option value="">любой</option>${acs.map(a => `<option${a === ne.ac ? ' selected' : ''}>${esc(a)}</option>`).join('')}</select></label>
                    <label>ПКЗ из NAV, кг<input id="ref-n-value" class="cr-input" type="number" min="0" step="1" value="${esc(ne.value != null ? ne.value : '')}"></label>
                </div>
                <div class="rp-ref-actions">
                    <button type="button" class="btn-primary rp-btn" data-refn-save>Сохранить</button>
                    <button type="button" class="filter-btn" data-refn-cancel>Отмена</button>
                    <span class="rp-ref-error" id="ref-n-error" role="alert"></span>
                </div>
            </div>` : '';
        const rows = list.map(r => `
            <tr>
                <td class="rp-nowrap">${esc(r.from)} – ${esc(r.to)}</td>
                <td class="rp-left"><strong>${esc(r.direction)}</strong></td>
                <td>${r.ac ? esc(r.ac) : '<span class="rp-muted">любой</span>'}</td>
                <td><strong>${esc(Number(r.value).toLocaleString('ru-RU'))}</strong> кг</td>
                <td>${pkzMatches(r.id)}</td>
                <td class="rp-left rp-muted">${esc(r.by || '')}${r.at ? '<br>' + esc(when(r.at)) : ''}</td>
                ${can ? `<td class="rp-nowrap">
                    <button type="button" class="filter-btn rp-open" data-refn-edit="${esc(r.id)}">Изменить</button>
                    <button type="button" class="filter-btn rp-open" data-refn-copy="${esc(r.id)}" title="Новое правило на основе этого">Копия</button>
                    <button type="button" class="filter-btn rp-open rp-danger" data-refn-del="${esc(r.id)}">Удалить</button>
                </td>` : ''}
            </tr>`).join('');
        return `
            <section class="rp-card">
                <div class="rp-card-head"><h3 class="rp-card-title">ПКЗ из NAV</h3>
                    ${can && !ne ? '<button type="button" class="btn-primary rp-btn" data-refn-new>Добавить правило</button>' : ''}</div>
                <p class="rp-card-text">Правило: <strong>период + направление в одну сторону + тип ВС → ПКЗ, кг</strong>. Значение само подставляется во все
                    вылеты, которые подходят (вкладка «ПКЗ», «Творческая», карточки). Обратное направление — отдельное правило.
                    Если подходят несколько — берётся правило с конкретным типом ВС, затем с более поздним началом периода.
                    Ручное значение, введённое в таблице «ПКЗ» для конкретного вылета, важнее правила.</p>
                ${form}
                <div class="ref-toolbar">
                    <label>Направление <select class="cr-input" id="ref-n-filter"><option value="">все</option>${dirs.map(d => `<option${d === navFlight ? ' selected' : ''}>${esc(d)}</option>`).join('')}</select></label>
                    <span class="rp-muted">Правил: ${list.length}</span>
                </div>
                ${rows ? `<div class="rp-scroll"><table class="rp-table rp-refs-table">
                    <thead><tr><th>Период</th><th>Направление</th><th>Тип ВС</th><th>ПКЗ</th><th>Вылетов</th><th>Изменил</th>${can ? '<th></th>' : ''}</tr></thead>
                    <tbody>${rows}</tbody></table></div>` : '<p class="rp-note">Правил пока нет.</p>'}
            </section>`;
    }

    // ---------- проверка полноты (без ПКЗ) ----------
    // На 60 дней вперёд: рейсы без периодов, маршруты без себестоимости, субсидированные вылеты без суммы
    // субсидии, пересекающиеся периоды. Считается только при открытии раздела и в утренней сводке.

    const CHECK_DAYS = 60;
    let checkMemo = { sig: '', res: null };

    function checkSig() {
        return [typeof dataEpoch === 'number' ? dataEpoch : 0, typeof getTodayDate === 'function' ? getTodayDate() : '',
            SubsidyRef.revision(), typeof allData !== 'undefined' && allData ? allData.length : 0].join('|');
    }

    function completeness() {
        const sig = checkSig();
        if (checkMemo.sig === sig && checkMemo.res) return checkMemo.res;
        const noPeriods = new Map();
        const noCost = new Map();
        const noSub = new Map();
        const noRoute = new Map();
        const add = (map, key, init, code, date) => {
            const e = map.get(key) || map.set(key, { ...init, n: 0, flights: new Set(), first: date }).get(key);
            e.n++;
            e.flights.add(code);
            if (typeof compareDateStr === 'function' && compareDateStr(date, e.first) < 0) e.first = date;
        };
        const never = (c) => typeof FlightChecks !== 'undefined' && FlightChecks.isNeverSubsidized && FlightChecks.isNeverSubsidized(c);
        dataRows().forEach(r => {
            const d = typeof getDaysUntil === 'function' ? getDaysUntil(r[1]) : null;
            if (d == null || d < 0 || d > CHECK_DAYS) return;
            const code = typeof cleanFlight === 'function' ? cleanFlight(r[0]) : r[0];
            const base = typeof getBaseFlight === 'function' ? getBaseFlight(code) : code;
            const inter = typeof getFlightRouteType === 'function' && getFlightRouteType(base) === 'interregional';
            const econ = RouteCosts.lookup(r, code, r[1]);
            if (!econ.from || !econ.to) {
                add(noRoute, base, { base }, code, r[1]);
                return;
            }
            const rk = SubsidyRef.amountKey(econ.from, econ.to, econ.ac);
            if (econ.unitCost == null) add(noCost, rk, { from: econ.from, to: econ.to, ac: econ.ac }, code, r[1]);
            if (!inter || never(base)) return;
            if (!RouteCosts.periodSource(flightNum(base)) && !(RouteCosts.periodsFor(base) || []).length) {
                // Туда и обратно — одной строкой.
                const pair = pairCodes(base).filter(c => !RouteCosts.periodSource(flightNum(c)));
                const key = (pair.length ? pair : [base]).join(' / ');
                add(noPeriods, key, { base: key, codes: pair.length ? pair : [base] }, code, r[1]);
            }
            const manual = typeof SharedOverrides !== 'undefined' && SharedOverrides.hasSubsidy(code, r[1]);
            if (!econ.commercial && !manual && !(Number(econ.subsidyOneWay) > 0)) {
                add(noSub, rk, { from: econ.from, to: econ.to, ac: econ.ac }, code, r[1]);
            }
        });
        const overlaps = [];
        const ref = SubsidyRef.periods();
        Object.keys(ref).forEach(n => {
            const rs = (ref[n].ranges || []).slice().sort((a, b) => compareDateStr(a.from, b.from));
            for (let i = 1; i < rs.length; i++) {
                if (compareDateStr(rs[i].from, rs[i - 1].to) <= 0) {
                    overlaps.push({ base: 'KV-' + n, a: rs[i - 1], b: rs[i] });
                    break;
                }
            }
        });
        const list = (m) => [...m.values()].sort((a, b) => b.n - a.n);
        const res = { noPeriods: list(noPeriods), noCost: list(noCost), noSub: list(noSub), noRoute: list(noRoute), overlaps };
        res.total = res.noPeriods.length + res.noCost.length + res.noSub.length + res.noRoute.length + res.overlaps.length;
        checkMemo = { sig, res };
        return res;
    }

    function flightsText(set) {
        const a = [...set].sort((x, y) => flightNum(x) - flightNum(y));
        return a.slice(0, 6).join(', ') + (a.length > 6 ? ` и ещё ${a.length - 6}` : '');
    }

    function checkHtml() {
        const can = SubsidyRef.canEdit();
        const r = completeness();
        const block = (title, hint, items, row) => items.length ? `
            <div class="ref-check-block">
                <div class="ref-check-title">${esc(title)} <span class="ref-check-n">${items.length}</span></div>
                <div class="rp-sub-line">${esc(hint)}</div>
                <div class="rp-scroll"><table class="rp-table rp-refs-table"><tbody>${items.map(row).join('')}</tbody></table></div>
            </div>` : '';
        const routeCell = (e) => `<td class="rp-left"><strong>${esc(e.from)} — ${esc(e.to)}</strong> · ${esc(e.ac || 'тип ВС?')}</td>`;
        const usage = (e) => `<td class="rp-left rp-muted">${e.n} вылет(ов), ближайший ${esc(e.first)} · ${esc(flightsText(e.flights))}</td>`;
        const fix = (attr, label) => (can ? `<td class="rp-nowrap"><button type="button" class="filter-btn rp-open" ${attr}>${label}</button></td>` : '');
        const body = [
            block('Рейсы без периодов субсидии', 'Записи в «Периодах субсидии» нет, в файле тоже — сейчас рейс считается субсидируемым во все даты. Если коммерции нет, сохраните пустой список — и рейс уйдёт из проверки.',
                r.noPeriods, e => `<tr><td class="rp-left"><strong>${esc(e.base)}</strong> · ${esc(directionOf(e.codes[0]))}</td>${usage(e)}${fix(`data-refp-edit="${esc(e.codes.join(','))}"`, 'Задать периоды')}</tr>`),
            block('Субсидированные вылеты без суммы субсидии', 'Даты вне коммерции, но суммы субсидии для маршрута и типа ВС нет — в экономике субсидия будет 0.',
                r.noSub, e => `<tr>${routeCell(e)}${usage(e)}${fix(`data-refa-prefill="${esc(JSON.stringify({ from: e.from, to: e.to, ac: e.ac }))}"`, 'Добавить сумму')}</tr>`),
            block('Маршруты без себестоимости', 'Для маршрута и типа ВС нет себестоимости — экономика и финрезультат по этим вылетам неполные.',
                r.noCost, e => `<tr>${routeCell(e)}${usage(e)}${fix(`data-refa-prefill="${esc(JSON.stringify({ from: e.from, to: e.to, ac: e.ac }))}"`, 'Добавить')}</tr>`),
            block('Пересекающиеся периоды', 'Периоды коммерции одного рейса заходят друг на друга — проверьте даты.',
                r.overlaps, e => `<tr><td class="rp-left"><strong>${esc(e.base)}</strong></td><td class="rp-left">${esc(e.a.from)} – ${esc(e.a.to)} и ${esc(e.b.from)} – ${esc(e.b.to)}</td>${fix(`data-refp-edit="${esc(e.base)}"`, 'Исправить')}</tr>`),
            block('Маршрут рейса не определён', 'Не удалось понять города рейса — суммы по нему не подставляются. Сообщите администратору.',
                r.noRoute, e => `<tr><td class="rp-left"><strong>${esc(e.base)}</strong></td>${usage(e)}</tr>`)
        ].join('');
        return `
            <section class="rp-card">
                <div class="rp-card-head"><h3 class="rp-card-title">Проверка полноты справочника</h3></div>
                <p class="rp-card-text">Вылеты на ${CHECK_DAYS} дней вперёд по загруженным данным: всё ли есть для субсидии и экономики. ПКЗ из NAV здесь не проверяется.</p>
                ${typeof groupedData === 'undefined' || !Object.keys(groupedData || {}).length ? '<p class="rp-note">Нет данных: загрузите файлы — проверка идёт по вылетам из них.</p>'
                    : (body || '<p class="ref-ok ref-check-ok">Всё заполнено: пропусков на ближайшие 60 дней нет.</p>')}
            </section>`;
    }

    // ---------- Excel: выгрузка и загрузка справочника ----------
    // Листы: «Тарифы», «Периоды», «Суммы», «ПКЗ» — только разделы, которые профиль видит.
    // Загрузка добавляет и обновляет записи из файла; чего в файле нет — остаётся как было.

    const SHEETS = {
        fares: { name: 'Тарифы', head: ['Рейсы', 'Код тарифа', 'Предел, ₽', 'Детский предел, ₽', 'Комментарий'] },
        periods: { name: 'Периоды', head: ['Рейс', 'Коммерция с', 'Коммерция по'] },
        amounts: { name: 'Суммы', head: ['Город 1', 'Город 2', 'Тип ВС', 'Субсидия, тыс. ₽ (пара)', 'Себестоимость, тыс. ₽ (пара)'] },
        nav: { name: 'ПКЗ', head: ['Период с', 'Период по', 'Направление (в одну сторону)', 'Тип ВС (пусто — любой)', 'ПКЗ, кг'] }
    };

    function canEditSection(id) {
        if (id === 'fares') return typeof FareRefs !== 'undefined' && FareRefs.canEdit();
        if (id === 'nav') return SubsidyRef.canEditPkz();
        return SubsidyRef.canEdit();
    }

    function viewSection(id) {
        const sec = SECTIONS.find(x => x.id === id);
        return !!(sec && sec.view());
    }

    async function xlsxLib() {
        const styled = typeof loadStyledXlsx === 'function' ? await loadStyledXlsx() : null;
        return styled || (typeof XLSX !== 'undefined' ? XLSX : null);
    }

    function sheetRows(id) {
        if (id === 'fares') {
            return FareRefs.list().filter(e => e.mode === 'limit')
                .map(e => [e.flights.join(', '), e.fareCode || '', e.adult, e.child != null ? e.child : '', e.note || '']);
        }
        if (id === 'periods') {
            const out = [];
            periodFlights().forEach(c => {
                const rs = RouteCosts.periodsFor(c) || [];
                if (!rs.length) { if (RouteCosts.periodSource(flightNum(c))) out.push([c, '', '']); return; }
                rs.forEach(r => out.push([c, r.from, r.to]));
            });
            return out;
        }
        if (id === 'amounts') {
            return RouteCosts.amountRows().map(e => [e.from, e.to, e.acLabel, e.subsidy != null ? e.subsidy : '', e.cost != null ? e.cost : '']);
        }
        if (id === 'nav') {
            return Object.values(SubsidyRef.pkzRules()).map(r => [r.from, r.to, r.direction, r.ac || '', r.value]);
        }
        return [];
    }

    async function exportExcel() {
        const lib = await xlsxLib();
        if (!lib) { toast('Библиотека Excel не загружена', 'error'); return; }
        const wb = lib.utils.book_new();
        let n = 0;
        ['fares', 'periods', 'amounts', 'nav'].forEach(id => {
            if (!viewSection(id)) return;
            const ws = lib.utils.aoa_to_sheet([SHEETS[id].head].concat(sheetRows(id)));
            ws['!cols'] = SHEETS[id].head.map((h, i) => ({ wch: i === 0 || h.length > 14 ? 26 : 16 }));
            lib.utils.book_append_sheet(wb, ws, SHEETS[id].name);
            n++;
        });
        if (!n) { toast('Нет доступа к справочнику', 'error'); return; }
        const day = typeof getTodayDate === 'function' ? getTodayDate() : '';
        const name = typeof excelDailyFilename === 'function' ? excelDailyFilename('КРАСАВИА_справочник', day) : `КРАСАВИА_справочник_${day}.xlsx`;
        const saved = typeof excelSaveWorkbook === 'function' ? await excelSaveWorkbook(lib, wb, name, null) : (lib.writeFile(wb, name), null);
        if (typeof ActivityLog !== 'undefined') ActivityLog.log('export', 'Справочник');
        if (saved && typeof excelAnnounceSaved === 'function') excelAnnounceSaved(saved, 'Справочник выгружен');
        else toast('Справочник выгружен');
    }

    // Дата из ячейки: «ДД.ММ.ГГГГ», «ГГГГ-ММ-ДД» или число Excel.
    function cellDate(v) {
        if (v == null || v === '') return '';
        if (typeof v === 'number' && v > 20000 && v < 80000) {
            const d = new Date(Math.round((v - 25569) * 86400000));
            return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;
        }
        const t = String(v).trim();
        let m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(t);
        if (m) return `${m[1].padStart(2, '0')}.${m[2].padStart(2, '0')}.${m[3]}`;
        m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
        return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
    }

    function cellNum(v) {
        if (v == null || v === '') return null;
        const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[\s ₽]/g, '').replace(',', '.'));
        return isFinite(n) ? n : null;
    }

    function readSheet(lib, wb, id) {
        const ws = wb.Sheets[SHEETS[id].name];
        if (!ws) return null;
        const rows = lib.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
        return rows.slice(1).filter(r => r.some(c => String(c).trim() !== ''));
    }

    // Разбор файла → что изменится. errors — строки, которые не поняли (с номером строки листа).
    function planImport(lib, wb) {
        const plan = { fares: [], periods: {}, amounts: [], nav: [], errors: [], sheets: [] };
        const fares = viewSection('fares') && canEditSection('fares') ? readSheet(lib, wb, 'fares') : null;
        if (fares) {
            plan.sheets.push('Тарифы');
            fares.forEach((r, i) => {
                const flights = String(r[0] || '').split(/[,;\s]+/).filter(Boolean).map(c => (/^\d+$/.test(c) ? 'KV-' + c : c.toUpperCase()));
                const adult = cellNum(r[2]);
                if (!flights.length || !(adult > 0)) { plan.errors.push(`Тарифы, строка ${i + 2}: нужен рейс и предел больше 0`); return; }
                plan.fares.push({ flights, fareCode: String(r[1] || ''), adult, child: cellNum(r[3]), note: String(r[4] || '') });
            });
        }
        const periods = viewSection('periods') && canEditSection('periods') ? readSheet(lib, wb, 'periods') : null;
        if (periods) {
            plan.sheets.push('Периоды');
            periods.forEach((r, i) => {
                const n = flightNum(r[0]);
                if (!n) { plan.errors.push(`Периоды, строка ${i + 2}: не понятен рейс`); return; }
                const from = cellDate(r[1]);
                const to = cellDate(r[2]);
                if (!plan.periods[n]) plan.periods[n] = [];
                if (!from && !to) return; // пустые даты — «коммерции нет»
                if (!from || !to) { plan.errors.push(`Периоды, строка ${i + 2}: нужны обе даты`); return; }
                plan.periods[n].push({ from, to });
            });
        }
        const amounts = viewSection('amounts') && canEditSection('amounts') ? readSheet(lib, wb, 'amounts') : null;
        if (amounts) {
            plan.sheets.push('Суммы');
            amounts.forEach((r, i) => {
                const e = { from: String(r[0] || '').trim(), to: String(r[1] || '').trim(), ac: String(r[2] || '').trim(), subsidy: cellNum(r[3]), cost: cellNum(r[4]) };
                if (!SubsidyRef.amountKey(e.from, e.to, e.ac) || (e.subsidy == null && e.cost == null)) {
                    plan.errors.push(`Суммы, строка ${i + 2}: нужны два города, тип ВС и хотя бы одна сумма`);
                    return;
                }
                plan.amounts.push(e);
            });
        }
        const nav = viewSection('nav') && canEditSection('nav') ? readSheet(lib, wb, 'nav') : null;
        if (nav) {
            plan.sheets.push('ПКЗ');
            nav.forEach((r, i) => {
                const e = { from: cellDate(r[0]), to: cellDate(r[1]), direction: String(r[2] || '').trim(), ac: String(r[3] || '').trim(), value: cellNum(r[4]) };
                if (!e.from || !e.to || !SubsidyRef.dirKey(e.direction) || e.value == null) {
                    plan.errors.push(`ПКЗ, строка ${i + 2}: нужны обе даты, направление «Город — Город» и ПКЗ`);
                    return;
                }
                plan.nav.push(e);
            });
        }
        return plan;
    }

    async function importExcel(file, rerender) {
        const lib = await xlsxLib();
        if (!lib || !file) return;
        let wb;
        try {
            wb = lib.read(await file.arrayBuffer(), { type: 'array', cellDates: false });
        } catch (e) {
            toast('Не удалось прочитать файл Excel', 'error');
            return;
        }
        const plan = planImport(lib, wb);
        if (!plan.sheets.length) {
            toast('В файле нет листов справочника, которые вам можно менять (Тарифы, Периоды, Суммы, ПКЗ)', 'error');
            return;
        }
        const nP = Object.keys(plan.periods).length;
        const lines = [
            plan.fares.length ? `Тарифы: ${plan.fares.length} записей` : '',
            nP ? `Периоды: ${nP} рейсов (периоды этих рейсов заменятся)` : '',
            plan.amounts.length ? `Суммы: ${plan.amounts.length} маршрутов` : '',
            plan.nav.length ? `ПКЗ: ${plan.nav.length} правил` : ''
        ].filter(Boolean);
        if (!lines.length) {
            toast('В файле нет строк для загрузки' + (plan.errors.length ? ` (ошибок: ${plan.errors.length})` : ''), 'error');
            return;
        }
        const errText = plan.errors.length
            ? `\n\nНе загрузятся (${plan.errors.length}):\n${plan.errors.slice(0, 8).join('\n')}${plan.errors.length > 8 ? '\n…' : ''}` : '';
        if (!window.confirm(`Загрузить в справочник?\n\n${lines.join('\n')}\n\nЗаписи из файла добавятся или обновятся, остальные останутся как были.${errText}`)) return;
        const r1 = plan.fares.length ? await FareRefs.upsertMany(plan.fares) : { ok: true };
        const r2 = (nP || plan.amounts.length || plan.nav.length)
            ? await SubsidyRef.applyImport({ periods: plan.periods, amounts: plan.amounts, pkz: plan.nav }) : { ok: true };
        if (!r1.ok || !r2.ok) {
            toast((r1.error || r2.error) || 'Не удалось сохранить', 'error');
        } else {
            toast('Справочник загружен из Excel: ' + lines.join(', '));
            if (typeof ActivityLog !== 'undefined') ActivityLog.log('fare_refs', 'Справочник из Excel: ' + lines.join(', '));
        }
        refreshAll();
        rerender();
    }

    function excelBarHtml() {
        const canImport = ['fares', 'periods', 'amounts', 'nav'].some(id => viewSection(id) && canEditSection(id));
        return `
            <div class="ref-excel">
                <button type="button" class="filter-btn" data-ref-xl-export title="Все разделы справочника, которые вам видны, — отдельными листами">⬇ Выгрузить в Excel</button>
                ${canImport ? `<button type="button" class="filter-btn" data-ref-xl-import title="Тот же формат, что у выгрузки: можно выгрузить, поправить и загрузить обратно">⬆ Загрузить из Excel</button>
                <input type="file" id="ref-xl-file" accept=".xlsx,.xls" hidden>` : ''}
            </div>`;
    }

    // ---------- общий каркас ----------

    function html(faresHtml) {
        const list = visibleSections();
        if (!list.length) return '<p class="rp-note">Нет доступа к справочнику — права выдаёт администратор.</p>';
        if (!list.some(s => s.id === section)) section = list[0].id;
        let body = '';
        if (section === 'check') body = checkHtml();
        else if (section === 'fares') body = faresHtml();
        else if (section === 'periods') body = periodsHtml();
        else if (section === 'amounts') body = amountsHtml();
        else if (section === 'nav') body = navHtml();
        return `
            ${excelBarHtml()}
            <div class="ref-sections" role="tablist">${list.map(s => `
                <button type="button" class="ref-section${s.id === section ? ' ref-section-on' : ''}" data-ref-section="${s.id}" aria-selected="${s.id === section}">${esc(s.label)}${s.id === 'check' && hasDataNow() && completeness().total ? ` <span class="ref-section-badge">${completeness().total}</span>` : ''}</button>`).join('')}
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
        if (d.refXlExport != null) {
            exportExcel().catch(e => { console.error(e); toast('Ошибка выгрузки', 'error'); });
            return true;
        }
        if (d.refXlImport != null) {
            const input = document.getElementById('ref-xl-file');
            if (input) {
                input.value = '';
                input.onchange = () => {
                    const f = input.files && input.files[0];
                    if (f) importExcel(f, rerender).catch(e => { console.error(e); toast('Ошибка загрузки', 'error'); });
                };
                input.click();
            }
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
            if (section === 'check') openSection('periods');
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
        if (d.refaPrefill) {
            let pre = {};
            try { pre = JSON.parse(d.refaPrefill); } catch (e) { /* ignore */ }
            const key = SubsidyRef.amountKey(pre.from, pre.to, pre.ac);
            const own = key && SubsidyRef.amounts()[key];
            amountEdit = own ? { ...own, key } : { from: pre.from, to: pre.to, acLabel: pre.ac, ac: pre.ac };
            openSection('amounts');
            rerender();
            document.getElementById('ref-amount-form')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return true;
        }
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
            const entry = { from: val('ref-a-from'), to: val('ref-a-to'), ac: val('ref-a-ac'), subsidy: val('ref-a-sub'), cost: val('ref-a-cost') };
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
        if (d.refnNew != null) { navEdit = { from: '', to: '', direction: navFlight || '', ac: '', value: null }; rerender(); return true; }
        if (d.refnEdit || d.refnCopy) {
            const id = d.refnEdit || d.refnCopy;
            const r = SubsidyRef.pkzRules()[id];
            if (!r) return true;
            navEdit = { ...r, id: d.refnEdit ? id : '' };
            rerender();
            document.getElementById('ref-nav-form')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return true;
        }
        if (d.refnCancel != null) { navEdit = null; rerender(); return true; }
        if (d.refnSave != null) {
            const val = (id) => document.getElementById(id)?.value ?? '';
            const entry = { from: ruOf(val('ref-n-from')), to: ruOf(val('ref-n-to')), direction: val('ref-n-dir'), ac: val('ref-n-ac'), value: val('ref-n-value') };
            if (!entry.from || !entry.to) { showError('ref-n-error', 'Укажите период: обе даты'); return true; }
            if (entry.value === '' || !(Number(entry.value) >= 0)) { showError('ref-n-error', 'Укажите ПКЗ в кг'); return true; }
            run(btn, () => SubsidyRef.setPkzRule(entry, navEdit && navEdit.id), 'ref-n-error', () => {
                navEdit = null;
                toast('Правило ПКЗ сохранено');
                refreshAll();
                rerender();
            });
            return true;
        }
        if (d.refnDel) {
            const r = SubsidyRef.pkzRules()[d.refnDel];
            if (!r || !window.confirm(`Удалить правило ПКЗ ${r.direction}, ${r.from} – ${r.to}?`)) return true;
            run(btn, () => SubsidyRef.removePkzRule(d.refnDel), null, () => { refreshAll(); rerender(); });
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

    function completenessCount() {
        return typeof SubsidyRef !== 'undefined' && SubsidyRef.canView() && hasDataNow() ? completeness().total : 0;
    }

    return { completenessCount, html, canAny, handleClick, handleChange, handleInput, openSection };
})();
