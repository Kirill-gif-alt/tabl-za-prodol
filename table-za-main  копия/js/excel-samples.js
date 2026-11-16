// подсказки "Образец файла" рядом с кнопками, которые читают файл Excel
// образец: шапка и две строки; названия столбцов - те, что узнаёт разбор файла
// разметка: ExcelSamples.button(ключ) - кнопка-ссылка, ExcelSamples.box(ключ) - скрытый блок с таблицей, ExcelSamples.html(ключ) - оба сразу
window.ExcelSamples = (function () {
    // note - одна короткая строка над таблицей; lead - строка над шапкой (если файл так устроен);
    // sheets - несколько листов в одном файле (у каждого title, head, rows)
    const SAMPLES = {
        // Отчёты - Выгрузки - Себестоимость и субсидии, Расчёт расходов - Загрузить файл расходов (RouteCosts)
        costs: {
            note: 'Лист 1, шапка в 1-й строке, данные со 2-й. Суммы в тыс. ₽ за пару рейсов. Сводная таблица по месяцам тоже подходит.',
            head: ['Сцепка', 'Пункт отправления', 'Пункт назначения', 'Тип ВС', 'Субсидии', 'Наличие субсидии', 'Себестоимость'],
            rows: [
                ['KV-101/102', 'Красноярск', 'Абакан', 'ATR-72', 1250, 'да', 2840],
                ['KV-101/102', 'Красноярск', 'Абакан', 'ATR-72', 0, 'нет', 2840]
            ]
        },
        // Отчёты - Справочник - Загрузить из Excel (ReferenceView.importExcel): листы по названиям, шапка в 1-й строке
        reference: {
            note: 'Как выгрузка «В Excel»: листы «Тарифы», «Периоды», «Суммы», «ПКЗ», шапка в 1-й строке. Лишние листы можно не брать.',
            sheets: [
                {
                    title: 'Лист «Тарифы»',
                    head: ['Рейсы', 'Код тарифа', 'Предел, ₽', 'Детский предел, ₽', 'Комментарий'],
                    rows: [['KV-101, KV-102', 'KLHOW', 4500, 2300, ''], ['KV-103', 'VLHOW', 6200, '', '']]
                },
                {
                    title: 'Лист «Периоды»',
                    head: ['Рейс', 'Коммерция с', 'Коммерция по'],
                    rows: [['KV-101', '01.03.2026', '31.05.2026'], ['KV-103', '15.06.2026', '30.09.2026']]
                },
                {
                    title: 'Лист «Суммы»',
                    head: ['Город 1', 'Город 2', 'Тип ВС', 'Субсидия, тыс. ₽ (пара), среднее', 'Себестоимость, тыс. ₽ (пара), среднее'],
                    rows: [['Красноярск', 'Абакан', 'ATR-72', 1250, 2840], ['Красноярск', 'Кызыл', 'Ан-24', 980, 2310]]
                },
                {
                    title: 'Лист «ПКЗ»',
                    head: ['Период с', 'Период по', 'Направление (в одну сторону)', 'Тип ВС (пусто — любой)', 'ПКЗ, кг', 'Аэропорт Красноярска (KJA или KCY, пусто — любой)'],
                    rows: [['01.06.2026', '30.09.2026', 'Красноярск — Абакан', 'ATR-72', 4800, 'KJA'], ['01.06.2026', '30.09.2026', 'Абакан — Красноярск', '', 4600, '']]
                }
            ]
        },
        // Отчёты - Справочник - ПКЗ из NAV - Загрузить из NAV (SubsidyRef.navParseSheet)
        nav: {
            note: 'Выгрузка NAV, лист «Report». Тип ВС берётся из имени файла («ПКЗ АН24.xls»), для зимы в конце имени буква З.',
            head: ['ICAO_OR', 'ICAO_DS', 'PYLD', 'Дата корр'],
            rows: [['UNKL', 'UNAA', 5200, '12.03.2026'], ['UNAA', 'UNKL', 5000, '12.03.2026']]
        },
        // Отчёты - Справочник - Сетка тарифов - Загрузить сетку тарифов (FareGrid.parseWorkbook)
        grid: {
            note: 'Над шапкой строка с периодом. Тариф берётся из столбца через один после «КБТ».',
            lead: 'Период действия с 01.12.2026 по 31.03.2027',
            head: ['Маршрут', 'КБТ', 'УПТ', 'Тариф ВЗР'],
            rows: [['Красноярск-Абакан', 'VLHOW', '—', 3900], ['Красноярск-Абакан', 'KSTOW', '—', 4700]]
        }
    };

    let seq = 0;

    function esc(v) {
        return String(v == null ? '' : v).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    }

    function cell(v) {
        return typeof v === 'number' ? v.toLocaleString('ru-RU') : String(v == null ? '' : v);
    }

    function tableHtml(t) {
        const cols = t.head.length;
        return `<div class="xs-scroll"><table class="xs-table"><thead>`
            + (t.lead ? `<tr class="xs-lead"><td colspan="${cols}">${esc(t.lead)}</td></tr>` : '')
            + `<tr>${t.head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>`
            + t.rows.map(r => `<tr>${t.head.map((_, i) => `<td>${esc(cell(r[i]))}</td>`).join('')}</tr>`).join('')
            + `</tbody></table></div>`;
    }

    function button(key) {
        if (!SAMPLES[key]) return '';
        return `<button type="button" class="xs-link" data-xs-toggle="${esc(key)}" aria-expanded="false">Образец файла</button>`;
    }

    function box(key) {
        const s = SAMPLES[key];
        if (!s) return '';
        const tables = s.sheets || [s];
        return `<div class="xs-box" data-xs-box="${esc(key)}" id="xs-${esc(key)}-${++seq}" hidden>`
            + (s.note ? `<p class="xs-note">${esc(s.note)}</p>` : '')
            + tables.map(t => (t.title ? `<div class="xs-title">${esc(t.title)}</div>` : '') + tableHtml(t)).join('')
            + `</div>`;
    }

    function html(key) {
        return button(key) + box(key);
    }

    // данные образца как строки листа: для проверки разбора (sheets - по названию листа)
    function toAoa(key) {
        const s = SAMPLES[key];
        if (!s) return null;
        const one = (t) => (t.lead ? [[t.lead]] : []).concat([t.head], t.rows);
        if (s.sheets) {
            const out = {};
            s.sheets.forEach(t => { out[t.title.replace(/^Лист «|»$/g, '')] = one(t); });
            return out;
        }
        return one(s);
    }

    // один обработчик на все подсказки: ищем блок ближайшего родителя, где он есть
    document.addEventListener('click', (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('[data-xs-toggle]') : null;
        if (!btn) return;
        const key = btn.getAttribute('data-xs-toggle');
        let el = btn.parentElement;
        let target = null;
        while (el && !target) {
            target = [...el.querySelectorAll('[data-xs-box]')].find(b => b.getAttribute('data-xs-box') === key) || null;
            el = el.parentElement;
        }
        if (!target) return;
        const show = target.hidden;
        target.hidden = !show;
        btn.setAttribute('aria-expanded', show ? 'true' : 'false');
    });

    return { button, box, html, toAoa, keys: () => Object.keys(SAMPLES) };
})();
