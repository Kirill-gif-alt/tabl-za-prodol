// js\data-ingest.js - extracted from script.js, logic unchanged.
// Globals on purpose: no bundler; onclick and other files call by name.

let salesLoadLock = null;

async function withSalesLoadLock(fn) {
    while (salesLoadLock) await salesLoadLock;
    let release;
    salesLoadLock = new Promise(resolve => { release = resolve; });
    try {
        return await fn();
    } finally {
        release();
        salesLoadLock = null;
    }
}

function getSalesAggForKey(key) {
    if (typeof PerfCache !== 'undefined') {
        const st = PerfCache.getSalesStats(key);
        if (st && st.count) {
            return {
                avg: st.paidCount ? Math.round(st.fareSum / st.paidCount) : 0,   // средний оплаченный взрослый: 0 ₽, детские и младенческие не в счёт
                last: st.lastFare || 0,
                lettr: String(st.lastBasicFare || '').trim()[0] || '',
                paid: st.paidCount, sum: st.fareSum   // для среднего тарифа по группе рейсов
            };
        }
    }
    const sl = salesDetails[key] || [];
    if (!sl.length) return { avg: 0, last: 0, lettr: '', paid: 0, sum: 0 };
    let sum = 0, paid = 0;
    const isAdult = (x) => (typeof FareGrid !== 'undefined' && FareGrid.isAdultPaid ? FareGrid.isAdultPaid(x) : (x.adjustedFare || x.fare || 0) > 0);
    for (let i = 0; i < sl.length; i++) { if (!isAdult(sl[i])) continue; sum += sl[i].adjustedFare || sl[i].fare || 0; paid++; }
    let last = 0, lettr = '', lastTs = 0;
    for (let i = 0; i < sl.length; i++) {
        const x = sl[i];
        const ts = parseLocalDate(x.dealDate)?.getTime() || 0;
        const v = x.adjustedFare || x.fare || 0;
        if (isAdult(x) && ts >= lastTs) {
            lastTs = ts;
            last = v;
            lettr = String(x.basicFareStr || '').trim()[0] || '';
        }
    }
    return { avg: paid ? Math.round(sum / paid) : 0, last, lettr, paid, sum };
}

function getRevenueForRow(row, firstSalesByKey) {
    if (!row || !shouldAttachSalesToRowCached(row, firstSalesByKey)) return 0;
    if (typeof PerfCache !== 'undefined') {
        const st = PerfCache.getSalesStats(resolveSalesKey(row));
        if (st && st.count) return st.paidSum || 0;   // выручка — по фактически оплаченному, не по пересчитанному детскому тарифу
    }
    return getSalesDetailsForRow(row).reduce((sum, x) => sum + (x.fare || 0), 0);
}

async function toFile(src) {
    if (!src) return null;
    if (src instanceof File) return src;
    if (typeof src.getFile === 'function') return src.getFile();
    return null;
}

function getLatestFilesFromList(files, cnt) {
    return [...files].sort((a, b) => b.lastModified - a.lastModified).slice(0, cnt);
}

// SalesHistory.csv (Export-SalesHistory.ps1) лежит в той же папке csv — это не файл продаж, а история для прогноза.
function isSalesHistoryName(name) {
    return /^saleshistory.*\.csv$/i.test(String(name || ''));
}

// SalesTickets.csv (Export-SalesTickets.ps1) — история по билетам: класс и цена на каждый день, возвраты, группы.
function isSalesTicketsName(name) {
    return /^salestickets.*\.csv$/i.test(String(name || ''));
}

function findSalesTicketsFile(files) {
    return getLatestFilesFromList((files || []).filter(f => isSalesTicketsName(f.name)), 1)[0] || null;
}

// Несколько копий (SalesHistory (1).csv и т.п.) — берём самую свежую, иначе старая затёрла бы новую историю.
function findSalesHistoryFile(files) {
    return getLatestFilesFromList((files || []).filter(f => isSalesHistoryName(f.name)), 1)[0] || null;
}

function findSalesCsvFile(files) {
    const csvs = (files || []).filter(f => String(f.name || '').toLowerCase().endsWith('.csv') && !isSalesHistoryName(f.name) && !isSalesTicketsName(f.name));
    if (!csvs.length) return null;
    const preferred = csvs.find(f => f.name.toLowerCase().includes('tickets_sale_last14days'));
    if (preferred) return preferred;
    const tickets = csvs.find(f => f.name.toLowerCase().includes('tickets_sale'));
    if (tickets) return tickets;
    return getLatestFilesFromList(csvs, 1)[0] || null;
}

