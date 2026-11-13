// отчёт "Запросы на снижение" (Отчёты): что админ просил снизить и что согласовали
// запрос = отметка attn, дата запроса = день отметки; согласовано = down на D..D+2 у любого автора, иначе ждём ответа или не согласовано
// общая история shared/lowreq-report.json, ключ 'рейс|вылет|запрос'; snap пишем один раз, fact по срокам 14/7/3/0
window.LowReqReport = (function () {
    const FILE = 'lowreq-report.json';
    const HZ = [14, 7, 3, 0];
    const PERIODS = [30, 60, 90, 0];   // 0 - за всё время
    const VIEW_KEY = 'krasavia_lowrep_view';
    const DONE_KEY = 'krasavia_lowrep_done';
    const STALE_MS = 45000;
    const BATCH = 30;

    let period = 0;
    let show = '';
    let query = '';
    try {
        const v = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null');
        if (v && PERIODS.includes(v.period)) period = v.period;
        if (v && ['', 'yes', 'no', 'wait'].includes(v.show)) show = v.show;
    } catch (e) { /* ignore */ }

    let store = { items: {}, loaded: false, at: 0 };
    let storeLoading = null;
    let rev = 0;
    let lrReady = false;
    let lastRerender = null;
    let editKey = '';
    let draft = null;
    const asked = new Set();

    function esc(v) { return escHtml(v); }
    function toast(m, t) { if (typeof showToast === 'function') showToast(m, t); }
    function today() { return typeof getTodayDate === 'function' ? getTodayDate() : formatDateRu(new Date()); }
    function dayNum(s) {
        const d = typeof parseLocalDate === 'function' ? parseLocalDate(s) : null;
        return d ? Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000) : null;
    }
    function fmt(n) { return n == null || !Number.isFinite(Number(n)) ? '—' : Math.round(n).toLocaleString('ru-RU'); }
    function norm(s) { return String(s || '').trim().toLowerCase(); }
    function monthOf(dateStr) {
        const d = parseLocalDate(dateStr);
        return d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` : '';
    }
    function placesWord(n) {
        const a = n % 10, b = n % 100;
        return a === 1 && b !== 11 ? 'место' : (a >= 2 && a <= 4 && (b < 12 || b > 14) ? 'места' : 'мест');
    }
    function keyOf(code, dep, check) { return `${code}|${dep}|${check}`; }
    function hasPerm(p) { return typeof ProfileAuth === 'undefined' || ProfileAuth.hasPermission(p); }

    function canView() {
        if (typeof ProfileAuth === 'undefined') return true;
        const cur = ProfileAuth.getCurrentProfile && ProfileAuth.getCurrentProfile();
        return !!(cur && (cur.isAdmin || ProfileAuth.canAccessTab('sales') || ProfileAuth.canAccessTab('reports')));
    }
    // править: админ или право edit_sales_mgmt (у админа есть всегда)
    function canEditRows() { return hasPerm('edit_sales_mgmt'); }
    function canExport() { return hasPerm('export_excel'); }
    function canWriteShared() { return typeof ProfileAuth !== 'undefined' && ProfileAuth.hasPermission('share_data'); }
    function available() { return typeof SalesManagement !== 'undefined' && SalesManagement.allMarks && typeof SharedStorage !== 'undefined'; }

    async function loadStore(force) {
        if (storeLoading) return storeLoading;
        if (!force && store.loaded && Date.now() - store.at < STALE_MS) return false;
        storeLoading = (async () => {
            const r = typeof SharedStorage !== 'undefined' ? await SharedStorage.readJsonFileStrict(FILE).catch(() => ({ ok: false })) : { ok: false };
            store.at = Date.now();
            if (!r.ok) return false;
            const items = r.data && r.data.items && typeof r.data.items === 'object' ? r.data.items : {};
            const changed = !store.loaded || JSON.stringify(items) !== JSON.stringify(store.items);
            store.loaded = true;
            if (changed) { store.items = items; rev++; }
            return changed;
        })().catch(() => false).finally(() => { storeLoading = null; });
        return storeLoading;
    }

    function byName() {
        const p = typeof ProfileAuth !== 'undefined' && ProfileAuth.getCurrentProfile ? ProfileAuth.getCurrentProfile() : null;
        return (p && p.name) || '';
    }

    // слияние добавок: зафиксированное (snap, fact, revFinal) не перезаписываем
    // ask и est обновляем, пока не итоговые; возвращает true, если что-то изменилось
    function applyPatch(items, p) {
        let it = items[p.key];
        let changed = false;
        if (!it) {
            it = { code: p.code, dep: p.dep, check: p.check, author: p.author || '', markAt: p.markAt || '', first: new Date().toISOString() };
            items[p.key] = it;
            changed = true;
        } else {
            it = items[p.key] = { ...it };
        }
        if (p.snap && !it.snap) { it.snap = p.snap; changed = true; }
        if (p.fact) {
            Object.keys(p.fact).forEach(t => {
                if (p.fact[t] == null) return;
                if (!it.fact || it.fact[t] == null) { it.fact = { ...(it.fact || {}), [t]: p.fact[t] }; changed = true; }
            });
        }
        if (p.revFinal != null && it.revFinal == null) { it.revFinal = p.revFinal; it.revAt = new Date().toISOString(); changed = true; }
        if (p.ask && JSON.stringify({ ...it.ask, at: 0 }) !== JSON.stringify({ ...p.ask, at: 0 })) { it.ask = p.ask; changed = true; }
        if (p.est && !(it.est && it.est.final)) {
            if (JSON.stringify({ ...it.est, at: 0 }) !== JSON.stringify({ ...p.est, at: 0 })) { it.est = p.est; changed = true; }
        }
        return changed;
    }

    let writeChain = Promise.resolve();
    function writePatches(patches) {
        const run = writeChain.catch(() => null).then(async () => {
            let merged = null;
            const res = await SharedStorage.updateJsonFile(FILE, (cur) => {
                const items = cur && cur.items && typeof cur.items === 'object' ? { ...cur.items } : {};
                let any = false;
                patches.forEach(p => { if (applyPatch(items, p)) any = true; });
                merged = items;
                return any ? { version: 1, updatedAt: new Date().toISOString(), by: byName(), items } : false;
            }).catch(() => ({ ok: false }));
            if (merged && (res.ok || res.aborted)) { store.items = merged; store.loaded = true; store.at = Date.now(); if (res.ok) rev++; }
            return !!(res.ok || res.aborted);
        });
        writeChain = run;
        return run;
    }

    // подпись админа в отметках - 'Лобанов К.И.' (SalesManagement.authorSignature)
    function adminSet() {
        const out = new Set();
        const sig = (n) => norm(typeof SalesManagement !== 'undefined' && SalesManagement.authorSignature ? SalesManagement.authorSignature(n) : n);
        let known = false;
        try {
            ((typeof ProfileAuth !== 'undefined' && ProfileAuth.getPublicProfiles && ProfileAuth.getPublicProfiles()) || []).forEach(p => { known = true; if (p.isAdmin) out.add(sig(p.name)); });
            const cur = typeof ProfileAuth !== 'undefined' && ProfileAuth.getCurrentProfile ? ProfileAuth.getCurrentProfile() : null;
            if (cur && cur.isAdmin) { out.add(sig(cur.name)); if (SalesManagement.profileName) out.add(norm(SalesManagement.profileName())); known = true; }
        } catch (e) { /* ignore */ }
        return { set: out, known };
    }

    let deriveMemo = { sig: '', cands: [], downs: new Map(), known: false };
    function derive() {
        const adm = adminSet();
        const sg = [SalesManagement.markRevision ? SalesManagement.markRevision() : '', [...adm.set].sort().join('|'), today()].join('#');
        if (deriveMemo.sig === sg) return deriveMemo;
        const t = dayNum(today());
        const cands = new Map();
        const downs = new Map();
        let from = null;   // отметки раньше этой даты не читаем
        SalesManagement.allMarks().forEach(m => {
            const cd = dayNum(m.check);
            if (cd != null && (from == null || cd < from)) from = cd;
            if (m.status === 'attn' && adm.set.has(norm(m.author))) {
                const c = dayNum(m.check);
                if (c == null || c > t) return;   // отметка на будущую дату станет запросом в свой день
                const k = keyOf(m.flight, m.dep, m.check);
                const prev = cands.get(k);
                if (!prev || String(m.updatedAt || '') < String(prev.markAt || '')) cands.set(k, { key: k, code: m.flight, dep: m.dep, check: m.check, author: m.author || '', markAt: m.updatedAt || '' });
            } else if (m.status === 'down') {
                const k = m.flight + '|' + m.dep;
                if (!downs.has(k)) downs.set(k, []);
                downs.get(k).push({ check: m.check, author: m.author || '', at: m.updatedAt || '' });
            }
        });
        deriveMemo = { sig: sg, cands: [...cands.values()], downs, known: adm.known, from };
        return deriveMemo;
    }

    // ответ: down в день запроса или за 2 дня после него (D..D+2), у любого автора
    function autoResult(code, dep, check, downs) {
        const c = dayNum(check);
        const hit = (downs.get(code + '|' + dep) || [])
            .filter(d => { const n = dayNum(d.check); return n >= c && n <= c + 2; })
            .sort((a, b) => (dayNum(a.check) - dayNum(b.check)) || String(a.at).localeCompare(String(b.at)))[0];
        if (hit) return { res: 'yes', down: hit };
        return { res: dayNum(today()) <= c + 2 ? 'wait' : 'no', down: null };
    }

    // цифры по вылету: живые билеты, журнал продаж по дням, архив

    function expectedFileOn() {
        return typeof hasExpectedFileLoaded === 'function' ? hasExpectedFileLoaded() : (typeof expectedLoadData !== 'undefined' && Object.keys(expectedLoadData || {}).length > 0);
    }

    function metaOf(code, date) {
        const base = typeof getBaseFlight === 'function' ? getBaseFlight(code) : code;
        let row = null;
        try { row = typeof getFlightRowForDate === 'function' ? getFlightRowForDate(base, date, code) : null; } catch (e) { row = null; }
        const arch = typeof SalesArchive !== 'undefined' && SalesArchive.entryFor ? SalesArchive.entryFor(date, code) : null;
        const logRec = typeof SalesDayLog !== 'undefined' && SalesDayLog.flight ? SalesDayLog.flight(date, code) : null;
        let seats = row ? getSeatsOnSale(row) : 0;
        if (!seats && arch && arch.s) seats = arch.s;
        if (!seats && logRec && logRec.s) seats = logRec.s;
        let ac = row ? getAircraftType(row[4]) : ((arch && arch.ac) || '');
        if (!ac && typeof groupedData !== 'undefined' && groupedData && groupedData[base] && groupedData[base].length) ac = getAircraftType(groupedData[base][0][4]);
        return { base, row, arch, seats, ac, load: row ? getSoldFromRow(row) : 0 };
    }

    // нарастающим итогом по дням до вылета: архив для улетевших, иначе живые билеты + журнал вне окна файла
    function curveOf(date, code, meta) {
        const fly = dayNum(date);
        const flown = fly < dayNum(today());
        if (flown && meta.arch && SalesArchive.curveFor) {
            const c = SalesArchive.curveFor(date, code);
            if (c && c.total > 0) return { onHand: c.onHand, maxDtd: c.maxDtd, total: c.total, rev: meta.arch.rev > 0 ? meta.arch.rev : null, src: 'arch', whi: null };
        }
        const flyMs = parseLocalDate(date).getTime();
        const list = typeof getFlightSalesList === 'function' ? getFlightSalesList(date, code) : [];
        const win = typeof SalesDayLog !== 'undefined' && SalesDayLog.fileWindow ? SalesDayLog.fileWindow() : null;
        const wlo = win ? Math.round((flyMs - win.to) / 86400000) : null;
        const whi = win ? Math.round((flyMs - win.from) / 86400000) : null;
        const by = Object.create(null);
        for (let i = 0; i < list.length; i++) {
            const x = list[i];
            const deal = parseLocalDate(x.dealDate);
            if (!deal) continue;
            const t = Math.round((flyMs - deal.getTime()) / 86400000);
            if (t < 0) continue;
            const e = by[t] || (by[t] = { n: 0, r: 0 });
            const f = x.fare > 0 ? x.fare : (x.adjustedFare || 0);
            e.n++;
            if (f > 0) e.r += f;
        }
        let usedLog = false;
        let revKnown = true;
        const days = typeof SalesDayLog !== 'undefined' && SalesDayLog.daysFor ? SalesDayLog.daysFor(date, code) : [];
        days.forEach(d => {
            if (list.length && win && d.dtd >= wlo && d.dtd <= whi) return;   // день уже есть в файле продаж
            if (by[d.dtd]) return;
            by[d.dtd] = { n: d.n, r: d.r == null ? 0 : d.r };
            if (d.r == null) revKnown = false;
            usedLog = true;
        });
        const ts = Object.keys(by).map(Number);
        if (!ts.length) return null;
        let maxDtd = Math.max.apply(null, ts);
        let run = 0;
        let revSum = 0;
        let onHand = Object.create(null);
        for (let t = maxDtd; t >= 0; t--) {
            const e = by[t];
            if (e) { run += e.n; revSum += e.r; }
            onHand[t] = run;
        }
        let total = run;
        if (!(total > 0)) return null;
        // как на сайте: масштаб по загрузке из файла загрузки
        // в продажах бывают незакрытые возвраты и обмены
        if (meta.load > 0 && total !== meta.load) {
            const k = meta.load / total;
            const o2 = Object.create(null);
            Object.keys(onHand).forEach(t => { o2[t] = Math.round(onHand[t] * k); });
            onHand = o2;
            total = meta.load;
        }
        return { onHand, maxDtd, total, rev: revKnown ? Math.round(revSum) : null, src: usedLog ? 'log' : 'live', whi };
    }

    // продано к сроку T дней до вылета; null - данных нет, а не ноль
    function soldAt(curve, T) {
        if (!curve) return null;
        if (T > curve.maxDtd) {
            if (curve.src === 'live' && curve.whi != null && T > curve.whi) return null;   // раньше окна файла продаж не знаем
            return 0;
        }
        const v = curve.onHand[T];
        return v == null ? null : v;
    }

    // средний тариф взрослых платных, проданных к концу дня запроса
    function avgAdultAt(date, code, dtdCheck) {
        if (typeof SalesDayLog === 'undefined' || !SalesDayLog.adultDays) return null;
        let a = 0;
        let ra = 0;
        SalesDayLog.adultDays(date, code).forEach(d => { if (d.dtd >= dtdCheck) { a += d.a; ra += d.ra; } });
        return a > 0 && ra > 0 ? Math.round(ra / a) : null;
    }

    // норма 'обычно к этому дню' по тем же дням недели на сроках 14 / 7 / 3 / 0
    function normAt(code, date, meta) {
        if (typeof collectSameWeekdayCohort !== 'function' || typeof weekdayNormSeries !== 'function') return null;
        try {
            const all = collectSameWeekdayCohort(meta.base, date, code);
            const win = typeof PV !== 'undefined' ? PV.WEEKDAY_NORM_WINDOW_DAYS : 56;
            let s = weekdayNormSeries(all.filter(c => c.dayGap <= win), HZ, meta.seats);
            if (!s.points.some(p => p.value != null)) s = weekdayNormSeries(all, HZ, meta.seats);
            const out = {};
            HZ.forEach((t, i) => { out[t] = s.points[i] && s.points[i].value != null ? s.points[i].value : null; });
            return out;
        } catch (e) { return null; }
    }

    // ожидаемая по срокам: из файла (не больше кресел в продаже), иначе норма
    function expAt(code, date, meta) {
        const exp = {};
        const es = {};
        let normV;
        const file = expectedFileOn() && typeof getExpectedLoad === 'function';
        HZ.forEach(T => {
            let v = null;
            if (file && meta.ac) {
                const cap = getCapacityFromAircraft(meta.ac);
                const ev = getExpectedLoad(cap, meta.base, T, getWeekForExpectedLoad(date));
                if (ev != null && !isNaN(ev)) { v = Math.ceil(meta.seats > 0 ? Math.min(ev, meta.seats) : ev); es[T] = 'file'; }
            }
            if (v == null) {
                if (normV === undefined) normV = normAt(code, date, meta);
                if (normV && normV[T] != null) { v = normV[T]; es[T] = 'norm'; }
            }
            exp[T] = v;
        });
        return { exp, es };
    }

    // значения на момент запроса, фиксируем один раз
    // null - данных нет совсем: запись не пишем, повторим позже
    function buildSnap(code, dep, check, curve0) {
        const meta = metaOf(code, dep);
        const fly = dayNum(dep);
        const chk = dayNum(check);
        const now = dayNum(today());
        const dtdCheck = fly - chk;
        const curve = curve0 !== undefined ? curve0 : curveOf(dep, code, meta);
        let sold = null;
        if (fly - now === dtdCheck && meta.row) sold = meta.load;   // в день отметки берём загрузку ровно как на сайте
        else if (curve) sold = soldAt(curve, dtdCheck);
        if (sold == null) return null;
        const avg = avgAdultAt(dep, code, dtdCheck);
        const e = expAt(code, dep, meta);
        return {
            sold, seats: meta.seats || null, dtd: dtdCheck, avg,
            exp: e.exp, es: e.es,
            expRev: e.exp[0] != null && avg ? Math.round(e.exp[0] * avg) : null,
            src: sold === meta.load && fly - now === dtdCheck && meta.row ? 'row' : (curve ? curve.src : ''),
            at: new Date().toISOString(), late: now > chk ? 1 : 0
        };
    }

    // оценка 'что согласовали': взрослые платные после дня снижения, дешевле среднего тарифа на момент запроса
    function estimateAfter(dep, code, downCheck, avgBefore) {
        const dc = dayNum(downCheck);
        let places = 0;
        let sum = 0;
        const list = typeof getFlightSalesList === 'function' ? getFlightSalesList(dep, code) : [];
        const win = typeof SalesDayLog !== 'undefined' && SalesDayLog.fileWindow ? SalesDayLog.fileWindow() : null;
        const flyMs = parseLocalDate(dep).getTime();
        const wlo = win ? Math.round((flyMs - win.to) / 86400000) : null;
        const whi = win ? Math.round((flyMs - win.from) / 86400000) : null;
        for (let i = 0; i < list.length; i++) {
            const x = list[i];
            const dn = dayNum(x.dealDate);
            if (dn == null || dn <= dc) continue;
            if (typeof FareGrid === 'undefined' || !FareGrid.isAdultPaid(x)) continue;
            const price = x.adjustedFare || x.fare || 0;
            if (!(price > 0)) continue;
            if (avgBefore && !(price < avgBefore)) continue;
            places++;
            sum += price;
        }
        // дней, которых нет в файле продаж, берём из журнала (средний тариф дня)
        if (typeof SalesDayLog !== 'undefined' && SalesDayLog.adultDays) {
            SalesDayLog.adultDays(dep, code).forEach(d => {
                if (!(d.a > 0)) return;
                const dn = dayNum(dep) - d.dtd;
                if (dn <= dc) return;
                if (list.length && win && d.dtd >= wlo && d.dtd <= whi) return;
                const avg = d.ra / d.a;
                if (avgBefore && !(avg < avgBefore)) return;
                places += d.a;
                sum += d.ra;
            });
        }
        return places > 0 ? { places, fare: Math.round(sum / places) } : null;
    }

    function askOf(code, dep) {
        if (typeof LowerRequest === 'undefined' || !LowerRequest.askFor) return null;
        try { return LowerRequest.askFor(code, dep); } catch (e) { return null; }
    }

    let memo = { sig: '', rows: [] };
    const liveSnaps = new Map();

    function lrRev() { return typeof LowerRequest !== 'undefined' && LowerRequest.revision ? LowerRequest.revision() : 0; }

    function sigNow() {
        return [typeof dataEpoch === 'number' ? dataEpoch : 0, today(), SalesManagement.markRevision ? SalesManagement.markRevision() : '', rev, lrReady ? 1 : 0,
            typeof SalesArchive !== 'undefined' && SalesArchive.revision ? SalesArchive.revision() : 0,
            typeof SalesDayLog !== 'undefined' && SalesDayLog.revision ? SalesDayLog.revision() : 0, deriveMemo.sig, lrRev(), CustomPeriod.sig('low')].join('|');
    }

    function routeOf(code) {
        const d = typeof getFlightDirection === 'function' ? String(getFlightDirection(typeof getBaseFlight === 'function' ? getBaseFlight(code) : code) || '') : '';
        return d.replace(/\s*[—–]\s*|\s+-\s+/g, ' — ').replace(/\s+/g, ' ').trim();
    }

    function buildRow(c, it, d) {
        const now = dayNum(today());
        const fly = dayNum(c.dep);
        const dtdNow = fly - now;
        const auto = autoResult(c.code, c.dep, c.check, d.downs);
        const over = it && it.over ? it.over : null;
        let res = auto.res;
        if (over && over.agree != null) res = over.agree ? 'yes' : 'no';
        // записанные значения; если запрос ещё не записан, считаем так же, как запишем
        let snap = it && it.snap ? it.snap : null;
        let meta = null;
        let curve;
        const lazy = () => { if (!meta) { meta = metaOf(c.code, c.dep); curve = curveOf(c.dep, c.code, meta); } };
        if (!snap && dayNum(c.check) === now) {
            const k = c.key + '|' + sigNow();
            if (!liveSnaps.has(k)) { lazy(); liveSnaps.clear(); liveSnaps.set(k, buildSnap(c.code, c.dep, c.check, curve)); }
            snap = liveSnaps.get(k);
        }
        const terms = HZ.map(T => {
            const exp = snap && snap.exp ? (snap.exp[T] != null ? snap.exp[T] : null) : null;
            const passed = dtdNow <= T;
            let fact = it && it.fact && it.fact[T] != null ? it.fact[T] : null;
            let live = false;
            if (fact == null && passed) {
                lazy();
                if (curve) {
                    fact = T === 0 && dtdNow < 0 && meta.arch ? (meta.arch.sold || meta.arch.t) : (T === 0 && meta.row && dtdNow >= 0 ? meta.load : soldAt(curve, T));
                    live = true;
                }
            }
            if (dtdNow === T) live = true;   // день срока идёт, число пока не итоговое
            return { T, exp, fact, passed, live };
        });
        // выручка: после вылета берём зафиксированную итоговую
        let curRev = it && it.revFinal != null ? it.revFinal : null;
        if (curRev == null) { lazy(); curRev = curve ? curve.rev : null; }
        // загрузка: после вылета итоговая (записанная или из архива), до вылета нынешняя
        lazy();
        let curSold = null;
        if (dtdNow < 0) curSold = it && it.fact && it.fact[0] != null ? it.fact[0] : (meta.arch ? (meta.arch.sold || meta.arch.t || null) : null);
        if (curSold == null) curSold = meta.row ? meta.load : (curve ? curve.total : null);
        const curSeats = meta.seats || (snap && snap.seats) || null;
        // что согласовали: из 'Запроса на понижение', иначе оценка по продажам после снижения
        let autoWhat = null;
        const ask = askOf(c.code, c.dep) || (it && it.ask) || null;
        if (auto.res === 'yes') {
            if (ask && ask.places > 0) autoWhat = { places: ask.places, fare: ask.fare != null ? ask.fare : null, est: false };
            else {
                let e = auto.down ? estimateAfter(c.dep, c.code, auto.down.check, snap ? snap.avg : null) : null;
                if ((!e || (it && it.est && it.est.final)) && it && it.est) e = { places: it.est.places, fare: it.est.fare };
                if (e && e.places > 0) autoWhat = { places: e.places, fare: e.fare, est: true };
            }
        }
        let what = res === 'yes' ? autoWhat : null;
        if (res === 'yes' && over) {
            const p = over.places != null ? over.places : (what ? what.places : null);
            const f = over.fare != null ? over.fare : (what ? what.fare : null);
            const stillEst = !!(what && what.est && (over.places == null || over.fare == null));
            what = p != null || f != null ? { places: p, fare: f, est: stillEst } : null;
        }
        const autoText = auto.res === 'yes'
            ? '«Да»' + (autoWhat ? `, ${whatText(autoWhat)} (${autoWhat.est ? 'оценка по продажам, в «Запросе на понижение» места не вписаны' : 'из «Запроса на понижение»'})` : ', мест и тарифа нет')
            : (auto.res === 'no' ? '«Нет»' : '«Ждём ответа»');
        return {
            key: c.key, code: c.code, dep: c.dep, check: c.check, author: c.author, route: routeOf(c.code),
            snap, sold: snap ? snap.sold : null, seats: snap ? snap.seats : null,
            terms, curSold, curSeats, expRev: snap ? snap.expRev : null, curRev, dtdNow, flown: dtdNow < 0,
            ask: ask && ask.places > 0 ? { places: ask.places, fare: ask.fare != null ? ask.fare : null } : null, approx: !!(snap && snap.late), res, autoRes: auto.res, autoText, down: auto.down, edited: !!over, over, what, saved: !!it
        };
    }

    function rows() {
        if (!available()) return [];
        const d = derive();
        const sg = sigNow();
        if (memo.sig === sg) return memo.rows;
        const seen = new Set();
        const out = [];
        d.cands.forEach(c => { seen.add(c.key); out.push(buildRow(c, store.items[c.key] || null, d)); });
        Object.keys(store.items).forEach(k => {
            if (seen.has(k)) return;
            const it = store.items[k];
            if (!it || !it.code || !it.dep || !it.check) return;
            // отметку сняли (дата внутри прочитанного окна, отметки нет): запроса больше нет
            const ck = dayNum(it.check);
            if (d.from != null && ck != null && ck >= d.from) return;
            out.push(buildRow({ key: k, code: it.code, dep: it.dep, check: it.check, author: it.author || '', markAt: it.markAt || '' }, it, d));
        });
        out.sort((a, b) => (dayNum(b.check) - dayNum(a.check)) || String(a.code).localeCompare(String(b.code), 'ru', { numeric: true }));
        memo = { sig: sg, rows: out };
        return out;
    }

    function inPeriod(list) {
        if (CustomPeriod.on('low')) return list.filter(r => CustomPeriod.contains('low', r.check));
        if (!period) return list;
        const t = dayNum(today());
        return list.filter(r => t - dayNum(r.check) <= period);
    }

    function filtered() {
        const q = norm(query).replace(/\s+/g, '');
        return inPeriod(rows()).filter(r => (!show || r.res === show) && (!q || norm(r.code).replace('-', '').includes(q.replace('-', ''))));
    }

    function totals(list) {
        const t = { n: list.length, yes: 0, no: 0, wait: 0, diff: 0, diffN: 0 };
        list.forEach(r => {
            t[r.res]++;
            if (r.res === 'yes' && r.curRev != null && r.expRev != null) { t.diff += r.curRev - r.expRev; t.diffN++; }
        });
        return t;
    }

    const pause = () => new Promise(r => setTimeout(r, 6));
    function makeYield() {
        let t = performance.now();
        return async () => { if (performance.now() - t > 8) { await pause(); t = performance.now(); } };
    }
    function whenIdle(fn, timeout) {
        if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: timeout || 40000 });
        else setTimeout(fn, 3000);
    }

    function dataToken() {
        const at = typeof lastSalesUpdate !== 'undefined' && lastSalesUpdate ? new Date(lastSalesUpdate).getTime() : 0;
        return `${today()}|${at}|${(typeof allData !== 'undefined' && allData ? allData.length : 0)}|${SalesManagement.markRevision ? SalesManagement.markRevision() : ''}`;
    }

    // работа нужна, если нет значений на момент запроса, факта по прошедшему сроку, итоговой выручки или оценки
    function needsWork(it, dtdNow) {
        if (!it || !it.snap) return true;
        for (const T of HZ) if (dtdNow < T && (!it.fact || it.fact[T] == null)) return true;
        if (dtdNow < 0) return it.revFinal == null || !!(it.est && !it.est.final);
        return true;   // вылет впереди, места и оценка ещё могут меняться
    }

    let running = null;
    let lastTry = 0;
    async function capture0() {
        if (!available() || typeof ProfileAuth === 'undefined' || !canWriteShared()) return false;
        if (typeof groupedData === 'undefined' || !groupedData || !Object.keys(groupedData).length) return false;
        if (typeof salesDetails === 'undefined' || !Object.keys(salesDetails || {}).length) return false;
        // без свежего файла продаж не пишем: цифры будут неверные
        if (typeof hasSalesFileLoaded === 'function' && !hasSalesFileLoaded()) return false;
        if (typeof getStaleSalesInfo === 'function' && getStaleSalesInfo()) return false;
        const token = dataToken();
        try { if (localStorage.getItem(DONE_KEY) === token) return true; } catch (e) { /* ignore */ }
        if (!(await SharedStorage.canWrite())) return false;
        try { await SalesManagement.load(); } catch (e) { /* что есть */ }
        const d = derive();
        if (!d.known) return false;
        const r0 = await SharedStorage.readJsonFileStrict(FILE).catch(() => ({ ok: false }));
        if (!r0.ok) return false;   // файл не прочитался - не пишем
        const items = r0.data && r0.data.items && typeof r0.data.items === 'object' ? r0.data.items : {};
        store.items = items; store.loaded = true; store.at = Date.now();
        const now = dayNum(today());
        const tick = makeYield();
        // к работе: запросы из отметок и записанные, у которых что-то наступило
        const work = new Map();
        d.cands.forEach(c => { if (!items[c.key] || needsWork(items[c.key], dayNum(c.dep) - now)) work.set(c.key, c); });
        Object.keys(items).forEach(k => {
            const it = items[k];
            if (work.has(k) || !it || !it.code) return;
            if (needsWork(it, dayNum(it.dep) - now)) work.set(k, { key: k, code: it.code, dep: it.dep, check: it.check, author: it.author || '', markAt: it.markAt || '' });
        });
        // журнал и архив нужных месяцев; улетевшие и старые запросы восстанавливаем оттуда
        const months = [...new Set([...work.values()].map(c => monthOf(c.dep)).filter(Boolean))];
        try { if (typeof SalesDayLog !== 'undefined') await SalesDayLog.ensureMonths(months); } catch (e) { /* без журнала */ }
        try { if (typeof SalesArchive !== 'undefined') await SalesArchive.ensureMonths(months); } catch (e) { /* без архива */ }
        let ok = true;
        let patches = [];
        let i = 0;
        const flush = async () => { if (!patches.length) return; ok = (await writePatches(patches)) && ok; patches = []; };
        for (const c of work.values()) {
            const it = items[c.key] || null;
            const dtdNow = dayNum(c.dep) - now;
            const p = { key: c.key, code: c.code, dep: c.dep, check: c.check, author: c.author, markAt: c.markAt };
            let meta = null;
            let curve;
            const lazy = () => { if (!meta) { meta = metaOf(c.code, c.dep); curve = curveOf(c.dep, c.code, meta); } };
            let touched = !it;
            if (!it || !it.snap) {
                lazy();
                const s = buildSnap(c.code, c.dep, c.check, curve);
                if (s) { p.snap = s; touched = true; }
            }
            // факт по сроку пишем, когда день срока прошёл (dtdNow < T): число уже не меняется
            HZ.forEach(T => {
                if (dtdNow >= T || (it && it.fact && it.fact[T] != null)) return;
                lazy();
                let v = null;
                if (T === 0) v = meta.arch ? (meta.arch.sold || meta.arch.t || null) : (meta.row ? meta.load : soldAt(curve, 0));
                else v = soldAt(curve, T);
                if (v != null) { (p.fact || (p.fact = {}))[T] = v; touched = true; }
            });
            if (dtdNow < 0 && (!it || it.revFinal == null)) {
                lazy();
                if (curve && curve.rev != null) { p.revFinal = curve.rev; touched = true; }
            }
            const ask = askOf(c.code, c.dep);
            if (ask && ask.places > 0) { p.ask = { places: ask.places, fare: ask.fare, cls: ask.parts && ask.parts.length === 1 ? ask.parts[0].cls : '', at: new Date().toISOString() }; touched = true; }
            const auto = autoResult(c.code, c.dep, c.check, d.downs);
            if (auto.res === 'yes' && !(ask && ask.places > 0) && !(it && it.est && it.est.final)) {
                const e = estimateAfter(c.dep, c.code, auto.down.check, (p.snap || (it && it.snap) || {}).avg || null);
                if (e) { p.est = { places: e.places, fare: e.fare, final: dtdNow < 0 ? 1 : 0, at: new Date().toISOString() }; touched = true; }
            }
            if (touched) patches.push(p);
            if (patches.length >= BATCH) await flush();
            await tick();
        }
        await flush();
        if (ok) { try { localStorage.setItem(DONE_KEY, token); } catch (e) { /* ignore */ } }
        memo.sig = '';
        document.dispatchEvent(new CustomEvent('krasavia:lowrep'));
        return ok;
    }

    function capture() {
        if (running) return running;
        running = capture0().catch(e => { console.warn('LowReqReport.capture', e); return false; }).finally(() => { running = null; });
        return running;
    }
    function captureSoon() { whenIdle(() => { capture(); }, 40000); }

    async function saveOver(key, over) {
        const r = rows().find(x => x.key === key);
        const base = r ? { key, code: r.code, dep: r.dep, check: r.check, author: r.author } : null;
        const res = await SharedStorage.updateJsonFile(FILE, (cur) => {
            const items = cur && cur.items && typeof cur.items === 'object' ? { ...cur.items } : {};
            let it = items[key];
            if (!it) {
                if (!base) return false;
                it = { code: base.code, dep: base.dep, check: base.check, author: base.author || '', markAt: '', first: new Date().toISOString() };
            } else it = { ...it };
            if (over) it.over = { ...over, by: byName(), at: new Date().toISOString() };
            else delete it.over;
            items[key] = it;
            return { version: 1, updatedAt: new Date().toISOString(), by: byName(), items };
        }).catch(() => ({ ok: false }));
        if (!res.ok) return false;
        store.items = res.data.items;
        store.loaded = true;
        rev++;
        return true;
    }

    function stateOf(res) { return res === 'yes' ? { cls: 'yes', text: 'Да' } : (res === 'no' ? { cls: 'no', text: 'Нет' } : { cls: 'wait', text: 'Ждём ответа' }); }

    function factClass(fact, exp) { return fact > exp ? 'up' : (fact < exp - 2 ? 'dn' : 'eq'); }

    function termHtml(t, seats, approx) {
        const A = approx ? '≈ ' : '';
        if (t.passed && t.fact != null) {
            if (t.exp == null) return `<td class="lrr-hz"><span class="lrr-fa eq">стало ${fmt(t.fact)}</span></td>`;
            return `<td class="lrr-hz"><span class="lrr-wa">ожидали ${A}${fmt(t.exp)}</span><span class="lrr-fa ${factClass(t.fact, t.exp)}">стало ${fmt(t.fact)}</span></td>`;
        }
        if (t.exp == null) return '<td class="lrr-hz"><span class="lrr-mut">—</span></td>';
        const pc = seats > 0 ? `<span class="lrr-pc">${Math.round(t.exp / seats * 100)}%</span>` : '';
        return `<td class="lrr-hz"><b>${A}${fmt(t.exp)}</b>${pc}</td>`;
    }

    function whatText(w) {
        if (!w) return '';
        const p = w.places != null ? `${fmt(w.places)} ${placesWord(w.places)}` : 'места —';
        return w.fare != null ? `${p} по ${w.est ? '≈ ' : ''}${fmt(w.fare)} ₽` : `${p}, тариф —`;
    }

    function editHtml(r) {
        const dr = draft && draft.key === r.key ? draft : { key: r.key, agree: r.res === 'yes' ? true : (r.res === 'no' ? false : null), places: r.what && r.what.places != null ? String(r.what.places) : '', fare: r.what && r.what.fare != null ? String(r.what.fare) : '' };
        draft = dr;
        return `<tr class="lrr-edit-tr"><td colspan="13"><div class="lrr-edit" data-lrr-edit="${esc(r.key)}">
            <div class="lrr-ei"><span class="lrr-el">Согласовали</span><div class="lrr-tg"><button type="button" class="${dr.agree === true ? 'on' : ''}" data-lrr-agree="1">Да</button><button type="button" class="${dr.agree === false ? 'on' : ''}" data-lrr-agree="0">Нет</button></div></div>
            <div class="lrr-ei"><span class="lrr-el">мест</span><input type="text" inputmode="numeric" id="lrr-places" value="${esc(dr.places)}" style="width:70px"></div>
            <div class="lrr-ei"><span class="lrr-el">тариф, ₽</span><input type="text" inputmode="numeric" id="lrr-fare" value="${esc(dr.fare)}" style="width:100px"></div>
            <div class="lrr-ei lrr-bt"><button type="button" class="btn-primary lrr-sv" data-lrr-save="${esc(r.key)}">Сохранить</button><button type="button" class="filter-btn" data-lrr-cancel="1">Отмена</button>${r.edited ? `<button type="button" class="filter-btn" data-lrr-reset="${esc(r.key)}">Вернуть автоматическое</button>` : ''}</div>
            <div class="lrr-en">Автоматически: ${esc(r.autoText)}</div>
        </div></td></tr>`;
    }

    // что просили - из 'Запроса на понижение'; согласовано - пометка, или значения, если правили или считали по продажам
    function askParts(r) {
        const asked = r.ask ? 'просили: ' + whatText({ places: r.ask.places, fare: r.ask.fare, est: false }) : '';
        let agreed = '';
        let est = false;
        if (r.res === 'yes') {
            if (r.edited && r.what) agreed = 'согласовано: ' + whatText(r.what);
            else if (r.ask) agreed = 'согласовано';
            else if (r.what) { agreed = 'согласовано: ' + whatText(r.what); est = !!r.what.est; }
            else agreed = 'согласовано';
        }
        return { asked, agreed, est };
    }

    function rowHtml(r) {
        const st = stateOf(r.res);
        const pct = r.sold != null && r.seats > 0 ? `<span class="lrr-pc">${Math.round(r.sold / r.seats * 100)}%</span>` : '';
        const load = r.sold != null ? `<b>${r.approx ? '≈ ' : ''}${fmt(r.sold)}</b>${r.seats ? ' из ' + fmt(r.seats) : ''}${pct}` : '<span class="lrr-mut">—</span>';
        const ap = askParts(r);
        const what = ap.asked || ap.agreed
            ? (ap.asked ? `<span class="lrr-wh">${esc(ap.asked)}</span>` : '') + (ap.agreed ? `<span class="lrr-agr">${esc(ap.agreed)}</span>` : '') + (ap.est ? '<span class="lrr-es">оценка</span>' : '')
            : '<span class="lrr-mut">—</span>';
        const A = r.approx ? '≈ ' : '';
        const open = editKey === r.key;
        const tr = `<tr data-lrr-row="${esc(r.key)}" class="${open ? 'lrr-open' : ''}${r.edited ? ' lrr-ed-row' : ''}">
            <td class="lrr-dt">${esc(r.check)}${r.approx ? '<span class="lrr-apx">примерно</span>' : ''}</td>
            <td class="lrr-fl"><b class="lrr-code" data-lrr-code="${esc(r.code)}" data-lrr-dep="${esc(r.dep)}">${esc(r.code)}</b>${r.route ? `<span class="lrr-rt">${esc(r.route)}</span>` : ''}</td>
            <td class="lrr-dt">${esc(r.dep)}</td>
            <td class="lrr-ld">${load}</td>
            ${r.terms.map(t => termHtml(t, r.seats, r.approx)).join('')}
            <td class="lrr-ld">${r.curSold != null ? `<b>${fmt(r.curSold)}</b>${r.curSeats ? ' из ' + fmt(r.curSeats) : ''}${r.curSeats > 0 ? `<span class="lrr-pc">${Math.round(r.curSold / r.curSeats * 100)}%</span>` : ''}` : '<span class="lrr-mut">—</span>'}</td>
            <td class="lrr-rub">${r.expRev != null && r.approx ? '≈ ' : ''}${fmt(r.expRev)}</td>
            <td class="lrr-rub">${fmt(r.curRev)}</td>
            <td class="lrr-ag"><span class="lrr-pl lrr-pl-${st.cls}">${st.text}</span>${r.edited ? '<span class="lrr-ed">исправлено вручную</span>' : ''}</td>
            <td class="lrr-wt"><div class="lrr-wtin"><div>${what}</div>${canEditRows() ? `<button type="button" class="lrr-edit-btn" data-lrr-open="${esc(r.key)}">править</button>` : ''}</div></td></tr>`;
        return tr + (open ? editHtml(r) : '');
    }

    function tableBodyHtml(list) {
        if (!list.length) return `<tr><td colspan="13" class="lrr-empty">${rows().length ? 'По выбранным условиям запросов нет.' : 'Запросов пока нет: они появляются, когда администратор отмечает вылет «Обратить внимание».'}</td></tr>`;
        return list.map(rowHtml).join('');
    }

    function seg(attr, val, cur, text) {
        return `<button type="button" class="filter-btn${String(val) === String(cur) ? ' filter-btn-active' : ''}" data-lrr-${attr}="${val}">${text}</button>`;
    }

    function prepare(rerender) {
        if (!store.loaded || Date.now() - store.at > STALE_MS) {
            loadStore(true).then(changed => { if (changed && typeof lastRerender === 'function' && document.querySelector('.lrr-card')) lastRerender(); });
        }
        if (!lrReady && typeof LowerRequest !== 'undefined' && LowerRequest.ensureLoaded) {
            LowerRequest.ensureLoaded().then(() => { lrReady = true; memo.sig = ''; if (document.querySelector('.lrr-card') && lastRerender) lastRerender(); }).catch(() => { lrReady = true; });
        }
        // журнал и архив по месяцам вылетов: для выручки и значений, которых нет в файле продаж
        const months = [...new Set(rows().map(r => monthOf(r.dep)).filter(Boolean))].filter(m => !asked.has(m));
        if (months.length) {
            months.forEach(m => asked.add(m));
            Promise.all([
                typeof SalesDayLog !== 'undefined' ? SalesDayLog.ensureMonths(months).catch(() => false) : false,
                typeof SalesArchive !== 'undefined' ? SalesArchive.ensureMonths(months).catch(() => false) : false
            ]).then(([a, b]) => { if ((a || b) && document.querySelector('.lrr-card') && lastRerender) { memo.sig = ''; lastRerender(); } });
        }
        // публикующий дописывает общий файл при открытии, не чаще раза на новые данные
        if (canWriteShared() && Date.now() - lastTry > 60000) { lastTry = Date.now(); capture(); }
    }

    // таблица до низа окна; обе строки шапки закреплены
    function fitTable(sc) {
        const top = sc.getBoundingClientRect().top;
        sc.style.maxHeight = Math.max(320, Math.round(window.innerHeight - top - 24)) + 'px';
        const r1 = sc.querySelector('thead tr');
        if (r1) sc.querySelectorAll('thead tr:nth-child(2) th').forEach(th => { th.style.top = r1.getBoundingClientRect().height + 'px'; });
    }
    window.addEventListener('resize', () => { const sc = document.querySelector('.lrr-card .rp-scroll'); if (sc) fitTable(sc); });

    function html(rerender) {
        if (typeof rerender === 'function') lastRerender = rerender;
        if (!available()) return '<p class="rp-note">Отчёт недоступен.</p>';
        prepare(rerender);
        const sc0 = document.querySelector('.lrr-card .rp-scroll');
        const keep = sc0 ? sc0.scrollTop : 0;   // новые сверху; при перерисовке держим прокрутку
        setTimeout(() => {
            const sc = document.querySelector('.lrr-card .rp-scroll');
            if (!sc) return;
            fitTable(sc);
            sc.scrollTop = keep;
        }, 40);
        const d = derive();
        const inP = inPeriod(rows());
        const t = totals(inP);
        const list = filtered();
        const tile = (label, valueHtml, sub, tone) => `<div class="rp-tile${tone ? ' rp-tile-' + tone : ''}"><div class="rp-tile-label">${esc(label)}</div><div class="rp-tile-value">${valueHtml}</div><div class="rp-tile-sub">${esc(sub)}</div></div>`;
        const tilesHtml = `<div class="rp-tiles lrr-tiles">${[
            tile('Запросов за период', String(t.n), 'отметок «Обратить внимание»'),
            tile('Согласовано', `${t.yes}${t.n ? ` <span class="lrr-tpct">${Math.round(t.yes / t.n * 100)}%</span>` : ''}`, 'поставлено «Снижение» в течение 2 дней', 'ok'),
            tile('Не согласовано', String(t.no), '«Снижения» не было'),
            tile('Ждём ответа', String(t.wait), '2 дня на ответ ещё не прошли', 'warn')
        ].join('')}</div>`;
        const sign = t.diff > 0 ? '+' : (t.diff < 0 ? '−' : '');
        const diffCls = t.diff > 0 ? 'lrr-pos' : (t.diff < 0 ? 'lrr-neg' : '');
        const diffLine = t.diffN
            ? `Разница выручки к ожидаемой по согласованным: <b class="${diffCls}">${sign}${fmt(Math.abs(t.diff))} ₽</b>${t.diffN < t.yes ? ` <span class="lrr-mut">(посчитано по ${t.diffN} из ${t.yes})</span>` : ''}`
            : 'Разница выручки к ожидаемой по согласованным: <b>—</b>';
        const exp = canExport();
        const note = !d.known ? '<p class="rp-note rp-warn">Список профилей не загружен — администратора среди авторов отметок определить нельзя, запросов не видно.</p>' : '';
        return `<div class="lrr-wrap">${note}${tilesHtml}
            <div class="lrr-sumline">${diffLine}</div>
            <section class="rp-card lrr-card">
                <div class="lrr-ctl">
                    <h3 class="lrr-title">Запросы на снижение</h3>
                    <div class="dr-seg"><span class="dr-seg-label">Период</span>${PERIODS.map(p => seg('period', CustomPeriod.on('low') ? 'x' + p : p, CustomPeriod.on('low') ? '' : period, p ? p + ' дн.' : 'всё время').replace('data-lrr-period="x', 'data-lrr-period="')).join('')}${CustomPeriod.buttonHtml('low')}${CustomPeriod.inputsHtml('low')}</div>
                    <div class="dr-seg"><span class="dr-seg-label">Показать</span>${[['', 'все'], ['yes', 'согласовано'], ['no', 'не согласовано'], ['wait', 'ждём']].map(([v, tx]) => seg('show', v, show, tx)).join('')}</div>
                    <input type="text" class="lrr-q" id="lrr-q" placeholder="Рейс, например KV-101" value="${esc(query)}" autocomplete="off">
                    <span class="lrr-sp"></span>
                    ${exp ? `<button type="button" class="btn-primary rp-btn" id="lrr-export"${list.length ? '' : ' disabled'}>В Excel</button>` : ''}
                </div>
                <div class="rp-scroll"><table class="lrr-table"><thead>
                    <tr><th rowspan="2" class="lrr-w-dt">Дата запроса</th><th rowspan="2" class="lrr-w-fl">Рейс</th><th rowspan="2" class="lrr-w-dt">Дата рейса</th><th rowspan="2" class="lrr-w-ld">Загрузка на момент запроса</th><th colspan="4" class="lrr-grp">Ожидаемая загрузка, мест</th><th rowspan="2" class="lrr-w-ld">Текущая загрузка</th><th rowspan="2" class="lrr-w-rub">Ожидаемая выручка на вылете, ₽</th><th rowspan="2" class="lrr-w-rub">Текущая выручка, ₽</th><th rowspan="2" class="lrr-w-ag">Согласовали</th><th rowspan="2" class="lrr-w-wt">Что просили / что согласовали</th></tr>
                    <tr><th>за 14 дн.</th><th>за 7 дн.</th><th>за 3 дн.</th><th>на вылете</th></tr></thead>
                    <tbody id="lrr-body">${tableBodyHtml(list)}</tbody></table></div>
                ${list.some(r => r.approx) ? '<p class="lrr-foot"><span class="lrr-apx">примерно</span> — запрос найден позже, цифры восстановлены по истории продаж</p>' : ''}
            </section></div>`;
    }

    function saveView() { try { localStorage.setItem(VIEW_KEY, JSON.stringify({ period, show })); } catch (e) { /* ignore */ } }

    function readDraft() {
        if (!draft) return;
        const p = document.getElementById('lrr-places');
        const f = document.getElementById('lrr-fare');
        if (p) draft.places = p.value;
        if (f) draft.fare = f.value;
    }
    function numOrNull(v) {
        const s = String(v == null ? '' : v).replace(/[\s ]/g, '').replace(',', '.');
        if (!s) return null;
        const n = Number(s);
        return Number.isFinite(n) && n >= 0 ? Math.round(n) : NaN;
    }

    function handleClick(btn, rerender) {
        const ds = btn.dataset;
        if (ds.lrrPeriod != null) { CustomPeriod.set('low', { on: false }); period = parseInt(ds.lrrPeriod, 10) || 0; saveView(); rerender(); return true; }
        if (ds.lrrShow != null) { show = ds.lrrShow; saveView(); rerender(); return true; }
        if (ds.lrrOpen) { editKey = editKey === ds.lrrOpen ? '' : ds.lrrOpen; draft = null; rerender(); return true; }
        if (ds.lrrCancel) { editKey = ''; draft = null; rerender(); return true; }
        if (ds.lrrAgree != null) { readDraft(); if (draft) draft.agree = ds.lrrAgree === '1'; rerender(); return true; }
        if (ds.lrrReset) {
            btn.disabled = true;
            saveOver(ds.lrrReset, null).then(ok => { if (ok) { editKey = ''; draft = null; toast('Возвращено автоматическое значение'); } else toast('Не удалось сохранить: нет доступа к общей папке', 'error'); })
                .finally(rerender);
            return true;
        }
        if (ds.lrrSave) {
            readDraft();
            if (!draft || draft.agree == null) { toast('Выберите «Да» или «Нет»', 'error'); return true; }
            const places = numOrNull(draft.places);
            const fare = numOrNull(draft.fare);
            if (Number.isNaN(places) || Number.isNaN(fare)) { toast('Места и тариф — числом', 'error'); return true; }
            const over = { agree: draft.agree };
            if (draft.agree) { if (places != null) over.places = places; if (fare != null) over.fare = fare; }
            btn.disabled = true;
            saveOver(ds.lrrSave, over).then(ok => { if (ok) { editKey = ''; draft = null; toast('Сохранено'); } else toast('Не удалось сохранить: нет доступа к общей папке', 'error'); })
                .finally(rerender);
            return true;
        }
        return false;
    }

    function handleInput(target) {
        if (!target) return false;
        if (target.id === 'lrr-q') {
            query = target.value;
            const body = document.getElementById('lrr-body');
            if (body) body.innerHTML = tableBodyHtml(filtered());
            const ex = document.getElementById('lrr-export');
            if (ex) ex.disabled = !filtered().length;
            return true;
        }
        if (target.id === 'lrr-places' || target.id === 'lrr-fare') { readDraft(); return true; }
        return false;
    }

    // двойной клик: по номеру рейса - карточка, по строке - правка
    function handleDblClick(event) {
        const code = event.target.closest && event.target.closest('[data-lrr-code]');
        if (code) {
            if (typeof FlightCard === 'undefined' || !FlightCard.maybeOpen) return true;
            if (!FlightCard.maybeOpen(code.dataset.lrrCode, code.dataset.lrrDep) && typeof showToast === 'function') toast('Карточка рейса скрыта — покажите её кнопкой ▤ у имени в шапке', 'info');
            return true;
        }
        const tr = event.target.closest && event.target.closest('tr[data-lrr-row]');
        if (tr && canEditRows() && !event.target.closest('button,input')) {
            editKey = tr.dataset.lrrRow;
            draft = null;
            if (lastRerender) lastRerender();
            return true;
        }
        return false;
    }

    document.addEventListener('krasavia:lowrep', () => {
        if (typeof currentTab !== 'undefined' && currentTab !== 'reports') return;
        if (lastRerender && document.querySelector('.lrr-card') && !editKey) lastRerender();
    });
    let markTimer = null;
    document.addEventListener('krasavia:lowreq', () => {
        if (typeof currentTab !== 'undefined' && currentTab !== 'reports') return;
        if (lastRerender && document.querySelector('.lrr-card') && !editKey) lastRerender();
    });
    document.addEventListener('krasavia:mark', () => {
        if (!lastRerender) return;
        clearTimeout(markTimer);
        markTimer = setTimeout(() => {
            if (typeof currentTab !== 'undefined' && currentTab !== 'reports') return;
            if (!document.querySelector('.lrr-card') || editKey) return;
            lastRerender();
        }, 600);
    });

    // для Excel: строки текущего отбора, как на экране
    function exportData() {
        const list = filtered();
        return {
            period: CustomPeriod.on('low') ? CustomPeriod.label('low') : (period ? period + ' дн.' : 'всё время'),
            show: { '': 'все', yes: 'согласовано', no: 'не согласовано', wait: 'ждём' }[show],
            query: query.trim(),
            totals: totals(inPeriod(rows())),
            rows: list.map(r => ({
                check: r.check, code: r.code, route: r.route, dep: r.dep,
                sold: r.sold, seats: r.seats,
                terms: r.terms, seatsForPct: r.seats,
                expRev: r.expRev, curRev: r.curRev, curSold: r.curSold, curSeats: r.curSeats,
                res: r.res, resText: stateOf(r.res).text, edited: r.edited,
                what: (() => { const ap = askParts(r); return [ap.asked, ap.agreed].filter(Boolean).join('\n'); })(), est: askParts(r).est, approx: r.approx
            }))
        };
    }

    return { canView, html, handleClick, handleInput, handleDblClick, captureSoon, capture, exportData, revision: () => rev + ':' + lrRev() + ':' + CustomPeriod.sig('low') };
})();
