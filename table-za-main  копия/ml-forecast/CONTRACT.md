# Контракт частей проекта (для разработчиков)

Корень проекта: `flight-load-forecast/`. Запуск тестов и скриптов — из корня (`python -m ...`, `pytest`).
Python 3.13, есть: numpy, pandas, sklearn, lightgbm, joblib, fastapi, pydantic, uvicorn, httpx, pytest.
НЕТ: torch, xgboost (ставить нельзя — нет сети). Всё, что требует их, делать опциональным, с запасным вариантом.
Комментарии, логи и README — по-русски. Никаких персональных данных в коде и примерах.

## Уже готово (не переписывать, можно читать и дополнять осторожно)
- `data/parsers.py`: `parse_curve`, `curve_to_cumulative`, `cumulative_to_curve`, `load_sales_history`, `load_tickets`,
  `tickets_to_history`, `load_availability`, `MAX_DTD`.
- `data/features.py`: `HORIZONS` {"30d","14d","7d","1_3d"} -> (центр, мин, макс DTD), `FEATURE_COLS`, `SEQ_H=28`, `SEQ_V=8`,
  `FlightTable` (df, cum, live), `build_flight_table(history, availability)`, `training_frame(table, horizon)`,
  `inference_frames(table, reis, flydate, current_booked, total_au, dtd, od=None)`, `horizon_of_dtd`.
- `data/synthetic.py`: `make_history`, `history_to_csv`, `make_availability`, `make_recent_tickets`.
- `models/base.py`: `BaseModel`, `as_frame`; `models/registry.py`: `default_models(seed)`.

## Что строит каждая часть
### A. Базовые модели (`models/fallback.py`, `models/lgbm.py`, `models/sequence.py`)
Классы `HierarchicalMeanModel`, `LGBMModel`, `SequenceModel`; конструктор `(seed=0)`; атрибут `name` ("hmean", "lgbm", "seq");
`fit(frame, horizon)`, `predict(frame)->np.ndarray` итогов. Дополнительно у моделей, где можно, метод
`predict_interval(frame, q=(0.1, 0.9)) -> (lo, hi)` (если нет — не определять).
- hmean: иерархия route(рейс×день недели) -> OD -> global, берёт `h_final`/`h_rem` из X, плюс booked: `max(booked, booked + h_rem*k)`.
- lgbm: LightGBM по FEATURE_COLS, цель — остаток `y - booked` (не ниже 0), ранняя остановка по хвосту выборки во времени.
- seq: если установлен torch — GRU/LSTM по H и V + статические признаки; если torch нет — запасной вариант на sklearn
  (MLPRegressor по склеенным H, V и статике). Обе ветки с одним интерфейсом, выбор автоматический, имя остаётся "seq".

### B. Ансамбль и критик (`models/ensemble.py`, `critic/critic.py`)
`EnsembleForecaster` (picklable):
- `__init__(self, seed=0, models_factory=None)` (по умолчанию `models.registry.default_models`).
- `fit(self, table: FlightTable, valid_frac=0.15) -> dict` — по каждому горизонту: training_frame; время-разбиение
  (последние valid_frac по дате as_of идут в проверку); обучить базовые модели; стекинг: неотрицательные веса (NNLS)
  по проверке; в конце дообучить базовые на всём. Возвращает `metrics[horizon][model_name] = {"mae":..,"mape":..,"n":..}`,
  где model_name = `<name>` и "ensemble", плюс `metrics[horizon]["_baseline_booked"]` (MAE у «текущее число проданных»).
  MAE/MAPE логируются через logging.
- `predict(self, horizon, frame) -> dict[str, np.ndarray]` — сырые прогнозы по именам моделей + "ensemble". Не падает,
  если одна из моделей упала (тогда её нет в результате, пишется warning).
- `recalibrate(self, table, since) -> dict` — лёгкое дообучение: пересчитать недавние ошибки по вылетам с `flydate >= since`,
  обновить веса стекинга и сдвиг (bias) по горизонту, без полного ретрейна; вернуть метрики. Должно быть идемпотентно
  (повторный вызов с теми же данными не меняет результат).
- `ledger: ErrorLedger` — журнал недавних ошибок; `model_names(horizon)`; `info() -> dict` (версии библиотек, список моделей).
`critic/critic.py`:
- `ErrorLedger`: `record(model, horizon, reis, od, abs_err, pct_err, when)`, `recent_mae(model, horizon, reis=None, od=None, window=200)`
  с иерархическим запасным уровнем reis -> od -> global; `to_dict()/from_dict()`; ограничение размера (кольцевой буфер).
