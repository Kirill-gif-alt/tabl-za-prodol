"""Тесты части C: хранилище версий, полное и дневное обучение, сервис прогноза.

Быстрые тесты идут на простых заглушках ансамбля и критика (они объявлены ниже), чтобы проверять
именно хранилище, оркестрацию и формат ответа. Один тест в конце гоняет весь путь с настоящими
EnsembleForecaster и Critic (пропускается, если их ещё нет).
"""
from __future__ import annotations

import json
import os
import threading
import time
from dataclasses import dataclass, field

import numpy as np
import pandas as pd
import pytest

from app.service import ForecastService, ModelNotReadyError
from data.features import HORIZONS, build_flight_table
from data.parsers import MAX_DTD
from data.synthetic import history_to_csv, make_availability, make_history, make_recent_tickets
from training import full_train, incremental, store as store_mod
from training.store import ArtifactStore, InputError

START, END = "2024-01-01", "2024-07-31"
TODAY = "2024-08-10"


# ---------------------------------------------------------------- заглушки

class StubEnsemble:
    """Простой ансамбль: прогноз = проданные + остаток по историческому h_rem. Лежит в joblib как есть."""

    def __init__(self, seed=0):
        self.seed = seed
        self.ledger = object()
        self.recal_calls = []

    def fit(self, table, valid_frac=0.15):
        return {h: {"stub": {"mae": 3.5, "mape": 0.12, "n": 100},
                    "ensemble": {"mae": 3.1, "mape": 0.1, "n": 100},
                    "_baseline_booked": {"mae": 9.0, "mape": 0.3, "n": 100}} for h in HORIZONS}

    def predict(self, horizon, frame):
        X = frame["X"]
        p = X["booked"].values + X["h_rem"].values
        return {"stub": p, "ensemble": p}

    def recalibrate(self, table, since):
        self.recal_calls.append(pd.Timestamp(since))
        n = int((table.df["flydate"] >= since).sum())
        return {h: {"ensemble": {"mae": 2.9, "mape": 0.09, "n": n}} for h in HORIZONS}

    def info(self):
        return {"models": ["stub"]}


@dataclass
class StubVerdict:
    pred: int
    chosen_model: str
    flags: list = field(default_factory=list)
    ok: bool = True
    confidence: float = 0.5


class StubCritic:
    """Клиппинг в [booked, total_au] с теми же флагами, что у настоящего критика."""

    def __init__(self, ledger=None):
        self.ledger = ledger

    def review(self, horizon, preds, current_booked, total_au, dtd=None, reis=None, od=None, distance=0):
        flags, ok = [], True
        p = preds.get("ensemble", current_booked)
        if total_au < current_booked:
            flags.append("total_au_below_booked")
            return StubVerdict(int(current_booked), f"ensemble_{horizon}", flags, False, 0.3)
        if p > total_au:
            p, flags = total_au, flags + ["clipped_to_capacity"]
        if p < current_booked:
            p, flags = current_booked, flags + ["clipped_to_booked"]
        return StubVerdict(int(round(p)), f"ensemble_{horizon}", flags, ok, 0.8)


def stub_factory(seed):
    return StubEnsemble(seed)


# ---------------------------------------------------------------- общие данные

@pytest.fixture(scope="module")
def hist():
    return make_history(START, END, seed=7)


@pytest.fixture(scope="module")
def files(hist, tmp_path_factory):
    d = tmp_path_factory.mktemp("inputs")
    history_to_csv(hist, d / "SalesHistory.csv")
    avail = make_availability(hist, TODAY, days_ahead=20)
    avail.to_csv(d / "avail.csv", index=False)
    make_recent_tickets(hist, TODAY, days=14).to_csv(d / "Tickets_SALE_Last14Days.csv", index=False)
    return d


@pytest.fixture(scope="module")
def trained_root(files, tmp_path_factory):
    """Каталог артефактов с одной версией, обученной full_train на заглушке (общий для тестов модуля)."""
    root = tmp_path_factory.mktemp("artifacts")
    res = full_train.run(history=files / "SalesHistory.csv", availability=files / "avail.csv", out=root,
                         ensemble_factory=stub_factory)
    assert not res["skipped"]
    return root


