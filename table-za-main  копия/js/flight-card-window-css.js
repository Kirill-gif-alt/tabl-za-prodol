// Стили карточки рейса для отдельного окна (FlightCard, режим «в отдельном окне»).
// Окно открывается пустым (about:blank), и подключить в него styles.css напрямую нельзя: на file:// Chrome этого не даёт.
// Поэтому правила карточки (.flight-card, .fc-*, .pm-*, .mode-*, .sm-st-*, .vd-*, .booking-curve-verdict*, .filter-btn — вместе
// с тёмной темой и @media) лежат здесь:
//  • FLIGHT_CARD_WINDOW_CSS — встроенная копия из styles.css и css/*.css. Нужна для file:// и для первого показа окна.
//  • FLIGHT_CARD_WINDOW_CSS_BUILD(тексты таблиц) — строит такой же набор правил из текста styles.css. На http(s) окно сразу
//    после открытия подменяет копию свежим набором, так что новые правила карточки попадают в окно без правки этого файла.
// Копию обновляют тем же кодом (выбор правил по префиксам классов); без обновления копия работает на file:// по состоянию на её дату.
window.FLIGHT_CARD_WINDOW_CSS = [
    "* { box-sizing: border-box; }",
    "body.fc-window-body { margin: 0; font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; color: var(--text, #012a4a); background: var(--surface, #fff); }",
    ".fc-flash { position: fixed; left: 12px; right: 12px; bottom: 12px; z-index: 20; padding: 10px 14px; border-radius: 10px; background: #1e293b; color: #fff; font-size: 0.82rem; font-weight: 600; box-shadow: 0 8px 24px rgb(15 23 42 / 0.28); }",
    ".fc-flash[hidden] { display: none; }",
    ":root { --primary: #012A4A; --primary-light: #023a5e; --nav-bg: #012A4A; --accent: #10b981; --accent-hover: #059669; --surface: #ffffff; --bg: #f0f4f8; --border: #e2e8f0; --text: #012A4A; --text-muted: #64748b; --data-leg-out: #eff6ff; --data-leg-in: #ecfdf5; --data-flew-bg: #e8ecf1; --main-chip-open-bg: #012A4A; --main-chip-open-text: #ffffff; --main-chip-open-border: #023a5e; --main-chip-low-bg: #fff7ed; --main-chip-low-text: #9a3412; --main-chip-low-border: #fdba74; --main-chip-full-bg: #ecfdf5; --main-chip-full-text: #047857; --main-chip-full-border: #6ee7b7; --main-chip-closed-bg: #fef2f2; --main-chip-closed-text: #991b1b; --main-chip-closed-border: #fca5a5; --main-chip-flew-bg: #f1f5f9; --main-chip-flew-text: #475569; --main-chip-flew-border: #cbd5e1; --table-head-bg: #012A4A; --table-row-even: #dbeafe; --table-row-odd: #ffffff; --pair-out-head: #1e40af; --pair-in-head: #047857; --pair-leg-out-bg: #eff6ff; --pair-leg-in-bg: #ecfdf5; --data-card-head-bg: #f8fafc; --rms-head-bg: #012A4A; --rms-row-even: #f1f5f9; --muted-bg: #f8fafc; --hover-bg: #f1f5f9; --shadow-sm: 0 1px 3px rgb(1 42 74 / 0.06); --shadow-md: 0 8px 24px -4px rgb(1 42 74 / 0.12); --radius: 16px; --radius-lg: 20px; }",
    ".filter-btn { border: 1px solid transparent; background: transparent; color: #475569; font-size: 0.74rem; font-weight: 600; padding: 6px 12px; border-radius: 9px; cursor: pointer; transition: background 0.12s, color 0.12s, border-color 0.12s, box-shadow 0.12s; white-space: nowrap; }",
    ".filter-btn:hover { background: var(--surface); color: var(--primary); border-color: #e2e8f0; }",
    ".booking-curve-verdict { font-size: 0.82rem; font-weight: 600; padding: 8px 12px; border-radius: 10px; margin: 0 0 12px; line-height: 1.35; }",
    ".booking-curve-verdict-up { background: #ecfdf5; color: #047857; }",
    ".booking-curve-verdict-down { background: #fef2f2; color: #991b1b; }",
    ".booking-curve-verdict-neutral { background: var(--muted-bg, var(--bg)); color: var(--text); }",
    "html[data-theme=\"dark\"] { color-scheme: dark; }",
    ".sm-st-keep { background: var(--sm-keep, #f7dc6f) !important; color: var(--sm-keep-text, #3d3206); }",
    ".sm-st-attn { background: var(--sm-attn, #f5b7b1) !important; color: var(--sm-attn-text, #7b241c); }",
    ".sm-st-down { background: var(--sm-down, #8e1b2f) !important; color: var(--sm-down-text, #fff); }",
    ".sm-st-up { background: var(--sm-up, #7dcea0) !important; color: var(--sm-up-text, #145a32); }",
    ".mode-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 15px; height: 15px; padding: 0 3px; margin-left: 4px; border-radius: 4px; font-size: 0.6rem; font-weight: 800; line-height: 1; vertical-align: middle; cursor: help; }",
    ".mode-sub { color: #0f766e; border: 1px solid rgb(13 148 136 / 0.45); background: rgb(13 148 136 / 0.08); }",
    ".mode-com { color: #fff; background: #d97706; border: 1px solid #d97706; }",
    ".pm-buttons { display: flex; flex-wrap: nowrap; align-items: center; gap: 4px; margin: 6px 0; }",
    ".pm-buttons-label { font-size: 0.78rem; color: var(--text-muted, #64748b); margin-right: 2px; }",
    ".pm-btn { padding: 3px 8px; border-radius: 7px; border: 1px solid transparent; font-size: 0.74rem; white-space: nowrap; font-weight: 700; cursor: pointer; opacity: 0.85; }",
    ".pm-btn:hover { opacity: 1; }",
    ".pm-btn-on { opacity: 1; box-shadow: 0 0 0 2px var(--primary, #1d4ed8); }",
    ".pm-btn-clear { background: transparent; border-color: var(--border, #cbd5e1); color: var(--text-muted, #64748b); }",
    ".pm-block { margin: 12px 0; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--border, #e2e8f0); background: var(--surface, #fff); }",
    ".pm-title { font-weight: 700; font-size: 0.85rem; margin-bottom: 6px; }",
    ".pm-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }",
    ".pm-item { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: baseline; font-size: 0.8rem; }",
    ".pm-glyph { font-weight: 800; width: 14px; text-align: center; }",
    ".pm-glyph.pm-up { color: #15803d; }",
    ".pm-glyph.pm-down { color: var(--sm-down, #8e1b2f); }",
    ".pm-glyph.pm-attn { color: #ea580c; }",
    ".pm-eff { color: var(--text-muted, #64748b); }",
    ".pm-eff-up { color: #15803d; }",
    ".pm-eff-down { color: #b91c1c; }",
    ".pm-hint { margin-top: 6px; font-size: 0.7rem; color: var(--text-muted, #64748b); }",
    ".flight-card { position: fixed; top: 0; right: 0; bottom: 0; z-index: 14000; width: 460px; max-width: 100vw; overflow-y: auto; padding: 14px 16px 20px; box-sizing: border-box; background: var(--surface, #fff); color: var(--text, #0f172a); border-left: 1px solid var(--border, #e2e8f0); box-shadow: -12px 0 32px rgb(15 23 42 / 0.16); animation: fc-in 0.16s ease-out; }",
    ".flight-card[hidden] { display: none; }",
    "@keyframes fc-in { from { transform: translateX(24px); opacity: 0; } to { transform: none; opacity: 1; } }",
    ".fc-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; margin-bottom: 10px; }",
    ".fc-title { font-size: 1.15rem; font-weight: 800; color: var(--primary, #012a4a); }",
    ".fc-dir { font-size: 0.85rem; font-weight: 600; color: var(--text-muted, #64748b); }",
    ".fc-sub { font-size: 0.8rem; color: var(--text-muted, #64748b); margin-top: 2px; }",
    ".fc-nav { display: flex; gap: 4px; flex-shrink: 0; }",
    ".fc-nav-btn, .fc-close { border: 1px solid var(--border, #e2e8f0); background: var(--surface, #fff); color: inherit; border-radius: 8px; padding: 4px 8px; font-size: 0.8rem; font-weight: 700; cursor: pointer; }",
    ".fc-nav-btn:disabled { opacity: 0.35; cursor: default; }",
    ".fc-issues { margin-bottom: 8px; padding: 6px 8px; border-radius: 8px; background: #fef2f2; color: #991b1b; font-size: 0.78rem; }",
    ".fc-tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; margin-bottom: 8px; }",
    ".fc-tile { padding: 7px 8px; border-radius: 10px; background: var(--muted-bg, #f1f5f9); }",
    ".fc-tile-label { font-size: 0.66rem; color: var(--text-muted, #64748b); text-transform: uppercase; letter-spacing: 0.03em; }",
    ".fc-tile-value { font-size: 1.05rem; font-weight: 800; }",
    ".fc-tile-sub { font-size: 0.7rem; color: var(--text-muted, #64748b); }",
    ".fc-neg { color: #b91c1c; }",
    ".fc-pos { color: #15803d; }",
    ".fc-verdict { font-size: 0.8rem; font-weight: 600; margin: 4px 0; }",
    ".fc-chart-wrap { position: relative; height: 300px; }",
    ".fc-chart-note { font-size: 0.68rem; color: var(--text-muted, #64748b); margin: 4px 0 6px; }",
    ".fc-comment { font-size: 0.8rem; padding: 8px; border-radius: 8px; background: #fffbeb; margin: 8px 0; }",
    ".fc-links { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 0.78rem; color: var(--text-muted, #64748b); margin-top: 10px; }",
    ".fc-empty { color: var(--text-muted, #64748b); }",
    "@media (max-width: 560px) { .flight-card { width: 100vw; padding: 12px; } .fc-tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); } }",
    ".flight-card.flight-card-is-pinned { animation: none; box-shadow: -4px 0 16px rgb(15 23 42 / 0.08); }",
    ".fc-nav-btn.fc-on { background: var(--primary, #012a4a); color: #fff; border-color: var(--primary, #012a4a); }",
    ".fc-alt { font-size: 0.7rem; font-weight: 600; color: #92400e; background: #fef3c7; border-radius: 6px; padding: 1px 6px; vertical-align: middle; }",
    ".fc-nav { flex-wrap: wrap; justify-content: flex-end; }",
    "body.fc-window-body { margin: 0; background: var(--surface, #fff); }",
    "body.fc-window-body .flight-card { position: static; width: auto; max-width: none; min-height: 100vh; box-shadow: none; border: none; animation: none; }",
    ".pm-buttons-label { white-space: nowrap; }",
    ".pm-item { display: block; }",
    ".pm-item-head { display: flex; gap: 6px; align-items: baseline; }",
    ".pm-eff { margin: 2px 0 0 20px; font-size: 0.78rem; line-height: 1.45; color: var(--text-muted, #64748b); }",
    ".pm-eff-verdict { font-weight: 700; color: var(--text, #334155); }",
    ".pm-eff-verdict.pm-eff-up { color: #15803d; }",
    ".pm-eff-verdict.pm-eff-down { color: #b91c1c; }",
    ".booking-curve-verdict .vd-head { margin-bottom: 2px; }",
    ".booking-curve-verdict .vd-head strong { font-size: 1.05em; }",
    ".booking-curve-verdict .vd-muted { font-weight: 500; opacity: 0.75; }",
    ".booking-curve-verdict .vd-line { font-weight: 500; color: var(--text, #334155); }",
    ".booking-curve-verdict .vd-up { color: #15803d; font-weight: 700; }",
    ".booking-curve-verdict .vd-down { color: #b91c1c; font-weight: 700; }",
    ".fc-insights { margin: 8px 0 6px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); font-size: 0.8rem; line-height: 1.35; overflow: hidden; }",
    ".fc-ins-head { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; width: 100%; padding: 7px 10px; border: 0; background: transparent; color: var(--text); font: inherit; text-align: left; cursor: pointer; }",
    ".fc-ins-head:hover { background: var(--hover-bg, rgba(0, 0, 0, 0.04)); }",
    ".fc-ins-caret { width: 10px; color: var(--text-muted); }",
    ".fc-ins-title { font-weight: 700; margin-right: 4px; }",
    ".fc-ins-chips { display: inline-flex; flex-wrap: wrap; gap: 4px; }",
    ".fc-ins-chip { padding: 1px 8px; border-radius: 999px; font-size: 0.72rem; font-weight: 600; background: var(--muted-bg, #f1f5f9); color: var(--text); white-space: nowrap; }",
    ".fc-ins-up { background: rgba(4, 120, 87, 0.12); color: #047857; }",
    ".fc-ins-down { background: rgba(185, 28, 28, 0.1); color: #b91c1c; }",
    ".fc-ins-group { background: rgba(29, 78, 216, 0.1); color: #1d4ed8; }",
    ".fc-ins-body { padding: 0 10px 10px; display: flex; flex-direction: column; gap: 8px; }",
    ".fc-it-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 6px; }",
    ".fc-it { padding: 7px 9px; border-radius: 8px; border: 1px solid var(--border); border-left-width: 3px; background: var(--bg); }",
    ".fc-it-up { border-left-color: #059669; }",
    ".fc-it-down { border-left-color: #dc2626; }",
    ".fc-it-plain { border-left-color: var(--accent, #2563eb); }",
    ".fc-it-label { font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-muted); }",
    ".fc-it-value { font-size: 1.2rem; font-weight: 700; margin: 2px 0 1px; color: var(--text); white-space: nowrap; }",
    ".fc-it-up .fc-it-value { color: #047857; }",
    ".fc-it-down .fc-it-value { color: #b91c1c; }",
    ".fc-it-of { font-size: 0.78rem; font-weight: 600; color: var(--text-muted); }",
    ".fc-it-sub { font-size: 0.75rem; color: var(--text); }",
    ".fc-it-note { font-size: 0.7rem; color: var(--text-muted); margin-top: 2px; }",
    ".fc-advice { padding: 6px 9px; border-radius: 8px; font-weight: 600; }",
    ".fc-advice-up { background: rgba(4, 120, 87, 0.1); color: #047857; }",
    ".fc-advice-down { background: rgba(185, 28, 28, 0.08); color: #b91c1c; }",
    ".fc-advice-hold { background: var(--muted-bg, #f1f5f9); color: var(--text); font-weight: 500; }",
    ".fc-advice + .fc-advice { margin-top: 6px; }",
    ".fc-groups { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; padding: 6px 9px; border-radius: 8px; background: rgba(29, 78, 216, 0.07); }",
    ".fc-groups-title { font-weight: 700; color: #1d4ed8; }",
    ".fc-grp-item { padding: 0 7px; border-radius: 999px; background: var(--surface); border: 1px solid rgba(29, 78, 216, 0.25); font-size: 0.72rem; }",
    ".fc-groups .fc-it-note { width: 100%; }",
    "html[data-theme=\"dark\"] .fc-ins-up, html[data-theme=\"dark\"] .fc-advice-up, html[data-theme=\"dark\"] .fc-it-up .fc-it-value { color: #34d399; }",
    "html[data-theme=\"dark\"] .fc-ins-down, html[data-theme=\"dark\"] .fc-advice-down, html[data-theme=\"dark\"] .fc-it-down .fc-it-value { color: #f87171; }",
    "html[data-theme=\"dark\"] .fc-ins-group, html[data-theme=\"dark\"] .fc-groups-title { color: #93c5fd; }",
    ".fc-cal { color: #b45309; font-weight: 600; }",
    ".fc-tile-of { font-size: 0.78rem; font-weight: 600; color: var(--text-muted); }",
    ".fc-tile-load .fc-tile-value { font-size: 1.25rem; }",
    ".fc-tile-pct { font-weight: 700; color: var(--text); }",
    "html[data-theme=\"dark\"] .booking-curve-verdict-up { background: #0f2e22; color: #86efac; }",
    "html[data-theme=\"dark\"] .booking-curve-verdict-down { background: #3b1717; color: #fca5a5; }",
    "html[data-theme=\"dark\"] .booking-curve-verdict .vd-line { color: inherit; }",
    "html[data-theme=\"dark\"] .filter-btn { color: var(--text-muted); }",
    ".fc-it-muted { border-left-color: var(--border); }",
    ".fc-it-muted .fc-it-note { margin-top: 0; }",
    ".fc-ins-muted { color: var(--text-muted); }",
    ".fc-ins-ml { background: rgba(14, 116, 144, 0.12); color: #0e7490; }",
    "html[data-theme=\"dark\"] .fc-ins-ml { color: #67e8f9; background: rgba(103, 232, 249, 0.12); }",
    ".fc-ml-link { padding: 0; border: 0; background: none; color: var(--accent, #2563eb); font: inherit; font-size: 0.7rem; text-decoration: underline; cursor: pointer; }"
].join('\n');

