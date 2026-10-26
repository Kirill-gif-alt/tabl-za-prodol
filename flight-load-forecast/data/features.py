"""Признаки: кривые бронирования, исторические агрегаты (без утечки из будущего), последовательности.

Договорённости:
  cum[h]  — сколько билетов продано к моменту «h дней до вылета» (по возрастанию h не растёт).
  горизонты — четыре точки «сколько дней до вылета»; для каждой модель учится на окне DTD вокруг точки.
  утечки нет: всё, что известно «на дату прогноза» — только вылеты, которые уже улетели до неё
  (flydate < дата_прогноза = flydate_рейса − dtd).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .parsers import MAX_DTD, curve_to_cumulative

log = logging.getLogger(__name__)

# ключ горизонта -> (центр, мин DTD окна, макс DTD окна)
HORIZONS: dict[str, tuple[int, int, int]] = {
    "30d": (30, 27, 33),
    "14d": (14, 12, 16),
    "7d": (7, 6, 8),
    "1_3d": (2, 1, 3),
}
SEQ_H = 28   # длина горизонтальной кривой (дней продаж до точки прогноза)
SEQ_V = 8    # сколько прошлых вылетов того же рейса в вертикальной кривой
SHRINK_K = 5.0

FEATURE_COLS = [
    "dtd", "booked", "booked_pct_cap", "cap", "pace3", "pace7", "pace14", "growth7",
    "dow", "month", "dom", "is_weekend", "doy_sin", "doy_cos",
    "h_final", "h_book", "h_rem", "h_final_pct_cap", "h_n_reis", "h_level",
    "grp_rate", "corp_rate", "rev_per_ticket", "booked_vs_hist",
]


def horizon_of_dtd(dtd: int) -> str:
    """К какому горизонту ближе текущий DTD."""
    return min(HORIZONS, key=lambda k: abs(HORIZONS[k][0] - dtd))


@dataclass
class FlightTable:
    """Вылеты истории: таблица + матрица кривых. Строки отсортированы по (flydate, reis)."""
    df: pd.DataFrame            # reis, flydate, od, tickets, group, corp, revenue, cap, dow ...
    cum: np.ndarray             # (N, MAX_DTD+1)
    live: dict = field(default_factory=dict)   # (reis, flydate) -> cum неполной кривой будущего вылета

    def __len__(self):
        return len(self.df)


def estimate_capacity(h: pd.DataFrame, availability: pd.DataFrame | None = None) -> pd.Series:
    """Потолок по каждому вылету: Total AU из файла доступности -> квантиль 0.99 по рейсу ->
    по направлению -> общий. Не меньше фактически проданного."""
    cap = pd.Series(np.nan, index=h.index)
    if "capacity" in h:
        cap = h["capacity"].astype(float)
    if availability is not None and len(availability):
        m = h[["reis", "flydate"]].merge(availability[["reis", "flydate", "total_au"]], how="left",
                                         on=["reis", "flydate"])
        cap = cap.fillna(pd.Series(m["total_au"].values, index=h.index))
    q = h["tickets"].astype(float)
    by_reis = q.groupby(h["reis"]).transform(lambda s: s.quantile(0.99))
    by_od = q.groupby(h["od"]).transform(lambda s: s.quantile(0.99))
    cap = cap.fillna(by_reis).fillna(by_od).fillna(q.quantile(0.99))
    return np.ceil(np.maximum(cap, q)).clip(lower=1)


def build_flight_table(history: pd.DataFrame, availability: pd.DataFrame | None = None) -> FlightTable:
    h = history.sort_values(["flydate", "reis"]).reset_index(drop=True).copy()
    h["cap"] = estimate_capacity(h, availability)
    cum = np.vstack([curve_to_cumulative(c, MAX_DTD) for c in h["curve"]]) if len(h) else np.zeros((0, MAX_DTD + 1))
    # итог по кривой должен совпасть с TICKETS: если нет — доверяем TICKETS и масштабируем кривую
    tot = cum[:, 0] if len(h) else np.array([])
    ok = (tot > 0) & (np.abs(tot - h["tickets"].values) > 0.5)
    if ok.any():
        cum[ok] = cum[ok] * (h["tickets"].values[ok] / tot[ok])[:, None]
    h["dow"] = h["flydate"].dt.dayofweek
    return FlightTable(h, cum)


# ------------------------------------------------------------------ исторические агрегаты

def _join(keys: list[np.ndarray]) -> np.ndarray:
    """Несколько массивов-ключей -> один массив строк."""
    out = keys[0].astype(str)
    for k in keys[1:]:
        out = np.char.add(np.char.add(out, "|"), k.astype(str))
    return out


def _lagged_means(keys: list[np.ndarray], flights_keys: list[np.ndarray], flydates: np.ndarray,
                  values: np.ndarray, as_of: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Для каждой строки (ключ, as_of): сумма и число значений по вылетам с тем же ключом и flydate < as_of.

    values: (N_flights, V). Возвращает суммы (N_rows, V) и счётчики (N_rows,).
    """
    n_rows = len(as_of)
    S = np.zeros((n_rows, values.shape[1]))
    C = np.zeros(n_rows)
    fk = pd.Series(range(len(flydates))).groupby(_join(flights_keys)).indices
    rk = pd.Series(range(n_rows)).groupby(_join(keys)).indices
    for key, ridx in rk.items():
        fidx = fk.get(key)
        if fidx is None:
            continue
        order = np.argsort(flydates[fidx], kind="stable")
        fidx = fidx[order]
        dates = flydates[fidx]
        cs = np.vstack([np.zeros(values.shape[1]), np.cumsum(values[fidx], axis=0)])
        pos = np.searchsorted(dates, as_of[ridx], side="left")
        S[ridx] = cs[pos]
        C[ridx] = pos
    return S, C


