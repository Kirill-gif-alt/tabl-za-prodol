// Ценовые решения из «Управления продажами» на графиках и отметка в один клик.
// • Маркеры ▲ повышение, ▼ снижение, ! внимание на графиках продаж рейса (плагин Chart.js).
// • Эффект решения: продажи за 3 дня до и 3 дня после (день отметки — в «после»),
//   с поправкой на норму по дню недели (sales-report.js). Пока окно «после» не закончилось
//   или норма не построена — честно пишем, что данных мало.
// • Быстрая отметка за сегодня (RMS, карточка рейса, детализация «Динамики»): те же права
//   и тот же файл, что в «Управлении продажами».
window.PriceMarks = (function () {
    const GLYPH = { up: '▲', down: '▼', attn: '!' };
    const WINDOW = 3;
    const DECISIONS = new Set(['up', 'down', 'attn']);

    function cssVar(name, fallback) {
        try {
            const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
            return v || fallback;
        } catch (e) {
            return fallback;
        }
    }

    function color(status) {
        if (status === 'up') return '#15803d';
        if (status === 'down') return cssVar('--sm-down', '#8e1b2f');
        return '#ea580c';
    }

    function available() {
        return typeof SalesManagement !== 'undefined' && typeof SalesManagement.marksFor === 'function';
    }

    // Решения по вылету (без «проверено без изменений»).
    function decisions(code, flyDate) {
        if (!available()) return [];
        return SalesManagement.marksFor(code, flyDate).filter(m => DECISIONS.has(m.status));
    }

    function todayMark(code, flyDate) {
        if (!available() || typeof getTodayDate !== 'function') return null;
        return SalesManagement.getMark(code, flyDate, getTodayDate());
    }

    function dayDiff(a, b) {
        const da = parseLocalDate(a);
        const db = parseLocalDate(b);
        return da && db ? Math.round((da.getTime() - db.getTime()) / 86400000) : null;
    }

    // ---------- эффект решения ----------

    function windowStats(list, flyDate, dtdFrom, dtdTo) {
        let n = 0;
        let sum = 0;
        let paid = 0;
        list.forEach(s => {
            const dtd = dayDiff(flyDate, s.dealDate);
            if (dtd == null || dtd < dtdTo || dtd > dtdFrom) return;
            n++;
            const v = s.adjustedFare || s.fare || 0;
            if (v > 0) { sum += v; paid++; }
        });
        return { n, avg: paid ? Math.round(sum / paid) : null };
    }

    // Норма продаж за окно дней до вылета [dtdTo..dtdFrom] на кресла этого вылета.
    function normPickup(base, code, flyDate, dtdFrom, dtdTo) {
        if (typeof collectSameWeekdayCohort !== 'function' || typeof weekdayNormSeries !== 'function') return null;
        const row = typeof getFlightRowForDate === 'function' ? getFlightRowForDate(base, flyDate, code) : null;
        const seats = row && typeof getSeatsOnSale === 'function' ? getSeatsOnSale(row) : 0;
        const cohort = collectSameWeekdayCohort(base, flyDate, code)
            .filter(c => c.dayGap <= (typeof WEEKDAY_NORM_WINDOW_DAYS === 'number' ? WEEKDAY_NORM_WINDOW_DAYS : 56));
        const pts = weekdayNormSeries(cohort, [dtdFrom + 1, Math.max(0, dtdTo)], seats).points;
        if (!pts[0] || !pts[1] || pts[0].value == null || pts[1].value == null) return null;
        return { value: Math.max(0, pts[1].value - pts[0].value), n: Math.min(pts[0].n, pts[1].n) };
    }

    function effectFor(base, code, flyDate, mark) {
        const list = typeof getFlightSalesList === 'function' ? getFlightSalesList(flyDate, code) : [];
        const d = dayDiff(flyDate, mark.check);
        if (d == null) return null;
        const before = windowStats(list, flyDate, d + WINDOW, d + 1);
        const afterTo = Math.max(0, d - (WINDOW - 1));
        const after = windowStats(list, flyDate, d, afterTo);
        const cutoff = typeof salesDataCutoffTime === 'function' ? salesDataCutoffTime() : Date.now();
        const lastAfterDay = parseLocalDate(flyDate);
        if (lastAfterDay) lastAfterDay.setDate(lastAfterDay.getDate() - afterTo);
        // Последний день окна «после» должен быть целиком в данных: день среза может быть неполным.
        const complete = !!(lastAfterDay && lastAfterDay.getTime() < cutoff);
        const nb = normPickup(base, code, flyDate, d + WINDOW, d + 1);
        const na = normPickup(base, code, flyDate, d, afterTo);
        const effect = complete && nb && na ? (after.n - na.value) - (before.n - nb.value) : null;
        return { dtd: d, before, after, normBefore: nb, normAfter: na, complete, effect };
    }

    function rub(v) {
        return v == null ? '—' : (typeof formatRub === 'function' ? formatRub(v) : Math.round(v) + ' ₽');
    }

    function statusLabel(status) {
        return typeof SalesManagement !== 'undefined' && SalesManagement.STATUSES[status] ? SalesManagement.STATUSES[status].label : status;
    }

    function plural(n, one, few, many) {
        const m10 = n % 10, m100 = n % 100;
        if (m10 === 1 && m100 !== 11) return one;
        if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
        return many;
    }

    function tickets(n) {
        return `${n} ${plural(n, 'билет', 'билета', 'билетов')}`;
    }

    // Понятное описание: сколько продали до и после решения, сколько обычно, и вывод.
    function effectLines(e) {
        if (!e) return [];
        const usual = (x) => (x ? ` (обычно ${x.value})` : '');
        const lines = [`До решения: ${tickets(e.before.n)} за ${WINDOW} дня${usual(e.normBefore)} → после: ${tickets(e.after.n)}${usual(e.normAfter)}${e.complete ? '' : ' — дни ещё идут'}`];
        if (e.before.avg != null && e.after.avg != null && e.before.avg !== e.after.avg) {
            const d = e.after.avg - e.before.avg;
            lines.push(`Средний тариф: ${rub(e.before.avg)} → ${rub(e.after.avg)} (${d > 0 ? '+' : '−'}${rub(Math.abs(d))})`);
        }
        let verdict;
        if (!e.complete) verdict = 'Итог будет, когда пройдут 3 дня после решения';
        else if (e.effect == null) verdict = 'Сравнить не с чем: мало прошлых вылетов в этот день недели';
        else if (e.effect > 0) verdict = `Итог: после решения продаётся лучше обычного — на ${tickets(e.effect)}`;
        else if (e.effect < 0) verdict = `Итог: после решения продаётся хуже обычного — на ${tickets(-e.effect)}`;
        else verdict = 'Итог: продаётся как обычно';
        lines.push(verdict);
        return lines;
    }

    function effectText(e) {
        return effectLines(e).join(' · ');
    }

    // Блок «Ценовые решения» под графиками.
    function decisionsHtml(base, code, flyDate) {
        const list = decisions(code, flyDate);
        if (!list.length) return '';
        const esc = typeof escHtml === 'function' ? escHtml : String;
        const rows = list.map(m => {
            const e = m.status === 'attn' ? null : effectFor(base, code, flyDate, m);
            const cls = e && e.complete && e.effect != null ? (e.effect > 0 ? 'pm-eff-up' : (e.effect < 0 ? 'pm-eff-down' : '')) : '';
            const lines = effectLines(e);
            return `<li class="pm-item">
                <div class="pm-item-head"><span class="pm-glyph pm-${m.status}">${GLYPH[m.status]}</span>
                <strong>${esc(statusLabel(m.status))}</strong> ${esc(m.check.slice(0, 5))}${m.author ? ' · ' + esc(m.author) : ''}</div>
                ${lines.length ? `<div class="pm-eff">${lines.slice(0, -1).map(l => `<div>${esc(l)}</div>`).join('')}<div class="pm-eff-verdict ${cls}">${esc(lines[lines.length - 1])}</div></div>` : ''}
            </li>`;
        }).join('');
        return `<div class="pm-block">
            <div class="pm-title">Ценовые решения по вылету</div>
            <ul class="pm-list">${rows}</ul>
        </div>`;
    }

    // Маркеры для графика: индекс точки по оси X.
    function chartItems(code, flyDate, indexOf) {
        return decisions(code, flyDate).map(m => {
            const index = indexOf(m);
            return index == null || index < 0 ? null : { index, status: m.status, title: `${GLYPH[m.status]} ${statusLabel(m.status)} ${m.check.slice(0, 5)}` };
        }).filter(Boolean);
    }

    const plugin = {
        id: 'priceMarks',
        afterDatasetsDraw(chart, args, opts) {
            const items = opts && opts.items;
            if (!items || !items.length) return;
            const x = chart.scales.x;
            const area = chart.chartArea;
            if (!x || !area) return;
            const ctx = chart.ctx;
            ctx.save();
            items.forEach(it => {
                const px = x.getPixelForValue(it.index);
                if (!isFinite(px) || px < area.left - 1 || px > area.right + 1) return;
                const c = color(it.status);
                ctx.strokeStyle = c;
                ctx.globalAlpha = 0.7;
                ctx.setLineDash([3, 3]);
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(px, area.top + 12);
                ctx.lineTo(px, area.bottom);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.globalAlpha = 1;
                ctx.fillStyle = c;
                ctx.font = 'bold 12px sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'top';
                ctx.fillText(GLYPH[it.status] || '•', px, area.top);
            });
            ctx.restore();
        }
    };
    if (typeof Chart !== 'undefined' && Chart.register) Chart.register(plugin);

    // ---------- отметка в один клик ----------

    function canMark() {
        return available() && SalesManagement.canEdit();
    }

    // Улетевший вылет не отмечаем — как и в таблице «Управления продажами».
    function flown(flyDate) {
        return available() && SalesManagement.isFlownDate && SalesManagement.isFlownDate(flyDate);
    }

    function setToday(code, flyDate, status) {
        if (!canMark()) {
            if (typeof showToast === 'function') showToast('Нет права ставить отметки «Управления продажами»', 'error');
            return false;
        }
        if (flown(flyDate)) {
            if (typeof showToast === 'function') showToast('Рейс уже улетел — отметка не нужна', 'error');
            return false;
        }
        const today = getTodayDate();
        const ok = status
            ? SalesManagement.putMark(code, flyDate, today, status, SalesManagement.profileName())
            : SalesManagement.clearMark(code, flyDate, today);
        if (ok && typeof ActivityLog !== 'undefined') {
            ActivityLog.log('sales_mark', `${code} ${flyDate}: ${status ? statusLabel(status) : 'снята'}`);
        }
        document.dispatchEvent(new CustomEvent('krasavia:mark', { detail: { code, date: flyDate, status } }));
        return ok;
    }

    // Чип сегодняшней отметки: кнопка для тех, кто может отмечать, иначе просто метка.
    function chipHtml(code, flyDate) {
        if (!available()) return '';
        const m = todayMark(code, flyDate);
        const esc = typeof escAttr === 'function' ? escAttr : String;
        const st = m && SalesManagement.STATUSES[m.status] ? m.status : '';
        const text = st ? (GLYPH[st] || '✓') : (canMark() ? '＋' : '');
        const title = st ? `Сегодня: ${statusLabel(st)}${m.author ? ' · ' + m.author : ''}` : 'Не проверен сегодня';
        if (!canMark() || flown(flyDate)) return st ? `<span class="pm-chip sm-st-${st}" title="${esc(title)}">${text}</span>` : '';
        return `<button type="button" class="pm-chip${st ? ' sm-st-' + st : ''}" data-pm-code="${esc(code)}" data-pm-date="${esc(flyDate)}" title="${esc(title + ' — нажмите, чтобы отметить (или клавиши 1–4 на строке)')}">${text}</button>`;
    }

    // Кнопки отметки (карточка рейса, детализация).
    const SHORT = { keep: 'Без изм.', attn: '! Вним.', down: '▼ Сниж.', up: '▲ Повыш.' };

    // Кнопки отметки за сегодня — компактно, в одну строку (карточка рейса, детализация, окно выбора).
    function buttonsHtml(code, flyDate) {
        if (!canMark() || flown(flyDate)) return '';
        const own = available() && SalesManagement.getOwnMark ? SalesManagement.getOwnMark(code, flyDate, getTodayDate()) : todayMark(code, flyDate);
        const esc = typeof escAttr === 'function' ? escAttr : String;
        const btn = (st, i) => `<button type="button" class="pm-btn sm-st-${st}${own && own.status === st ? ' pm-btn-on' : ''}" data-pm-set="${st}" data-pm-code="${esc(code)}" data-pm-date="${esc(flyDate)}" title="${esc(SalesManagement.STATUSES[st].label)} (клавиша ${i})">${SHORT[st]}</button>`;
        return `<div class="pm-buttons"><span class="pm-buttons-label">Сегодня:</span>${['keep', 'attn', 'down', 'up'].map((st, i) => btn(st, i + 1)).join('')}${own ? `<button type="button" class="pm-btn pm-btn-clear" data-pm-set="" data-pm-code="${esc(code)}" data-pm-date="${esc(flyDate)}" title="Снять свою отметку">✕</button>` : ''}</div>`;
    }

    const KEY_STATUS = { '1': 'keep', '2': 'attn', '3': 'down', '4': 'up' };

    function closePicker() {
        const pop = document.getElementById('pm-pop');
        if (pop) pop.hidden = true;
    }

    function openPicker(anchor) {
        const code = anchor.dataset.pmCode;
        const date = anchor.dataset.pmDate;
        let pop = document.getElementById('pm-pop');
        if (!pop) {
            pop = document.createElement('div');
            pop.id = 'pm-pop';
            pop.className = 'pm-pop';
            document.body.appendChild(pop);
            pop.addEventListener('click', (e) => {
                const b = e.target.closest('[data-pm-set]');
                if (!b) return;
                setToday(b.dataset.pmCode, b.dataset.pmDate, b.dataset.pmSet || null);
                closePicker();
            });
            document.addEventListener('pointerdown', (e) => {
                if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('.pm-chip')) closePicker();
            }, true);
            document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePicker(); });
        }
        pop.innerHTML = `<div class="pm-pop-title">${typeof escHtml === 'function' ? escHtml(code + ' · ' + date) : code}</div>${buttonsHtml(code, date)}`;
        pop.hidden = false;
        const r = anchor.getBoundingClientRect();
        const w = 300;
        pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
        let top = r.bottom + 6;
        const h = pop.offsetHeight || 90;
        if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
        pop.style.top = top + 'px';
    }

    // Делегирование: чипы и кнопки отметки в любом месте страницы.
    document.addEventListener('click', (e) => {
        const set = e.target.closest('[data-pm-set]');
        if (set && !set.closest('#pm-pop')) {
            e.preventDefault();
            e.stopPropagation();
            setToday(set.dataset.pmCode, set.dataset.pmDate, set.dataset.pmSet || null);
            return;
        }
        const chip = e.target.closest('button.pm-chip[data-pm-code]');
        if (chip) {
            e.preventDefault();
            e.stopPropagation();
            openPicker(chip);
        }
    }, true);

    // Клавиши 1–4 на строке с чипом (RMS): отметка без мыши.
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.altKey || e.metaKey) return;
        const st = KEY_STATUS[e.key];
        if (!st) return;
        const t = e.target;
        if (!t || !t.closest || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
        const host = t.closest('[data-pm-row]');
        const chip = host && host.querySelector('button.pm-chip[data-pm-code]');
        if (!chip) return;
        e.preventDefault();
        setToday(chip.dataset.pmCode, chip.dataset.pmDate, st);
    });

    return { decisions, todayMark, effectFor, effectText, decisionsHtml, chartItems, chipHtml, buttonsHtml, setToday, canMark, GLYPH };
})();
