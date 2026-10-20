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

    // Компактная строка решения; по двойному клику раскрываются подробности. tone: pos / neg / unk / wait / na.
    const TONE = { pos: 'ЛУЧШЕ', neg: 'ХУЖЕ', unk: 'НЕ ПОНЯТНО', wait: 'ЖДЁМ', ser: 'В СЕРИИ', na: 'НЕ СЧИТАЕМ' };
    const TONE_ORDER = ['pos', 'neg', 'unk', 'wait', 'ser', 'na'];
    const TONE_FILTER = { pos: 'Помогли', neg: 'Навредили', unk: 'Не понятно', wait: 'Ждём', ser: 'В серии', na: 'Не считаем' };

    function plainRow(c) {
        const html = `<div class="dp-row dp-${c.tone}" title="Двойной клик — подробности">
            <div class="dp-main">
                <span class="dp-badge">${TONE[c.tone]}</span>
                <div class="dp-who">${c.head}</div>
                <div class="dp-dep">вылет ${c.dep}</div>
                <div class="dp-act">${c.act}</div>
                <div class="dp-big">${c.big}</div>
                <div class="dp-short">${c.short || ''}</div>
                <button type="button" class="dp-chev" aria-label="Подробности" aria-expanded="false">▾</button>
            </div>
            <div class="dp-lines">${c.say ? `<div class="dp-say">${c.say}</div>` : ''}${c.range || ''}<ul>${c.lines.filter(Boolean).map(l => `<li>${l}</li>`).join('')}</ul>${c.tags ? `<div class="dp-tags">${c.tags.filter(Boolean).map(t => `<span>${t}</span>`).join('')}</div>` : ''}</div>
        </div>`;
        return { tone: c.tone, html };
    }

    // Верхняя полоса показателей: items = [{ label, value, cls }].
    function strip(items) {
        return `<div class="dp-strip">${items.map(i => `<div><small>${esc(i.label)}</small><span class="${i.cls || ''}">${i.value}</span></div>`).join('')}</div>`;
    }

    // Полоска с нулём: lo / mid / hi в рублях, fmt — форматтер.
    function rangeBar(lo, mid, hi, fmt) {
        const mn = Math.min(lo, 0), mx = Math.max(hi, 0);
        const span = (mx - mn) || 1;
        const pct = (v) => 6 + (v - mn) / span * 88;
        const tone = lo > 0 ? 'dp-rpos' : (hi < 0 ? 'dp-rneg' : 'dp-runk');
        const a = pct(lo), b = pct(hi), z = pct(0), m = pct(mid);
        return `<div class="dp-rng"><div class="dp-axis"></div><span class="dp-zl" style="left:${z}%">0</span><div class="dp-zero" style="left:${z}%"></div>
            <div class="dp-rseg ${tone}" style="left:${a}%;width:${Math.max(b - a, 1)}%"></div><div class="dp-mid" style="left:${m}%"></div>
            <span class="dp-lb" style="left:${a}%">${esc(fmt(lo))}</span><span class="dp-lb dp-lbm" style="left:${m}%"><b>${esc(fmt(mid))}</b></span><span class="dp-lb" style="left:${b}%">${esc(fmt(hi))}</span></div>`;
    }

    function toneBar(rows, cur, attr) {
        const cnt = {};
        rows.forEach(r => { cnt[r.tone] = (cnt[r.tone] || 0) + 1; });
        const b = (t, label, n) => `<button type="button" class="dp-f${String(cur) === String(t) ? ' on' : ''}${t && t !== '' ? ' dp-f-' + t : ''}" data-${attr}="${t}">${label} <b>${n}</b></button>`;
        return `<div class="dp-filters">${b('', 'Все', rows.length)}${TONE_ORDER.filter(t => cnt[t]).map(t => b(t, TONE_FILTER[t], cnt[t])).join('')}
            <span class="dp-hint">Двойной клик по строке — подробности</span>
            <button type="button" class="dp-all" data-dp-all="1">Раскрыть все</button></div>`;
    }

    function list(rows, cur) {
        const sel = cur ? rows.filter(r => r.tone === cur) : rows;
        return `<div class="dp-list">${sel.map(r => r.html).join('') || '<p class="rp-note">Нет решений с такой меткой.</p>'}</div>`;
    }

    function howToRead(extra) {
        return `<div class="dp-read">
            <span class="dp-chip dp-pos">ЛУЧШЕ</span> решение помогло
            <span class="dp-chip dp-neg">ХУЖЕ</span> навредило
            <span class="dp-chip dp-unk">НЕ ПОНЯТНО</span> разница может быть случайной
            <span class="dp-chip dp-na">НЕ СЧИТАЕМ</span> сравнивать не с чем
            ${extra || ''}</div>`;
    }

    function toggle(row, force) {
        const open = force == null ? !row.classList.contains('open') : force;
        row.classList.toggle('open', open);
        const c = row.querySelector('.dp-chev');
        if (c) c.setAttribute('aria-expanded', String(open));
    }

    // Один обработчик на страницу: двойной клик по строке и клик по стрелке.
    document.addEventListener('dblclick', (e) => {
        const row = e.target.closest && e.target.closest('.dp-row');
        if (!row || e.target.closest('button, a, input, select')) return;
        const sel = window.getSelection && window.getSelection();
        if (sel && sel.removeAllRanges) sel.removeAllRanges();
        toggle(row);
    });
    document.addEventListener('click', (e) => {
        const chev = e.target.closest && e.target.closest('.dp-chev');
        if (chev) { toggle(chev.closest('.dp-row')); return; }
        const all = e.target.closest && e.target.closest('[data-dp-all]');
        if (all) {
            const rows = [...document.querySelectorAll('.dp-row')];
            const open = rows.some(r => !r.classList.contains('open'));
            rows.forEach(r => toggle(r, open));
            all.textContent = open ? 'Свернуть все' : 'Раскрыть все';
        }
    });

    return { stack, bars, columns, strip, rangeBar, plainRow, toneBar, list, howToRead };
})();
