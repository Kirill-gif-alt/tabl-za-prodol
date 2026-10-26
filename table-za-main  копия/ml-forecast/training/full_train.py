"""Полное обучение: история продаж -> таблица вылетов -> ансамбль -> новая версия в хранилище.

Запуск::

    python -m training.full_train --history SalesHistory.csv [--availability avail.csv] \\
        [--tickets Tickets_SALE_Last14Days.csv ...] [--out artifacts] [--force] [--valid-frac 0.15]
    python -m training.full_train --synthetic          # демо без боевых файлов

Код возврата: 0 — успех (в том числе «версия уже есть»), 2 — плохие входные данные
(понятный текст по-русски), 1 — непредвиденный сбой.
Значения персональных данных в логи и метаданные не попадают: билеты читаются только через
``data.parsers.load_tickets`` (она не читает ФИО, PNR, контакты), в логи идут лишь счётчики и метрики.
"""
from __future__ import annotations

import argparse
import logging
import sys
import time
from datetime import datetime, timezone
from fnmatch import fnmatch
from pathlib import Path

import pandas as pd

from data.features import FlightTable, build_flight_table
from data.parsers import load_availability, load_sales_history
from training.incremental import absorb_daily, read_tickets_history
from training.store import ArtifactStore, InputError, hash_inputs

log = logging.getLogger("training.full_train")

MIN_FLIGHTS = 30               # меньше вылетов обучать бессмысленно
SYNTH_START, SYNTH_END = "2024-01-01", "2025-06-30"


# ---------------------------------------------------------------- чтение входов

def _resolve_path(path, patterns, what):
    """Если указана папка, находит в ней нужный файл по маске (SalesHistory*.csv и т.п.).

    Несколько подходящих — берём точное имя, иначе самый свежий по дате изменения. Нет ни одного — понятная ошибка
    со списком CSV, которые в папке есть (только имена файлов).
    """
    p = Path(str(path).strip().strip('"'))
    if not p.is_dir():
        return str(p)
    csvs = sorted(f for f in p.iterdir() if f.is_file() and f.suffix.lower() == ".csv")
    hits = [f for f in csvs if any(fnmatch(f.name.lower(), pat) for pat in patterns)]
    if not hits:
        seen = ", ".join(f.name for f in csvs[:8]) or "CSV-файлов нет"
        raise InputError(f"В папке «{p}» нет файла {what}. Ищу по маске {', '.join(patterns)}. В папке: {seen}")
    exact = [f for f in hits if f.name.lower() == patterns[0].replace("*", "")]
    pick = exact[0] if exact else max(hits, key=lambda f: f.stat().st_mtime)
    if len(hits) > 1:
        log.warning("В папке «%s» несколько подходящих файлов %s, беру «%s»", p, what, pick.name)
    return str(pick)


def _read_history(path) -> pd.DataFrame:
    p = Path(path)
    if not p.is_file():
        raise InputError(f"Не найден файл истории продаж: «{p}»")
    try:
        return load_sales_history(p)
    except ValueError as e:
        raise InputError(f"Файл истории «{p.name}» не распознан: {e}") from e
    except Exception as e:      # битая кодировка, пустой файл и т.п.
        raise InputError(f"Не удалось прочитать файл истории «{p.name}»: {e}") from e


def _read_availability(path) -> pd.DataFrame:
    p = Path(path)
    if not p.is_file():
        raise InputError(f"Не найден файл доступности: «{p}»")
    try:
        return load_availability(p)
    except ValueError as e:
        raise InputError(f"Файл доступности «{p.name}» не распознан: {e}") from e
    except Exception as e:
        raise InputError(f"Не удалось прочитать файл доступности «{p.name}»: {e}") from e


# ---------------------------------------------------------------- метрики в виде таблицы

def format_metrics(metrics: dict) -> str:
    """Таблица MAE/MAPE по горизонтам и моделям для лога."""
    lines = [f"{'горизонт':<8}{'модель':<16}{'MAE':>9}{'MAPE':>10}{'n':>8}"]
    for hz, per in metrics.items():
        for name, m in per.items():
            if isinstance(m, dict):
                mae, mape, n = m.get("mae"), m.get("mape"), m.get("n")
            else:                      # _baseline_booked может быть просто числом MAE
                mae, mape, n = m, None, None
            fmt = lambda v, f: ("-" if v is None or v != v else format(v, f))   # noqa: E731
            lines.append(f"{hz:<8}{name:<16}{fmt(mae, '.2f'):>9}{fmt(mape, '.3f'):>10}"
                         f"{fmt(n, 'd') if isinstance(n, int) else '-':>8}")
    return "\n".join(lines)