# ================================================================ хранилище

def make_meta(h="a" * 64, **kw):
    return {"input_hash": h, "metrics": {"7d": {"ensemble": {"mae": np.float64(1.5), "mape": float("nan"), "n": 3}}}, **kw}


def test_store_save_load_and_metadata(tmp_path, hist):
    st = ArtifactStore(tmp_path)
    table = build_flight_table(hist)
    v = st.save(StubEnsemble(), table, make_meta())
    assert v.startswith("v") and v.endswith("_" + "a" * 12)
    assert st.list_versions() == [v]
    cur = json.loads((tmp_path / "current.json").read_text(encoding="utf-8"))
    assert cur["version"] == v
    ens, tbl, meta = st.load_current()
    assert isinstance(ens, StubEnsemble) and len(tbl) == len(table)
    # метаданные: версия, дата UTC, хеш, метрики, библиотеки, число вылетов, период данных
    assert meta["version"] == v and meta["created_utc"].endswith("Z") and meta["input_hash"] == "a" * 64
    assert meta["n_flights"] == len(table)
    assert meta["data_period"]["from"] == hist["flydate"].min().strftime("%Y-%m-%d")
    assert {"numpy", "pandas", "lightgbm", "sklearn"} <= set(meta["libs"])
    assert meta["metrics"]["7d"]["ensemble"]["mape"] is None      # NaN -> null, JSON остаётся валидным


def test_store_idempotent(tmp_path, caplog):
    st = ArtifactStore(tmp_path)
    v1 = st.save(StubEnsemble(), None, make_meta())
    with caplog.at_level("INFO"):
        v2 = st.save(StubEnsemble(), None, make_meta())
    assert v1 == v2 and len(st.list_versions()) == 1
    assert "версия уже есть" in caplog.text.lower()
    # другой вход — новая версия, тот же вход с force — тоже новая
    v3 = st.save(StubEnsemble(), None, make_meta("b" * 64))
    v4 = st.save(StubEnsemble(), None, make_meta("b" * 64), force=True)
    assert len({v1, v3, v4}) == 3 and len(st.list_versions()) == 3
    assert st.current_version() == v4


def test_store_hash_depends_on_content_and_params(tmp_path):
    a, b = tmp_path / "a.csv", tmp_path / "b.csv"
    a.write_text("x,y\n1,2\n", encoding="utf-8")
    b.write_text("x,y\n1,2\n", encoding="utf-8")
    h1, _ = store_mod.hash_inputs({"history": [a]}, {"p": 1})
    h2, _ = store_mod.hash_inputs({"history": [b]}, {"p": 1})        # имя файла не важно
    h3, _ = store_mod.hash_inputs({"history": [a]}, {"p": 2})        # параметры важны
    b.write_text("x,y\n1,3\n", encoding="utf-8")
    h4, _ = store_mod.hash_inputs({"history": [b]}, {"p": 1})        # содержимое важно
    assert h1 == h2 and len({h1, h3, h4}) == 3
    with pytest.raises(InputError):
        store_mod.hash_inputs({"history": [tmp_path / "нет.csv"]}, {})


def test_store_keeps_last_five(tmp_path):
    st = ArtifactStore(tmp_path)
    vs = [st.save(StubEnsemble(), None, make_meta(f"{i:064x}")) for i in range(8)]
    kept = st.list_versions()
    assert len(kept) == 5 and kept == vs[::-1][:5]
    assert st.current_version() == vs[-1]
    assert not any(p.name.endswith(".tmp") for p in tmp_path.iterdir())


