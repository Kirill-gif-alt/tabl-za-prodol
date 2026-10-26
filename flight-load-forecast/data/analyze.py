"""Анализ входных данных перед обучением: только агрегаты, строки с данными не печатаются.

Запуск: python -m data.analyze --history SalesHistory.csv [--availability file.csv]
"""
from __future__ import annotations

import argparse
import logging

import numpy as np
import pandas as pd

from .features import HORIZONS, build_flight_table
from .parsers import load_availability, load_sales_history

log = logging.getLogger("analyze")


def analyze(history: pd.DataFrame, availability: pd.DataFrame | None = None) -> dict:
    """Короткая сводка: объём, период, редкие рейсы, форма кривой, доля продаж по горизонтам."""
    table = build_flight_table(history, availability)
    f = table.df
    per_reis = f.groupby("reis").size()
    out = {
        "вылетов": int(len(f)),
        "рейсов": int(f["reis"].nunique()),
        "направлений": int(f["od"].nunique()),
        "период": f"{f['flydate'].min():%d.%m.%Y} — {f['flydate'].max():%d.%m.%Y}",
        "билетов в вылете (среднее/мед/макс)": (round(float(f["tickets"].mean()), 1), float(f["tickets"].median()),
                                                 float(f["tickets"].max())),
        "рейсов с менее чем 20 вылетами (редкие)": int((per_reis < 20).sum()),
        "доля групповых вылетов": round(float(f["group"].clip(0, 1).mean()), 3),
        "доля корпоративных вылетов": round(float(f["corp"].clip(0, 1).mean()), 3),
        "вылетов без кривой": int((table.cum[:, 0] <= 0).sum()),
        "вылетов с итогом выше потолка": int((f["tickets"] > f["cap"]).sum()),
    }
    tot = np.maximum(table.cum[:, 0], 1)
    out["какая доля итога уже продана к горизонту (среднее)"] = {
        k: round(float(np.mean(table.cum[:, c] / tot)), 3) for k, (c, _, _) in HORIZONS.items()}
    gaps = f.groupby("reis")["flydate"].apply(lambda s: s.sort_values().diff().dt.days.dropna())
    out["пропуски дат в истории (рейс-дни > 3 дня подряд)"] = int((gaps > 3).sum()) if len(gaps) else 0
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--history", required=True)
    ap.add_argument("--availability")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    h = load_sales_history(a.history)
    av = load_availability(a.availability) if a.availability else None
    for k, v in analyze(h, av).items():
        log.info("%-55s %s", k, v)


if __name__ == "__main__":
    main()