def hist_stats(table: FlightTable, rows: pd.DataFrame, h0: int) -> pd.DataFrame:
    """Исторические агрегаты для строк rows(reis, od, dow, as_of) с иерархическим сглаживанием.

    Цепочка: общий -> направление (OD) -> OD×день недели -> рейс -> рейс×день недели.
    Если у уровня мало вылетов, оценка подтягивается к родителю (как байесовское сжатие, k=5), поэтому
    у редких и новых рейсов автоматически работает запасной уровень выше.
    Значения: итог, продано к h0 дням, доля групп, доля корпоратов, выручка на билет.
    """
    f = table.df
    vals = np.column_stack([
        f["tickets"].values.astype(float),
        table.cum[:, h0],
        f["group"].values.astype(float).clip(0, 1),
        f["corp"].values.astype(float).clip(0, 1),
        (f["revenue"].values / np.maximum(f["tickets"].values, 1)).astype(float),
    ])
    fd = f["flydate"].values.astype("datetime64[ns]").astype(np.int64)
    asof = rows["as_of"].values.astype("datetime64[ns]").astype(np.int64)
    fkeys = {"od": [f["od"].values], "oddow": [f["od"].values, f["dow"].values],
             "reis": [f["reis"].values], "reisdow": [f["reis"].values, f["dow"].values]}
    rkeys = {"od": [rows["od"].values], "oddow": [rows["od"].values, rows["dow"].values],
             "reis": [rows["reis"].values], "reisdow": [rows["reis"].values, rows["dow"].values]}
    # глобальный уровень
    gs = np.vstack([np.zeros(vals.shape[1]), np.cumsum(vals[np.argsort(fd, kind="stable")], axis=0)])
    gpos = np.searchsorted(np.sort(fd), asof, side="left")
    gN = gpos.astype(float)
    est = np.where(gN[:, None] > 0, gs[gpos] / np.maximum(gN, 1)[:, None], np.nan)
    if np.isnan(est).all():
        est = np.broadcast_to(vals.mean(axis=0), est.shape).copy() if len(vals) else est
    est = np.where(np.isnan(est), vals.mean(axis=0) if len(vals) else 0.0, est)
    n_reis = np.zeros(len(rows))
    level = np.zeros(len(rows))
    for li, lvl in enumerate(("od", "oddow", "reis", "reisdow"), start=1):
        S, C = _lagged_means(rkeys[lvl], fkeys[lvl], fd, vals, asof)
        est = (S + SHRINK_K * est) / (C[:, None] + SHRINK_K)
        level = np.where(C >= 3, li, level)
        if lvl == "reis":
            n_reis = C
    out = pd.DataFrame({"h_final": est[:, 0], "h_book": est[:, 1], "grp_rate": est[:, 2],
                        "corp_rate": est[:, 3], "rev_per_ticket": est[:, 4],
                        "h_n_reis": n_reis, "h_level": level}, index=rows.index)
    out["h_rem"] = (out["h_final"] - out["h_book"]).clip(lower=0)
    return out


# ------------------------------------------------------------------ строки признаков

