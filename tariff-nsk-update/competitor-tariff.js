// Плавающая кнопка «Тариф НСК» больше не используется.
// Тарифы конкурента вводятся из «Запроса на понижение».
(function () {
    function removeLegacy() {
        var btn = document.getElementById('ct-float-btn');
        if (btn) btn.remove();
        var modal = document.getElementById('ct-modal');
        if (modal) modal.remove();
    }
    removeLegacy();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', removeLegacy);
})();