- `Critic(ledger)`; `review(horizon, preds: dict[str,float], current_booked, total_au, dtd, reis, od, distance=0) -> Verdict`.
  `Verdict`: `pred:int`, `chosen_model:str` (вида "lgbm_7d"), `flags:list[str]`, `ok:bool`, `confidence:float 0..1`,
  `interval:(lo,hi)`. Правила: выбрать модель с наименьшим недавним MAE (reis->od->global; если ошибок нет — "ensemble");
  отбросить NaN/Inf/отрицательные/нечисловые; если выбранная плоха — следующая лучшая -> ensemble -> hmean -> booked;
  всегда `pred = max(current_booked, min(pred, total_au))` (если total_au < current_booked — флаг и pred = current_booked);
  `confidence` убывает с удалением от горизонта (distance) и ростом недавнего MAE относительно остатка, 0.05..0.99;
  флаги: "clipped_to_capacity", "clipped_to_booked", "non_finite_model:<имя>", "fallback_model", "sparse_route",
  "total_au_below_booked", "far_from_horizon". `ok=False` только если пришлось падать до booked или были некорректные входы.
  Никогда не бросает исключений (любой сбой -> pred=current_booked, flag "critic_error", ok=False).

### C. Обучение, хранилище, сервис (`training/store.py`, `training/full_train.py`, `training/incremental.py`, `app/service.py`)
- `training/store.py`: `ArtifactStore(root)` — версии `artifacts/v<UTC>_<хеш входа>/` с `ensemble.joblib`, `table.joblib`,
  `metadata.json` (версия, дата, хеш входных файлов, метрики по горизонтам, версии библиотек, число вылетов) и указатель
  `artifacts/current.json`. Запись атомарная (во временную папку -> `os.replace`), идемпотентная (тот же хеш входа и тот же
  параметр -> версия не дублируется), безопасная при перезапуске (недописанные `.tmp` чистятся), хранить последние N=5 версий.
  `save(ensemble, table, metadata) -> version`, `load_current() -> (ensemble, table, metadata)`, `list_versions()`.
- `training/full_train.py`: CLI `python -m training.full_train --history SalesHistory.csv [--availability f.csv] [--tickets f.csv ...]
  [--synthetic] [--out artifacts] [--force]`; читает данные, строит FlightTable, обучает EnsembleForecaster, пишет метрики
  (MAE/MAPE по горизонтам) в лог и в metadata, сохраняет. Функция `run(...)` для вызова из API. Если входов нет — `--synthetic`.
- `training/incremental.py`: CLI и `run(...)`: загрузить текущую версию, добавить свежие ежедневные файлы (билеты за 14 дней ->
  `tickets_to_history`; новые улетевшие вылеты добавить в table; кривые будущих вылетов -> `table.live`; файл доступности ->
  запомнить Total AU), вызвать `ensemble.recalibrate`, сохранить новую версию (идемпотентно по хешу файлов).
- `app/service.py`: `ForecastService` — держит (ensemble, table, critic), `predict(reis, flydate, current_booked, total_au, dtd) -> dict`
  в формате ответа API; `reload()`; `health() -> dict`; блокировка при перезагрузке (потокобезопасно).

### D. API, README, тесты (`app/main.py`, `app/schemas.py`, `README.md`, `requirements.txt`, `tests/`)
- FastAPI: `POST /predict` (формат запроса и ответа — из навыка flight-load-forecast, см. ниже), `GET /health`,
  `POST /retrain` (запускает полное обучение в фоне, один за раз, защищено заголовком `X-Admin-Token` из переменной
  окружения `FORECAST_ADMIN_TOKEN`; если переменная не задана — ретрейн с HTTP 403), `POST /incremental` (то же для дообучения).
  Валидация входа pydantic (flydate DD.MM.YYYY, числа >= 0, dtd 0..180); ошибки -> 422 с понятным текстом, никаких 500
  на плохом вводе; при отсутствии модели — 503 с текстом «модель ещё не обучена».
- Ответ: `{"reis","flydate","horizons":{"30d":{"pred","confidence"},"14d":..,"7d":..,"1_3d":..},"critic":{"ok","chosen_model","flags"}}`.
- README по-русски: что это, структура, установка, данные (форматы файлов), как обучить (синтетика и боевые файлы), как
  запустить API, пример curl для RMS (`/predict`, `/health`, `/retrain`), ночной ретрейн (cron / планировщик задач Windows),
  дневное дообучение, как читать метрики, ограничения (как достраивается кривая по запросу, утечки, что не делает).
- tests/: pytest — парсеры (кривые, AU, билеты без ПДн), признаки (нет утечки из будущего), критик (границы, NaN),
  ансамбль на малой синтетике (быстро, < 60 с всего), хранилище (идемпотентность), API через TestClient.
