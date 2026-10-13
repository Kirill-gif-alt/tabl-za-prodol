"""Общие данные для всей команды: билеты, вылеты и дневная панель «вылет × день до вылета».

Панель (build_panel): одна строка = вылет × день до вылета t (0..T_MAX), где известны продажи этого дня:
  bookings   — билетов, купленных в этот день (взрослые платные и нулевые тарифы считаются отдельно)
  paid       — из них платных (тариф > 0)
  price      — цена, по которой продавали в этот день: минимальный взрослый платный тариф среди проданных
               (код без /CN, /IN, /ID). В дни без продаж цены не видно: берётся последняя наблюдённая на этом
               вылете (price_obs = 0), иначе типичная минимальная цена направления на таком горизонте.
  ref_fare   — опорный тариф направления: медиана взрослых платных тарифов направления (для индекса цены)
  rel_price  — price / ref_fare (сравнимо между направлениями)
  cap, seats — ёмкость ВС и кресла в продаже; load_final — загрузка к вылету (только улетевшие)
  sold_before — продано до этого дня (для учёта «сколько осталось»)
Наблюдаемые дни: от первого дня продаж вылета (но не дальше T_MAX) до дня среза данных (deal_date ≤ cutoff).
"""
import json
import os
import re

import numpy as np
import pandas as pd

T_MAX = 120
DISCOUNT_RE = re.compile(r"/(?:CN|IN|ID|CH|INF)", re.I)


def data_dir(default=None):
    return os.environ.get("PM_DATA") or default or os.path.join(os.path.dirname(__file__), "data")


def load(d=None):
    d = data_dir(d)
    t = pd.read_csv(os.path.join(d, "tickets.csv"), parse_dates=["fly_date", "deal_date"])
    dep = pd.read_csv(os.path.join(d, "departures.csv"), parse_dates=["fly_date"])
    meta = json.load(open(os.path.join(d, "meta.json"), encoding="utf-8"))
    cutoff = pd.Timestamp(t.deal_date.max()).normalize()   # последний день продаж в данных
    t["adult"] = ~t.basis.fillna("").str.contains(DISCOUNT_RE)
    t["paid"] = t.fare > 0
    dep["route"] = dep.route.fillna("")
    t = t.drop(columns=["route"]).merge(dep[["flight", "fly_date", "route", "cap", "seats", "cap_class", "base", "week", "load", "closed"]],
                                        on=["flight", "fly_date"], how="left")
    return t, dep, cutoff, meta


def horizon_bucket(t):
    return np.where(t <= 7, "near(0-7)", np.where(t <= 21, "mid(8-21)", "far(22+)"))


def build_panel(t, dep, cutoff, t_max=T_MAX):
    """Дневная панель по вылетам, у которых есть продажи в данных. Возвращает DataFrame."""
    t = t[t.route.notna() & (t.route != "")].copy()
    adult_paid = t[t.adult & t.paid]
    ref = adult_paid.groupby("route").fare.median().rename("ref_fare")
    daily = t.groupby(["flight", "fly_date", "dtd"]).agg(bookings=("fare", "size"), paid=("paid", "sum"),
                                                         revenue=("fare", "sum")).reset_index()
    pmin = adult_paid.groupby(["flight", "fly_date", "dtd"]).fare.min().rename("price_seen").reset_index()
    daily = daily.merge(pmin, on=["flight", "fly_date", "dtd"], how="left")
    rows = []
    keys = daily.groupby(["flight", "fly_date"])
    deps = dep.set_index(["flight", "fly_date"])
    for (fl, fd), g in keys:
        if (fl, fd) not in deps.index:
            continue
        info = deps.loc[(fl, fd)]
        if isinstance(info, pd.DataFrame):
            info = info.iloc[0]
        first = int(min(t_max, g.dtd.max()))
        last = max(0, int((fd - cutoff).days))   # дальше среза продаж не видно
        if last > first:
            continue
        gi = g.set_index("dtd")
        sold = int(g[g.dtd > first].bookings.sum())   # купленные раньше окна T_MAX
        for d in range(first, last - 1, -1):
            if d in gi.index:
                r = gi.loc[d]
                b, p, rev, ps = int(r.bookings), int(r.paid), float(r.revenue), r.price_seen
            else:
                b, p, rev, ps = 0, 0, 0.0, np.nan
            rows.append((fl, fd, d, b, p, rev, ps, sold))
            sold += b
    panel = pd.DataFrame(rows, columns=["flight", "fly_date", "dtd", "bookings", "paid", "revenue", "price_seen", "sold_before"])
    panel = panel.merge(dep[["flight", "fly_date", "route", "base", "cap", "seats", "cap_class", "week", "load", "closed"]],
                        on=["flight", "fly_date"], how="left").merge(ref, left_on="route", right_index=True, how="left")
    panel = panel.sort_values(["flight", "fly_date", "dtd"], ascending=[True, True, False])
    # Цена в дни без продаж: последняя наблюдённая на вылете (дальше от вылета → ближе), иначе типичная для горизонта.
    panel["price_obs"] = panel.price_seen.notna().astype(int)
    panel["price"] = panel.groupby(["flight", "fly_date"]).price_seen.ffill()
    panel["hb"] = horizon_bucket(panel.dtd)
    typ = panel[panel.price_obs == 1].groupby(["route", "hb"]).price_seen.median().rename("price_typ")
    panel = panel.merge(typ, left_on=["route", "hb"], right_index=True, how="left")
    panel["price"] = panel.price.fillna(panel.price_typ).fillna(panel.ref_fare)
    panel["rel_price"] = panel.price / panel.ref_fare
    panel["flown"] = panel.fly_date <= cutoff
    panel["dow"] = panel.fly_date.dt.dayofweek
    panel["load_final"] = np.where(panel.flown, panel["load"], np.nan)
    return panel.reset_index(drop=True)


def baseline_final(dep, d=None):
    """Текущая модель: прогноз загрузки к вылету = файл ожидаемой при dtd = 0 (ёмкость, основной рейс, неделя)."""
    e = pd.read_csv(os.path.join(data_dir(d), "expected.csv"))
    f = e[e.dtd == 0].set_index(["cap", "flight", "week"]).expected
    return pd.Series([f.get((c, b, w)) for c, b, w in zip(dep.cap_class, dep.base, dep.week)], index=dep.index, dtype=float)


if __name__ == "__main__":
    t, dep, cutoff, meta = load()
    p = build_panel(t, dep, cutoff)
    print(f"cutoff {cutoff:%d.%m.%Y}; panel rows {len(p)}; departures {p.groupby(['flight', 'fly_date']).ngroups}; "
          f"flown {p[p.flown].groupby(['flight', 'fly_date']).ngroups}; days with observed price {p.price_obs.mean():.0%}")
    print(p.groupby("hb")[["bookings", "rel_price"]].mean())
