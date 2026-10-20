// Диаграммы для «Отчёты» → «Решения»: полоса долей, горизонтальные столбики, колонки по неделям. Чистый HTML/CSS, без библиотек.
window.DecisionsViz = (function () {
    function esc(v) {
        return typeof escHtml === 'function' ? escHtml(v) : String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // Полоса долей: items = [{ label, value, cls }], cls — dv-pos / dv-neg / dv-unk / dv-na / dv-wait.
    function stack(title, items) {
        const total = items.reduce((a, i) => a + i.value, 0);
        if (!total) return '';
        const segs = items.filter(i => i.value > 0).map(i =>
            `<span class="dv-seg ${i.cls}" style="flex:${i.value}" title="${esc(i.label)}: ${i.value}">${i.value / total >= 0.07 ? i.value : ''}</span>`).join('');
        const legend = items.filter(i => i.value > 0).map(i =>
            `<span class="dv-leg"><i class="dv-dot ${i.cls}"></i>${esc(i.label)} <b>${i.value}</b></span>`).join('');
        return `<div class="dv-card"><div class="dv-title">${esc(title)}</div><div class="dv-stack">${segs}</div><div class="dv-legend">${legend}</div></div>`;
    }

    // Столбики вокруг нуля: items = [{ label, value, text, sub }]; положительные зелёные, отрицательные красные.
    function bars(title, items, note) {
        if (!items.length) return '';
        const max = Math.max(...items.map(i => Math.abs(i.value)), 1);
        const rows = items.map(i => {
            const w = Math.round(Math.abs(i.value) / max * 100);
            const pos = i.value >= 0;
            return `<div class="dv-row"><div class="dv-lab" title="${esc(i.label)}">${esc(i.label)}${i.sub ? `<span>${esc(i.sub)}</span>` : ''}</div>
                <div class="dv-track"><div class="dv-fill ${pos ? 'dv-pos' : 'dv-neg'}" style="width:${Math.max(w, i.value ? 2 : 0)}%"></div></div>
                <div class="dv-val ${pos ? 'dr-pos' : 'dr-neg'}">${esc(i.text)}</div></div>`;
        }).join('');
        return `<div class="dv-card"><div class="dv-title">${esc(title)}</div>${rows}${note ? `<div class="dv-note">${esc(note)}</div>` : ''}</div>`;
    }

    // Колонки по периодам: items = [{ label, value, text }], положительные вверх, отрицательные вниз.
    function columns(title, items, note) {
        if (items.length < 2) return '';
        const max = Math.max(...items.map(i => Math.abs(i.value)), 1);
        const cols = items.map(i => {
            const h = Math.round(Math.abs(i.value) / max * 100);
            const pos = i.value >= 0;
            return `<div class="dv-col" title="${esc(i.label)}: ${esc(i.text)}"><div class="dv-up">${pos ? `<div class="dv-bar dv-pos" style="height:${h}%"></div>` : ''}</div><div class="dv-down">${pos ? '' : `<div class="dv-bar dv-neg" style="height:${h}%"></div>`}</div><div class="dv-xl">${esc(i.label)}</div></div>`;
        }).join('');
        return `<div class="dv-card"><div class="dv-title">${esc(title)}</div><div class="dv-cols">${cols}</div>${note ? `<div class="dv-note">${esc(note)}</div>` : ''}</div>`;
    }

    return { stack, bars, columns };
})();