def test_store_atomic_on_failed_write(tmp_path, monkeypatch):
    st = ArtifactStore(tmp_path)
    v1 = st.save(StubEnsemble(), None, make_meta())
    real_dump = store_mod.joblib.dump
    calls = []

    def flaky_dump(obj, path, *a, **k):
        calls.append(path)
        if len(calls) == 2:          # падаем на втором файле: ensemble.joblib уже записан
            raise OSError("диск заполнен")
        return real_dump(obj, path, *a, **k)

    monkeypatch.setattr(store_mod.joblib, "dump", flaky_dump)
    with pytest.raises(OSError):
        st.save(StubEnsemble(), None, make_meta("c" * 64))
    monkeypatch.undo()
    # новая версия не появилась, временное прибрано, указатель на старой версии
    assert st.list_versions() == [v1] and st.current_version() == v1
    assert [p.name for p in tmp_path.iterdir() if p.name.endswith(".tmp")] == []
    st.load_current()


def test_store_current_pointer_is_atomic(tmp_path, monkeypatch):
    st = ArtifactStore(tmp_path)
    v1 = st.save(StubEnsemble(), None, make_meta())
    monkeypatch.setattr(store_mod.os, "replace", lambda *a, **k: (_ for _ in ()).throw(OSError("сбой")))
    with pytest.raises(OSError):
        st._write_current("v20990101T000000Z_zzz", "z")
    monkeypatch.undo()
    # старый указатель цел и читается, временных файлов нет
    assert json.loads((tmp_path / "current.json").read_text(encoding="utf-8"))["version"] == v1
    assert not list(tmp_path.glob("*.tmp"))


def test_store_cleans_stale_tmp_on_start(tmp_path):
    junk_dir = tmp_path / "v20240101T000000Z_abc.123.deadbeef.tmp"
    junk_dir.mkdir()
    (junk_dir / "ensemble.joblib").write_bytes(b"half")
    junk_file = tmp_path / "current.json.123.deadbeef.tmp"
    junk_file.write_text("{", encoding="utf-8")
    fresh = tmp_path / "v20240102T000000Z_abc.456.cafebabe.tmp"     # свежий — чужой процесс может ещё писать
    fresh.mkdir()
    old = time.time() - 7200
    for p in (junk_dir, junk_file):
        os.utime(p, (old, old))
    ArtifactStore(tmp_path)                    # по умолчанию трогает только старше часа
    assert not junk_dir.exists() and not junk_file.exists() and fresh.exists()
    ArtifactStore(tmp_path, tmp_max_age_s=0)   # явное «чистить всё»
    assert not fresh.exists()


def test_store_falls_back_when_pointer_lost(tmp_path):
    st = ArtifactStore(tmp_path)
    v1 = st.save(StubEnsemble(), None, make_meta())
    (tmp_path / "current.json").write_text("{битый json", encoding="utf-8")
    assert st.current_version() is None and st.resolve_current() == v1
    assert isinstance(st.load_current()[0], StubEnsemble)


def test_store_empty_raises(tmp_path):
    with pytest.raises(store_mod.ModelNotFoundError):
        ArtifactStore(tmp_path, cleanup=False).load_current()


# ================================================================ полное обучение

def test_full_train_synthetic_and_idempotent(tmp_path, caplog):
    kw = dict(synthetic=True, synthetic_start=START, synthetic_end=END, out=tmp_path, ensemble_factory=stub_factory)
    with caplog.at_level("INFO"):
        r1 = full_train.run(**kw)
    assert not r1["skipped"] and r1["n_flights"] > 100
    assert "MAE" in caplog.text and "ensemble" in caplog.text           # таблица метрик в логе
    meta = ArtifactStore(tmp_path).read_metadata(r1["version"])
    assert meta["kind"] == "full" and set(meta["metrics"]) == set(HORIZONS)
    assert meta["data_period"]["from"] >= START and meta["data_period"]["to"] <= END
    caplog.clear()
    with caplog.at_level("INFO"):
        r2 = full_train.run(**kw)
    assert r2["skipped"] and r2["version"] == r1["version"]
    assert "версия уже есть" in caplog.text.lower()
    assert len(ArtifactStore(tmp_path).list_versions()) == 1
    r3 = full_train.run(**kw, force=True)                                # force — новая версия
    assert not r3["skipped"] and r3["version"] != r1["version"]


