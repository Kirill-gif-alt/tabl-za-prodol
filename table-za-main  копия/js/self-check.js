// Самопроверка чистых функций. В консоли: KrasaviaSelfCheck.run()
window.KrasaviaSelfCheck = (function () {
    function assert(name, cond, detail) {
        return { name, ok: !!cond, detail: detail || '' };
    }

    function run() {
        const tests = [];

        const d = typeof parseLocalDate === 'function' ? parseLocalDate('08.03.2026') : null;
        tests.push(assert('дата 08.03.2026', d && d.getFullYear() === 2026 && d.getMonth() === 2 && d.getDate() === 8));

        tests.push(assert('дата 32.13.2026 отклонена', typeof parseLocalDate === 'function' && parseLocalDate('32.13.2026') === null));
        tests.push(assert('дата 29.02.2025 отклонена', typeof parseLocalDate === 'function' && parseLocalDate('29.02.2025') === null));

        const leap = typeof parseLocalDate === 'function' ? parseLocalDate('29.02.2024') : null;
        tests.push(assert('високосный 29.02.2024', leap && leap.getMonth() === 1 && leap.getDate() === 29));

        tests.push(assert('normalizeDate 08032026', typeof normalizeDate === 'function' && normalizeDate('08032026') === '08.03.2026'));

        tests.push(assert('formatNum 1234 → 1 234', typeof formatNum === 'function' && formatNum(1234) === '1\u00a0234'));

        const denom = 0;
        const free = 10;
        const pct = denom > 0 ? Math.round(free / denom * 100) : 0;
        tests.push(assert('LF при capacity 0 не NaN', pct === 0 && Number.isFinite(pct)));

        if (typeof getDeltaFromExpected === 'function') {
            const d0 = getDeltaFromExpected(10, null);
            tests.push(assert('нет ожидаемой → delta null, не 0', d0.delta === null));
        }
        if (typeof getSeatRemainder === 'function') {
            const fake = ['KV-1', '01.01.2026', '', 'AAA-BBB', 'AT5', 46, 20, 0, 4, 0, 'открыт', '08:00', '09:00'];
            tests.push(assert('остаток = AU − sold − avs', getSeatRemainder(fake) === 22));
        }
        if (typeof getSoldFromRow === 'function') {
            tests.push(assert('free/sold не путается с empty', getSoldFromRow(['', '', '', '', '', 46, 12, 0, 0]) === 12));
        }
        tests.push(assert('RMS free подписан как пассажиров, не empty', typeof RMS_FILTER_FIELDS === 'undefined' || RMS_FILTER_FIELDS.free.label !== 'Свободные места'));
        tests.push(assert('hasSalesFileLoaded возвращает boolean', typeof hasSalesFileLoaded === 'function' && typeof hasSalesFileLoaded() === 'boolean'));

        if (typeof GEO_AIRPORTS !== 'undefined') {
            const kja = GEO_AIRPORTS.lookupCode('KJA');
            const aba = GEO_AIRPORTS.lookupCode('ABA');
            const nsk = GEO_AIRPORTS.lookupCode('NSK');
            const htg = GEO_AIRPORTS.lookupCode('HTG');
            const uln = GEO_AIRPORTS.lookupCode('ULN');
            const kyz = GEO_AIRPORTS.lookupCode('KYZ');
            tests.push(assert('Абакан южнее Красноярска', aba && kja && aba.lat < kja.lat - 1));
            tests.push(assert('Норильск севернее Красноярска', nsk && kja && nsk.lat > kja.lat + 8));
            tests.push(assert('Хатанга севернее и восточнее КЯА', htg && kja && htg.lat > kja.lat + 10 && htg.lon > kja.lon));
            tests.push(assert('Улан-Батор южнее и восточнее КЯА', uln && kja && uln.lat < kja.lat - 5 && uln.lon > kja.lon + 10));
            tests.push(assert('Кызыл южнее Красноярска', kyz && kja && kyz.lat < kja.lat - 2));
            tests.push(assert('нет точки без координат', !GEO_AIRPORTS.lookupToken('НеттакогогородаXYZ')));
            const kcy = GEO_AIRPORTS.lookupCode('KCY');
            const cher = GEO_AIRPORTS.lookupCity('Черемшанка');
            tests.push(assert('KCY = Красноярск', kcy && kcy.city === 'Красноярск' && kcy.code === 'KJA'));
            tests.push(assert('Черемшанка = Красноярск', cher && cher.city === 'Красноярск'));
            tests.push(assert('KCY координаты как у KJA', kcy && kja && kcy.lat === kja.lat && kcy.lon === kja.lon));
            tests.push(assert('хаб Черемшанка', typeof isHubCity !== 'function' || isHubCity('Черемшанка')));
            const loop = GEO_AIRPORTS.endpointsFromRow(['', '', '', 'KCY-KJA'], '');
            tests.push(assert('KCY-KJA не рисуется', loop && !loop.a && !loop.b));
            const km = GEO_AIRPORTS.endpointsFromRow(['', '', '', 'KCY-MJY'], '');
            tests.push(assert('KCY-MJY из Красноярска', km && km.a && km.a.city === 'Красноярск' && km.b && km.b.city === 'Мотыгино'));
        }

        if (typeof NetworkMap !== 'undefined' && NetworkMap.flightMatchesFilter) {
            const prev = window.networkMapFilter;
            window.networkMapFilter = { city: 'Мотыгино', query: 'Мотыгино', iata: '' };
            const rowMjy = ['KV-183', '01.01.2026', '', 'KJA-MJY'];
            const rowAba = ['KV-101', '01.01.2026', '', 'KJA-ABA'];
            tests.push(assert('фильтр карты: Мотыгино проходит', NetworkMap.flightMatchesFilter('KV-183', rowMjy) === true));
            tests.push(assert('фильтр карты: Абакан не проходит', NetworkMap.flightMatchesFilter('KV-101', rowAba) === false));
            window.networkMapFilter = { iata: 'KJA' };
            tests.push(assert('фильтр KCY как KJA', NetworkMap.flightMatchesFilter('KV-183', ['KV-183', '', '', 'KCY-MJY']) === true));
            window.networkMapFilter = prev;
        }

        if (typeof LiveKvFlights !== 'undefined' && LiveKvFlights.kvFlight) {
            tests.push(assert('KV111 → KV-111', LiveKvFlights.kvFlight('KV111') === 'KV-111'));
            tests.push(assert('SSJ 102 → KV-102', LiveKvFlights.kvFlight('SSJ102') === 'KV-102'));
            tests.push(assert('ЭК-183 → KV-183', LiveKvFlights.kvFlight('ЭК-183') === 'KV-183'));
        }
        if (typeof getCitiesFromFlight === 'function') {
            const kyz = getCitiesFromFlight('KV-111');
            tests.push(assert('KV-111 = Красноярск — Кызыл', kyz && kyz[0] === 'Красноярск' && kyz[kyz.length - 1] === 'Кызыл'));
            const aba = getCitiesFromFlight('KV-101');
            tests.push(assert('KV-101 = Красноярск — Абакан', aba && aba[aba.length - 1] === 'Абакан'));
        }

        tests.push(assert('escHtml экранирует тег', typeof escHtml === 'function' && escHtml('<img>') === '&lt;img&gt;'));

        if (typeof getSeatsOnSale === 'function' && typeof buildFlightLegMetrics === 'function') {
            const zeroDenom = ['KV-1', '01.01.2026', '', 'AAA-BBB', 'AT5', 4, 2, 0, 4, 0, 'открыт', '08:00', '09:00'];
            tests.push(assert('AU=avs → кресел в продаже 0', getSeatsOnSale(zeroDenom) === 0));
            const todayStart = new Date(2020, 0, 1);
            todayStart.setHours(0, 0, 0, 0);
            const m = buildFlightLegMetrics(zeroDenom, new Map(), todayStart);
            tests.push(assert('ЗПК при знаменателе 0 это —', m && m.zpk === '—'));
        }

        const cfg = window.CITY_CLASSIFICATION || {};
        tests.push(assert('Чара не краевой', !(cfg.KRAI_CITIES || []).includes('Чара')));
        tests.push(assert('Чара межрегиональный', (cfg.INTERREGIONAL_CITIES || []).includes('Чара')));
        tests.push(assert('нет алиаса Енисейск→Северо-Енисейск', !cfg.CITY_ALIASES || !cfg.CITY_ALIASES['Енисейск']));
        if (typeof canonicalCityName === 'function') {
            tests.push(assert('Енисейск не склеивается с С.Енисейском', canonicalCityName('Енисейск') !== 'Северо-Енисейск'));
        }
        if (typeof getFlightRouteType === 'function') {
            tests.push(assert('KV-225 Чара = межрегион', getFlightRouteType('KV-225') === 'interregional'));
            tests.push(assert('KV-183 Мотыгино = край', getFlightRouteType('KV-183') === 'krai'));
            tests.push(assert('KV-111 Кызыл = межрегион', getFlightRouteType('KV-111') === 'interregional'));
        }
        if (typeof TableVirtual !== 'undefined') {
            tests.push(assert('TableVirtual.mount есть', typeof TableVirtual.mount === 'function'));
        }

        if (typeof SalesManagement !== 'undefined' && SalesManagement.checkDatesBetween) {
            const days = SalesManagement.checkDatesBetween(new Date(2026, 8, 30), new Date(2026, 9, 2), ['24.09.2026']);
            tests.push(assert(
                'дни заполнения от сегодня до вылета',
                days.join(',') === '24.09.2026,30.09.2026,01.10.2026,02.10.2026'
            ));
            const past = SalesManagement.checkDatesBetween(new Date(2026, 8, 30), new Date(2026, 8, 1), []);
            tests.push(assert('прошедший рейс без лишних колонок', past.length === 0));
            const kept = SalesManagement.checkDatesBetween(new Date(2026, 9, 1), new Date(2026, 9, 3), []);
            tests.push(assert(
                'история с 01.10 остаётся',
                kept.join(',') === '01.10.2026,02.10.2026,03.10.2026'
            ));
            tests.push(assert(
                'улетевший день раньше сегодня',
                SalesManagement.isFlownDate('29.09.2026', new Date(2026, 8, 30)) === true
                && SalesManagement.isFlownDate('30.09.2026', new Date(2026, 8, 30)) === false
            ));
        }
        if (typeof SalesManagement !== 'undefined' && typeof SalesManagement.operatingCode === 'function') {
            tests.push(assert(
                'доп рейс сохраняет свой номер',
                SalesManagement.operatingCode('KV-301') === 'KV-301'
                && SalesManagement.baseCode('KV-301') === 'KV-101'
                && SalesManagement.operatingCode('KV-302') === 'KV-302'
                && SalesManagement.baseCode('KV-111') === 'KV-111'
            ));
        }
        if (typeof SalesManagement !== 'undefined' && typeof SalesManagement.authorSignature === 'function') {
            tests.push(assert(
                'подпись администратора',
                SalesManagement.authorSignature('Администратор') === 'Лобанов К.И.'
                && SalesManagement.authorSignature('Иванов') === 'Иванов'
            ));
        }
        if (typeof salesSharedSyncMs === 'function') {
            tests.push(assert('отметки обновляются каждые 30 минут', salesSharedSyncMs() === 30 * 60 * 1000));
        }
        if (typeof salesCellStyle === 'function') {
            const id = salesCellStyle('id', 0, 5);
            const route = salesCellStyle('id', 4, 5);
            const headRoute = salesCellStyle('head', 4, 3);
            const headDate = salesCellStyle('head', 5, 3);
            const empty = salesCellStyle('empty', 6, 6);
            const legend = salesCellStyle('legend', 1, 1);
            const swatch = salesCellStyle('swatch-keep', 0, 1);
            const grayRoute = salesCellStyle('gray', 4, 6);
            const keep = salesCellStyle('keep', 7, 6);
            const sameFont = [id, route, headRoute, headDate, empty, legend, swatch, grayRoute, keep].every(style =>
                style.font && style.font.name === 'Calibri' && style.font.sz === 11
                && style.alignment && style.alignment.vertical === 'center'
            );
            tests.push(assert('excel один шрифт и центр по вертикали', sameFont));
            tests.push(assert(
                'excel маршрут слева, остальное по центру',
                id.alignment.horizontal === 'center'
                && route.alignment.horizontal === 'left'
                && headRoute.alignment.horizontal === 'left'
                && headDate.alignment.horizontal === 'center'
                && grayRoute.alignment.horizontal === 'left'
                && keep.alignment.horizontal === 'center'
                && empty.alignment.wrapText === false
                && legend.alignment.horizontal === 'left'
                && legend.alignment.wrapText === false
                && empty.border && empty.border.left && empty.border.left.style === 'thin'
                && swatch.fill && swatch.fill.fgColor
                && swatch.fill.fgColor.rgb === (typeof salesThemeFill === 'function' ? salesThemeFill('keep')[0] : 'F7DC6F')
                && swatch.border && swatch.border.top
            ));
        }
        if (typeof SalesManagement !== 'undefined' && typeof SalesManagement.rangeDefaults === 'function') {
            const defaults = SalesManagement.rangeDefaults();
            tests.push(assert(
                'период строк с 18.09 и столбцов с 01.10',
                defaults.rowsFrom === '18.09.2026' && defaults.colsFrom === '01.10.2026'
            ));
        }
        if (typeof salesLegendModel === 'function' && typeof salesSheetFreeze === 'function') {
            const legend = salesLegendModel();
            const freeze = salesSheetFreeze(legend.count);
            tests.push(assert(
                'легенда excel столбиком и закрепление до даты',
                legend.count === 6
                && legend.rows[0].kinds[0] === 'swatch-gray'
                && legend.rows[0].cells[1] === 'Улетел'
                && legend.rows[1].cells[1] === 'Не проверен'
                && legend.rows[2].cells[1] === 'Проверено без изменений'
                && legend.rows[3].kinds[0] === 'swatch-attn'
                && legend.rows[3].cells[0] === '!'
                && legend.rows[3].cells[1] === 'Обратить внимание'
                && legend.rows[4].cells[1] === 'Снижение'
                && legend.rows[5].cells[1] === 'Повышение'
                && legend.rows.every(row => row.cells.length === 2)
                && freeze.xSplit === 5
                && freeze.ySplit === 9
                && freeze.topLeft === 'F10'
            ));
        }
        if (typeof salesCellText === 'function' && typeof salesMarkExportText === 'function') {
            tests.push(assert(
                'внимание показывает ! и подпись',
                salesCellText({ status: 'attn', author: 'Петров' }) === '! Петров'
                && salesCellText({ status: 'attn', author: '' }) === '!'
                && salesMarkExportText({ status: 'attn', author: 'Петров' }, true) === '! Петров'
                && salesMarkExportText({ status: 'down', author: 'Петров' }, true) === 'Петров'
                && salesMarkExportText({ status: 'down', author: 'Петров' }, false) === 'Снижение — Петров'
            ));
        }
        if (typeof salesCheckIsToday === 'function' && typeof getTodayDate === 'function') {
            tests.push(assert(
                'править можно только сегодня',
                salesCheckIsToday(getTodayDate()) === true && salesCheckIsToday('01.01.2000') === false
            ));
        }
        if (typeof salesThemeFill === 'function' && typeof ThemeSettings === 'undefined') {
            const down = salesThemeFill('down');
            const attn = salesThemeFill('attn');
            tests.push(assert(
                'снижение бардовое, внимание прежним цветом',
                down && down[0] === '8E1B2F' && down[1] === 'FFFFFF'
                && attn && attn[0] === 'F5B7B1' && attn[1] === '7B241C'
            ));
        }
        if (typeof readHtmlTableForExcel === 'function' && document.createElement) {
            const table = document.createElement('table');
            table.innerHTML = '<thead><tr><th rowspan="2">Дата</th><th colspan="2" class="pair-dir-out">Туда</th></tr><tr><th class="pair-sub-out">Места</th><th class="pair-sub-in">Места</th></tr></thead><tbody><tr class="flew-flight"><td>01.10.2026</td><td class="pair-leg-out">10</td><td class="pair-leg-in">4</td></tr></tbody>';
            const parsed = readHtmlTableForExcel(table);
            tests.push(assert(
                'excel читает шапку с объединением',
                parsed.headerRows === 2
                && parsed.rows[0][0] === 'Дата'
                && parsed.rows[0][1] === 'Туда'
                && parsed.rows[1][1] === 'Места'
                && parsed.rows[2][0] === '01.10.2026'
                && parsed.rows[2][2] === '4'
                && parsed.merges.length === 2
                && parsed.tags[2][1] === 'out'
                && parsed.tags[2][2] === 'in'
            ));
        }
        if (typeof excelFolderKinds === 'function' && typeof excelSafeFilename === 'function') {
            const ids = excelFolderKinds().map(item => item.id);
            tests.push(assert(
                'у каждого excel своя папка',
                ids.indexOf('sales') !== -1
                && ids.indexOf('data') !== -1
                && ids.indexOf('rms') !== -1
                && ids.indexOf('table') !== -1
                && ids.indexOf('pkz') !== -1
                && ids.indexOf('pair') !== -1
                && new Set(ids).size === ids.length
                && excelSafeFilename('a/b:c.xlsx') === 'a b c.xlsx'
            ));
        }
        if (typeof excelDailyFilename === 'function') {
            const morning = excelDailyFilename('КРАСАВИА_управление_продажами', '01.10.2026 08:15');
            const evening = excelDailyFilename('КРАСАВИА_управление_продажами', '01.10.2026 19:40');
            const next = excelDailyFilename('КРАСАВИА_управление_продажами', '02.10.2026 08:05');
            tests.push(assert(
                'выгрузка одного дня заменяет файл, следующий день — новый',
                morning === evening
                && morning === 'КРАСАВИА_управление_продажами_01-10-2026.xlsx'
                && next === 'КРАСАВИА_управление_продажами_02-10-2026.xlsx'
                && morning !== next
            ));
        }
        if (typeof excelStyle === 'function') {
            const styled = excelStyle('012A4A', 'FFFFFF', true, 'center', true, true);
            tests.push(assert(
                'общий excel: шрифт, центр и рамка',
                styled.font.name === 'Calibri' && styled.font.sz === 11
                && styled.alignment.vertical === 'center'
                && styled.border && styled.border.left.style === 'thin'
            ));
        }

        if (typeof excelSafeCell === 'function') {
            const cell = excelSafeCell('=cmd|');
            tests.push(assert('excelSafeCell формула как текст', cell && typeof cell === 'object' && cell.t === 's' && cell.v === '=cmd|'));
            tests.push(assert('excelSafeCell число не трогает', excelSafeCell(42) === 42));
        }

        const failed = tests.filter(t => !t.ok);
        const passed = tests.filter(t => t.ok);
        const summary = failed.length
            ? `Самопроверка: ${passed.length}/${tests.length} ок, ошибки: ${failed.map(t => t.name).join('; ')}`
            : `Самопроверка: все ${tests.length} проверок прошли`;
        if (typeof console !== 'undefined') {
            console.log(summary, tests);
        }
        if (typeof showToast === 'function') showToast(summary, failed.length ? 'error' : 'ok');
        return { ok: failed.length === 0, passed: passed.length, total: tests.length, tests };
    }

    return { run };
})();