def _at(cum: np.ndarray, idx: np.ndarray) -> np.ndarray:
    return cum[np.arange(len(cum)), np.clip(idx, 0, cum.shape[1] - 1)]


def make_features(table: FlightTable, rows: pd.DataFrame, cum_rows: np.ndarray, h0: int) -> pd.DataFrame:
    """Признаки по строкам rows(reis, flydate, od, dow, dtd, cap, as_of) и их кривым cum_rows (N, MAX_DTD+1)."""
    d = rows["dtd"].values.astype(int)
    booked = _at(cum_rows, d)
    b3, b7, b14 = _at(cum_rows, d + 3), _at(cum_rows, d + 7), _at(cum_rows, d + 14)
    hs = hist_stats(table, rows, h0)
    fl = pd.to_datetime(rows["flydate"])
    doy = fl.dt.dayofyear.values
    X = pd.DataFrame({
        "dtd": d, "booked": booked, "cap": rows["cap"].values,
        "booked_pct_cap": booked / np.maximum(rows["cap"].values, 1),
        "pace3": (booked - b3) / 3.0, "pace7": (booked - b7) / 7.0, "pace14": (booked - b14) / 14.0,
        "growth7": (booked + 1.0) / (b7 + 1.0),
        "dow": fl.dt.dayofweek.values, "month": fl.dt.month.values, "dom": fl.dt.day.values,
        "is_weekend": (fl.dt.dayofweek.values >= 5).astype(int),
        "doy_sin": np.sin(2 * np.pi * doy / 365.25), "doy_cos": np.cos(2 * np.pi * doy / 365.25),
    }, index=rows.index)
    X = pd.concat([X, hs], axis=1)
    X["h_final_pct_cap"] = X["h_final"] / np.maximum(X["cap"], 1)
    X["booked_vs_hist"] = (X["booked"] + 1.0) / (X["h_book"] + 1.0)
    return X[FEATURE_COLS]