def test_full_train_files_and_availability(files, tmp_path):
    r = full_train.run(history=files / "SalesHistory.csv", availability=files / "avail.csv",
                       tickets=[files / "Tickets_SALE_Last14Days.csv"], out=tmp_path, ensemble_factory=stub_factory)
    _, table, meta = ArtifactStore(tmp_path).load(r["version"])
    assert meta["n_flights"] == len(table)
    assert {x["role"] for x in meta["inputs"]} == {"history", "availability", "tickets"}
    assert table.capacity_override                                      # Total AU запомнен
    assert table.live                                                   # будущие вылеты из билетов
    # хеши и имена — да, но не содержимое билетов
    assert "NFARE" not in json.dumps(meta) and "DEALDATE" not in json.dumps(meta)


def test_full_train_bad_inputs(tmp_path, capsys):
    with pytest.raises(InputError, match="Нет входных данных"):
        full_train.run(out=tmp_path)
    with pytest.raises(InputError, match="Не найден файл истории продаж"):
        full_train.run(history=tmp_path / "нет.csv", out=tmp_path)
    with pytest.raises(InputError, match="valid-frac"):
        full_train.run(synthetic=True, valid_frac=0.9, out=tmp_path)
    bad = tmp_path / "bad.csv"
    bad.write_text("A,B\n1,2\n", encoding="utf-8")
    with pytest.raises(InputError, match="не распознан"):
        full_train.run(history=bad, out=tmp_path)
    small = tmp_path / "small.csv"
    small.write_text("REIS,FLYDATE,TICKETS,CURVE\nKV-1,01.02.2024,5,0:5\n", encoding="utf-8")
    with pytest.raises(InputError, match="Слишком мало"):
        full_train.run(history=small, out=tmp_path)
    # CLI: код 2 и понятный текст по-русски
    assert full_train.main(["--history", str(tmp_path / "нет.csv"), "--out", str(tmp_path / "o")]) == 2
    assert "Ошибка входных данных" in capsys.readouterr().err
    assert full_train.main(["--out", str(tmp_path / "o")]) == 2
    assert not (tmp_path / "o" / "current.json").exists()


def test_format_metrics_table():
    text = full_train.format_metrics({"7d": {"hmean": {"mae": 4.0, "mape": 0.2, "n": 50}, "_baseline_booked": 9.0}})
    assert "7d" in text and "hmean" in text and "4.00" in text and "_baseline_booked" in text


# ================================================================ дневное дообучение

def test_incremental_flow(trained_root, files, tmp_path):
    import shutil
    root = tmp_path / "art"
    shutil.copytree(trained_root, root)
    st = ArtifactStore(root)
    parent = st.current_version()
    n0 = st.load_current()[1]
    n_before = len(n0)
    kw = dict(tickets=[files / "Tickets_SALE_Last14Days.csv"], availability=files / "avail.csv", out=root, today=TODAY)
    r = incremental.run(**kw)
    assert not r["skipped"] and r["version"] != parent
    ens, table, meta = st.load_current()
    assert meta["kind"] == "incremental" and meta["parent_version"] == parent
    assert meta["metrics"] == st.read_metadata(parent)["metrics"] and "recalibration" in meta
    assert ens.recal_calls and ens.recal_calls[-1] == pd.Timestamp(TODAY) - pd.Timedelta(days=30)
    # новые улетевшие вылеты дописаны, уникальность (reis, flydate), порядок сохранён
    assert len(table) > n_before and not table.df.duplicated(["reis", "flydate"]).any()
    assert table.cum.shape == (len(table), MAX_DTD + 1)
    assert table.df.equals(table.df.sort_values(["flydate", "reis"], kind="stable").reset_index(drop=True))
    assert (table.df["flydate"] >= pd.Timestamp(START)).all() and meta["n_flights"] == len(table)
    # будущие вылеты — в live, Total AU — в capacity_override
    assert table.live and all(k[1] >= pd.Timestamp(TODAY) - pd.Timedelta(days=3) for k in table.live)
    cum = next(iter(table.live.values()))
    assert cum.shape == (MAX_DTD + 1,) and np.all(np.diff(cum) <= 1e-9)
    assert table.capacity_override and all(isinstance(v, int) for v in table.capacity_override.values())
    # повтор с теми же файлами — версия не плодится
    r2 = incremental.run(**kw)
    assert r2["skipped"] and r2["version"] == r["version"]
    assert len(st.list_versions()) == 2


