"""FastAPI-сервис прогноза загрузки рейсов для RMS.

Эндпоинты:
  POST /predict          прогноз по четырём горизонтам (30d, 14d, 7d, 1_3d)
  GET  /health           состояние сервиса и модели
  POST /retrain          полное переобучение в фоне (нужен X-Admin-Token)
  POST /incremental      дообучение на свежих файлах в фоне (нужен X-Admin-Token)
  GET  /retrain/status   что сейчас с фоновым обучением

Пути берутся из переменных окружения (см. README):
  FORECAST_ARTIFACTS, FORECAST_HISTORY, FORECAST_AVAILABILITY, FORECAST_TICKETS_DIR, FORECAST_ADMIN_TOKEN.
"""
from __future__ import annotations

import hmac
import importlib
import inspect
import logging
import os
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from pydantic import ValidationError

from .schemas import BatchRequest, PredictRequest, PredictResponse, RetrainRequest

log = logging.getLogger("forecast.api")

ROOT = Path(__file__).resolve().parent.parent

MSG_NO_MODEL = "Модель ещё не обучена"
MSG_INTERNAL = "Внутренняя ошибка сервиса прогноза. Подробности записаны в лог."


# ---------------------------------------------------------------- пути из окружения

def artifacts_dir() -> Path:
    return Path(os.environ.get("FORECAST_ARTIFACTS") or ROOT / "artifacts")


def history_path() -> Path:
    return Path(os.environ.get("FORECAST_HISTORY") or ROOT / "input" / "SalesHistory.csv")


def availability_path() -> Path:
    return Path(os.environ.get("FORECAST_AVAILABILITY") or ROOT / "input" / "Availability.csv")


def tickets_dir() -> Path:
    return Path(os.environ.get("FORECAST_TICKETS_DIR") or ROOT / "input" / "tickets")


# ---------------------------------------------------------------- сервис прогноза

def _make_service():
    """Создаёт ForecastService. ЕДИНСТВЕННОЕ место, где известна сигнатура конструктора.

    ВНИМАНИЕ: сигнатура ForecastService.__init__ в контракте не зафиксирована, поэтому подбираем
    имя аргумента с путём к артефактам по inspect. Если сервис изменится — поправьте здесь.
    """
    mod = importlib.import_module("app.service")
    cls = mod.ForecastService
    params = inspect.signature(cls).parameters
    for name in ("artifacts", "artifacts_dir", "root", "store_dir", "path", "store"):
        if name in params:
            return cls(**{name: str(artifacts_dir())})
    if any(p.default is inspect.Parameter.empty and p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)
           for p in params.values()):
        return cls(str(artifacts_dir()))
    return cls()


def _call_predict(service, req: PredictRequest) -> dict:
    """Вызов service.predict. ЕДИНСТВЕННОЕ место, где известна его сигнатура.

    ВНИМАНИЕ: тип flydate в контракте не уточнён. Передаём datetime.date (ForecastService понимает
    date, Timestamp и строку). Если сигнатура изменится — поправьте здесь.
    """
    return service.predict(reis=req.reis.upper(), flydate=req.flydate_date, current_booked=req.current_booked,
                           total_au=req.total_au, dtd=req.dtd)


_service_lock = threading.Lock()


def get_service(request: Request):
    """Зависимость FastAPI: возвращает сервис (создаёт лениво) или None, если создать не удалось.
    В тестах подменяется через app.dependency_overrides[get_service]."""
    app = request.app
    svc = getattr(app.state, "service", None)
    if svc is None:
        with _service_lock:
            svc = getattr(app.state, "service", None)
            if svc is None:
                try:
                    svc = _make_service()
                except Exception:
                    log.exception("не удалось создать ForecastService")
                    return None        # /predict ответит 503, /health покажет no_model
                app.state.service = svc
    return svc


def _model_loaded(health: dict) -> bool:
    """Модель загружена? Ключи health() в контракте не зафиксированы — проверяем по очереди."""
    for key in ("model_loaded", "loaded", "ready", "has_model"):
        if key in health:
            return bool(health[key])
    if "version" in health:
        return bool(health["version"])
    if "status" in health:
        return str(health["status"]).lower() in ("ok", "ready")
    return True


def _is_no_model_error(exc: BaseException) -> bool:
    name = type(exc).__name__.lower()
    return (isinstance(exc, FileNotFoundError)
            or any(w in name for w in ("notready", "notrained", "nomodel", "notfitted", "notloaded", "modelnot")))


