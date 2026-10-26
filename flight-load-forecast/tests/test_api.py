"""Тесты API через TestClient. Сервис подменяется заглушкой; с настоящим сервисом — отдельный тест в конце."""
from __future__ import annotations

import logging
import os
import threading
import time

import pytest
from fastapi.testclient import TestClient

from app import main
from app.main import app, get_service

HORIZONS = ("30d", "14d", "7d", "1_3d")
GOOD = {"reis": "KV-110", "flydate": "25.12.2025", "current_booked": 42, "total_au": 100, "dtd": 14}
TOKEN = "test-token-123"


class NotReadyError(RuntimeError):
    """Имя похоже на ModelNotReadyError из app.service."""


class StubService:
    def __init__(self, fail: Exception | None = None):
        self.fail = fail
        self.calls: list[dict] = []
        self.reloads = 0
        self.loaded = True

    def predict(self, reis, flydate, current_booked, total_au, dtd, od=None):
        self.calls.append(dict(reis=reis, flydate=flydate, current_booked=current_booked, total_au=total_au, dtd=dtd))
        if self.fail:
            raise self.fail
        return {
            "reis": reis, "flydate": "00.00.0000",
            "horizons": {h: {"pred": 50 + i, "confidence": 0.8 + 0.05 * i} for i, h in enumerate(HORIZONS)},
            "critic": {"ok": True, "chosen_model": "lgbm_14d", "flags": []},
        }

    def reload(self):
        self.reloads += 1
        return True

    def health(self):
        return {"status": "ok" if self.loaded else "no_model", "model_loaded": self.loaded, "version": "v-test" if self.loaded else None}


@pytest.fixture(autouse=True)
def clean_state(monkeypatch):
    """Чистое состояние: нет токена, задача обучения «простаивает», сервис не закеширован."""
    monkeypatch.delenv("FORECAST_ADMIN_TOKEN", raising=False)
    main._job.update(state="idle", kind=None, started_at=None, finished_at=None, error=None, result=None)
    app.state.service = None
    yield
    app.dependency_overrides.clear()
    deadline = time.time() + 5                    # фоновые потоки не должны пережить тест
    while main._job["state"] == "running" and time.time() < deadline:
        time.sleep(0.01)
    app.state.service = None


@pytest.fixture
def stub():
    s = StubService()
    app.dependency_overrides[get_service] = lambda: s
    app.state.service = s                      # фоновая задача перезагружает сервис, лежащий в app.state
    return s


@pytest.fixture
def client(stub):
    return TestClient(app)


def admin(token=TOKEN):
    return {"X-Admin-Token": token}


# ================================================================ /predict

def test_predict_ok_format(client, stub):
    r = client.post("/predict", json=GOOD)
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"reis", "flydate", "horizons", "critic"}
    assert body["reis"] == "KV-110" and body["flydate"] == "25.12.2025"      # эхо запроса
    assert set(body["horizons"]) == set(HORIZONS)
    for h in body["horizons"].values():
        assert set(h) == {"pred", "confidence"}
        assert isinstance(h["pred"], int) and 0 <= h["confidence"] <= 1
    assert set(body["critic"]) == {"ok", "chosen_model", "flags"}
    assert body["critic"] == {"ok": True, "chosen_model": "lgbm_14d", "flags": []}
    # в сервис ушли нормализованные значения
    call = stub.calls[0]
    assert call["reis"] == "KV-110" and call["dtd"] == 14 and call["total_au"] == 100


def test_predict_normalizes_input(client, stub):
    r = client.post("/predict", json={**GOOD, "reis": "  kv-110 ", "flydate": " 05.01.2026 ", "current_booked": 42.0})
    assert r.status_code == 200
    assert stub.calls[0]["reis"] == "KV-110"
    assert r.json()["flydate"] == "05.01.2026"


def test_predict_boundaries_are_accepted(client):
    for patch in ({"dtd": 0}, {"dtd": 180}, {"current_booked": 0}, {"reis": "A" * 16},
                  {"current_booked": 120, "total_au": 100}):          # продано > потолка — это дело критика, не валидации
        assert client.post("/predict", json={**GOOD, **patch}).status_code == 200, patch


