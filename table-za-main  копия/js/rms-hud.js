// Плавающие виджеты RMS: сводка экрана и тревожная лента.
// Один блок #rms-hud, не двигает таблицу. Включение — ProfileAuth.screenWidgetsOn().

var RmsHud = (function () {
    var KEY = 'krasavia_rms_hud_ui';
    var ALERT_LIMIT = 12;
    var root = null;
    var timer = 0;
    var drag = null;
    var state = loadState();

    function loadState() {
        var base = { collapsed: false, dock: 'right', x: null, y: null, lf: 40, pickupZero: true, dtd: 7, routeType: 'all' };
        try {
            var raw = JSON.parse(localStorage.getItem(KEY) || 'null');
            if (!raw || typeof raw !== 'object') return base;
            if (raw.collapsed === true) base.collapsed = true;
            if (raw.dock === 'left' || raw.dock === 'right' || raw.dock === 'bottom' || raw.dock === '') base.dock = raw.dock;
            if (typeof raw.x === 'number') base.x = raw.x;
            if (typeof raw.y === 'number') base.y = raw.y;
            if (typeof raw.lf === 'number') base.lf = clamp(raw.lf, 0, 100);
            if (typeof raw.dtd === 'number') base.dtd = clamp(raw.dtd, 0, 60);
            if (raw.pickupZero === false) base.pickupZero = false;
            if (raw.routeType === 'krai' || raw.routeType === 'interregional' || raw.routeType === 'all') base.routeType = raw.routeType;
        } catch (e) { /* оставляем значения по умолчанию */ }
        return base;
    }

    function saveState() {
        try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
    }

    function clamp(n, min, max) {
        n = Math.round(n);
        if (n < min) return min;
        if (n > max) return max;
        return n;
    }

    function allowed() {
        return typeof ProfileAuth !== 'undefined'
            && typeof ProfileAuth.screenWidgetsOn === 'function'
            && ProfileAuth.screenWidgetsOn() === true;
    }

    var dockTopCache = 0;
    var dockTopPending = false;

    // Высота шапки: читаем размеры только в кадре отрисовки, а не посреди построения страницы —
    // иначе браузер пересчитывает раскладку всей страницы (на слабом ПК это секунды при входе).
    function dockTop() {
        if (!dockTopPending) {
            dockTopPending = true;
            window.requestAnimationFrame(function () {
                dockTopPending = false;
                var nav = document.querySelector('.top-nav');
                var next = nav ? Math.max(72, Math.round(nav.getBoundingClientRect().bottom + 8)) : 148;
                if (next === dockTopCache) return;
                dockTopCache = next;
                if (root && (state.dock === 'left' || state.dock === 'right')) root.style.top = next + 'px';
            });
        }
        return dockTopCache || 148;
    }

    function applyPlacement() {
        if (!root) return;
        root.classList.remove('dock-right', 'dock-left', 'dock-bottom');
        root.style.left = '';
        root.style.top = '';
        root.style.right = '';
        root.style.bottom = '';
        root.style.width = '';
        if (state.dock === 'left' || state.dock === 'right' || state.dock === 'bottom') {
            root.classList.add('dock-' + state.dock);
            if (state.dock !== 'bottom') root.style.top = dockTop() + 'px';
        } else if (typeof state.x === 'number' && typeof state.y === 'number') {
            root.style.left = state.x + 'px';
            root.style.top = state.y + 'px';
        } else {
            state.dock = 'right';
            root.classList.add('dock-right');
            root.style.top = dockTop() + 'px';
        }
        root.classList.toggle('is-collapsed', !!state.collapsed);
    }

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function mount() {
        if (root && root.isConnected) return;
        root = el('aside', 'rms-hud');
        root.id = 'rms-hud';
        root.setAttribute('role', 'complementary');
        root.setAttribute('aria-label', 'Виджеты экрана');

        var bar = el('div', 'rms-hud-bar');
        var collapseBtn = el('button', 'rms-hud-collapse', 'Сводка');
        collapseBtn.type = 'button';
        collapseBtn.id = 'rms-hud-collapse';
        collapseBtn.title = 'Свернуть или развернуть';
        var grip = el('span', 'rms-hud-grip', 'перетащить');
        var dockBtn = el('button', 'rms-hud-dock', 'Край');
        dockBtn.type = 'button';
        dockBtn.title = 'Справа, слева или снизу';
        bar.append(collapseBtn, grip, dockBtn);

        var body = el('div', 'rms-hud-body');

        var summarySec = el('section', 'rms-hud-sec');
        summarySec.appendChild(el('h3', 'rms-hud-title', 'Сводка экрана'));
        var summary = el('div', 'rms-hud-summary');
        summary.id = 'rms-hud-summary';
        summarySec.appendChild(summary);

        var alertSec = el('section', 'rms-hud-sec');
        alertSec.appendChild(el('h3', 'rms-hud-title', 'Тревожная лента'));

        var controls = el('div', 'rms-hud-controls');
        var typeLabel = el('label', 'rms-hud-field rms-hud-type', 'Тип рейса');
        var typeSel = el('select');
        typeSel.id = 'rms-hud-route-type';
        [
            ['all', 'Все'],
            ['krai', 'Краевые'],
            ['interregional', 'Межрегиональные']
        ].forEach(function (pair) {
            var opt = el('option', '', pair[1]);
            opt.value = pair[0];
            typeSel.appendChild(opt);
        });
        typeSel.value = state.routeType || 'all';
        typeLabel.appendChild(typeSel);

        var lfLabel = el('label', 'rms-hud-field', 'ЗПК ниже, %');
        var lfInput = el('input');
        lfInput.type = 'number';
        lfInput.id = 'rms-hud-lf';
        lfInput.min = '0';
        lfInput.max = '100';
        lfInput.step = '1';
        lfInput.value = String(state.lf);
        lfLabel.appendChild(lfInput);

        var dtdLabel = el('label', 'rms-hud-field', 'DTD не больше, дн.');
        var dtdInput = el('input');
        dtdInput.type = 'number';
        dtdInput.id = 'rms-hud-dtd';
        dtdInput.min = '0';
        dtdInput.max = '60';
        dtdInput.step = '1';
        dtdInput.value = String(state.dtd);
        dtdLabel.appendChild(dtdInput);

        var pickupLabel = el('label', 'rms-hud-check');
        var pickupInput = el('input');
        pickupInput.type = 'checkbox';
        pickupInput.id = 'rms-hud-pickup';
        pickupInput.checked = !!state.pickupZero;
        pickupLabel.append(pickupInput, document.createTextNode(' Pickup ровно 0'));

        controls.append(typeLabel, lfLabel, dtdLabel, pickupLabel);
        var hint = el('p', 'rms-hud-hint', '«—» в pickup — нет файла 14 дней, это не ноль.');
        var alerts = el('div', 'rms-hud-alerts');
        alerts.id = 'rms-hud-alerts';
        alertSec.append(controls, hint, alerts);
        body.append(summarySec, alertSec);
        root.append(bar, body);
        document.body.appendChild(root);

        collapseBtn.addEventListener('click', function () {
            state.collapsed = !state.collapsed;
            saveState();
            applyPlacement();
            paintCollapse();
        });
        dockBtn.addEventListener('click', function () {
            var order = ['right', 'left', 'bottom'];
            var i = order.indexOf(state.dock);
            state.dock = order[(i + 1) % order.length];
            state.x = null;
            state.y = null;
            saveState();
            applyPlacement();
        });
        typeSel.addEventListener('change', onThreshold);
        lfInput.addEventListener('input', onThreshold);
        dtdInput.addEventListener('input', onThreshold);
        lfInput.addEventListener('change', function () { onThreshold(true); });
        dtdInput.addEventListener('change', function () { onThreshold(true); });
        pickupInput.addEventListener('change', onThreshold);
        bar.addEventListener('pointerdown', onPointerDown);
        bar.addEventListener('pointermove', onPointerMove);
        bar.addEventListener('pointerup', onPointerUp);
        bar.addEventListener('pointercancel', onPointerUp);
        applyPlacement();
    }

    function onThreshold(forceClamp) {
        var lfEl = document.getElementById('rms-hud-lf');
        var dtdEl = document.getElementById('rms-hud-dtd');
        var pickupEl = document.getElementById('rms-hud-pickup');
        var typeEl = document.getElementById('rms-hud-route-type');
        if (!lfEl || !dtdEl || !pickupEl) return;
        var lf = parseInt(lfEl.value, 10);
        var dtd = parseInt(dtdEl.value, 10);
        if (!isNaN(lf)) state.lf = clamp(lf, 0, 100);
        if (!isNaN(dtd)) state.dtd = clamp(dtd, 0, 60);
        state.pickupZero = !!pickupEl.checked;
        if (typeEl && (typeEl.value === 'all' || typeEl.value === 'krai' || typeEl.value === 'interregional')) {
            state.routeType = typeEl.value;
        }
        if (forceClamp === true) {
            lfEl.value = String(state.lf);
            dtdEl.value = String(state.dtd);
        }
        saveState();
        refresh();
    }

    function onPointerDown(e) {
        if (!root || e.button !== 0) return;
        if (e.target.closest('button, input, label, select')) return;
        var rect = root.getBoundingClientRect();
        drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
        root.classList.add('is-dragging');
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        e.preventDefault();
    }

    function onPointerMove(e) {
        if (!drag || !root) return;
        var x = Math.round(e.clientX - drag.dx);
        var y = Math.round(e.clientY - drag.dy);
        var maxX = Math.max(8, window.innerWidth - 48);
        var maxY = Math.max(8, window.innerHeight - 36);
        x = Math.min(maxX, Math.max(-root.offsetWidth + 80, x));
        y = Math.min(maxY, Math.max(8, y));
        state.dock = '';
        state.x = x;
        state.y = y;
        root.classList.remove('dock-right', 'dock-left', 'dock-bottom');
        root.style.right = 'auto';
        root.style.bottom = 'auto';
        root.style.left = x + 'px';
        root.style.top = y + 'px';
    }

    function onPointerUp() {
        if (!drag) return;
        drag = null;
        if (root) root.classList.remove('is-dragging');
        saveState();
    }

    function attrEmpty(node, name) {
        if (!node || !node.hasAttribute(name)) return true;
        return !String(node.getAttribute(name) || '').trim();
    }

    function flightMissing(tr) {
        if (tr.classList.contains('rms-row')) return attrEmpty(tr, 'data-rms-orig');
        if (tr.hasAttribute('data-flight-code')) return attrEmpty(tr, 'data-flight-code');
        if (tr.hasAttribute('data-outbound')) return attrEmpty(tr, 'data-outbound');
        return true;
    }

    function dateMissing(tr) {
        if (tr.classList.contains('rms-row')) return attrEmpty(tr, 'data-rms-date');
        return attrEmpty(tr, 'data-date');
    }

    function zpkMissing(tr) {
        var text = tr.textContent || '';
        if (tr.classList.contains('rms-row')) {
            var cell = tr.querySelector('.rms-col-load');
            return !cell || (cell.textContent || '').indexOf('%') < 0;
        }
        if (tr.hasAttribute('data-flight-code')) {
            if (text.indexOf('%') >= 0) return false;
            if (tr.querySelector('.occupancy-high, .occupancy-med, .closed-text, .flew-text')) return false;
            return true;
        }
        if (tr.hasAttribute('data-outbound')) {
            if (text.indexOf('%') >= 0) return false;
            if (tr.querySelector('.closed-text, .flew-text')) return false;
            if (tr.classList.contains('flew-flight') || tr.classList.contains('closed-flight') || tr.classList.contains('data-row-both-closed')) return false;
            return true;
        }
        return false;
    }

    function screenRows() {
        var host = document.getElementById('main-content-inner');
        if (!host) return [];
        return Array.prototype.slice.call(host.querySelectorAll('tr.rms-row, tr[data-date][data-flight-code], tr[data-outbound][data-date]'));
    }

    function readFlights() {
        try {
            var list = null;
            if (typeof getAllUpcomingFlights === 'function') {
                var days = 30;
                var daysEl = document.getElementById('rms-days-filter');
                if (daysEl && daysEl.value) {
                    var parsed = parseInt(daysEl.value, 10);
                    if (!isNaN(parsed)) days = parsed;
                }
                list = getAllUpcomingFlights(days);
                var alertEl = document.getElementById('rms-alert-filter');
                if (alertEl && alertEl.value === 'alerts' && Array.isArray(list)) {
                    list = list.filter(function (f) { return f.alertLevel >= 2; });
                }
                if (typeof applyRmsConditions === 'function' && Array.isArray(list)) list = applyRmsConditions(list);
            } else if (typeof getRmsFilteredFlights === 'function') {
                list = getRmsFilteredFlights();
            }
            if (!Array.isArray(list)) return null;
            if (state.routeType && state.routeType !== 'all') {
                list = list.filter(function (f) {
                    var code = f.orig || f.base;
                    if (typeof flightMatchesRouteTypeFilter === 'function') return flightMatchesRouteTypeFilter(code, state.routeType);
                    if (typeof getFlightRouteType === 'function') return getFlightRouteType(code) === state.routeType;
                    return true;
                });
            }
            return list;
        } catch (e) {
            return null;
        }
    }

    function routeTypeCaption() {
        if (state.routeType === 'krai') return 'краевые';
        if (state.routeType === 'interregional') return 'межрегиональные';
        return '';
    }

    function renderedIndex(orig, date) {
        if (typeof getRmsFilteredFlights !== 'function') return -1;
        try {
            var list = getRmsFilteredFlights();
            if (!Array.isArray(list)) return -1;
            for (var i = 0; i < list.length; i++) {
                var item = list[i];
                if (String(item.orig || item.base || '') === orig && String(item.date || '') === date) return i;
            }
        } catch (e) { /* строка останется без прокрутки */ }
        return -1;
    }

    function alertReasons(f) {
        var reasons = [];
        if (f.pct != null && f.pct !== '' && Number(f.pct) < state.lf) reasons.push('ЗПК ' + f.pct + '%');
        if (state.pickupZero && f.pickup === 0) reasons.push('Pickup 0');
        if (f.dtd != null && f.dtd !== '' && Number(f.dtd) >= 0 && Number(f.dtd) <= state.dtd) reasons.push('DTD ' + f.dtd);
        return reasons;
    }

    function line(parent, text) {
        var p = el('p', 'rms-hud-line', text);
        parent.appendChild(p);
    }

    function paintSummary() {
        var box = document.getElementById('rms-hud-summary');
        if (!box) return;
        box.replaceChildren();
        var today = typeof getTodayDate === 'function' ? getTodayDate() : '—';
        line(box, 'Дата: ' + today);
        var rows = screenRows();
        line(box, 'Строк на экране: ' + rows.length);
        var gaps = 0;
        rows.forEach(function (tr) {
            if (flightMissing(tr) || dateMissing(tr) || zpkMissing(tr)) gaps++;
        });
        line(box, 'Без рейса, даты или ЗПК: ' + gaps);
        var flights = readFlights();
        if (flights) {
            var caption = routeTypeCaption();
            line(box, 'В выборке RMS: ' + flights.length + (caption ? ', ' + caption : ''));
        } else line(box, 'В выборке RMS: нет данных');
        if (!rows.length) line(box, 'На экране нет строк рейсов');
    }

    function paintAlerts() {
        var box = document.getElementById('rms-hud-alerts');
        if (!box) return;
        box.replaceChildren();
        var flights = readFlights();
        if (!flights) {
            box.appendChild(el('p', 'rms-hud-empty', 'Нет данных загрузки'));
            paintCollapse(0);
            return;
        }
        var hits = [];
        flights.forEach(function (f) {
            var reasons = alertReasons(f);
            if (!reasons.length) return;
            hits.push({ flight: f, reasons: reasons, dtd: f.dtd, pct: f.pct });
        });
        hits.sort(function (a, b) {
            var da = a.dtd == null || a.dtd === '' ? 9999 : Number(a.dtd);
            var db = b.dtd == null || b.dtd === '' ? 9999 : Number(b.dtd);
            if (da !== db) return da - db;
            var pa = a.pct == null || a.pct === '' ? 9999 : Number(a.pct);
            var pb = b.pct == null || b.pct === '' ? 9999 : Number(b.pct);
            return pa - pb;
        });
        paintCollapse(hits.length);
        if (!flights.length) {
            box.appendChild(el('p', 'rms-hud-empty', state.routeType && state.routeType !== 'all' ? 'Нет рейсов этого типа' : 'Нет рейсов в выборке'));
            return;
        }
        if (!hits.length) {
            box.appendChild(el('p', 'rms-hud-empty', 'По этим порогам тревог нет'));
            return;
        }
        var ul = el('ul', 'rms-hud-list');
        hits.slice(0, ALERT_LIMIT).forEach(function (hit) {
            var code = String(hit.flight.orig || hit.flight.base || 'рейс');
            var date = String(hit.flight.date || '—');
            var btn = el('button', 'rms-hud-alert', code + '  ' + date + ' · ' + hit.reasons.join(' · '));
            btn.type = 'button';
            btn.title = 'Показать рейс в RMS';
            btn.addEventListener('click', function () { focusFlight(hit.flight); });
            var li = el('li');
            li.appendChild(btn);
            ul.appendChild(li);
        });
        box.appendChild(ul);
        if (hits.length > ALERT_LIMIT) {
            box.appendChild(el('p', 'rms-hud-more', 'Ещё ' + (hits.length - ALERT_LIMIT) + '. Сузьте порог или откройте RMS.'));
        }
    }

    function paintCollapse(count) {
        var btn = document.getElementById('rms-hud-collapse');
        if (!btn) return;
        if (count == null) {
            var flights = readFlights();
            count = 0;
            if (flights) flights.forEach(function (f) { if (alertReasons(f).length) count++; });
        }
        btn.textContent = state.collapsed
            ? ('Сводка' + (count ? ' · ' + count : '') + ' — развернуть')
            : 'Свернуть';
        btn.setAttribute('aria-expanded', state.collapsed ? 'false' : 'true');
    }

    function findRmsRow(orig, date) {
        var rows = document.querySelectorAll('tr.rms-row');
        for (var i = 0; i < rows.length; i++) {
            if (rows[i].getAttribute('data-rms-orig') === orig && rows[i].getAttribute('data-rms-date') === date) return rows[i];
        }
        return null;
    }

    function flashRow(row) {
        if (!row) return;
        row.classList.add('rms-hud-flash');
        window.setTimeout(function () { row.classList.remove('rms-hud-flash'); }, 1600);
    }

    function focusFlight(f) {
        var orig = String(f.orig || f.base || '');
        var date = String(f.date || '');
        if (typeof currentTab !== 'undefined' && currentTab !== 'rms' && typeof switchMainTab === 'function') {
            if (typeof ProfileAuth !== 'undefined' && typeof ProfileAuth.canAccessTab === 'function' && !ProfileAuth.canAccessTab('rms')) {
                if (typeof showToast === 'function') showToast('Вкладка RMS недоступна для вашего профиля', 'error');
                return;
            }
            switchMainTab('rms');
        }
        var row = findRmsRow(orig, date);
        if (!row) {
            var idx = renderedIndex(orig, date);
            if (idx < 0) {
                var sel = document.getElementById('rms-route-type-filter');
                var nextType = state.routeType && state.routeType !== 'all' ? state.routeType : 'all';
                if (sel && sel.value !== nextType) {
                    sel.value = nextType;
                    if (typeof renderRmsWatchlist === 'function') renderRmsWatchlist();
                    idx = renderedIndex(orig, date);
                }
            }
            var sc = document.getElementById('rms-watchlist');
            if (sc && idx >= 0) sc.scrollTop = idx * 48;
            window.requestAnimationFrame(function () {
                window.requestAnimationFrame(function () { flashRow(findRmsRow(orig, date)); });
            });
            return;
        }
        flashRow(row);
    }

    function refresh() {
        if (!root || !root.isConnected) return;
        paintSummary();
        paintAlerts();
    }

    function ensureTimer() {
        if (timer || document.hidden) return;
        timer = window.setInterval(refresh, 2000);
    }

    function stopTimer() {
        if (!timer) return;
        window.clearInterval(timer);
        timer = 0;
    }

    function teardown() {
        stopTimer();
        drag = null;
        if (root) {
            root.remove();
            root = null;
        }
    }

    function sync() {
        if (!allowed()) {
            teardown();
            return;
        }
        mount();
        applyPlacement();
        refresh();
        ensureTimer();
    }

    document.addEventListener('visibilitychange', function () {
        if (!root) return;
        if (document.hidden) stopTimer();
        else {
            refresh();
            ensureTimer();
        }
    });

    window.addEventListener('resize', function () {
        if (!root) return;
        if (state.dock === 'left' || state.dock === 'right') root.style.top = dockTop() + 'px';
    });

    return { sync: sync };
})();