# ---------------------------------------------------------------- фоновое обучение

_job_lock = threading.Lock()
_job: dict = {"state": "idle", "kind": None, "started_at": None, "finished_at": None, "error": None,
              "result": None}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _filter_kwargs(fn, kwargs: dict) -> dict:
    """Оставляет только те именованные аргументы, которые функция принимает."""
    params = inspect.signature(fn).parameters
    if any(p.kind is p.VAR_KEYWORD for p in params.values()):
        return kwargs
    return {k: v for k, v in kwargs.items() if k in params}


def _run_training(kind: str, force: bool, synthetic: bool):
    """Запуск обучения. ЕДИНСТВЕННОЕ место, где известны сигнатуры training.*.run(...).

    ВНИМАНИЕ: точные сигнатуры run() заранее неизвестны. Вызываем с именованными аргументами
    history, availability, tickets, out, force, synthetic и отбрасываем те, которых функция не принимает.
    Если сигнатуры другие — поправьте здесь.
    """
    module = "training.full_train" if kind == "retrain" else "training.incremental"
    fn = importlib.import_module(module).run
    hist, avail, tdir = history_path(), availability_path(), tickets_dir()
    tickets = sorted(str(p) for p in tdir.glob("*.csv")) if tdir.is_dir() else []
    # Для дообучения полный SalesHistory не нужен (там «дневная выгрузка улетевших вылетов», необязательная).
    use_history = kind == "retrain" and hist.is_file()
    kwargs = {
        "history": str(hist) if use_history else None,
        "availability": str(avail) if avail.is_file() else None,
        "tickets": tickets or None,
        "out": str(artifacts_dir()),
        "force": force,
        "synthetic": synthetic,
    }
    return fn(**_filter_kwargs(fn, kwargs))


def _summarize(result) -> str | None:
    """Короткое описание результата run() для /retrain/status (версия, если есть)."""
    if result is None:
        return None
    if isinstance(result, str):
        return result[:200]
    if isinstance(result, dict):
        for k in ("version", "ver"):
            if k in result:
                return str(result[k])[:200]
    return None


def _job_worker(kind: str, force: bool, synthetic: bool, app: FastAPI):
    t0 = time.time()
    try:
        result = _run_training(kind, force, synthetic)
        # после обучения подхватываем новую версию в сервисе
        svc = getattr(app.state, "service", None)
        if svc is None:
            try:
                svc = _make_service()
                app.state.service = svc
            except Exception:
                log.exception("не удалось создать сервис после обучения")
        if svc is not None:
            svc.reload()
        with _job_lock:
            _job.update(state="done", finished_at=_now(), error=None, result=_summarize(result))
        log.info("фоновая задача %s завершена за %.1f с", kind, time.time() - t0)
    except BaseException as e:  # noqa: BLE001 — задача не должна оставить статус «running»
        log.exception("фоновая задача %s упала", kind)
        # наружу — тип ошибки; текст только у «понятных» ошибок входных данных (без путей и стеков). Остальное — в логе.
        name = type(e).__name__
        text = f"{name}: {str(e)[:200]}" if name in ("InputError", "ModelNotFoundError") else name
        with _job_lock:
            _job.update(state="failed", finished_at=_now(), error=text, result=None)


def _start_job(kind: str, body: RetrainRequest | None, app: FastAPI) -> dict:
    body = body or RetrainRequest()
    with _job_lock:
        if _job["state"] == "running":
            raise HTTPException(status_code=409, detail="Обучение уже идёт. Дождитесь окончания (GET /retrain/status).")
        if (not body.synthetic and kind == "retrain" and not history_path().is_file()
                and not (tickets_dir().is_dir() and any(tickets_dir().glob("*.csv")))):
            raise HTTPException(
                status_code=422,
                detail="Не найден файл истории продаж. Задайте путь в FORECAST_HISTORY "
                       "или передайте {\"synthetic\": true} для демо-обучения на синтетике.")
        _job.update(state="running", kind=kind, started_at=_now(), finished_at=None, error=None, result=None)
        th = threading.Thread(target=_job_worker, args=(kind, body.force, body.synthetic, app),
                              name=f"forecast-{kind}", daemon=True)
        th.start()
        return dict(_job)