// Вид файла «загрузка таб» по содержимому: 'heli' — вертолётный (конфигурация MIH-…), 'mixed' — и те и другие строки, 'air' — самолётный.
// Читаем только начало файла; ответ запоминается по самому файлу.
const availKindCache = new WeakMap();
async function classifyAvailFile(file) {
    if (!file) return 'air';
    if (availKindCache.has(file)) return availKindCache.get(file);
    let kind = 'air';
    try {
        const buf = await file.slice(0, 262144).arrayBuffer();
        const txt = new TextDecoder('windows-1252').decode(buf);   // нужна только латиница: MIH-, KV-
        if (typeof HeliData !== 'undefined') kind = HeliData.classifyText(txt);
    } catch (e) { kind = 'air'; }
    availKindCache.set(file, kind);
    return kind;
}

// Из папки «загрузка таб»: два последних самолётных файла и один последний вертолётный (вертолётный не вытесняет самолётные).
async function pickAvailFromList(csvFiles) {
    const sorted = getLatestFilesFromList(csvFiles || [], (csvFiles || []).length);
    const air = [];
    let heli = null;
    let looked = 0;
    for (const f of sorted) {
        if (air.length >= 2 && heli) break;
        if (looked++ >= 16) break;
        const kind = await classifyAvailFile(f);
        if (kind === 'heli') { if (!heli) heli = f; } else if (air.length < 2) air.push(f);
    }
    return heli ? air.concat([heli]) : air;
}

async function pickSourcesFromFolders(folderMap) {
    let avail = [], closed = [], sales = null;
    for (const [name, files] of Object.entries(folderMap)) {
        const l = name.toLowerCase();
        if (isLoadTabDirName(name)) {
            const csvFiles = files.filter(f => f.name.toLowerCase().endsWith('.csv'));
            avail = await pickAvailFromList(csvFiles);
        }
        if (l.includes('база закрытие') || l.includes('базазакрытие')) closed = getLatestFilesFromList(files, 2);
        if (l.includes('csv') || l.includes('продажи')) {
            const hit = findSalesCsvFile(files);
            if (hit) sales = hit;
        }
    }
    return { avail, closed, sales };
}

function findExpectedLoadFile(files) {
    for (const f of files) {
        const n = f.name.toLowerCase();
        if (n.endsWith('.xlsx') && (n.includes('ожидаемая') || n.includes('загрузка'))) return f;
    }
    return null;
}

async function classifyFilesFromInput(fileList) {
    const dirs = {};
    const all = Array.from(fileList || []);
    const rootCsv = [];

    for (const f of all) {
        const path = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
        const parts = path.split('/');
        if (parts.length < 3) {
            if (f.name.toLowerCase().endsWith('.csv')) rootCsv.push(f);
            continue;
        }
        const dirKey = parts[1].toLowerCase();
        if (!dirs[dirKey]) dirs[dirKey] = [];
        if (f.name.toLowerCase().endsWith('.csv')) dirs[dirKey].push(f);
    }

    const picked = await pickSourcesFromFolders(dirs);
    const xlsxAll = all.filter(f => /\.xlsx?$/i.test(f.name || '') && !String(f.name).startsWith('~$'));
    return {
        ...picked,
        exp: findExpectedLoadFile(all),
        weights: typeof findBaggageWeightsFile === 'function' ? findBaggageWeightsFile(all) : null,
        children: typeof findChildrenCsvFile === 'function'
            ? (findChildrenCsvFile(all) || findChildrenCsvFile(rootCsv))
            : null,
        sales: picked.sales || findSalesCsvFile(all),
        history: findSalesHistoryFile(all),
        tickets: findSalesTicketsFile(all),
        costs: typeof RouteCosts !== 'undefined' ? RouteCosts.findCostsFile(xlsxAll) : null,
        subsidyPeriods: typeof RouteCosts !== 'undefined' ? RouteCosts.findPeriodsFile(xlsxAll) : null
    };
}

