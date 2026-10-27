// Ценовые решения из «Управления продажами» на графиках и отметка в один клик.
// • Маркеры ▲ повышение, ▼ снижение, ! внимание на графиках продаж рейса (плагин Chart.js).
// • Эффект решения: продажи за 3 дня до и 3 дня после (день отметки — в «после»),
//   с поправкой на норму по дню недели (sales-report.js). Пока окно «после» не закончилось
//   или норма не построена — честно пишем, что данных мало.
// • Быстрая отметка за сегодня (RMS, карточка рейса, детализация «Динамики»): те же права
//   и тот же файл, что в «Управлении продажами».
window.PriceMarks = (function () {
    // «3 дня», «5 дней» — окно решения из «Параметров расчётов».
    function winDays() { const n = PV.DECISION_WINDOW; const m10 = n % 10, m100 = n % 100; return n + ' ' + (m10 === 1 && m100 !== 11 ? 'день' : (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'дня' : 'дней')); }

    const GLYPH = { up: '▲', down: '▼', attn: '!' };
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

    // Решения по вылету (без «проверено без изменений»). Одно решение, отмеченное двумя людьми, — одна запись
    // (как в отчёте «Решения»): иначе в карточке оно шло бы дважды, а на графике рисовалось бы два маркера.
    function decisions(code, flyDate) {
        if (!available()) return [];
        const out = [];
        const seen = new Map();
        SalesManagement.marksFor(code, flyDate).filter(m => DECISIONS.has(m.status)).forEach(m => {
            const k = m.check + '|' + m.status;
            const prev = seen.get(k);
            if (!prev) {
                const item = Object.assign({}, m);
                seen.set(k, item);
                out.push(item);
                return;
            }
            if (m.author && !String(prev.author || '').split(' / ').includes(m.author)) prev.author = prev.author ? prev.author + ' / ' + m.author : m.author;
        });
        return out;
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
        // avg — средний оплаченный тариф (для показа); perTicket — выручка на один билет, включая билеты за 0 ₽:
        // по нему считается выручка «без решения», иначе нулевые билеты занижали бы итог решения на ровном месте.
        return { n, sum, avg: paid ? Math.round(sum / paid) : null, perTicket: n ? sum / n : null };
    }

    // Норма продаж за окно дней до вылета [dtdTo..dtdFrom] на кресла этого вылета.
    function normPickup(base, code, flyDate, dtdFrom, dtdTo) {
        if (typeof collectSameWeekdayCohort !== 'function' || typeof weekdayNormSeries !== 'function') return null;
        const row = typeof getFlightRowForDate === 'function' ? getFlightRowForDate(base, flyDate, code) : null;
        const seats = row && typeof getSeatsOnSale === 'function' ? getSeatsOnSale(row) : 0;
        // Оба дня окна — у одних и тех же вылетов: только те, у кого и конец окна уже наступил
        // (иначе разность двух средних по разным наборам вылетов врёт).
        const cohort = collectSameWeekdayCohort(base, flyDate, code)
            .filter(c => c.dayGap <= (typeof PV.WEEKDAY_NORM_WINDOW_DAYS === 'number' ? PV.WEEKDAY_NORM_WINDOW_DAYS : 56))
            .filter(c => !(c.observedFrom > Math.max(0, dtdTo)));
        const pts = weekdayNormSeries(cohort, [dtdFrom + 1, Math.max(0, dtdTo)], seats).points;
        if (!pts[0] || !pts[1] || pts[0].value == null || pts[1].value == null) return null;
        return { value: Math.max(0, pts[1].value - pts[0].value), n: Math.min(pts[0].n, pts[1].n) };
    }

    // Вылет уже выпал из файла продаж — число билетов по дням берём из архива кривых (без тарифов).
    function curveStats(curve, dtdFrom, dtdTo) {
        const val = (t) => (t > curve.maxDtd ? 0 : (curve.onHand[t] != null ? curve.onHand[t] : curve.total));
        return { n: Math.max(0, val(dtdTo) - val(dtdFrom + 1)), avg: null };
    }

    function effectFor(base, code, flyDate, mark) {
        const list = typeof getFlightSalesList === 'function' ? getFlightSalesList(flyDate, code) : [];
        const d = dayDiff(flyDate, mark.check);
        if (d == null) return null;
        const archived = !list.length && typeof SalesArchive !== 'undefined' ? SalesArchive.curveFor(flyDate, code) : null;
        const stats = (from, to) => (archived ? curveStats(archived, from, to) : windowStats(list, flyDate, from, to));
        const before = stats(d + PV.DECISION_WINDOW, d + 1);
        const afterTo = Math.max(0, d - (PV.DECISION_WINDOW - 1));
        const after = stats(d, afterTo);
        const cutoff = typeof salesDataCutoffTime === 'function' ? salesDataCutoffTime() : Date.now();
        const lastAfterDay = parseLocalDate(flyDate);
        if (lastAfterDay) lastAfterDay.setDate(lastAfterDay.getDate() - afterTo);
        // Последний день окна «после» должен быть целиком в данных: день среза может быть неполным.
        const complete = !!(lastAfterDay && lastAfterDay.getTime() < cutoff);
        const nb = normPickup(base, code, flyDate, d + PV.DECISION_WINDOW, d + 1);
        const na = normPickup(base, code, flyDate, d, afterTo);
        const effect = complete && nb && na ? (after.n - na.value) - (before.n - nb.value) : null;
        // Рубли по решениям не считаются: выручка за окно зависит от состава билетов (группы, дети, семейства тарифов)
        // сильнее, чем от самого решения. Решение судится по билетам против нормы.
        if (mark.status === 'up') return upEffect(base, code, flyDate, d, stats, before, nb);
        return { dtd: d, before, after, normBefore: nb, normAfter: na, complete, effect };
    }

    // Повышение судится по итогу вылета, а не по 3 дням: дороже продают медленнее — это нормально, места продаются
    // ближе к вылету. Плохо только если рейс в итоге недобрал. Сравнение — выручка с решения до вылета против того,
    // что было бы без повышения: обычный добор с этого дня (норма по дню недели, с поправкой на темп до решения),
    // по старому тарифу, не больше свободных на тот момент мест. Рейс заполнился (от 95%) — места не потеряны.
    function upEffect(base, code, flyDate, d, stats, before, nb) {
        const afterAll = stats(d, 0);
        const naAll = normPickup(base, code, flyDate, d, 0);
        const fly = parseLocalDate(flyDate);
        const cutoff = typeof salesDataCutoffTime === 'function' ? salesDataCutoffTime() : Date.now();
        const complete = !!(fly && fly.getTime() < cutoff);   // данные уже охватывают день вылета
        let seats = 0;
        let sold = 0;
        if (typeof getFlightRowForDate === 'function') {
            const row = getFlightRowForDate(base, flyDate, code);
            seats = row && typeof getSeatsOnSale === 'function' ? getSeatsOnSale(row) : 0;
            sold = row && typeof getSoldFromRow === 'function' ? getSoldFromRow(row) : 0;
        }
        // Вылет уже выпал из таблицы загрузки — кресла и итог из архива продаж.
        if (!(seats > 0) && typeof SalesArchive !== 'undefined' && SalesArchive.entryFor) {
            const ae = SalesArchive.entryFor(flyDate, code);
            if (ae && ae.s > 0) { seats = ae.s; sold = ae.sold || 0; }
        }
        // Кресел не знаем — не знаем, были ли свободные места: не судим (иначе «потеряли» билеты на полном рейсе).
        if (!(seats > 0)) return { dtd: d, before, after: afterAll, normBefore: nb, normAfter: naAll, complete, effect: null, finalLf: null, untilDeparture: true, expected: null };
        const finalLf = complete && seats > 0 ? sold / seats : null;
        const freeAtDecision = seats > 0 ? Math.max(0, seats - Math.max(0, sold - afterAll.n)) : null;
        let expected = naAll && nb ? Math.max(0, naAll.value + (before.n - nb.value) / 2) : null;
        if (expected != null && freeAtDecision != null) expected = Math.min(expected, freeAtDecision);
        if (expected != null && finalLf != null && finalLf >= 0.95) expected = afterAll.n;   // заполнился — мест не потеряли
        const effect = complete && expected != null ? Math.round((afterAll.n - expected) * 10) / 10 : null;
        return { dtd: d, before, after: afterAll, normBefore: nb, normAfter: naAll, complete, effect, finalLf, untilDeparture: true, expected };
    }

    // Итог решения — один для карточки рейса и для журнала решений.
    // worked: true / false, null — вывод делать рано (мало продаж) или не с чем сравнить.
    function judge(e, status) {
        if (!e || !e.complete) return e && e.untilDeparture
            ? { cls: 'wait', text: 'итог повышения — после вылета', short: 'ждём вылета', worked: null }
            : { cls: 'wait', text: `ещё идут ${winDays()}`, short: 'ждём', worked: null };
        if (e.effect == null) return { cls: 'none', text: 'не с чем сравнить', short: '—', worked: null };
        if (e.untilDeparture) {
            if (e.finalLf != null && e.finalLf >= 0.95) return { cls: 'pos', text: `рейс заполнился (${Math.round(e.finalLf * 100)}%)`, short: 'сработало', worked: true };
            const tol = Math.max(1, Math.round((e.expected || 0) * 0.1));
            if ((e.expected || 0) + e.after.n < 3) return { cls: 'none', text: 'мало продаж для вывода', short: 'рано судить', worked: null };
            return e.effect >= -tol
                ? { cls: 'pos', text: `по новой цене добрали как обычно (${e.after.n} при обычных ${fmtN(e.expected)})`, short: 'сработало', worked: true }
                : { cls: 'neg', text: `после повышения добрали меньше обычного: ${e.after.n} вместо ${fmtN(e.expected)}, загрузка ${e.finalLf != null ? Math.round(e.finalLf * 100) + '%' : '—'}`, short: 'не сработало', worked: false };
        }
        return e.effect > 0 ? { cls: 'pos', text: `продаётся лучше обычного ${signedN(e.effect)}`, short: 'сработало', worked: true }
            : { cls: 'neg', text: e.effect < 0 ? `хуже обычного ${signedN(e.effect)}` : 'без изменений', short: 'не сработало', worked: false };
    }

    // Дробные числа билетов — с запятой и без хвоста вида 0,30000000000000004.
    function fmtN(v) {
        return String(Math.round(Number(v) * 10) / 10).replace('.', ',');
    }

    function signedN(n) {
        return (n > 0 ? '+' : (n < 0 ? '−' : '')) + fmtN(Math.abs(n));
    }

    // «1 билет», «2 билета», «5 билетов»; у дробного числа — всегда «билета» («0,5 билета», «5,5 билета»).
    function ticketWord(n) {
        const v = Math.round(Number(n) * 10) / 10;
        return Number.isInteger(v) ? pluralRu(v, 'билет', 'билета', 'билетов') : 'билета';
    }

    function rub(v) {
        return v == null ? '—' : (typeof formatRub === 'function' ? formatRub(v) : Math.round(v) + ' ₽');
    }

    function statusLabel(status) {
        return typeof SalesManagement !== 'undefined' && SalesManagement.STATUSES[status] ? SalesManagement.STATUSES[status].label : status;
    }

    function tickets(n) {
        return `${fmtN(n)} ${ticketWord(n)}`;
    }

    // Понятное описание: сколько продали до и после решения, сколько обычно, и вывод.
    function effectLines(e, status) {
        if (!e) return [];
        const usual = (x) => (x ? ` (обычно ${fmtN(x.value)})` : '');
        const lines = e.untilDeparture
            ? [`До решения: ${tickets(e.before.n)} за ${winDays()}${usual(e.normBefore)} → после решения до вылета: ${tickets(e.after.n)}${e.normAfter ? ` (обычно добирают ${fmtN(e.normAfter.value)})` : ''}${e.complete ? '' : ' — вылет ещё впереди'}`]
            : [`До решения: ${tickets(e.before.n)} за ${winDays()}${usual(e.normBefore)} → после: ${tickets(e.after.n)}${usual(e.normAfter)}${e.complete ? '' : ' — дни ещё идут'}`];
        if (e.before.avg != null && e.after.avg != null && e.before.avg !== e.after.avg) {
            const d = e.after.avg - e.before.avg;
            lines.push(`Средний тариф: ${rub(e.before.avg)} → ${rub(e.after.avg)} (${d > 0 ? '+' : '−'}${rub(Math.abs(d))})`);
        }
        let verdict;
        if (!e.complete) verdict = e.untilDeparture ? 'Итог повышения будет после вылета: важно, заполнится ли рейс' : `Итог будет, когда пройдут ${winDays()} после решения`;
        else if (e.effect == null) verdict = 'Сравнить не с чем: мало прошлых вылетов в этот день недели';
        else {
            // Тот же вывод, что в отчёте «Решения» → «По билетам» (допуск 10% у повышения, «рано судить» при малых продажах).
            const j = judge(e, status);
            verdict = `${j.worked === true ? 'Помогло' : (j.worked === false ? 'Навредило' : 'Пока вывода нет')}: ${j.text}`;
        }
        lines.push(verdict);
        return lines;
    }

    // Блок «Ценовые решения» под графиками.
    function decisionsHtml(base, code, flyDate) {
        const list = decisions(code, flyDate);
        if (!list.length) return '';
        const esc = typeof escHtml === 'function' ? escHtml : String;
        const rows = list.map(m => {
            const e = m.status === 'attn' ? null : effectFor(base, code, flyDate, m);
            const jd = e && e.complete && e.effect != null ? judge(e, m.status) : null;
            const cls = jd ? (jd.worked === true ? 'pm-eff-up' : (jd.worked === false ? 'pm-eff-down' : '')) : '';
            const lines = effectLines(e, m.status);
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
        if (!ok) {
            if (typeof showToast === 'function') showToast('Отметку поставить не удалось: менять можно только сегодняшний столбец', 'error');
            return false;
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

    return { winDays, decisions, todayMark, effectFor, judge, decisionsHtml, chartItems, chipHtml, buttonsHtml, setToday, canMark, GLYPH };
})();