def require_admin(x_admin_token: str | None = Header(default=None)) -> None:
    """Проверка токена администратора. Нет FORECAST_ADMIN_TOKEN в окружении — доступ закрыт совсем."""
    expected = os.environ.get("FORECAST_ADMIN_TOKEN", "")
    if not expected:
        raise HTTPException(status_code=403, detail="Администрирование отключено: на сервере не задан FORECAST_ADMIN_TOKEN.")
    if not x_admin_token or not hmac.compare_digest(x_admin_token.encode("utf-8"), expected.encode("utf-8")):
        raise HTTPException(status_code=403, detail="Неверный или отсутствующий заголовок X-Admin-Token.")


# ---------------------------------------------------------------- приложение

@asynccontextmanager
async def lifespan(app: FastAPI):
    """При старте пробуем загрузить текущую модель. Если её нет — сервис всё равно стартует."""
    try:
        svc = _make_service()
        app.state.service = svc
        try:
            svc.reload()
        except Exception as e:  # noqa: BLE001
            log.warning("Текущая модель не загружена (%s: %s). Сервис запущен, /predict вернёт 503.",
                        type(e).__name__, e)
    except Exception as e:  # noqa: BLE001
        log.warning("ForecastService не создан (%s: %s). Сервис запущен без модели.", type(e).__name__, e)
    yield


app = FastAPI(title="Прогноз загрузки рейсов", version="1.0", lifespan=lifespan,
              description="Ансамбль моделей и критик: итог пассажиров на вылете при 30/14/7/1-3 днях до вылета.")


@app.middleware("http")
async def log_requests(request: Request, call_next):
    """Одна строка на запрос: метод, путь, статус, время. Тело запроса не пишем."""
    t0 = time.perf_counter()
    status = 500
    try:
        response = await call_next(request)
        status = response.status_code
        return response
    finally:
        extra = getattr(request.state, "log_extra", "")
        log.info("%s %s -> %s %.0f мс %s", request.method, request.url.path, status,
                 (time.perf_counter() - t0) * 1000, extra)


# ---------------------------------------------------------------- обработчики ошибок

_FIELD_RU = {"reis": "рейс (reis)", "flydate": "дата вылета (flydate)", "current_booked": "продано сейчас (current_booked)",
             "total_au": "Total AU (total_au)", "dtd": "дней до вылета (dtd)", "force": "force", "synthetic": "synthetic"}


def _ru_message(err: dict) -> str:
    t, ctx = err.get("type", ""), err.get("ctx") or {}
    if t == "missing":
        return "поле обязательно"
    if t == "string_too_short":
        return f"длина должна быть не меньше {ctx.get('min_length')} симв."
    if t == "string_too_long":
        return f"длина должна быть не больше {ctx.get('max_length')} символов"
    if t == "string_type":
        return "должно быть строкой"
    if t in ("greater_than_equal", "less_than_equal", "greater_than", "less_than"):
        word = {"greater_than_equal": "не меньше", "less_than_equal": "не больше",
                "greater_than": "больше", "less_than": "меньше"}[t]
        lim = ctx.get("ge", ctx.get("le", ctx.get("gt", ctx.get("lt"))))
        if isinstance(lim, float) and lim.is_integer():
            lim = int(lim)
        return f"значение должно быть {word} {lim}"
    if t in ("int_parsing", "int_from_float", "float_parsing", "int_type", "float_type", "int_parsing_size"):
        return "должно быть числом" + (" (целым)" if t.startswith("int") else "")
    if t == "finite_number":
        return "число должно быть конечным"
    if t == "bool_parsing" or t == "bool_type":
        return "должно быть true или false"
    if t == "value_error":
        e = ctx.get("error")
        return str(e) if e else "недопустимое значение"
    return "недопустимое значение"


@app.exception_handler(RequestValidationError)
async def on_validation_error(request: Request, exc: RequestValidationError):
    errors = []
    for e in exc.errors():
        loc = [str(x) for x in e.get("loc", ()) if x not in ("body", "query")]
        field = ".".join(loc)
        if e.get("type") == "json_invalid":
            msg = "тело запроса не является корректным JSON"
        elif e.get("type") in ("model_attributes_type", "dict_type") and not field:
            msg = "тело запроса должно быть JSON-объектом"
        else:
            msg = _ru_message(e)
        errors.append({"field": field, "message": msg})
    parts = [f"{_FIELD_RU.get(x['field'], x['field'])}: {x['message']}" if x["field"] else x["message"] for x in errors]
    return JSONResponse(status_code=422, content={"detail": "Некорректный запрос. " + "; ".join(parts) + ".",
                                                  "errors": errors})


