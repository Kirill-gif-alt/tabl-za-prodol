// свой период: два поля дат "с ... по ..." рядом с 30 / 60 / 90 дн. и т.п.
// состояние по id запоминается в браузере; в полях ГГГГ-ММ-ДД, наружу дд.мм.гггг
window.CustomPeriod = (function () {
    const KEY = 'krasavia_cp_';
    const mem = {};

    function pad(n) { return String(n).padStart(2, '0'); }
    function iso(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
    function ru(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s || '') ? `${s.slice(8)}.${s.slice(5, 7)}.${s.slice(0, 4)}` : ''; }
    function dayNum(ruStr) {
        const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(ruStr || '');
        return m ? Math.round(Date.UTC(+m[3], +m[2] - 1, +m[1]) / 86400000) : null;
    }

    function state(id) {
        if (!mem[id]) {
            let v = null;
            try { v = JSON.parse(localStorage.getItem(KEY + id) || 'null'); } catch (e) { /* ignore */ }
            mem[id] = { on: !!(v && v.on), from: (v && v.from) || '', to: (v && v.to) || '' };
        }
        return mem[id];
    }
    function save(id) { try { localStorage.setItem(KEY + id, JSON.stringify(mem[id])); } catch (e) { /* ignore */ } }
    function set(id, patch) { Object.assign(state(id), patch); save(id); }

    // включить: пустые границы - последние 30 дней (окна вперёд: от сегодня на 30 дней)
    function toggle(id, forward) {
        const s = state(id);
        if (s.on) { set(id, { on: false }); return; }
        const t = new Date();
        const a = new Date(t.getFullYear(), t.getMonth(), t.getDate() + (forward ? 0 : -30));
        const b = new Date(t.getFullYear(), t.getMonth(), t.getDate() + (forward ? 30 : 0));
        set(id, { on: true, from: s.from || iso(a), to: s.to || iso(b) });
    }

    function buttonHtml(id) {
        return `<button type="button" class="filter-btn${state(id).on ? ' filter-btn-active' : ''}" data-cp-toggle="${id}">Свой период</button>`;
    }
    // поля "с ... по ..." только при своём периоде; onlyTo - окно вперёд, одно поле "по"
    function inputsHtml(id, onlyTo) {
        const s = state(id);
        if (!s.on) return '';
        return `<span class="cp-box">${onlyTo ? '' : `<label class="cp-lab">с <input type="date" class="cp-in" data-cp-id="${id}" data-cp-end="from" value="${s.from}"></label>`}<label class="cp-lab">по <input type="date" class="cp-in" data-cp-id="${id}" data-cp-end="to" value="${s.to}"></label></span>`;
    }
    // дата дд.мм.гггг входит в период? пустая граница - без ограничения
    function contains(id, dateStr) {
        const s = state(id);
        const d = dayNum(dateStr);
        if (d == null) return false;
        const a = dayNum(ru(s.from));
        const b = dayNum(ru(s.to));
        return (a == null || d >= a) && (b == null || d <= b);
    }
    function label(id) {
        const s = state(id);
        return `${ru(s.from) || '…'} – ${ru(s.to) || '…'}`;
    }
    // дней от сегодня до даты "по" (для окон вперёд), не меньше 1
    function aheadDays(id) {
        const t = new Date();
        const b = dayNum(ru(state(id).to));
        return b == null ? 30 : Math.max(1, b - Math.round(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()) / 86400000));
    }
    function sig(id) { const s = state(id); return s.on ? `${s.from}~${s.to}` : ''; }
    function on(id) { return state(id).on; }
    // Изменение поля даты: true, если событие наше.
    function handleChange(target) {
        if (!target || !target.dataset || !target.dataset.cpId) return false;
        set(target.dataset.cpId, { [target.dataset.cpEnd]: target.value });
        return true;
    }

    return { state, set, toggle, buttonHtml, inputsHtml, contains, label, aheadDays, sig, on, handleChange, ru };
})();
