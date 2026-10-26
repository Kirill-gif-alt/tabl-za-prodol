"""Тесты ансамбля на малой синтетике с заглушками вместо настоящих моделей."""
import copy
import json
import logging
import pickle

import numpy as np
import pandas as pd
import pytest

from critic.critic import Critic
from data.features import HORIZONS, build_flight_table, inference_frames, training_frame
from data.synthetic import ROUTES, make_history
from models.base import BaseModel, as_frame
from models.ensemble import EnsembleForecaster, MIN_VALID, _nnls, _norm_weights


# ---------------------------------------------------------------- заглушки

class LastBooked(BaseModel):
    """Последнее число проданных."""
    name = "last"

    def fit(self, frame, horizon):
        return self

    def predict(self, frame):
        return np.asarray(frame["booked"], float)


class HistMean(BaseModel):
    """Среднее по h_final."""
    name = "hist"

    def fit(self, frame, horizon):
        return self

    def predict(self, frame):
        return frame["X"]["h_final"].values.astype(float)


class BookedPlusRem(BaseModel):
    """booked + h_rem."""
    name = "rem"

    def fit(self, frame, horizon):
        return self

    def predict(self, frame):
        return frame["X"]["booked"].values + frame["X"]["h_rem"].values


class Broken(BaseModel):
    name = "broken"

    def fit(self, frame, horizon):
        return self

    def predict(self, frame):
        raise RuntimeError("модель сломалась")


class FitFails(BaseModel):
    name = "nofit"

    def fit(self, frame, horizon):
        raise RuntimeError("не обучается")

    def predict(self, frame):
        return np.zeros(len(frame["booked"]))


class NaNModel(BaseModel):
    name = "nan"

    def fit(self, frame, horizon):
        return self

    def predict(self, frame):
        out = np.asarray(frame["booked"], float) + 5.0
        out[::2] = np.nan
        return out


class Spy(BaseModel):
    """Запоминает, на чём обучали и что прогнозировали (для проверки утечки)."""
    name = "spy"
    fits: list = []
    predicts: list = []

    def fit(self, frame, horizon):
        Spy.fits.append((horizon, frame["meta"].copy()))
        return self

    def predict(self, frame):
        if "meta" in frame:
            Spy.predicts.append(frame["meta"].copy())
        return np.asarray(frame["booked"], float)


def stub_factory(seed=0):
    return [LastBooked(), HistMean(), BookedPlusRem()]


def broken_factory(seed=0):
    return [LastBooked(), HistMean(), Broken()]


@pytest.fixture(scope="module")
def table():
    h = make_history(start="2024-01-01", end="2024-05-31", routes=ROUTES[:2], seed=3)
    return build_flight_table(h)


@pytest.fixture(scope="module")
def fitted(table):
    ens = EnsembleForecaster(seed=0, models_factory=stub_factory)
    metrics = ens.fit(table)
    return ens, metrics


# ---------------------------------------------------------------- fit

def test_fit_metrics_structure(fitted, caplog):
    ens, metrics = fitted
    assert set(metrics) == set(HORIZONS)
    for h, m in metrics.items():
        assert set(m) == {"last", "hist", "rem", "ensemble", "_baseline_booked"}
        for name, v in m.items():
            assert set(v) == {"mae", "mape", "n"}
            assert v["n"] > 0 and v["mae"] >= 0 and v["mape"] >= 0
        assert len({v["n"] for v in m.values()}) == 1          # одна и та же проверка
        # ансамбль не хуже худшей модели и заметно лучше «просто проданное»
        worst = max(m[k]["mae"] for k in ("last", "hist", "rem"))
        assert m["ensemble"]["mae"] <= worst + 1e-9
        assert m["ensemble"]["mae"] < m["_baseline_booked"]["mae"] or h == "1_3d"
        # last == booked == baseline
        assert m["last"]["mae"] == pytest.approx(m["_baseline_booked"]["mae"])
    json.dumps(metrics)                                           # JSON-совместимо


def test_fit_logs_one_line_per_model(table, caplog):
    with caplog.at_level(logging.INFO, logger="models.ensemble"):
        EnsembleForecaster(models_factory=stub_factory).fit(table)
    lines = [r.getMessage() for r in caplog.records if "MAE=" in r.getMessage()]
    assert len(lines) == len(HORIZONS) * 5                        # 3 модели + ensemble + baseline на горизонт
    assert any("[7d]" in s and "ensemble" in s for s in lines)


def test_weights_nonneg_sum_one(fitted):
    ens, _ = fitted
    for h in HORIZONS:
        w = ens.weights[h]
        assert set(w) == {"last", "hist", "rem"}
        assert all(v >= 0 for v in w.values()) and sum(w.values()) == pytest.approx(1.0)
        assert abs(ens.bias[h]) < 50
    assert ens.model_names("7d") == ["last", "hist", "rem", "ensemble"]
    assert ens.model_names("nope") == []


