// js\excel-export.js - extracted from script.js, logic unchanged.
// Globals on purpose: no bundler; onclick and other files call by name.

/** Не давать Excel исполнять =cmd| и формулы из ячеек-текста. Числа не трогаем. */
function excelSafeCell(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'boolean') return v;
    const s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) return { t: 's', v: s };
    return v;
}

function excelSafeRow(row) {
    return (row || []).map(excelSafeCell);
}

const EXCEL_NAVY = '012A4A';
const EXCEL_LINE = '5D6D7E';
const EXCEL_INK = '1C2833';
const EXCEL_ZEBRA = 'F7F9FB';
const EXCEL_OUT = 'EAF2FB';
const EXCEL_IN = 'E8F6EF';

function excelInk(rgb) {
    const num = parseInt(String(rgb || '').replace('#', ''), 16);
    if (!isFinite(num)) return EXCEL_INK;
    const channel = (c) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    const light = 0.2126 * channel((num >> 16) & 255)
        + 0.7152 * channel((num >> 8) & 255)
        + 0.0722 * channel(num & 255);
    return light < 0.45 ? 'FFFFFF' : EXCEL_INK;
}

function excelExportStamp() {
    const now = new Date();
    const date = typeof formatDateRu === 'function' ? formatDateRu(now) : '';
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    return date ? `${date} ${hh}:${mm}` : `${hh}:${mm}`;
}

async function loadStyledXlsx() {
    if (window.XLSXStyle) return window.XLSXStyle;
    // Сначала обычная библиотека: цветная грузится поверх и возвращает window.XLSX на место.
    await loadPlainXlsx();
    if (window.XLSXStyle) return window.XLSXStyle;
    return new Promise(resolve => {
        const plain = window.XLSX;
        const script = document.createElement('script');
        script.src = 'js/vendor/xlsx-js-style.min.js';
        script.onload = () => {
            window.XLSXStyle = window.XLSX;
            if (plain) window.XLSX = plain;
            resolve(window.XLSXStyle);
        };
        script.onerror = () => {
            if (plain) window.XLSX = plain;
            resolve(null);
        };
        document.head.appendChild(script);
    });
}

function excelStyle(fill, color, bold, horizontal, wrap, border, seam) {
    const style = {
        fill: { patternType: 'solid', fgColor: { rgb: fill || 'FFFFFF' } },
        font: { name: 'Calibri', sz: 11, bold: !!bold, color: { rgb: color || EXCEL_INK } },
        alignment: { horizontal: horizontal || 'center', vertical: 'center', wrapText: !!wrap }
    };
    if (border) {
        const edge = { style: 'thin', color: { rgb: EXCEL_LINE } };
        const hidden = { style: 'thin', color: { rgb: fill || 'FFFFFF' } };
        const hide = seam || {};
        style.border = {
            top: hide.top ? hidden : edge,
            bottom: hide.bottom ? hidden : edge,
            left: hide.left ? hidden : edge,
            right: hide.right ? hidden : edge
        };
    }
    return style;
}

function excelLeftHeader(text) {
    return /направлен|маршрут|коммент|причин/i.test(String(text || ''));
}

function excelHeaderSide(text) {
    const name = String(text || '').toLowerCase();
    if (name.includes('обратно') || name.includes('←')) return 'in';
    if (name.includes('туда') || name.includes('→')) return 'out';
    return '';
}

function readHtmlTableForExcel(table) {
    const grid = [];
    const tags = [];
    const occupied = [];
    const merges = [];
    let headerRows = 0;
    let r = 0;
    Array.from(table.rows || []).forEach(tr => {
        const inHead = !!(tr.parentElement && tr.parentElement.tagName === 'THEAD');
        if (inHead) headerRows += 1;
        let c = 0;
        const rowTag = tr.classList.contains('flew-flight') ? 'flew'
            : (tr.classList.contains('closed-flight') ? 'closed'
                : (tr.classList.contains('full-loaded') ? 'full' : ''));
        Array.from(tr.cells || []).forEach(cell => {
            while (occupied[r] && occupied[r][c]) c += 1;
            const rowspan = Math.max(1, parseInt(cell.getAttribute('rowspan') || '1', 10) || 1);
            const colspan = Math.max(1, parseInt(cell.getAttribute('colspan') || '1', 10) || 1);
            const input = cell.querySelector('input, textarea');
            const text = input
                ? String(input.value || '').trim()
                : String(cell.innerText || '').replace(/\s+/g, ' ').trim();
            let tag = rowTag;
            const cls = cell.className || '';
            if (/pair-leg-out|pair-sub-out|pair-dir-out/.test(cls)) tag = 'out';
            else if (/pair-leg-in|pair-sub-in|pair-dir-in/.test(cls)) tag = 'in';
            for (let rr = 0; rr < rowspan; rr++) {
                for (let cc = 0; cc < colspan; cc++) {
                    const pr = r + rr;
                    const pc = c + cc;
                    if (!occupied[pr]) occupied[pr] = [];
                    occupied[pr][pc] = true;
                    if (!grid[pr]) grid[pr] = [];
                    if (!tags[pr]) tags[pr] = [];
                    if (rr === 0 && cc === 0) grid[pr][pc] = text;
                    else if (grid[pr][pc] == null) grid[pr][pc] = '';
                    if (!tags[pr][pc]) tags[pr][pc] = tag;
                }
            }
            if (rowspan > 1 || colspan > 1) {
                merges.push({ s: { r, c }, e: { r: r + rowspan - 1, c: c + colspan - 1 } });
            }
            c += colspan;
        });
        r += 1;
    });
    if (!headerRows) headerRows = grid.length ? 1 : 0;
    const width = grid.reduce((max, row) => Math.max(max, row ? row.length : 0), 0);
    const rows = grid.map(row => {
        const next = (row || []).slice();
        while (next.length < width) next.push('');
        return next;
    });
    return { rows, tags, merges, headerRows };
}

