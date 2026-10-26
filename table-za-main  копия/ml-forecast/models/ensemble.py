"""Ансамбль базовых моделей: стекинг NNLS по неотрицательным весам + сдвиг (bias), лёгкое дообучение.

Для каждого горизонта (30d/14d/7d/1_3d) обучается свой набор базовых моделей. Веса подбираются на
временной проверке (последние valid_frac по as_of, без утечки: обучение — только вылеты, которые улетели
до начала проверки). Затем базовые модели дообучаются на всех данных.

Единицы метрик: mae — в пассажирах, mape — в процентах (по строкам с y > 0). Метрики считаются по прогнозам,
ограниченным [продано, вместимость] (так их увидит пользователь), а веса — по сырым прогнозам.
Неопределённые метрики (нет строк проверки) — None.
"""
from __future__ import annotations

import hashlib
import logging
import pickle
import platform
import sys

import numpy as np
import pandas as pd

from critic.critic import ErrorLedger
from data.features import HORIZONS, FlightTable, training_frame
from models.registry import default_models

log = logging.getLogger(__name__)

MIN_VALID = 30        # меньше строк проверки — равные веса, bias = 0
INERTIA = 0.5         # доля старых весов при дообучении (recalibrate)
BIAS_FRAC = 0.05      # |bias| <= BIAS_FRAC * средний итог (но не меньше 1 пассажира)
MIN_TRAIN = 20        # меньше строк обучения — проверки нет, обучаем сразу на всём


# ---------------------------------------------------------------------- вспомогательное

