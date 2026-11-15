// грузится в отдельное окно карточки рейса (flight-card.js): клик по "открыть вкладку" поднимает основное окно
document.addEventListener('click', function (event) {
    var t = event.target;
    t = t && t.closest && t.closest('[data-fc-tab],[data-fc=ml-window]');
    if (t && window.opener) {
        try { window.opener.focus(); } catch (e) { /* ignore */ }
    }
});