function resetDataBeforeLoad() {
    if (typeof DelayedFlights !== 'undefined') DelayedFlights.rememberPrevious(allData);
    dataLoadStatus = { availability: false, closed: false, sales: false, expected: false, weights: false, children: false, costs: false, subsidy: false };
    closedFlights = new Set();
    allData = [];
    groupedData = {};
    salesMap = {};
    salesDetails = {};
    expectedLoadData = {};
    lastSalesUpdate = null;
    if (typeof baggageWeightsData !== 'undefined') baggageWeightsData = {};
    if (typeof childrenByFlightDate !== 'undefined') childrenByFlightDate = {};
    if (typeof childrenFileCount !== 'undefined') childrenFileCount = 0;
    CACHED_TODAY = null;
    CACHED_YESTERDAY = null;
    if (typeof HeliData !== 'undefined') HeliData.reset();
    if (typeof PerfCache !== 'undefined') PerfCache.reset();
    tableHtmlCache = { sig: '', html: '' };
    invalidateMetricsCache();
}

async function processDataFromSources(avail, closed, sales, exp, weights, children, costsFile, subsidyFile) {
    window.ingestQuiet = true;
    try {
    resetDataBeforeLoad();
    const parallelLoads = [];
    if (avail.length) {
        parallelLoads.push((async () => {
            setLoadingMessage('Загрузка таб...');
            await loadAvailabilityFiles(avail);
        })());
    }
    if (closed.length) {
        parallelLoads.push((async () => {
            setLoadingMessage('Загрузка закрытых рейсов...');
            await loadClosedFiles(closed);
        })());
    }
    if (parallelLoads.length) await Promise.all(parallelLoads);

    if (sales) {
        setLoadingMessage('Загрузка продаж...');
        await loadSalesFile(sales);
        // Билеты перенесённых рейсов и доп. номеров — к вылету, на котором люди летят (sales-reconcile.js).
        if (typeof SalesReconcile !== 'undefined' && SalesReconcile.run(salesDetails) && typeof rebuildSalesAggregatesFromDetails === 'function') {
            rebuildSalesAggregatesFromDetails();
        }
    }

    const secondaryLoads = [];
    if (exp) {
        secondaryLoads.push((async () => {
            setLoadingMessage('Загрузка прогноза загрузки...');
            await loadExpectedLoadFile(exp);
        })());
    }
    if (weights && typeof loadBaggageWeightsFile === 'function') {
        secondaryLoads.push((async () => {
            setLoadingMessage('Загрузка весовых...');
            await loadBaggageWeightsFile(weights);
        })());
    }
    if (children && typeof loadChildrenFile === 'function') {
        secondaryLoads.push((async () => {
            setLoadingMessage('Загрузка детей (Дети.csv)...');
            await loadChildrenFile(children);
        })());
    }
    if ((costsFile || subsidyFile) && typeof RouteCosts !== 'undefined') {
        secondaryLoads.push((async () => {
            setLoadingMessage('Загрузка расходов и субсидий...');
            await RouteCosts.loadFiles(costsFile, subsidyFile);
        })());
    }
    if (secondaryLoads.length) await Promise.all(secondaryLoads);
    if (typeof SharedOverrides !== 'undefined') {
        await SharedOverrides.load();
    }

    window.ingestQuiet = false;
    window.krasaviaIngestSeq = (window.krasaviaIngestSeq || 0) + 1; // для подписи локального снимка
    updateHeaderStatus();
    invalidateMetricsCache();
    refreshCurrentView();
    if (typeof SessionStore !== 'undefined') {
        SessionStore.scheduleSnapshotSave(true);
        SessionStore.saveUiSession();
    }
    if (typeof ActivityLog !== 'undefined') {
        const flightCount = Object.keys(groupedData || {}).length;
        ActivityLog.log('data_load', `Рейсов: ${flightCount}`);
    }
    showToast('Данные успешно загружены');
    if (typeof MorningSummary !== 'undefined') MorningSummary.build().catch(() => {});
    } catch (e) {
        // Данные уже сброшены — возвращаем последний сохранённый снимок, чтобы не остаться с пустыми таблицами.
        window.ingestQuiet = false;
        if (typeof SessionStore !== 'undefined' && SessionStore.restoreLastData) {
            await SessionStore.restoreLastData(true).catch(err => console.warn('restoreLastData', err));
        }
        throw e;
    } finally {
        window.ingestQuiet = false;
    }
}