def _nnls(A: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Неотрицательные наименьшие квадраты (scipy, иначе простой координатный спуск)."""
    try:
        from scipy.optimize import nnls
        return nnls(A, b, maxiter=50 * A.shape[1] + 200)[0]
    except Exception:
        w = np.zeros(A.shape[1])
        AtA, Atb = A.T @ A, A.T @ b
        for _ in range(500):
            for j in range(len(w)):
                if AtA[j, j] > 0:
                    w[j] = max(0.0, (Atb[j] - AtA[j] @ w + AtA[j, j] * w[j]) / AtA[j, j])
        return w


def _norm_weights(w: np.ndarray) -> np.ndarray:
    w = np.where(np.isfinite(w) & (w > 0), w, 0.0)
    s = w.sum()
    return w / s if s > 1e-9 else np.full(len(w), 1.0 / len(w))


def _subset(frame: dict, idx: np.ndarray) -> dict:
    out = {"X": frame["X"].iloc[idx].reset_index(drop=True)}
    for k in ("y", "booked", "cap", "H", "V"):
        if k in frame:
            out[k] = frame[k][idx]
    if "meta" in frame:
        out["meta"] = frame["meta"].iloc[idx].reset_index(drop=True)
    return out


def _prep(frame: dict) -> dict:
    """Кадр из as_frame/inference_frames -> кадр для predict (добавляем booked/cap, если их нет)."""
    f = dict(frame)
    X = f["X"]
    if "booked" not in f:
        f["booked"] = X["booked"].values
    if "cap" not in f:
        f["cap"] = X["cap"].values
    return f


def _predict_all(models: list, frame: dict) -> dict:
    """Прогнозы каждой модели; упавшая модель пропускается с warning."""
    n = len(frame["booked"])
    out = {}
    for m in models:
        try:
            p = np.asarray(m.predict(frame), dtype=float).reshape(-1)
            if len(p) != n:
                raise ValueError(f"длина прогноза {len(p)} != {n}")
            out[m.name] = p
        except Exception as e:
            log.warning("модель %s упала при прогнозе: %s", getattr(m, "name", m), e)
    return out


def _combine(preds: dict, weights: dict, bias: float) -> np.ndarray:
    """Взвешенная сумма прогнозов + bias. Нефинитные значения исключаются поэлементно (веса пересчитываются)."""
    names = list(preds)
    P = np.column_stack([preds[n] for n in names])
    w = np.array([max(float(weights.get(n, 0.0)), 0.0) for n in names])
    if w.sum() <= 1e-9:
        w = np.ones(len(names))
    fin = np.isfinite(P)
    W = fin * w[None, :]
    den = W.sum(axis=1)
    num = (np.where(fin, P, 0.0) * W).sum(axis=1)
    with np.errstate(invalid="ignore", divide="ignore"):
        ens = np.where(den > 0, num / den, np.nan)
    return ens + bias


def _clip(p: np.ndarray, booked: np.ndarray, cap: np.ndarray) -> np.ndarray:
    p = np.where(np.isfinite(p), p, booked)
    return np.clip(p, booked, np.maximum(cap, booked))


def _metric(y: np.ndarray, p: np.ndarray) -> dict:
    n = int(len(y))
    if n == 0:
        return {"mae": None, "mape": None, "n": 0}
    err = np.abs(y - p)
    pos = y > 0
    mape = float(np.mean(err[pos] / y[pos]) * 100.0) if pos.any() else None
    return {"mae": float(err.mean()), "mape": mape, "n": n}


def _bias_limit(y: np.ndarray) -> float:
    return max(1.0, BIAS_FRAC * float(np.mean(y))) if len(y) else 1.0


def _center_rows(meta: pd.DataFrame, h0: int) -> np.ndarray:
    """По одной строке на вылет — с DTD ближе всего к центру горизонта (для журнала ошибок)."""
    d = pd.DataFrame({"reis": meta["reis"].values, "fd": meta["flydate"].values,
                      "a": np.abs(meta["dtd"].values - h0), "pos": np.arange(len(meta))})
    d = d.sort_values(["a", "pos"]).drop_duplicates(["reis", "fd"]).sort_values(["fd", "pos"])
    return d["pos"].values


def _lib_versions() -> dict:
    out = {"python": platform.python_version()}
    for mod in ("numpy", "pandas", "scipy", "sklearn", "lightgbm", "joblib", "torch"):
        try:
            out[mod] = getattr(__import__(mod), "__version__", "?")
        except Exception:
            out[mod] = None
    return out


# ---------------------------------------------------------------------- ансамбль

class EnsembleForecaster:
    """Ансамбль по горизонтам. Picklable (фабрику моделей, которую нельзя запиклить, при сохранении отбрасываем)."""

    def __init__(self, seed: int = 0, models_factory=None):
        self.seed = seed
        self.models_factory = models_factory
        self.models: dict[str, list] = {}         # горизонт -> обученные базовые модели
        self.weights: dict[str, dict] = {}        # горизонт -> {имя модели: вес}, сумма = 1
        self.bias: dict[str, float] = {}          # горизонт -> сдвиг ансамбля
        self.metrics: dict = {}                   # метрики последнего fit/recalibrate
        self.ledger = ErrorLedger()
        self._recal_sig: dict[str, str] = {}      # горизонт -> подпись данных последнего обновления весов

    # ---- служебное
    def _new_models(self) -> list:
        factory = self.models_factory or default_models
        try:
            return list(factory(self.seed))
        except TypeError:
            return list(factory())

    def __getstate__(self):
        st = self.__dict__.copy()
        if st.get("models_factory") is not None:
            try:
                pickle.dumps(st["models_factory"])
            except Exception:
                log.warning("фабрика моделей не сериализуется — после загрузки будет default_models")
                st["models_factory"] = None
        return st

    def model_names(self, horizon: str) -> list[str]:
        """Имена базовых моделей горизонта + 'ensemble' (те же ключи, что возвращает predict)."""
        ms = self.models.get(horizon)
        return [m.name for m in ms] + ["ensemble"] if ms else []

    def info(self) -> dict:
        return {"versions": _lib_versions(), "seed": self.seed, "fitted": bool(self.models),
                "models": {h: self.model_names(h) for h in HORIZONS},
                "weights": {h: {k: round(float(v), 4) for k, v in w.items()} for h, w in self.weights.items()},
                "bias": {h: round(float(b), 4) for h, b in self.bias.items()},
                "ledger_size": len(self.ledger)}

    # ---- обучение
    @staticmethod
    def _split(meta: pd.DataFrame, valid_frac: float):
        """Время-разбиение по as_of. Обучение — вылеты, улетевшие ДО отсечки; проверка — прогнозы на/после отсечки
        (значит их flydate позже конца обучения). Строки между ними (зазор в окно горизонта) выбрасываются."""
        n = len(meta)
        if n == 0 or not (0 < valid_frac < 1):
            return np.arange(n), np.array([], dtype=int)
        asof = meta["as_of"].values
        cut = np.sort(asof)[min(max(int(n * (1 - valid_frac)), 0), n - 1)]
        tr = np.flatnonzero(meta["flydate"].values < cut)
        va = np.flatnonzero(asof >= cut)
        if len(tr) < MIN_TRAIN or len(va) == 0:
            return np.arange(n), np.array([], dtype=int)
        return tr, va

    def _fit_models(self, frame: dict, horizon: str, only: set | None = None) -> list:
        fitted = []
        for m in self._new_models():
            if only is not None and getattr(m, "name", None) not in only:
                continue
            try:
                m.fit(frame, horizon)
                fitted.append(m)
            except Exception as e:
                log.warning("[%s] модель %s не обучилась: %s", horizon, getattr(m, "name", m), e)
        return fitted

    def _record(self, horizon: str, meta: pd.DataFrame, y: np.ndarray, booked, cap, preds: dict, rows: np.ndarray):
        """Ошибки по центральным строкам вылетов -> журнал (идемпотентно по ключу)."""
        added = 0
        for name, p in preds.items():
            pc = _clip(p, booked, cap)
            for i in rows:
                err = abs(float(y[i]) - float(pc[i]))
                pct = err / y[i] * 100.0 if y[i] > 0 else None
                fd = pd.Timestamp(meta["flydate"].iloc[i])
                key = (meta["reis"].iloc[i], fd.date().isoformat(), horizon, name)
                added += self.ledger.record(name, horizon, meta["reis"].iloc[i], meta["od"].iloc[i], err, pct,
                                            fd.date().isoformat(), key=key)
        return added

    def _metrics_for(self, horizon: str, y, booked, cap, preds: dict, weights: dict, bias: float) -> dict:
        res = {}
        for name, p in preds.items():
            res[name] = _metric(y, _clip(p, booked, cap))
        if preds:
            res["ensemble"] = _metric(y, _clip(_combine(preds, weights, bias), booked, cap))
        res["_baseline_booked"] = _metric(y, np.asarray(booked, dtype=float))
        for name, m in res.items():
            log.info("[%s] %-18s MAE=%s MAPE=%s%% n=%d", horizon, name,
                     "н/д" if m["mae"] is None else f"{m['mae']:.2f}",
                     "н/д" if m["mape"] is None else f"{m['mape']:.1f}", m["n"])
        return res

    def fit(self, table: FlightTable, valid_frac: float = 0.15) -> dict:
        self.models, self.weights, self.bias, self._recal_sig = {}, {}, {}, {}
        self.ledger = ErrorLedger()
        metrics: dict = {}
        for h, (h0, _, _) in HORIZONS.items():
            fr = training_frame(table, h)
            n = len(fr["y"])
            if n == 0:
                log.warning("[%s] нет обучающих строк", h)
                metrics[h] = {}
                continue
            tr, va = self._split(fr["meta"], valid_frac)
            f_tr = fr if len(va) == 0 else _subset(fr, tr)
            f_va = _subset(fr, va) if len(va) else None

            models = self._fit_models(f_tr, h)
            if not models:
                log.warning("[%s] ни одна модель не обучилась", h)
                metrics[h] = {"_baseline_booked": _metric(fr["y"], fr["booked"])}
                continue
            names = [m.name for m in models]

            w = np.full(len(names), 1.0 / len(names))
            bias = 0.0
            preds_va: dict = {}
            if f_va is not None:
                preds_va = _predict_all(models, f_va)
                if len(preds_va) < len(models):     # модель упала на проверке — выкидываем из ансамбля
                    models = [m for m in models if m.name in preds_va]
                    names = [m.name for m in models]
                    w = np.full(len(names), 1.0 / len(names))
                if len(f_va["y"]) >= MIN_VALID and names:
                    yv, bv = f_va["y"], f_va["booked"]
                    P = np.column_stack([np.where(np.isfinite(preds_va[k]), preds_va[k], bv) for k in names])
                    w = _norm_weights(_nnls(P, yv))
                    resid = yv - P @ w
                    lim = _bias_limit(yv)
                    bias = float(np.clip(np.median(resid), -lim, lim))
                else:
                    log.warning("[%s] строк проверки %d < %d — равные веса", h, len(f_va["y"]), MIN_VALID)
            weights = dict(zip(names, map(float, w)))

            if f_va is not None and preds_va:
                metrics[h] = self._metrics_for(h, f_va["y"], f_va["booked"], f_va["cap"], preds_va, weights, bias)
                ens = _combine(preds_va, weights, bias)
                rows = _center_rows(f_va["meta"], h0)
                self._record(h, f_va["meta"], f_va["y"], f_va["booked"], f_va["cap"],
                             {**preds_va, "ensemble": ens}, rows)
            else:
                log.warning("[%s] проверки нет — метрики не посчитаны", h)
                metrics[h] = {k: {"mae": None, "mape": None, "n": 0} for k in names + ["ensemble"]}
                metrics[h]["_baseline_booked"] = _metric(fr["y"], fr["booked"])

            # в конце дообучаем базовые на всех данных
            final = self._fit_models(fr, h, only=set(names))
            if not final:
                log.warning("[%s] финальное дообучение не удалось — оставляю модели, обученные на части данных", h)
                final = models
            fnames = [m.name for m in final]
            wf = _norm_weights(np.array([weights.get(k, 0.0) for k in fnames]))
            self.models[h] = final
            self.weights[h] = dict(zip(fnames, map(float, wf)))
            self.bias[h] = bias
        self.metrics = metrics
        return metrics

    # ---- прогноз
    def predict(self, horizon: str, frame: dict) -> dict:
        """Сырые прогнозы по именам моделей + 'ensemble'. Упавшая модель пропускается (warning). Не бросает."""
        try:
            models = self.models.get(horizon)
            if not models:
                return {}
            f = _prep(frame)
            preds = _predict_all(models, f)
            if not preds:
                return {}
            preds["ensemble"] = _combine(preds, self.weights.get(horizon, {}), self.bias.get(horizon, 0.0))
            return preds
        except Exception as e:
            log.warning("[%s] ансамбль не смог построить прогноз: %s", horizon, e)
            return {}

    # ---- лёгкое дообучение
    def recalibrate(self, table: FlightTable, since) -> dict:
        """Пересчёт ошибок по вылетам flydate >= since, сдвиг весов/bias без ретрейна. Идемпотентно."""
        since = pd.Timestamp(since)
        metrics: dict = {}
        for h, (h0, _, _) in HORIZONS.items():
            models = self.models.get(h)
            if not models:
                continue
            fr = training_frame(table, h)
            idx = np.flatnonzero(pd.to_datetime(fr["meta"]["flydate"]).values >= since.to_datetime64())
            if len(idx) == 0:
                log.info("[%s] нет вылетов с %s — дообучать нечем", h, since.date())
                metrics[h] = {}
                continue
            sub = _subset(fr, idx)
            preds = _predict_all(models, sub)
            if not preds:
                continue
            y, booked, cap = sub["y"], sub["booked"], sub["cap"]
            names = list(preds)
            w_old = self.weights.get(h, {})
            b_old = self.bias.get(h, 0.0)

            # 1) ошибки текущих (до обновления весов) моделей -> журнал; дубли по ключу отсекаются
            added = self._record(h, sub["meta"], y, booked, cap, {**preds, "ensemble": _combine(preds, w_old, b_old)},
                                 _center_rows(sub["meta"], h0))

            # 2) сдвиг весов и bias к NNLS по свежим данным; та же выборка вылетов -> без изменений
            sig = hashlib.sha1((f"{len(y)}|{float(np.sum(y)):.3f}|" + "|".join(sorted(
                f"{r}@{pd.Timestamp(d).value}" for r, d in
                set(zip(sub["meta"]["reis"], sub["meta"]["flydate"]))))).encode()).hexdigest()
            updated = False
            if len(y) >= MIN_VALID and sig != self._recal_sig.get(h):
                P = np.column_stack([np.where(np.isfinite(preds[k]), preds[k], booked) for k in names])
                w_fresh = _norm_weights(_nnls(P, y))
                w_prev = np.array([w_old.get(k, 0.0) for k in names])
                w_prev = _norm_weights(w_prev) if w_prev.sum() > 0 else np.full(len(names), 1.0 / len(names))
                w_new = _norm_weights(INERTIA * w_prev + (1 - INERTIA) * w_fresh)
                lim = _bias_limit(y)
                b_fresh = float(np.median(y - P @ w_new))
                b_new = float(np.clip(INERTIA * b_old + (1 - INERTIA) * b_fresh, -lim, lim))
                self.weights[h] = dict(zip(names, map(float, w_new)))
                self.bias[h] = b_new
                self._recal_sig[h] = sig
                updated = True
            log.info("[%s] recalibrate: строк %d, новых записей в журнале %d, веса %s", h, len(y), added,
                     "обновлены" if updated else "без изменений")
            metrics[h] = self._metrics_for(h, y, booked, cap, preds, self.weights[h], self.bias[h])
        self.metrics = {**self.metrics, **metrics}
        return metrics
