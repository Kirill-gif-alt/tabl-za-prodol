"""Unconstraining (восстановление неограниченного спроса) для модели «спрос от цены».

Запуск:  PM_DATA=... python3 unconstrain.py      → таблицы в scratchpad/pm/out/unc/ (или PM_OUT)

Что делает:
 1. Цензура по ёмкости, уровень ВЫЛЕТА (hist.csv): наблюдаемые бронирования y (валовые билеты, как в кривой)
    при полной загрузке (нетто ≥ cap−1) — лишь нижняя граница спроса D ≥ y. Методы:
      naive    — D̂ = y;
      curve    — досчёт по доле кривой: D̂ = B(t*) / F(t*), t* — день до вылета, когда продажи достигли ёмкости,
                 F(t) — средняя доля итога, накопленная к t (по нераспроданным вылетам того же класса ВС);
      em_pois  — EM для Пуассона с правым цензурированием (группа = рейс×ёмкость×месяц);
      ml_nb    — отриц. биномиальное (НБ) с цензурированием, максимум правдоподобия (то, к чему сходится EM);
      pd       — Projection Detruncation (Hopperstad–Weatherford), τ = 0.5.
 2. Тест: нераспроданные вылеты, ёмкость искусственно урезана (до 80% факта у трети вылетов и до 80% ёмкости ВС),
    восстанавливаем и сравниваем с известным фактом.
 3. Уровень ДНЯ (дневная панель common.build_panel): день распродажи, флаг cens_cap, bookings_unc.
 4. Закрытие классов из продаж: минимальная цена/класс дня vs «обычный минимум» направления и вылета.

API для команды:
    unconstrained_final(departures_like) -> Series D̂   (нужны: flight, fly_date, cap, y[, curve])
    unconstrained_daily(panel)          -> panel + cens_cap, soldout_dtd, bookings_unc, cheap_closed, ...
"""
import json
import os

import numpy as np
import pandas as pd
from scipy import optimize, stats

from common import build_panel, data_dir, load

OUT = os.environ.get("PM_OUT") or os.path.join(os.path.dirname(data_dir()), "out", "unc")
TAU = 0.5
MIN_GROUP = 8
CAP_EPS = 1          # «распродан»: нетто ≥ cap − 1


# ---------------------------------------------------------------- данные уровня вылета
def load_hist(dep):
    """hist.csv + ёмкость. Ёмкость: из departures на ту же дату, иначе мода ёмкости рейса в departures (допущение)."""
    h = pd.read_csv(os.path.join(data_dir(), "hist.csv"), parse_dates=["fly_date"])
    exact = dep.set_index(["flight", "fly_date"]).cap
    exact = exact[~exact.index.duplicated()]
    mode = dep.groupby("flight").cap.agg(lambda s: s.mode().iloc[0])
    cls = dep.groupby("flight").cap_class.agg(lambda s: s.mode().iloc[0])
    h["cap"] = [exact.get((f, d), np.nan) for f, d in zip(h.flight, h.fly_date)]
    h["cap_src"] = np.where(h.cap.notna(), "exact", "flight_mode")
    h["cap"] = h.cap.fillna(h.flight.map(mode))
    h["cap_class"] = h.flight.map(cls)
    h = h[h.cap.notna()].copy()
    h["curve"] = h.curve.map(lambda s: {int(k): v for k, v in json.loads(s).items()})
    h["y"] = h.tickets.astype(int)                    # валовые бронирования (единица спроса)
    h["net"] = h.tickets - h.refunded
    # явная несостыковка ёмкости (мода не та ВС) — выкидываем
    h = h[(h.net <= h.cap * 1.1) & (h.y > 0)].copy()
    h["censored"] = h.net >= h.cap - CAP_EPS
    h["month"] = h.fly_date.dt.month
    h["grp"] = h.flight + "|" + h.cap.astype(int).astype(str) + "|" + h.month.astype(str)
    h["grp2"] = h.flight + "|" + h.cap.astype(int).astype(str)
    return h.reset_index(drop=True)


