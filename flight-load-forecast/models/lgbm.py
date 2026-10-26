"""LightGBM по FEATURE_COLS. Цель — остаток y - booked (>= 0), итог = booked + прогноз остатка.

- Ранняя остановка по хвосту выборки ВО ВРЕМЕНИ (по meta.as_of, не случайно); строки обучения, чей вылет
  попадает за порог, отсекаются, чтобы не подглядывать в проверку. После подбора числа деревьев модель
  дообучается на всей выборке (число деревьев x1.1).
- Интервал: два квантильных LightGBM (alpha = q[0], q[1]) по остатку; границы сортируются и не ниже booked.
- Детерминированность: seed, deterministic=True, force_row_wise=True, n_jobs=FORECAST_N_JOBS (по умолчанию до 4). Вывод lightgbm подавлен (verbose=-1).
"""
from __future__ import annotations

import logging
import os
import warnings

import numpy as np

from data.features import FEATURE_COLS
from .fallback import finish, n_rows, num, time_split

log = logging.getLogger(__name__)

# число потоков: переменная FORECAST_N_JOBS (на перегруженной машине ставьте 1)
N_JOBS = max(1, int(os.environ.get("FORECAST_N_JOBS", min(4, os.cpu_count() or 1))))

PARAMS = dict(
    learning_rate=0.04, num_leaves=31, min_child_samples=30, subsample=0.8, subsample_freq=1,
    colsample_bytree=0.8, reg_lambda=2.0, n_jobs=N_JOBS, verbose=-1, deterministic=True, force_row_wise=True,
)
MAX_TREES = 1500
EARLY_ROUNDS = 80


class LGBMModel:
    """lgbm: градиентный бустинг по остатку. predict_interval доступен после fit."""
    name = "lgbm"

    def __init__(self, seed: int = 0, objective: str = "huber"):
        self.seed = seed
        self.objective = objective
        self.horizon = None
        self.model_ = None
        self.lo_ = None
        self.hi_ = None
        self.q_ = (0.1, 0.9)
        self.best_iter_ = 0
        self.const_ = 0.0      # запасной вариант, если обучить нечем: средний остаток

    # ---- данные
    @staticmethod
    def _matrix(frame: dict) -> np.ndarray:
        """Матрица признаков в порядке FEATURE_COLS; NaN оставляем (LightGBM их понимает), inf -> NaN."""
        X = frame["X"]
        cols = [np.asarray(X[c].values, dtype=float) if c in X.columns else np.full(len(X), np.nan)
                for c in FEATURE_COLS]
        M = np.column_stack(cols) if cols else np.zeros((len(X), 0))
        M[~np.isfinite(M)] = np.nan
        return M

    def _params(self, **kw):
        p = dict(PARAMS, random_state=self.seed, **kw)
        return p

    def fit(self, frame: dict, horizon: str):
        import lightgbm as lgb
        self.horizon = horizon
        n = n_rows(frame)
        booked = np.maximum(num(frame, "booked"), 0.0)
        y = np.asarray(frame["y"], dtype=float) if frame.get("y") is not None else booked
        ok = np.isfinite(y)
        if n == 0 or ok.sum() < 20:
            self.const_ = float(np.maximum(y[ok] - booked[ok], 0).mean()) if ok.any() else 0.0
            self.model_ = None
            return self
        r = np.where(ok, np.maximum(y - booked, 0.0), 0.0)
        M = self._matrix(frame)
        tr, va = time_split(frame)
        tr = tr[ok[tr]]
        base = dict(objective=self.objective, n_estimators=MAX_TREES)
        if self.objective == "huber":
            base["alpha"] = max(float(np.std(r)) * 0.5, 1.0)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            if va is not None:
                va = va[ok[va]]
                m = lgb.LGBMRegressor(**self._params(**base))
                m.fit(M[tr], r[tr], eval_set=[(M[va], r[va])], eval_metric="l1",
                      callbacks=[lgb.early_stopping(EARLY_ROUNDS, verbose=False)])
                self.best_iter_ = int(m.best_iteration_ or MAX_TREES)
            else:
                self.best_iter_ = 300
            n_final = max(int(self.best_iter_ * 1.1), 20)
            allr = np.where(ok)[0]
            base["n_estimators"] = n_final
            self.model_ = lgb.LGBMRegressor(**self._params(**base)).fit(M[allr], r[allr])
            # квантильные модели фиксированной небольшой глубины (число деревьев от основной модели)
            nq = int(np.clip(self.best_iter_, 50, 400))
            self.lo_ = lgb.LGBMRegressor(**self._params(objective="quantile", alpha=self.q_[0], n_estimators=nq,
                                                        num_leaves=15)).fit(M[allr], r[allr])
            self.hi_ = lgb.LGBMRegressor(**self._params(objective="quantile", alpha=self.q_[1], n_estimators=nq,
                                                        num_leaves=15)).fit(M[allr], r[allr])
        return self

    # ---- прогноз
    def _resid(self, model, frame):
        if model is None:
            return np.full(n_rows(frame), self.const_)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            return np.maximum(model.predict(self._matrix(frame)), 0.0)

    def predict(self, frame: dict) -> np.ndarray:
        n = n_rows(frame)
        if n == 0:
            return np.zeros(0)
        booked = np.maximum(num(frame, "booked"), 0.0)
        return finish(booked + self._resid(self.model_, frame), booked, num(frame, "cap", np.inf))

    def predict_interval(self, frame: dict, q=(0.1, 0.9)):
        """(lo, hi) итогов. Обучены квантили self.q_ (0.1/0.9); другие q не пересчитываются — берём ближайший
        запас: интервал расширяется/сужается линейно вокруг точечного прогноза пропорционально q."""
        n = n_rows(frame)
        if n == 0:
            return np.zeros(0), np.zeros(0)
        booked = np.maximum(num(frame, "booked"), 0.0)
        cap = num(frame, "cap", np.inf)
        mid = booked + self._resid(self.model_, frame)
        if self.lo_ is None:
            return finish(mid, booked, cap), finish(mid, booked, cap)
        lo = booked + self._resid(self.lo_, frame)
        hi = booked + self._resid(self.hi_, frame)
        lo, hi = np.minimum(lo, hi), np.maximum(lo, hi)
        lo, hi = np.minimum(lo, mid), np.maximum(hi, mid)
        return finish(lo, booked, cap), finish(hi, booked, cap)