async function fileFromHandle(handle, name) {
    const file = await toFile(handle);
    if (!file || !name) return file;
    if (file.name === name) return file;
    return new File([file], name, { lastModified: file.lastModified, type: file.type });
}

async function scanDirectoryHandle(dir) {
    const folderEntries = {};
    const rootEntries = [];
    let weightsHandle = null;
    let weightsName = '';
    let costsHandle = null;
    let costsName = '';
    let subsidyHandle = null;
    let subsidyName = '';
    const historyHandles = [];
    // «Ожидаемая загрузка» и «Дети.csv» ищутся и в подпапках — как при выборе папки обычным окном.
    const expHandles = [];
    const childHandles = [];

    for await (const [name, h] of dir.entries()) {
        if (h.kind === 'directory') {
            const lname = name.toLowerCase();
            const csvHandles = [];
            for await (const [fn, fh] of h.entries()) {
                if (fh.kind !== 'file') continue;
                const fl = fn.toLowerCase();
                if (fl.endsWith('.xlsx') && !fl.startsWith('~$') && (fl.includes('ожидаемая') || fl.includes('загрузка'))) expHandles.push({ name: fn, handle: fh });
                if (fl.endsWith('.csv') && (fl.includes('дети') || fl.includes('deti') || lname.includes('дети'))) childHandles.push({ name: fn, handle: fh });
                if (isSalesHistoryName(fn) || isSalesTicketsName(fn)) historyHandles.push({ name: fn, handle: fh });
                else if (fl.endsWith('.csv')) csvHandles.push({ name: fn, handle: fh });
                else if (fl.endsWith('.xlsx') && (lname.includes('весов') || fl.includes('весов'))) {
                    weightsHandle = fh;
                    weightsName = fn;
                } else if ((fl.endsWith('.xlsx') || fl.endsWith('.xls')) && !fl.startsWith('~$')) {
                    if (fl.includes('период') && fl.includes('субсид')) {
                        subsidyHandle = fh;
                        subsidyName = fn;
                    } else if (fl.includes('расход') || lname.includes('расход')) {
                        if (!fl.includes('период')) {
                            costsHandle = fh;
                            costsName = fn;
                        }
                    }
                }
            }
            folderEntries[lname] = csvHandles;
        } else if (h.kind === 'file') {
            if (isSalesHistoryName(name) || isSalesTicketsName(name)) historyHandles.push({ name, handle: h });
            else rootEntries.push({ name, handle: h });
        }
    }

    async function materializeCsvList(handles, limit) {
        if (!handles?.length) return [];
        const files = await Promise.all(handles.map(async item => fileFromHandle(item.handle, item.name)));
        const ready = files.filter(Boolean);
        return limit ? getLatestFilesFromList(ready, limit) : ready;
    }

    const folderMap = {};
    for (const [lname, handles] of Object.entries(folderEntries)) {
        if (isLoadTabDirName(lname)) {
            // Берём все файлы папки: сколько из них самолётных, а какой вертолётный, видно только по содержимому (pickAvailFromList).
            folderMap[lname] = await materializeCsvList(handles, 0);
        } else if (lname.includes('база закрытие') || lname.includes('базазакрытие')) {
            folderMap[lname] = await materializeCsvList(handles, 2);
        } else if (lname.includes('csv') || lname.includes('продаж')) {
            const preferred = handles.find(item => item.name.toLowerCase().includes('tickets_sale_last14days'))
                || handles.find(item => item.name.toLowerCase().includes('tickets_sale'));
            folderMap[lname] = preferred
                ? [await fileFromHandle(preferred.handle, preferred.name)].filter(Boolean)
                : await materializeCsvList(handles, 1);
        }
    }

    const rootFiles = await Promise.all(rootEntries.map(async item => fileFromHandle(item.handle, item.name)));
    const weightsFile = weightsHandle
        ? await fileFromHandle(weightsHandle, weightsName)
        : null;

    const rootReady = rootFiles.filter(Boolean);
    const costsFile = costsHandle
        ? await fileFromHandle(costsHandle, costsName)
        : (typeof RouteCosts !== 'undefined' ? RouteCosts.findCostsFile(rootReady) : null);
    const subsidyFile = subsidyHandle
        ? await fileFromHandle(subsidyHandle, subsidyName)
        : (typeof RouteCosts !== 'undefined' ? RouteCosts.findPeriodsFile(rootReady) : null);
    // Файлы из подпапок материализуем, только если в корне такого файла нет.
    let expFile = findExpectedLoadFile(rootReady);
    if (!expFile && expHandles.length) expFile = findExpectedLoadFile((await materializeCsvList(expHandles)));
    let childFile = typeof findChildrenCsvFile === 'function' ? findChildrenCsvFile(rootReady) : null;
    if (!childFile && childHandles.length && typeof findChildrenCsvFile === 'function') childFile = findChildrenCsvFile((await materializeCsvList(childHandles)));
    return {
        ...(await pickSourcesFromFolders(folderMap)),
        exp: expFile,
        weights: weightsFile || (typeof findBaggageWeightsFile === 'function' ? findBaggageWeightsFile(rootReady) : null),
        children: childFile,
        costs: costsFile,
        subsidyPeriods: subsidyFile,
        ...(await (async () => {
            const hf = historyHandles.length ? (await Promise.all(historyHandles.map(x => fileFromHandle(x.handle, x.name)))).filter(Boolean) : [];
            return { history: findSalesHistoryFile(hf), tickets: findSalesTicketsFile(hf) };
        })())
    };
}

