"""Ценовая эластичность спроса (эконометрист). Запуск: PM_DATA=... python3 elasticity.py

Модель: bookings_{i,t} ~ Poisson(λ) (QMLE, кластерные по вылету SE — устойчиво к сверхдисперсии NegBin),
  log λ = α_g + γ_{dtd-bin} + δ_dow + μ_month + κ_cap + Σ_h β_h·1[h]·log p_{i,t}
α_g — ФЭ направления или ФЭ вылета (условный Poisson: ФЭ сокращаются концентрированием правдоподобия).
p — индекс цены: «стоящая» цена на начало дня (последняя виденная до дня t) / опорный тариф направления.
Выход: out/econ/*.csv, coefs.json; функция demand_rate(df, price) -> λ.
"""
import json, os, sys
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import load, build_panel, data_dir

OUT = os.environ.get("PM_OUT") or os.path.join(os.path.dirname(data_dir().rstrip("/")), "out", "econ")
HB = ["far(22+)", "mid(8-21)", "near(0-7)"]
DTD_EDGES = [-1, 0, 1, 2, 3, 7, 14, 21, 35, 60, 90, 999]


def dtd_bin(d):
    return pd.cut(d, DTD_EDGES, labels=[f"d{a+1}_{b}" for a, b in zip(DTD_EDGES[:-1], DTD_EDGES[1:])]).astype(str)


# ---------------- ядро: Poisson с поглощёнными ФЭ (концентрированное правдоподобие) ----------------
def fe_poisson(y, X, g, cl, iters=60):
    """y (n,), X (n,k) без константы, g — коды ФЭ-групп, cl — коды кластеров. Возвращает beta, cov (кластерный)."""
    y = np.asarray(y, float); X = np.asarray(X, float)
    n_g = np.bincount(g, weights=y); keep = n_g[g] > 0
    y, X, g, cl = y[keep], X[keep], g[keep], cl[keep]
    _, g = np.unique(g, return_inverse=True); n_g = np.bincount(g, weights=y)
    b = np.zeros(X.shape[1])
    for _ in range(iters):
        eta = X @ b; eta -= eta.max()
        mu = np.exp(eta); S = np.bincount(g, weights=mu); p = mu / S[g]
        r = y - n_g[g] * p
        score = X.T @ r
        px = X * p[:, None]
        mx = np.vstack([np.bincount(g, weights=px[:, j]) for j in range(X.shape[1])]).T  # E_g[x]
        H = -(X.T @ (px * n_g[g][:, None])) + (mx.T * n_g) @ mx
        step = np.linalg.solve(H, score)
        b -= step
        if np.abs(step).max() < 1e-9: break
    si = X * r[:, None]
    _, cl = np.unique(cl, return_inverse=True)
    sc = np.vstack([np.bincount(cl, weights=si[:, j]) for j in range(X.shape[1])]).T
    Hi = np.linalg.inv(H)
    G = sc.shape[0]; adj = G / max(G - 1, 1)
    cov = Hi @ (sc.T @ sc) @ Hi * adj
    # дисперсия Пирсона (насколько данные сверхдисперсны относительно Пуассона)
    lam = n_g[g] * p
    disp = float(((y - lam) ** 2 / np.maximum(lam, 1e-9)).sum() / max(len(y) - X.shape[1] - n_g.size, 1))
    return b, cov, int(keep.sum()), disp


def design(df, controls, price_terms):
    parts = []
    for c in controls:
        parts.append(pd.get_dummies(df[c].astype(str), prefix=c, drop_first=True, dtype=float))
    parts.append(price_terms)
    return pd.concat(parts, axis=1)


def price_terms(df, col="lp", by="hb", levels=HB):
    return pd.DataFrame({f"beta[{h}]": (df[by] == h) * df[col] for h in levels}, index=df.index).astype(float)


def fit(df, fe, controls, pt, label):
    Xd = design(df, controls, pt)
    Xd = Xd.loc[:, Xd.std() > 0]
    g = pd.factorize(df[fe].astype(str) if isinstance(fe, str) else df[fe].astype(str).agg("|".join, axis=1))[0]
    cl = pd.factorize(df.dep_id)[0]
    b, cov, n, disp = fe_poisson(df.bookings.values, Xd.values, g, cl)
    se = np.sqrt(np.diag(cov))
    res = pd.DataFrame({"model": label, "term": Xd.columns, "coef": b, "se": se,
                        "lo95": b - 1.96 * se, "hi95": b + 1.96 * se})
    res["n"] = n; res["dispersion"] = disp
    return res, dict(zip(Xd.columns, b))


