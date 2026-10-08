// js\timeline-view.js - extracted from script.js, logic unchanged.
// Globals on purpose: no bundler; onclick and other files call by name.

const TIMELINE_SCROLL_OFFSET = 400;
const TIMELINE_AC_ORDER = ['ATR-42', 'ATR-72', 'Ан-24', 'Ан-26', 'Як-42'];
const TIMELINE_CFG_KEY = 'krasavia_timeline_cfg';
const TIMELINE_AC_SLUG = {
    'ATR-42': 'atr42',
    'ATR-72': 'atr72',
    'Ан-24': 'an24',
    'Ан-26': 'an26',
    'Як-42': 'yak42'
};

function getTimelineAcSlug(ac) {
    return TIMELINE_AC_SLUG[ac] || 'other';
}


let timelineRenderCache = { sig: '', html: '' };

let timelineInitialScrollDone = false;
const TIMELINE_HEADER_H = 58;
const TIMELINE_HEADER_H_EXPANDED = 82;
const TIMELINE_CHIP_H = 50;
const TIMELINE_GANTT_CHIP_H = 44;
const TIMELINE_CHIP_GAP = 4;
const TIMELINE_CELL_PAD = 0;
const TIMELINE_DAY_MIN = 24 * 60;
const TIMELINE_SLOT_H = 12;
const TIMELINE_COMPACT_COL_PX = 118;
const TIMELINE_MIN_BLOCK_MIN = 20;
const TIMELINE_HUB_UTC = 7;
/** Смещение от UTC. Прилёт в файле часто местный у пункта назначения. Ось графика — Красноярск (UTC+7). */
const TIMELINE_AIRPORT_UTC = {
    KJA: 7, ABA: 7, KYZ: 7, KEJ: 7, NOZ: 7, RGK: 7, TOF: 7,
    NSK: 7, IAA: 7, HTG: 7, DKS: 7, THX: 7, MJY: 7, KCY: 7,
    BXY: 7, TTK: 7, SBT: 7, HTA: 8, UUD: 8, ULN: 8, NZG: 8, IKT: 8,
    ULK: 9, TLK: 9, BQS: 9, NNY: 9, CZR: 9, PYR: 9,
    NJC: 5, HMA: 5, SGC: 5
};

const timelineExpandedDates = new Set();
let timelineAnchorDate = null;

function invalidateTimelineCache() {
    timelineRenderCache = { sig: '', html: '' };
    timelineInitialScrollDone = false;
    const content = document.getElementById('timeline-content');
    if (content) delete content.dataset.renderSig;
}

function getTimelineCacheSignature() {
    const cfg = loadTimelineCfg();
    const expanded = [...timelineExpandedDates].sort().join(',');
    const nf = window.networkMapFilter;
    const filt = nf ? `${nf.city || ''}|${(nf.flights || []).join(',')}` : '';
    return `${getMetricsCacheSignature()}|${(cfg.globalOrder || []).join('\x1f')}|grid2|e:${expanded}|w:${cfg.slotPx || 80}|f:${filt}`;
}

function timelineRowHeight(chipCount) {
    if (!chipCount) return 36;
    return TIMELINE_CELL_PAD + chipCount * TIMELINE_CHIP_H + (chipCount - 1) * TIMELINE_CHIP_GAP;
}

function createMainTimelineView(c){
    c.innerHTML = `
        <div class="main-timeline-page">
            <div class="timeline-section">
                <div class="timeline-section-head">
                    <div class="timeline-section-head-left">
                        <h2 class="timeline-title">Графический план полетов</h2>
                        <div class="timeline-legend">
                            <span class="timeline-legend-item timeline-legend-open">открыт</span>
                            <span class="timeline-legend-item timeline-legend-low">&lt;40%</span>
                            <span class="timeline-legend-item timeline-legend-full">≥95%</span>
                            <span class="timeline-legend-item timeline-legend-closed">закрыт</span>
                            <span class="timeline-legend-item timeline-legend-flew">улетел</span>
                            <span class="timeline-legend-hint">двойной клик по дате — сетка 2 ч</span>
                        </div>
                    </div>
                    <div id="timeline-map-filter-banner" class="nmap-work-banner" hidden></div>
                    <div class="timeline-section-head-actions">
                        <label class="timeline-slot-label">2 ч
                            <select id="timeline-slot-px" class="timeline-slot-select" onchange="onTimelineSlotPxChange(this)" title="Ширина слота 2 часа">
                                <option value="64">узко</option>
                                <option value="80" selected>средне</option>
                                <option value="96">широко</option>
                                <option value="112">ещё шире</option>
                            </select>
                        </label>
                        <button type="button" class="btn-secondary timeline-collapse-all-btn" id="timeline-collapse-all-btn" onclick="collapseAllTimelineDates()" disabled>Свернуть все</button>
                        <button type="button" class="btn-secondary timeline-order-btn" onclick="openTimelineAcSettingsModal()">Порядок ВС</button>
                        <button type="button" class="btn-secondary timeline-today-btn" onclick="scrollTimelineToToday()">К сегодня</button>
                    </div>
                </div>
                <div class="view-zoom-host">
                    <div id="timeline-container" class="timeline-container card" data-zoom-target="main">
                        <div id="timeline-content" class="timeline-content"></div>
                    </div>
                </div>
            </div>
        </div>
    `;
    applyViewZoom('main');
    timelineInitialScrollDone = false;
    const slotSel = document.getElementById('timeline-slot-px');
    if (slotSel) slotSel.value = String(getTimelineSlotPx());
    if (typeof renderTimeline === 'function') renderTimeline();
    if (typeof initTimelineDrag === 'function') initTimelineDrag();
}

