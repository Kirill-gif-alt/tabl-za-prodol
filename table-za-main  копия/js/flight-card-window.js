// работает в отдельном окне карточки рейса (подключает flight-card.js)
// кнопки открыть вкладку и Сравнение моделей выводят основное окно вперёд; остальные обработчики в основной странице
document.addEventListener('click', function (event) {
    var t = event.target;
    t = t && t.closest && t.closest('[data-fc-tab],[data-fc=ml-window]');
    if (t && window.opener) {
        try { window.opener.focus(); } catch (e) { /* окно сайта закрыто */ }
    }
});