# ---------------------------------------------------------------- основной сценарий

def run(history=None, availability=None, tickets=(), synthetic: bool = False, out="artifacts", force: bool = False,
        valid_frac: float = 0.15, seed: int = 0, today=None, synthetic_start: str = SYNTH_START,
        synthetic_end: str = SYNTH_END, ensemble_factory=None) -> dict:
    """Полное обучение. Возвращает {"version", "skipped", "metrics", "n_flights"}.

    Можно вызывать из API. ``ensemble_factory(seed) -> ансамбль`` — для тестов; по умолчанию
    models.ensemble.EnsembleForecaster. Плохие входы -> InputError.
    """
    t0 = time.time()
    if isinstance(tickets, (str, Path)):
        tickets = [tickets]
    tickets = [Path(t) for t in (tickets or [])]
    if not (0.0 < float(valid_frac) < 0.5):
        raise InputError(f"valid-frac должен быть в диапазоне (0; 0.5), получено {valid_frac}")
    if not history and not tickets and not synthetic:
        raise InputError("Нет входных данных: укажите --history (и при желании --availability, --tickets) "
                         "или --synthetic для демо на выдуманных данных")
    if history:
        history = _resolve_path(history, ("saleshistory.csv", "saleshistory*.csv", "*history*.csv"), "истории продаж")
    tickets = [_resolve_path(t, ("tickets_sale_last14days*.csv", "*tickets*.csv"), "с билетами") for t in (tickets or ())]
    if history and synthetic:
        log.warning("Указаны и --history, и --synthetic: синтетика игнорируется")
        synthetic = False

    for role, paths, what in (("history", [history] if history else [], "истории продаж"),
                              ("availability", [availability] if availability else [], "доступности"),
                              ("tickets", tickets, "с билетами")):
        for p in paths:
            if not Path(p).is_file():
                raise InputError(f"Не найден файл {what}: «{p}»")
    files = {"history": [history] if history else [], "availability": [availability] if availability else [],
             "tickets": tickets}
    today_arg = pd.Timestamp(today).normalize() if today is not None else None
    params = {"valid_frac": float(valid_frac), "seed": int(seed),
              "today": str(today_arg.date()) if today_arg is not None else None,
              "synthetic": ({"start": str(synthetic_start), "end": str(synthetic_end)} if synthetic else None)}
    input_hash, described = hash_inputs(files, params)       # заодно проверяет, что файлы читаются

    store = ArtifactStore(out)
    if not force:
        existing = store.find_by_hash(input_hash)
        if existing:
            log.info("Версия уже есть: %s — входные файлы и параметры те же, обучение пропущено (--force обучит заново)",
                     existing)
            return {"version": existing, "skipped": True, "metrics": {}, "n_flights": None}

    # ---- данные
    if history:
        hist = _read_history(history)
        log.info("История продаж: %d вылетов (%s — %s)", len(hist),
                 hist["flydate"].min().date() if len(hist) else "-", hist["flydate"].max().date() if len(hist) else "-")
    elif synthetic:
        from data.synthetic import make_history
        log.info("Режим --synthetic: выдуманные данные (%s — %s)", synthetic_start, synthetic_end)
        hist = make_history(start=synthetic_start, end=synthetic_end, seed=seed + 7)
    else:
        hist = None                  # только билеты: история восстанавливается из них
    avail = _read_availability(availability) if availability else None
    tickets_hist, last_deal = read_tickets_history(tickets) if tickets else (None, None)
    if hist is None:
        if tickets_hist is None or tickets_hist.empty:
            raise InputError("Из файлов билетов не получилось собрать ни одного вылета")
        # только билеты: улетевшие вылеты становятся историей, будущие пойдут в живые кривые
        cut = (last_deal.normalize() if last_deal is not None else pd.Timestamp.now().normalize())
        hist = tickets_hist[tickets_hist["flydate"] < cut]
        tickets_hist = tickets_hist[tickets_hist["flydate"] >= cut]
    if len(hist) < MIN_FLIGHTS:
        raise InputError(f"Слишком мало вылетов для обучения: {len(hist)} (нужно хотя бы {MIN_FLIGHTS}). "
                         "Проверьте файл истории и формат дат (ДД.ММ.ГГГГ).")

    # ---- таблица вылетов
    table: FlightTable = build_flight_table(hist, avail)
    if today_arg is None:
        today_arg = last_deal.normalize() if last_deal is not None else None
    if today_arg is not None or avail is not None or (tickets_hist is not None and len(tickets_hist)):
        absorb_daily(table, tickets_hist, None, avail, today_arg if today_arg is not None else pd.Timestamp.now().normalize())
    if len(table) < MIN_FLIGHTS:
        raise InputError(f"Слишком мало вылетов для обучения: {len(table)} (нужно хотя бы {MIN_FLIGHTS})")
    log.info("Таблица вылетов: %d, потолок вместимости из файла доступности: %s",
             len(table), "да" if avail is not None else "нет (оценка по истории)")

    # ---- обучение
    if ensemble_factory is None:
        try:
            from models.ensemble import EnsembleForecaster
        except ImportError as e:
            raise RuntimeError(f"Не найден модуль ансамбля models.ensemble: {e}") from e
        ensemble_factory = lambda s: EnsembleForecaster(seed=s)    # noqa: E731
    ensemble = ensemble_factory(seed)
    metrics = ensemble.fit(table, valid_frac=valid_frac)
    log.info("Метрики на проверочной части (по времени):\n%s", format_metrics(metrics))

    meta = {
        "kind": "full", "input_hash": input_hash, "inputs": described, "params": params,
        "metrics": metrics, "full_trained_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "train_seconds": round(time.time() - t0, 1),
    }
    try:
        meta["ensemble_info"] = ensemble.info()
    except Exception:
        pass
    version = store.save(ensemble, table, meta, force=force)
    log.info("Готово за %.1f с, версия %s", time.time() - t0, version)
    return {"version": version, "skipped": False, "metrics": metrics, "n_flights": len(table)}