let timelineSuppressClick = false;

function selectFlightFromTimeline(flight, date) {
    if (timelineSuppressClick) return;
    // Графплан: не переключаем вкладку, только запоминаем рейс
    const base = getBaseFlight(flight);
    if (!isValidFlightBase(base)) return;
    currentFlight = base;
    lastSelectedDate = date || null;
    if (typeof SessionStore !== 'undefined') SessionStore.saveUiSession();
    markTimelineSelectedChip();
}

function markTimelineSelectedChip() {
    const content = document.getElementById('timeline-content');
    if (!content) return;
    content.querySelectorAll('.timeline-chip-selected').forEach(el => el.classList.remove('timeline-chip-selected'));
    const cur = typeof currentFlight !== 'undefined' ? currentFlight : '';
    if (!cur) return;
    content.querySelectorAll('.timeline-chip[data-flight]').forEach(el => {
        const fl = el.dataset.flight;
        if (typeof getBaseFlight === 'function' && getBaseFlight(fl) === cur) {
            el.classList.add('timeline-chip-selected');
        }
    });
}

function initTimelineDrag() {
    const container = document.getElementById('timeline-container');
    if (!container || container.dataset.dragInit) return;
    container.dataset.dragInit = '1';

    const DRAG_THRESHOLD = 8;
    let isDown = false;
    let didDrag = false;
    let startX = 0;
    let startY = 0;
    let scrollLeft = 0;
    let scrollTop = 0;

    const onMouseDown = (e) => {
        if (e.button !== 0) return;
        isDown = true;
        didDrag = false;
        timelineSuppressClick = false;
        startX = e.pageX;
        startY = e.pageY;
        scrollLeft = container.scrollLeft;
        scrollTop = container.scrollTop;
    };

    const onMouseMove = (e) => {
        if (!isDown) return;
        const dx = e.pageX - startX;
        const dy = e.pageY - startY;
        if (!didDrag && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
            didDrag = true;
            container.classList.add('timeline-dragging');
        }
        if (!didDrag) return;
        e.preventDefault();
        container.scrollLeft = scrollLeft - dx;
        container.scrollTop = scrollTop - dy;
    };

    const onMouseUp = () => {
        if (!isDown) return;
        isDown = false;
        container.classList.remove('timeline-dragging');
        if (didDrag) timelineSuppressClick = true;
        didDrag = false;
    };

    container.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    container.addEventListener('click', (e) => {
        if (timelineSuppressClick) {
            timelineSuppressClick = false;
            return;
        }
        const chip = e.target.closest('.timeline-chip[data-flight][data-date]');
        if (!chip) return;
        selectFlightFromTimeline(chip.dataset.flight, chip.dataset.date);
    });

    container.addEventListener('dblclick', (e) => {
        const head = e.target.closest('.timeline-date-head');
        if (!head || !container.contains(head)) return;
        e.preventDefault();
        const date = head.dataset.date;
        if (!date) return;
        toggleTimelineDateExpand(date);
    });
}

function toggleTimelineDateExpand(date) {
    if (!date) return;
    if (timelineExpandedDates.has(date)) timelineExpandedDates.delete(date);
    else timelineExpandedDates.add(date);
    timelineAnchorDate = date;
    refreshTimelineExpanded();
    requestAnimationFrame(() => {
        const el = document.querySelector(`.timeline-date-head[data-date="${CSS.escape(date)}"]`);
        el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    });
}

function collapseAllTimelineDates() {
    if (!timelineExpandedDates.size) return;
    timelineExpandedDates.clear();
    timelineAnchorDate = null;
    refreshTimelineExpanded();
}

function refreshTimelineExpanded() {
    timelineRenderCache = { sig: '', html: '' };
    const content = document.getElementById('timeline-content');
    if (content) delete content.dataset.renderSig;
    renderTimeline();
}

function updateTimelineCollapseBtn() {
    const btn = document.getElementById('timeline-collapse-all-btn');
    if (!btn) return;
    btn.disabled = timelineExpandedDates.size === 0;
}

function timelineAirportPair(route) {
    const r = String(route || '').toUpperCase().replace(/\s+/g, '');
    const parts = r.split('-').filter(Boolean);
    if (parts.length < 2) return '';
    const a = parts[0].slice(0, 4);
    const b = parts[parts.length - 1].slice(0, 4);
    return `${a}–${b}`;
}

function timelineRouteEnds(route) {
    const r = String(route || '').toUpperCase().replace(/\s+/g, '');
    const parts = r.split('-').filter(Boolean);
    if (parts.length < 2) return null;
    return { from: parts[0], to: parts[parts.length - 1] };
}

function timelineReverseRoute(a, b) {
    const ra = timelineRouteEnds(a.meta?.route);
    const rb = timelineRouteEnds(b.meta?.route);
    return !!(ra && rb && ra.from === rb.to && ra.to === rb.from);
}

function timelineConnects(a, b) {
    const ra = timelineRouteEnds(a.meta?.route);
    const rb = timelineRouteEnds(b.meta?.route);
    return !!(ra && rb && (ra.to === rb.from || rb.to === ra.from));
}