function excelPaintValue(tag, value) {
    if (tag === 'out') return { fill: EXCEL_OUT };
    if (tag === 'in') return { fill: EXCEL_IN };
    if (tag === 'flew') return { fill: 'E5E8EB', color: '2C3E50' };
    if (tag === 'closed') return { fill: 'F5B7B1', color: '7B241C' };
    if (tag === 'full') return { fill: 'D5F5E3', color: '145A32' };
    if (tag === 'warn') return { fill: 'F7DC6F', color: '3D3206', bold: true };
    if (tag === 'crit') return { fill: 'F5B7B1', color: '7B241C', bold: true };
    const num = typeof value === 'number' ? value : null;
    if (tag === 'alert' && num !== null) {
        if (num >= 3) return { fill: 'F5B7B1', color: '7B241C', bold: true };
        if (num >= 2) return { fill: 'F7DC6F', color: '3D3206', bold: true };
    }
    return null;
}

function excelDecorateSheet(lib, ws, meta) {
    if (!ws || !ws['!ref'] || !lib.utils) return;
    const range = lib.utils.decode_range(ws['!ref']);
    const headerRows = meta.headerRows || 1;
    const leftCols = meta.leftCols || new Set();
    const tags = meta.tags || [];
    const seam = [];
    (meta.merges || []).forEach(merge => {
        const top = merge.s.r + 1;
        const bottom = merge.e.r + 1;
        for (let r = top; r <= bottom; r++) {
            for (let c = merge.s.c; c <= merge.e.c; c++) {
                if (!seam[r]) seam[r] = [];
                seam[r][c] = {
                    top: r > top,
                    bottom: r < bottom,
                    left: c > merge.s.c,
                    right: c < merge.e.c
                };
            }
        }
    });
    const widths = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
        for (let c = range.s.c; c <= range.e.c; c++) {
            if (r === 0 && c > 0) continue;
            const addr = lib.utils.encode_cell({ r, c });
            const cell = ws[addr] || { t: 's', v: '' };
            const text = cell.v == null ? '' : String(cell.v);
            widths[c] = Math.min(40, Math.max(widths[c] || 11, text.length + 2));
            let fill = 'FFFFFF';
            let color = EXCEL_INK;
            let bold = false;
            let horizontal = 'center';
            let wrap = false;
            let border = r > 0;
            if (r === 0) {
                color = EXCEL_NAVY;
                bold = true;
                horizontal = 'left';
                border = false;
            } else if (r <= headerRows) {
                fill = EXCEL_NAVY;
                color = 'FFFFFF';
                bold = true;
                wrap = true;
                if (leftCols.has(c)) horizontal = 'left';
            } else if ((r - headerRows) % 2 === 0) {
                fill = EXCEL_ZEBRA;
            }
            if (r > headerRows && leftCols.has(c)) horizontal = 'left';
            const tag = tags[r - 1] && tags[r - 1][c];
            const paint = excelPaintValue(tag, cell.v);
            if (paint && r > headerRows) {
                if (paint.fill) fill = paint.fill;
                if (paint.color) color = paint.color;
                if (paint.bold) bold = true;
            }
            cell.s = excelStyle(fill, color, bold, horizontal, wrap, border, seam[r] && seam[r][c]);
            if (cell.v == null) cell.v = '';
            if (!cell.t) cell.t = 's';
            ws[addr] = cell;
        }
    }
    ws['!cols'] = widths.map(wch => ({ wch: wch || 12 }));
    const rows = [{ hpt: 20 }];
    for (let i = 1; i <= headerRows; i++) rows[i] = { hpt: 32 };
    ws['!rows'] = rows;
    const cols = range.e.c - range.s.c + 1;
    const merges = [{ s: { r: 0, c: 0 }, e: { r: 0, c: Math.max(0, cols - 1) } }];
    (meta.merges || []).forEach(merge => {
        merges.push({
            s: { r: merge.s.r + 1, c: merge.s.c },
            e: { r: merge.e.r + 1, c: merge.e.c }
        });
    });
    ws['!merges'] = merges;
    ws['!views'] = [{
        state: 'frozen',
        xSplit: meta.freezeCols || 0,
        ySplit: headerRows + 1,
        topLeftCell: lib.utils.encode_cell({ r: headerRows + 1, c: meta.freezeCols || 0 })
    }];
}

function excelSheetFromRows(lib, name, bodyRows, options) {
    const stamp = excelExportStamp();
    const rows = [[`Дата выгрузки: ${stamp}`]].concat(bodyRows || []);
    const safe = rows.map(row => (typeof excelSafeRow === 'function' ? excelSafeRow(row) : row));
    const ws = lib.utils.aoa_to_sheet(safe);
    const header = bodyRows && bodyRows[0] ? bodyRows[0] : [];
    const leftCols = new Set();
    header.forEach((label, index) => {
        if (excelLeftHeader(label)) leftCols.add(index);
    });
    const tags = [header.map(() => '')];
    const alertCol = header.findIndex(label => String(label || '').indexOf('Уровень предупреждения') !== -1);
    (bodyRows || []).slice(1).forEach(row => {
        tags.push((row || []).map((value, index) => {
            if (index === alertCol) return 'alert';
            return excelHeaderSide(header[index]);
        }));
    });
    if (options && options.colored) {
        excelDecorateSheet(lib, ws, {
            headerRows: 1,
            leftCols,
            tags,
            freezeCols: options.freezeCols || 0
        });
    }
    return { ws, stamp, name };
}

function excelFolderKinds() {
    return [
        { id: 'sales', label: 'Управление продажами' },
        { id: 'data', label: 'Загрузка рейсов' },
        { id: 'rms', label: 'RMS' },
        { id: 'table', label: 'Динамика продаж' },
        { id: 'pkz', label: 'ПКЗ' },
        { id: 'pair', label: 'Экономическая таблица' },
        { id: 'creative', label: 'Творческая' },
        { id: 'econ', label: 'Отчёт для экономистов' }
    ];
}