@app.exception_handler(Exception)
async def on_unhandled(request: Request, exc: Exception):
    log.error("необработанная ошибка в %s %s", request.method, request.url.path, exc_info=exc)
    return JSONResponse(status_code=500, content={"detail": MSG_INTERNAL})


# ---------------------------------------------------------------- эндпоинты

@app.post("/predict", response_model=PredictResponse, summary="Прогноз по четырём горизонтам")
def predict(req: PredictRequest, request: Request, service=Depends(get_service)):
    # в лог — только служебные поля запроса (номер рейса не персональные данные)
    request.state.log_extra = f"reis={req.reis} dtd={req.dtd}"
    if service is None:
        raise HTTPException(status_code=503, detail=MSG_NO_MODEL)
    try:
        result = _call_predict(service, req)
        out = dict(result)
        out["reis"], out["flydate"] = req.reis, req.flydate
        return PredictResponse.model_validate(out)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        if _is_no_model_error(e):
            log.warning("predict: модель не готова (%s)", type(e).__name__)
            raise HTTPException(status_code=503, detail=MSG_NO_MODEL) from None
        log.exception("predict: внутренняя ошибка (reis=%s dtd=%s)", req.reis, req.dtd)
        raise HTTPException(status_code=500, detail=MSG_INTERNAL) from None


@app.post("/predict_batch", summary="Прогноз сразу по многим рейсам")
def predict_batch(body: BatchRequest, request: Request, service=Depends(get_service)):
    """Для окна сравнения моделей. Ошибка в одном рейсе не ломает остальные: у него `ok=false` и текст."""
    request.state.log_extra = f"batch={len(body.items)}"
    if service is None:
        raise HTTPException(status_code=503, detail=MSG_NO_MODEL)
    # каждый элемент проверяется отдельно: плохой не ломает остальные
    valid, results = [], [None] * len(body.items)
    for i, raw in enumerate(body.items):
        try:
            req = PredictRequest.model_validate(raw)
            valid.append((i, {"reis": req.reis.upper(), "flydate": req.flydate_date, "current_booked": req.current_booked,
                              "total_au": req.total_au, "dtd": req.dtd}))
        except ValidationError as e:
            results[i] = {"ok": False, "error": _ru_message(e.errors()[0]) if e.errors() else "плохой запрос"}
    try:
        if valid:
            done = service.predict_many([v[1] for v in valid])
            for (i, _), r in zip(valid, done):
                if r.get("ok"):
                    out = dict(r["result"])
                    out["flydate"] = body.items[i].get("flydate", out.get("flydate"))
                    results[i] = {"ok": True, "result": PredictResponse.model_validate(out).model_dump()}
                else:
                    results[i] = {"ok": False, "error": r.get("error") or MSG_INTERNAL}
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        if _is_no_model_error(e):
            raise HTTPException(status_code=503, detail=MSG_NO_MODEL) from None
        log.exception("predict_batch: внутренняя ошибка")
        raise HTTPException(status_code=500, detail=MSG_INTERNAL) from None
    return {"results": results}


@app.get("/health", summary="Состояние сервиса")
def health(service=Depends(get_service)):
    info: dict = {"model_loaded": False}
    try:
        if service is not None:
            info = dict(service.health())
    except Exception:  # noqa: BLE001
        log.exception("health: ошибка сервиса")
        info = {"model_loaded": False, "error": "ошибка при чтении состояния модели"}
    loaded = _model_loaded(info)
    info.setdefault("model_loaded", loaded)
    with _job_lock:
        job = dict(_job)
    return {"status": "ok" if loaded else "no_model", **info, "retrain": job}


@app.post("/retrain", status_code=202, dependencies=[Depends(require_admin)],
          summary="Полное переобучение в фоне")
def retrain(request: Request, body: RetrainRequest | None = None):
    return _start_job("retrain", body, request.app)


@app.post("/incremental", status_code=202, dependencies=[Depends(require_admin)],
          summary="Дообучение на свежих файлах в фоне")
def incremental(request: Request, body: RetrainRequest | None = None):
    return _start_job("incremental", body, request.app)


@app.get("/retrain/status", summary="Состояние фонового обучения")
def retrain_status():
    with _job_lock:
        return dict(_job)