@pytest.mark.parametrize("patch,field", [
    ({"reis": ""}, "reis"), ({"reis": "   "}, "reis"), ({"reis": "A" * 17}, "reis"), ({"reis": 123}, "reis"),
    ({"flydate": "2025-12-25"}, "flydate"), ({"flydate": "31.02.2025"}, "flydate"), ({"flydate": "32.01.2025"}, "flydate"),
    ({"flydate": "25.12.25"}, "flydate"), ({"flydate": "завтра"}, "flydate"), ({"flydate": ""}, "flydate"),
    ({"flydate": "01.01.1900"}, "flydate"), ({"flydate": None}, "flydate"),
    ({"current_booked": -1}, "current_booked"), ({"current_booked": "много"}, "current_booked"),
    ({"current_booked": None}, "current_booked"), ({"current_booked": True}, "current_booked"),
    ({"total_au": 0}, "total_au"), ({"total_au": -5}, "total_au"), ({"total_au": "abc"}, "total_au"),
    ({"dtd": -1}, "dtd"), ({"dtd": 181}, "dtd"), ({"dtd": 3.5}, "dtd"), ({"dtd": "x"}, "dtd"), ({"dtd": None}, "dtd"),
])
def test_predict_bad_input_is_422_in_russian(client, stub, patch, field):
    r = client.post("/predict", json={**GOOD, **patch})
    assert r.status_code == 422, (patch, r.text)
    body = r.json()
    assert any("а" <= ch.lower() <= "я" for ch in body["detail"])             # русский текст
    assert field in [e["field"] for e in body["errors"]]
    assert "Traceback" not in r.text and "Input should" not in r.text and "Value error" not in r.text
    assert stub.calls == []                                                   # до сервиса плохой ввод не доходит


@pytest.mark.parametrize("missing", ["reis", "flydate", "current_booked", "total_au", "dtd"])
def test_predict_missing_field(client, missing):
    payload = {k: v for k, v in GOOD.items() if k != missing}
    r = client.post("/predict", json=payload)
    assert r.status_code == 422
    assert "обязательно" in r.json()["detail"]


def test_predict_broken_body(client):
    r = client.post("/predict", content="{не json", headers={"Content-Type": "application/json"})
    assert r.status_code == 422 and "JSON" in r.json()["detail"]
    r = client.post("/predict", json=[1, 2, 3])
    assert r.status_code == 422
    r = client.post("/predict")
    assert r.status_code == 422


def test_predict_no_model_is_503(stub, client):
    stub.fail = NotReadyError("нет модели в /srv/secret/path")
    r = client.post("/predict", json=GOOD)
    assert r.status_code == 503
    assert "модель ещё не обучена" in r.json()["detail"].lower()
    assert "secret" not in r.text


def test_predict_no_model_when_service_cannot_be_created(monkeypatch):
    """Нет сервиса вообще (например, не создался) — тоже 503, а не 500."""
    monkeypatch.setattr(main, "_make_service", lambda: (_ for _ in ()).throw(RuntimeError("boom")))
    r = TestClient(app).post("/predict", json=GOOD)
    assert r.status_code == 503 and "ещё не обучена" in r.json()["detail"]


def test_predict_internal_error_is_500_without_leak_but_logged(stub, client, caplog):
    stub.fail = RuntimeError("секретный путь /srv/data/hidden.csv")
    with caplog.at_level(logging.ERROR, logger="forecast.api"):
        r = client.post("/predict", json=GOOD)
    assert r.status_code == 500
    assert "hidden.csv" not in r.text and "Traceback" not in r.text and "RuntimeError" not in r.text
    assert "Внутренняя ошибка" in r.json()["detail"]
    rec = [x for x in caplog.records if x.levelno >= logging.ERROR]
    assert rec and rec[0].exc_info and "hidden.csv" in str(rec[0].exc_info[1])    # в логе стек есть