def test_no_leak_between_train_and_valid(table):
    Spy.fits, Spy.predicts = [], []
    EnsembleForecaster(models_factory=lambda seed=0: [Spy()]).fit(table, valid_frac=0.2)
    # на каждый горизонт: 1-й fit (обучение), predict по проверке, 2-й fit (на всём)
    assert len(Spy.fits) == 2 * len(HORIZONS) and len(Spy.predicts) == len(HORIZONS)
    for i in range(len(HORIZONS)):
        _, tr = Spy.fits[2 * i]
        _, full = Spy.fits[2 * i + 1]
        va = Spy.predicts[i]
        # обучение целиком улетело до первого прогноза проверки (итоги известны на момент as_of проверки)
        assert tr["flydate"].max() < va["as_of"].min()
        assert va["flydate"].min() > tr["flydate"].max()
        assert len(full) > len(tr) + len(va) - 1 and len(va) > 0


def test_few_valid_rows_equal_weights(table):
    ens = EnsembleForecaster(models_factory=stub_factory)
    small = type(table)(table.df.iloc[:40].reset_index(drop=True), table.cum[:40])
    m = ens.fit(small, valid_frac=0.05)
    for h in HORIZONS:
        if h in ens.weights:
            assert ens.weights[h] == pytest.approx({"last": 1 / 3, "hist": 1 / 3, "rem": 1 / 3})
            assert ens.bias[h] == 0.0


def test_fit_tolerates_model_failures(table):
    ens = EnsembleForecaster(models_factory=lambda seed=0: [LastBooked(), FitFails(), HistMean()])
    m = ens.fit(table)
    assert "nofit" not in m["7d"] and "nofit" not in ens.weights["7d"]
    assert "ensemble" in m["7d"]


def test_nnls_recovers_mixture():
    rng = np.random.default_rng(0)
    a, b, c = rng.normal(100, 20, (3, 500))
    y = 0.7 * a + 0.3 * b
    w = _norm_weights(_nnls(np.column_stack([a, b, c]), y))
    assert w == pytest.approx([0.7, 0.3, 0.0], abs=1e-6)
    assert _norm_weights(np.zeros(3)) == pytest.approx([1 / 3] * 3)


# ---------------------------------------------------------------- predict