def test_incremental_errors(tmp_path, files, trained_root, capsys):
    with pytest.raises(store_mod.ModelNotFoundError):
        incremental.run(tickets=[files / "Tickets_SALE_Last14Days.csv"], out=tmp_path / "пусто")
    with pytest.raises(InputError, match="Нет входных файлов"):
        incremental.run(out=trained_root)
    with pytest.raises(InputError, match="Не найден файл"):
        incremental.run(tickets=[tmp_path / "нет.csv"], out=trained_root)
    assert incremental.main(["--tickets", str(tmp_path / "нет.csv"), "--out", str(trained_root)]) == 2
    assert "Ошибка входных данных" in capsys.readouterr().err


def test_merge_flown_replace_and_truncated():
    h = make_history(START, "2024-03-31", seed=3)
    table = build_flight_table(h)
    n = len(table)
    row = h.iloc[[100]].copy()
    key = (row["reis"].iloc[0], row["flydate"].iloc[0])
    # свежая строка с большим итогом заменяет старую
    bigger = row.assign(tickets=row["tickets"] + 5, curve=row["curve"].iloc[0] + " 0:5")
    s = incremental.merge_flown(table, bigger)
    assert s == {"added": 0, "replaced": 1, "kept_old": 0} and len(table) == n
    i = table.df.index[(table.df["reis"] == key[0]) & (table.df["flydate"] == key[1])][0]
    assert table.df.loc[i, "tickets"] == row["tickets"].iloc[0] + 5
    assert table.cum[i, 0] == pytest.approx(row["tickets"].iloc[0] + 5)
    # усечённая кривая (билетов сильно меньше) старую полную строку не затирает
    trunc = row.assign(tickets=1, curve="0:1")
    s = incremental.merge_flown(table, trunc)
    assert s["kept_old"] == 1 and table.df.loc[i, "tickets"] > 1
    # новый вылет добавляется
    new = row.assign(flydate=pd.Timestamp("2024-04-05"), reis="KV-NEW")
    assert incremental.merge_flown(table, new)["added"] == 1 and len(table) == n + 1


def test_merge_live_accumulates_idempotently():
    table = build_flight_table(make_history(START, "2024-02-29", seed=3))
    fd = pd.Timestamp("2024-03-10")
    a = pd.DataFrame({"reis": ["KV-100"], "flydate": [fd], "curve": ["1:3 2:2"]})
    b = pd.DataFrame({"reis": ["KV-100"], "flydate": [fd], "curve": ["0:4 1:3"]})     # окна перекрываются по дню 1
    incremental.merge_live(table, a)
    incremental.merge_live(table, b)
    incremental.merge_live(table, b)
    cum = table.live[("KV-100", fd)]
    assert cum[0] == 9 and cum[1] == 5 and cum[2] == 2        # день 1 не задвоился: max(3, 3)


# ================================================================ сервис

@pytest.fixture(scope="module")
def service(trained_root):
    return ForecastService(trained_root, critic_factory=StubCritic)


def _sample_request(service):
    df = service._state["table"].df
    r = df.iloc[-1]
    return r["reis"], r["flydate"] + pd.Timedelta(days=20), float(r["cap"])


def test_service_predict_format(service):
    reis, fd, cap = _sample_request(service)
    booked = int(cap * 0.4)
    out = service.predict(reis, fd.strftime("%d.%m.%Y"), booked, cap, 14)
    assert set(out) == {"reis", "flydate", "horizons", "critic"}
    assert out["reis"] == reis and out["flydate"] == fd.strftime("%d.%m.%Y")
    assert list(out["horizons"]) == ["30d", "14d", "7d", "1_3d"]
    for h, v in out["horizons"].items():
        assert set(v) == {"pred", "confidence"} and isinstance(v["pred"], int)
        assert booked <= v["pred"] <= cap and 0 <= v["confidence"] <= 1
    c = out["critic"]
    assert set(c) == {"ok", "chosen_model", "flags"} and c["ok"] is True
    assert c["chosen_model"].endswith("_14d")        # ближайший к dtd=14 горизонт
    json.dumps(out)                                  # сериализуется без numpy-типов