# ---------------------------------------------------------------- CLI

def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="python -m training.full_train",
                                 description="Полное обучение ансамбля прогноза загрузки рейсов.")
    ap.add_argument("--history", help="SalesHistory.csv — история продаж по вылетам")
    ap.add_argument("--availability", help="файл доступности (Total AU)")
    ap.add_argument("--tickets", action="append", default=[], help="файл билетов (можно несколько раз)")
    ap.add_argument("--synthetic", action="store_true", help="обучить на выдуманных данных (демо)")
    ap.add_argument("--synthetic-start", default=SYNTH_START, help="начало синтетики (ГГГГ-ММ-ДД)")
    ap.add_argument("--synthetic-end", default=SYNTH_END, help="конец синтетики (ГГГГ-ММ-ДД)")
    ap.add_argument("--out", default="artifacts", help="каталог с версиями модели (по умолчанию artifacts)")
    ap.add_argument("--force", action="store_true", help="обучить заново, даже если версия с такими входами уже есть")
    ap.add_argument("--valid-frac", type=float, default=0.15, help="доля последних по времени данных для проверки")
    ap.add_argument("--seed", type=int, default=0, help="зерно случайных чисел")
    ap.add_argument("--today", help="«сегодня» (ГГГГ-ММ-ДД); по умолчанию — последний день продаж в билетах")
    return ap


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    try:
        res = run(history=args.history, availability=args.availability, tickets=args.tickets,
                  synthetic=args.synthetic, out=args.out, force=args.force, valid_frac=args.valid_frac,
                  seed=args.seed, today=args.today, synthetic_start=args.synthetic_start,
                  synthetic_end=args.synthetic_end)
    except InputError as e:
        log.error("%s", e)
        print(f"Ошибка входных данных: {e}", file=sys.stderr)
        return 2
    except Exception:
        log.exception("Обучение завершилось сбоем")
        return 1
    print(("Версия уже есть: " if res["skipped"] else "Сохранена версия: ") + res["version"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
