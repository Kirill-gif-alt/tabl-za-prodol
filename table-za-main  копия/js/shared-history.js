// Резервные копии общих файлов (shared/_history): просмотр и восстановление. Только для админа.
// Копии делаются сами перед перезаписью файла (shared-storage.js и scripts/local-server.py).
window.SharedHistory = (function () {
    const LABELS = {
        'snapshot.json': 'Данные (снимок для всех ПК)',
        'profiles.json': 'Профили и права',
        'sales-management.json': 'Управление продажами (отметки)',
        'subsidy-overrides.json': 'Правки субсидий',
        'subsidy-fares.json': 'Справочник субсидированных тарифов',
        'pkz-nav.json': 'ПКЗ',
        'flight-comments.json': 'Комментарии к рейсам',
        'creative-layouts.json': 'Творческая (макеты)'
    };

    function esc(v) {
        return typeof escHtml === 'function' ? escHtml(v) : String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // «profiles__2026-10-08_09-15-02.json» → «08.10.2026 09:15»
    function versionLabel(id) {
        const m = /__(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})/.exec(id);
        return m ? `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}` : id;
    }

    function sizeLabel(bytes) {
        if (!bytes) return '';
        if (bytes >= 1048576) return (bytes / 1048576).toFixed(1).replace('.', ',') + ' МБ';
        return Math.max(1, Math.round(bytes / 1024)) + ' КБ';
    }

    function ensureModal() {
        let modal = document.getElementById('shared-history-modal');
        if (modal) return modal;
        modal = document.createElement('div');
        modal.id = 'shared-history-modal';
        modal.className = 'profile-admin-modal shared-history-modal';
        modal.innerHTML = `
            <div class="profile-admin-backdrop" data-sh-close></div>
            <div class="profile-admin-panel shared-history-panel">
                <div class="profile-admin-header">
                    <h3>Резервные копии общих файлов</h3>
                    <button type="button" class="profile-admin-close" data-sh-close>✕</button>
                </div>
                <div class="profile-admin-body">
                    <p class="shared-history-hint">Перед каждой перезаписью общего файла сохраняется его прошлая версия
                        (не чаще раза в 10 мин–6 ч, хранятся последние копии). Если загрузка или правка что-то испортила —
                        выберите версию и нажмите «Восстановить». Текущая версия при этом тоже уйдёт в копии.</p>
                    <div id="shared-history-list" class="shared-history-list">Загрузка…</div>
                </div>
            </div>`;
        document.body.appendChild(modal);
        modal.addEventListener('click', onClick);
        return modal;
    }

    async function render() {
        const box = document.getElementById('shared-history-list');
        if (!box) return;
        box.textContent = 'Загрузка…';
        const files = await SharedStorage.listHistory();
        if (!files) {
            box.innerHTML = '<p class="shared-history-empty">Нет доступа к общей папке. Подключите папку приложения.</p>';
            return;
        }
        box.innerHTML = SharedStorage.historyFiles().map(name => {
            const list = files[name] || [];
            const opts = list.map(v => `<option value="${esc(v.id)}">${esc(versionLabel(v.id))}${v.size ? ' · ' + esc(sizeLabel(v.size)) : ''}</option>`).join('');
            return `<div class="shared-history-row">
                <div class="shared-history-name">${esc(LABELS[name] || name)}<span class="shared-history-file">${esc(name)}</span></div>
                ${list.length
                    ? `<select class="shared-history-select" data-sh-file="${esc(name)}">${opts}</select>
                       <button type="button" class="btn-secondary" data-sh-restore="${esc(name)}">Восстановить</button>`
                    : '<span class="shared-history-empty">копий пока нет</span>'}
            </div>`;
        }).join('');
    }

    async function onClick(e) {
        if (e.target.closest('[data-sh-close]')) {
            close();
            return;
        }
        const btn = e.target.closest('[data-sh-restore]');
        if (!btn) return;
        const name = btn.dataset.shRestore;
        const sel = document.querySelector(`.shared-history-select[data-sh-file="${CSS.escape(name)}"]`);
        const id = sel ? sel.value : '';
        if (!id) return;
        if (!confirm(`Восстановить «${LABELS[name] || name}» на версию ${versionLabel(id)}?\nЭто увидят все пользователи.`)) return;
        btn.disabled = true;
        const res = await SharedStorage.restoreHistory(name, id);
        btn.disabled = false;
        if (!res.ok) {
            if (typeof showToast === 'function') showToast(res.error, 'error');
            return;
        }
        if (typeof ActivityLog !== 'undefined') ActivityLog.log('history_restore', `${name} → ${versionLabel(id)}`);
        if (typeof showToast === 'function') showToast('Версия восстановлена. Обновите страницу (F5), чтобы увидеть её.');
        render();
    }

    function open() {
        if (typeof ProfileAuth !== 'undefined' && !ProfileAuth.hasPermission('manage_profiles')) return;
        ensureModal().classList.add('open');
        render();
    }

    function close() {
        document.getElementById('shared-history-modal')?.classList.remove('open');
    }

    return { open, close, versionLabel };
})();