function excelFoldersSupported() {
    return typeof window.showDirectoryPicker === 'function' && window.isSecureContext;
}

function excelProfileId() {
    const prof = typeof ProfileAuth !== 'undefined' && typeof ProfileAuth.getCurrentProfile === 'function'
        ? ProfileAuth.getCurrentProfile()
        : null;
    return String((prof && prof.id) || 'guest');
}

function excelSafeFilename(name) {
    const clean = String(name || 'КРАСАВИА.xlsx')
        .replace(/[\\/:*?"<>|]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!clean) return 'КРАСАВИА.xlsx';
    return /\.xlsx$/i.test(clean) ? clean : clean + '.xlsx';
}

/** Одно имя на календарный день: вечерняя выгрузка заменяет утреннюю, завтра — новый файл. */
function excelDailyFilename(prefix, stampOrDate) {
    const raw = String(stampOrDate || '');
    const matched = raw.match(/(\d{2})\.(\d{2})\.(\d{4})/);
    const date = matched
        ? `${matched[1]}-${matched[2]}-${matched[3]}`
        : raw.slice(0, 10).replace(/\./g, '-').replace(/[^\d-]/g, '');
    return excelSafeFilename(`${prefix}_${date}.xlsx`);
}

function excelDirDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('krasavia_excel_dirs', 1);
        req.onerror = () => reject(req.error);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles');
        };
        req.onsuccess = () => resolve(req.result);
    });
}

function excelDirKey(kind) {
    return excelProfileId() + ':' + kind;
}

async function excelDirRead(kind) {
    const db = await excelDirDb();
    try {
        return await new Promise((resolve) => {
            const tx = db.transaction('handles', 'readonly');
            const req = tx.objectStore('handles').get(excelDirKey(kind));
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
        });
    } finally {
        db.close();
    }
}

async function excelDirWrite(kind, record) {
    const db = await excelDirDb();
    try {
        await new Promise((resolve, reject) => {
            const tx = db.transaction('handles', 'readwrite');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.objectStore('handles').put(record, excelDirKey(kind));
        });
    } finally {
        db.close();
    }
}

async function excelDirDelete(kind) {
    const db = await excelDirDb();
    try {
        await new Promise((resolve, reject) => {
            const tx = db.transaction('handles', 'readwrite');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.objectStore('handles').delete(excelDirKey(kind));
        });
    } finally {
        db.close();
    }
}

async function excelFolderCatalog() {
    const items = excelFolderKinds();
    const out = [];
    for (let i = 0; i < items.length; i++) {
        let name = '';
        try {
            const stored = await excelDirRead(items[i].id);
            name = stored && (stored.name || (stored.handle && stored.handle.name)) || '';
        } catch (e) { /* ignore */ }
        out.push({ id: items[i].id, label: items[i].label, name });
    }
    return out;
}

async function excelPickFolder(kind) {
    if (!excelFoldersSupported()) {
        throw new Error('unsupported');
    }
    const pickerId = 'krasavia-excel-' + kind;
    let handle;
    try {
        handle = await window.showDirectoryPicker({ mode: 'readwrite', id: pickerId });
    } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    }
    const name = handle.name || 'папка';
    await excelDirWrite(kind, { handle, name });
    return name;
}

async function excelClearFolder(kind) {
    await excelDirDelete(kind);
}

async function excelPrepareFolder(kind) {
    if (!kind) return null;
    let stored = null;
    try { stored = await excelDirRead(kind); } catch (e) { return null; }
    if (!stored || !stored.handle) return null;
    const handle = stored.handle;
    const name = stored.name || handle.name || 'папка';
    try {
        let perm = await handle.queryPermission({ mode: 'readwrite' });
        if (perm !== 'granted') perm = await handle.requestPermission({ mode: 'readwrite' });
        if (perm !== 'granted') return { denied: true, name };
        return { handle, name };
    } catch (e) {
        return { denied: true, name };
    }
}

function excelBytes(data) {
    if (!data) return new Uint8Array(0);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return new Uint8Array(data);
}

function excelWriteBusy(error) {
    if (error && error.name === 'NoModificationAllowedError') return true;
    return /lock|in use|being used|sharing violation|занят|используется/i.test(String((error && error.message) || ''));
}

async function excelWriteHandle(file, bytes) {
    const writable = await file.createWritable({ keepExistingData: false });
    try {
        await writable.write(bytes);
        await writable.close();
    } catch (e) {
        try { await writable.abort(); } catch (ignore) { /* временный файл уже закрыт */ }
        throw e;
    }
}

async function excelReplaceFile(dir, filename, bytes) {
    let existed = false;
    try {
        await dir.getFileHandle(filename);
        existed = true;
    } catch (e) {
        if (!e || e.name !== 'NotFoundError') throw e;
    }
    const file = await dir.getFileHandle(filename, { create: true });
    try {
        await excelWriteHandle(file, bytes);
    } catch (e) {
        if (!existed || !excelWriteBusy(e)) throw e;
        const busy = new Error('locked');
        busy.code = 'locked';
        throw busy;
    }
    let saved = null;
    try { saved = await file.getFile(); } catch (e) { saved = null; }
    if (!saved || saved.size === bytes.byteLength) return existed;
    if (saved.size < bytes.byteLength) {
        await excelWriteHandle(file, bytes);
        return existed;
    }
    try {
        await dir.removeEntry(filename);
    } catch (e) {
        const busy = new Error('locked');
        busy.code = 'locked';
        throw busy;
    }
    const fresh = await dir.getFileHandle(filename, { create: true });
    await excelWriteHandle(fresh, bytes);
    return existed;
}