function timelineFamilyPair(fa, fb) {
    const na = parseInt(String(fa || '').replace('KV-', ''), 10) || 0;
    const nb = parseInt(String(fb || '').replace('KV-', ''), 10) || 0;
    if (!na || !nb) return false;
    const lo = Math.min(na, nb);
    const hi = Math.max(na, nb);
    return lo % 2 === 1 && hi === lo + 1;
}

const TIMELINE_TURN_SLACK = 30;

function timelineTurnOk(a, b) {
    if (!a || !b || a.untimed || b.untimed) return true;
    const overlap = a.startMin < b.endMin && b.startMin < a.endMin;
    if (overlap) return false;
    const earlier = a.startMin <= b.startMin ? a : b;
    const later = earlier === a ? b : a;
    return later.startMin >= earlier.endMin - TIMELINE_TURN_SLACK;
}

function timelinePairTimedItems(timed) {
    const used = new Set();
    const groups = [];

    const takePair = (i, j) => {
        const x = timed[i];
        const y = timed[j];
        const out = x.startMin <= y.startMin ? x : y;
        const inn = out === x ? y : x;
        groups.push({
            members: [out, inn],
            startMin: Math.min(out.startMin, inn.startMin),
            endMin: Math.max(out.endMin, inn.endMin)
        });
        used.add(i);
        used.add(j);
    };

    for (let i = 0; i < timed.length; i++) {
        if (used.has(i)) continue;
        for (let j = i + 1; j < timed.length; j++) {
            if (used.has(j)) continue;
            if (!timelineFamilyPair(timed[i].flight, timed[j].flight)) continue;
            const linked = timelineReverseRoute(timed[i], timed[j]) || timelineConnects(timed[i], timed[j]);
            if (!linked) continue;
            takePair(i, j);
            const g = groups[groups.length - 1];
            if (g.members.length === 2) timelineClampPairOverlap(g.members[0], g.members[1]);
            g.startMin = Math.min(g.members[0].startMin, g.members[1].startMin);
            g.endMin = Math.max(g.members[0].endMin, g.members[1].endMin);
            break;
        }
    }
    for (let i = 0; i < timed.length; i++) {
        if (used.has(i)) continue;
        let best = -1;
        let bestGap = Infinity;
        let ambiguous = false;
        for (let j = 0; j < timed.length; j++) {
            if (i === j || used.has(j)) continue;
            if (!timelineReverseRoute(timed[i], timed[j])) continue;
            if (!timelineTurnOk(timed[i], timed[j])) continue;
            const g = Math.min(
                Math.abs(timed[j].startMin - timed[i].endMin),
                Math.abs(timed[i].startMin - timed[j].endMin)
            );
            if (g < bestGap - 20) {
                bestGap = g;
                best = j;
                ambiguous = false;
            } else if (best >= 0 && Math.abs(g - bestGap) <= 20) {
                ambiguous = true;
            }
        }
        if (best >= 0 && !ambiguous && !used.has(best)) takePair(i, best);
    }
    for (let i = 0; i < timed.length; i++) {
        if (used.has(i)) continue;
        groups.push({
            members: [timed[i]],
            startMin: timed[i].startMin,
            endMin: timed[i].endMin
        });
    }
    timelineAssignLanes(groups);
    groups.forEach(g => {
        g.members.forEach(m => { m.lane = g.lane; });
    });
    return groups;
}

function timelineAirportUtc(code) {
    const c = String(code || '').toUpperCase();
    return Object.prototype.hasOwnProperty.call(TIMELINE_AIRPORT_UTC, c)
        ? TIMELINE_AIRPORT_UTC[c]
        : TIMELINE_HUB_UTC;
}

function timelineToHubMin(localMin, airport) {
    if (localMin == null || localMin < 0 || localMin >= TIMELINE_DAY_MIN) return localMin;
    const deltaH = timelineAirportUtc(airport) - TIMELINE_HUB_UTC;
    return localMin - deltaH * 60;
}

function timelineClampPairOverlap(a, b) {
    if (!a || !b || a.untimed || b.untimed) return;
    const earlier = a.startMin <= b.startMin ? a : b;
    const later = earlier === a ? b : a;
    if (later.startMin >= earlier.endMin) return;
    earlier.endMin = Math.max(earlier.startMin + TIMELINE_MIN_BLOCK_MIN, later.startMin - 8);
}

function timelineBlockForMeta(meta) {
    const ends = timelineRouteEnds(meta?.route);
    let depMin = meta?.depMin;
    let arrMin = meta?.arrMin;
    if (ends?.from) depMin = timelineToHubMin(depMin, ends.from);
    if (ends?.to && arrMin != null && arrMin < TIMELINE_DAY_MIN) {
        arrMin = timelineToHubMin(arrMin, ends.to);
    }
    const untimed = depMin == null || depMin >= TIMELINE_DAY_MIN || depMin < 0;
    if (untimed) return { untimed: true };
    if (depMin < 0) depMin = 0;
    let plus1 = false;
    if (arrMin == null || arrMin >= TIMELINE_DAY_MIN * 2) {
        arrMin = Math.min(TIMELINE_DAY_MIN, depMin + 90);
    } else if (arrMin < 0) {
        arrMin += TIMELINE_DAY_MIN;
    }
    if (arrMin <= depMin) {
        plus1 = true;
        arrMin = TIMELINE_DAY_MIN;
    }
    const startMin = depMin;
    const endMin = Math.max(startMin + TIMELINE_MIN_BLOCK_MIN, arrMin);
    return {
        untimed: false,
        startMin,
        endMin: Math.min(TIMELINE_DAY_MIN, endMin),
        plus1
    };
}

