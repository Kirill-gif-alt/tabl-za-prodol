"""Генератор синтетики: история продаж, файл доступности и билеты за 14 дней.

Нужен, когда настоящих файлов нет (демо, тесты). Данные выдуманные, персональных полей нет.
Форматы колонок совпадают с боевыми файлами, поэтому тот же код читает и то и другое.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .parsers import MAX_DTD

ROUTES = [  # (город1, город2, вместимость, спрос, дальность заказа в днях, сколько рейсов в неделю)
    ("KJA", "ABA", 72, 0.62, 26, 7),
    ("KJA", "IKT", 100, 0.70, 21, 7),
    ("KJA", "OVB", 100, 0.55, 18, 7),
    ("KJA", "MOW", 180, 0.75, 35, 7),
    ("KJA", "LED", 180, 0.68, 40, 4),
    ("ABA", "KJA", 72, 0.60, 26, 7),
    ("KJA", "NSK", 50, 0.50, 14, 3),
    ("KJA", "YKS", 50, 0.35, 12, 2),     # редкий маршрут: мало вылетов — проверка запасных уровней
]


def _season(doy: np.ndarray) -> np.ndarray:
    return 1.0 + 0.18 * np.sin((doy - 120) / 365 * 2 * np.pi) + 0.12 * (np.abs(doy - 215) < 25)


def make_history(start="2024-01-01", end="2025-06-30", seed=7, routes=ROUTES) -> pd.DataFrame:
    """Возвращает DataFrame в формате load_sales_history + служебная колонка capacity."""
    rng = np.random.default_rng(seed)
    rows = []
    days = pd.date_range(start, end, freq="D")
    dow_f = np.array([0.92, 0.88, 0.9, 1.0, 1.12, 1.1, 1.08])
    for ri, (c1, c2, cap, dem, lead, per_week) in enumerate(routes):
        fnums = [f"KV-{100 + ri * 10 + k}" for k in range(2 if cap >= 100 else 1)]
        for day in days:
            if day.dayofweek >= per_week and per_week < 7:
                continue
            for fn in fnums:
                # потолок вместимости иногда меняется (другой борт)
                cap_f = cap if rng.random() > 0.04 else int(cap * 0.7)
                mu = cap_f * dem * dow_f[day.dayofweek] * _season(np.array([day.dayofyear]))[0]
                demand = max(0.0, rng.normal(mu, 0.18 * mu) * (1.0 + 0.0002 * (day - days[0]).days / 30))
                total = int(round(min(demand, cap_f)))
                if total < 3:
                    continue
                # дальность заказа и форма кривой
                lam = lead * rng.uniform(0.8, 1.25)
                d = np.minimum(rng.exponential(lam, total).astype(int), MAX_DTD)
                grp = int(rng.random() < 0.12)
                corp = int(rng.random() < 0.18)
                if grp:                      # групповая бронь: пачка билетов рано
                    k = min(total // 3 + 1, 10)
                    d[:k] = np.maximum(d[:k], int(lam * 1.8))
                curve = pd.Series(d).value_counts().sort_index()
                refunded = int(rng.binomial(total, 0.04))
                price = 6000 * (0.8 + 0.5 * (cap_f / 180)) * rng.uniform(0.9, 1.15)
                rows.append(dict(
                    reis=fn, flydate=day, city1=c1, city2=c2, od=f"{c1}-{c2}", tickets=total, refunded=refunded,
                    group=grp, corp=corp, revenue=int(total * price),
                    curve=" ".join(f"{k}:{v}" for k, v in curve.items()), capacity=cap_f))
    return pd.DataFrame(rows)


def history_to_csv(h: pd.DataFrame, path) -> None:
    out = h.copy()
    out["FLYDATE"] = out["flydate"].dt.strftime("%d.%m.%Y")
    out = out.rename(columns={"reis": "REIS", "city1": "CITY1", "city2": "CITY2", "tickets": "TICKETS",
                              "refunded": "REFUNDED", "group": "GROUP", "corp": "CORP", "revenue": "REVENUE",
                              "curve": "CURVE"})
    out["REFUND_CURVE"] = ""
    out[["REIS", "FLYDATE", "CITY1", "CITY2", "TICKETS", "REFUNDED", "GROUP", "CORP", "REVENUE", "CURVE",
         "REFUND_CURVE"]].to_csv(path, index=False)


def make_availability(h: pd.DataFrame, today, days_ahead=60, seed=11) -> pd.DataFrame:
    """Файл доступности на ближайшие вылеты. Потолок берём по рейсу из истории."""
    rng = np.random.default_rng(seed)
    cap = h.groupby("reis")["capacity"].agg(lambda s: int(s.mode().iloc[0]))
    today = pd.Timestamp(today).normalize()
    rows = []
    for fn, c in cap.items():
        for k in range(days_ahead):
            fd = today + pd.Timedelta(days=k)
            booked = int(min(c, max(0, rng.normal(c * 0.5 * np.exp(-k / 30), 3))))
            rows.append({"REIS": fn, "FLYDATE": fd.strftime("%d.%m.%Y"), "Config": f"Y{c}", "Total AU": c,
                         "SegBkd": booked, "Free": c - booked})
    return pd.DataFrame(rows)


def make_recent_tickets(h: pd.DataFrame, today, days=14, seed=5) -> pd.DataFrame:
    """Билеты за последние дни в формате Tickets_SALE_Last14Days (без персональных колонок)."""
    rng = np.random.default_rng(seed)
    today = pd.Timestamp(today).normalize()
    rows = []
    for fn, g in h.groupby("reis"):
        r = g.iloc[-1]
        for k in range(days):
            deal = today - pd.Timedelta(days=k)
            for _ in range(rng.poisson(3)):
                fd = deal + pd.Timedelta(days=int(rng.integers(0, 60)))
                rows.append({"DEALDATE": deal.strftime("%d.%m.%Y"), "FLYDATE": fd.strftime("%d.%m.%Y"),
                             "REIS": fn, "CITY1": r.city1, "CITY2": r.city2, "TYPE": "SALE",
                             "RBD": rng.choice(list("YBMHKLQ")), "NFARE": int(rng.integers(3000, 12000))})
    return pd.DataFrame(rows)