async function excelSaveWorkbook(lib, wb, filename, prepared) {
    const safe = excelSafeFilename(filename);
    if (!prepared || !prepared.handle) {
        lib.writeFile(wb, safe);
        return { where: 'download', filename: safe, failedFolder: !!(prepared && prepared.denied) };
    }
    let bytes;
    try {
        bytes = excelBytes(lib.write(wb, { bookType: 'xlsx', type: 'array' }));
    } catch (e) {
        console.error(e);
        lib.writeFile(wb, safe);
        return { where: 'download', filename: safe, failedFolder: true };
    }
    try {
        const replaced = await excelReplaceFile(prepared.handle, safe, bytes);
        return {
            where: 'folder',
            filename: safe,
            folder: prepared.name || prepared.handle.name || 'папка',
            replaced: !!replaced
        };
    } catch (e) {
        console.error(e);
        if (e && e.code === 'locked') {
            return {
                where: 'locked',
                filename: safe,
                folder: prepared.name || prepared.handle.name || 'папка'
            };
        }
        lib.writeFile(wb, safe);
        return { where: 'download', filename: safe, failedFolder: true };
    }
}

function excelAnnounceSaved(saved, fallback) {
    if (typeof showToast !== 'function') return;
    if (saved && saved.where === 'folder') {
        const verb = saved.replaced ? 'Файл за сегодня заменён' : 'Файл сохранён';
        showToast(`${verb} в папке «${saved.folder}»: ${saved.filename}`);
        return;
    }
    if (saved && saved.where === 'locked') {
        showToast(`Файл «${saved.filename}» открыт в Excel. Закройте его и выгрузите ещё раз — новая выгрузка заменит сегодняшний файл.`, 'error');
        return;
    }
    if (saved && saved.failedFolder) {
        showToast('Папка недоступна, файл скачан в загрузки', 'error');
        return;
    }
    showToast(fallback);
}

async function excelWriteBook(sheetName, bodyRows, filename, options) {
    // Сначала папка: разрешение на неё браузер даёт только сразу после клика, а библиотека может грузиться секунды.
    const folder = await excelPrepareFolder(options && options.kind);
    if (!(await loadPlainXlsx())) {
        if (typeof showToast === 'function') showToast('Библиотека Excel не загружена', 'error');
        return;
    }
    if (typeof showToast === 'function') showToast('Готовлю Excel…');
    const styled = await loadStyledXlsx();
    const lib = styled || XLSX;
    const built = excelSheetFromRows(lib, sheetName, bodyRows, { colored: !!styled, freezeCols: options && options.freezeCols });
    const wb = lib.utils.book_new();
    lib.utils.book_append_sheet(wb, built.ws, sheetName);
    const saved = await excelSaveWorkbook(lib, wb, filename, folder);
    excelAnnounceSaved(saved, `Файл готов, дата выгрузки ${built.stamp}`);
}

// ==================== ЭКСПОРТ В EXCEL ====================
// «Загрузка рейсов»: карточки маршрутов в ряд, как на экране, а не один общий список.

function dataBoardExcelShowTimes() {
    return typeof dataShowLocalTimes !== 'undefined' && !!dataShowLocalTimes;
}

function dataBoardExcelShowBooks() {
    return typeof dataShowSpecBookings !== 'undefined' && !!dataShowSpecBookings;
}

function dataBoardExcelRgb(value) {
    const raw = String(value || '').replace('#', '').trim();
    return /^[0-9a-fA-F]{6}$/.test(raw) ? raw.toUpperCase() : '';
}