function timelineAssignLanes(blocks) {
    const sorted = blocks.slice().sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
    const laneEnds = [];
    sorted.forEach(b => {
        let lane = 0;
        while (lane < laneEnds.length && b.startMin < laneEnds[lane]) lane++;
        if (lane === laneEnds.length) laneEnds.push(b.endMin);
        else laneEnds[lane] = b.endMin;
        b.lane = lane;
    });
    return laneEnds.length;
}

function renderTimelineHourScale() {
    const hours = [];
    for (let h = 0; h < 24; h += 2) hours.push(String(h).padStart(2, '0'));
    return `<div class="timeline-hour-scale" aria-hidden="true">${hours.map(h => `<span class="timeline-hour-tick">${h}</span>`).join('')}</div>`;
}

function shortenTimelineDirection(dir) {
    const text = String(dir || '').trim();
    if (!text) return '';
    const parts = text.split(/[—–-]/).map(s => s.trim()).filter(Boolean);
    if (parts.length === 2) {
        const cut = (s) => (s.length > 9 ? s.slice(0, 8) + '…' : s);
        return cut(parts[0]) + ' — ' + cut(parts[1]);
    }
    return text.length > 18 ? text.slice(0, 17) + '…' : text;
}

function sortTimelineAcTypes(types) {
    return [...types].sort((a, b) => {
        const ia = TIMELINE_AC_ORDER.indexOf(a);
        const ib = TIMELINE_AC_ORDER.indexOf(b);
        if (ia >= 0 && ib >= 0) return ia - ib;
        if (ia >= 0) return -1;
        if (ib >= 0) return 1;
        return a.localeCompare(b, 'ru');
    });
}

function loadTimelineCfg() {
    try {
        const raw = localStorage.getItem(TIMELINE_CFG_KEY);
        if (!raw) return { globalOrder: [], slotPx: 80 };
        const cfg = JSON.parse(raw);
        const slotPx = parseInt(cfg.slotPx, 10);
        return {
            globalOrder: cfg.globalOrder || [],
            slotPx: slotPx >= 56 && slotPx <= 128 ? slotPx : 80
        };
    } catch {
        return { globalOrder: [], slotPx: 80 };
    }
}

function getTimelineSlotPx() {
    return loadTimelineCfg().slotPx || 80;
}

function getTimelineExpandedColPx() {
    return 12 * getTimelineSlotPx();
}

function onTimelineSlotPxChange(sel) {
    const n = parseInt(sel?.value, 10);
    if (!(n >= 56 && n <= 128)) return;
    const cfg = loadTimelineCfg();
    cfg.slotPx = n;
    try { localStorage.setItem(TIMELINE_CFG_KEY, JSON.stringify(cfg)); } catch (e) { /* ignore */ }
    refreshTimelineExpanded();
}

function saveTimelineCfg(cfg) {
    try {
        localStorage.setItem(TIMELINE_CFG_KEY, JSON.stringify(cfg));
        invalidateTimelineCache();
    } catch (e) { console.warn('timeline cfg', e); }
}

function mergeTimelineAcOrder(savedOrder, allTypes) {
    const set = new Set(allTypes);
    const ordered = (savedOrder || []).filter(a => set.has(a));
    const rest = allTypes.filter(a => !ordered.includes(a));
    return [...ordered, ...sortTimelineAcTypes(rest)];
}

function getTimelineGlobalAcOrder(allTypes, cfg) {
    return mergeTimelineAcOrder(cfg?.globalOrder, allTypes);
}

function timelineIsWeekend(date) {
    const d = parseLocalDate(date);
    const wd = d ? d.getDay() : -1;
    return wd === 0 || wd === 6;
}

function renderTimelineChipHtml(flight, date, meta, opts = {}) {
    const chipCls = getTimelineChipClass(meta);
    const selected = typeof currentFlight !== 'undefined' && currentFlight
        && typeof getBaseFlight === 'function'
        && getBaseFlight(flight) === currentFlight;
    const pctLabel = !opts.gantt && meta.pct !== null && !meta.closed && !meta.flew
        ? `${meta.pct}%`
        : '';
    const airports = timelineAirportPair(meta.route);
    const times = [meta.dep, meta.arr].filter(Boolean).join('–');
    const plus = opts.plus1 ? ' +1' : '';
    const loadBits = [];
    if (meta.flew) loadBits.push('улетел');
    else if (meta.closed) loadBits.push('закрыт');
    if (meta.pct !== null && meta.pct !== undefined) loadBits.push(`загрузка ${meta.pct}%` + (meta.sold != null ? ` (${meta.sold})` : ''));
    if (meta.evR !== null && meta.evR !== undefined && !meta.flew) loadBits.push(`ожидаемая ${meta.evR}`);
    if (meta.delta !== null && meta.delta !== undefined && !meta.flew) loadBits.push(`Δ ${meta.delta > 0 ? '+' : ''}${meta.delta}`);
    const title = [flight, airports || meta.direction, times ? times + plus : 'без времени', meta.ac].filter(Boolean).join(' · ')
        + (loadBits.length ? '\n' + loadBits.join(' · ') : '');
    const ganttCls = opts.gantt ? ' timeline-chip-gantt' : '';
    const selCls = selected ? ' timeline-chip-selected' : '';
    const style = opts.style ? ` style="${opts.style}"` : '';
    const line2 = airports
        || (!opts.gantt ? shortenTimelineDirection(meta.direction) : '');
    return `<div class="${chipCls}${ganttCls}${selCls}" data-flight="${escAttr(flight)}" data-date="${escAttr(date)}" role="button" tabindex="0" title="${escAttr(title)}"${style}>
        <div class="timeline-chip-top">
            <span class="timeline-chip-flight">${escHtml(flight)}</span>
            ${pctLabel ? `<span class="timeline-chip-pct">${pctLabel}</span>` : ''}
            ${opts.plus1 ? '<span class="timeline-plus1">+1</span>' : ''}
        </div>
        ${line2 ? `<span class="timeline-chip-dir">${escHtml(line2)}</span>` : ''}
        ${!opts.gantt && meta.pct !== null && !meta.closed && !meta.flew ? `<span class="timeline-chip-bar"><span class="timeline-chip-bar-fill" style="width:${Math.min(100, Math.max(0, meta.pct))}%"></span></span>` : ''}
    </div>`;
}

