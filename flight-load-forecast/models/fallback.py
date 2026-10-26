"""Запасная модель: иерархические средние (рейс×день недели -> направление -> общий).

Иерархия уже заложена в признаках `h_final` / `h_book` / `h_rem` / `h_level` (см. data.features.hist_stats:
сжатие к родительскому уровню, k=5). Здесь поверх неё стоит собственная простая оценка:

    pred = booked + k1[level] * h_rem + k2[level] * booked * (h_final / h_book - 1)+

k1, k2 >= 0 подбираются неотрицательным МНК отдельно по каждому уровню `h_level` (0 — общий, 4 — рейс×день
недели) со сжатием к глобальным коэффициентам. Если на хвосте выборки (по времени) уровень не лучше
простого «booked», его коэффициенты обнуляются, и на редких маршрутах модель не хуже «booked».
"""
from __future__ import annotations

import logging

import numpy as np
from scipy.optimize import nnls

log = logging.getLogger(__name__)

N_LEVELS = 5          # h_level принимает значения 0..4
SHRINK_N = 200.0      # сжатие коэффициента уровня к глобальному: w = n / (n + SHRINK_N)


def num(frame: dict, name: str, default: float = 0.0) -> np.ndarray:
    """Столбец признаков X как конечный float-массив (NaN/inf -> default). Нет столбца -> default."""
    X = frame.get("X")
    if X is not None and name in getattr(X, "columns", ()):
        v = np.asarray(X[name].values, dtype=float)
    elif name in ("booked", "cap") and frame.get(name) is not None:
        v = np.asarray(frame[name], dtype=float)
    else:
        n = 0 if X is None else len(X)
        v = np.full(n, default)
    return np.where(np.isfinite(v), v, default)


def n_rows(frame: dict) -> int:
    X = frame.get("X")
    return 0 if X is None else len(X)


def finish(pred: np.ndarray, booked: np.ndarray, cap: np.ndarray) -> np.ndarray:
    """Итог не ниже проданного и (если потолок известен и не ниже проданного) не выше потолка; всегда конечный."""
    pred = np.where(np.isfinite(pred), pred, booked)
    pred = np.maximum(pred, booked)
    ok = np.isfinite(cap) & (cap >= booked) & (cap > 0)
    return np.where(ok, np.minimum(pred, cap), pred)


def time_split(frame: dict, frac: float = 0.15):
    """Индексы (обучение, проверка): хвост выборки ПО ВРЕМЕНИ (meta.as_of), с отсечением пересечения по вылетам.

    Строки обучения: as_of < порога и flydate <= порога (итог вылета известен до порога, без утечки в проверку).
    Если meta нет или выборка мала — проверки нет: (все индексы, None).
    """
    n = n_rows(frame)
    idx = np.arange(n)
    meta = frame.get("meta")
    if meta is None or n < 200 or "as_of" not in meta:
        return idx, None
    asof = np.asarray(meta["as_of"].values, dtype="datetime64[ns]")
    cut = np.quantile(asof.astype(np.int64), 1.0 - frac)
    va = asof.astype(np.int64) >= cut
    tr = ~va
    if "flydate" in meta:
        fd = np.asarray(meta["flydate"].values, dtype="datetime64[ns]").astype(np.int64)
        tr &= fd <= cut
    if tr.sum() < 100 or va.sum() < 30:
        return idx, None
    return np.where(tr)[0], np.where(va)[0]


class HierarchicalMeanModel:
    """hmean: booked + поправка по историческому остатку (h_rem), коэффициенты по уровням иерархии."""
    name = "hmean"

    def __init__(self, seed: int = 0):
        self.seed = seed
        self.horizon = None
        self.coef_ = np.zeros((N_LEVELS, 2))   # k1, k2 по уровням
        self.fitted_ = False

    # ---- компоненты оценки
    @staticmethod
    def _components(frame: dict) -> np.ndarray:
        booked = np.maximum(num(frame, "booked"), 0.0)
        h_rem = np.maximum(num(frame, "h_rem"), 0.0)
        h_final = np.maximum(num(frame, "h_final"), 0.0)
        h_book = np.maximum(num(frame, "h_book"), 0.0)
        ratio_rem = np.maximum(booked * h_final / np.maximum(h_book, 1.0) - booked, 0.0)
        return np.column_stack([h_rem, np.minimum(ratio_rem, 3.0 * np.maximum(h_rem, 1.0) + 5.0)])

    @staticmethod
    def _levels(frame: dict) -> np.ndarray:
        return np.clip(np.rint(num(frame, "h_level")), 0, N_LEVELS - 1).astype(int)

    @staticmethod
    def _nnls(C: np.ndarray, r: np.ndarray) -> np.ndarray:
        if len(r) == 0 or not C.any():
            return np.zeros(2)
        try:
            return nnls(C, r)[0]
        except Exception:
            return np.zeros(2)

    def _fit_coef(self, C, r, lv, rows) -> np.ndarray:
        g = self._nnls(C[rows], r[rows])
        coef = np.tile(g, (N_LEVELS, 1))
        for l in range(N_LEVELS):
            m = rows[lv[rows] == l]
            if len(m) >= 20:
                w = len(m) / (len(m) + SHRINK_N)
                coef[l] = w * self._nnls(C[m], r[m]) + (1 - w) * g
        return coef

    def fit(self, frame: dict, horizon: str):
        self.horizon = horizon
        n = n_rows(frame)
        if n == 0:
            self.fitted_ = True
            return self
        booked = np.maximum(num(frame, "booked"), 0.0)
        y = np.asarray(frame.get("y", booked), dtype=float)
        ok = np.isfinite(y)
        r = np.where(ok, np.maximum(y - booked, 0.0), 0.0)
        C, lv = self._components(frame), self._levels(frame)
        tr, va = time_split(frame)
        tr = tr[ok[tr]]
        coef = self._fit_coef(C, r, lv, tr)
        if va is not None:
            # уровень, на котором хвост по времени не лучше «booked», отключаем (k=0)
            va = va[ok[va]]
            for l in range(N_LEVELS):
                m = va[lv[va] == l]
                if len(m) < 20:
                    continue
                e_model = np.abs(r[m] - C[m] @ coef[l]).mean()
                e_booked = np.abs(r[m]).mean()
                if e_model >= e_booked:
                    log.info("hmean[%s]: уровень %d не лучше booked (%.2f >= %.2f), коэффициенты обнулены",
                             horizon, l, e_model, e_booked)
                    coef[l] = 0.0
            tr = np.where(ok)[0]
            # коэффициенты не переобучаем после обнуления: берём пересчёт только для включённых уровней
            full = self._fit_coef(C, r, lv, tr)
            coef = np.where(coef.any(axis=1, keepdims=True), full, 0.0)
        self.coef_ = coef
        self.fitted_ = True
        return self

    def predict(self, frame: dict) -> np.ndarray:
        n = n_rows(frame)
        if n == 0:
            return np.zeros(0)
        booked = np.maximum(num(frame, "booked"), 0.0)
        if not self.fitted_:
            return booked
        C, lv = self._components(frame), self._levels(frame)
        add = (C * self.coef_[lv]).sum(axis=1)
        return finish(booked + add, booked, num(frame, "cap", np.inf))