async function loadFromDirectoryPicker() {
    const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
    if (typeof SalesSync !== 'undefined') await SalesSync.saveDataFolderHandle(dir);
    showLoading('Сканирование папки...');
    const sources = await scanDirectoryHandle(dir);
    // Не та папка — не стираем текущие данные (сброс идёт до чтения файлов).
    if (!sources.avail.length && !sources.closed.length && !sources.sales && !sources.exp && !sources.weights) {
        showToast('В папке не найдены нужные файлы (загрузка таб, закрытие, продажи)', 'error');
        return;
    }
    await processDataFromSources(sources.avail, sources.closed, sources.sales, sources.exp, sources.weights, sources.children, sources.costs, sources.subsidyPeriods);
    importSalesHistorySoon(sources.history, sources.tickets);
}

// История продаж из папки данных: дописывается в архив сама, если файл новый (в фоне, после загрузки данных).
function importSalesHistorySoon(file, ticketsFile) {
    if (typeof ForecastLab !== 'undefined' && ForecastLab.afterDataLoad) ForecastLab.afterDataLoad();
    if (typeof SalesArchive === 'undefined') return;
    setTimeout(async () => {
        if (file && SalesArchive.autoImport) {
            await SalesArchive.autoImport(file).then(r => {
                if (r && r.ok && !r.same && typeof showToast === 'function') showToast(`История продаж обновлена: ${r.flights.toLocaleString('ru-RU')} вылетов — модель прогноза доучивается`);
            }).catch(e => console.warn('SalesHistory', e));
        }
        if (ticketsFile && SalesArchive.autoImportTickets) {
            await SalesArchive.autoImportTickets(ticketsFile).then(r => {
                if (r && r.ok && !r.same && typeof showToast === 'function') showToast(`История по билетам загружена: ${r.flights.toLocaleString('ru-RU')} вылетов — модель учит цену, класс, возвраты и группы`);
            }).catch(e => console.warn('SalesTickets', e));
        }
    }, 1500);
}

async function processDataFromFileList(fileList) {
    try {
        if (typeof Security !== 'undefined') {
            const check = Security.validateFileList(fileList);
            if (!check.ok) {
                showToast(check.error, 'error');
                return;
            }
        }
        showLoading('Сканирование папки...');
        const sources = await classifyFilesFromInput(fileList);
        if (!sources.avail.length && !sources.closed.length && !sources.sales && !sources.exp && !sources.weights) {
            showToast('В папке не найдены нужные файлы (загрузка таб, закрытие, продажи)', 'error');
            return;
        }
        await processDataFromSources(sources.avail, sources.closed, sources.sales, sources.exp, sources.weights, sources.children, sources.costs, sources.subsidyPeriods);
        importSalesHistorySoon(sources.history, sources.tickets);
    } catch (e) {
        console.error(e);
        const hint = (typeof SessionStore !== 'undefined' && await SessionStore.hasSnapshot())
            ? ' Выберите папку или нажмите «Последние данные».'
            : ' Выберите папку «Загрузка» (подпапки: загрузка таб, база закрытие, csv/продажи).';
        showToast('Ошибка загрузки.' + hint, 'error');
    } finally {
        hideLoading();
    }
}