function buildTimelineHtml() {
    const cfg = loadTimelineCfg();
    const metricsByKey = buildMetricsCache().byKey;
    const today = getTodayDate();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const metaByDateFlight = {};
    const flightDates = {};
    const flightSeen = {};
    const allAcTypes = new Set();
    const allDates = [];

    getValidFlightBases().forEach(base => {
        (groupedData[base] || []).forEach(row => {
            const date = row[1];
            const fl = cleanFlight(row[0]);
            if (!date || !isValidFlightBase(getBaseFlight(fl))) return;
            if (window.networkMapFilter && typeof NetworkMap !== 'undefined' && NetworkMap.flightMatchesFilter
                && !NetworkMap.flightMatchesFilter(fl, row)) return;
            const dk = `${date}\x1f${fl}`;
            if (!metaByDateFlight[dk]) {
                const m = metricsByKey[getMetricsStorageKey(row)];
                const depStr = typeof getDepTime === 'function' ? getDepTime(row) : '';
                const arrStr = typeof getArrTime === 'function' ? getArrTime(row) : '';
                const depMin = typeof timeToMinutes === 'function' ? timeToMinutes(depStr || row[11]) : 9999;
                const arrMin = arrStr && typeof timeToMinutes === 'function' ? timeToMinutes(arrStr) : 9999;
                metaByDateFlight[dk] = {
                    pct: m ? m.pct : null,
                    sold: m ? m.free : null,
                    evR: m ? m.evR : null,
                    delta: m ? m.delta : null,
                    closed: m ? m.closed : false,
                    flew: m ? m.flew : false,
                    direction: getFlightDirection(base),
                    ac: getAircraftType(row[4]),
                    route: typeof getRouteFromRow === 'function' ? getRouteFromRow(row) : '',
                    dep: depStr || '',
                    depMin: depMin,
                    arr: arrStr || '',
                    arrMin: arrMin
                };
                if (!flightSeen[date]) flightSeen[date] = new Set();
                if (!flightSeen[date].has(fl)) {
                    flightSeen[date].add(fl);
                    if (!flightDates[date]) flightDates[date] = [];
                    flightDates[date].push(fl);
                    if (!allDates.includes(date)) allDates.push(date);
                }
            } else {
                // если позже встретился более ранний вылет (сегменты) — берём минимальное время
                const depStr = typeof getDepTime === 'function' ? getDepTime(row) : '';
                const arrStr = typeof getArrTime === 'function' ? getArrTime(row) : '';
                const depMin = typeof timeToMinutes === 'function' ? timeToMinutes(depStr || row[11]) : 9999;
                const arrMin = arrStr && typeof timeToMinutes === 'function' ? timeToMinutes(arrStr) : 9999;
                if (depMin < (metaByDateFlight[dk].depMin ?? 9999)) {
                    metaByDateFlight[dk].dep = depStr || metaByDateFlight[dk].dep;
                    metaByDateFlight[dk].depMin = depMin;
                    metaByDateFlight[dk].arr = arrStr || metaByDateFlight[dk].arr;
                    metaByDateFlight[dk].arrMin = arrMin;
                    if (typeof getRouteFromRow === 'function') {
                        metaByDateFlight[dk].route = getRouteFromRow(row) || metaByDateFlight[dk].route;
                    }
                }
            }
            allAcTypes.add(getAircraftType(row[4]));
        });
    });

    allDates.sort((a, b) => {
        const [d1, m1, y1] = a.split('.').map(Number);
        const [d2, m2, y2] = b.split('.').map(Number);
        return new Date(y1, m1 - 1, d1) - new Date(y2, m2 - 1, d2);
    });
    // в пределах даты: время вылета, затем номер рейса
    Object.keys(flightDates).forEach(d => {
        flightDates[d].sort((a, b) => {
            const ta = metaByDateFlight[`${d}\x1f${a}`]?.depMin ?? 9999;
            const tb = metaByDateFlight[`${d}\x1f${b}`]?.depMin ?? 9999;
            if (ta !== tb) return ta - tb;
            const na = parseInt(String(a).replace('KV-', ''), 10) || 0;
            const nb = parseInt(String(b).replace('KV-', ''), 10) || 0;
            return na - nb || String(a).localeCompare(String(b));
        });
    });

    const acTypesList = sortTimelineAcTypes([...allAcTypes].filter(a => a && a !== '-'));
    const globalAcOrder = getTimelineGlobalAcOrder(acTypesList, cfg);
    const maxChipsByAc = Object.fromEntries(globalAcOrder.map(ac => [ac, 0]));
    const expandedHByAc = Object.fromEntries(globalAcOrder.map(ac => [ac, 0]));

    let orderedDates = allDates;
    const todayIdx = orderedDates.indexOf(today);
    if (todayIdx > 0) {
        orderedDates = orderedDates.slice(0, todayIdx).concat(orderedDates.slice(todayIdx));
    }

    const byDateAc = {};
    orderedDates.forEach(date => {
        byDateAc[date] = {};
        (flightDates[date] || []).forEach(flight => {
            const meta = metaByDateFlight[`${date}\x1f${flight}`];
            if (!meta) return;
            const acKey = meta.ac || '-';
            if (!byDateAc[date][acKey]) byDateAc[date][acKey] = [];
            byDateAc[date][acKey].push({ flight, meta });
        });
    });

    orderedDates.forEach(date => {
        const expanded = timelineExpandedDates.has(date);
        globalAcOrder.forEach(ac => {
            const items = byDateAc[date]?.[ac] || [];
            maxChipsByAc[ac] = Math.max(maxChipsByAc[ac], items.length);
            if (!expanded || !items.length) return;
            const sortedItems = items.slice().sort((a, b) => {
                const ta = a.meta?.depMin ?? 9999;
                const tb = b.meta?.depMin ?? 9999;
                if (ta !== tb) return ta - tb;
                const na = parseInt(String(a.flight).replace('KV-', ''), 10) || 0;
                const nb = parseInt(String(b.flight).replace('KV-', ''), 10) || 0;
                return na - nb || String(a.flight).localeCompare(String(b.flight));
            });
            const timed = [];
            let untimedN = 0;
            sortedItems.forEach(it => {
                const block = timelineBlockForMeta(it.meta);
                if (block.untimed) untimedN++;
                else timed.push({ ...it, ...block });
            });
            const groups = timelinePairTimedItems(timed);
            const lanes = groups.length ? Math.max(...groups.map(g => g.lane || 0)) + 1 : 0;
            const untimedH = untimedN ? timelineRowHeight(untimedN) : 0;
            const ganttH = lanes ? (TIMELINE_CELL_PAD + lanes * TIMELINE_GANTT_CHIP_H + (lanes - 1) * TIMELINE_CHIP_GAP) : 0;
            expandedHByAc[ac] = Math.max(expandedHByAc[ac], Math.max(36, untimedH + ganttH));
        });
    });

    const anyExpanded = timelineExpandedDates.size > 0;
    const rowHeights = Object.fromEntries(
        globalAcOrder.map(ac => {
            if (anyExpanded) return [ac, Math.max(36, expandedHByAc[ac] || 36)];
            return [ac, timelineRowHeight(maxChipsByAc[ac])];
        })
    );
    const headerH = anyExpanded ? TIMELINE_HEADER_H_EXPANDED : TIMELINE_HEADER_H;
    const colWidths = orderedDates.map(d =>
        timelineExpandedDates.has(d) ? `${getTimelineExpandedColPx()}px` : `${TIMELINE_COMPACT_COL_PX}px`
    );
    const gridCols = `92px ${colWidths.join(' ')}`;
    const gridRows = `${headerH}px ${globalAcOrder.map(ac => `${rowHeights[ac]}px`).join(' ')}`;
    const gridParts = [`<div class="timeline-corner-cell" style="grid-column:1;grid-row:1;height:${headerH}px" title="Тип воздушного судна">Тип ВС</div>`];

    orderedDates.forEach((date, colIdx) => {
        const col = colIdx + 2;
        const isToday = date === today;
        const fd = parseLocalDate(date);
        const isPast = fd ? fd < todayStart : false;
        const flights = flightDates[date] || [];
        const expanded = timelineExpandedDates.has(date);
        const headCls = [
            'timeline-date-head',
            isToday ? 'timeline-date-head-today' : '',
            isPast ? 'timeline-date-head-past' : '',
            expanded ? 'timeline-date-head-expanded' : ''
        ].filter(Boolean).join(' ');
        const dow = getDayOfWeek(date);
        const hint = expanded ? 'Двойной клик — свернуть' : 'Двойной клик — сетка 2 ч';
        const dateLabel = String(date).slice(0, 5);
        // Одна строка «чт 08.10» и число рейсов: в две-три строки дата обрезалась по высоте.
        gridParts.push(`<div class="${headCls}${timelineIsWeekend(date) ? ' timeline-date-head-weekend' : ''}" style="grid-column:${col};grid-row:1;height:${headerH}px" data-date="${escAttr(date)}" title="${escAttr(date + ' · ' + dow + (isToday ? ' · сегодня' : '') + ' · рейсов: ' + flights.length + ' · ' + hint)}">
            <span class="timeline-date-line"><span class="timeline-dow">${escHtml(dow)}</span><span class="timeline-date">${escHtml(dateLabel)}</span>${flights.length ? `<span class="timeline-count">${flights.length}</span>` : ''}</span>
            ${expanded ? renderTimelineHourScale() : ''}
        </div>`);
    });

    globalAcOrder.forEach((ac, acIdx) => {
        const row = acIdx + 2;
        const h = rowHeights[ac];
        const slug = getTimelineAcSlug(ac);
        gridParts.push(`<div class="timeline-side-ac timeline-ac-${slug}" data-ac="${escHtml(ac)}" style="grid-column:1;grid-row:${row};height:${h}px">
            <span class="timeline-ac-dot"></span>
            <span class="timeline-ac-name">${escHtml(ac)}</span>
        </div>`);

        orderedDates.forEach((date, colIdx) => {
            const col = colIdx + 2;
            const fd = parseLocalDate(date);
            const isPast = fd ? fd < todayStart : false;
            const items = byDateAc[date]?.[ac] || [];
            const expanded = timelineExpandedDates.has(date);
            let inner = '<span class="timeline-cell-empty"></span>';
            if (items.length) {
                items.sort((a, b) => {
                    const ta = a.meta?.depMin ?? 9999;
                    const tb = b.meta?.depMin ?? 9999;
                    if (ta !== tb) return ta - tb;
                    const na = parseInt(String(a.flight).replace('KV-', ''), 10) || 0;
                    const nb = parseInt(String(b.flight).replace('KV-', ''), 10) || 0;
                    return na - nb || String(a.flight).localeCompare(String(b.flight));
                });
                if (expanded) {
                    const untimed = [];
                    const timed = [];
                    items.forEach(it => {
                        const block = timelineBlockForMeta(it.meta);
                        if (block.untimed) untimed.push(it);
                        else timed.push({ ...it, ...block });
                    });
                    timelinePairTimedItems(timed);
                    const untimedHtml = untimed.length
                        ? `<div class="timeline-untimed">${untimed.map(({ flight, meta }) => renderTimelineChipHtml(flight, date, meta)).join('')}</div>`
                        : '';
                    const ganttH = timed.length
                        ? (Math.max(...timed.map(b => b.lane || 0)) + 1) * (TIMELINE_GANTT_CHIP_H + TIMELINE_CHIP_GAP)
                        : 0;
                    const ganttHtml = timed.length
                        ? `<div class="timeline-gantt" style="height:${ganttH}px">${timed.map(b => {
                            const left = (b.startMin / TIMELINE_DAY_MIN) * 100;
                            const durPct = ((b.endMin - b.startMin) / TIMELINE_DAY_MIN) * 100;
                            const width = Math.min(100 - left, Math.max(1.2, durPct));
                            const top = (b.lane || 0) * (TIMELINE_GANTT_CHIP_H + TIMELINE_CHIP_GAP);
                            return renderTimelineChipHtml(b.flight, date, b.meta, {
                                gantt: true,
                                plus1: b.plus1,
                                style: `left:${left}%;width:${width}%;top:${top}px`
                            });
                        }).join('')}</div>`
                        : '';
                    inner = untimedHtml + ganttHtml || inner;
                    if (date === getTodayDate() && ganttHtml) {
                        // Линия «сейчас» по оси Красноярска (UTC+7), как и блоки рейсов.
                        const now = new Date();
                        const hubMin = ((now.getUTCHours() + TIMELINE_HUB_UTC) % 24) * 60 + now.getUTCMinutes();
                        inner += `<span class="timeline-now-line" style="left:${(hubMin / TIMELINE_DAY_MIN) * 100}%" title="Сейчас"></span>`;
                    }
                } else {
                    inner = items.map(({ flight, meta }) => renderTimelineChipHtml(flight, date, meta)).join('');
                }
            }
            const cellCls = [
                'timeline-cell',
                `timeline-ac-${slug}`,
                isPast ? 'timeline-cell-past' : '',
                timelineIsWeekend(date) ? 'timeline-cell-weekend' : '',
                expanded ? 'timeline-cell-expanded' : ''
            ].filter(Boolean).join(' ');
            gridParts.push(`<div class="${cellCls}" data-ac="${escAttr(ac)}" data-date="${escAttr(date)}" style="grid-column:${col};grid-row:${row};height:${h}px">${inner}</div>`);
        });
    });

    const expandedCls = anyExpanded ? ' timeline-grid-expanded' : '';
    return `<div class="timeline-matrix"><div id="timeline-ac-list" class="timeline-grid${expandedCls}" style="grid-template-columns:${gridCols};grid-template-rows:${gridRows}">${gridParts.join('')}</div></div>`;
}

