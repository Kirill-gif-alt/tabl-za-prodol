// Оконный tbody: идея Clusterize.js (MIT), без зависимости.
// thead не режем. Excel берёт полный набор строк через getExportTable(), не DOM.

const TableVirtual = (function () {
    const DEFAULT_ROW_H = 44;
    const BUFFER = 12;
    const VIRTUAL_MIN = 80;

    function bind(opts) {
        const scrollEl = opts.scrollEl;
        const tbody = opts.tbody;
        const rows = opts.rows || [];
        const rowH = opts.rowHeight || DEFAULT_ROW_H;
        const onPaint = typeof opts.onPaint === 'function' ? opts.onPaint : null;
        if (!scrollEl || !tbody) {
            return { destroy() {}, refresh() {}, scrollToIndex() {}, getExportTable() { return null; } };
        }

        let destroyed = false;
        let start = -1;
        let end = -1;
        let raf = 0;

        function visibleCount() {
            const h = scrollEl.clientHeight || 480;
            return Math.max(16, Math.ceil(h / rowH) + BUFFER * 2);
        }

        function paint() {
            if (destroyed) return;
            const n = rows.length;
            if (!n) {
                tbody.innerHTML = '';
                start = 0;
                end = 0;
                return;
            }
            const top = scrollEl.scrollTop || 0;
            const vis = visibleCount();
            const nextStart = Math.max(0, Math.min(n, Math.floor(top / rowH) - BUFFER));
            const nextEnd = Math.min(n, nextStart + vis);
            if (nextStart === start && nextEnd === end && tbody.childElementCount) return;
            start = nextStart;
            end = nextEnd;
            const padTop = start * rowH;
            const padBot = Math.max(0, (n - end) * rowH);
            tbody.innerHTML = `<tr class="tv-pad" aria-hidden="true"><td colspan="32" style="height:${padTop}px;padding:0;border:0"></td></tr>`
                + rows.slice(start, end).join('')
                + `<tr class="tv-pad" aria-hidden="true"><td colspan="32" style="height:${padBot}px;padding:0;border:0"></td></tr>`;
            if (onPaint) onPaint();
        }

        function onScroll() {
            if (raf) return;
            raf = requestAnimationFrame(() => {
                raf = 0;
                paint();
            });
        }

        function scrollToIndex(i) {
            if (destroyed || i == null || i < 0) return;
            const n = rows.length;
            if (!n) return;
            const idx = Math.min(n - 1, i);
            const view = scrollEl.clientHeight || 480;
            scrollEl.scrollTop = Math.max(0, idx * rowH - view / 2 + rowH);
            start = -1;
            end = -1;
            paint();
        }

        scrollEl.addEventListener('scroll', onScroll, { passive: true });
        paint();

        return {
            refresh: paint,
            scrollToIndex,
            getExportTable() { return null; },
            destroy() {
                destroyed = true;
                scrollEl.removeEventListener('scroll', onScroll);
                if (raf) cancelAnimationFrame(raf);
            }
        };
    }

    function destroyHandle(container) {
        if (!container) return;
        if (container._tvHandle && typeof container._tvHandle.destroy === 'function') {
            container._tvHandle.destroy();
        }
        container._tvHandle = null;
        container._tvRows = null;
    }

    function makeExportTable(table, rows) {
        if (!table) return null;
        const clone = table.cloneNode(true);
        const tb = clone.querySelector('tbody');
        if (tb) tb.innerHTML = (rows || []).join('');
        return clone;
    }

    function mount(opts) {
        const container = opts.container;
        const openTable = opts.openTable || '';
        const rows = opts.rows || [];
        const rowHeight = opts.rowHeight || DEFAULT_ROW_H;
        const onPaint = opts.onPaint;
        const threshold = opts.threshold == null ? VIRTUAL_MIN : opts.threshold;
        const scrollIndex = opts.scrollIndex;
        if (!container) return { destroy() {}, refresh() {}, scrollToIndex() {}, getExportTable() { return null; } };

        if (container._tvHandle && container._tvRows === rows && container.querySelector('tbody')) {
            if (typeof scrollIndex === 'number' && scrollIndex >= 0) {
                container._tvHandle.scrollToIndex(scrollIndex);
            }
            return container._tvHandle;
        }

        destroyHandle(container);
        container.innerHTML = openTable + '</tbody></table>';
        const table = container.querySelector('table');
        const tbody = container.querySelector('tbody');
        container._tvRows = rows;

        const exportFn = () => makeExportTable(table, rows);

        if (rows.length > threshold && tbody) {
            const handle = bind({
                scrollEl: container,
                tbody,
                rows,
                rowHeight,
                onPaint
            });
            handle.getExportTable = exportFn;
            container._tvHandle = handle;
            if (typeof scrollIndex === 'number' && scrollIndex >= 0) {
                requestAnimationFrame(() => handle.scrollToIndex(scrollIndex));
            }
            return handle;
        }

        if (tbody) tbody.innerHTML = rows.join('');
        if (onPaint) onPaint();
        const handle = {
            destroy() {},
            refresh() {},
            getExportTable: () => table,
            scrollToIndex(i) {
                if (i == null || i < 0 || !tbody) return;
                const tr = tbody.children[i];
                if (tr) tr.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        };
        container._tvHandle = handle;
        if (typeof scrollIndex === 'number' && scrollIndex >= 0) {
            setTimeout(() => handle.scrollToIndex(scrollIndex), 150);
        }
        return handle;
    }

    return { bind, mount, destroyHandle };
})();
