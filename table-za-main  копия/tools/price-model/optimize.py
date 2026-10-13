"""RM-оптимизация вылета: DP по цене (= «открыт минимальный класс k»), EMSR-b, фиксированная цена.

Интерфейс: любая demand(p, t) -> ожидаемые бронирования в день при цене p за t дней до вылета
(например elasticity.demand_rate, когда появится). Здесь тест на параметрической модели:
  exp:  λ(p,t) = a(t)·exp(β·(p/p_ref − 1));   iso: λ(p,t) = a(t)·(p/p_ref)^β
a(t) — средние бронирования (взрослые платные) по дням до вылета на улетевших вылетах направления (из данных),
p_ref — медианный взрослый платный тариф направления. β ∈ {−1..−4} — ДОПУЩЕНИЕ до оценки эконометриста.

DP (продаётся один уровень = минимальный открытый класс, покупатель берёт самый дешёвый открытый):
  V_t(x) = max_k  E[ V_{t-1}(x − N) + p_k·N ],  N — продажи за день при цене p_k; день дробится на n шагов
  с λ/n ≤ 0.25 (Бернулли на шаге), цена внутри дня постоянна (правило «не чаще раза в день»).
  bid price b_t(x) = V_{t-1}(x) − V_{t-1}(x−1).
Запуск: PM_DATA=... python3 optimize.py
"""
import json
import math
import os

import numpy as np
import pandas as pd

from common import load

OUT = os.environ.get("PM_OUT") or os.path.join(os.path.dirname(os.environ.get("PM_DATA", ".").rstrip("/")), "out", "opt")
T = 90               # горизонт продаж, дней
BETAS = [-1.0, -2.0, -3.0, -4.0]   # ДОПУЩЕНИЕ


# ---------------------------------------------------------------- данные направления
def ladder(a_route, min_n=5):
    """Лестница: класс (1-я буква RBD) → медианный тариф; классы с ≥ min_n взрослыми платными билетами."""
    g = a_route.assign(cl=a_route.rbd.str[0]).groupby("cl").fare.agg(["median", "size"])
    g = g[g["size"] >= min_n].sort_values("median")
    g = g[~g["median"].round(-1).duplicated()]
    return list(zip(g.index, g["median"].astype(float)))


def is_subsidized(a_route):
    """Фиксированный тариф: ≥ 80% взрослых платных билетов по одной цене или лестница из одного класса."""
    vc = a_route.fare.round().value_counts(normalize=True)
    return bool(vc.iloc[0] >= 0.8) or len(ladder(a_route)) < 2


def booking_curve(t_route, dep_flown):
    """a(t): средние взрослые платные бронирования в день t на улетевшем вылете направления, сглаживание 7 дн."""
    n = len(dep_flown)
    s = t_route.groupby("dtd").size().reindex(range(T + 1), fill_value=0) / max(n, 1)
    return s.rolling(7, center=True, min_periods=1).mean().values


def make_demand(a, p_ref, beta, kind="exp"):
    if kind == "exp":
        return lambda p, t: a[t] * math.exp(beta * (p / p_ref - 1))
    return lambda p, t: a[t] * (p / p_ref) ** beta


# ---------------------------------------------------------------- переход за день при фиксированной цене
def day_matrix(lam, C, nsub):
    """M[x, x'] — вероятность перейти из x свободных в x' за день (nsub шагов Бернулли с q = λ/nsub)."""
    q = min(lam / nsub, 1.0)
    step = np.zeros((C + 1, C + 1))
    for x in range(C + 1):
        if x == 0:
            step[0, 0] = 1
        else:
            step[x, x - 1] = q
            step[x, x] = 1 - q
    return np.linalg.matrix_power(step, nsub)


