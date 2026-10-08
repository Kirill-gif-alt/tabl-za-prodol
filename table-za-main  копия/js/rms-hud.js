// Данные для отдельного окна виджета (Start-Widget.cmd): после загрузки рейсов сайт пишет
// shared/rms-widget.json. Плавающая панель на странице («Сводка экрана», «Тревожная лента») удалена.

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