function dataBoardExcelMix(hex, base, weight) {
    const channels = (h) => {
        const n = parseInt(h, 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    };
    const a = channels(hex);
    const b = channels(base);
    return a.map((v, i) => {
        const mixed = Math.round(v * weight + b[i] * (1 - weight));
        return Math.max(0, Math.min(255, mixed)).toString(16).padStart(2, '0');
    }).join('').toUpperCase();
}

function dataBoardExcelHighlightFill(hex, weekEven) {
    const rgb = dataBoardExcelRgb(hex);
    if (!rgb) return '';
    return weekEven ? dataBoardExcelMix(rgb, 'DBEAFE', 0.22) : dataBoardExcelMix(rgb, 'FFFFFF', 0.28);
}

function dataBoardExcelLegSpec() {
    const labels = [];
    const kinds = [];
    if (dataBoardExcelShowTimes()) {
        labels.push('ВР. ВЫЛЕТА', 'ВР. ПРИЛЕТА');
        kinds.push('time', 'time');
    }
    labels.push('КРЕС.');
    kinds.push('seats');
    if (dataBoardExcelShowBooks()) {
        labels.push('СПЕЦ. БРОНИ');
        kinds.push('book');
    }
    labels.push('ЗАГР.', 'ЗПК');
    kinds.push('load', 'zpk');
    return { labels, kinds };
}

function dataBoardExcelKindWidth(kind) {
    if (kind === 'date') return 24;
    if (kind === 'day') return 12;
    if (kind === 'time') return 13;
    if (kind === 'book') return 14;
    if (kind === 'avg') return 11;
    if (kind === 'gap') return 3;
    return 10;
}

function dataBoardExcelStyle(fill, color, bold, horizontal, wrap, spec) {
    const useBorder = !!(spec && spec.border);
    const style = excelStyle(fill, color, bold, horizontal, wrap, useBorder, spec && spec.seam);
    if (spec && spec.quiet) {
        const hidden = { style: 'thin', color: { rgb: fill || 'FFFFFF' } };
        style.border = { top: hidden, bottom: hidden, left: hidden, right: hidden };
        return style;
    }
    if (useBorder && style.border) {
        if (spec.splitLeft) style.border.left = { style: 'medium', color: { rgb: '0A0A0A' } };
        if (spec.splitRight) style.border.right = { style: 'medium', color: { rgb: '0A0A0A' } };
    }
    return style;
}

function dataBoardPutCell(lib, ws, r, c, value, style) {
    const safe = typeof excelSafeCell === 'function' ? excelSafeCell(value) : value;
    const addr = lib.utils.encode_cell({ r, c });
    let cell;
    if (safe && typeof safe === 'object' && safe.t === 's') cell = { t: 's', v: safe.v };
    else if (typeof safe === 'number' && isFinite(safe)) cell = { t: 'n', v: safe };
    else if (typeof safe === 'boolean') cell = { t: 'b', v: safe };
    else cell = { t: 's', v: safe == null ? '' : String(safe) };
    if (style) cell.s = style;
    ws[addr] = cell;
}

function dataBoardPaint(lib, ws, merges, r1, c1, r2, c2, value, fill, color, bold, horizontal, wrap, spec) {
    const quiet = !!(spec && spec.quiet);
    const useBorder = !quiet && (!spec || spec.border !== false);
    for (let r = r1; r <= r2; r++) {
        for (let c = c1; c <= c2; c++) {
            const seam = { top: r > r1, bottom: r < r2, left: c > c1, right: c < c2 };
            const style = dataBoardExcelStyle(fill, color, bold, horizontal, wrap, {
                border: useBorder,
                quiet,
                seam: useBorder ? seam : null,
                splitLeft: !!(spec && spec.splitLeft && c === c1),
                splitRight: !!(spec && spec.splitRight && c === c2)
            });
            dataBoardPutCell(lib, ws, r, c, (r === r1 && c === c1) ? value : '', style);
        }
    }
    if (r2 > r1 || c2 > c1) merges.push({ s: { r: r1, c: c1 }, e: { r: r2, c: c2 } });
}

function dataBoardExcelDateLabel(entry, pair) {
    const label = typeof formatPairDateLabel === 'function'
        ? formatPairDateLabel(entry.outRow, entry.inRow, entry.date)
        : (entry.date || '');
    const extras = [];
    [[entry.outRow, pair.outbound], [entry.inRow, pair.inbound]].forEach(part => {
        const row = part[0];
        const code = part[1];
        if (!row || typeof cleanFlight !== 'function') return;
        const orig = cleanFlight(row[0]);
        if (orig && orig !== code) extras.push(String(orig).replace(/^KV-/, ''));
    });
    return extras.length ? `${label} ${extras.join('/')}` : label;
}

function dataBoardExcelEntryState(entry, todayStart) {
    const outRow = entry.outRow;
    const inRow = entry.inRow;
    const outM = outRow && typeof getDataLegMetrics === 'function' ? getDataLegMetrics(outRow) : {};
    const inM = inRow && typeof getDataLegMetrics === 'function' ? getDataLegMetrics(inRow) : {};
    const closedOut = !!(outRow && typeof isDataLegClosed === 'function' && isDataLegClosed(outRow));
    const closedIn = !!(inRow && typeof isDataLegClosed === 'function' && isDataLegClosed(inRow));
    const flewOut = !!(outRow && typeof isDataLegFlew === 'function' && isDataLegFlew(outRow, todayStart));
    const flewIn = !!(inRow && typeof isDataLegFlew === 'function' && isDataLegFlew(inRow, todayStart));
    const bothClosed = closedOut && closedIn;
    const bothFlew = (!outRow || flewOut) && (!inRow || flewIn) && !!(outRow || inRow);
    const avg = typeof getEntryAvgZpk === 'function' ? getEntryAvgZpk(entry) : -1;
    const yellowOut = !!(outRow && !flewOut && !closedOut && outM.zpk != null && outM.zpk >= 100);
    const yellowIn = !!(inRow && !flewIn && !closedIn && inM.zpk != null && inM.zpk >= 100);
    const fd = typeof parseLocalDate === 'function' ? parseLocalDate(entry.date) : null;
    const week = typeof getWeekNumber === 'function' ? getWeekNumber(fd) : 1;
    let customOut = '';
    let customIn = '';
    if (!bothClosed && typeof DataBoardFilters !== 'undefined' && typeof DataBoardFilters.highlightForLeg === 'function') {
        if (outRow && !closedOut && !flewOut && !yellowOut) {
            const hit = DataBoardFilters.highlightForLeg(outRow);
            if (hit && hit.color) customOut = hit.color;
        }
        if (inRow && !closedIn && !flewIn && !yellowIn) {
            const hit = DataBoardFilters.highlightForLeg(inRow);
            if (hit && hit.color) customIn = hit.color;
        }
    }
    return {
        bothGray: bothClosed || bothFlew,
        grayOut: !!(outRow && (closedOut || flewOut)),
        grayIn: !!(inRow && (closedIn || flewIn)),
        yellowOut,
        yellowIn,
        yellowAvg: !bothFlew && !bothClosed && avg >= 100,
        customOut,
        customIn,
        weekEven: (Number(week) % 2) === 0,
        avg,
        bothClosed
    };
}

function dataBoardExcelBodyLook(part, state) {
    const slate = '0F172A';
    if (state.bothGray) return { fill: '94A3B8', color: slate, bold: part === 'avg' };
    if (part === 'out' && state.grayOut) return { fill: '94A3B8', color: slate, bold: false };
    if (part === 'in' && state.grayIn) return { fill: '94A3B8', color: slate, bold: false };
    const yellow = (part === 'out' && state.yellowOut)
        || (part === 'in' && state.yellowIn)
        || (part === 'avg' && state.yellowAvg);
    if (yellow) return { fill: 'FACC15', color: slate, bold: true };
    const custom = part === 'out' ? state.customOut : (part === 'in' ? state.customIn : '');
    if (custom) {
        const mixed = dataBoardExcelHighlightFill(custom, state.weekEven);
        if (mixed) return { fill: mixed, color: slate, bold: false };
    }
    return { fill: state.weekEven ? 'DBEAFE' : 'FFFFFF', color: '1C2833', bold: part === 'avg' };
}

function dataBoardExcelLegValues(row, closed) {
    const showTimes = dataBoardExcelShowTimes();
    const showBooks = dataBoardExcelShowBooks();
    if (!row) {
        const dashes = [];
        if (showTimes) dashes.push('—', '—');
        dashes.push('—');
        if (showBooks) dashes.push('—');
        dashes.push('—', '—');
        return dashes;
    }
    const m = typeof getDataLegMetrics === 'function'
        ? getDataLegMetrics(row)
        : { seats: null, load: null, zpk: null, bookings: null };
    const vals = [];
    if (showTimes) {
        const dep = typeof getDepTime === 'function' ? getDepTime(row) : '';
        const arr = typeof getArrTime === 'function' ? getArrTime(row) : '';
        vals.push(dep || '—', arr || '—');
    }
    vals.push(m.seats != null ? m.seats : '—');
    if (showBooks) vals.push(m.bookings != null ? m.bookings : '—');
    vals.push(m.load != null ? m.load : '—');
    vals.push(closed ? 'ЗАКРЫТ' : (m.zpk != null ? `${m.zpk}%` : '—'));
    return vals;
}

function dataBoardExcelCaption(pair) {
    const typeLabel = typeof getFlightRouteTypeLabel === 'function' ? getFlightRouteTypeLabel(pair.outbound) : '';
    const routes = `${pair.outDir || ''}  ⇄  ${pair.inDir || ''}`.trim();
    return typeLabel ? `${routes}   ·   ${String(typeLabel).toUpperCase()}` : routes;
}

function dataBoardPaintCard(lib, ws, merges, origin, card, spec, todayStart, maxR) {
    const labels = spec.labels;
    const legCount = labels.length;
    const cardWidth = 2 + legCount * 2 + 1;
    const pair = card.pair;
    const navy = '012A4A';
    const outFill = '1E40AF';
    const inFill = '047857';
    const white = 'FFFFFF';
    dataBoardPaint(lib, ws, merges, 1, origin, 1, origin + cardWidth - 1, dataBoardExcelCaption(pair), navy, white, true, 'left', true, { border: true });
    dataBoardPaint(lib, ws, merges, 2, origin, 3, origin, 'ДАТА\nрейса', navy, white, true, 'left', true, { border: true });
    dataBoardPaint(lib, ws, merges, 2, origin + 1, 3, origin + 1, 'ДЕНЬ', navy, white, true, 'center', true, { border: true });
    const outStart = origin + 2;
    const inStart = outStart + legCount;
    const avgCol = inStart + legCount;
    dataBoardPaint(lib, ws, merges, 2, outStart, 2, outStart + legCount - 1, `→\nТУДА\n${pair.outbound || ''}`, outFill, white, true, 'center', true, { border: true, splitRight: true });
    dataBoardPaint(lib, ws, merges, 2, inStart, 2, inStart + legCount - 1, `←\nОБРАТНО\n${pair.inbound || ''}`, inFill, white, true, 'center', true, { border: true, splitLeft: true });
    dataBoardPaint(lib, ws, merges, 2, avgCol, 3, avgCol, 'СР.\nзпк', navy, white, true, 'center', true, { border: true, splitLeft: true });
    labels.forEach((label, index) => {
        dataBoardPaint(lib, ws, merges, 3, outStart + index, 3, outStart + index, label, outFill, white, true, 'center', true, {
            border: true,
            splitRight: index === legCount - 1
        });
        dataBoardPaint(lib, ws, merges, 3, inStart + index, 3, inStart + index, label, inFill, white, true, 'center', true, {
            border: true,
            splitLeft: index === 0
        });
    });
    card.entries.forEach((entry, index) => {
        const r = 4 + index;
        const state = dataBoardExcelEntryState(entry, todayStart);
        const info = dataBoardExcelBodyLook('info', state);
        const outLook = dataBoardExcelBodyLook('out', state);
        const inLook = dataBoardExcelBodyLook('in', state);
        const avgLook = dataBoardExcelBodyLook('avg', state);
        const day = typeof formatPairDayOfWeek === 'function'
            ? formatPairDayOfWeek(entry.outRow, entry.inRow, entry.date)
            : '';
        dataBoardPaint(lib, ws, merges, r, origin, r, origin, dataBoardExcelDateLabel(entry, pair), info.fill, info.color, info.bold, 'left', false, { border: true });
        dataBoardPaint(lib, ws, merges, r, origin + 1, r, origin + 1, day || '—', info.fill, info.color, info.bold, 'center', false, { border: true });
        const closedOut = !!(entry.outRow && typeof isDataLegClosed === 'function' && isDataLegClosed(entry.outRow));
        const closedIn = !!(entry.inRow && typeof isDataLegClosed === 'function' && isDataLegClosed(entry.inRow));
        const outVals = dataBoardExcelLegValues(entry.outRow, closedOut);
        const inVals = dataBoardExcelLegValues(entry.inRow, closedIn);
        outVals.forEach((val, i) => {
            dataBoardPaint(lib, ws, merges, r, outStart + i, r, outStart + i, val, outLook.fill, outLook.color, outLook.bold, 'center', false, {
                border: true,
                splitRight: i === legCount - 1
            });
        });
        inVals.forEach((val, i) => {
            dataBoardPaint(lib, ws, merges, r, inStart + i, r, inStart + i, val, inLook.fill, inLook.color, inLook.bold, 'center', false, {
                border: true,
                splitLeft: i === 0
            });
        });
        const avgText = state.bothClosed ? 'ЗАКРЫТ' : (state.avg >= 0 ? `${state.avg}%` : '—');
        dataBoardPaint(lib, ws, merges, r, avgCol, r, avgCol, avgText, avgLook.fill, avgLook.color, avgLook.bold, 'center', false, { border: true, splitLeft: true });
    });
    const blank = dataBoardExcelStyle('FFFFFF', 'FFFFFF', false, 'center', false, { quiet: true });
    for (let r = 4 + card.entries.length; r <= maxR; r++) {
        for (let c = origin; c < origin + cardWidth; c++) dataBoardPutCell(lib, ws, r, c, '', blank);
    }
}

function buildDataBoardWorksheet(lib, pairs, todayStart) {
    const spec = dataBoardExcelLegSpec();
    const legCount = spec.labels.length;
    const cardWidth = 2 + legCount * 2 + 1;
    const prepared = [];
    let maxEntries = 0;
    (pairs || []).forEach(pair => {
        const entries = typeof getDataPairEntries === 'function' ? (getDataPairEntries(pair, todayStart) || []) : [];
        if (!entries.length) return;
        prepared.push({ pair, entries });
        if (entries.length > maxEntries) maxEntries = entries.length;
    });
    const stamp = typeof excelExportStamp === 'function' ? excelExportStamp() : '';
    const ws = {};
    if (!prepared.length || !lib || !lib.utils) return { ws, stamp, cards: 0 };
    const merges = [];
    const origins = [];
    let cursor = 0;
    prepared.forEach((card, index) => {
        origins.push(cursor);
        cursor += cardWidth;
        if (index < prepared.length - 1) cursor += 1;
    });
    const lastCol = origins[origins.length - 1] + cardWidth - 1;
    const maxR = 3 + maxEntries;
    dataBoardPaint(lib, ws, merges, 0, 0, 0, lastCol, `Дата выгрузки: ${stamp}`, 'FFFFFF', '012A4A', true, 'left', false, { quiet: true });
    prepared.forEach((card, index) => {
        dataBoardPaintCard(lib, ws, merges, origins[index], card, spec, todayStart, maxR);
    });
    const gapStyle = dataBoardExcelStyle('FFFFFF', 'FFFFFF', false, 'center', false, { quiet: true });
    for (let i = 0; i < origins.length - 1; i++) {
        const gapCol = origins[i] + cardWidth;
        for (let r = 1; r <= maxR; r++) dataBoardPutCell(lib, ws, r, gapCol, '', gapStyle);
    }
    const cols = [];
    prepared.forEach((card, index) => {
        if (index) cols.push({ wch: dataBoardExcelKindWidth('gap') });
        cols.push({ wch: dataBoardExcelKindWidth('date') }, { wch: dataBoardExcelKindWidth('day') });
        spec.kinds.forEach(kind => cols.push({ wch: dataBoardExcelKindWidth(kind) }));
        spec.kinds.forEach(kind => cols.push({ wch: dataBoardExcelKindWidth(kind) }));
        cols.push({ wch: dataBoardExcelKindWidth('avg') });
    });
    const rowMeta = [{ hpt: 22 }, { hpt: 40 }, { hpt: 48 }, { hpt: 22 }];
    for (let r = 4; r <= maxR; r++) rowMeta[r] = { hpt: 18 };
    ws['!merges'] = merges;
    ws['!cols'] = cols;
    ws['!rows'] = rowMeta;
    ws['!ref'] = lib.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: lastCol } });
    ws['!views'] = [{
        state: 'frozen',
        xSplit: 0,
        ySplit: 4,
        topLeftCell: 'A5',
        activePane: 'bottomLeft'
    }];
    return { ws, stamp, cards: prepared.length };
}