window.FLIGHT_CARD_WINDOW_CSS_BUILD = (function () {
    function buildCardCss(sheetTexts) {
        // Классы карточки: по префиксам. Лишнее (шапка, чипы таблиц, окно сравнения моделей) — в SKIP.
        const PREFIX = /^(fc-|pm-|mode-|sm-st-|vd-|booking-curve-verdict|flight-card|filter-btn$)/;
        const SKIP = /^(flight-card-toggle|flight-card-pinned|flight-card-open|fc-row-problem|fc-flag|pm-chip|pm-pop|mlw)/;
    
        // Разбор таблицы стилей на правила; вложенность только через @media.
        function parse(source) {
            const out = [];
            function block(text, wrap) {
                let pos = 0;
                while (pos < text.length) {
                    while (pos < text.length && /\s/.test(text[pos])) pos++;
                    if (pos >= text.length) return;
                    let j = pos, q = null, paren = 0;
                    for (; j < text.length; j++) {
                        const ch = text[j];
                        if (q) { if (ch === q && text[j - 1] !== '\\') q = null; }
                        else if (ch === '"' || ch === "'") q = ch;
                        else if (ch === '(') paren++;
                        else if (ch === ')') paren--;
                        else if ((ch === '{' || ch === ';') && paren <= 0) break;
                    }
                    const head = text.slice(pos, j).trim();
                    if (text[j] === ';') { pos = j + 1; continue; }
                    let depth = 0, k = j;
                    q = null;
                    for (; k < text.length; k++) {
                        const ch = text[k];
                        if (q) { if (ch === q && text[k - 1] !== '\\') q = null; continue; }
                        if (ch === '"' || ch === "'") { q = ch; continue; }
                        if (ch === '{') depth++;
                        else if (ch === '}') { depth--; if (depth === 0) break; }
                    }
                    const body = text.slice(j + 1, k);
                    if (head.startsWith('@media')) block(body, (wrap ? wrap + ' and ' : '') + head.slice(6).trim());
                    else if (head.startsWith('@keyframes')) out.push({ wrap, kind: 'keyframes', name: head.split(/\s+/)[1], text: head + ' { ' + body.replace(/\s+/g, ' ').trim() + ' }' });
                    else if (!head.startsWith('@')) out.push({ wrap, kind: 'rule', sel: head, body: body.replace(/\s+/g, ' ').trim() });
                    pos = k + 1;
                }
            }
            block(source.replace(/\/\*[\s\S]*?\*\//g, ''), '');
            return out;
        }
    
        function splitTop(sel) {
            const parts = [];
            let depth = 0, cur = '';
            for (const ch of sel) {
                if (ch === '(' || ch === '[') depth++;
                else if (ch === ')' || ch === ']') depth--;
                if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; } else cur += ch;
            }
            if (cur.trim()) parts.push(cur.trim());
            return parts;
        }
        const classesOf = (part) => (part.replace(/\[[^\]]*\]/g, '').replace(/"[^"]*"/g, '').match(/\.(-?[_a-zA-Z][\w-]*)/g) || []).map(x => x.slice(1));
    
        const all = [];
        sheetTexts.forEach(t => parse(String(t || '')).forEach(r => all.push(r)));
        const known = new Set(['no-cmix']);
        all.forEach(r => {
            if (r.kind !== 'rule') return;
            splitTop(r.sel).forEach(p => classesOf(p).forEach(c => { if (PREFIX.test(c) && !SKIP.test(c)) known.add(c); }));
        });
        function keepPart(part) {
            if ((part.match(/#[\w-]+/g) || []).some(i => i !== '#flight-card')) return false;
            const cls = classesOf(part);
            if (!cls.length) return /^(:root|html\[data-theme="(dark|light)"\])$/.test(part);
            return cls.every(c => known.has(c) && !SKIP.test(c)) && cls.some(c => c !== 'no-cmix');
        }
    
        // Окно: базовые правила и сообщение внизу окна (flash).
        const lines = [
            "* { box-sizing: border-box; }",
            "body.fc-window-body { margin: 0; font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; color: var(--text, #012a4a); background: var(--surface, #fff); }",
            ".fc-flash { position: fixed; left: 12px; right: 12px; bottom: 12px; z-index: 20; padding: 10px 14px; border-radius: 10px; background: #1e293b; color: #fff; font-size: 0.82rem; font-weight: 600; box-shadow: 0 8px 24px rgb(15 23 42 / 0.28); }",
            ".fc-flash[hidden] { display: none; }"
        ];
        let curWrap = null, buf = [];
        const flush = () => {
            if (!buf.length) return;
            if (curWrap) lines.push('@media ' + curWrap + ' { ' + buf.join(' ') + ' }'); else buf.forEach(x => lines.push(x));
            buf = [];
        };
        all.forEach(r => {
            let t = null;
            if (r.kind === 'rule') {
                const parts = splitTop(r.sel).filter(keepPart);
                if (parts.length) t = parts.join(', ') + ' { ' + r.body + ' }';
            } else if (/^fc-/.test(r.name)) t = r.text;
            if (!t) return;
            if (r.wrap !== curWrap) { flush(); curWrap = r.wrap; }
            buf.push(t);
        });
        flush();
        return lines;
    }
    return function (sheetTexts) { return buildCardCss(sheetTexts).join('\n'); };
})();
