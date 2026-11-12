// Выполняется в отдельном окне карточки рейса (подключает flight-card.js): нажатие «открыть вкладку» или
// «Сравнение моделей» выносит вперёд основное окно сайта. Остальные обработчики окна живут в основной странице.
document.addEventListener('click', function (event) {
    var t = event.target;
    t = t && t.closest && t.closest('[data-fc-tab],[data-fc=ml-window]');
    if (t && window.opener) {
        try { window.opener.focus(); } catch (e) { /* окно сайта закрыто */ }
    }
});
