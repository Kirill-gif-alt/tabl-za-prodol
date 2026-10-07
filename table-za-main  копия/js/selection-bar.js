// js\selection-bar.js - extracted from script.js, logic unchanged.
// Globals on purpose: no bundler; onclick and other files call by name.

/**
 * Выделение в таблицах как в Excel:
 * — клик по заголовку столбца → весь столбец
 * — клик по первой ячейке строки (дата) → вся строка
 * — протягивание вниз → диапазон в одном столбце
 * — протягивание вправо/влево → диапазон в одной строке
 * — Ctrl+клик → добавить/убрать столбец, строку или ячейку
 * Снизу: кол-во / сумма / среднее по выделенным числам.
 */
let _clearActiveTableSelection = null;
function clearActiveTableSelection() {
    if (typeof _clearActiveTableSelection === 'function') _clearActiveTableSelection();
}

function initSelectionStatusBar() {
    const TABLE_SEL = 'table.data-table, table.pair-table, table.rms-table, table.data-board-table';
    let bar = document.getElementById('selection-status-bar');
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'selection-status-bar';
        bar.className = 'selection-status-bar';
        bar.setAttribute('aria-live', 'polite');
        bar.innerHTML = `
            <span class="sel-stat"><span class="sel-stat-label">Кол-во</span><span class="sel-stat-val" data-sel="count">0</span></span>
            <span class="sel-stat"><span class="sel-stat-label">Сумма</span><span class="sel-stat-val" data-sel="sum">0</span></span>
            <span class="sel-stat"><span class="sel-stat-label">Среднее</span><span class="sel-stat-val" data-sel="avg">0</span></span>
`;
        document.body.appendChild(bar);
    }

    /** @type {WeakMap<HTMLTableElement, Set<string>>} */
    const selectedByTable = new WeakMap();
    let drag = null; // { table, mode: 'col'|'row'|'cell', r0, c0, additive }
    let activeTable = null;
    let didDragSelect = false;

    const parseNumsFromText = (text) => {
        if (!text) return [];
        const cleaned = String(text)
            .replace(/[\u00a0\u202f]/g, ' ')
            .replace(/[₽%]/g, ' ')
            .replace(/\bкг\b/gi, ' ')
            .replace(/ЗАКРЫТ|УЛЕТЕЛ/gi, ' ');
        const re = /-?\d{1,3}(?:[ \u00a0]\d{3})+(?:[.,]\d+)?|-?\d+(?:[.,]\d+)?/g;
        const out = [];
        let m;
        while ((m = re.exec(cleaned)) !== null) {
            const n = parseFloat(m[0].replace(/[ \u00a0]/g, '').replace(',', '.'));
            if (!isNaN(n) && isFinite(n)) out.push(n);
        }
        return out;
    };

    const bodyRows = (table) => Array.from(table.tBodies?.[0]?.rows || []);

    const cellKey = (r, c) => `${r}:${c}`;

    const getSet = (table) => {
        let s = selectedByTable.get(table);
        if (!s) {
            s = new Set();
            selectedByTable.set(table, s);
        }
        return s;
    };

    const clearTable = (table) => {
        if (!table) return;
        getSet(table).clear();
        table.querySelectorAll('.tbl-sel').forEach((el) => {
            el.classList.remove('tbl-sel', 'tbl-sel-col', 'tbl-sel-row', 'tbl-sel-cell');
        });
    };

    const clearAllExcept = (keep) => {
        document.querySelectorAll(TABLE_SEL).forEach((t) => {
            if (t !== keep) clearTable(t);
        });
    };

    const paint = (table) => {
        if (!table) return;
        table.querySelectorAll('.tbl-sel').forEach((el) => {
            el.classList.remove('tbl-sel', 'tbl-sel-col', 'tbl-sel-row', 'tbl-sel-cell');
        });
        const set = getSet(table);
        const rows = bodyRows(table);
        set.forEach((key) => {
            const [rs, cs] = key.split(':');
            const r = parseInt(rs, 10);
            const c = parseInt(cs, 10);
            const tr = rows[r];
            if (!tr) return;
            const td = tr.cells[c];
            if (td) td.classList.add('tbl-sel', 'tbl-sel-cell');
        });
        // подсветка заголовков столбцов, где выделены все числовые ячейки — все строки
        const colCounts = {};
        set.forEach((key) => {
            const c = parseInt(key.split(':')[1], 10);
            colCounts[c] = (colCounts[c] || 0) + 1;
        });
        const nRows = rows.length;
        Object.keys(colCounts).forEach((c) => {
            if (colCounts[c] >= nRows && nRows > 0) {
                table.querySelectorAll(`thead th`).forEach((th) => {
                    if (th.cellIndex === parseInt(c, 10)) th.classList.add('tbl-sel', 'tbl-sel-col');
                });
            }
        });
        updateBar(table);
    };

    const fmt = (n) => {
        const r = Math.round(n * 100) / 100;
        const s = Number.isInteger(r) ? String(r) : r.toFixed(2);
        return s.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
    };

    const isDetailPanelOpen = () => {
        // только если панель реально есть в DOM и открыта (нет is-hidden)
        if (document.body.classList.contains('pkz-detail-open')) {
            const anyOpen = ['pkz-detail-panel', 'table-sales-panel', 'pair-sales-panel'].some((id) => {
                const el = document.getElementById(id);
                return el && !el.classList.contains('is-hidden');
            });
            // класс мог «залипнуть» — сбрасываем, если все панели закрыты
            if (!anyOpen) {
                document.body.classList.remove('pkz-detail-open');
                return false;
            }
            return true;
        }
        return ['pkz-detail-panel', 'table-sales-panel', 'pair-sales-panel'].some((id) => {
            const el = document.getElementById(id);
            return el && !el.classList.contains('is-hidden');
        });
    };

    const updateBar = (table) => {
        // скрывать плашку только при открытой детализации (не если панели ещё нет в DOM)
        if (isDetailPanelOpen()) {
            bar.classList.remove('is-visible');
            return;
        }
        if (!table) {
            bar.classList.remove('is-visible');
            return;
        }
        const set = getSet(table);
        if (!set.size) {
            bar.classList.remove('is-visible');
            return;
        }
        const rows = bodyRows(table);
        const nums = [];
        set.forEach((key) => {
            const [rs, cs] = key.split(':');
            const td = rows[parseInt(rs, 10)]?.cells[parseInt(cs, 10)];
            if (!td) return;
            const found = parseNumsFromText(td.textContent || '');
            // одна ячейка — одно значение (первое число), чтобы % и «+3» не давали мусор
            if (found.length === 1) nums.push(found[0]);
            else if (found.length > 1) {
                // «+3» / «100%» — берём первое «значимое» (часто единственное)
                nums.push(found[0]);
            }
        });
        if (nums.length < 1) {
            bar.classList.remove('is-visible');
            return;
        }
        const count = nums.length;
        const sum = nums.reduce((a, b) => a + b, 0);
        bar.querySelector('[data-sel="count"]').textContent = fmt(count);
        bar.querySelector('[data-sel="sum"]').textContent = fmt(sum);
        bar.querySelector('[data-sel="avg"]').textContent = fmt(sum / count);
        bar.classList.add('is-visible');
    };

    const selectColumn = (table, colIndex, additive) => {
        if (!additive) {
            clearAllExcept(table);
            clearTable(table);
        }
        const set = getSet(table);
        bodyRows(table).forEach((tr, r) => {
            if (tr.cells[colIndex]) set.add(cellKey(r, colIndex));
        });
        activeTable = table;
        paint(table);
    };

    const selectRow = (table, rowIndex, additive) => {
        if (!additive) {
            clearAllExcept(table);
            clearTable(table);
        }
        const set = getSet(table);
        const tr = bodyRows(table)[rowIndex];
        if (!tr) return;
        for (let c = 0; c < tr.cells.length; c++) set.add(cellKey(rowIndex, c));
        activeTable = table;
        paint(table);
    };

    const selectCell = (table, r, c, additive) => {
        if (!additive) {
            clearAllExcept(table);
            clearTable(table);
        }
        const set = getSet(table);
        const key = cellKey(r, c);
        if (additive && set.has(key)) set.delete(key);
        else set.add(key);
        activeTable = table;
        paint(table);
    };

    const selectColRange = (table, c, r0, r1, additive) => {
        if (!additive) {
            clearAllExcept(table);
            clearTable(table);
        }
        const set = getSet(table);
        const lo = Math.min(r0, r1);
        const hi = Math.max(r0, r1);
        for (let r = lo; r <= hi; r++) {
            if (bodyRows(table)[r]?.cells[c]) set.add(cellKey(r, c));
        }
        activeTable = table;
        paint(table);
    };

    const selectRowRange = (table, r, c0, c1, additive) => {
        if (!additive) {
            clearAllExcept(table);
            clearTable(table);
        }
        const set = getSet(table);
        const lo = Math.min(c0, c1);
        const hi = Math.max(c0, c1);
        const tr = bodyRows(table)[r];
        if (!tr) return;
        for (let c = lo; c <= hi; c++) {
            if (tr.cells[c]) set.add(cellKey(r, c));
        }
        activeTable = table;
        paint(table);
    };

    const resolveBodyCell = (el) => {
        const td = el?.closest?.('td');
        if (!td) return null;
        const tr = td.parentElement;
        const table = tr?.closest?.(TABLE_SEL);
        if (!table || !tr || tr.parentElement?.tagName !== 'TBODY') return null;
        const rows = bodyRows(table);
        const r = rows.indexOf(tr);
        if (r < 0) return null;
        return { table, r, c: td.cellIndex, td };
    };

    const resolveHeaderCell = (el) => {
        const th = el?.closest?.('th');
        if (!th) return null;
        const table = th.closest(TABLE_SEL);
        if (!table || !th.closest('thead')) return null;
        // для многорядных шапок: берём cellIndex; если colspan — выделяем все покрытые столбцы
        const start = th.cellIndex;
        const span = th.colSpan || 1;
        return { table, start, span, th };
    };

    const isRowSelectorCell = (td, table) => {
        if (!td) return false;
        // первая колонка (дата) — селектор строки; также col-date
        if (td.classList.contains('col-date')) return true;
        return td.cellIndex === 0;
    };

    document.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        const interactive = e.target.closest('button, a, input, select, textarea, label, .export-excel-btn');
        if (interactive) return;

        const head = resolveHeaderCell(e.target);
        if (head) {
            e.preventDefault();
            window.getSelection()?.removeAllRanges();
            const additive = e.ctrlKey || e.metaKey;
            for (let i = 0; i < head.span; i++) {
                selectColumn(head.table, head.start + i, additive || i > 0);
            }
            didDragSelect = false;
            drag = null;
            return;
        }

        const cell = resolveBodyCell(e.target);
        if (!cell) {
            // клик вне таблицы — сброс
            if (!e.target.closest(TABLE_SEL) && !e.target.closest('.selection-status-bar')) {
                if (activeTable) {
                    clearTable(activeTable);
                    updateBar(null);
                    activeTable = null;
                }
            }
            return;
        }

        e.preventDefault();
        window.getSelection()?.removeAllRanges();
        const additive = e.ctrlKey || e.metaKey;
        didDragSelect = false;

        if (isRowSelectorCell(cell.td, cell.table) && !e.shiftKey) {
            selectRow(cell.table, cell.r, additive);
            drag = { table: cell.table, mode: 'rowPick', r0: cell.r, c0: cell.c, additive };
            return;
        }

        drag = {
            table: cell.table,
            mode: 'pending',
            r0: cell.r,
            c0: cell.c,
            additive,
            dominant: null
        };
        selectCell(cell.table, cell.r, cell.c, additive);
    }, true);

    _clearActiveTableSelection = () => {
        if (!activeTable) return;
        clearTable(activeTable);
        updateBar(null);
        activeTable = null;
    };

    document.addEventListener('mousemove', (e) => {
        if (!drag || drag.mode === 'rowPick') return;
        const cell = resolveBodyCell(e.target);
        if (!cell || cell.table !== drag.table) return;

        const dr = Math.abs(cell.r - drag.r0);
        const dc = Math.abs(cell.c - drag.c0);
        if (dr === 0 && dc === 0) return;

        // фиксируем режим по первому существенному движению: столбец или строка
        if (!drag.dominant) {
            if (dr >= dc) drag.dominant = 'col';
            else drag.dominant = 'row';
        }

        didDragSelect = true;
        if (drag.dominant === 'col') {
            drag.mode = 'col';
            selectColRange(drag.table, drag.c0, drag.r0, cell.r, drag.additive);
        } else {
            drag.mode = 'row';
            selectRowRange(drag.table, drag.r0, drag.c0, cell.c, drag.additive);
        }
    }, { capture: true, passive: true });

    document.addEventListener('mouseup', () => {
        drag = null;
    }, true);

    // dblclick не блокируем — детализация продаж/КЗ открывается по двойному клику

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && activeTable) {
            clearTable(activeTable);
            updateBar(null);
            activeTable = null;
        }
    });
}