def test_service_predict_accepts_date_objects_and_weird_input(service):
    reis, fd, cap = _sample_request(service)
    out = service.predict(reis.lower(), fd.date(), 10, cap, 7)       # date и нижний регистр
    assert out["reis"] == reis
    # total_au < current_booked: не падаем, критик отмечает
    weird = service.predict(reis, fd, 150, 100, 7)
    assert weird["critic"]["ok"] is False
    assert any(f.endswith("total_au_below_booked") for f in weird["critic"]["flags"])
    assert all(v["pred"] == 150 for v in weird["horizons"].values())
    # NaN, отрицательное, неизвестный рейс, dtd вне горизонтов — без исключений
    for args in ((reis, fd, float("nan"), cap, 7), (reis, fd, -5, cap, 7), ("ZZ-999", fd, 5, 60, 30),
                 (reis, fd, 5, 60, 0), (reis, fd, 5, 60, 150)):
        res = service.predict(*args)
        assert set(res["horizons"]) == set(HORIZONS)
    with pytest.raises(ValueError):
        service.predict(reis, "не дата", 5, 60, 7)


def test_service_flags_prefixed_by_horizon(trained_root):
    class ClipEverything(StubCritic):
        def review(self, horizon, preds, current_booked, total_au, **kw):
            return StubVerdict(int(current_booked), f"hmean_{horizon}", ["clipped_to_capacity"], horizon != "30d", 0.5)

    svc = ForecastService(trained_root, critic_factory=ClipEverything)
    reis, fd, cap = _sample_request(svc)
    out = svc.predict(reis, fd, 20, cap, 8)
    assert "7d:clipped_to_capacity" in out["critic"]["flags"] and "1_3d:clipped_to_capacity" in out["critic"]["flags"]
    assert out["critic"]["ok"] is False and out["critic"]["chosen_model"] == "hmean_7d"


def test_service_health_and_no_model(tmp_path, service):
    h = service.health()
    assert h["status"] == "ok" and h["model_loaded"] is True and h["version"] and h["trained_at"]
    assert h["n_flights"] > 0 and set(h["metrics"]) == set(HORIZONS)
    empty = ForecastService(tmp_path / "нет", critic_factory=StubCritic)
    assert empty.health()["status"] == "no_model" and empty.ready is False
    with pytest.raises(ModelNotReadyError):
        empty.predict("KV-100", "01.09.2024", 1, 50, 7)
    assert empty.reload() is False


def test_service_reload_picks_new_version_and_survives_bad_one(trained_root, tmp_path):
    import shutil
    root = tmp_path / "art"
    shutil.copytree(trained_root, root)
    svc = ForecastService(root, critic_factory=StubCritic, auto_reload_s=0)
    v1 = svc.health()["version"]
    assert svc.reload() is True and svc.health()["version"] == v1
    st = ArtifactStore(root)
    ens, table, meta = st.load_current()
    v2 = st.save(ens, table, {"input_hash": "d" * 64, "metrics": meta["metrics"]})
    assert svc.reload() and svc.health()["version"] == v2
    # битая новая версия: сервис остаётся на прежней
    (root / v2 / "ensemble.joblib").write_bytes(b"garbage")
    v3dir = root / "v29990101T000000Z_bad"
    shutil.copytree(root / v2, v3dir)
    st.set_current(v3dir.name)
    assert svc.reload() is False and svc.health()["version"] == v2
    reis, fd, cap = _sample_request(svc)
    assert svc.predict(reis, fd, 10, cap, 7)["horizons"]