def solve(prices, demand, C, T=T, policy=None):
    """Если policy=None — DP-оптимум по лестнице prices; иначе policy(t, x) -> индекс цены (оценка политики).
    Возвращает V[t, x], act[t, x], bid[t, x]."""
    lam_max = max(demand(p, t) for p in prices for t in range(T + 1))
    nsub = max(1, math.ceil(lam_max / 0.25))
    V = np.zeros((T + 2, C + 1))           # V[0] — после вылета (t = −1 по смыслу)
    act = np.zeros((T + 1, C + 1), dtype=int)
    xs = np.arange(C + 1)
    for t in range(0, T + 1):
        Vn = V[t]                           # ценность после дня t (то есть к t−1)
        best = np.full(C + 1, -np.inf)
        for k, p in enumerate(prices):
            M = day_matrix(demand(p, t), C, nsub)
            val = M @ Vn + p * (xs - M @ xs)      # ценность остатка + p·E[продажи за день]
            if policy is None:
                upd = val > best + 1e-9
                best = np.where(upd, val, best); act[t] = np.where(upd, k, act[t])
            else:
                mask = np.array([policy(t, x) == k for x in xs])
                best = np.where(mask, val, best); act[t] = np.where(mask, k, act[t])
        V[t + 1] = best
    bid = np.zeros((T + 1, C + 1))
    bid[:, 1:] = V[:T + 1, 1:] - V[:T + 1, :-1]   # b_t(x) = V_{t-1}(x) − V_{t-1}(x−1)
    return V, act, bid, nsub


def forward(prices, demand, C, act, nsub, T=T):
    """Ожидаемые проданные кресла при политике act (распределение по x, старт x = C в день T)."""
    d = np.zeros(C + 1); d[C] = 1
    for t in range(T, -1, -1):
        nd = np.zeros(C + 1)
        for k, p in enumerate(prices):
            m = act[t] == k
            if not m.any():
                continue
            nd += (d * m) @ day_matrix(demand(p, t), C, nsub)
        d = nd
    return C - d @ np.arange(C + 1)


# ---------------------------------------------------------------- EMSR-b
def emsrb_protect(prices, demand, T=T):
    """Независимый спрос классов (без buy-down — как в классическом EMSR-b):
    D_j ~ Poisson(Λ(p_j) − Λ(p_{j+1})), Λ(p) = Σ_t λ(p,t) — пассажиры с WTP в [p_j, p_{j+1}).
    Возвращает уровни защиты y_j для классов j и выше (j от дорогого к дешёвому)."""
    from scipy.stats import poisson
    P = sorted(prices, reverse=True)
    Lam = [sum(demand(p, t) for t in range(T + 1)) for p in P]
    D = [Lam[0]] + [Lam[j] - Lam[j - 1] for j in range(1, len(P))]
    prot = []
    for j in range(len(P) - 1):
        mu = sum(D[:j + 1]); pbar = sum(D[i] * P[i] for i in range(j + 1)) / max(mu, 1e-9)
        y = 0
        while poisson.sf(y, mu) * pbar > P[j + 1] and y < 500:   # P(S > y)·p̄ > p_{j+1}
            y += 1
        prot.append(y)
    return P, prot


def emsrb_policy(prices, demand, C, T=T):
    P, prot = emsrb_protect(prices, demand, T)
    asc = sorted(prices)

    def pol(t, x):   # открыт самый дешёвый класс j+1, у которого свободных x > защита классов выше
        lowest = P[0]
        for j, y in enumerate(prot):
            if x > y:
                lowest = P[j + 1]
        return asc.index(lowest)
    return pol, dict(zip(P[:-1], prot))