let folderInputReady = false;
function openFolderPickerFallback() {
    let input = document.getElementById('folder-input');
    if (!input) {
        input = document.createElement('input');
        input.type = 'file';
        input.id = 'folder-input';
        input.setAttribute('webkitdirectory', '');
        input.multiple = true;
        input.hidden = true;
        document.body.appendChild(input);
    }
    if (!folderInputReady) {
        folderInputReady = true;
        input.addEventListener('change', () => {
            const files = input.files;
            input.value = '';
            if (!files || !files.length) return;
            processDataFromFileList(files);
        });
    }
    input.click();
}

async function autoLoadLatestFiles() {
    if (typeof ProfileAuth !== 'undefined' && !ProfileAuth.guardPermission('load_data', 'Загрузка данных недоступна для вашего профиля')) return;
    if (window.isSecureContext && typeof window.showDirectoryPicker === 'function') {
        try {
            await loadFromDirectoryPicker();
            return;
        } catch (e) {
            console.error(e);
            if (e.name === 'AbortError') return;
            const hint = (typeof SessionStore !== 'undefined' && await SessionStore.hasSnapshot())
                ? ' Выберите папку или нажмите «Последние данные».'
                : ' Выберите папку с файлами или используйте Chrome/Edge.';
            showToast('Ошибка загрузки.' + hint, 'error');
        } finally {
            hideLoading();
        }
    }
    openFolderPickerFallback();
}

async function loadAvailabilityFiles(files){
    allData=[];
    availabilityKeepClosed = true;
    const heliRows = [];
    try {
    for(const fh of files){
        const file = await toFile(fh);
        const txt = await readCsvText(file);
        // Вертолётные строки (конфигурация MIH-…) — в отдельное хранилище, в allData они не попадают.
        let pureHeli = false;
        if (typeof HeliData !== 'undefined' && txt.indexOf('MIH-') >= 0) {
            const h = HeliData.parseText(txt);
            heliRows.push(...h.rows);
            pureHeli = h.rows.length > 0 && h.other === 0;
        }
        if (pureHeli) continue;
        const parsed = await parseAvailabilityTextAsync(txt, (p) => setLoadingMessage(`Загрузка таб… ${p}%`));
        if (parsed.length) allData.push(...parsed.filter(r => !/^MIH-/i.test(String(r[4] || ''))));
    }
    } finally { availabilityKeepClosed = false; }
    if (typeof HeliData !== 'undefined') HeliData.setRows(heliRows);
    // Файлы — от нового к старому: первая строка рейса (в том числе закрытая) — актуальная; закрытые потом убираем.
    allData = dedupeAvailabilityRows(allData.filter(r => r.length >= 7 && r[0] && r[1])).filter(r => !r.closedRow);
    dataLoadStatus.availability = true;
    processData();
    if (!window.ingestQuiet) updateHeaderStatus();
}
async function loadClosedFiles(files){
    for(const fh of files){
        const txt=await (await toFile(fh)).text();
        const lines=txt.split('\n');
        for(let i=3;i<lines.length;i++){
            const l=lines[i];
            if(!l.trim())continue;
            const c=l.split(';').map(x=>x.trim());
            if(c.length<2)continue;
            const fl=cleanFlight(c[0]),dt=normalizeDate(c[1]);
            if(dt&&fl)closedFlights.add(dt+'|'+fl);
            if(i%800===0)await new Promise(r=>setTimeout(r,0));
        }
    }
    dataLoadStatus.closed = true;
    updateHeaderStatus();
}
function parseSalesDateField(str) {
    // Сначала полный разбор с временем (dd.mm.yyyy HH:MM)
    const parsed = parseDealDateTime(str);
    if (parsed?.date && /^\d{2}\.\d{2}\.\d{4}$/.test(parsed.date)) return parsed.date;

    if (typeof PerfCache !== 'undefined') {
        const fast = PerfCache.parseSalesDateFast(str);
        if (fast && /^\d{2}\.\d{2}\.\d{4}$/.test(fast)) return fast;
    }
    const raw = String(str || '').trim().replace(/[^0-9]/g, '');
    // только если ровно 8 цифр (ddmmyyyy), иначе не режем datetime
    if (raw.length === 8) {
        return raw.slice(0, 2) + '.' + raw.slice(2, 4) + '.' + raw.slice(4);
    }
    return normalizeDate(str);
}