def test_service_auto_reload_from_disk(trained_root, tmp_path):
    import shutil
    root = tmp_path / "art"
    shutil.copytree(trained_root, root)
    svc = ForecastService(root, critic_factory=StubCritic, auto_reload_s=0.01)
    st = ArtifactStore(root)
    ens, table, meta = st.load_current()
    v2 = st.save(ens, table, {"input_hash": "e" * 64, "metrics": meta["metrics"]})
    time.sleep(0.05)
    reis, fd, cap = _sample_request(svc)
    svc.predict(reis, fd, 10, cap, 7)
    assert svc.health()["version"] == v2


def test_service_thread_safe_reload(trained_root, tmp_path):
    import shutil
    root = tmp_path / "art"
    shutil.copytree(trained_root, root)
    svc = ForecastService(root, critic_factory=StubCritic, auto_reload_s=0)
    reis, fd, cap = _sample_request(svc)
    st = ArtifactStore(root)
    ens, table, meta = st.load_current()
    errors, stop = [], threading.Event()

    def predictor():
        while not stop.is_set():
            try:
                out = svc.predict(reis, fd, 12, cap, 7)
                assert set(out["horizons"]) == set(HORIZONS)
                svc.health()
            except Exception as e:      # noqa: BLE001
                errors.append(e)

    ts = [threading.Thread(target=predictor) for _ in range(4)]
    [t.start() for t in ts]
    for i in range(3):
        st.save(ens, table, {"input_hash": f"{i + 10:064x}", "metrics": meta["metrics"]})
        svc.reload()
    stop.set()
    [t.join(10) for t in ts]
    assert not errors


# ================================================================ полный путь с настоящими классами

def test_full_path_with_real_ensemble_and_critic(tmp_path):
    ens_mod = pytest.importorskip("models.ensemble")
    pytest.importorskip("critic.critic")
    t0 = time.time()

    def light_models(seed):       # быстрый набор: только иерархические средние (LightGBM/seq на загруженной машине долгие)
        from models.fallback import HierarchicalMeanModel
        return [HierarchicalMeanModel(seed=seed)]

    # FLF_FULL_PATH=1 — прогнать с полным набором моделей из registry (дольше минуты)
    factory = None if os.environ.get("FLF_FULL_PATH") else light_models

    res = full_train.run(synthetic=True, synthetic_start=START, synthetic_end=END, out=tmp_path,
                         ensemble_factory=lambda s: ens_mod.EnsembleForecaster(seed=s, models_factory=factory))
    metrics = ArtifactStore(tmp_path).read_metadata(res["version"])["metrics"]
    assert set(metrics) == set(HORIZONS) and "ensemble" in metrics["7d"] and "_baseline_booked" in metrics["7d"]

    hist = make_history(START, END, seed=7)
    tickets = tmp_path / "t.csv"
    avail = tmp_path / "a.csv"
    make_recent_tickets(hist, TODAY, days=14).to_csv(tickets, index=False)
    make_availability(hist, TODAY, days_ahead=20).to_csv(avail, index=False)
    inc = incremental.run(tickets=[tickets], availability=avail, out=tmp_path, today=TODAY)
    assert not inc["skipped"] and incremental.run(tickets=[tickets], availability=avail, out=tmp_path, today=TODAY)["skipped"]

    svc = ForecastService(tmp_path)                       # настоящий Critic
    reis, fd, cap = _sample_request(svc)
    booked = int(cap * 0.5)
    out = svc.predict(reis, fd.strftime("%d.%m.%Y"), booked, cap, 14)
    assert list(out["horizons"]) == ["30d", "14d", "7d", "1_3d"]
    for v in out["horizons"].values():
        assert isinstance(v["pred"], int) and booked <= v["pred"] <= cap and 0.05 <= v["confidence"] <= 0.99
    assert isinstance(out["critic"]["ok"], bool) and out["critic"]["chosen_model"]
    bad = svc.predict(reis, fd, 120, 100, 7)               # total_au < booked
    assert bad["critic"]["ok"] is False and all(v["pred"] == 120 for v in bad["horizons"].values())
    assert svc.health()["status"] == "ok"
    assert os.environ.get("FLF_FULL_PATH") or time.time() - t0 < 60
