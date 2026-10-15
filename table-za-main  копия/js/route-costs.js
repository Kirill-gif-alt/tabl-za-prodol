// Расходы + периоды субсидии (папка «Расходы»)
// Себестоимость на направление = столбец «Себестоимость» / 2 * 1000
// Периоды 1–3 в «Период субсидии» = коммерция (без субсидии)

// Справочник субсидий в приложении (subsidy-ref.js) важнее файлов: costRows/periodsByNum ниже —
// уже итог «файл + справочник», а данные самих файлов лежат в fileCostRows/filePeriods.

window.RouteCosts = (function () {
    let costRows = [];
    let costIndex = Object.create(null);
    let periodsByNum = {};
    let fileCostRows = [];
    let filePeriods = {};
    let refPeriods = {};
    let refAmounts = {};

    function parseNumber(val) {
        if (val == null || val === '') return null;
        if (typeof val === 'number' && !isNaN(val)) return val;
        const s = String(val).trim().replace(/\s/g, '').replace(',', '.');
        const n = parseFloat(s);
        return isNaN(n) ? null : n;
    }

    function cityKey(name) {
        return String(name || '')
            .toLowerCase()
            .replace(/ё/g, 'е')
            .replace(/[^a-zа-я0-9]/gi, '');
    }

    function acKey(name) {
        const s = String(name || '').toUpperCase()
            .replace(/Ё/g, 'Е')
            .replace(/АТР/g, 'ATR')
            .replace(/ЯК/g, 'YK')
            .replace(/АН/g, 'AN');
        if (/ATR[\s-]*72|AT7/.test(s)) return 'atr72';
        if (/ATR[\s-]*42|AT5/.test(s)) return 'atr42';
        if (/AN[\s-]*26/.test(s)) return 'an26';
        if (/AN[\s-]*24/.test(s)) return 'an24';
        if (/YK[\s-]*42/.test(s)) return 'yak42';
        if (/L[\s-]*410|Л[\s-]*410/.test(s)) return 'l410';
        return s.replace(/[^A-Z0-9]/g, '').toLowerCase() || '';
    }

    function flagKey(val) {
        const s = String(val || '').trim().toLowerCase();
        if (s === 'да' || s === 'yes' || s === '1' || s === 'true') return 'да';
        return 'нет';
    }

    function pad2(n) {
        return String(n).padStart(2, '0');
    }

    function ruFromYmd(y, m, d) {
        if (!y || !m || !d) return '';
        return `${pad2(d)}.${pad2(m)}.${y}`;
    }

    /** Календарный ключ YYYYMMDD — без часовых поясов, границы периодов включительно */
    function dateKey(ru) {
        const p = String(ru || '').trim().split(/[./-]/);
        if (p.length !== 3) return 0;
        let y = parseInt(p[2], 10);
        const mo = parseInt(p[1], 10);
        const d = parseInt(p[0], 10);
        if (y < 100) y += 2000;
        if (!y || !mo || !d) return 0;
        return y * 10000 + mo * 100 + d;
    }

    /** Excel serial / OADate → ДД.ММ.ГГГГ без сдвига на сутки */
    function excelSerialToRu(serial) {
        const n = Math.floor(Number(serial));
        if (!isFinite(n) || n < 60) return '';
        const utcMs = Date.UTC(1970, 0, 1) + Math.round((n - 25569) * 86400000);
        const d = new Date(utcMs);
        return ruFromYmd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }

    function ruDateFromCell(val) {
        if (val == null || val === '') return '';
        if (typeof val === 'number' && isFinite(val) && val > 59) {
            const ru = excelSerialToRu(val);
            if (ru) return ru;
        }
        const s = String(val).trim();
        const m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
        if (m) {
            const y = m[3].length === 2 ? `20${m[3]}` : m[3];
            return ruFromYmd(+y, +m[2], +m[1]);
        }
        if (val instanceof Date && !isNaN(val.getTime())) {
            return ruFromYmd(val.getFullYear(), val.getMonth() + 1, val.getDate());
        }
        return '';
    }

    function headerIndex(headerRow, aliases, preferLast = false) {
        const cells = (headerRow || []).map(h => String(h || '').toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim());
        let found = -1;
        for (const alias of aliases) {
            for (let i = 0; i < cells.length; i++) {
                if (cells[i].includes(alias)) {
                    found = i;
                    if (!preferLast) return i;
                }
            }
            if (found >= 0 && !preferLast) return found;
        }
        return found;
    }

    function parseCostsSheet(json) {
        if (!json || json.length < 2) return [];
        if (isPivotSheet(json)) return parsePivotSheet(json);
        const head = json[0];
        const iScepka = headerIndex(head, ['сцепка']);
        const iFrom = headerIndex(head, ['пункт отправления'], true);
        const iTo = headerIndex(head, ['пункт назначения'], true);
        const iAc = headerIndex(head, ['тип вс'], true);
        const iFlag = headerIndex(head, ['наличие субсидии'], true);
        const iCost = headerIndex(head, ['себестоимость'], true);
        const iSub = (() => {
            const cells = (head || []).map(h => String(h || '').toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim());
            let idx = -1;
            cells.forEach((h, i) => {
                if (h === 'субсидии' || h === 'субсидия') idx = i;
            });
            return idx;
        })();

        const rows = [];
        for (let r = 1; r < json.length; r++) {
            const row = json[r];
            if (!row) continue;
            const scepka = String(row[iScepka >= 0 ? iScepka : 4] || '').trim();
            const from = String(row[iFrom >= 0 ? iFrom : 5] || '').trim();
            const to = String(row[iTo >= 0 ? iTo : 6] || '').trim();
            const ac = String(row[iAc >= 0 ? iAc : 7] || '').trim();
            const flag = flagKey(row[iFlag >= 0 ? iFlag : 12]);
            const costPair = parseNumber(row[iCost >= 0 ? iCost : 13]);
            const subsidyAmt = parseNumber(row[iSub >= 0 ? iSub : 10]) || 0;
            if (!from || !to || !ac || costPair == null) continue;
            const rec = {
                scepka,
                from,
                to,
                ac,
                flag,
                costPair,
                subsidyAmt,
                fromKey: cityKey(from),
                toKey: cityKey(to),
                acK: acKey(ac)
            };
            rows.push(rec);
        }
        return rows;
    }

    // Краевой маршрут — оба конца в крае (или хаб). Межрегиональные и международные — как в файле.
    function isKraiPair(from, to) {
        const cities = [from, to].filter(c => !(typeof isHubCity === 'function' && isHubCity(c)));
        if (!cities.length || typeof isKraiCity !== 'function') return false;
        const inter = (c) => (typeof isInterregionalCity === 'function' && isInterregionalCity(c))
            || (typeof isInternationalCity === 'function' && isInternationalCity(c));
        return cities.every(c => isKraiCity(c) && !inter(c));
    }

    // Сводная таблица по месяцам: «Названия строк | Тип ВС | 6 | 6 | 7 | 7 | 8 | 8», во второй строке —
    // «Максимум по полю Субсидии» / «Среднее по полю Себестоимость рейса». Маршрут «Красноярск-Абакан-Красноярск»,
    // суммы — тыс. ₽ на рейс туда-обратно (как в прежнем файле). Месяцев сколько угодно, на сайт — последние три.
    function isPivotSheet(json) {
        const r0 = (json && json[0]) || [];
        const r1 = (json && json[1]) || [];
        return /названия строк/i.test(String(r0[0] || '')) || r1.some(c => /по полю/i.test(String(c || '')));
    }

    // «Красноярск-Горно-алтайск-Красноярск» → [Красноярск, Горно-алтайск]: город отправления — то, чем название
    // начинается и заканчивается (в названиях городов бывает свой дефис), назначение — между ними.
    function splitRoute(name) {
        const n = String(name || '').replace(/\s*-\s*/g, '-').trim();
        const idx = [];
        for (let i = 0; i < n.length; i++) if (n[i] === '-') idx.push(i);
        for (const i of idx) {
            const a = n.slice(0, i);
            if (n.length > 2 * a.length + 2 && n.endsWith('-' + a)) {
                const mid = n.slice(i + 1, n.length - a.length - 1);
                if (mid) return [a, mid];
            }
        }
        // Без возврата в начало: «А-Б» — первый и последний участок.
        if (idx.length) return [n.slice(0, idx[0]), n.slice(idx[idx.length - 1] + 1)];
        return null;
    }

    // Субсидия направления одна на все месяцы: есть хотя бы в одном месяце — во всех (наибольшая из месяцев).
    function evenSubsidy(byMonth, krai) {
        const vals = Object.values(byMonth);
        const top = krai ? 0 : vals.reduce((a, v) => Math.max(a, v.sub || 0), 0);
        vals.forEach(v => { v.sub = top; });
        return top;
    }

    function parsePivotSheet(json) {
        const r0 = json[0] || [];
        const r1 = json[1] || [];
        const iAc = r0.findIndex(c => /тип\s*вс/i.test(String(c || '')));
        const cols = {};
        for (let i = 0; i < r1.length; i++) {
            const m = parseInt(String(r0[i] == null ? '' : r0[i]).replace(/[^0-9]/g, ''), 10);
            if (!(m >= 1 && m <= 12)) continue;
            const h = String(r1[i] || '').toLowerCase();
            const c = cols[m] || (cols[m] = {});
            if (h.includes('себестоим')) c.cost = i;
            else if (h.includes('субсид')) c.sub = i;
            else if (h.includes('рейс') || h.includes('кол-во') || h.includes('количество')) c.n = i;
        }
        let months = Object.keys(cols).map(Number).filter(m => cols[m].cost != null);
        // Порядок месяцев — как в файле; через новый год (11, 12, 1) идёт по порядку столбцов.
        months.sort((a, b) => cols[a].cost - cols[b].cost);
        months = months.slice(-3);
        const rows = [];
        for (let r = 2; r < json.length; r++) {
            const row = json[r];
            if (!row) continue;
            const name = String(row[0] || '').trim();
            const ac = String(row[iAc >= 0 ? iAc : 1] || '').trim();
            if (!ac || /итог/i.test(name)) continue;
            const ends = splitRoute(name);
            if (!ends) continue;
            const [from, to] = ends;
            const krai = isKraiPair(from, to);
            const byMonth = {};
            months.forEach(m => {
                const cost = parseNumber(row[cols[m].cost]);
                if (cost == null) return;
                const sub = cols[m].sub != null ? parseNumber(row[cols[m].sub]) : null;
                const n = cols[m].n != null ? parseNumber(row[cols[m].n]) : null;
                byMonth[m] = { cost, sub: krai ? 0 : (sub || 0) };
                if (n != null) byMonth[m].n = Math.round(n);
            });
            const have = months.filter(m => byMonth[m]);
            if (!have.length) continue;
            evenSubsidy(byMonth, krai);
            const avg = (k) => have.reduce((a, m) => a + byMonth[m][k], 0) / have.length;
            const base = { scepka: '', from, to, ac, fromKey: cityKey(from), toKey: cityKey(to), acK: acKey(ac), krai, months, byMonth };
            // Всегда два варианта: с субсидией и без. Себестоимость одна и та же, без субсидии — субсидия 0.
            rows.push({ ...base, flag: 'да', costPair: avg('cost'), subsidyAmt: krai ? 0 : avg('sub') });
            rows.push({ ...base, flag: 'нет', costPair: avg('cost'), subsidyAmt: 0 });
        }
        return rows;
    }

    function rebuildCostIndex() {
        costIndex = Object.create(null);
        costRows.forEach((r) => {
            const a = `${r.fromKey}|${r.toKey}|${r.acK}|${r.flag}`;
            const b = `${r.toKey}|${r.fromKey}|${r.acK}|${r.flag}`;
            costIndex[a] = r;
            costIndex[b] = r;
        });
    }

    function periodColPairs(headerRow) {
        const cells = (headerRow || []).map(h => String(h || '').toLowerCase().replace(/\s+/g, ' ').trim());
        const pairs = [];
        for (let n = 1; n <= 3; n++) {
            const token = 'период ' + n;
            const iStart = cells.findIndex(h => h.includes('начал') && h.includes(token));
            const iEnd = cells.findIndex(h => (h.includes('конец') || h.includes('конца')) && h.includes(token));
            if (iStart >= 0 && iEnd >= 0) pairs.push([iStart, iEnd]);
            else pairs.push([n * 2 - 1, n * 2]); // B–C / D–E / F–G
        }
        return pairs;
    }

    function parsePeriodsSheet(json) {
        const map = {};
        if (!json || !json.length) return map;
        let start = 0;
        const head0 = String(json[0]?.[0] || '').toLowerCase();
        if (head0.includes('рейс') || head0.includes('период')) start = 1;
        const pairs = periodColPairs(json[0] || []);

        for (let r = start; r < json.length; r++) {
            const row = json[r];
            if (!row) continue;
            const num = parseInt(String(row[0] || '').replace(/[^0-9]/g, ''), 10);
            if (!num) continue;
            const ranges = [];
            pairs.forEach(([iA, iB]) => {
                const a = ruDateFromCell(row[iA]);
                const b = ruDateFromCell(row[iB]);
                if (!a || !b) return;
                const k0 = dateKey(a);
                const k1 = dateKey(b);
                if (!k0 || !k1) return;
                ranges.push({ from: a, to: b, k0: Math.min(k0, k1), k1: Math.max(k0, k1) });
            });
            if (ranges.length) map[num] = ranges;
        }
        return map;
    }

    async function readXlsxJson(file) {
        if (!file) return null;
        const XLSX = await loadPlainXlsx();
        if (!XLSX) return null;
        const buf = await file.arrayBuffer();
        // cellDates:false — сырые серийники Excel, без сдвига часового пояса
        const wb = XLSX.read(buf, { type: 'array', cellDates: false });
        const sh = wb.Sheets[wb.SheetNames[0]];
        return XLSX.utils.sheet_to_json(sh, { header: 1, raw: true, defval: '' });
    }

    function rangeOf(r) {
        const k0 = dateKey(r.from);
        const k1 = dateKey(r.to);
        return { from: r.from, to: r.to, k0: Math.min(k0, k1), k1: Math.max(k0, k1) };
    }

    function routePairKey(fromKey, toKey, acK) {
        return (fromKey < toKey ? `${fromKey}|${toKey}` : `${toKey}|${fromKey}`) + '|' + acK;
    }

    // Итог: данные файлов, поверх — записи справочника (по номеру рейса и по маршруту+типу ВС).
    function rebuild() {
        const periods = { ...filePeriods };
        Object.keys(refPeriods).forEach(n => {
            periods[n] = (refPeriods[n].ranges || []).map(rangeOf).filter(r => r.k0 && r.k1);
        });
        periodsByNum = periods;
        const refKeys = new Set(Object.keys(refAmounts));
        const fileByKey = {};
        fileCostRows.forEach(r => { fileByKey[routePairKey(r.fromKey, r.toKey, r.acK) + '|' + r.flag] = r; });
        // Справочник главнее файлов. Файл по месяцам при загрузке сам записывается в справочник (pivotEntries):
        // субсидия межрегионального направления, которой нет в файле ни в одном месяце, берётся из справочника.
        const subFromRef = (r) => {
            const e = refAmounts[routePairKey(r.fromKey, r.toKey, r.acK)];
            return e && e.subsidy > 0 ? e.subsidy : 0;
        };
        const rows = fileCostRows.filter(r => !refKeys.has(routePairKey(r.fromKey, r.toKey, r.acK))).map(r => {
            if (!r.byMonth || r.flag !== 'да' || r.krai) return r;
            const hasSub = r.months.some(m => r.byMonth[m] && r.byMonth[m].sub > 0);
            const ref = hasSub ? 0 : subFromRef(r);
            if (!ref) return r;
            const byMonth = {};
            Object.keys(r.byMonth).forEach(m => { byMonth[m] = { ...r.byMonth[m], sub: ref }; });
            return { ...r, byMonth, subsidyAmt: ref, subRef: true };
        });
        Object.keys(refAmounts).forEach(key => {
            let e0 = refAmounts[key];
            // Запись справочника одним числом, а в файле маршрут по месяцам: число справочника — во все месяцы
            // (пустое поле — значение месяца из файла).
            const fp = !e0.byMonth && (fileByKey[key + '|да'] || fileByKey[key + '|нет']);
            if (fp && fp.byMonth) {
                const byMonth = {};
                Object.keys(fp.byMonth).forEach(m => {
                    byMonth[m] = { n: fp.byMonth[m].n, cost: e0.cost != null ? e0.cost : fp.byMonth[m].cost, sub: e0.subsidy != null ? e0.subsidy : (fileByKey[key + '|да'] ? fileByKey[key + '|да'].byMonth[m].sub : 0) };
                });
                e0 = { ...e0, months: fp.months, byMonth, krai: fp.krai };
            }
            if (e0.byMonth) {
                const krai = !!e0.krai;
                const months = e0.months;
                const have = months.filter(m => e0.byMonth[m]);
                if (!have.length) return;
                const avg = (k) => have.reduce((a, m) => a + e0.byMonth[m][k], 0) / have.length;
                const byMonth = {};
                have.forEach(m => { byMonth[m] = { cost: e0.byMonth[m].cost, sub: krai ? 0 : e0.byMonth[m].sub, n: e0.byMonth[m].n }; });
                evenSubsidy(byMonth, krai);
                const base = { scepka: '', from: e0.from, to: e0.to, ac: e0.ac, fromKey: cityKey(e0.from), toKey: cityKey(e0.to), acK: acKey(e0.ac), fromRef: true, krai, months, byMonth };
                rows.push({ ...base, flag: 'да', costPair: avg('cost'), subsidyAmt: krai ? 0 : avg('sub') });
                rows.push({ ...base, flag: 'нет', costPair: avg('cost'), subsidyAmt: 0 });
                return;
            }
            const e = refAmounts[key];
            const base = { from: e.from, to: e.to, ac: e.ac, fromKey: cityKey(e.from), toKey: cityKey(e.to), acK: acKey(e.ac), fromRef: true };
            const fm = fileByKey[key + '|да'] || fileByKey[key + '|нет'];
            if (fm && fm.byMonth) { base.months = fm.months; base.byMonth = fm.byMonth; base.krai = fm.krai; }
            const fDa = fileByKey[key + '|да'];
            const fNet = fileByKey[key + '|нет'];
            // Себестоимость одна — и в субсидированные, и в коммерческие даты.
            rows.push({ ...base, scepka: '', flag: 'да', costPair: e.cost != null ? e.cost : (fDa ? fDa.costPair : (fNet ? fNet.costPair : null)), subsidyAmt: e.subsidy != null ? e.subsidy : (fDa ? fDa.subsidyAmt : 0) });
            rows.push({ ...base, scepka: '', flag: 'нет', costPair: e.cost != null ? e.cost : (fNet ? fNet.costPair : (fDa ? fDa.costPair : null)), subsidyAmt: 0 });
        });
        costRows = rows;
        rebuildCostIndex();
        if (typeof dataLoadStatus !== 'undefined') {
            dataLoadStatus.costs = costRows.length > 0;
            dataLoadStatus.subsidy = Object.keys(periodsByNum).length > 0;
        }
    }

    function applyRef(periods, amounts) {
        refPeriods = periods || {};
        refAmounts = amounts || {};
        rebuild();
    }

    async function loadFiles(expensesFile, periodsFile) {
        if (expensesFile) {
            const json = await readXlsxJson(expensesFile);
            fileCostRows = parseCostsSheet(json || []);
        }
        if (periodsFile) {
            const json = await readXlsxJson(periodsFile);
            filePeriods = parsePeriodsSheet(json || []);
        }
        rebuild();
        return { costs: fileCostRows.length, periods: Object.keys(filePeriods).length };
    }

    function applySnapshot(snap) {
        if (snap && Array.isArray(snap.costRows)) {
            fileCostRows = snap.costRows.filter(r => r && !r.fromRef);
        }
        if (snap && snap.periodsByNum && typeof snap.periodsByNum === 'object') {
            const next = {};
            Object.keys(snap.periodsByNum).forEach((key) => {
                next[key] = (snap.periodsByNum[key] || []).map((r) => {
                    const from = r.from || ruDateFromCell(r.from);
                    const to = r.to || ruDateFromCell(r.to);
                    const k0 = r.k0 || dateKey(from);
                    const k1 = r.k1 || dateKey(to);
                    return { from, to, k0: Math.min(k0, k1), k1: Math.max(k0, k1) };
                }).filter(r => r.k0 && r.k1);
            });
            filePeriods = next;
        }
        rebuild();
    }

    // В снимок для других ПК — только данные файлов: справочник они читают сами из общей папки.
    function toSnapshot() {
        return { costRows: fileCostRows, periodsByNum: filePeriods };
    }

    // Все маршруты с суммами (итог файл + справочник) для раздела «Справочник».
    function amountRows() {
        const map = {};
        costRows.forEach(r => {
            const key = routePairKey(r.fromKey, r.toKey, r.acK);
            const e = map[key] || (map[key] = { key, from: r.from, to: r.to, ac: r.ac, acLabel: acDisplay(r.acK, r.ac), subsidy: null, cost: null,
                source: r.fromRef ? 'ref' : (r.byMonth ? (r.subRef ? 'file+ref' : 'file') : (refAmounts[key] ? 'ref' : 'file')), months: r.months || null, byMonth: null, krai: !!r.krai });
            if (r.byMonth && r.flag === 'да') { e.byMonth = r.byMonth; if (r.subRef) e.source = 'file+ref'; }
            if (r.byMonth && !e.byMonth) e.byMonth = r.byMonth;
            if (r.flag === 'да') {
                if (e.cost == null) e.cost = r.costPair;
                e.subsidy = r.subsidyAmt || null;
            } else {
                if (r.costPair != null) e.cost = r.costPair;
            }
        });
        return Object.values(map).sort((a, b) => (a.from + a.to).localeCompare(b.from + b.to, 'ru') || a.acLabel.localeCompare(b.acLabel, 'ru'));
    }

    // Что записать в справочник после загрузки файла по месяцам: итог (с субсидией из справочника там,
    // где у межрегионального направления в файле её нет), по одной записи на маршрут и ВС.
    function pivotEntries() {
        const out = [];
        fileCostRows.forEach(r => {
            if (!r.byMonth || r.flag !== 'да') return;
            const key = routePairKey(r.fromKey, r.toKey, r.acK);
            let byMonth = r.byMonth;
            let subsidy = r.subsidyAmt || 0;
            if (!r.krai && !r.months.some(m => r.byMonth[m] && r.byMonth[m].sub > 0)) {
                const old = refAmounts[key];
                const ref = old && old.subsidy > 0 ? old.subsidy : 0;
                if (ref) {
                    byMonth = {};
                    Object.keys(r.byMonth).forEach(m => { byMonth[m] = { ...r.byMonth[m], sub: ref }; });
                    subsidy = ref;
                }
            }
            out.push({ from: r.from, to: r.to, ac: r.ac, subsidy, cost: r.costPair, months: r.months, byMonth, krai: !!r.krai });
        });
        return out;
    }

    function fileData() {
        return { costRows: fileCostRows, periodsByNum: filePeriods };
    }

    // Откуда берутся периоды рейса и суммы маршрута: 'ref' — справочник, 'file' — файл, '' — нигде.
    function periodSource(num) {
        if (refPeriods[num]) return 'ref';
        return filePeriods[num] ? 'file' : '';
    }

    function flightNum(flightCode) {
        const code = typeof cleanFlight === 'function' ? cleanFlight(flightCode) : String(flightCode || '');
        return parseInt(String(code).replace(/[^0-9]/g, ''), 10) || 0;
    }

    /** Периоды рейса по базовому номеру (доп. KV-305 = KV-105). 105 ≠ 106. */
    function periodsForFlight(flightCode) {
        const n = flightNum(flightCode);
        const b = typeof getBaseFlight === 'function' ? flightNum(getBaseFlight(flightCode)) : n;
        // Справочник: пустой список — «коммерции нет», это тоже ответ.
        if (b && refPeriods[b]) return periodsByNum[b] || [];
        if (b && periodsByNum[b] && periodsByNum[b].length) return periodsByNum[b];
        // Старый файл мог содержать строку под номером доп. рейса — берём её, если у базового нет.
        if (n && n !== b && periodsByNum[n] && periodsByNum[n].length) return periodsByNum[n];
        return [];
    }

    /** Периоды 1–3 = коммерция, обе границы включительно. */
    function isCommercialDate(flightCode, dateStr) {
        const ranges = periodsForFlight(flightCode);
        if (!ranges.length) return false;
        const k = dateKey(dateStr);
        if (!k) return false;
        return ranges.some(r => k >= r.k0 && k <= r.k1);
    }

    function findCostRec(fromCity, toCity, acLabel, flag) {
        const fk = cityKey(fromCity);
        const tk = cityKey(toCity);
        const ak = acKey(acLabel);
        if (!fk || !tk || !ak) return null;
        return costIndex[`${fk}|${tk}|${ak}|${flagKey(flag)}`] || null;
    }

    const AC_LABELS = {
        atr42: 'ATR-42',
        atr72: 'ATR-72',
        an24: 'Ан-24',
        an26: 'Ан-26',
        yak42: 'Як-42',
        l410: 'L-410'
    };

    function acDisplay(key, fallback) {
        return AC_LABELS[key] || fallback || key;
    }

    function sameRoute(r, fromKey, toKey) {
        return (r.fromKey === fromKey && r.toKey === toKey)
            || (r.fromKey === toKey && r.toKey === fromKey);
    }

    function listRoutes() {
        const seen = Object.create(null);
        const out = [];
        costRows.forEach((r) => {
            const id = `${r.fromKey}|${r.toKey}`;
            if (seen[id]) return;
            seen[id] = true;
            out.push({
                id,
                from: r.from,
                to: r.to,
                fromKey: r.fromKey,
                toKey: r.toKey,
                label: `${r.from} — ${r.to}`
            });
        });
        out.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
        return out;
    }

    function listAircraft(fromKey, toKey) {
        const seen = Object.create(null);
        const out = [];
        costRows.forEach((r) => {
            if (!sameRoute(r, fromKey, toKey)) return;
            if (seen[r.acK]) return;
            seen[r.acK] = true;
            out.push({ key: r.acK, label: acDisplay(r.acK, r.ac) });
        });
        out.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
        return out;
    }

    /** Калькулятор вкладки: туда+обратно. В файле сумма на пару → × 1000. Экономическая таблица не трогается. */
    function quote(fromKey, toKey, acK, subsidized) {
        const flag = subsidized ? 'да' : 'нет';
        const rec = (fromKey && toKey && acK)
            ? (costIndex[`${fromKey}|${toKey}|${acK}|${flag}`] || null)
            : null;
        const recDa = (fromKey && toKey && acK)
            ? (costIndex[`${fromKey}|${toKey}|${acK}|да`] || null)
            : null;
        const expenses = rec && rec.costPair != null ? rec.costPair * 1000 : null;
        const subsidy = (subsidized && recDa && recDa.subsidyAmt)
            ? recDa.subsidyAmt * 1000
            : 0;
        // По месяцам файла (сводная таблица): расходы и субсидия каждого месяца и среднее за них.
        const src = rec || recDa;
        let months = null;
        if (src && src.byMonth && src.months) {
            months = src.months.map(m => {
                const v = src.byMonth[m];
                return {
                    m,
                    expenses: v ? v.cost * 1000 : null,
                    subsidy: v ? (subsidized ? v.sub * 1000 : 0) : null,
                    flights: v && v.n != null ? v.n : null
                };
            });
        }
        return { found: expenses != null, expenses, subsidy, months, krai: !!(src && src.krai) };
    }

    function citiesForRow(row, flightCode) {
        const code = flightCode || (row && typeof cleanFlight === 'function' ? cleanFlight(row[0]) : '');
        if (typeof getCitiesFromFlight === 'function') {
            const c = getCitiesFromFlight(code);
            if (c && c.length >= 2) return c;
        }
        if (row && typeof getRouteFromRow === 'function' && typeof parseDirectionCities === 'function') {
            const route = formatRouteDisplay ? formatRouteDisplay(getRouteFromRow(row)) : getRouteFromRow(row);
            const c = parseDirectionCities(String(route || '').replace('→', '—'));
            if (c && c.length >= 2) return c;
        }
        return [];
    }

    /**
     * @returns {{
     *   unitCost: number|null,
     *   subsidyAmt: number,
     *   subsidized: boolean,
     *   commercial: boolean,
     *   krai: boolean
     * }}
     */
    /**
     * Субсидия и коммерция — только этот рейс и его дата (row[0], row[1]).
     * В файле сумма на туда+обратно → на одно направление: сумма / 2 * 1000.
     */
    function lookup(row, flightCode, dateStr) {
        const code = (row && typeof cleanFlight === 'function')
            ? cleanFlight(row[0])
            : (flightCode || '');
        const date = String((row && row[1]) || dateStr || '').trim();
        const ac = row && typeof getAircraftType === 'function' ? getAircraftType(row[4]) : '';
        const krai = typeof getFlightRouteType === 'function' && getFlightRouteType(code) === 'krai';
        const commercial = krai ? true : isCommercialDate(code, date);
        const flag = commercial ? 'нет' : 'да';
        const cities = citiesForRow(row, code);
        const rec = cities.length >= 2
            ? findCostRec(cities[0], cities[1], ac, flag)
            : null;
        const recDa = cities.length >= 2
            ? findCostRec(cities[0], cities[1], ac, 'да')
            : null;
        const unitCost = rec && rec.costPair != null
            ? rec.costPair / 2 * 1000
            : null;
        const pairFromFile = recDa ? (recDa.subsidyAmt || 0) : 0;
        const subsidyOneWay = (!commercial && pairFromFile)
            ? pairFromFile / 2 * 1000
            : 0;
        return {
            unitCost,
            from: cities[0] || '',
            to: cities[1] || '',
            ac,
            subsidyAmt: pairFromFile,
            subsidyOneWay,
            subsidized: !commercial,
            commercial,
            krai
        };
    }

    function findCostsFile(files) {
        const list = files || [];
        return list.find(f => {
            const n = String(f.name || '').toLowerCase();
            return (n.endsWith('.xlsx') || n.endsWith('.xls'))
                && (n.includes('расход') || n.includes('себестоим')) && !n.startsWith('~$')
                && !n.includes('период');
        }) || null;
    }

    function findPeriodsFile(files) {
        const list = files || [];
        return list.find(f => {
            const n = String(f.name || '').toLowerCase();
            return (n.endsWith('.xlsx') || n.endsWith('.xls'))
                && n.includes('период') && n.includes('субсид') && !n.startsWith('~$');
        }) || null;
    }

    return {
        loadFiles,
        applySnapshot,
        toSnapshot,
        fileData,
        pivotEntries,
        isKraiPair,
        applyRef,
        amountRows,
        periodsFor: (code) => periodsForFlight(code),
        periodSource,
        cityKey,
        acKey,
        acLabels: () => ({ ...AC_LABELS }),
        lookup,
        listRoutes,
        listAircraft,
        quote,
        isCommercialDate,
        findCostsFile,
        findPeriodsFile,
        get loaded() { return costRows.length > 0; }
    };
})();