def prep():
    t, dep, cutoff, meta = load()
    p = build_panel(t, dep, cutoff)
    p = p[p.route.notna() & p.ref_fare.notna()].copy()
    p["dep_id"] = p.flight + "_" + p.fly_date.dt.strftime("%Y%m%d")
    p = p.sort_values(["dep_id", "dtd"], ascending=[True, False])
    # «стоящая» цена на начало дня: последняя ВИДЕННАЯ до дня t (не использует продажи дня t)
    p["price_lag"] = p.groupby("dep_id").price_seen.transform(lambda s: s.shift(1).ffill())
    p["lp"] = np.log(p.rel_price)                         # как в common: цена дня (min проданного) / восстановленная
    p["lp_lag"] = np.log(p.price_lag / p.ref_fare)
    p["dbin"] = dtd_bin(p.dtd); p["month"] = p.fly_date.dt.month
    p["capg"] = np.where(p.cap_class.notna(), p.cap_class, p.cap).astype(int).astype(str)
    p["sale_date"] = p.fly_date - pd.to_timedelta(p.dtd, "D")
    # Инструмент: ценовая политика направления в дату продажи — leave-one-out средний lp_lag других вылетов того же
    # направления в тот же день продажи (тариф/открытые классы, общие для направления), центрированный по направл.×горизонт.
    k = ["route", "sale_date"]
    s = p.groupby(k).lp_lag.transform("sum"); c = p.groupby(k).lp_lag.transform("count")
    p["z_loo"] = (s - p.lp_lag.fillna(0)) / (c - p.lp_lag.notna().astype(int))
    p.loc[(c - p.lp_lag.notna().astype(int)) < 1, "z_loo"] = np.nan
    return p, t, dep, cutoff


def eb_shrink(tab):
    """Эмпирический Байес: β_g ← β̄ + w_g(β_g − β̄), w = τ²/(τ²+se²), τ² — метод моментов (DerSimonian–Laird)."""
    b, s2 = tab.coef.values, tab.se.values ** 2
    w = 1 / s2; bbar = (w * b).sum() / w.sum()
    Q = (w * (b - bbar) ** 2).sum(); k = len(b)
    tau2 = max(0.0, (Q - (k - 1)) / (w.sum() - (w ** 2).sum() / w.sum())) if k > 1 else 0.0
    sh = tau2 / (tau2 + s2)
    tab = tab.copy(); tab["beta_pooled"] = bbar; tab["tau"] = np.sqrt(tau2)
    tab["beta_eb"] = bbar + sh * (b - bbar); tab["se_eb"] = np.sqrt(sh * s2 + (1 - sh) ** 2 / w.sum())
    return tab


CTRL = ["dbin", "dow", "month", "capg"]


