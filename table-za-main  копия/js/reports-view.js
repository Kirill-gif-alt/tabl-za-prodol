// Вкладка «Отчёты»: выгрузки в Excel одной кнопкой.
// «Загрузка рейсов» и «Управление продажами» — те же файлы, что кнопки на своих вкладках.
// «Для экономистов» — факт кресел в продаже за прошлую неделю (пн–вс) и план загрузки
// на следующую неделю (пн–вс), отдельно ВВЛ и МВЛ (см. getFlightLineType в cities.js).
// План загрузки — ожидаемые пассажиры в день вылета из файла прогноза загрузки (0 дней до вылета).
window.ReportsView = (function () {
    const LINE_LABELS = { vvl: 'ВВЛ', mvl: 'МВЛ' };
    const ROUTE_LABELS = { krai: 'краевые', interregional: 'межрегиональные', unknown: 'не классифицированы' };

    let previewSig = '';
    let checksFutureOnly = true;

    function hasPerm(perm) {
        if (typeof ProfileAuth === 'undefined' || typeof ProfileAuth.hasPermission !== 'function') return true;
        return ProfileAuth.hasPermission(perm);
    }

    function canTab(tab) {
        if (typeof ProfileAuth === 'undefined' || typeof ProfileAuth.canAccessTab !== 'function') return true;
        return ProfileAuth.canAccessTab(tab);
    }

    function toast(msg, type) {
        if (typeof showToast === 'function') showToast(msg, type);
    }

    function hasData() {
        return typeof groupedData !== 'undefined' && groupedData && Object.keys(groupedData).length > 0;
    }

    function esc(v) {
        return typeof escHtml === 'function' ? escHtml(v) : String(v == null ? '' : v);
    }

    function fmt(n) {
        return n == null || isNaN(n) ? '—' : Number(n).toLocaleString('ru-RU', { maximumFractionDigits: 0 });
    }

    // ---------- недели ----------

    function startOfDay(d) {
        const t = new Date(d.getTime());
        t.setHours(0, 0, 0, 0);
        return t;
    }

    function addDays(d, n) {
        return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
    }

    function weekBounds(now) {
        const today = startOfDay(now || new Date());
        const monday = addDays(today, -((today.getDay() + 6) % 7));
        return {
            past: { from: addDays(monday, -7), to: addDays(monday, -1) },
            next: { from: addDays(monday, 7), to: addDays(monday, 13) }
        };
    }

    function ru(d) {
        return typeof formatDateRu === 'function' ? formatDateRu(d) : d.toLocaleDateString('ru-RU');
    }

    function weekLabel(w) {
        return `${ru(w.from)} (пн) – ${ru(w.to)} (вс)`;
    }

    // ---------- данные отчёта для экономистов ----------

    function lineOf(code) {
        return typeof getFlightLineType === 'function' ? getFlightLineType(code) : 'vvl';
    }

    function routeTypeOf(code) {
        const t = typeof getFlightRouteType === 'function' ? getFlightRouteType(code) : 'unknown';
        return ROUTE_LABELS[t] ? t : 'unknown';
    }

    function planLoad(row, base) {
        if (typeof getExpectedLoad !== 'function') return null;
        const ac = typeof getAircraftType === 'function' ? getAircraftType(row[4]) : '';
        const cap = typeof getCapacityFromAircraft === 'function' ? getCapacityFromAircraft(ac) : 0;
        const wk = typeof getWeekForExpectedLoad === 'function' ? getWeekForExpectedLoad(row[1]) : null;
        if (!cap || wk == null) return null;
        const ev = getExpectedLoad(cap, base, 0, wk);
        return ev == null || isNaN(ev) ? null : Math.ceil(ev);
    }

    // Один вылет (рейс + дата) считается один раз: у рейса из нескольких участков берётся первый,
    // как для продаж (buildFirstSalesRowByKey), иначе кресла и рейсы задвоятся.
    function collectWeek(week, withPlan) {
        const out = [];
        const seen = new Set();
        const fromT = week.from.getTime();
        const toT = week.to.getTime();
        Object.keys(groupedData || {}).forEach(base => {
            if (typeof isValidFlightBase === 'function' && !isValidFlightBase(base)) return;
            (groupedData[base] || []).forEach(row => {
                if (!row || !row[0] || !row[1]) return;
                const d = parseLocalDate(row[1]);
                if (!d) return;
                const t = d.getTime();
                if (t < fromT || t > toT) return;
                const code = cleanFlight(row[0]);
                const once = code + '|' + row[1];
                if (seen.has(once)) return;
                seen.add(once);
                const seats = typeof getSeatsOnSale === 'function' ? getSeatsOnSale(row) : 0;
                const sold = typeof getSoldFromRow === 'function' ? getSoldFromRow(row) : 0;
                out.push({
                    date: row[1],
                    time: d.getTime(),
                    dow: typeof DAYS_RU !== 'undefined' ? DAYS_RU[d.getDay()] : '',
                    code,
                    base,
                    direction: typeof getFlightDirection === 'function' ? getFlightDirection(code) : code,
                    aircraft: typeof getAircraftType === 'function' ? getAircraftType(row[4]) : '',
                    line: lineOf(code),
                    routeType: routeTypeOf(code),
                    seats,
                    sold,
                    plan: withPlan ? planLoad(row, base) : null
                });
            });
        });
        out.sort((a, b) => (a.time - b.time) || String(a.code).localeCompare(String(b.code), 'ru', { numeric: true }));
        return out;
    }

    function sumUp(list) {
        const acc = { flights: 0, seats: 0, sold: 0, plan: 0, planned: 0, planSeats: 0, noPlan: 0 };
        list.forEach(f => {
            acc.flights++;
            acc.seats += f.seats || 0;
            acc.sold += f.sold || 0;
            if (f.plan != null) {
                acc.plan += f.plan;
                acc.planSeats += f.seats || 0;
                acc.planned++;
            } else {
                acc.noPlan++;
            }
        });
        return acc;
    }

    function pct(a, b) {
        return b > 0 ? Math.round(a / b * 100) : null;
    }

    function categories(list) {
        const vvl = list.filter(f => f.line === 'vvl');
        const mvl = list.filter(f => f.line === 'mvl');
        const rows = [{ label: 'ВВЛ', list: vvl, level: 0 }];
        ['krai', 'interregional', 'unknown'].forEach(type => {
            const part = vvl.filter(f => f.routeType === type);
            if (part.length || type !== 'unknown') rows.push({ label: 'в т.ч. ' + ROUTE_LABELS[type], list: part, level: 1 });
        });
        rows.push({ label: 'МВЛ', list: mvl, level: 0 });
        rows.push({ label: 'Всего', list, level: 0, total: true });
        return rows.map(r => ({ ...r, sum: sumUp(r.list) }));
    }

    function byDay(list, week) {
        const days = [];
        for (let i = 0; i < 7; i++) {
            const d = addDays(week.from, i);
            const date = ru(d);
            const items = list.filter(f => f.date === date);
            days.push({
                date,
                dow: typeof DAYS_RU !== 'undefined' ? DAYS_RU[d.getDay()] : '',
                vvl: sumUp(items.filter(f => f.line === 'vvl')),
                mvl: sumUp(items.filter(f => f.line === 'mvl')),
                all: sumUp(items)
            });
        }
        return days;
    }

    function buildEconReport(now) {
        const weeks = weekBounds(now);
        const past = collectWeek(weeks.past, false);
        const next = collectWeek(weeks.next, true);
        return {
            weeks,
            past,
            next,
            pastDays: byDay(past, weeks.past),
            nextDays: byDay(next, weeks.next),
            pastCats: categories(past),
            nextCats: categories(next),
            hasExpected: typeof expectedLoadData !== 'undefined' && expectedLoadData && Object.keys(expectedLoadData).length > 0
        };
    }

    // ---------- Excel: отчёт для экономистов ----------

    const NAVY = '012A4A';
    const SECTION = '1A5276';
    const ZEBRA = 'F7F9FB';
    const TOTAL = 'E2E8F0';

    function style(fill, color, bold, horizontal, numFmt) {
        const edge = { style: 'thin', color: { rgb: '5D6D7E' } };
        const s = {
            fill: { patternType: 'solid', fgColor: { rgb: fill || 'FFFFFF' } },
            font: { name: 'Calibri', sz: 11, bold: !!bold, color: { rgb: color || '1C2833' } },
            alignment: { horizontal: horizontal || 'center', vertical: 'center', wrapText: true },
            border: { top: edge, bottom: edge, left: edge, right: edge }
        };
        if (numFmt) s.numFmt = numFmt;
        return s;
    }

    function sheetWriter(lib) {
        const ws = {};
        const merges = [];
        let maxR = 0;
        let maxC = 0;
        function put(r, c, value, s) {
            let cell;
            if (value == null || value === '') cell = { t: 's', v: '' };
            else if (typeof value === 'number' && isFinite(value)) cell = { t: 'n', v: value, z: '#,##0' };
            else cell = { t: 's', v: String(value) };
            if (s) cell.s = s;
            ws[lib.utils.encode_cell({ r, c })] = cell;
            if (r > maxR) maxR = r;
            if (c > maxC) maxC = c;
        }
        function title(r, text, width, s) {
            put(r, 0, text, s);
            for (let c = 1; c < width; c++) put(r, c, '', s);
            if (width > 1) merges.push({ s: { r, c: 0 }, e: { r, c: width - 1 } });
        }
        function table(r, headers, rows) {
            headers.forEach((h, c) => put(r, c, h, style(NAVY, 'FFFFFF', true)));
            rows.forEach((row, i) => {
                const fill = row.total ? TOTAL : (i % 2 ? ZEBRA : 'FFFFFF');
                row.cells.forEach((v, c) => {
                    const left = c === 0 || (row.leftCols && row.leftCols.indexOf(c) !== -1);
                    put(r + 1 + i, c, v, style(fill, '1C2833', !!row.total || row.level === 0 && row.bold, left ? 'left' : (typeof v === 'number' ? 'right' : 'center')));
                });
            });
            return r + 1 + rows.length;
        }
        function finish(cols, freeze) {
            ws['!ref'] = lib.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });
            ws['!merges'] = merges;
            ws['!cols'] = cols.map(w => ({ wch: w }));
            if (freeze) ws['!views'] = [{ state: 'frozen', ySplit: freeze, topLeftCell: 'A' + (freeze + 1), activePane: 'bottomLeft' }];
            return ws;
        }
        return { put, title, table, finish };
    }

    function blank(v) {
        return v == null ? '' : v;
    }

    function summarySheet(lib, rep, stamp) {
        const w = sheetWriter(lib);
        const width = 7;
        const titleStyle = style('FFFFFF', NAVY, true, 'left');
        const sectionStyle = style(SECTION, 'FFFFFF', true, 'left');
        const noteStyle = { font: { name: 'Calibri', sz: 10, italic: true, color: { rgb: '475569' } }, alignment: { horizontal: 'left', vertical: 'top', wrapText: true } };
        let r = 0;
        w.title(r++, 'КРАСАВИА · отчёт для экономистов', width, titleStyle);
        w.title(r++, `Дата выгрузки: ${stamp}`, width, style('FFFFFF', '475569', false, 'left'));
        r++;

        w.title(r++, `Факт кресел в продаже — прошлая неделя: ${weekLabel(rep.weeks.past)}`, width, sectionStyle);
        r = w.table(r, ['День', 'Дата', 'ВВЛ: рейсов', 'ВВЛ: кресла в продаже', 'МВЛ: рейсов', 'МВЛ: кресла в продаже', 'Всего кресел в продаже'],
            rep.pastDays.map(d => ({ cells: [d.dow, d.date, d.vvl.flights, d.vvl.seats, d.mvl.flights, d.mvl.seats, d.all.seats] }))
                .concat([{ total: true, cells: ['Итого', '', ...(() => { const a = sumUp(rep.past.filter(f => f.line === 'vvl')); const b = sumUp(rep.past.filter(f => f.line === 'mvl')); return [a.flights, a.seats, b.flights, b.seats, a.seats + b.seats]; })()] }]));
        r++;
        r = w.table(r, ['Категория', 'Рейсов', 'Кресла в продаже', 'Загрузка, пасс.', 'ЗПК, %'],
            rep.pastCats.map(c => ({
                total: !!c.total,
                bold: true,
                level: c.level,
                cells: [(c.level ? '   ' : '') + c.label, c.sum.flights, c.sum.seats, c.sum.sold, blank(pct(c.sum.sold, c.sum.seats))]
            })));
        r++;

        w.title(r++, `План загрузки — следующая неделя: ${weekLabel(rep.weeks.next)}`, width, sectionStyle);
        r = w.table(r, ['День', 'Дата', 'ВВЛ: кресла в продаже', 'ВВЛ: план загрузки (прогноз)', 'МВЛ: кресла в продаже', 'МВЛ: план загрузки (прогноз)', 'Всего: план загрузки (прогноз)'],
            rep.nextDays.map(d => ({ cells: [d.dow, d.date, d.vvl.seats, d.vvl.planned ? d.vvl.plan : '', d.mvl.seats, d.mvl.planned ? d.mvl.plan : '', d.all.planned ? d.all.plan : ''] }))
                .concat([{ total: true, cells: ['Итого', '', ...(() => { const a = sumUp(rep.next.filter(f => f.line === 'vvl')); const b = sumUp(rep.next.filter(f => f.line === 'mvl')); return [a.seats, a.planned ? a.plan : '', b.seats, b.planned ? b.plan : '', (a.planned || b.planned) ? a.plan + b.plan : '']; })()] }]));
        r++;
        r = w.table(r, ['Категория', 'Рейсов', 'Кресла в продаже', 'Продано на сегодня', 'План загрузки (прогноз)', 'План ЗПК, % (рейсы с прогнозом)', 'Рейсов без прогноза'],
            rep.nextCats.map(c => ({
                total: !!c.total,
                bold: true,
                level: c.level,
                cells: [(c.level ? '   ' : '') + c.label, c.sum.flights, c.sum.seats, c.sum.sold, c.sum.planned ? c.sum.plan : '', blank(c.sum.planned ? pct(c.sum.plan, c.sum.planSeats) : null), c.sum.noPlan]
            })));
        r++;
        const notes = [
            'Кресла в продаже = AU снимка − спец. брони, как на вкладке «Загрузка рейсов». Для прошлой недели — значения из последней загрузки.',
            'План загрузки — ожидаемое число пассажиров в день вылета по файлу прогноза загрузки. Рейсы, которых нет в файле прогноза, в план не входят (их число — в последнем столбце), план ЗПК считается только по рейсам с прогнозом.',
            'МВЛ — рейсы с международным городом (список INTERNATIONAL_CITIES в js/cities.js), остальные — ВВЛ. Внутри ВВЛ — деление на краевые и межрегиональные.'
        ];
        if (!rep.hasExpected) notes.unshift('Файл прогноза загрузки не загружен — план загрузки пуст.');
        const emptyPast = rep.pastDays.filter(d => !d.all.flights).map(d => d.date);
        if (emptyPast.length) notes.unshift(`Нет рейсов в загруженных данных за: ${emptyPast.join(', ')}.`);
        notes.forEach(text => { w.title(r, text, width, noteStyle); r++; });
        return w.finish([30, 12, 16, 22, 16, 22, 22], 0);
    }

    function flightsSheet(lib, list, plan) {
        const w = sheetWriter(lib);
        const headers = plan
            ? ['Дата', 'День', 'Рейс', 'Направление', 'Тип ВС', 'ВВЛ/МВЛ', 'Тип маршрута', 'Кресла в продаже', 'Продано на сегодня', 'План загрузки (прогноз)', 'План ЗПК, %']
            : ['Дата', 'День', 'Рейс', 'Направление', 'Тип ВС', 'ВВЛ/МВЛ', 'Тип маршрута', 'Кресла в продаже', 'Загрузка, пасс.', 'ЗПК, %'];
        const rows = list.map(f => ({
            leftCols: [3],
            cells: plan
                ? [f.date, f.dow, f.code, f.direction, f.aircraft, LINE_LABELS[f.line], ROUTE_LABELS[f.routeType], f.seats, f.sold, blank(f.plan), blank(f.plan != null ? pct(f.plan, f.seats) : null)]
                : [f.date, f.dow, f.code, f.direction, f.aircraft, LINE_LABELS[f.line], ROUTE_LABELS[f.routeType], f.seats, f.sold, blank(pct(f.sold, f.seats))]
        }));
        const total = sumUp(list);
        rows.push({
            total: true,
            cells: plan
                ? ['Итого', '', '', '', '', '', '', total.seats, total.sold, total.planned ? total.plan : '', blank(total.planned ? pct(total.plan, total.planSeats) : null)]
                : ['Итого', '', '', '', '', '', '', total.seats, total.sold, blank(pct(total.sold, total.seats))]
        });
        w.table(0, headers, rows);
        return w.finish(plan ? [12, 6, 10, 34, 10, 9, 18, 14, 14, 14, 12] : [12, 6, 10, 34, 10, 9, 18, 14, 14, 10], 1);
    }

    async function ensureXlsx() {
        const styled = typeof loadStyledXlsx === 'function' ? await loadStyledXlsx() : null;
        return styled || (typeof XLSX !== 'undefined' ? XLSX : null);
    }

    async function exportEcon() {
        if (!canEcon()) {
            toast('Отчёт недоступен для вашего профиля', 'error');
            return;
        }
        if (!hasData()) {
            toast('Нет данных. Нажмите «Загрузить» или «Последние».', 'error');
            return;
        }
        const folder = typeof excelPrepareFolder === 'function' ? await excelPrepareFolder('econ') : null;
        const lib = await ensureXlsx();
        if (!lib) {
            toast('Библиотека Excel не загружена', 'error');
            return;
        }
        toast('Готовлю Excel…');
        const rep = buildEconReport();
        const stamp = typeof excelExportStamp === 'function' ? excelExportStamp() : ru(new Date());
        const wb = lib.utils.book_new();
        lib.utils.book_append_sheet(wb, summarySheet(lib, rep, stamp), 'Сводка');
        lib.utils.book_append_sheet(wb, flightsSheet(lib, rep.past, false), 'Факт прошлой недели');
        lib.utils.book_append_sheet(wb, flightsSheet(lib, rep.next, true), 'План следующей недели');
        const fileDate = typeof getTodayDate === 'function' ? getTodayDate() : stamp;
        const filename = typeof excelDailyFilename === 'function'
            ? excelDailyFilename('КРАСАВИА_для_экономистов', fileDate)
            : `КРАСАВИА_для_экономистов_${fileDate.replace(/\./g, '-')}.xlsx`;
        try {
            const saved = typeof excelSaveWorkbook === 'function'
                ? await excelSaveWorkbook(lib, wb, filename, folder)
                : (lib.writeFile(wb, filename), { where: 'download' });
            if (typeof ActivityLog !== 'undefined') ActivityLog.log('export', 'Отчёт для экономистов');
            const msg = `Файл готов: факт ${weekLabel(rep.weeks.past)}, план ${weekLabel(rep.weeks.next)}`;
            if (typeof excelAnnounceSaved === 'function') excelAnnounceSaved(saved, msg);
            else toast(msg);
        } catch (e) {
            console.error(e);
            toast('Ошибка выгрузки', 'error');
        }
    }

    // ---------- остальные выгрузки ----------

    async function exportData() {
        if (!canData()) {
            toast('Выгрузка «Загрузки рейсов» недоступна для вашего профиля', 'error');
            return;
        }
        await ensureXlsx();
        if (typeof exportDataBoardToExcel === 'function') exportDataBoardToExcel();
    }

    async function exportSales() {
        if (!canSales()) {
            toast('Выгрузка «Управления продажами» недоступна для вашего профиля', 'error');
            return;
        }
        await ensureXlsx();
        if (typeof SalesManagement !== 'undefined' && typeof SalesManagement.load === 'function') {
            try { await SalesManagement.load(); } catch (e) { /* выгрузка покажет, что есть */ }
        }
        if (typeof exportSalesManagementExcel === 'function') await exportSalesManagementExcel();
    }

    function canData() {
        return canTab('data') && hasPerm('export_excel');
    }

    function canSales() {
        return canTab('sales');
    }

    function canEcon() {
        return hasPerm('export_excel') && (canTab('data') || canTab('pair') || canTab('costs'));
    }

    // ---------- проверка рейсов ----------

    function checksList() {
        if (typeof FlightChecks === 'undefined' || !FlightChecks.enabled() || !hasData()) return [];
        return FlightChecks.list();
    }

    function checksHtml() {
        if (typeof FlightChecks === 'undefined' || !FlightChecks.enabled()) return '';
        if (!hasData()) {
            return `<section class="rp-card rp-checks" id="rp-checks"><div class="rp-card-head"><h3 class="rp-card-title">Проверка рейсов</h3></div><p class="rp-note">Данных нет — нажмите «Загрузить» или «Последние».</p></section>`;
        }
        const all = checksList();
        const flightKey = (i) => i.code + '|' + i.date;
        const flightsAll = new Set(all.map(flightKey));
        const future = all.filter(i => i.state !== 'Улетел');
        const flightsFuture = new Set(future.map(flightKey));
        const shown = checksFutureOnly ? future : all;
        const canOpen = canTab('pair') || canTab('table');
        const rows = shown.map(i => `
            <tr class="${i.state === 'Улетел' ? 'rp-flew' : ''}">
                <td>${esc(i.date)}</td>
                <td><strong>${esc(i.code)}</strong></td>
                <td class="rp-left">${esc(i.direction)}</td>
                <td>${esc(i.state)}</td>
                <td class="rp-left rp-rule rp-rule-${esc(i.rule)}">${esc(i.title)}</td>
                <td>${fmt(i.count)}</td>
                <td class="rp-left">${esc(i.detail)}</td>
                <td>${esc(i.subsidySource)}</td>
                <td>${canOpen ? `<button type="button" class="filter-btn rp-open" data-open-base="${esc(i.base)}" data-open-date="${esc(i.date)}">Открыть</button>` : ''}</td>
            </tr>`).join('');
        const summary = all.length
            ? `Рейсов с ошибкой: <strong>${fmt(flightsAll.size)}</strong>, из них до вылета: <strong>${fmt(flightsFuture.size)}</strong>. Ошибок всего: ${fmt(all.length)}.`
            : 'Ошибок не найдено.';
        return `
            <section class="rp-card rp-checks" id="rp-checks">
                <div class="rp-card-head">
                    <h3 class="rp-card-title"><span class="fc-flag fc-flag-big" aria-hidden="true"></span> Проверка рейсов</h3>
                    <button type="button" class="btn-primary rp-btn" id="rp-checks-export"${all.length && hasPerm('export_excel') ? '' : ' disabled'}>В Excel</button>
                </div>
                <p class="rp-card-text">Проверяются субсидированные рейсы: межрегиональные с суммой субсидии больше 0 в «Экономической таблице» (краевые не субсидированные). Ошибка — если продан детский тариф со скидкой 50% (…/CN50) или билет дороже предельного тарифа из справочника субсидированных тарифов. Рейс с ошибкой помечен «!» в «Загрузке рейсов», «Экономической таблице» и «Динамике продаж».</p>
                <p class="rp-note">${summary}</p>
                ${all.length ? `
                <label class="rp-check"><input type="checkbox" id="rp-checks-future"${checksFutureOnly ? ' checked' : ''}> только рейсы до вылета</label>
                <div class="rp-scroll">
                    <table class="rp-table rp-checks-table">
                        <thead><tr><th>Дата</th><th>Рейс</th><th>Направление</th><th>Статус</th><th>Ошибка</th><th>Билетов</th><th>Подробно</th><th>Субсидия по</th><th></th></tr></thead>
                        <tbody>${rows || '<tr><td colspan="9" class="rp-left">До вылета ошибок нет — снимите галочку, чтобы увидеть улетевшие.</td></tr>'}</tbody>
                    </table>
                </div>` : ''}
            </section>`;
    }

    // ---------- справочник субсидированных тарифов ----------

    let refEditId = '';
    let refPrefill = '';

    function isoOf(ruDate) {
        const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(ruDate || ''));
        return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
    }

    function ruOf(isoDate) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ''));
        return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
    }

    function pairOf(code) {
        if (typeof getFlightPair !== 'function') return '';
        const p = getFlightPair(code);
        const other = code === p.outbound ? p.inbound : p.outbound;
        return other && other !== code ? other : '';
    }

    function interregionalCodes() {
        const set = new Set();
        Object.keys(window.FLIGHT_DIRECTIONS || {}).forEach(c => set.add(c));
        Object.keys(typeof groupedData !== 'undefined' && groupedData ? groupedData : {}).forEach(base => {
            (groupedData[base] || []).forEach(r => { if (r && r[0]) set.add(cleanFlight(r[0])); });
        });
        // Только базовые номера: доп. рейсы (KV-301, KV-355…) идут под своим базовым.
        return [...new Set([...set].map(c => (typeof getBaseFlight === 'function' && /^KV-\d+$/.test(c) ? getBaseFlight(c) : c)))]
            .filter(c => /^KV-\d+$/.test(c) && typeof getFlightRouteType === 'function' && getFlightRouteType(c) === 'interregional')
            .filter(c => !neverSubsidized(c))
            .sort((a, b) => (parseInt(a.slice(3), 10) || 0) - (parseInt(b.slice(3), 10) || 0));
    }

    function directionOf(code) {
        return typeof getFlightDirection === 'function' ? getFlightDirection(code) : code;
    }

    function neverSubsidized(code) {
        return typeof FlightChecks !== 'undefined' && FlightChecks.isNeverSubsidized && FlightChecks.isNeverSubsidized(code);
    }

    function refsHtml() {
        if (typeof FareRefs === 'undefined') return '';
        const can = FareRefs.canEdit();
        // Рейсы без субсидии (KV-247/248) в справочнике не показываются, даже если записи с ними есть в файле.
        const entries = FareRefs.list()
            .map(e => ({ ...e, flights: e.flights.filter(f => !neverSubsidized(f)) }))
            .filter(e => e.flights.length);
        const missing = hasData() && typeof FlightChecks !== 'undefined' ? FlightChecks.missingRefs() : [];
        const rows = entries.map(e => {
            const excl = e.mode === 'exclude';
            return `
            <tr class="${excl ? 'rp-ref-excluded' : ''}">
                <td class="rp-left"><strong>${esc(e.flights.join(', '))}</strong><div class="rp-sub-line">${esc(e.flights.map(directionOf).join(' · '))}</div></td>
                <td>${excl ? '—' : esc(e.fareCode || '—')}</td>
                <td>${excl ? '<span class="rp-ref-mode-excl" title="Старая запись: рейс исключён из субсидированных. Новые такие не создаются — даты субсидии задаются в «Периодах субсидии».">исключён (старая запись)</span>' : '<strong>' + fmt(e.adult) + ' ₽</strong>'}</td>
                <td>${excl ? '—' : (e.child != null ? fmt(e.child) + ' ₽' : '<span class="rp-muted">как взрослый</span>')}</td>
                <td class="rp-left">${esc(e.note || '')}</td>
                <td class="rp-left rp-muted">${esc(e.by || '')}${e.updatedAt && e.by !== 'по умолчанию' ? '<br>' + esc(new Date(e.updatedAt).toLocaleString('ru-RU')) : ''}</td>
                ${can ? `<td>${excl ? '' : `<button type="button" class="filter-btn rp-open" data-ref-edit="${esc(e.id)}">Изменить</button> `}<button type="button" class="filter-btn rp-open rp-danger" data-ref-delete="${esc(e.id)}">Удалить</button></td>` : ''}
            </tr>`;
        }).join('');
        const editing = refEditId ? entries.find(e => e.id === refEditId) : null;
        const pick = editing ? editing.flights[0] : (refPrefill || missing[0] || '');
        // Рейсы из записей справочника тоже в списке — иначе при правке сезонного рейса браузер молча выберет другой.
        const codes = [...new Set(interregionalCodes().concat(entries.flatMap(e => e.flights), pick ? [pick] : []))];
        const subsidizedNow = new Set(missing.concat(entries.flatMap(e => e.flights)));
        const option = (c) => `<option value="${esc(c)}"${c === pick ? ' selected' : ''}>${esc(c)} · ${esc(directionOf(c))}</option>`;
        const options = `
            <optgroup label="Субсидированные и из справочника">${codes.filter(c => subsidizedNow.has(c)).map(option).join('')}</optgroup>
            <optgroup label="Остальные межрегиональные">${codes.filter(c => !subsidizedNow.has(c)).map(option).join('')}</optgroup>`;
        const other = pick ? pairOf(pick) : '';
        const pairOn = editing ? (editing.flights.length > 1) : true;
        const form = can ? `
            <div class="rp-ref-form" id="rp-ref-form">
                <div class="rp-ref-form-title">${editing ? 'Изменить запись' : 'Новая запись'}</div>
                <div class="rp-ref-grid">
                    <label>Рейс<select id="rp-ref-flight" class="cr-input">${options}</select></label>
                    <label class="rp-check rp-ref-pair"><input type="checkbox" id="rp-ref-pair"${pairOn ? ' checked' : ''}${other ? '' : ' disabled'}> и обратный <strong id="rp-ref-pair-code">${esc(other || '—')}</strong></label>
                    <label class="rp-ref-limit">Код тарифа<input id="rp-ref-code" class="cr-input" maxlength="30" placeholder="напр. USCOW" value="${esc(editing ? editing.fareCode : '')}"></label>
                    <label class="rp-ref-limit">Предельный тариф, ₽<input id="rp-ref-adult" class="cr-input" type="number" min="0" step="1" value="${esc(editing && editing.adult != null ? editing.adult : '')}"></label>
                    <label class="rp-ref-limit">Детский предел, ₽<input id="rp-ref-child" class="cr-input" type="number" min="0" step="1" placeholder="как взрослый" value="${esc(editing && editing.child != null ? editing.child : '')}"></label>
                    <label class="rp-ref-note">Комментарий<input id="rp-ref-note" class="cr-input" maxlength="200" value="${esc(editing ? editing.note : '')}"></label>
                </div>
                <div class="rp-ref-actions">
                    <button type="button" class="btn-primary rp-btn" id="rp-ref-save">${editing ? 'Сохранить' : 'Добавить'}</button>
                    ${editing ? '<button type="button" class="filter-btn" id="rp-ref-cancel">Отмена</button>' : ''}
                    <span class="rp-ref-error" id="rp-ref-error" role="alert"></span>
                </div>
            </div>` : '<p class="rp-note">Менять тарифы может администратор или профиль с правом «Тарифы субсидии — менять».</p>';
        const suggestions = can && missing.length && typeof FlightChecks !== 'undefined' && FlightChecks.suggestRefs
            ? FlightChecks.suggestRefs() : [];
        lastSuggestions = suggestions;
        const ready = suggestions.filter(x => x.enough);
        const suggestHtml = suggestions.length ? `
            <div class="rp-suggest">
                <div class="rp-suggest-head">
                    <div><strong>Подсказки по продажам</strong>
                        <div class="rp-sub-line">Предел — самый дорогой из ходовых (от 10% билетов) оплаченных взрослых тарифов на субсидированных датах рейса; дешевле него бывают другие тарифы. Проверьте и подтвердите: справочник сам ничего не заполняет.</div></div>
                    ${ready.length > 1 ? `<button type="button" class="btn-primary rp-btn" id="rp-suggest-all">Принять все (${ready.length})</button>` : ''}
                </div>
                <div class="rp-scroll">
                    <table class="rp-table rp-suggest-table">
                        <thead><tr><th>Рейсы</th><th>Предел</th><th>Код тарифа</th><th>Билетов по пределу</th><th>Дешевле</th><th>Дороже (будут ошибки)</th><th>Вылетов</th><th></th></tr></thead>
                        <tbody>${suggestions.map((x, i) => `
                            <tr class="${x.enough ? '' : 'rp-suggest-weak'}">
                                <td class="rp-left"><strong>${esc(x.flights.join(', '))}</strong><div class="rp-sub-line">${esc(x.flights.map(directionOf).join(' · '))}</div></td>
                                <td><strong>${fmt(x.adult)} ₽</strong></td>
                                <td>${esc(x.fareCode || '—')}</td>
                                <td>${x.share}% <span class="rp-muted">(${fmt(x.tickets)} из ${fmt(x.total)})</span></td>
                                <td>${x.belowShare}%</td>
                                <td>${x.above ? `<span class="rp-warn-text">${fmt(x.above)}</span> <span class="rp-muted">до ${fmt(x.maxPaid)} ₽</span>` : '0'}</td>
                                <td>${x.departures}</td>
                                <td class="rp-nowrap">
                                    <button type="button" class="filter-btn rp-open" data-suggest-accept="${i}"${x.enough ? '' : ' title="Подсказка ненадёжная — проверьте вручную"'}>Принять</button>
                                    <button type="button" class="filter-btn rp-open" data-suggest-form="${i}">В форму</button>
                                </td>
                            </tr>`).join('')}</tbody>
                    </table>
                </div>
                ${suggestions.length > ready.length ? '<p class="rp-note">Серым — ненадёжные подсказки: меньше 20 взрослых билетов или больше 5% билетов дороже предела (возможно, несколько субсидированных тарифов по периодам). Их «Принять все» не трогает.</p>' : ''}
            </div>` : '';
        const missingHtml = missing.length
            ? `<p class="rp-note rp-warn">Субсидированные рейсы до вылета без тарифа в справочнике — для них проверка тарифа не выполняется: ${missing.map(c => can ? `<button type="button" class="rp-chip" data-ref-fill="${esc(c)}">${esc(c)}</button>` : `<span class="rp-chip">${esc(c)}</span>`).join(' ')}</p>`
            : '';
        return `
            <section class="rp-card rp-refs" id="rp-refs">
                <div class="rp-card-head"><h3 class="rp-card-title">Тарифы субсидии</h3></div>
                <p class="rp-card-text">Предельный тариф на субсидированном рейсе: билет дороже предела — ошибка, дешевле — можно, в том числе детские. Детский предел необязателен: если он не задан, детский билет сравнивается со взрослым пределом. Сравнивается оплаченная сумма билета.</p>
                <p class="rp-card-text">Периода у тарифа нет: проверка идёт только в субсидированные даты из раздела «Периоды субсидии». Рейсы — только базовые номера: доп. рейсы (KV-301, KV-355…) проверяются по тарифу своего базового рейса.</p>
                ${missingHtml}
                ${suggestHtml}
                ${entries.length ? `
                <div class="rp-scroll">
                    <table class="rp-table rp-refs-table">
                        <thead><tr><th>Рейсы</th><th>Код тарифа</th><th>Предел</th><th>Детский предел</th><th>Комментарий</th><th>Изменил</th>${can ? '<th></th>' : ''}</tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>` : '<p class="rp-note">Справочник пуст.</p>'}
                ${form}
            </section>`;
    }

    let lastSuggestions = [];

    function suggestionNote(x) {
        return `по продажам: ${x.share}% взрослых билетов (${x.tickets} из ${x.total})`;
    }

    async function acceptSuggestions(list) {
        let shared = true;
        let done = 0;
        for (const x of list) {
            const res = await FareRefs.upsert({ mode: 'limit', flights: x.flights, fareCode: x.fareCode, adult: x.adult, note: suggestionNote(x) });
            if (!res.ok) {
                toast(res.error, 'error');
                break;
            }
            shared = shared && res.shared;
            done++;
        }
        if (!done) return;
        afterRefChange(shared, done === 1
            ? `Тариф для ${list[0].flights.join(', ')} сохранён (${fmt(list[0].adult)} ₽)`
            : `Добавлено пределов: ${done}`);
    }

    function fillFormFromSuggestion(x) {
        refEditId = '';
        refPrefill = x.flights[0];
        renderBody();
        const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
        const pair = document.getElementById('rp-ref-pair');
        if (pair) pair.checked = x.flights.length > 1;
        set('rp-ref-code', x.fareCode || '');
        set('rp-ref-adult', String(x.adult));
        set('rp-ref-note', suggestionNote(x));
        const adult = document.getElementById('rp-ref-adult');
        if (adult) { adult.scrollIntoView({ behavior: 'smooth', block: 'center' }); adult.focus(); }
    }

    function syncPairLabel() {
        const sel = document.getElementById('rp-ref-flight');
        const box = document.getElementById('rp-ref-pair');
        const label = document.getElementById('rp-ref-pair-code');
        if (!sel || !box || !label) return;
        const other = pairOf(sel.value);
        label.textContent = other || '—';
        box.disabled = !other;
        if (!other) box.checked = false;
    }

    async function saveRef() {
        const val = (id) => (document.getElementById(id) || {}).value || '';
        const err = document.getElementById('rp-ref-error');
        const code = val('rp-ref-flight');
        const pairBox = document.getElementById('rp-ref-pair');
        const flights = [code];
        const other = pairOf(code);
        if (pairBox && pairBox.checked && other) flights.push(other);
        const mode = 'limit';
        const res = await FareRefs.upsert({
            id: refEditId || undefined,
            mode,
            flights,
            fareCode: val('rp-ref-code'),
            adult: val('rp-ref-adult'),
            child: val('rp-ref-child'),
            note: val('rp-ref-note')
        });
        if (!res.ok) {
            if (err) err.textContent = res.error;
            return;
        }
        refEditId = '';
        refPrefill = '';
        afterRefChange(res.shared, mode === 'exclude'
            ? `${flights.join(', ')} не считаются субсидированными`
            : `Тариф для ${flights.join(', ')} сохранён`);
    }

    async function deleteRef(id) {
        const entry = FareRefs.list().find(e => e.id === id);
        const what = entry && entry.mode === 'exclude' ? 'исключение' : 'тариф';
        if (!entry || !window.confirm(`Удалить ${what} для ${entry.flights.join(', ')}?`)) return;
        const res = await FareRefs.remove(id);
        if (!res.ok) {
            toast(res.error, 'error');
            return;
        }
        if (refEditId === id) refEditId = '';
        afterRefChange(res.shared, 'Запись удалена');
    }

    function afterRefChange(shared, msg) {
        if (typeof FlightChecks !== 'undefined') FlightChecks.refreshViews();
        renderBody();
        if (shared) toast(msg + ' — видно всем');
        else toast(msg + ' на этом компьютере. Подключите папку приложения, чтобы справочник увидели остальные.', 'error');
        if (typeof ActivityLog !== 'undefined') ActivityLog.log('fare_refs', msg);
    }

    function openFlight(base, date) {
        const tab = canTab('pair') ? 'pair' : (canTab('table') ? 'table' : '');
        if (!tab || typeof switchMainTab !== 'function') return;
        if (typeof currentFlight !== 'undefined') currentFlight = base;
        if (typeof lastSelectedDate !== 'undefined') lastSelectedDate = date;
        switchMainTab(tab);
    }

    async function exportChecks() {
        if (!hasPerm('export_excel')) {
            toast('Экспорт недоступен для вашего профиля', 'error');
            return;
        }
        const all = checksList();
        if (!all.length) {
            toast('Ошибок нет — выгружать нечего', 'error');
            return;
        }
        const folder = typeof excelPrepareFolder === 'function' ? await excelPrepareFolder('econ') : null;
        const lib = await ensureXlsx();
        if (!lib) {
            toast('Библиотека Excel не загружена', 'error');
            return;
        }
        const stamp = typeof excelExportStamp === 'function' ? excelExportStamp() : ru(new Date());
        const w = sheetWriter(lib);
        w.title(0, `Проверка рейсов · выгрузка ${stamp}`, 11, style('FFFFFF', NAVY, true, 'left'));
        w.table(1, ['Дата', 'Рейс', 'Направление', 'Статус', 'Ошибка', 'Билетов', 'Тарифы', 'Предел, ₽', 'Макс. оплачено, ₽', 'Субсидия по', 'Субсидия на рейс, ₽'],
            all.map(i => ({ leftCols: [2, 4, 6], cells: [i.date, i.code, i.direction, i.state, i.title, i.count, i.fares.join(', '), i.limit != null ? i.limit : '', i.maxPaid != null ? Math.round(i.maxPaid) : '', i.subsidySource, Math.round(i.subsidyAmount || 0)] })));
        const ws = w.finish([12, 10, 32, 10, 30, 10, 30, 12, 16, 16, 16], 2);
        const wb = lib.utils.book_new();
        lib.utils.book_append_sheet(wb, ws, 'Ошибки');
        const fileDate = typeof getTodayDate === 'function' ? getTodayDate() : stamp;
        const filename = typeof excelDailyFilename === 'function'
            ? excelDailyFilename('КРАСАВИА_проверка_рейсов', fileDate)
            : `КРАСАВИА_проверка_рейсов_${fileDate.replace(/\./g, '-')}.xlsx`;
        const saved = typeof excelSaveWorkbook === 'function'
            ? await excelSaveWorkbook(lib, wb, filename, folder)
            : (lib.writeFile(wb, filename), { where: 'download' });
        if (typeof ActivityLog !== 'undefined') ActivityLog.log('export', 'Проверка рейсов');
        const msg = `Файл готов: ошибок ${all.length}`;
        if (typeof excelAnnounceSaved === 'function') excelAnnounceSaved(saved, msg);
        else toast(msg);
    }

    // ---------- страница ----------

    function previewHtml() {
        if (!hasData()) {
            return '<p class="rp-note">Данных нет — нажмите «Загрузить» или «Последние», и здесь появятся итоги.</p>';
        }
        const rep = buildEconReport();
        const factRows = rep.pastCats.map(c => `<tr class="${c.total ? 'rp-total' : ''}${c.level ? ' rp-sub' : ''}"><td>${esc(c.label)}</td><td>${fmt(c.sum.flights)}</td><td>${fmt(c.sum.seats)}</td><td>${fmt(c.sum.sold)}</td><td>${c.sum.seats ? fmt(pct(c.sum.sold, c.sum.seats)) + '%' : '—'}</td></tr>`).join('');
        const planRows = rep.nextCats.map(c => `<tr class="${c.total ? 'rp-total' : ''}${c.level ? ' rp-sub' : ''}"><td>${esc(c.label)}</td><td>${fmt(c.sum.flights)}</td><td>${fmt(c.sum.seats)}</td><td>${c.sum.planned ? fmt(c.sum.plan) : '—'}</td><td>${c.sum.planned && c.sum.planSeats ? fmt(pct(c.sum.plan, c.sum.planSeats)) + '%' : '—'}</td><td>${fmt(c.sum.noPlan)}</td></tr>`).join('');
        const empty = rep.pastDays.filter(d => !d.all.flights).map(d => d.date);
        return `
            <div class="rp-preview-grid">
                <div>
                    <h4 class="rp-preview-title">Факт: ${esc(weekLabel(rep.weeks.past))}</h4>
                    <table class="rp-table"><thead><tr><th>Категория</th><th>Рейсов</th><th>Кресла в продаже</th><th>Загрузка</th><th>ЗПК</th></tr></thead><tbody>${factRows}</tbody></table>
                    ${empty.length ? `<p class="rp-note rp-warn">Нет рейсов в данных за: ${esc(empty.join(', '))}</p>` : ''}
                </div>
                <div>
                    <h4 class="rp-preview-title">План: ${esc(weekLabel(rep.weeks.next))}</h4>
                    <table class="rp-table"><thead><tr><th>Категория</th><th>Рейсов</th><th>Кресла в продаже</th><th>План загрузки</th><th>План ЗПК</th><th>Без прогноза</th></tr></thead><tbody>${planRows}</tbody></table>
                    ${rep.hasExpected ? '' : '<p class="rp-note rp-warn">Файл прогноза загрузки не загружен — плана нет.</p>'}
                </div>
            </div>`;
    }

    function card(id, title, text, allowed, denyText, extra) {
        return `
            <section class="rp-card">
                <div class="rp-card-head">
                    <h3 class="rp-card-title">${esc(title)}</h3>
                    <button type="button" class="btn-primary rp-btn" id="${id}"${allowed ? '' : ' disabled'}>Выгрузить</button>
                </div>
                <p class="rp-card-text">${esc(text)}</p>
                ${allowed ? '' : `<p class="rp-note rp-warn">${esc(denyText)}</p>`}
                ${extra || ''}
            </section>`;
    }

    // Внутренние вкладки: проверка, справочник (только с правом), выгрузки.
    const SUBTAB_KEY = 'krasavia_reports_subtab';
    let subtab = '';
    try { subtab = localStorage.getItem(SUBTAB_KEY) || ''; } catch (e) { /* ignore */ }

    function canRefs() {
        return typeof FareRefs !== 'undefined' && FareRefs.canEdit();
    }

    function subtabs() {
        const list = [];
        const checksOn = typeof FlightChecks !== 'undefined' && FlightChecks.enabled();
        if (checksOn) {
            const n = hasData() ? new Set(checksList().filter(i => i.state !== 'Улетел').map(i => i.code + '|' + i.date)).size : 0;
            list.push({ id: 'checks', label: 'Проверка рейсов', badge: n ? String(n) : '' });
        }
        if (typeof ReferenceView !== 'undefined' ? ReferenceView.canAny() : canRefs()) {
            const miss = canRefs() && hasData() && checksOn && typeof FlightChecks !== 'undefined' ? FlightChecks.missingRefs().length : 0;
            list.push({ id: 'refs', label: 'Справочник', badge: miss ? miss + ' без предела' : '', warn: !!miss });
        }
        list.push({ id: 'export', label: 'Выгрузки в Excel', badge: '' });
        return list;
    }

    function renderBody() {
        const body = document.getElementById('rp-body');
        if (!body) return;
        const tabs = subtabs();
        if (!tabs.some(t => t.id === subtab)) subtab = tabs[0].id;
        const weeks = weekBounds();
        let content = '';
        if (subtab === 'checks') content = checksHtml();
        else if (subtab === 'refs') content = typeof ReferenceView !== 'undefined' ? ReferenceView.html(refsHtml) : refsHtml();
        else {
            content = `<div class="rp-export-grid">${[
                card('rp-data', 'Загрузка рейсов',
                    'Excel с карточками маршрутов, как на вкладке «Загрузка рейсов» (с её текущими фильтрами).',
                    canData(), 'Нужны вкладка «Загрузка рейсов» и право на экспорт Excel.'),
                card('rp-sales', 'Управление продажами',
                    'Excel вкладки «Управление продажами»: лист на каждый рейс с отметками по дням.',
                    canSales(), 'Нужна вкладка «Управление продажами».')
            ].join('')}</div>
            ${card('rp-econ', 'Для экономистов',
                `Факт кресел в продаже за прошлую неделю (${weekLabel(weeks.past)}) и план загрузки на следующую (${weekLabel(weeks.next)}), отдельно ВВЛ и МВЛ. Листы: сводка, факт по рейсам, план по рейсам.`,
                canEcon(), 'Нужны право на экспорт Excel и одна из вкладок: «Загрузка рейсов», «Экономическая таблица», «Расчёт расходов».',
                canEcon() ? `<div class="rp-preview" id="rp-preview">${previewHtml()}</div>` : '')}`;
        }
        body.innerHTML = `
            <nav class="rp-subtabs" role="tablist">${tabs.map(t => `
                <button type="button" role="tab" class="rp-subtab${t.id === subtab ? ' rp-subtab-on' : ''}" data-rp-tab="${t.id}" aria-selected="${t.id === subtab}">
                    ${esc(t.label)}${t.badge ? ` <span class="rp-subtab-badge${t.warn ? ' rp-subtab-badge-warn' : ''}">${esc(t.badge)}</span>` : ''}
                </button>`).join('')}
            </nav>
            <div class="rp-subtab-body">${content}</div>`;
        previewSig = signature();
    }

    function signature() {
        const epoch = typeof dataEpoch === 'number' ? dataEpoch : 0;
        const today = typeof getTodayDate === 'function' ? getTodayDate() : '';
        const prof = typeof ProfileAuth !== 'undefined' && ProfileAuth.getCurrentProfile ? (ProfileAuth.getCurrentProfile()?.id || '') : '';
        const rows = typeof allData !== 'undefined' && allData ? allData.length : 0;
        const checksOn = (typeof FlightChecks !== 'undefined' && FlightChecks.enabled() ? 1 : 0)
            + ':' + (typeof FareRefs !== 'undefined' ? FareRefs.revision() : 0)
            + ':' + (typeof SubsidyRef !== 'undefined' ? SubsidyRef.revision() : 0)
            + ':' + (typeof SharedOverrides !== 'undefined' && SharedOverrides.navRevision ? SharedOverrides.navRevision() : 0);
        const checks = checksList().map(i => i.code + i.date).join(',');
        return [epoch, today, prof, rows, checksOn, checks].join('|');
    }

    function create(panel) {
        panel.innerHTML = `
            <div class="rp-page table-page" id="rp-page">
                <div class="table-page-hero">
                    <div class="table-page-hero-main">
                        <h2 class="rms-hero-title">Отчёты</h2>
                        <span class="table-page-hint">Проверка рейсов, справочник (тарифы, периоды и суммы субсидии, ПКЗ из NAV) и выгрузки в Excel</span>
                    </div>
                </div>
                <div class="table-page-body rp-body" id="rp-body"></div>
            </div>
        `;
        const page = panel.querySelector('#rp-page');
        page.addEventListener('change', (event) => {
            if (typeof ReferenceView !== 'undefined' && ReferenceView.handleChange(event.target, renderBody)) return;
            if (event.target.id === 'rp-ref-flight') { syncPairLabel(); return; }
            if (event.target.id !== 'rp-checks-future') return;
            checksFutureOnly = event.target.checked;
            renderBody();
        });
        page.addEventListener('input', (event) => {
            if (typeof ReferenceView !== 'undefined') ReferenceView.handleInput(event.target, renderBody);
        });
        page.addEventListener('click', (event) => {
            const btn = event.target.closest('button');
            if (!btn || btn.disabled) return;
            if (typeof ReferenceView !== 'undefined' && ReferenceView.handleClick(btn, renderBody)) return;
            if (btn.dataset.rpTab) {
                subtab = btn.dataset.rpTab;
                try { localStorage.setItem(SUBTAB_KEY, subtab); } catch (e) { /* ignore */ }
                renderBody();
                return;
            }
            if (btn.dataset.openBase) {
                openFlight(btn.dataset.openBase, btn.dataset.openDate);
                return;
            }
            if (btn.dataset.refEdit) {
                refEditId = btn.dataset.refEdit;
                renderBody();
                const form = document.getElementById('rp-ref-form');
                if (form) form.scrollIntoView({ behavior: 'smooth', block: 'center' });
                return;
            }
            if (btn.dataset.refDelete) { deleteRef(btn.dataset.refDelete); return; }
            if (btn.dataset.refFill) {
                refEditId = '';
                refPrefill = btn.dataset.refFill;
                renderBody();
                const adult = document.getElementById('rp-ref-adult');
                if (adult) { adult.scrollIntoView({ behavior: 'smooth', block: 'center' }); adult.focus(); }
                return;
            }
            if (btn.dataset.suggestAccept != null) {
                const x = lastSuggestions[Number(btn.dataset.suggestAccept)];
                if (!x) return;
                btn.disabled = true;
                acceptSuggestions([x]).catch(e => { console.error(e); toast('Не удалось сохранить', 'error'); }).finally(() => { btn.disabled = false; });
                return;
            }
            if (btn.dataset.suggestForm != null) {
                const x = lastSuggestions[Number(btn.dataset.suggestForm)];
                if (x) fillFormFromSuggestion(x);
                return;
            }
            if (btn.id === 'rp-suggest-all') {
                const ready = lastSuggestions.filter(x => x.enough);
                if (!ready.length || !window.confirm(`Добавить в справочник ${ready.length} пределов по подсказкам?\n\n${ready.map(x => `${x.flights.join(', ')} — ${fmt(x.adult)} ₽ ${x.fareCode}`).join('\n')}`)) return;
                btn.disabled = true;
                acceptSuggestions(ready).catch(e => { console.error(e); toast('Не удалось сохранить', 'error'); }).finally(() => { btn.disabled = false; });
                return;
            }
            if (btn.id === 'rp-ref-cancel') { refEditId = ''; renderBody(); return; }
            if (btn.id === 'rp-ref-save') {
                btn.disabled = true;
                saveRef().catch(e => { console.error(e); toast('Не удалось сохранить', 'error'); }).finally(() => { btn.disabled = false; });
                return;
            }
            const run = btn.id === 'rp-data' ? exportData
                : (btn.id === 'rp-sales' ? exportSales
                    : (btn.id === 'rp-econ' ? exportEcon
                        : (btn.id === 'rp-checks-export' ? exportChecks : null)));
            if (!run) return;
            btn.disabled = true;
            Promise.resolve()
                .then(run)
                .catch(e => { console.error(e); toast('Ошибка выгрузки', 'error'); })
                .finally(() => { btn.disabled = false; });
        });
        renderBody();
        if (typeof FareRefs !== 'undefined') {
            const before = FareRefs.revision();
            FareRefs.load().then(() => {
                if (FareRefs.revision() === before) return;
                if (typeof FlightChecks !== 'undefined') FlightChecks.refreshViews();
                renderBody();
            }).catch(() => {});
        }
    }

    function refresh() {
        if (!document.getElementById('rp-page')) return;
        if (previewSig === signature()) return;
        renderBody();
    }

    // Открыть нужную внутреннюю вкладку (например, из счётчика ошибок в шапке).
    function showSubtab(id) {
        subtab = id;
        if (id === 'refs' && typeof ReferenceView !== 'undefined') ReferenceView.openSection('fares');
        try { localStorage.setItem(SUBTAB_KEY, id); } catch (e) { /* ignore */ }
        if (document.getElementById('rp-page')) renderBody();
    }

    return { create, refresh, showSubtab, buildEconReport, weekBounds, exportEcon, exportData, exportSales, exportChecks };
})();

function createReportsView(panel) {
    ReportsView.create(panel);
}
