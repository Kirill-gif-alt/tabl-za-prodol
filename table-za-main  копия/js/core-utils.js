// js\core-utils.js - extracted from script.js, logic unchanged.
// Globals on purpose: no bundler; onclick and other files call by name.

function escHtml(s) {
    return typeof Security !== 'undefined' ? Security.escapeHtml(s) : String(s || '');
}

function escAttr(s) {
    return typeof Security !== 'undefined' ? Security.escapeAttr(s) : String(s || '');
}

function formatNum(n) {
    if (n === null || n === undefined || n === '' || n === '—' || n === '-') return n;
    if (typeof n === 'string' && /₽|\/|ЗАКРЫТ|УЛЕТЕЛ|%/.test(n)) return n;
    const num = typeof n === 'number' ? n : parseFloat(String(n).replace(/\s/g, '').replace(/[^\d.-]/g, ''));
    if (isNaN(num)) return String(n);
    return Math.round(num).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
}

function formatRub(n) {
    if (n === null || n === undefined || n === '' || n === '—' || n === '-') return '—';
    const num = typeof n === 'number' ? n : parseFloat(String(n).replace(/\s/g, '').replace(/[^\d.-]/g, ''));
    if (isNaN(num) || num === 0) return '—';
    return formatNum(num) + ' ₽';
}

function formatRubSigned(n) {
    if (n === null || n === undefined || n === '' || isNaN(n)) return '—';
    const num = Math.round(Number(n));
    if (!num) return '0 ₽';
    const sign = num < 0 ? '−' : '';
    return sign + formatNum(Math.abs(num)) + ' ₽';
}

function isValidCalendarDate(y, m0, d) {
    if (!Number.isFinite(y) || !Number.isFinite(m0) || !Number.isFinite(d)) return false;
    if (y < 1900 || y > 2200 || m0 < 0 || m0 > 11 || d < 1 || d > 31) return false;
    const dt = new Date(y, m0, d);
    return dt.getFullYear() === y && dt.getMonth() === m0 && dt.getDate() === d;
}

function parseLocalDate(dateStr) {
    if (typeof PerfCache !== 'undefined') return PerfCache.parseLocalDateMemo(dateStr);
    if (!dateStr) return null;
    const parts = String(dateStr).split('.');
    if (parts.length !== 3) return null;
    const d = parseInt(parts[0], 10), m = parseInt(parts[1], 10) - 1, y = parseInt(parts[2], 10);
    if (!isValidCalendarDate(y, m, d)) return null;
    return new Date(y, m, d);
}

// Активные Chart.js-инстансы (уничтожаем при перерисовке)
const activeCharts = {};

function destroyChart(id) {
    if (activeCharts[id]) {
        activeCharts[id].destroy();
        delete activeCharts[id];
    }
}

function destroyChartsByPrefix(prefix) {
    Object.keys(activeCharts).forEach(id => {
        if (id.startsWith(prefix)) destroyChart(id);
    });
}

function createManagedChart(id, config) {
    destroyChart(id);
    const canvas = document.getElementById(id);
    if (!canvas || typeof Chart === 'undefined') return null;
    activeCharts[id] = new Chart(canvas, config);
    return activeCharts[id];
}

const reportChartExpandConfigs = {};