def main():
    os.makedirs(OUT, exist_ok=True)
    p, t, dep, cutoff = prep()
    print(f"панель {len(p)} строк, {p.dep_id.nunique()} вылетов, цена видна в {p.price_obs.mean():.0%} дней")
    allres = []
    a = p.dropna(subset=["lp_lag"]).copy()
    specs = [
        ("A1 все дни, цена дня (common.rel_price), ФЭ направления", p, "route", CTRL, "lp"),
        ("A2 только дни с видимой ценой, ФЭ направления", p[p.price_obs == 1], "route", CTRL, "lp"),
        ("B1 все дни, стоящая цена (лаг), ФЭ направления", a, "route", CTRL, "lp_lag"),
        ("B2 стоящая цена, ФЭ вылета", a, "dep_id", ["dbin"], "lp_lag"),
        ("B3 стоящая цена, ФЭ вылета + контроль продано/кресла", a.assign(lf=pd.cut(a.sold_before / a.seats.clip(lower=1), [-1, .25, .5, .75, .9, 99]).astype(str)), "dep_id", ["dbin", "lf"], "lp_lag"),
    ]
    models = {}
    for lab, d, fe, ctrl, col in specs:
        r, cf = fit(d, fe, ctrl, price_terms(d, col), lab)
        allres.append(r); models[lab] = cf
    # C: контрольная функция (IV) — 1-я стадия lp_lag ~ z_loo×hb + ФЭ направления + контроли; остаток в Пуассон.
    iv = a.dropna(subset=["z_loo"]).copy()
    from numpy.linalg import lstsq
    Z = pd.concat([pd.get_dummies(iv[c].astype(str), prefix=c, dtype=float) for c in ["route", "dbin", "dow", "month"]] +
                  [price_terms(iv, "z_loo").rename(columns=lambda x: x.replace("beta", "z"))], axis=1)
    coef, *_ = lstsq(Z.values, iv.lp_lag.values, rcond=None)
    iv["v"] = iv.lp_lag - Z.values @ coef
    zc = Z.filter(like="z[").values; resid = iv.v.values
    # F-статистика 1-й стадии (частная, грубо, без кластеров)
    Z0 = Z.drop(columns=Z.filter(like="z[").columns).values
    c0, *_ = lstsq(Z0, iv.lp_lag.values, rcond=None); r0 = iv.lp_lag.values - Z0 @ c0
    F = ((r0 @ r0 - resid @ resid) / zc.shape[1]) / (resid @ resid / (len(iv) - Z.shape[1]))
    print(f"IV: строк {len(iv)}, 1-я стадия F ≈ {F:.0f}, коэф. z: {np.round(coef[-3:], 3)}")
    pt = price_terms(iv, "lp_lag"); pt["cf_resid"] = iv.v
    lab = "C1 IV(контр. функция): стоящая цена, инстр.=цена направления в дату продажи (LOO), ФЭ направления"
    r, cf = fit(iv, "route", CTRL, pt, lab); r["firststage_F"] = F; allres.append(r); models[lab] = cf
    # то же без IV на той же подвыборке для сравнения
    r, _ = fit(iv, "route", CTRL, price_terms(iv, "lp_lag"), "C0 та же подвыборка без IV"); allres.append(r)
    res = pd.concat(allres)
    res.to_csv(os.path.join(OUT, "models_all_terms.csv"), index=False)
    main_tab = res[res.term.str.startswith("beta")]
    main_tab.to_csv(os.path.join(OUT, "beta_by_horizon.csv"), index=False)
    pd.set_option("display.width", 200); pd.set_option("display.max_colwidth", 70)
    print(main_tab[["model", "term", "coef", "lo95", "hi95", "n", "dispersion"]].round(3).to_string(index=False))

    # ---- разбивки (основная спецификация B2: ФЭ вылета, стоящая цена), с ЭБ-сжатием ----
    a["routeg"] = a.route.map(a.groupby("route").bookings.sum()).pipe(lambda s: np.where(s >= 300, a.route, "прочие"))
    a["season"] = a.month.map({9: "сен-окт", 10: "сен-окт", 11: "ноя-дек", 12: "ноя-дек", 1: "янв-мар", 2: "янв-мар", 3: "янв-мар"})
    out = []
    for by in ["hb", "dow", "season", "capg", "routeg"]:
        levels = sorted(a[by].astype(str).unique())
        d = a.assign(_g=a[by].astype(str))
        try:
            r, _ = fit(d, "dep_id", ["dbin"], price_terms(d, "lp_lag", "_g", levels), f"B2 по {by}")
        except np.linalg.LinAlgError:
            continue
        r = r[r.term.str.startswith("beta")].copy(); r["by"] = by
        r["level"] = r.term.str.extract(r"beta\[(.*)\]")[0]
        r = r[r.se < 5]
        out.append(eb_shrink(r))
    grp = pd.concat(out)
    grp.to_csv(os.path.join(OUT, "beta_groups_eb.csv"), index=False)
    print(grp[["by", "level", "coef", "se", "beta_eb", "se_eb", "tau"]].round(3).to_string(index=False))

    # ---- sanity: история, кросс-секция по направлению ----
    h = pd.read_csv(os.path.join(data_dir(), "hist.csv"), parse_dates=["fly_date"])
    h = h[(h.tickets > 0) & (h.avg_fare > 0)].copy()
    h["la"] = np.log(h.avg_fare); h["lt"] = np.log(h.tickets); h["ym"] = h.fly_date.dt.strftime("%Y%m")
    h["dow"] = h.fly_date.dt.dayofweek
    import statsmodels.formula.api as smf
    rows = []
    top = h.route.value_counts(); top = top[top >= 150].index
    for rt in top:
        d = h[h.route == rt]
        m = smf.ols("lt ~ la + C(ym) + C(dow)", d).fit(cov_type="HC1")
        rows.append((rt, len(d), m.params["la"], m.bse["la"]))
    hs = pd.DataFrame(rows, columns=["route", "n", "coef", "se"])
    m = smf.ols("lt ~ la + C(route) + C(ym) + C(dow)", h[h.route.isin(top)]).fit(cov_type="HC1")
    hs.to_csv(os.path.join(OUT, "hist_sanity.csv"), index=False)
    print(f"hist: log(билеты) ~ log(ср.тариф) + ФЭ напр.+месяц+дн: {m.params['la']:.3f} ± {1.96*m.bse['la']:.3f}; "
          f"по направлениям медиана {hs.coef.median():.2f}, доля >0: {(hs.coef > 0).mean():.0%} ({len(hs)} напр.)")

    # ---- коэффициенты для demand_rate: B1 (ФЭ направления, нужны α_route) с β из B2 (ФЭ вылета) ----
    lab1 = specs[2][0]; lab2 = specs[3][0]
    cf = dict(models[lab1])
    beta = {h_: models[lab2][f"beta[{h_}]"] for h_ in HB}
    # пересчитать уровни при фиксированных β из B2: offset-подгонка α_route и контролей
    off = sum(((a.hb == h_) * a.lp_lag * beta[h_]) for h_ in HB)
    Xd = design(a, CTRL, pd.DataFrame(index=a.index)); Xd = Xd.loc[:, Xd.std() > 0]
    import statsmodels.api as sm
    R = pd.get_dummies(a.route, prefix="route", dtype=float)
    mm = sm.GLM(a.bookings.values, pd.concat([R, Xd], axis=1).values, family=sm.families.Poisson(), offset=off.values).fit()
    names = list(R.columns) + list(Xd.columns)
    coefs = {"spec": "log λ = route + dbin + dow + month + cap + β_h·log(price/ref_fare); β из ФЭ-вылета (B2), уровни — Poisson с offset",
             "beta": beta, "params": dict(zip(names, map(float, mm.params))),
             "ref_fare": a.groupby("route").ref_fare.first().to_dict(), "dtd_edges": DTD_EDGES,
             "beta_ci95": {r_.term: [r_.lo95, r_.hi95] for r_ in res[(res.model == lab2) & res.term.str.startswith("beta")].itertuples()}}
    json.dump(coefs, open(os.path.join(OUT, "coefs.json"), "w"), ensure_ascii=False, indent=1, default=float)
    lam = demand_rate(a.head(5), a.head(5).price_lag, coefs)
    print("demand_rate проверка:", np.round(lam, 3), "факт:", a.head(5).bookings.values)
    print("Σλ vs Σbookings:", round(float(demand_rate(a, a.price_lag, coefs).sum())), int(a.bookings.sum()))