def cum_from_curve(c, tmax=120):
    """B(t) = бронирований к дню t до вылета включительно (накоплено со стороны дальних дней), t = 0..tmax."""
    a = np.zeros(tmax + 2)
    for k, v in c.items():
        a[min(max(k, 0), tmax)] += v
    return np.cumsum(a[::-1])[::-1][: tmax + 1]       # B[t] = сумма дней ≥ t


def profile(h, tmax=120):
    """F(t) по классу ВС = Σ B_i(t) / Σ B_i(0) по нецензурированным вылетам."""
    out = {}
    for cc, g in h[~h.censored].groupby("cap_class"):
        B = np.vstack([cum_from_curve(c, tmax) for c in g.curve])
        out[cc] = B.sum(0) / max(B[:, 0].sum(), 1)
    allB = np.vstack([cum_from_curve(c, tmax) for c in h[~h.censored].curve])
    out["all"] = allB.sum(0) / allB[:, 0].sum()
    return out


# ---------------------------------------------------------------- методы
def em_poisson(y, cens, it=200):
    mu = max(y.mean(), 0.5)
    for _ in range(it):
        # E[D | D ≥ c] для Пуассона = μ · P(D ≥ c−1) / P(D ≥ c)
        tail = stats.poisson.sf(y - 1, mu)
        e = np.where(cens, mu * stats.poisson.sf(y - 2, mu) / np.maximum(tail, 1e-300), y)
        new = e.mean()
        if abs(new - mu) < 1e-6:
            break
        mu = new
    return mu, e


def nb_cond_mean(c, mu, k, hi):
    n, p = k, k / (k + mu)
    xs = np.arange(0, hi + 1)
    pm = stats.nbinom.pmf(xs, n, p)
    res = []
    for ci in c:
        m = xs >= ci
        s = pm[m].sum()
        tail_mass = stats.nbinom.sf(hi, n, p)
        res.append(((xs[m] * pm[m]).sum() + tail_mass * (hi + 1)) / max(s + tail_mass, 1e-300) if s + tail_mass > 0 else ci)
    return np.array(res)


def ml_nb(y, cens):
    """Максимум правдоподобия НБ(μ, k) с правым цензурированием: Σ log p(y) [точные] + Σ log P(D ≥ y) [цензур.]."""
    def nll(th):
        mu, k = np.exp(th)
        p = k / (k + mu)
        ll = np.where(cens, stats.nbinom.logsf(y - 1, k, p), stats.nbinom.logpmf(y, k, p))
        return -ll.sum()
    r = optimize.minimize(nll, [np.log(max(y.mean(), 0.5)), np.log(5.0)], method="Nelder-Mead",
                          options={"maxiter": 400, "xatol": 1e-4, "fatol": 1e-6})
    mu, k = np.exp(r.x)
    k = min(k, 1e4)
    e = np.where(cens, nb_cond_mean(y, mu, k, int(max(y.max(), mu) * 4 + 20)), y)
    return mu, e


def projection_detruncation(y, cens, tau=TAU, it=100):
    """Hopperstad–Weatherford: D ~ N(μ,σ); цензурированное значение заменяется точкой x, выше которой лежит
    доля τ «хвоста» над текущим значением: P(D > x) = τ·P(D > z), итерации до сходимости."""
    z = y.astype(float).copy()
    for _ in range(it):
        mu, sd = z.mean(), max(z.std(ddof=1) if len(z) > 1 else 1.0, 1.0)
        tail = stats.norm.sf((y - mu) / sd)
        x = mu + sd * stats.norm.isf(np.clip(tau * tail, 1e-12, 1))
        new = np.where(cens, np.maximum(y, x), y)
        if np.abs(new - z).max() < 1e-4:
            z = new
            break
        z = new
    return z