function exportDataBoardToExcel() {
    if (typeof ProfileAuth !== 'undefined' && !ProfileAuth.guardPermission('export_excel', 'Экспорт недоступен для вашего профиля')) return;
    if (typeof ActivityLog !== 'undefined') ActivityLog.log('export', 'Данные');
    if (typeof groupedData === 'undefined' || !Object.keys(groupedData).length) {
        showToast('Нет данных для экспорта', 'error');
        return;
    }
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const pairs = typeof getDataRoutePairs === 'function' ? getDataRoutePairs(todayStart) : [];
    exportDataBoardWorkbook(pairs, todayStart).catch(e => {
        console.error(e);
        if (typeof showToast === 'function') showToast('Ошибка экспорта', 'error');
    });
}

async function exportDataBoardWorkbook(pairs, todayStart) {
    const folder = await excelPrepareFolder('data');
    if (!(await loadPlainXlsx())) {
        showToast('Библиотека Excel не загружена', 'error');
        return;
    }
    if (typeof showToast === 'function') showToast('Готовлю Excel…');
    const styled = await loadStyledXlsx();
    const lib = styled || XLSX;
    const built = buildDataBoardWorksheet(lib, pairs, todayStart);
    if (!built.cards) {
        if (typeof showToast === 'function') showToast('Нет данных для экспорта', 'error');
        return;
    }
    const wb = lib.utils.book_new();
    lib.utils.book_append_sheet(wb, built.ws, 'Маршруты');
    if (typeof excelSafeWorkbook === 'function') excelSafeWorkbook(wb);
    const fileDate = typeof getTodayDate === 'function' ? getTodayDate() : built.stamp;
    const saved = await excelSaveWorkbook(lib, wb, excelDailyFilename('КРАСАВИА_данные', fileDate), folder);
    excelAnnounceSaved(saved, `Файл готов, дата выгрузки ${built.stamp}`);
}