def _sample_frame(table, h, n=40):
    fr = training_frame(table, h)
    idx = np.arange(0, len(fr["y"]), max(len(fr["y"]) // n, 1))[:n]
    X = fr["X"].iloc[idx].reset_index(drop=True)
    return {"X": X, "H": fr["H"][idx], "V": fr["V"][idx]}      # без booked/cap, как из inference_frames


def test_predict_matches_weights(fitted, table):
    ens, _ = fitted
    fr = _sample_frame(table, "14d")
    p = ens.predict("14d", fr)
    assert list(p) == ["last", "hist", "rem", "ensemble"]
    w = ens.weights["14d"]
    expect = sum(w[k] * p[k] for k in w) + ens.bias["14d"]
    assert p["ensemble"] == pytest.approx(expect)
    assert all(len(v) == 40 and np.isfinite(v).all() for v in p.values())


def test_predict_unfitted_or_unknown_returns_empty(fitted, table):
    ens, _ = fitted
    assert ens.predict("nope", _sample_frame(table, "7d")) == {}
    assert EnsembleForecaster(models_factory=stub_factory).predict("7d", _sample_frame(table, "7d")) == {}
    assert ens.predict("7d", {"X": None}) == {}


def test_predict_survives_broken_model(table, caplog):
    ens = EnsembleForecaster(models_factory=broken_factory)
    ens.fit(table)
    with caplog.at_level(logging.WARNING, logger="models.ensemble"):
        p = ens.predict("7d", _sample_frame(table, "7d"))
    assert "broken" not in p and "ensemble" in p and set(p) == {"last", "hist", "ensemble"}
    assert any("broken" in r.getMessage() for r in caplog.records)
    assert np.isfinite(p["ensemble"]).all()


def test_predict_nan_model_is_ignored_per_row(table):
    ens = EnsembleForecaster(models_factory=lambda seed=0: [LastBooked(), NaNModel()])
    ens.fit(table)
    p = ens.predict("7d", _sample_frame(table, "7d"))
    assert np.isnan(p["nan"]).any()
    assert np.isfinite(p["ensemble"]).all()                      # там, где nan-модель молчит, веса пересчитаны


def test_predict_on_inference_frame_and_critic(fitted, table):
    ens, _ = fitted
    last = table.df.iloc[-1]
    inf = inference_frames(table, last["reis"], last["flydate"] + pd.Timedelta(days=5), 20, 72, 7, od=last["od"])
    critic = Critic(ens.ledger)
    for h, item in inf.items():
        preds = ens.predict(h, as_frame(item))
        v = critic.review(h, {k: float(a[0]) for k, a in preds.items()}, 20, 72, 7, last["reis"], last["od"],
                          item["distance"])
        assert 20 <= v.pred <= 72 and v.chosen_model.endswith(f"_{h}")


# ---------------------------------------------------------------- журнал

def test_ledger_filled_after_fit(fitted, table):
    ens, _ = fitted
    assert len(ens.ledger) > 0
    reis = table.df["reis"].iloc[0]
    od = table.df["od"].iloc[0]
    for h in HORIZONS:
        assert ens.ledger.recent_mae("ensemble", h, reis, od) is not None
        assert ens.ledger.recent_mae("last", h) is not None
    json.dumps(ens.ledger.to_dict())


# ---------------------------------------------------------------- recalibrate

def test_recalibrate_idempotent(table):
    ens = EnsembleForecaster(models_factory=stub_factory)
    ens.fit(table)
    n0 = len(ens.ledger)
    w0, b0 = copy.deepcopy(ens.weights), dict(ens.bias)
    since = pd.Timestamp("2024-03-01")
    m1 = ens.recalibrate(table, since)
    w1, b1, led1 = copy.deepcopy(ens.weights), dict(ens.bias), ens.ledger.to_dict()
    assert len(ens.ledger) > n0                                   # появились новые ошибки
    assert w1 != w0 or b1 != b0                                   # веса сдвинулись к свежим данным
    for h in HORIZONS:
        assert sum(w1[h].values()) == pytest.approx(1.0) and all(v >= 0 for v in w1[h].values())
    m2 = ens.recalibrate(table, since)
    assert ens.weights == w1 and ens.bias == b1 and ens.ledger.to_dict() == led1
    assert m1 == m2
    assert set(m1) == set(HORIZONS) and "ensemble" in m1["7d"] and "_baseline_booked" in m1["7d"]


def test_recalibrate_later_since_and_empty(table):
    ens = EnsembleForecaster(models_factory=stub_factory)
    ens.fit(table)
    assert ens.recalibrate(table, "2030-01-01") == {h: {} for h in HORIZONS}
    ens.recalibrate(table, "2024-05-15")
    w, n = copy.deepcopy(ens.weights), len(ens.ledger)
    ens.recalibrate(table, "2024-05-15")
    assert ens.weights == w and len(ens.ledger) == n
    # ошибок не дублируется и по расширенному окну: старые ключи пропускаются
    ens.recalibrate(table, "2024-05-01")
    assert len(ens.ledger) >= n


def test_recalibrate_unfitted():
    assert EnsembleForecaster(models_factory=stub_factory).recalibrate(None, "2024-01-01") == {}


# ---------------------------------------------------------------- сохранение и info

def test_pickle_roundtrip(fitted, table):
    ens, _ = fitted
    ens2 = pickle.loads(pickle.dumps(ens))
    fr = _sample_frame(table, "7d")
    a, b = ens.predict("7d", fr), ens2.predict("7d", fr)
    assert set(a) == set(b) and all(np.allclose(a[k], b[k]) for k in a)
    assert len(ens2.ledger) == len(ens.ledger)


def test_pickle_with_unpicklable_factory(table):
    ens = EnsembleForecaster(models_factory=lambda seed=0: [LastBooked()])
    ens.fit(table)
    ens2 = pickle.loads(pickle.dumps(ens))
    assert ens2.models_factory is None
    assert "ensemble" in ens2.predict("7d", _sample_frame(table, "7d"))


def test_info(fitted):
    ens, _ = fitted
    inf = ens.info()
    assert inf["fitted"] and inf["models"]["7d"] == ["last", "hist", "rem", "ensemble"]
    assert "numpy" in inf["versions"] and "pandas" in inf["versions"]
    assert inf["ledger_size"] == len(ens.ledger)
    json.dumps(inf)
    assert EnsembleForecaster().info()["fitted"] is False


# ---------------------------------------------------------------- настоящие модели (если уже написаны)

def test_real_models_if_available():
    from models.registry import default_models
    if not default_models(0):
        pytest.skip("настоящие базовые модели ещё не написаны")
    table = build_flight_table(make_history(start="2024-01-01", end="2024-04-30", routes=ROUTES[1:2], seed=3))
    ens = EnsembleForecaster(seed=0)
    metrics = ens.fit(table)
    names = {m.name for m in default_models(0)}
    for h in HORIZONS:
        assert "ensemble" in metrics[h] and "_baseline_booked" in metrics[h]
        assert names <= set(metrics[h]) | {"seq"}
        assert metrics[h]["ensemble"]["mae"] <= metrics[h]["_baseline_booked"]["mae"] * 1.05
    p = ens.predict("7d", _sample_frame(table, "7d"))
    assert "ensemble" in p and np.isfinite(p["ensemble"]).all()
    ens.recalibrate(table, "2024-04-20")