# ---------------------------------------------------------------- прогон по направлениям
def run():
    os.makedirs(OUT, exist_ok=True)
    t, dep, cutoff, meta = load()
    a = t[t.adult & t.paid & t.route.notna()]
    flown = dep[dep.fly_date <= cutoff]
    rows, excluded, policies, today = [], [], {}, []
    routes = a.groupby("route").size()
    routes = routes[routes >= 300].index
    for r in routes:
        ar = a[a.route == r]
        if is_subsidized(ar):
            excluded.append(r); continue
        lad = ladder(ar); prices = [p for _, p in lad]; cls = {p: c for c, p in lad}
        p_ref = float(ar.fare.median())
        fl_r = flown[flown.route == r]
        tr = ar[ar.fly_date <= cutoff]
        if len(fl_r) < 5:
            continue
        acurve = booking_curve(tr, fl_r)
        C = int(dep[dep.route == r].seats.median())
        for kind in ["exp", "iso"]:
            for beta in BETAS:
                dem = make_demand(acurve, p_ref, beta, kind)
                V, act, bid, ns = solve(prices, dem, C)
                res = {"route": r, "cap": C, "kind": kind, "beta": beta, "n_classes": len(prices),
                       "dp_rev": V[T + 1, C], "dp_load": forward(prices, dem, C, act, ns)}
                # фиксированная цена: лучшая одна ступень лестницы
                best = (-1, None, None)
                for k, p in enumerate(prices):
                    Vf, af, _, _ = solve(prices, dem, C, policy=lambda tt, x, k=k: k)
                    if Vf[T + 1, C] > best[0]:
                        best = (Vf[T + 1, C], p, af)
                res.update(fix_rev=best[0], fix_price=best[1], fix_load=forward(prices, dem, C, best[2], ns))
                pol, prot = emsrb_policy(prices, dem, C)
                Ve, ae, _, _ = solve(prices, dem, C, policy=pol)
                res.update(emsrb_rev=Ve[T + 1, C], emsrb_load=forward(prices, dem, C, ae, ns),
                           emsrb_protect=json.dumps({cls[p]: y for p, y in prot.items()}))
                rows.append(res)
                if kind == "exp" and beta == -2.0:
                    policies[r] = (prices, cls, act, bid)
                    pd.DataFrame(np.vectorize(lambda k: cls[prices[k]])(act[:, 1:]),
                                 columns=range(1, C + 1)).rename_axis("dtd").to_csv(f"{OUT}/policy_{r}_b2.csv")
                    pd.DataFrame(bid[:, 1:].round(0), columns=range(1, C + 1)).rename_axis("dtd").to_csv(f"{OUT}/bid_{r}_b2.csv")
        # рекомендации на сегодня для будущих вылетов направления (β = −2, exp)
        prices, cls, act, bid = policies[r]
        fut = dep[(dep.route == r) & (dep.fly_date > cutoff)]
        sold = t[t.route == r].groupby(["flight", "fly_date"]).size()
        for _, d in fut.iterrows():
            dtd = int((d.fly_date - cutoff).days)
            if dtd > T:
                continue
            x = int(max(0, min(C, d.seats - sold.get((d.flight, d.fly_date), 0))))
            if x == 0:
                today.append((r, d.flight, f"{d.fly_date:%d.%m.%Y}", dtd, 0, "закрыть всё", None, None)); continue
            k = act[dtd, x]
            today.append((r, d.flight, f"{d.fly_date:%d.%m.%Y}", dtd, x, cls[prices[k]], prices[k], round(bid[dtd, x])))
    df = pd.DataFrame(rows)
    df["dp_vs_fix_%"] = (df.dp_rev / df.fix_rev - 1) * 100
    df["dp_vs_emsrb_%"] = (df.dp_rev / df.emsrb_rev - 1) * 100
    df.round(2).to_csv(f"{OUT}/compare.csv", index=False)
    td = pd.DataFrame(today, columns=["route", "flight", "fly_date", "dtd", "free", "open_class", "price", "bid_price"])
    td.to_csv(f"{OUT}/today.csv", index=False)
    summ = df.groupby(["kind", "beta"]).agg(dp=("dp_rev", "sum"), fix=("fix_rev", "sum"), emsrb=("emsrb_rev", "sum"),
                                            dp_load=("dp_load", "sum"), fix_load=("fix_load", "sum"),
                                            emsrb_load=("emsrb_load", "sum"), cap=("cap", "sum"))
    summ["dp_vs_fix_%"] = (summ.dp / summ.fix - 1) * 100
    summ["dp_vs_emsrb_%"] = (summ.dp / summ.emsrb - 1) * 100
    for c in ["dp_load", "fix_load", "emsrb_load"]:
        summ[c] = summ[c] / summ.cap * 100
    summ.round(1).to_csv(f"{OUT}/summary.csv")
    pd.set_option("display.width", 200)
    print("Исключены (фиксированный/субсидируемый тариф):", excluded)
    print(f"Направлений в расчёте: {df.route.nunique()}; выручка на 1 вылет, сумма по направлениям; загрузка %")
    print(summ.drop(columns="cap").round(1))
    print("\nПо направлениям (exp, β=−2):")
    print(df[(df.kind == "exp") & (df.beta == -2)][["route", "cap", "n_classes", "dp_rev", "fix_rev", "fix_price", "emsrb_rev",
                                                     "dp_load", "fix_load", "emsrb_load", "dp_vs_fix_%", "dp_vs_emsrb_%"]].round(1).to_string(index=False))
    print("\nСегодня (срез", f"{cutoff:%d.%m.%Y}", "), первые 15 рекомендаций:")
    print(td.head(15).to_string(index=False))


if __name__ == "__main__":
    run()