function readSalesCsvText(file) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = e => {
            let text = String(e.target.result || '').replace(/^\uFEFF/, '');
            const head = text.split('\n')[0] || '';
            // Заголовок латиницей — и в Windows-1251 читается; кириллица тогда превращается в «�» — читаем как 1251.
            if (/BSONUM/i.test(head) && /FLYDATE/i.test(head) && !text.includes('\uFFFD')) {
                resolve(text);
                return;
            }
            const r2 = new FileReader();
            r2.onload = ev => resolve(String(ev.target.result || '').replace(/^\uFEFF/, ''));
            r2.onerror = () => reject(new Error('Ошибка чтения файла продаж'));
            r2.readAsText(file, 'windows-1251');
        };
        r.onerror = () => reject(new Error('Ошибка чтения файла продаж'));
        r.readAsText(file, 'UTF-8');
    });
}

function loadSalesFile(fh) {
    return withSalesLoadLock(async () => {
        const file = await toFile(fh);
        const text = await readSalesCsvText(file);
        lastSalesUpdate = file.lastModified ? new Date(file.lastModified) : new Date();

        const lines = text.split(/\r?\n/);
        const dates = getTodayYesterday();
        const seen = new Set();
        let loaded = 0;
        let lineCount = lines.length;

        salesMap = {};
        salesDetails = {};
        if (typeof PerfCache !== 'undefined') PerfCache.resetSalesStats();
        const heli = typeof HeliData !== 'undefined' ? HeliData : null;
        if (heli) heli.beginSales();

        const nextSalesMap = salesMap;
        const nextSalesDetails = salesDetails;
        const todayStart = dates.todayStart || (() => { const t = new Date(); t.setHours(0,0,0,0); return t; })();

        // крупные CSV: отдаём UI каждые N строк, чтобы не «замораживать» браузер
        const YIELD_EVERY = 2500;
        for (let li = 1; li < lineCount; li++) {
            const line = lines[li];
            if (!line || !line.trim()) continue;

            const row = parseCSVLine(line);
            if (row.length < 17) continue;
            if ((row[8] || '').toUpperCase() !== 'ETICKET') continue;
            // Младенец без места (тариф …/IN00, …/ID00) — не место в самолёте: в загрузке его нет,
            // поэтому и в продажах не считаем (иначе «продано 25» при загрузке 22).
            // Младенец с местом (…/IN50) оплачен и занимает кресло — его считаем.
            const nf = parseFloat(String(row[14] || '').replace(/[\s\u00a0]/g, '').replace(',', '.')) || 0;
            if (/\/(IN|ID)\d/i.test(row[13] || '') && !(nf > 0)) continue;

            const dedupKey = `${row[2] || ''}|${row[8] || ''}|${row[12] || ''}|${row[3] || ''}`.toUpperCase();
            if (seen.has(dedupKey)) continue;
            seen.add(dedupKey);

            const fly = parseSalesDateField(row[7]);
            const fl = cleanFlight(row[12]);
            if (!fly || !fl) continue;

            const deal = parseSalesDateField(row[5]);
            // Билеты вертолётных рейсов — отдельно (самолётные итоги, шапка и расчёты их не видят).
            if (heli && heli.isHeliFlight(fl)) {
                heli.addTicket(fly, fl, deal, row[10], row[11]);
                loaded++;
                continue;
            }

            const k = fly + '|' + fl;
            let bucket = nextSalesMap[k];
            if (!bucket) bucket = nextSalesMap[k] = emptySalesBucket();

            if (deal === dates.today) bucket.today++;
            else if (deal === dates.yesterday) bucket.yesterday++;
            else if (deal === dates.day2) bucket.day2++;

            const daysAgo = daysBetweenDates(deal, todayStart);
            if (daysAgo !== null && daysAgo >= 0) {
                if (daysAgo < 7) bucket.d7++;   // 7, 14 и 30 дней считаются с сегодняшнего дня
                if (daysAgo < 14) bucket.d14++;
                if (daysAgo < 30) bucket.d30++;
            }

            let list = nextSalesDetails[k];
            if (!list) list = nextSalesDetails[k] = [];
            const birth = parseSalesDateField(row[16]);
            const adj = getAdjustedFare(nf, row[13], birth || row[16], fly);
            list.push({
                dealDate: deal,
                pnr: row[4] || '',
                fare: nf,
                adjustedFare: adj,
                basicFareStr: row[13] || '',
                // ФИО и дата рождения из файла на сайте не хранятся (даже в памяти страницы): для расчётов нужен только возраст.
                ageAtFly: calculateAgeAtFly(birth || row[16], fly),
                flyDate: fly,
                bsonum: row[2] || '',
                city1: row[10] || '',
                city2: row[11] || ''
            });
            if (typeof PerfCache !== 'undefined') {
                PerfCache.recordSaleStat(k, deal, adj, nf, row[13] || '', dates.today, dates.yesterday);
            }
            loaded++;

            if (li % YIELD_EVERY === 0) {
                setLoadingMessage(`Загрузка продаж… ${Math.min(99, Math.round((li / lineCount) * 100))}%`);
                await new Promise((r) => setTimeout(r, 0));
            }
        }

        if (heli) heli.endSales();
        // Размер заказа (PNR) у каждого билета — для «групповых броней»; сам PNR дальше не нужен.
        if (typeof FlightInsights !== 'undefined') FlightInsights.annotateGroups(salesDetails);
        dataLoadStatus.sales = loaded > 0;
        tableHtmlCache = { sig: '', html: '' };
        if (!window.ingestQuiet) {
            if (typeof invalidateTabPanelState === 'function') invalidateTabPanelState();
            invalidateMetricsCache();
            updateHeaderWithLastUpdate();
            updateHeaderStatus();
        } else {
            updateHeaderWithLastUpdate();
        }
        return loaded;
    });
}
async function loadExpectedLoadFile(fh){
    if(!fh)return;
    const XLSX=await loadPlainXlsx();
    if(!XLSX)return;
    try{
        const wb=XLSX.read(await (await toFile(fh)).arrayBuffer(),{type:'array'});
        const sh=wb.Sheets[wb.SheetNames[0]];
        const json=XLSX.utils.sheet_to_json(sh,{header:1,raw:true});
        expectedLoadData={};
        for(let i=1;i<json.length;i++){
            const r=json[i];
            if(!r||r.length<4)continue;
            const cap=parseInt(r[0]),fn=parseInt(r[1]),du=parseInt(r[2]);
            if(!cap||!fn||isNaN(du))continue;
            const bf='KV-'+fn;
            for(let w=1;w<=52;w++){
                const idx=w+2;
                if(idx>=r.length)break;
                const v=parseFloat(r[idx]);
                if(!isNaN(v))expectedLoadData[`${cap}|${bf}|${du}|${w}`]=v;
            }
            if(i%40===0)await new Promise(r=>setTimeout(r,0));
        }
        dataLoadStatus.expected = true;
        if (!window.ingestQuiet) {
            invalidateMetricsCache();
            updateHeaderStatus();
        }
    }catch(e){console.error(e)}
}