function exportRmsToExcel() {
    if (typeof ProfileAuth !== 'undefined' && !ProfileAuth.guardPermission('export_excel', 'Экспорт недоступен для вашего профиля')) return;
    if (typeof ActivityLog !== 'undefined') ActivityLog.log('export', 'RMS');
    const flights = getRmsFilteredFlights();

    if (!flights.length) {
        showToast('Нет данных для экспорта', 'error');
        return;
    }

    const hasExpected = Object.keys(expectedLoadData).length > 0;
    const salesReady = typeof hasSalesFileLoaded === 'function' ? hasSalesFileLoaded() : !!(typeof dataLoadStatus !== 'undefined' && dataLoadStatus.sales);
    const headers = ['Код рейса', 'Тип рейса', 'Направление', 'Дата вылета', 'Дней до вылета', 'ЗПК %', 'Загрузка', 'Остаток'];
    if (hasExpected) headers.push('Ожидаемая', 'Δ к ожидаемой');
    headers.push('Pickup 1–2д (файл 14д)', 'Сегодня (файл 14д)', 'Ср. тариф 14д', 'Уровень предупреждения', 'Причина');

    const rows = flights.map(f => {
        const row = [
            f.orig || f.base,
            typeof getFlightRouteTypeLabel === 'function' ? getFlightRouteTypeLabel(f.orig || f.base) : '',
            getFlightDirection(f.orig || f.base),
            f.date,
            f.dtd,
            f.pct,
            f.free,
            f.remainder != null ? f.remainder : ''
        ];
        if (hasExpected) {
            row.push(f.evR !== null ? f.evR : '');
            row.push(f.delta !== null ? f.delta : '');
        }
        row.push(
            salesReady && f.pickup !== null && f.pickup !== undefined ? f.pickup : '',
            salesReady ? (f.s.today || 0) : '',
            salesReady && f.avg ? f.avg : '',
            f.alertLevel,
            f.alertReason || ''
        );
        return row;
    });

    const fileDate = typeof getTodayDate === 'function' ? getTodayDate() : excelExportStamp();
    excelWriteBook('Сводка', [headers, ...rows], excelDailyFilename('КРАСАВИА_сводка', fileDate), { freezeCols: 1, kind: 'rms' }).catch(e => {
        console.error(e);
        showToast('Ошибка экспорта', 'error');
    });
}