def test_predict_bad_service_answer_is_500(stub, client):
    stub.predict = lambda **kw: {"oops": 1}
    assert client.post("/predict", json=GOOD).status_code == 500


def test_requests_logged_in_one_line_without_body(stub, client, caplog):
    with caplog.at_level(logging.INFO, logger="forecast.api"):
        client.post("/predict", json={**GOOD, "current_booked": 777})
    lines = [r.getMessage() for r in caplog.records if r.name == "forecast.api"]
    assert len(lines) == 1
    assert "POST /predict" in lines[0] and "200" in lines[0]
    assert "777" not in lines[0] and "25.12.2025" not in lines[0]


# ================================================================ /health

def test_health_with_model(client):
    r = client.get("/health")
    assert r.status_code == 200
    b = r.json()
    assert b["status"] == "ok" and b["model_loaded"] is True and b["version"] == "v-test"
    assert b["retrain"]["state"] == "idle"


def test_health_without_model(stub, client):
    stub.loaded = False
    r = client.get("/health")
    assert r.status_code == 200 and r.json()["status"] == "no_model" and r.json()["model_loaded"] is False


def test_health_survives_service_failure(stub, client):
    stub.health = lambda: (_ for _ in ()).throw(RuntimeError("плохо"))
    r = client.get("/health")
    assert r.status_code == 200 and r.json()["status"] == "no_model"
    assert "плохо" not in r.text


# ================================================================ /retrain и /incremental

@pytest.fixture
def slow_job(monkeypatch):
    """Подменяет само обучение: ждёт сигнала, пока тест не разрешит закончить."""
    gate, started = threading.Event(), threading.Event()
    calls = []

    def fake(kind, force, synthetic):
        calls.append((kind, force, synthetic))
        started.set()
        assert gate.wait(10)
        return {"version": f"v-{kind}"}

    monkeypatch.setattr(main, "_run_training", fake)
    yield type("Job", (), {"gate": gate, "started": started, "calls": calls})
    gate.set()