function processData() {
    groupedData = {};
    const next = groupedData;
    const normTime = typeof normalizeTimeStr === 'function' ? normalizeTimeStr : null;
    for (let i = 0, n = allData.length; i < n; i++) {
        const r = allData[i];
        if (!r || r.length < 7 || !r[0] || !r[1]) continue;
        // снимок/старый парсер мог оставить «+1 08:45» — нормализуем до HH:MM
        if (normTime) {
            const t11 = r[11], t12 = r[12];
            if (t11 != null && t11 !== '' && !/^\d{1,2}:\d{2}$/.test(String(t11))) r[11] = normTime(t11);
            if (t12 != null && t12 !== '' && !/^\d{1,2}:\d{2}$/.test(String(t12))) r[12] = normTime(t12);
        }
        const b = getBaseFlight(cleanFlight(r[0]));
        if (!isValidFlightBase(b)) continue;
        if (!next[b]) next[b] = [];
        next[b].push(r);
    }
    if (typeof SegmentSplit !== 'undefined') SegmentSplit.splitRows(next);
    if (currentFlight && !isValidFlightBase(currentFlight)) currentFlight = null;
    tableHtmlCache = { sig: '', html: '' };
    if (!window.ingestQuiet) {
        if (typeof dataEpoch === 'number') dataEpoch++;
        updateHeaderStatus();
    }
}