function excelSafeWorkbook(wb) {
    (wb.SheetNames || []).forEach(name => {
        const sh = wb.Sheets[name];
        if (!sh) return;
        Object.keys(sh).forEach(addr => {
            if (addr.charAt(0) === '!') return;
            const cell = sh[addr];
            if (!cell || typeof cell.v !== 'string') return;
            if (/^[=+\-@\t\r]/.test(cell.v)) {
                cell.t = 's';
                cell.z = '@';
            }
        });
    });
    return wb;
}

async function exportTableToExcel(tableElement, filename = 'КРАСАВИА_экспорт.xlsx', kind) {
    if (typeof ProfileAuth !== 'undefined' && !ProfileAuth.guardPermission('export_excel', 'Экспорт недоступен для вашего профиля')) return;
    if (typeof ActivityLog !== 'undefined') ActivityLog.log('export', filename);
    if (!tableElement) {
        showToast('Нет данных для экспорта', 'error');
        return;
    }
    const folder = await excelPrepareFolder(kind || 'table');
    if (!(await loadPlainXlsx())) {
        showToast('Библиотека Excel не загружена', 'error');
        return;
    }
    try {
        if (typeof showToast === 'function') showToast('Готовлю Excel…');
        const parsed = readHtmlTableForExcel(tableElement);
        if (!parsed.rows.length) {
            showToast('Нет данных для экспорта', 'error');
            return;
        }
        const styled = await loadStyledXlsx();
        const lib = styled || XLSX;
        const stamp = excelExportStamp();
        const body = parsed.rows.map(row => row.map(value => {
            if (typeof value === 'number') return value;
            const text = String(value ?? '').trim();
            if (/^-?\d+(?:[.,]\d+)?$/.test(text) && text.length < 14) {
                const num = Number(text.replace(',', '.'));
                if (isFinite(num)) return num;
            }
            // «1 234» и «12 345 ₽» — тоже числа (иначе СУММ в Excel их пропускает).
            const m = /^(-?\d{1,3}(?:[\s\u00a0\u202f]\d{3})+(?:[.,]\d+)?|-?\d+(?:[.,]\d+)?)(?:[\s\u00a0\u202f]*₽)?$/.exec(text);
            if (m && /\d[\s\u00a0\u202f]\d|₽/.test(text)) {
                const num = Number(m[1].replace(/[\s\u00a0\u202f]/g, '').replace(',', '.'));
                if (isFinite(num) && Math.abs(num) < 1e13) return num;
            }
            return text;
        }));
        const aoa = [[`Дата выгрузки: ${stamp}`]].concat(body);
        const ws = lib.utils.aoa_to_sheet(aoa.map(excelSafeRow));
        const leftCols = new Set();
        const head = body[0] || [];
        for (let r = 0; r < parsed.headerRows; r++) {
            (body[r] || []).forEach((label, index) => {
                if (excelLeftHeader(label)) leftCols.add(index);
            });
        }
        if (styled) {
            excelDecorateSheet(lib, ws, {
                headerRows: parsed.headerRows,
                leftCols,
                tags: parsed.tags,
                merges: parsed.merges,
                freezeCols: 1
            });
        }
        const wb = excelSafeWorkbook(lib.utils.book_new());
        lib.utils.book_append_sheet(wb, ws, 'Данные');
        const saved = await excelSaveWorkbook(lib, wb, filename, folder);
        excelAnnounceSaved(saved, `Файл готов, дата выгрузки ${stamp}`);
    } catch (e) {
        console.error(e);
        showToast('Ошибка экспорта в Excel', 'error');
    }
}

function addExportButtonToTable(container, kind) {
    const oldBtn = container.querySelector('.export-excel-btn');
    if (oldBtn) oldBtn.remove();
    if (typeof ProfileAuth !== 'undefined' && !ProfileAuth.hasPermission('export_excel')) return;

    const btn = document.createElement('button');
    btn.className = 'export-excel-btn';
    btn.innerHTML = `📥 В Excel`;

    btn.onclick = () => {
        const handle = container._tvHandle;
        const live = container.querySelector('table.data-table');
        const table = (handle && typeof handle.getExportTable === 'function' && handle.getExportTable()) || live;
        if (table) {
            const wasExpanded = table.classList.contains('table-extra-expanded');
            const isPair = table.classList.contains('pair-table');
            if (isPair && !wasExpanded) table.classList.add('table-extra-expanded');
            const day = typeof getTodayDate === 'function' ? getTodayDate() : excelExportStamp();
            exportTableToExcel(table, excelDailyFilename(`КРАСАВИА_${currentFlight || 'рейсы'}`, day), kind || (isPair ? 'pair' : 'table'));
            if (isPair && !wasExpanded) table.classList.remove('table-extra-expanded');
        }
    };
    container.style.position = 'relative';
    container.appendChild(btn);
}