function ensureTimelineOrderModal() {
    if (document.getElementById('timeline-order-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'timeline-order-modal';
    modal.className = 'timeline-order-modal';
    modal.innerHTML = `
        <div class="timeline-order-backdrop" onclick="closeTimelineOrderModal()"></div>
        <div class="timeline-order-panel">
            <div class="timeline-order-head">
                <h3 id="timeline-order-title">Порядок типов ВС</h3>
                <button type="button" class="timeline-order-close" onclick="closeTimelineOrderModal()">✕</button>
            </div>
            <p id="timeline-order-hint" class="timeline-order-hint"></p>
            <div id="timeline-order-list" class="timeline-order-list"></div>
            <div class="timeline-order-foot">
                <button type="button" class="btn-secondary" onclick="resetTimelineAcOrder()">По умолчанию</button>
                <button type="button" class="btn-primary" onclick="applyTimelineOrderModal()">Сохранить</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
}

function openTimelineAcSettingsModal() {
    ensureTimelineOrderModal();
    const cfg = loadTimelineCfg();
    const allTypes = [...document.querySelectorAll('.timeline-grid .timeline-side-ac')].map(el => el.dataset.ac);
    const order = getTimelineGlobalAcOrder(allTypes.length ? allTypes : sortTimelineAcTypes([...TIMELINE_AC_ORDER]), cfg);

    document.getElementById('timeline-order-title').textContent = 'Порядок типов ВС';
    const orderHint = document.getElementById('timeline-order-hint');
    if (orderHint) orderHint.textContent = '';
    renderTimelineOrderList(order);
    document.getElementById('timeline-order-modal').classList.add('open');
}

function renderTimelineOrderList(order) {
    const list = document.getElementById('timeline-order-list');
    if (!list) return;
    list.innerHTML = order.map((ac, idx) => `
        <div class="timeline-order-item timeline-ac-${getTimelineAcSlug(ac)}" data-ac="${escHtml(ac)}">
            <span class="timeline-order-index">${idx + 1}</span>
            <span class="timeline-order-name">${escHtml(ac)}</span>
            <div class="timeline-order-arrows">
                <button type="button" data-move="-1" ${idx === 0 ? 'disabled' : ''}>↑</button>
                <button type="button" data-move="1" ${idx === order.length - 1 ? 'disabled' : ''}>↓</button>
            </div>
        </div>
    `).join('');

    list.querySelectorAll('.timeline-order-item').forEach(el => {
        el.querySelectorAll('[data-move]').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                moveTimelineOrderItem(el.dataset.ac, parseInt(btn.dataset.move, 10));
            };
        });
    });
}

function moveTimelineOrderItem(ac, dir) {
    const list = document.getElementById('timeline-order-list');
    if (!list) return;
    const items = [...list.querySelectorAll('.timeline-order-item')].map(x => x.dataset.ac);
    const idx = items.indexOf(ac);
    const next = idx + dir;
    if (idx < 0 || next < 0 || next >= items.length) return;
    [items[idx], items[next]] = [items[next], items[idx]];
    renderTimelineOrderList(items);
}

function applyTimelineOrderModal() {
    const list = document.getElementById('timeline-order-list');
    if (!list) return;
    const order = [...list.querySelectorAll('.timeline-order-item')].map(x => x.dataset.ac);
    const cfg = loadTimelineCfg();
    cfg.globalOrder = order;
    saveTimelineCfg(cfg);
    closeTimelineOrderModal();
    renderTimeline();
    showToast('Порядок ВС сохранён');
}

function resetTimelineAcOrder() {
    const list = document.getElementById('timeline-order-list');
    if (!list) return;
    const allTypes = [...list.querySelectorAll('.timeline-order-item')].map(x => x.dataset.ac);
    renderTimelineOrderList(sortTimelineAcTypes(allTypes));
}

function closeTimelineOrderModal() {
    document.getElementById('timeline-order-modal')?.classList.remove('open');
}

function scrollTimelineToToday(behavior = 'smooth') {
    const container = document.getElementById('timeline-container');
    const content = document.getElementById('timeline-content');
    if (!container || !content) return;
    const todayEl = content.querySelector('.timeline-date-head-today');
    if (!todayEl) {
        showToast('Сегодняшняя дата не найдена в плане', 'error');
        return;
    }
    const targetScroll = Math.max(0, todayEl.offsetLeft - TIMELINE_SCROLL_OFFSET);
    container.scrollTo({ left: targetScroll, behavior });
}

function getTimelineChipClass(meta) {
    if (meta.closed) return 'timeline-chip timeline-chip-closed';
    if (meta.flew) return 'timeline-chip timeline-chip-flew';
    if (meta.pct !== null && meta.pct >= 95) return 'timeline-chip timeline-chip-full';
    if (meta.pct !== null && meta.pct < 40) return 'timeline-chip timeline-chip-low';
    return 'timeline-chip timeline-chip-open';
}

function renderTimeline() {
    const content = document.getElementById('timeline-content');
    if (!content) return;
    const banner = document.getElementById('timeline-map-filter-banner');
    if (banner) {
        const f = window.networkMapFilter;
        if (f && (f.city || f.query)) {
            banner.hidden = false;
            banner.innerHTML = `Фильтр карты: ${escHtml(f.city || f.query)} <button type="button" class="btn-secondary" id="timeline-clear-map-filter">Сбросить</button>`;
            banner.querySelector('#timeline-clear-map-filter')?.addEventListener('click', () => {
                window.networkMapFilter = null;
                invalidateTimelineCache();
                renderTimeline();
            });
        } else {
            banner.hidden = true;
            banner.innerHTML = '';
        }
    }

    if (!groupedData || Object.keys(groupedData).length === 0) {
        invalidateTimelineCache();
        content.innerHTML = `
            <div class="timeline-empty">
                <div class="timeline-empty-icon">📅</div>
                <div class="timeline-empty-title">Графический план полетов</div>
            </div>
        `;
        updateTimelineCollapseBtn();
        return;
    }

    const sig = getTimelineCacheSignature();
    if (timelineRenderCache.sig !== sig || !timelineRenderCache.html) {
        timelineRenderCache = { sig, html: buildTimelineHtml() };
    }
    if (content.dataset.renderSig === sig && content.childElementCount > 0) {
        markTimelineSelectedChip();
        updateTimelineCollapseBtn();
        if (!timelineInitialScrollDone) {
            timelineInitialScrollDone = true;
            requestAnimationFrame(() => scrollTimelineToToday('auto'));
        }
        return;
    }
    content.innerHTML = timelineRenderCache.html;
    content.dataset.renderSig = sig;
    markTimelineSelectedChip();
    updateTimelineCollapseBtn();

    if (!timelineInitialScrollDone) {
        timelineInitialScrollDone = true;
        requestAnimationFrame(() => scrollTimelineToToday('auto'));
    }
}
