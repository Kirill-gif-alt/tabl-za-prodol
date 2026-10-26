"""Тесты базовых моделей (часть A): интерфейс, pickle/joblib, устойчивость к NaN, конечность прогноза."""
from __future__ import annotations

import io
import pickle

import joblib
import numpy as np
import pandas as pd
import pytest

from data.features import HORIZONS, build_flight_table, inference_frames, training_frame
from models.base import as_frame
from models.fallback import HierarchicalMeanModel
from models.lgbm import LGBMModel
from models.sequence import SequenceModel

MODELS = [HierarchicalMeanModel, LGBMModel, SequenceModel]


@pytest.fixture(scope="module")
def table():
    from data.synthetic import make_history
    return build_flight_table(make_history(start="2024-01-01", end="2024-07-31"))


@pytest.fixture(scope="module")
def frame(table):
    return training_frame(table, "7d")


def sub(fr: dict, idx) -> dict:
    """Срез кадра по индексам (X, y, booked, cap, H, V, meta)."""
    idx = np.asarray(idx)
    out = {"X": fr["X"].iloc[idx].reset_index(drop=True), "booked": fr["booked"][idx], "cap": fr["cap"][idx],
           "H": fr["H"][idx], "V": fr["V"][idx], "meta": fr["meta"].iloc[idx].reset_index(drop=True)}
    if "y" in fr:
        out["y"] = fr["y"][idx]
    return out


@pytest.fixture(scope="module")
def split(frame):
    order = np.argsort(frame["meta"]["as_of"].values, kind="stable")
    k = int(len(order) * 0.8)
    return sub(frame, order[:k]), sub(frame, order[k:])


@pytest.fixture(scope="module")
def fitted(split):
    tr, _ = split
    return {cls.name: cls(seed=0).fit(tr, "7d") for cls in MODELS}


def test_names_and_ctor():
    assert [c.name for c in MODELS] == ["hmean", "lgbm", "seq"]
    for c in MODELS:
        assert c(seed=3).seed == 3 and c().seed == 0


@pytest.mark.parametrize("cls", MODELS)
def test_predict_finite_and_bounds(cls, fitted, split):
    _, te = split
    p = fitted[cls.name].predict(te)
    assert p.shape == (len(te["y"]),) and np.isfinite(p).all()
    assert (p >= te["booked"] - 1e-9).all()          # итог не ниже проданного


def test_models_beat_booked(fitted, split):
    _, te = split
    base = np.abs(te["y"] - te["booked"]).mean()
    for name, m in fitted.items():
        assert np.abs(te["y"] - m.predict(te)).mean() < base, name


@pytest.mark.parametrize("cls", MODELS)
def test_pickle_and_joblib_same_predictions(cls, fitted, split, tmp_path):
    _, te = split
    te = sub(te, np.arange(min(200, len(te["y"]))))
    m = fitted[cls.name]
    p0 = m.predict(te)
    p1 = pickle.loads(pickle.dumps(m)).predict(te)
    joblib.dump(m, tmp_path / "m.joblib")
    p2 = joblib.load(tmp_path / "m.joblib").predict(te)
    assert np.allclose(p0, p1) and np.allclose(p0, p2)


@pytest.mark.parametrize("cls", MODELS)
def test_nan_input_does_not_crash(cls, fitted, split):
    _, te = split
    te = sub(te, np.arange(min(100, len(te["y"]))))
    bad = {k: (v.copy() if hasattr(v, "copy") else v) for k, v in te.items()}
    bad["X"] = bad["X"].copy()
    rng = np.random.default_rng(0)
    for c in bad["X"].columns:
        bad["X"].loc[rng.random(len(bad["X"])) < 0.3, c] = np.nan
    bad["H"] = bad["H"].copy()
    bad["V"] = bad["V"].copy()
    bad["H"][rng.random(bad["H"].shape) < 0.3] = np.nan
    bad["V"][::3, :] = np.nan
    bad["X"].loc[0, :] = np.nan                   # строка целиком из NaN
    bad["X"].loc[1, "booked"] = np.inf
    p = fitted[cls.name].predict(bad)
    assert p.shape == (len(bad["X"]),) and np.isfinite(p).all()