def booking_curve(h, prof):
    """D̂ = B(t*) / F(t*), t* — самый дальний день, когда накоплено ≥ ёмкости (c)."""
    res = []
    for c, cc, curve, y, cen in zip(h.c, h.cap_class, h.curve, h.y, h.censored):
        if not cen:
            res.append(y); continue
        B = cum_from_curve(curve)
        F = prof.get(cc, prof["all"])
        idx = np.where(B >= c)[0]
        ts = idx.max() if len(idx) else 0
        res.append(max(y, B[ts] / max(F[ts], 0.05)) if ts > 0 else y)
    return np.array(res, float)


def run_methods(h, prof):
    """h: y (наблюдаемое, урезанное), c (ёмкость для цензуры), censored, grp, grp2, curve, cap_class."""
    h = h.copy()
    big = h.groupby("grp").y.transform("size") >= MIN_GROUP
    h["g"] = np.where(big, h.grp, h.grp2)
    h["naive"] = h.y.astype(float)
    h["curve_m"] = booking_curve(h, prof)
    for col in ["em_pois", "ml_nb", "pd"]:
        h[col] = h.y.astype(float)
    for _, idx in h.groupby("g").groups.items():
        g = h.loc[idx]
        y, cen = g.y.values.astype(int), g.censored.values
        if not cen.any():
            continue
        if cen.all():   # все распроданы — оценить нечем, оставляем факт (честно)
            continue
        h.loc[idx, "em_pois"] = em_poisson(y, cen)[1]
        h.loc[idx, "ml_nb"] = ml_nb(y, cen)[1]
        h.loc[idx, "pd"] = projection_detruncation(y, cen)
    return h


METHODS = ["naive", "curve_m", "em_pois", "ml_nb", "pd"]


def unconstrained_final(df, method="ml_nb", hist=None):
    """Неограниченный спрос к вылету. df: flight, fly_date, cap, y (бронирования), [net], [curve].
    Вылеты из df оцениваются вместе с историей (hist) своей группы. Возвращает Series D̂ (index df)."""
    t, dep, cutoff, meta = load()
    h = hist if hist is not None else load_hist(dep)
    d = df.copy()
    d["net"] = d.get("net", d.y)
    d["censored"] = d.net >= d.cap - CAP_EPS
    d["month"] = pd.to_datetime(d.fly_date).dt.month
    d["grp"] = d.flight + "|" + d.cap.astype(int).astype(str) + "|" + d.month.astype(str)
    d["grp2"] = d.flight + "|" + d.cap.astype(int).astype(str)
    d["cap_class"] = d.get("cap_class", d.cap)
    if "curve" not in d:
        d["curve"] = [{0: v} for v in d.y]
    d["_new"] = True
    base = h.assign(_new=False)
    allx = pd.concat([base, d[base.columns.intersection(d.columns)]], ignore_index=True)
    allx["c"] = allx.cap - CAP_EPS
    r = run_methods(allx, profile(h))
    return pd.Series(r.loc[r._new.values, method].values, index=df.index)


