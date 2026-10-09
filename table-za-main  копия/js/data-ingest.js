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
                avg: Math.round(st.fareSum / st.count),
                last: st.lastFare || 0,
                lettr: String(st.lastBasicFare || '').trim()[0] || ''
            };
        }
    }
    const sl = salesDetails[key] || [];
    if (!sl.length) return { avg: 0, last: 0, lettr: '' };
    let sum = 0;
    for (let i = 0; i < sl.length; i++) sum += sl[i].adjustedFare || sl[i].fare || 0;
    let last = 0, lettr = '', lastTs = 0;
    for (let i = 0; i < sl.length; i++) {
        const x = sl[i];
        const ts = parseLocalDate(x.dealDate)?.getTime() || 0;
        const v = x.adjustedFare || x.fare || 0;
        if (v > 0 && ts >= lastTs) {
            lastTs = ts;
            last = v;
            lettr = String(x.basicFareStr || '').trim()[0] || '';
        }
    }
    return { avg: Math.round(sum / sl.length), last, lettr };
}

function getRevenueForRow(row, firstSalesByKey) {
    if (!row || !shouldAttachSalesToRowCached(row, firstSalesByKey)) return 0;
    if (typeof PerfCache !== 'undefined') {
        const st = PerfCache.getSalesStats(resolveSalesKey(row));
        if (st && st.fareSum) return st.fareSum;
    }
    return getSalesDetailsForRow(row).reduce((sum, x) => sum + (x.adjustedFare || x.fare || 0), 0);
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

function findSalesCsvFile(files) {
    const csvs = (files || []).filter(f => String(f.name || '').toLowerCase().endsWith('.csv'));
    if (!csvs.length) return null;
    const preferred = csvs.find(f => f.name.toLowerCase().includes('tickets_sale_last14days'));
    if (preferred) return preferred;
    const tickets = csvs.find(f => f.name.toLowerCase().includes('tickets_sale'));
    if (tickets) return tickets;
    return getLatestFilesFromList(csvs, 1)[0] || null;
}

function pickSourcesFromFolders(folderMap) {
    let avail = [], closed = [], sales = null;
    for (const [name, files] of Object.entries(folderMap)) {
        const l = name.toLowerCase();
        if (isLoadTabDirName(name)) {
            const csvFiles = files.filter(f => f.name.toLowerCase().endsWith('.csv'));
            avail = getLatestFilesFromList(csvFiles, 2);
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

function classifyFilesFromInput(fileList) {
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

    const picked = pickSourcesFromFolders(dirs);
    const xlsxAll = all.filter(f => /\.xlsx?$/i.test(f.name || '') && !String(f.name).startsWith('~$'));
    return {
        ...picked,
        exp: findExpectedLoadFile(all),
        weights: typeof findBaggageWeightsFile === 'function' ? findBaggageWeightsFile(all) : null,
        children: typeof findChildrenCsvFile === 'function'
            ? (findChildrenCsvFile(all) || findChildrenCsvFile(rootCsv))
            : null,
        sales: findSalesCsvFile(all) || picked.sales,
        costs: typeof RouteCosts !== 'undefined' ? RouteCosts.findCostsFile(xlsxAll) : null,
        subsidyPeriods: typeof RouteCosts !== 'undefined' ? RouteCosts.findPeriodsFile(xlsxAll) : null
    };
}

function resetDataBeforeLoad() {
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
    CACHED_TODAY = null;
    CACHED_YESTERDAY = null;
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

    for await (const [name, h] of dir.entries()) {
        if (h.kind === 'directory') {
            const lname = name.toLowerCase();
            const csvHandles = [];
            for await (const [fn, fh] of h.entries()) {
                if (fh.kind !== 'file') continue;
                const fl = fn.toLowerCase();
                if (fl.endsWith('.csv')) csvHandles.push({ name: fn, handle: fh });
                else if (fl.endsWith('.xlsx') && lname.includes('весов') && fl.includes('весов')) {
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
            rootEntries.push({ name, handle: h });
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
        if (isLoadTabDirName(lname) || lname.includes('база закрытие') || lname.includes('базазакрытие')) {
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
    return {
        ...pickSourcesFromFolders(folderMap),
        exp: findExpectedLoadFile(rootReady),
        weights: weightsFile || (typeof findBaggageWeightsFile === 'function' ? findBaggageWeightsFile(rootReady) : null),
        children: typeof findChildrenCsvFile === 'function' ? findChildrenCsvFile(rootReady) : null,
        costs: costsFile,
        subsidyPeriods: subsidyFile
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
        const sources = classifyFilesFromInput(fileList);
        if (!sources.avail.length && !sources.closed.length && !sources.sales && !sources.exp && !sources.weights) {
            showToast('В папке не найдены нужные файлы (загрузка таб, закрытие, продажи)', 'error');
            return;
        }
        await processDataFromSources(sources.avail, sources.closed, sources.sales, sources.exp, sources.weights, sources.children, sources.costs, sources.subsidyPeriods);
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
    for(const fh of files){
        const file = await toFile(fh);
        const txt = await readCsvText(file);
        const parsed = typeof parseAvailabilityTextAsync === 'function'
            ? await parseAvailabilityTextAsync(txt, (p) => setLoadingMessage(`Загрузка таб… ${p}%`))
            : parseAvailabilityText(txt);
        if (parsed.length) allData.push(...parsed);
    }
    allData = dedupeAvailabilityRows(allData.filter(r => r.length >= 7 && r[0] && r[1]));
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
            if (/BSONUM/i.test(head) && /FLYDATE/i.test(head)) {
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
            if (/\/(IN|ID)\d/i.test(row[13] || '')) continue;

            const dedupKey = `${row[2] || ''}|${row[8] || ''}|${row[12] || ''}|${row[3] || ''}`.toUpperCase();
            if (seen.has(dedupKey)) continue;
            seen.add(dedupKey);

            const fly = parseSalesDateField(row[7]);
            const fl = cleanFlight(row[12]);
            if (!fly || !fl) continue;

            const k = fly + '|' + fl;
            let bucket = nextSalesMap[k];
            if (!bucket) bucket = nextSalesMap[k] = emptySalesBucket();

            const deal = parseSalesDateField(row[5]);
            if (deal === dates.today) bucket.today++;
            else if (deal === dates.yesterday) bucket.yesterday++;
            else if (deal === dates.day2) bucket.day2++;

            const daysAgo = daysBetweenDates(deal, todayStart);
            if (daysAgo !== null && daysAgo >= 0) {
                if (daysAgo < 7) bucket.d7++;
                if (daysAgo < 14) bucket.d14++;
                if (daysAgo < 30) bucket.d30++;
            }

            let list = nextSalesDetails[k];
            if (!list) list = nextSalesDetails[k] = [];
            const nf = parseFloat(String(row[14] || '').replace(',', '.')) || 0;
            const birth = parseSalesDateField(row[16]);
            const adj = getAdjustedFare(nf, row[13], birth || row[16], fly);
            list.push({
                dealDate: deal,
                pnr: row[4] || '',
                fio: row[3] || '',
                fare: nf,
                adjustedFare: adj,
                basicFareStr: row[13] || '',
                birthDate: birth || row[16] || '',
                flyDate: fly,
                bsonum: row[2] || ''
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
    if (currentFlight && !isValidFlightBase(currentFlight)) currentFlight = null;
    tableHtmlCache = { sig: '', html: '' };
    if (!window.ingestQuiet) {
        if (typeof dataEpoch === 'number') dataEpoch++;
        updateHeaderStatus();
    }
}