_COEFS = None


def demand_rate(df, price, coefs=None):
    """Ожидаемые бронирования в день λ при цене price (₽, скаляр или массив). df — строки панели
    (нужны route, dtd, fly_date или dow+month, cap_class/cap). Направления/категории вне обучения → 0 эффекта."""
    global _COEFS
    if coefs is None:
        if _COEFS is None:
            _COEFS = json.load(open(os.path.join(OUT, "coefs.json"), encoding="utf-8"))
        coefs = _COEFS
    df = pd.DataFrame(df) if not isinstance(df, pd.DataFrame) else df
    if isinstance(df, pd.DataFrame) and df.shape[1] == 1 and "route" not in df.columns:
        df = df.T
    P = coefs["params"]
    dtd = df.dtd.astype(int).values
    dow = df.dow.values if "dow" in df else pd.to_datetime(df.fly_date).dt.dayofweek.values
    month = df.month.values if "month" in df else pd.to_datetime(df.fly_date).dt.month.values
    capv = df.cap_class.where(df.cap_class.notna(), df.cap) if "cap_class" in df else df.cap
    db = dtd_bin(pd.Series(dtd)).values
    hb = np.where(dtd <= 7, "near(0-7)", np.where(dtd <= 21, "mid(8-21)", "far(22+)"))
    ref = df.route.map(coefs["ref_fare"]).values.astype(float)
    eta = np.array([P.get(f"route_{r}", np.nan) + P.get(f"dbin_{b}", 0) + P.get(f"dow_{w}", 0) + P.get(f"month_{m}", 0)
                    + P.get(f"capg_{int(c)}", 0) for r, b, w, m, c in zip(df.route, db, dow, month, capv)])
    beta = np.array([coefs["beta"][h] for h in hb])
    return np.exp(eta + beta * np.log(np.asarray(price, float) / ref))


if __name__ == "__main__":
    main()