def build_sequences(table: FlightTable, rows: pd.DataFrame, cum_rows: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Последовательности для sequence-модели.

    horizontal (N, SEQ_H): продажи по дням внутри самого рейса, от старых к новым, до точки прогноза
        (последний элемент — продажи за день dtd; дни дальше окна и раньше начала продаж = 0);
    vertical   (N, SEQ_V): сколько было продано к тому же DTD у последних SEQ_V вылетов того же рейса
        (только уже улетевших до as_of); пустые места = среднее найденных, либо 0.
    """
    n = len(rows)
    d = rows["dtd"].values.astype(int)
    M = cum_rows.shape[1]
    H = np.zeros((n, SEQ_H))
    for t in range(SEQ_H):                       # t=0 — самый старый из окна
        k = d + (SEQ_H - 1 - t)
        a = _at(cum_rows, k)
        b = _at(cum_rows, k + 1)
        H[:, t] = np.where(k + 1 < M, a - b, a)
    H = np.clip(H, 0, None)
    V = np.zeros((n, SEQ_V))
    f = table.df
    fd = f["flydate"].values.astype("datetime64[ns]")
    for reis, ridx in pd.Series(range(n)).groupby(rows["reis"].values).indices.items():
        fidx = np.where(f["reis"].values == reis)[0]
        if len(fidx) == 0:
            continue
        dates = fd[fidx]
        asof = rows["as_of"].values.astype("datetime64[ns]")[ridx]
        pos = np.searchsorted(dates, asof, side="left")
        for j, r in enumerate(ridx):
            lo = max(0, pos[j] - SEQ_V)
            sel = fidx[lo:pos[j]]
            if len(sel):
                vals = table.cum[sel, min(d[r], M - 1)]
                V[r, SEQ_V - len(vals):] = vals
                V[r, :SEQ_V - len(vals)] = vals.mean()
    return H, V


def training_frame(table: FlightTable, horizon: str, min_history_days: int = 0) -> dict:
    """Обучающая выборка для горизонта: по строке на (вылет, DTD из окна горизонта).

    Возвращает dict: X (DataFrame признаков), y (итог), booked, cap, H, V (последовательности), meta
    (reis, od, flydate, as_of). Строки без единого вылета до даты прогноза остаются: для них
    работают запасные уровни.
    """
    h0, lo, hi = HORIZONS[horizon]
    f = table.df
    parts, cums = [], []
    first = f["flydate"].min() if len(f) else pd.Timestamp("2000-01-01")
    for d in range(lo, hi + 1):
        r = f[["reis", "flydate", "od", "dow", "cap"]].copy()
        r["dtd"] = d
        r["as_of"] = r["flydate"] - pd.to_timedelta(d, unit="D")
        r["idx"] = np.arange(len(f))
        r = r[(r["as_of"] - first).dt.days >= min_history_days]
        parts.append(r)
    rows = pd.concat(parts, ignore_index=True)
    cum_rows = table.cum[rows["idx"].values]
    X = make_features(table, rows, cum_rows, h0)
    H, V = build_sequences(table, rows, cum_rows)
    y = f["tickets"].values[rows["idx"].values].astype(float)
    return {"X": X, "y": y, "booked": X["booked"].values, "cap": rows["cap"].values, "H": H, "V": V,
            "meta": rows[["reis", "od", "flydate", "as_of", "dtd"]].reset_index(drop=True)}


# ------------------------------------------------------------------ прогноз по запросу

def template_curve(table: FlightTable, reis: str, od: str, as_of: pd.Timestamp, n: int = 40) -> np.ndarray:
    """Типичная кривая: последние n улетевших вылетов рейса -> направления -> всех. Запасной вариант — нули."""
    f = table.df
    done = (f["flydate"] < as_of).values
    for mask in ((f["reis"] == reis).values, (f["od"] == od).values, np.ones(len(f), bool)):
        idx = np.where(mask & done)[0][-n:]
        if len(idx) >= 3:
            return table.cum[idx].mean(axis=0)
    return np.zeros(MAX_DTD + 1)


def request_curve(table: FlightTable, reis: str, od: str, flydate: pd.Timestamp, current_booked: float,
                  dtd: int) -> np.ndarray:
    """Достраивает кривую будущего вылета по запросу.

    До текущего DTD берётся живая кривая из накопленных ежедневных файлов (если есть), иначе
    типичная кривая, приведённая к текущему числу проданных. Будущая часть — типичный прирост
    с масштабом по темпу продаж. Всегда монотонна и проходит через current_booked.
    """
    as_of = flydate - pd.Timedelta(days=dtd)
    T = template_curve(table, reis, od, as_of)
    M = len(T)
    c = np.zeros(M)
    cb = max(float(current_booked), 0.0)
    live = table.live.get((reis, flydate))
    base = max(T[min(dtd, M - 1)], 1e-6)
    scale = float(np.clip(cb / base, 0.25, 4.0)) if T.sum() > 0 else 1.0
    for k in range(M):
        if k >= dtd:
            if live is not None and k < len(live) and live[k] > 0:
                c[k] = min(live[k], cb)
            else:
                c[k] = cb * (T[k] / base) if T.sum() > 0 else cb
        else:
            c[k] = cb + (T[k] - T[min(dtd, M - 1)]) * scale if T.sum() > 0 else cb
    c[min(dtd, M - 1)] = cb
    # монотонность: cum не возрастает по k; c[dtd] остаётся равным current_booked
    return np.minimum.accumulate(c)


def inference_frames(table: FlightTable, reis: str, flydate: pd.Timestamp, current_booked: float, total_au: float,
                     dtd: int, od: str | None = None) -> dict:
    """Для запроса строит строку признаков и последовательности по КАЖДОМУ горизонту.

    Состояние рейса на точке горизонта h берётся из достроенной кривой: если h == dtd это текущее
    число проданных, если h < dtd — прогнозное (точка в будущем), если h > dtd — восстановленное
    (точка в прошлом). Возвращает {ключ_горизонта: {"X","H","V","h_dtd","distance"}}.
    """
    if od is None:
        known = table.df.loc[table.df["reis"] == reis, "od"]
        od = known.iloc[-1] if len(known) else ""
    flydate = pd.Timestamp(flydate).normalize()
    curve = request_curve(table, reis, od, flydate, current_booked, dtd)
    out = {}
    for key, (h0, lo, hi) in HORIZONS.items():
        d = int(np.clip(dtd, lo, hi)) if lo <= dtd <= hi else h0
        rows = pd.DataFrame({"reis": [reis], "flydate": [flydate], "od": [od], "dow": [flydate.dayofweek],
                             "cap": [float(total_au)], "dtd": [d],
                             "as_of": [flydate - pd.Timedelta(days=d)]})
        X = make_features(table, rows, curve[None, :], h0)
        H, V = build_sequences(table, rows, curve[None, :])
        out[key] = {"X": X, "H": H, "V": V, "h_dtd": d, "distance": abs(d - dtd),
                    "booked_at_h": float(X["booked"].iloc[0])}
    return out
