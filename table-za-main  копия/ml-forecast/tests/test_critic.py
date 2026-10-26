"""Тесты журнала ошибок и критика (границы, NaN, запасные уровни, уверенность)."""
import json
import math
import pickle

import numpy as np
import pytest

from critic.critic import Critic, ErrorLedger, Verdict


def _ledger(**maes):
    """Журнал, где у каждой модели по 20 одинаковых ошибок на рейсе R1/OD1, горизонт 7d."""
    led = ErrorLedger()
    for model, mae in maes.items():
        for i in range(20):
            led.record(model, "7d", "R1", "OD1", mae, 5.0, f"2025-01-{i + 1:02d}")
    return led


def _rv(critic, preds, booked=50, cap=100, **kw):
    kw.setdefault("horizon", "7d")
    kw.setdefault("dtd", 7)
    kw.setdefault("reis", "R1")
    kw.setdefault("od", "OD1")
    return critic.review(preds=preds, current_booked=booked, total_au=cap, **kw)


# ---------------------------------------------------------------- журнал

def test_ledger_hierarchy_reis_od_global():
    led = ErrorLedger()
    for i in range(6):
        led.record("m", "7d", "R1", "OD1", 2.0, 1.0, i)          # рейс R1: MAE 2
    for i in range(10):
        led.record("m", "7d", f"X{i}", "OD1", 4.0, 1.0, i)       # прочие рейсы того же OD
    for i in range(10):
        led.record("m", "7d", "Z", "OD2", 10.0, 1.0, i)          # другое направление
    assert led.recent_mae("m", "7d", reis="R1", od="OD1") == pytest.approx(2.0)
    # у рейса R2 мало записей -> берём OD1: (6*2 + 10*4) / 16
    assert led.recent_mae("m", "7d", reis="R2", od="OD1") == pytest.approx((12 + 40) / 16)
    # неизвестное направление -> глобально: (12 + 40 + 100) / 26
    assert led.recent_mae("m", "7d", reis="R9", od="OD9") == pytest.approx(152 / 26)
    assert led.recent_mae("m", "7d") == pytest.approx(152 / 26)
    assert led.recent_mae("m", "14d") is None                    # другой горизонт — нет данных
    assert led.recent_mae("other", "7d") is None
    assert led.stats("m", "7d", "R1", "OD1")[2] == "reis"
    assert led.stats("m", "7d", "R2", "OD1")[2] == "od"
    assert led.stats("m", "7d", "R9", "OD9")[2] == "global"


def test_ledger_window_takes_latest():
    led = ErrorLedger()
    for i in range(100):
        led.record("m", "7d", "R", "O", 100.0 if i < 50 else 1.0, None, i)
    assert led.recent_mae("m", "7d", window=50) == pytest.approx(1.0)
    assert led.recent_mae("m", "7d", window=100) == pytest.approx(50.5)


def test_ledger_ring_buffer():
    led = ErrorLedger(maxlen=100)
    for i in range(250):
        assert led.record("m", "7d", "R", "O", float(i), None, i, key=("R", i, "7d", "m"))
    assert len(led) == 100
    assert led.recent_mae("m", "7d", window=1000) == pytest.approx(np.mean(range(150, 250)))
    # вытесненный ключ снова можно записать, живой — нет
    assert led.record("m", "7d", "R", "O", 1.0, None, 0, key=("R", 0, "7d", "m"))
    assert not led.record("m", "7d", "R", "O", 1.0, None, 249, key=("R", 249, "7d", "m"))


def test_ledger_ignores_garbage_and_duplicates():
    led = ErrorLedger()
    assert not led.record("m", "7d", "R", "O", float("nan"), 1.0, 0)
    assert not led.record("m", "7d", "R", "O", "abc", 1.0, 0)
    assert not led.record("m", "7d", "R", "O", -1.0, 1.0, 0)
    assert led.record("m", "7d", "R", "O", 1.0, float("nan"), 0, key=("a", 1))   # pct = NaN допустим
    assert not led.record("m", "7d", "R", "O", 5.0, 1.0, 0, key=("a", 1))        # дубль ключа
    assert len(led) == 1 and led.has(("a", 1))


def test_ledger_json_roundtrip_and_pickle():
    led = _ledger(m1=2.0, m2=3.0)
    led.record("m1", "7d", "R1", "OD1", 9.0, None, None, key=("R1", "2025-02-01", "7d", "m1"))
    d = json.loads(json.dumps(led.to_dict()))          # строго JSON
    back = ErrorLedger.from_dict(d)
    assert len(back) == len(led)
    assert back.recent_mae("m1", "7d", "R1", "OD1") == pytest.approx(led.recent_mae("m1", "7d", "R1", "OD1"))
    assert back.has(("R1", "2025-02-01", "7d", "m1"))
    assert not back.record("m1", "7d", "R1", "OD1", 1.0, None, None, key=("R1", "2025-02-01", "7d", "m1"))
    p = pickle.loads(pickle.dumps(led))
    assert len(p) == len(led) and p.to_dict() == led.to_dict()
    assert len(ErrorLedger.from_dict({})) == 0 and len(ErrorLedger.from_dict(None)) == 0


