"""Сервис прогноза: держит (ансамбль, таблица, критик) и отвечает на запросы в формате API.

Потокобезопасность: состояние меняется только целиком под ``RLock`` (смена ссылок), а сама загрузка
с диска идёт вне замка — запросы на прогноз не ждут чтения файлов. Параллельные ``reload()``
выстраиваются в очередь. ``predict`` берёт «снимок» состояния и считает без замка.

Если рядом с работающим API ночной ретрейн (cron) положил новую версию, сервис это заметит сам:
не чаще раза в ``auto_reload_s`` секунд он смотрит на ``current.json`` (отключается нулём).
"""
from __future__ import annotations

import logging
import math
import threading
import time
from datetime import date, datetime

import numpy as np
import pandas as pd

from data.features import HORIZONS, horizon_of_dtd, inference_frames, inference_frames_batch
from data.parsers import parse_dates
from models.base import as_frame
from training.store import ArtifactStore, ModelNotFoundError

log = logging.getLogger(__name__)

HORIZON_ORDER = ("30d", "14d", "7d", "1_3d")


class ModelNotReadyError(RuntimeError):
    """Модель ещё не обучена или не загружена (API отвечает 503)."""


def _parse_flydate(value) -> pd.Timestamp:
    """'ДД.ММ.ГГГГ' / ГГГГ-ММ-ДД / date / datetime / Timestamp -> Timestamp (день)."""
    if isinstance(value, (pd.Timestamp, datetime, date)):
        ts = pd.Timestamp(value)
    else:
        ts = parse_dates(pd.Series([str(value)])).iloc[0]
    if pd.isna(ts):
        raise ValueError(f"Не удалось разобрать дату вылета «{value}» (нужен формат ДД.ММ.ГГГГ)")
    return ts.normalize()


def _flydate_str(value, ts: pd.Timestamp) -> str:
    return value if isinstance(value, str) else ts.strftime("%d.%m.%Y")


def _finite(x, default: float = 0.0) -> float:
    try:
        x = float(x)
    except (TypeError, ValueError):
        return default
    return x if math.isfinite(x) else default