# ---------------------------------------------------------------- уровень дня
def unconstrained_daily(panel, hist=None, prof=None):
    """Добавляет в панель:
      soldout_dtd  — день до вылета, к которому накоплено ≥ кресел в продаже (seats) − 1 (NaN — не распродан)
      cens_cap     — 1 в дни ПОСЛЕ распродажи (dtd < soldout_dtd): нулевые продажи — не отсутствие спроса
      bookings_unc — бронирования без цензуры: факт в открытые дни; в цензурированные — D̂·(F(t)−F(t−1)), где
                     D̂ = (продано к распродаже)/F(soldout_dtd) — досчёт по кривой класса ВС
      min_price_day, route_min_typ, cheap_closed, dep_floor_up — признаки закрытия дешёвых классов (см. записку)."""
    p = panel.copy()
    if prof is None:
        t, dep, cutoff, meta = load()
        prof = profile(hist if hist is not None else load_hist(dep))
    p = p.sort_values(["flight", "fly_date", "dtd"], ascending=[True, True, False])
    p["cum"] = p.sold_before + p.bookings
    lim = p.seats.fillna(p.cap) - CAP_EPS
    so = p[p.cum >= lim].groupby(["flight", "fly_date"]).dtd.max().rename("soldout_dtd")
    p = p.drop(columns=[c for c in ["soldout_dtd"] if c in p]).merge(so, on=["flight", "fly_date"], how="left")
    p["cens_cap"] = (p.dtd < p.soldout_dtd).astype(int)
    p["bookings_unc"] = p.bookings.astype(float)
    m = p.cens_cap == 1
    if m.any():
        key = p.cap_class.where(p.cap_class.isin(list(prof)), "all")
        F = np.array([prof[k][min(int(t), 120)] for k, t in zip(key, p.dtd)])
        Fprev = np.array([prof[k][min(int(t) + 1, 120)] for k, t in zip(key, p.dtd)])
        Fso = np.array([prof[k][min(int(t), 120)] if t == t else 1 for k, t in zip(key, p.soldout_dtd.fillna(0))])
        sold_at = p.groupby(["flight", "fly_date"]).cum.transform("max")
        D = sold_at / np.maximum(Fso, 0.05)
        p.loc[m, "bookings_unc"] = (D * np.maximum(F - Fprev, 0))[m.values]
    # --- закрытие классов из продаж
    p["min_price_day"] = p.price_seen
    obs = p[p.price_seen.notna()]
    typ = obs.groupby(["route", "hb"]).price_seen.quantile(0.10).rename("route_min_typ")
    p = p.merge(typ, left_on=["route", "hb"], right_index=True, how="left")
    p["cheap_closed"] = np.where(p.price_seen.notna(), (p.price_seen > p.route_min_typ * 1.02).astype(float), np.nan)
    # на этом вылете раньше продавали дешевле, а сегодня — только дороже (минимум «поднялся»)
    prev_min = p.groupby(["flight", "fly_date"]).price_seen.transform(lambda s: s.cummin().shift())
    p["dep_floor_up"] = np.where(p.price_seen.notna() & prev_min.notna(),
                                 (p.price_seen > prev_min * 1.02).astype(float), np.nan)
    p["price_step_up"] = p.price_seen / p.route_min_typ        # «цена дня» относительно обычного минимума
    return p.drop(columns=["cum"])


# ---------------------------------------------------------------- тест
def err(tr, est):
    e = est - tr
    return {"n": len(e), "MAE": np.abs(e).mean(), "bias": e.mean(), "MAPE%": 100 * np.mean(np.abs(e) / tr)}


def censor_test(h, prof_src, how, seed=0):
    rng = np.random.default_rng(seed)
    u = h[~h.censored].copy()
    true = u.y.values.astype(float)
    if how == "0.8y_third":
        pick = rng.random(len(u)) < 1 / 3
        c = np.where(pick, np.floor(0.8 * true), np.inf)
    else:   # 0.8·cap
        c = np.floor(0.8 * u.cap.values)
    c = np.maximum(c, 1)
    u["censored"] = true >= c
    u["y"] = np.minimum(true, c).astype(int)
    u["c"] = np.where(np.isinf(c), u.cap, c)
    u["curve"] = [trunc_curve(cv, ci) if cen else cv for cv, ci, cen in zip(u.curve, c, u.censored)]
    prof = profile(u.assign(censored=u.censored)) if prof_src is None else prof_src
    r = run_methods(u, prof)
    m = u.censored.values
    rows = []
    for meth in METHODS:
        d = err(true[m], r[meth].values[m])
        d.update(method=meth, scenario=how, total_bias_pct=100 * (r[meth].values.sum() - true.sum()) / true.sum())
        rows.append(d)
    return pd.DataFrame(rows), m.sum(), len(u)