var rmsWidgetPublishTimer = 0;

function rmsWidgetCount(value) {
    if (value == null || value === '') return null;
    var n = Number(value);
    if (!isFinite(n)) return null;
    return Math.round(n);
}

function publishRmsWidgetSnapshot() {
    window.clearTimeout(rmsWidgetPublishTimer);
    rmsWidgetPublishTimer = window.setTimeout(writeRmsWidgetSnapshot, 1500);
}

function writeRmsWidgetSnapshot() {
    if (typeof getAllUpcomingFlights !== 'function') return;
    if (typeof SharedStorage === 'undefined' || typeof SharedStorage.writeJsonFile !== 'function') return;
    var grouped = typeof groupedData !== 'undefined' ? groupedData : null;
    if (!grouped || !Object.keys(grouped).length) return;
    var list;
    try { list = getAllUpcomingFlights(90); } catch (e) { return; }
    if (!Array.isArray(list)) return;
    var flights = [];
    for (var i = 0; i < list.length; i++) {
        var f = list[i];
        var code = String(f.orig || f.base || '');
        if (!code || !f.date) continue;
        var routeType = 'unknown';
        if (typeof getFlightRouteType === 'function') {
            try { routeType = getFlightRouteType(code) || 'unknown'; } catch (err) { routeType = 'unknown'; }
        }
        flights.push({
            code: code,
            date: String(f.date),
            pct: (f.pct == null || f.pct === '') ? null : Number(f.pct),
            pickup: (f.pickup == null || f.pickup === '') ? null : Number(f.pickup),
            load: rmsWidgetCount(f.free),
            expected: rmsWidgetCount(f.evR),
            route: f.route ? String(f.route) : '',
            routeType: routeType,
            remainder: (f.remainder == null || f.remainder === '') ? null : Number(f.remainder)
        });
    }
    SharedStorage.writeJsonFile('rms-widget.json', {
        version: 1,
        updatedAt: new Date().toISOString(),
        flights: flights
    }).catch(function () { /* папка приложения не подключена */ });
}

window.setInterval(function () {
    if (typeof groupedData === 'undefined' || !Object.keys(groupedData || {}).length) return;
    publishRmsWidgetSnapshot();
}, 5 * 60 * 1000);