@pytest.mark.parametrize("cls", MODELS)
def test_empty_and_single_row(cls, fitted, split):
    _, te = split
    m = fitted[cls.name]
    empty = sub(te, np.arange(0))
    assert m.predict(empty).shape == (0,)
    one = sub(te, [0])
    p = m.predict(one)
    assert p.shape == (1,) and np.isfinite(p).all()


@pytest.mark.parametrize("cls", MODELS)
def test_fit_on_tiny_and_nan_target(cls, split):
    """Обучение на крошечной / пустой выборке и с NaN в цели не падает, прогноз конечный."""
    tr, te = split
    for k in (0, 1, 30):
        m = cls(seed=0).fit(sub(tr, np.arange(k)), "7d")
        p = m.predict(sub(te, np.arange(10)))
        assert p.shape == (10,) and np.isfinite(p).all()
    t2 = sub(tr, np.arange(len(tr["y"])))
    t2["y"] = t2["y"].copy()
    t2["y"][::5] = np.nan
    m = cls(seed=0).fit(t2, "7d")
    assert np.isfinite(m.predict(sub(te, np.arange(10)))).all()


def test_determinism(split):
    tr, te = split
    tr = sub(tr, np.arange(min(1500, len(tr["y"]))))
    for cls in (LGBMModel, HierarchicalMeanModel):
        a = cls(seed=1).fit(tr, "7d").predict(te)
        b = cls(seed=1).fit(tr, "7d").predict(te)
        assert np.array_equal(a, b), cls.name


def test_lgbm_interval(fitted, split):
    _, te = split
    m = fitted["lgbm"]
    lo, hi = m.predict_interval(te)
    p = m.predict(te)
    assert lo.shape == hi.shape == p.shape and np.isfinite(lo).all() and np.isfinite(hi).all()
    assert (lo <= p + 1e-9).all() and (p <= hi + 1e-9).all() and (lo >= te["booked"] - 1e-9).all()
    cover = ((te["y"] >= lo) & (te["y"] <= hi)).mean()
    assert 0.5 < cover <= 1.0


def test_lgbm_early_stopping_uses_time_tail(split):
    """Ранняя остановка включилась (есть meta.as_of) и число деревьев меньше потолка."""
    tr, _ = split
    m = LGBMModel(seed=0).fit(tr, "7d")
    assert 0 < m.best_iter_ < 1500


def test_seq_backend(fitted):
    assert fitted["seq"].backend_used_ in ("sklearn", "torch")


def test_hmean_not_worse_than_booked_on_sparse_levels(split):
    """Холодный старт: строки с малой историей рейса (низкий h_level) — не хуже «booked»."""
    tr, te = split
    m = HierarchicalMeanModel(seed=0).fit(tr, "7d")
    both = {k: np.concatenate([tr[k], te[k]]) if isinstance(tr[k], np.ndarray) else None
            for k in ("y", "booked", "cap")}
    X = pd.concat([tr["X"], te["X"]], ignore_index=True)
    mask = (X["h_n_reis"].values < 10) | (X["h_level"].values <= 2)
    if mask.sum() < 5:
        pytest.skip("нет редких строк")
    fr = {"X": X[mask].reset_index(drop=True), "booked": both["booked"][mask], "cap": both["cap"][mask]}
    p = m.predict(fr)
    y = both["y"][mask]
    assert np.abs(y - p).mean() <= np.abs(y - fr["booked"]).mean() + 1e-9


def test_inference_frames_roundtrip(table, fitted):
    """Кадр из inference_frames (как делает ансамбль) проходит через predict."""
    reis = table.df["reis"].iloc[-1]
    fd = table.df["flydate"].max() + pd.Timedelta(days=10)
    inf = inference_frames(table, reis, fd, current_booked=30, total_au=100, dtd=7)
    fr = as_frame(inf["7d"])
    for name, m in fitted.items():
        p = m.predict(fr)
        assert p.shape == (1,) and np.isfinite(p).all() and p[0] >= 30, name
    for key in HORIZONS:
        assert as_frame(inf[key])["X"].shape[0] == 1