class ForecastService:
    def __init__(self, artifacts="artifacts", critic_factory=None, auto_reload_s: float = 60.0, load: bool = True):
        """artifacts — каталог с версиями. critic_factory(ledger) -> критик (по умолчанию critic.critic.Critic)."""
        self.store = ArtifactStore(artifacts, cleanup=False)       # только чтение: ничего не чистим
        self._critic_factory = critic_factory
        self._auto_reload_s = float(auto_reload_s)
        self._lock = threading.RLock()          # защита смены состояния
        self._reload_lock = threading.Lock()    # одна перезагрузка за раз
        self._state: dict | None = None         # {"ensemble","table","critic","meta","version"}
        self._last_check = time.monotonic()
        self._last_error: str | None = None
        if load:
            self.reload()

    # ---------------------------------------------------------------- состояние

    @property
    def ready(self) -> bool:
        with self._lock:
            return self._state is not None

    def _make_critic(self, ensemble):
        factory = self._critic_factory
        if factory is None:
            from critic.critic import Critic as factory   # noqa: N813  (ленивый импорт: модуль пишется отдельно)
        return factory(getattr(ensemble, "ledger", None))

    def reload(self) -> bool:
        """Загружает текущую версию с диска. True — состояние обновлено/загружено; False — загрузить нечего или сбой
        (прежняя модель, если была, остаётся в работе)."""
        with self._reload_lock:
            try:
                version = self.store.resolve_current()
                if version is None:
                    self._last_error = "в хранилище нет обученной модели"
                    log.warning("Перезагрузка: %s", self._last_error)
                    return False
                with self._lock:
                    cur = self._state["version"] if self._state else None
                if cur == version:
                    return True
                ensemble, table, meta = self.store.load(version)
                critic = self._make_critic(ensemble)
                new_state = {"ensemble": ensemble, "table": table, "critic": critic, "meta": meta, "version": version}
            except (ModelNotFoundError, FileNotFoundError) as e:
                self._last_error = f"модель не найдена: {e}"
                log.warning("Перезагрузка: %s", self._last_error)
                return False
            except Exception as e:      # битый файл, несовместимая версия библиотек и т.п.
                self._last_error = f"{type(e).__name__}: {e}"
                log.exception("Не удалось загрузить модель — продолжаю работать на прежней")
                return False
            with self._lock:
                self._state = new_state
                self._last_error = None
            log.info("Загружена модель %s (вылетов в таблице: %s)", new_state["version"], new_state["meta"].get("n_flights"))
            return True

    def _maybe_reload(self) -> None:
        if self._auto_reload_s <= 0:
            return
        now = time.monotonic()
        if now - self._last_check < self._auto_reload_s:
            return
        self._last_check = now
        try:
            v = self.store.resolve_current()
            with self._lock:
                cur = self._state["version"] if self._state else None
            if v and v != cur:
                log.info("В хранилище новая версия %s — перезагружаю", v)
                self.reload()
        except Exception:
            log.exception("Проверка новой версии не удалась")

    def _snapshot(self) -> dict:
        self._maybe_reload()
        with self._lock:
            st = self._state
        if st is None:
            raise ModelNotReadyError("Модель ещё не обучена")
        return st

    # ---------------------------------------------------------------- прогноз

    def predict(self, reis, flydate, current_booked, total_au, dtd, od=None) -> dict:
        """Ответ в формате API::

            {"reis","flydate","horizons":{"30d":{"pred","confidence"},...},
             "critic":{"ok","chosen_model","flags"}}

        Не падает на странных числах (total_au < current_booked, NaN, отрицательные): их разбирает критик.
        Исключение — не распознана дата вылета (ValueError) или модели нет (ModelNotReadyError).
        """
        st = self._snapshot()
        ensemble, table, critic = st["ensemble"], st["table"], st["critic"]
        ts = _parse_flydate(flydate)
        reis_n = str(reis).strip().upper()
        dtd_i = int(_finite(dtd, 0.0))
        booked_raw, au_raw = current_booked, total_au
        booked = max(_finite(current_booked), 0.0)          # для признаков — только конечные неотрицательные
        au = _finite(total_au, booked)
        if od is None:
            known = table.df.loc[table.df["reis"] == reis_n, "od"]
            od = known.iloc[-1] if len(known) else ""

        try:
            frames = inference_frames(table, reis_n, ts, booked, au, dtd_i, od)
        except Exception:
            log.exception("Не удалось построить признаки для рейса %s", reis_n)
            frames = {}

        horizons, all_flags, all_ok, per_h = {}, [], True, {}
        for h in HORIZON_ORDER:
            inf = frames.get(h)
            try:
                if inf is None:
                    raise RuntimeError("нет признаков горизонта")
                raw = ensemble.predict(h, as_frame(inf))
                preds = {k: float(np.asarray(v, dtype=float).ravel()[0]) for k, v in raw.items()}
                v = critic.review(h, preds, booked_raw, au_raw, dtd=dtd_i, reis=reis_n, od=od,
                                  distance=int(inf.get("distance", abs(HORIZONS[h][0] - dtd_i))))
                pred, conf, flags, ok, chosen = int(v.pred), float(v.confidence), list(v.flags), bool(v.ok), str(v.chosen_model)
            except Exception:
                log.exception("Сбой прогноза на горизонте %s", h)
                pred = int(round(booked))
                conf, flags, ok, chosen = 0.05, ["service_error"], False, f"booked_{h}"
            horizons[h] = {"pred": pred, "confidence": round(conf, 4)}
            per_h[h] = (chosen, flags, ok)
            all_ok &= ok
            all_flags += [f"{h}:{f}" for f in flags]

        nearest = horizon_of_dtd(dtd_i)
        return {
            "reis": reis_n,
            "flydate": _flydate_str(flydate, ts),
            "horizons": horizons,
            "critic": {"ok": bool(all_ok), "chosen_model": per_h[nearest][0], "flags": all_flags},
        }

    def predict_many(self, items: list[dict]) -> list[dict]:
        """Много рейсов за один проход (окно сравнения моделей). Каждый элемент — как аргументы predict().

        Возвращает список той же длины: {"ok": True, "result": <ответ predict>} или {"ok": False, "error": текст}.
        Признаки и модели считаются пачкой по горизонтам; рейс с некорректными числами уходит в обычный predict().
        """
        st = self._snapshot()
        ensemble, table, critic = st["ensemble"], st["table"], st["critic"]
        out: list[dict | None] = [None] * len(items)
        good: list[tuple[int, dict]] = []
        for i, it in enumerate(items):
            try:
                ts = _parse_flydate(it["flydate"])
                booked, au = float(it["current_booked"]), float(it["total_au"])
                dtd_i = int(it["dtd"])
                if not (np.isfinite(booked) and np.isfinite(au)) or booked < 0 or au <= 0 or not 0 <= dtd_i <= 180:
                    raise ValueError("число вне допустимых границ")
                good.append((i, {"reis": str(it["reis"]).strip().upper(), "flydate": ts, "current_booked": booked,
                                 "total_au": au, "dtd": dtd_i, "raw": it}))
            except Exception:   # странный ввод: пусть решает обычный predict (там критик и флаги)
                try:
                    out[i] = {"ok": True, "result": self.predict(**{k: it.get(k) for k in
                                                                    ("reis", "flydate", "current_booked", "total_au", "dtd")})}
                except Exception as e:      # noqa: BLE001
                    out[i] = {"ok": False, "error": str(e)[:200] or type(e).__name__}
        if good:
            try:
                frames = inference_frames_batch(table, [g[1] for g in good])
                od_of = table.df.groupby("reis")["od"].last().to_dict()
                preds_h = {}
                for h in HORIZON_ORDER:
                    fr = frames[h]
                    raw = ensemble.predict(h, {"X": fr["X"], "H": fr["H"], "V": fr["V"],
                                               "booked": fr["X"]["booked"].values, "cap": fr["X"]["cap"].values})
                    preds_h[h] = {k: np.asarray(v, dtype=float).ravel() for k, v in raw.items()}
                for j, (i, sp) in enumerate(good):
                    horizons, flags_all, ok_all, per_h = {}, [], True, {}
                    for h in HORIZON_ORDER:
                        try:
                            preds = {k: float(v[j]) for k, v in preds_h[h].items()}
                            v = critic.review(h, preds, sp["current_booked"], sp["total_au"], dtd=sp["dtd"],
                                              reis=sp["reis"], od=od_of.get(sp["reis"], ""),
                                              distance=int(frames[h]["distance"][j]))
                            pred, conf, flags, ok, chosen = int(v.pred), float(v.confidence), list(v.flags), bool(v.ok), str(v.chosen_model)
                        except Exception:
                            log.exception("Сбой прогноза на горизонте %s", h)
                            pred, conf, flags, ok, chosen = int(round(sp["current_booked"])), 0.05, ["service_error"], False, f"booked_{h}"
                        horizons[h] = {"pred": pred, "confidence": round(conf, 4)}
                        per_h[h] = chosen
                        ok_all &= ok
                        flags_all += [f"{h}:{f}" for f in flags]
                    out[i] = {"ok": True, "result": {
                        "reis": sp["reis"], "flydate": _flydate_str(sp["raw"]["flydate"], sp["flydate"]),
                        "horizons": horizons,
                        "critic": {"ok": bool(ok_all), "chosen_model": per_h[horizon_of_dtd(sp["dtd"])], "flags": flags_all}}}
            except Exception:
                log.exception("Пакетный прогноз не удался — считаю по одному")
                for i, sp in good:
                    if out[i] is None:
                        try:
                            out[i] = {"ok": True, "result": self.predict(sp["reis"], sp["flydate"], sp["current_booked"],
                                                                         sp["total_au"], sp["dtd"])}
                        except Exception as e:      # noqa: BLE001
                            out[i] = {"ok": False, "error": str(e)[:200] or type(e).__name__}
        return [o if o is not None else {"ok": False, "error": "нет результата"} for o in out]

    # ---------------------------------------------------------------- состояние сервиса

    def health(self) -> dict:
        """Статус, версия модели, дата обучения, число вылетов, метрики."""
        with self._lock:
            st = self._state
        if st is None:
            return {"status": "no_model", "model_loaded": False, "version": None, "model_version": None,
                    "trained_at": None, "n_flights": 0, "metrics": {}, "detail": self._last_error}
        meta = st["meta"]
        return {"status": "ok", "model_loaded": True, "version": st["version"], "model_version": st["version"],
                "trained_at": meta.get("full_trained_utc") or meta.get("created_utc"),
                "updated_at": meta.get("created_utc"), "kind": meta.get("kind"),
                "n_flights": meta.get("n_flights"), "data_period": meta.get("data_period"),
                "metrics": meta.get("metrics", {}), "recalibration": meta.get("recalibration"),
                "libs": meta.get("libs"), "detail": self._last_error}