# ---------------------------------------------------------------- выбор модели

def test_picks_lowest_recent_mae():
    c = Critic(_ledger(lgbm=3.0, hmean=6.0, ensemble=4.0))
    v = _rv(c, {"lgbm": 70.0, "hmean": 60.0, "ensemble": 65.0})
    assert isinstance(v, Verdict)
    assert v.chosen_model == "lgbm_7d" and v.pred == 70 and v.ok
    assert v.flags == []


def test_no_errors_chooses_ensemble():
    v = _rv(Critic(ErrorLedger()), {"lgbm": 70.0, "hmean": 60.0, "ensemble": 65.0})
    assert v.chosen_model == "ensemble_7d" and v.pred == 65 and v.ok


def test_no_errors_no_ensemble_prefers_hmean():
    v = _rv(Critic(ErrorLedger()), {"lgbm": 70.0, "hmean": 60.0})
    assert v.chosen_model == "hmean_7d"


def test_nonfinite_model_dropped_and_flagged():
    c = Critic(_ledger(lgbm=1.0, hmean=6.0, ensemble=4.0))
    v = _rv(c, {"lgbm": float("nan"), "hmean": 60.0, "ensemble": 65.0, "seq": float("inf"), "x": "abc",
                "neg": -5.0})
    assert v.chosen_model == "ensemble_7d" and v.pred == 65
    for name in ("lgbm", "seq", "x"):
        assert f"non_finite_model:{name}" in v.flags
    assert "negative_model:neg" in v.flags
    assert v.ok


def test_implausible_best_falls_to_next():
    c = Critic(_ledger(lgbm=1.0, hmean=6.0, ensemble=4.0))
    v = _rv(c, {"lgbm": 5000.0, "hmean": 60.0, "ensemble": 65.0})   # лучший по MAE выдал бред
    assert v.chosen_model == "ensemble_7d" and v.pred == 65
    assert "fallback_model" in v.flags and v.ok


def test_all_implausible_falls_to_booked():
    c = Critic(_ledger(lgbm=1.0, ensemble=4.0))
    v = _rv(c, {"lgbm": 9999.0, "ensemble": 8888.0}, booked=40, cap=100)
    assert v.pred == 40 and v.chosen_model == "booked_7d" and not v.ok


def test_sparse_route_flag():
    led = ErrorLedger()
    for i in range(30):
        led.record("ensemble", "7d", f"R{i}", "OD1", 3.0, 5.0, i)
    v = _rv(Critic(led), {"ensemble": 60.0}, reis="NEW", od="OD1")
    assert "sparse_route" in v.flags and v.chosen_model == "ensemble_7d"


# ---------------------------------------------------------------- клиппинг и краевые случаи

def test_clipped_to_capacity_and_booked():
    c = Critic(ErrorLedger())
    v = _rv(c, {"ensemble": 150.0}, booked=50, cap=100)
    assert v.pred == 100 and "clipped_to_capacity" in v.flags and v.ok
    v = _rv(c, {"ensemble": 30.0}, booked=50, cap=100)
    assert v.pred == 50 and "clipped_to_booked" in v.flags
    v = _rv(c, {"ensemble": 70.0}, booked=50, cap=100)
    assert v.pred == 70 and v.flags == []


def test_total_au_below_booked():
    v = _rv(Critic(ErrorLedger()), {"ensemble": 70.0}, booked=80, cap=60)
    assert v.pred == 80 and "total_au_below_booked" in v.flags and not v.ok


def test_total_au_zero():
    v = _rv(Critic(ErrorLedger()), {"ensemble": 70.0}, booked=0, cap=0)
    assert v.pred == 0 and not v.ok
    v = _rv(Critic(ErrorLedger()), {"ensemble": 70.0}, booked=5, cap=0)
    assert v.pred == 5 and "total_au_below_booked" in v.flags


def test_empty_and_bad_preds():
    c = Critic(ErrorLedger())
    for bad in ({}, None, [], "abc", 42):
        v = _rv(c, bad, booked=33, cap=100)
        assert v.pred == 33 and not v.ok, bad
        assert v.chosen_model == "booked_7d"
    v = _rv(c, {"a": float("nan"), "b": "x", "c": None}, booked=33, cap=100)
    assert v.pred == 33 and not v.ok