def trunc_curve(cv, c):
    """Обрезать кривую: бронирования идут от дальних дней к ближним, пока не наберётся c."""
    out, s = {}, 0
    for k in sorted(cv, reverse=True):
        v = min(cv[k], max(c - s, 0))
        if v > 0:
            out[k] = v
        s += v
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    t, dep, cutoff, meta = load()
    h = load_hist(dep)
    h["c"] = h.cap - CAP_EPS
    print(f"hist: вылетов с ёмкостью {len(h)} (точная ёмкость {np.mean(h.cap_src == 'exact'):.0%}); "
          f"распроданы (нетто ≥ cap−1): {h.censored.sum()} = {h.censored.mean():.1%}")
    print(h.groupby("cap_class").censored.agg(["size", "mean"]).round(3).to_string())
    prof = profile(h)

    # 1. Реальное восстановление
    r = run_methods(h, prof)
    cen = r[r.censored]
    summ = pd.DataFrame({m: [r[m].sum(), cen[m].sum(), (cen[m] - cen.y).mean()] for m in METHODS},
                        index=["Σ спрос, все", "Σ по распроданным", "добавка на распроданный"]).T
    print("\nВосстановление на истории:\n", summ.round(1).to_string())
    r.drop(columns=["curve"]).to_csv(os.path.join(OUT, "final_unc.csv"), index=False)
    summ.to_csv(os.path.join(OUT, "final_summary.csv"))

    # 2. Тест с искусственным урезанием
    res = []
    for how in ["0.8y_third", "0.8cap"]:
        for seed in range(3):
            df, ncens, n = censor_test(h, None, how, seed)
            df["seed"], df["n_cens"], df["n_all"] = seed, ncens, n
            res.append(df)
            if how == "0.8cap":
                break
    res = pd.concat(res)
    tab = res.groupby(["scenario", "method"])[["n", "MAE", "bias", "MAPE%", "total_bias_pct"]].mean().round(2)
    print("\nТЕСТ (ошибка на урезанных вылетах; total_bias_pct — смещение суммарного спроса):\n", tab.to_string())
    tab.to_csv(os.path.join(OUT, "test.csv"))

    # 3–4. Дневной уровень и закрытие классов
    panel = build_panel(t, dep, cutoff)
    pu = unconstrained_daily(panel, prof=prof)
    pu.to_csv(os.path.join(OUT, "panel_unc.csv.gz"), index=False, compression="gzip")
    nd = pu.groupby(["flight", "fly_date"]).soldout_dtd.first()
    print(f"\nПанель: вылетов {len(nd)}, распродано {nd.notna().sum()} ({nd.notna().mean():.1%}); "
          f"дней с cens_cap {pu.cens_cap.sum()} ({pu.cens_cap.mean():.2%}); "
          f"Σbookings {pu.bookings.sum()} → Σbookings_unc {pu.bookings_unc.sum():.0f}")
    print("Медиана дня распродажи (dtd):", nd.median())
    o = pu[pu.price_seen.notna()]
    print(f"Дни с платной взрослой продажей: {len(o)}; cheap_closed (мин. цена дня > 10%-квантиля направления×горизонт): "
          f"{o.cheap_closed.mean():.1%}; dep_floor_up (минимум вылета поднялся): {o.dep_floor_up.mean():.1%}")
    by = o.groupby("hb")[["cheap_closed", "dep_floor_up", "price_step_up"]].mean().round(3)
    print(by.to_string())
    by.to_csv(os.path.join(OUT, "class_closure_by_horizon.csv"))
    # минимальный класс дня (по rbd билетов)
    tt = t[t.adult & t.paid].copy()
    tt["cls"] = tt.rbd.str[0]
    dmin = tt.loc[tt.groupby(["flight", "fly_date", "dtd"]).fare.idxmin(), ["flight", "fly_date", "dtd", "cls", "fare", "route"]]
    dmin.to_csv(os.path.join(OUT, "day_min_class.csv"), index=False)
    print("Мин. класс дня, топ:", dmin.cls.value_counts().head(8).to_dict())


if __name__ == "__main__":
    main()