function expandReportChart(chartId, title) {
    const config = reportChartExpandConfigs[chartId];
    if (!config || typeof Chart === 'undefined') return;

    let modal = document.getElementById('chart-expand-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'chart-expand-modal';
        modal.className = 'chart-expand-modal';
        modal.innerHTML = `
            <div class="chart-expand-backdrop" onclick="closeChartExpandModal()"></div>
            <div class="chart-expand-panel">
                <div class="chart-expand-header">
                    <h3 id="chart-expand-title"></h3>
                    <button type="button" onclick="closeChartExpandModal()" class="chart-expand-close">✕</button>
                </div>
                <div class="chart-expand-body">
                    <canvas id="chart-expand-canvas"></canvas>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeChartExpandModal();
        });
    }

    document.getElementById('chart-expand-title').textContent = title;
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
    destroyChart('chart-expand-canvas');
    createManagedChart('chart-expand-canvas', {
        type: config.type,
        data: config.data,
        options: { ...config.options, maintainAspectRatio: false }
    });
}

function closeChartExpandModal() {
    const modal = document.getElementById('chart-expand-modal');
    if (modal) modal.classList.remove('open');
    destroyChart('chart-expand-canvas');
    document.body.style.overflow = '';
}

let loadingCount = 0;

function showLoading(msg = 'Загрузка данных...') {
    loadingCount++;
    const el = document.getElementById('loading-overlay');
    const text = document.getElementById('loading-text');
    const btn = document.getElementById('load-data-btn');
    if (el) {
        el.classList.add('open');
        el.setAttribute('aria-busy', 'true');
        el.setAttribute('aria-hidden', 'false');
    }
    if (text) text.textContent = msg;
    if (btn) btn.disabled = true;
}

function setLoadingMessage(msg) {
    const text = document.getElementById('loading-text');
    if (text) text.textContent = msg;
}

function hideLoading() {
    loadingCount = Math.max(0, loadingCount - 1);
    if (loadingCount === 0) {
        const el = document.getElementById('loading-overlay');
        if (el) {
            el.classList.remove('open');
            el.setAttribute('aria-busy', 'false');
            el.setAttribute('aria-hidden', 'true');
        }
        const btn = document.getElementById('load-data-btn');
        if (btn) btn.disabled = false;
    }
}

function applyChartRuLocale() {
    if (typeof Chart === 'undefined') return;
    Chart.defaults.font.family = "'Inter', system-ui, sans-serif";
    Chart.defaults.locale = 'ru-RU';
}

function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    // не копить десятки toast
    while (container.children.length >= 4) container.firstElementChild.remove();
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.3s';
        setTimeout(() => toast.remove(), 300);
    }, 3200);
}

function formatDateRu(d) {
    return d.getDate().toString().padStart(2, '0') + '.' +
        (d.getMonth() + 1).toString().padStart(2, '0') + '.' + d.getFullYear();
}

function parseDealDateTime(str) {
    const s = String(str || '').trim();
    const withTime = s.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})/);
    if (withTime) {
        const d = withTime[1].padStart(2, '0');
        const m = withTime[2].padStart(2, '0');
        return { date: `${d}.${m}.${withTime[3]}`, hour: parseInt(withTime[4], 10) };
    }
    const dateOnly = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (dateOnly) {
        const d = dateOnly[1].padStart(2, '0');
        const m = dateOnly[2].padStart(2, '0');
        return { date: `${d}.${m}.${dateOnly[3]}`, hour: null };
    }
    return { date: normalizeDate(s), hour: null };
}

const VIEW_ZOOM = { main: 1, table: 1, pkz: 1, pair: 1, costs: 1, data: 1, rms: 1, home: 1, sales: 1, creative: 1, reports: 1 };
// Масштаб общий для всех вкладок и запоминается в браузере.
const VIEW_ZOOM_KEY = 'krasavia_view_zoom';
(function restoreViewZoom() {
    let z = 1;
    try { z = parseFloat(localStorage.getItem(VIEW_ZOOM_KEY)) || 1; } catch (e) { /* ignore */ }
    z = Math.min(1.6, Math.max(0.55, z));
    Object.keys(VIEW_ZOOM).forEach(k => { VIEW_ZOOM[k] = z; });
})();
let dataBoardZoom = VIEW_ZOOM.data;
/** Спец. брони (AV SSP Seg) — галочка на данных / динамике / экономике / ПКЗ */
let dataShowSpecBookings = false;
let showSpecBookings = false;
/** Время местное (вылет/прилёт) на «Загрузка рейсов» */
let dataShowLocalTimes = false;

/** Масштаб в шапке — один на все вкладки */
function syncGlobalZoomUi(tabKey) {
    const tab = tabKey || (typeof currentTab !== 'undefined' ? currentTab : 'main');
    const label = document.getElementById('global-zoom-val');
    if (label) label.textContent = `${Math.round((VIEW_ZOOM[tab] || 1) * 100)}%`;
}

function setViewZoom(tabKey, delta) {
    const tab = tabKey || (typeof currentTab !== 'undefined' ? currentTab : 'main');
    const cur = VIEW_ZOOM[tab] ?? 1;
    const next = Math.min(1.6, Math.max(0.55, Math.round((cur + delta) * 100) / 100));
    // Один масштаб на все вкладки: меняем сразу везде, в том числе на уже открытых.
    Object.keys(VIEW_ZOOM).forEach(k => { VIEW_ZOOM[k] = next; });
    dataBoardZoom = next;
    try { localStorage.setItem(VIEW_ZOOM_KEY, String(next)); } catch (e) { /* ignore */ }
    Object.keys(VIEW_ZOOM).forEach(k => applyViewZoom(k));
    syncGlobalZoomUi(tab);
}

function applyZoomToElement(el, scale) {
    if (!el) return;
    const next = (scale && scale !== 1) ? String(scale) : '';
    if (el.style.zoom === next) return;
    el.style.transform = '';
    el.style.width = '';
    el.style.transformOrigin = '';
    el.style.zoom = next;
}

function applyViewZoom(tabKey) {
    const tab = tabKey || (typeof currentTab !== 'undefined' ? currentTab : 'main');
    const scale = VIEW_ZOOM[tab] ?? 1;
    syncGlobalZoomUi(tab);

    if (tab === 'data') {
        dataBoardZoom = scale;
        applyZoomToElement(document.getElementById('data-board-track'), scale);
        return;
    }

    // Вкладки без своей таблицы (Отчёты, Расчёт расходов) — масштаб на содержимое вкладки.
    const target = document.querySelector(`[data-zoom-target="${tab}"]`)
        || document.querySelector(`#tab-panel-${tab} .table-page-body`)
        || document.querySelector(`#tab-panel-${tab} .rp-body`);
    applyZoomToElement(target, scale);
}

function bindGlobalZoomControls() {
    const out = document.getElementById('global-zoom-out');
    const inn = document.getElementById('global-zoom-in');
    if (out && !out.dataset.bound) {
        out.dataset.bound = '1';
        out.addEventListener('click', () => setViewZoom(typeof currentTab !== 'undefined' ? currentTab : 'main', -0.1));
    }
    if (inn && !inn.dataset.bound) {
        inn.dataset.bound = '1';
        inn.addEventListener('click', () => setViewZoom(typeof currentTab !== 'undefined' ? currentTab : 'main', 0.1));
    }
    syncGlobalZoomUi();
}

// совместимость: старые вызовы bindViewZoomButtons игнорируем
function bindViewZoomButtons() { /* zoom в шапке */ }
function buildViewZoomHtml() { return ''; }

const DAYS_RU = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

const MAX_WEEK = 52;
const DEFAULT_AIRCRAFT_CAPACITY = 46;
const ATR72_CAPACITY = 72;
const YAK42_CAPACITY = 120;

function parseDateStr(str){if(!str)return null;const c=String(str).replace(/[^0-9]/g,'');if(c.length!==8)return null;const d=parseInt(c.slice(0,2),10),m=parseInt(c.slice(2,4),10)-1,y=parseInt(c.slice(4),10);if(!isValidCalendarDate(y,m,d))return null;return new Date(y,m,d)}
function calculateAgeAtFly(b,f){const br=parseDateStr(b),fl=parseDateStr(f);if(!br||!fl)return null;let a=fl.getFullYear()-br.getFullYear();const md=fl.getMonth()-br.getMonth();if(md<0||(md===0&&fl.getDate()<br.getDate()))a--;return a}
function extractDiscountPercent(s){if(!s)return 0;s=String(s).toUpperCase().trim();let m=s.match(/CN(\d{1,2})/);if(m)return parseInt(m[1],10);m=s.match(/\/(\d{2})$/);if(m)return parseInt(m[1],10);if((s.includes('LOW')||s.includes('CN')||s.includes('CHILD'))&&(m=s.match(/(\d{2})$/)))return parseInt(m[1],10);return 0}
function getAdjustedFare(paid,basic,birth,fly){if(!paid||paid<=0)return paid;const d=extractDiscountPercent(basic);const age=calculateAgeAtFly(birth,fly);return(age!==null&&age<12&&d>0)?Math.round((paid*100)/(100-d)):paid}
function getCapacityFromAircraft(t){t=String(t||'').toUpperCase();if(t.includes('ATR-72')||t.includes('AT7'))return ATR72_CAPACITY;if(t.includes('ЯК-42')||t.includes('YK2'))return YAK42_CAPACITY;return DEFAULT_AIRCRAFT_CAPACITY}
function getWeekNumber(input){
    if (typeof PerfCache !== 'undefined' && PerfCache.getWeekNumberMemo) return PerfCache.getWeekNumberMemo(input);
    if(!input)return 1;let d;if(input instanceof Date){d=new Date(input)}else{d=new Date(String(input).split('.').reverse().join('-'))}d.setHours(0,0,0,0);const j=new Date(d.getFullYear(),0,1);j.setHours(0,0,0,0);const dow=j.getDay();let mon=new Date(j);if(dow===0)mon.setDate(j.getDate()-6);else mon.setDate(j.getDate()-(dow-1));const diff=Math.floor((d-mon)/86400000);let w=Math.floor(diff/7)+1;return Math.min(Math.max(w,1),MAX_WEEK)
}
function getWeekForExpectedLoad(input){let w=getWeekNumber(input);return w>MAX_WEEK?MAX_WEEK:w}
function getDaysUntil(input){
    if (typeof PerfCache !== 'undefined' && PerfCache.getDaysUntilMemo) {
        return PerfCache.getDaysUntilMemo(input, typeof getTodayDate === 'function' ? getTodayDate() : '');
    }
    if(!input)return null;let f;if(input instanceof Date){f=new Date(input)}else{f=new Date(String(input).split('.').reverse().join('-'))}const t=new Date();t.setHours(0,0,0,0);f.setHours(0,0,0,0);return Math.ceil((f-t)/86400000)
}

function renderTableEmptyState(cont, title, hint, icon = '📭') {
    if (!cont) return;
    const hintHtml = hint ? `<div class="table-empty-hint">${escHtml(hint)}</div>` : '';
    cont.innerHTML = `
        <div class="table-empty-state">
            <div class="table-empty-icon">${escHtml(icon)}</div>
            <div class="table-empty-title">${escHtml(title)}</div>
            ${hintHtml}
        </div>`;
}


function compareDateStr(a, b) {
    const ka = String(a || '').split('.');
    const kb = String(b || '').split('.');
    if (ka.length !== 3 || kb.length !== 3) return 0;
    const na = (+ka[2]) * 10000 + (+ka[1]) * 100 + (+ka[0]);
    const nb = (+kb[2]) * 10000 + (+kb[1]) * 100 + (+kb[0]);
    return na - nb;
}

function getAircraftType(c){c=String(c||'').toUpperCase();if(c.includes('AT5'))return'ATR-42';if(c.includes('AN4'))return'Ан-24';if(c.includes('AN6'))return'Ан-26';if(c.includes('AT7'))return'ATR-72';if(c.includes('YK2'))return'Як-42';return c||'-'}
function cleanFlight(s) {
    if (typeof PerfCache !== 'undefined') return PerfCache.cleanFlightMemo(s);
    const n = String(s || '').replace(/[^0-9]/g, '');
    return n ? 'KV-' + n : '';
}
function normalizeDate(d){d=String(d||'').replace(/[^0-9.]/g,'');if(d.length===8)return d.slice(0,2)+'.'+d.slice(2,4)+'.'+d.slice(4);return d}
let CACHED_TODAY = null;
let CACHED_YESTERDAY = null;

function getTodayDate(){
    const today = formatDateRu(new Date());
    if (CACHED_TODAY !== today) {
        CACHED_TODAY = today;
        CACHED_YESTERDAY = null;
    }
    return CACHED_TODAY;
}
function getTodayYesterday(){
    getTodayDate();
    if(!CACHED_YESTERDAY){
        const t=new Date(); t.setHours(0,0,0,0);
        const day = (n) => { const d = new Date(t); d.setDate(d.getDate() - n); return formatDateRu(d); };
        CACHED_YESTERDAY = {
            today: CACHED_TODAY,
            yesterday: day(1),
            day2: day(2),
            todayStart: t
        };
    }
    return CACHED_YESTERDAY;
}

function daysBetweenDates(fromStr, toStartDate) {
    const d = parseLocalDate(fromStr);
    if (!d || !toStartDate) return null;
    d.setHours(0, 0, 0, 0);
    return Math.round((toStartDate - d) / 86400000);
}

function parseCSVLine(line) {
    if (typeof PerfCache !== 'undefined') {
        const fast = PerfCache.parseCsvLineFast(line);
        if (fast) return fast;
    } else if (line.indexOf('"') === -1) {
        return line.split(',').map(x => x.trim());
    }
    const res = [];
    let f = '', q = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"' && (i === 0 || line[i - 1] !== '\\')) { q = !q; continue; }
        if (c === ',' && !q) { res.push(f.trim()); f = ''; } else f += c;
    }
    res.push(f.trim());
    return res;
}

function getDayOfWeek(ds) {
    if (typeof PerfCache !== 'undefined') return PerfCache.getDayOfWeekMemo(ds, DAYS_RU);
    return DAYS_RU[new Date(ds.split('.').reverse().join('-')).getDay()];
}