def test_negative_and_huge_numbers():
    c = Critic(ErrorLedger())
    v = _rv(c, {"ensemble": -10.0}, booked=20, cap=100)
    assert v.pred == 20 and not v.ok
    v = _rv(c, {"ensemble": 1e30}, booked=20, cap=100)
    assert v.pred in (20, 100) and 20 <= v.pred <= 100
    v = _rv(c, {"ensemble": 70.0}, booked=1e30, cap=1e30)
    assert not v.ok and isinstance(v.pred, int)
    v = _rv(c, {"ensemble": 70.0}, booked=-5, cap=100)
    assert not v.ok and 0 <= v.pred <= 100
    v = _rv(c, {"ensemble": 70.0}, booked=10, cap=-3)
    assert not v.ok and v.pred >= 10


def test_nan_inputs():
    c = Critic(ErrorLedger())
    v = _rv(c, {"ensemble": 70.0}, booked=float("nan"), cap=100)
    assert not v.ok and "bad_input:current_booked" in v.flags and 0 <= v.pred <= 100
    v = _rv(c, {"ensemble": 70.0}, booked=10, cap=float("nan"))
    assert not v.ok and v.pred >= 10
    v = _rv(c, {"ensemble": 70.0}, booked=None, cap=None)
    assert not v.ok and isinstance(v.pred, int)
    v = _rv(c, {"ensemble": 70.0}, booked="12", cap="100")
    assert not v.ok


def test_numpy_scalars_ok():
    v = _rv(Critic(ErrorLedger()), {"ensemble": np.float32(70.4)}, booked=np.int64(50), cap=np.float64(100))
    assert v.pred == 70 and v.ok


def test_fractional_booked_and_cap():
    v = _rv(Critic(ErrorLedger()), {"ensemble": 10.2}, booked=10.6, cap=10.9)
    assert v.pred == 11 and v.interval[0] >= 11


def test_never_raises_on_weird_input():
    class Boom:
        def __float__(self):
            raise RuntimeError("boom")

    class BadDict(dict):
        def items(self):
            raise RuntimeError("boom")

    c = Critic(ErrorLedger())
    weird = [None, "x", float("nan"), float("inf"), -1, 10 ** 400, Boom(), [1], {"a": 1}, np.array([1, 2]), True]
    for a in weird:
        for b in weird:
            v = c.review("7d", {"ensemble": a, "b": b}, a, b, a, a, b, b)
            assert isinstance(v, Verdict) and isinstance(v.pred, int)
            assert 0.05 <= v.confidence <= 0.99
    v = c.review("7d", BadDict(a=1.0), 10, 100, 7, "R", "O")
    assert v.pred == 10 and "critic_error" in v.flags and not v.ok
    v = c.review("zzz", {"ensemble": 5.0}, 1, 10, 7, None, None, None)   # неизвестный горизонт, distance=None
    assert isinstance(v, Verdict)


def test_verdict_invariants_random():
    rng = np.random.default_rng(0)
    c = Critic(_ledger(lgbm=3.0, ensemble=4.0))
    for _ in range(300):
        booked = float(rng.integers(0, 200))
        cap = float(rng.integers(0, 220))
        preds = {"lgbm": float(rng.normal(80, 80)), "ensemble": float(rng.normal(80, 80))}
        v = _rv(c, preds, booked=booked, cap=cap, distance=int(rng.integers(0, 9)))
        assert v.pred >= booked
        if cap >= booked:
            assert v.pred <= cap
        else:
            assert v.pred == booked
        lo, hi = v.interval
        assert lo <= v.pred <= hi and lo >= booked
        assert 0.05 <= v.confidence <= 0.99


# ---------------------------------------------------------------- уверенность

def test_confidence_decreases_with_distance():
    c = Critic(_ledger(ensemble=3.0))
    confs = [_rv(c, {"ensemble": 70.0}, distance=d).confidence for d in range(0, 8)]
    assert all(a > b for a, b in zip(confs, confs[1:])), confs
    assert "far_from_horizon" in _rv(c, {"ensemble": 70.0}, distance=7).flags
    assert "far_from_horizon" not in _rv(c, {"ensemble": 70.0}, distance=1).flags


def test_confidence_decreases_with_recent_mae():
    confs = []
    for mae in (0.5, 2.0, 5.0, 10.0, 20.0):
        c = Critic(_ledger(ensemble=mae))
        confs.append(_rv(c, {"ensemble": 70.0}).confidence)
    assert all(a > b for a, b in zip(confs, confs[1:])), confs
    assert all(0.05 <= x <= 0.99 for x in confs)


def test_interval_widens_with_mae_and_stays_in_bounds():
    small = _rv(Critic(_ledger(ensemble=1.0)), {"ensemble": 70.0}, booked=50, cap=100).interval
    big = _rv(Critic(_ledger(ensemble=10.0)), {"ensemble": 70.0}, booked=50, cap=100).interval
    assert big[1] - big[0] > small[1] - small[0]
    assert big[0] >= 50 and big[1] <= 100


def test_critic_default_ledger():
    v = Critic().review("7d", {"ensemble": 10.0}, 5, 20, 7, "R", "O")
    assert v.pred == 10
    assert json.dumps(v.to_dict())