def wait_state(client, state, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        s = client.get("/retrain/status").json()
        if s["state"] == state:
            return s
        time.sleep(0.01)
    raise AssertionError(f"статус не стал {state}: {client.get('/retrain/status').json()}")


@pytest.mark.parametrize("path", ["/retrain", "/incremental"])
def test_admin_closed_without_env_token(client, path, slow_job):
    assert client.post(path, headers=admin()).status_code == 403          # переменная не задана
    assert client.post(path).status_code == 403
    assert not slow_job.calls


@pytest.mark.parametrize("path", ["/retrain", "/incremental"])
def test_admin_wrong_or_missing_token(client, monkeypatch, path, slow_job):
    monkeypatch.setenv("FORECAST_ADMIN_TOKEN", TOKEN)
    assert client.post(path).status_code == 403
    assert client.post(path, headers=admin("wrong-token")).status_code == 403
    assert client.post(path, headers=admin("")).status_code == 403
    assert client.post(path, headers={"X-Admin-Token": "x" * len(TOKEN)}).status_code == 403
    assert not slow_job.calls


def test_non_ascii_token_does_not_crash(client, monkeypatch, slow_job):
    monkeypatch.setenv("FORECAST_ADMIN_TOKEN", TOKEN)
    r = client.post("/retrain", headers={"X-Admin-Token": "caf\u00e9".encode("utf-8")})
    assert r.status_code == 403


def test_retrain_runs_in_background_and_only_once(client, stub, monkeypatch, slow_job):
    monkeypatch.setenv("FORECAST_ADMIN_TOKEN", TOKEN)
    r = client.post("/retrain", headers=admin(), json={"force": True, "synthetic": True})
    assert r.status_code == 202 and r.json()["state"] == "running"
    assert slow_job.started.wait(5)
    # пока идёт — всё остальное 409 (и retrain, и incremental)
    assert client.post("/retrain", headers=admin()).status_code == 409
    assert client.post("/incremental", headers=admin()).status_code == 409
    st = client.get("/retrain/status").json()
    assert st["state"] == "running" and st["kind"] == "retrain" and st["started_at"]
    assert client.get("/health").json()["retrain"]["state"] == "running"
    slow_job.gate.set()
    st = wait_state(client, "done")
    assert st["result"] == "v-retrain" and st["error"] is None and st["finished_at"]
    assert slow_job.calls == [("retrain", True, True)]
    assert stub.reloads == 1                                              # сервис подхватил новую версию
    # после завершения можно запускать снова
    slow_job.gate.set()
    assert client.post("/incremental", headers=admin()).status_code == 202
    wait_state(client, "done")
    assert slow_job.calls[-1] == ("incremental", False, False)


def test_retrain_failure_is_reported_without_details(client, monkeypatch):
    monkeypatch.setenv("FORECAST_ADMIN_TOKEN", TOKEN)

    def boom(kind, force, synthetic):
        raise RuntimeError("секретный путь /srv/x.csv")

    monkeypatch.setattr(main, "_run_training", boom)
    assert client.post("/retrain", headers=admin(), json={"synthetic": True}).status_code == 202
    st = wait_state(client, "failed")
    assert st["error"] == "RuntimeError" and "srv" not in str(st)
    # после сбоя можно пробовать снова
    monkeypatch.setattr(main, "_run_training", lambda *a: {"version": "v2"})
    assert client.post("/retrain", headers=admin(), json={"synthetic": True}).status_code == 202
    wait_state(client, "done")


def test_retrain_without_inputs_is_422(client, monkeypatch, tmp_path, slow_job):
    monkeypatch.setenv("FORECAST_ADMIN_TOKEN", TOKEN)
    monkeypatch.setenv("FORECAST_HISTORY", str(tmp_path / "нет-такого.csv"))
    monkeypatch.setenv("FORECAST_TICKETS_DIR", str(tmp_path / "нет-папки"))
    r = client.post("/retrain", headers=admin())
    assert r.status_code == 422 and "FORECAST_HISTORY" in r.json()["detail"]
    assert client.get("/retrain/status").json()["state"] == "idle"
    # с synthetic — можно
    assert client.post("/retrain", headers=admin(), json={"synthetic": True}).status_code == 202
    slow_job.gate.set()
    wait_state(client, "done")


def test_retrain_bad_body_is_422(client, monkeypatch, slow_job):
    monkeypatch.setenv("FORECAST_ADMIN_TOKEN", TOKEN)
    r = client.post("/retrain", headers=admin(), json={"force": "возможно"})
    assert r.status_code == 422 and "force" in r.json()["detail"]


def test_run_training_wrapper_passes_paths_from_env(monkeypatch, tmp_path):
    """Обёртка вызывает training.*.run именованными аргументами из переменных окружения."""
    import training.full_train as ft
    import training.incremental as inc

    hist, avail, tdir, art = tmp_path / "h.csv", tmp_path / "a.csv", tmp_path / "t", tmp_path / "art"
    hist.write_text("x"), avail.write_text("x"), tdir.mkdir()
    (tdir / "b.csv").write_text("x"), (tdir / "a.csv").write_text("x"), (tdir / "note.txt").write_text("x")
    for k, v in (("FORECAST_HISTORY", hist), ("FORECAST_AVAILABILITY", avail), ("FORECAST_TICKETS_DIR", tdir),
                 ("FORECAST_ARTIFACTS", art)):
        monkeypatch.setenv(k, str(v))
    got = {}
    monkeypatch.setattr(ft, "run", lambda **kw: got.setdefault("full", kw) or {"version": "v"})
    monkeypatch.setattr(inc, "run", lambda **kw: got.setdefault("inc", kw) or {"version": "v"})

    main._run_training("retrain", True, False)
    assert got["full"] == {"history": str(hist), "availability": str(avail), "out": str(art), "force": True,
                           "synthetic": False, "tickets": [str(tdir / "a.csv"), str(tdir / "b.csv")]}
    main._run_training("incremental", False, False)
    assert got["inc"]["history"] is None and got["inc"]["tickets"] and got["inc"]["out"] == str(art)


def test_run_training_wrapper_drops_unknown_kwargs(monkeypatch, tmp_path):
    import training.incremental as inc
    seen = {}

    def run(tickets=(), availability=None, out="artifacts"):
        seen.update(tickets=tickets, availability=availability, out=out)

    monkeypatch.setattr(inc, "run", run)
    monkeypatch.setenv("FORECAST_ARTIFACTS", str(tmp_path))
    main._run_training("incremental", True, True)           # force/synthetic/history функция не принимает — не падаем
    assert seen["out"] == str(tmp_path)


# ================================================================ настоящий сервис (если все части уже есть)

def _real_parts_available() -> bool:
    try:
        import app.service  # noqa: F401
        import training.full_train  # noqa: F401
        import models.ensemble  # noqa: F401
        import critic.critic  # noqa: F401
        return True
    except Exception:
        return False


def _fast_models(seed=0):
    """Только модель-запас (hmean): обучение за доли секунды. LightGBM/seq в быстрые тесты не берём."""
    from models.fallback import HierarchicalMeanModel
    return [HierarchicalMeanModel(seed=seed)]


@pytest.mark.skipif(not _real_parts_available(), reason="сервис/обучение/ансамбль/критик ещё не готовы")
@pytest.mark.parametrize("full_models", [False, pytest.param(True, id="all-models-slow")])
def test_real_service_end_to_end(tmp_path, monkeypatch, full_models):
    """Настоящие хранилище, ансамбль, критик и сервис. Полный набор моделей (LightGBM, seq) — только с
    FORECAST_TEST_FULL=1: на загруженной машине обучение занимает минуты."""
    if full_models and not os.environ.get("FORECAST_TEST_FULL"):
        pytest.skip("медленный тест: задайте FORECAST_TEST_FULL=1")
    from data.synthetic import ROUTES, history_to_csv, make_history
    from models.ensemble import EnsembleForecaster
    from training.full_train import run as full_run

    art = tmp_path / "artifacts"
    # 1) без модели: сервис стартует, /predict -> 503, /health -> no_model
    monkeypatch.setenv("FORECAST_ARTIFACTS", str(art))
    with TestClient(app) as c:
        assert c.get("/health").json()["status"] == "no_model"
        r = c.post("/predict", json=GOOD)
        assert r.status_code == 503 and "ещё не обучена" in r.json()["detail"]
    app.state.service = None

    # 2) обучаем на маленькой синтетике и стартуем заново
    hist_csv = tmp_path / "SalesHistory.csv"
    history_to_csv(make_history(start="2024-10-01", end="2025-02-28", routes=ROUTES[:2], seed=1), hist_csv)
    factory = None if full_models else (lambda s: EnsembleForecaster(seed=s, models_factory=_fast_models))
    full_run(history=str(hist_csv), out=str(art), ensemble_factory=factory)
    with TestClient(app) as c:
        h = c.get("/health").json()
        assert h["status"] == "ok" and h["model_loaded"] is True
        r = c.post("/predict", json={"reis": "KV-110", "flydate": "10.03.2025", "current_booked": 30,
                                     "total_au": 100, "dtd": 14})
        assert r.status_code == 200, r.text
        b = r.json()
        assert set(b["horizons"]) == set(HORIZONS)
        for v in b["horizons"].values():
            assert 30 <= v["pred"] <= 100 and 0 <= v["confidence"] <= 1       # критик: не ниже проданного и не выше Total AU
        assert isinstance(b["critic"]["ok"], bool) and isinstance(b["critic"]["flags"], list)
        # продано больше потолка — критик не падает
        r = c.post("/predict", json={"reis": "KV-110", "flydate": "10.03.2025", "current_booked": 120,
                                     "total_au": 100, "dtd": 7})
        assert r.status_code == 200 and r.json()["critic"]["flags"]
        # неизвестный рейс — запасной уровень, не 500
        r = c.post("/predict", json={"reis": "ZZ-9", "flydate": "10.03.2025", "current_booked": 3,
                                     "total_au": 50, "dtd": 2})
        assert r.status_code == 200
    app.state.service = None
