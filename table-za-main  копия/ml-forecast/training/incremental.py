"""Ежедневное дообучение: свежие файлы -> таблица вылетов -> лёгкая перекалибровка ансамбля -> новая версия.

Что делает ``run``:
  1. билеты за 14 дней -> ``tickets_to_history`` (кривая и итог по вылету);
  2. вылеты, которые уже улетели, дописываются в таблицу (уникальность по (reis, flydate), свежая
     строка заменяет старую; оговорка про усечённые кривые — в ``absorb_daily``);
  3. кривые будущих вылетов -> ``table.live[(reis, flydate)]`` (неполная кривая накопленных продаж);
  4. Total AU из файла доступности запоминается в ``table.capacity_override[(reis, flydate)]``;
  5. ``ensemble.recalibrate(table, since)`` без полного ретрейна;
  6. сохранение новой версии (идемпотентно по хешу: родительская версия + файлы + параметры).

Запуск: ``python -m training.incremental --tickets Tickets_SALE_Last14Days.csv --availability avail.csv``.
Код возврата: 0 — успех (в том числе «версия уже есть»), 2 — плохие входные данные.
Значения персональных данных в логи и метаданные не попадают: билеты читает только ``load_tickets``.
"""
from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

import numpy as np
import pandas as pd

from data.features import FlightTable, build_flight_table
from data.parsers import (MAX_DTD, curve_to_cumulative, load_availability, load_sales_history, load_tickets,
                          tickets_to_history)
from training.store import ArtifactStore, InputError, ModelNotFoundError, hash_inputs

log = logging.getLogger("training.incremental")

DEFAULT_RECALIB_DAYS = 30     # по вылетам за сколько последних дней пересчитывать ошибки
DEFAULT_MIN_RATIO = 0.8       # свежая строка заменяет старую, если билетов не меньше 80% прежнего итога
LIVE_KEEP_DAYS = 3            # сколько дней после вылета держать «живую» кривую
CAP_KEEP_DAYS = 90            # сколько дней после вылета держать запомненный Total AU


# ---------------------------------------------------------------- чтение входов

def _check_file(path, what: str) -> Path:
    p = Path(path)
    if not p.is_file():
        raise InputError(f"Не найден файл {what}: «{p}»")
    return p


def read_tickets_history(paths) -> tuple[pd.DataFrame, pd.Timestamp | None]:
    """Файлы билетов -> строки в формате SalesHistory + «сегодня» по данным (последняя дата продажи).

    Если файлов несколько (окна по 14 дней перекрываются), для одного вылета берётся строка из
    более позднего файла: билеты из разных файлов не складываются, иначе перекрытие задвоило бы продажи.
    """
    frames, last_deal = [], None
    for p in paths:
        p = _check_file(p, "с билетами")
        try:
            t = load_tickets(p)
        except ValueError as e:
            raise InputError(f"Файл билетов «{p.name}» не распознан: {e}") from e
        if t.empty:
            log.warning("В файле билетов «%s» нет подходящих строк", p.name)
            continue
        deal = (t["flydate"] - pd.to_timedelta(t["dtd"], unit="D")).max()
        last_deal = deal if last_deal is None else max(last_deal, deal)
        frames.append(tickets_to_history(t))
        log.info("Билеты «%s»: %d билетов, %d вылетов", p.name, len(t), len(frames[-1]))
    if not frames:
        return tickets_to_history(pd.DataFrame(columns=["reis", "flydate", "city1", "city2", "od", "dtd",
                                                        "nfare", "group", "corp"])), last_deal
    hist = pd.concat(frames, ignore_index=True).drop_duplicates(["reis", "flydate"], keep="last")
    return hist.reset_index(drop=True), last_deal


# ---------------------------------------------------------------- подмешивание в таблицу

def _cap_for_new(table: FlightTable, new_df: pd.DataFrame) -> np.ndarray:
    """Потолок для новых вылетов: запомненный Total AU -> типичный по рейсу -> по направлению -> по билетам."""
    override = getattr(table, "capacity_override", {}) or {}
    old = table.df
    by_reis = old.groupby("reis")["cap"].agg(lambda s: s.iloc[-20:].median()) if len(old) else pd.Series(dtype=float)
    by_od = old.groupby("od")["cap"].agg(lambda s: s.iloc[-20:].median()) if len(old) else pd.Series(dtype=float)
    out = []
    for r in new_df.itertuples():
        c = override.get((r.reis, r.flydate))
        if c is None or not np.isfinite(c) or c <= 0:
            c = by_reis.get(r.reis, np.nan)
        if not np.isfinite(c):
            c = by_od.get(r.od, np.nan)
        if not np.isfinite(c):
            c = r.tickets
        out.append(max(float(c), float(r.tickets), 1.0))
    return np.array(out)


def merge_flown(table: FlightTable, new_hist: pd.DataFrame, min_ratio: float = DEFAULT_MIN_RATIO) -> dict:
    """Дописывает улетевшие вылеты в table (на месте). Возвращает счётчики added/replaced/kept_old.

    Ключ уникальности — (reis, flydate); свежая строка заменяет старую. Исключение: если у свежей
    строки билетов меньше ``min_ratio`` от прежнего итога, это признак усечённой кривой (файл за 14
    дней не видит ранних продаж) — старая полная строка остаётся (kept_old).
    """
    stats = {"added": 0, "replaced": 0, "kept_old": 0}
    if new_hist is None or new_hist.empty:
        return stats
    new_hist = new_hist.drop_duplicates(["reis", "flydate"], keep="last").reset_index(drop=True)
    nt = build_flight_table(new_hist)                      # кривые, dow, оценка cap
    nt.df["cap"] = _cap_for_new(table, nt.df)
    old = table.df
    old_idx = pd.MultiIndex.from_frame(old[["reis", "flydate"]])
    new_idx = pd.MultiIndex.from_frame(nt.df[["reis", "flydate"]])
    pos = old_idx.get_indexer(new_idx)                     # -1, если вылета ещё нет
    exists = pos >= 0
    accept = np.ones(len(nt.df), bool)
    if exists.any():
        old_t = old["tickets"].values[pos[exists]].astype(float)
        new_t = nt.df["tickets"].values[exists].astype(float)
        keep_old = new_t < min_ratio * old_t
        ex_idx = np.where(exists)[0]
        accept[ex_idx[keep_old]] = False
        stats["kept_old"] = int(keep_old.sum())
    replaced_old = np.zeros(len(old), bool)
    replaced_old[pos[exists & accept]] = True
    stats["replaced"] = int((exists & accept).sum())
    stats["added"] = int((~exists & accept).sum())
    if not accept.any():
        return stats

    df = pd.concat([old[~replaced_old], nt.df[accept]], ignore_index=True, sort=False)
    cum = np.vstack([table.cum[~replaced_old], nt.cum[accept]])
    order = np.lexsort((df["reis"].values.astype(str), df["flydate"].values.astype("datetime64[ns]")))
    table.df = df.iloc[order].reset_index(drop=True)
    table.cum = cum[order]
    return stats


def _daily(cum: np.ndarray) -> np.ndarray:
    return cum - np.append(cum[1:], 0.0)


def merge_live(table: FlightTable, future_hist: pd.DataFrame) -> int:
    """Кривые будущих вылетов -> table.live. Новый день продаж не уменьшает ранее известный (max по дням):
    так перекрывающиеся окна по 14 дней накапливают кривую, а повторная загрузка ничего не меняет."""
    n = 0
    if future_hist is None or future_hist.empty:
        return n
    for r in future_hist.itertuples():
        new_cum = curve_to_cumulative(r.curve, MAX_DTD)
        key = (r.reis, r.flydate)
        prev = table.live.get(key)
        if prev is not None and len(prev) == len(new_cum):
            daily = np.maximum(_daily(np.asarray(prev, float)), _daily(new_cum))
            new_cum = daily[::-1].cumsum()[::-1].copy()
        table.live[key] = new_cum
        n += 1
    return n


def remember_capacity(table: FlightTable, availability: pd.DataFrame | None) -> int:
    """Total AU из файла доступности -> table.capacity_override[(reis, flydate)] (поле создаётся на лету)."""
    if availability is None or availability.empty:
        return 0
    if not isinstance(getattr(table, "capacity_override", None), dict):
        setattr(table, "capacity_override", {})
    for reis, fd, au in zip(availability["reis"], availability["flydate"], availability["total_au"]):
        table.capacity_override[(reis, pd.Timestamp(fd))] = int(au)
    return len(availability)


def prune_state(table: FlightTable, today: pd.Timestamp) -> None:
    """Выбрасывает устаревшее: живые кривые улетевших вылетов и давние запомненные Total AU."""
    table.live = {k: v for k, v in table.live.items() if k[1] >= today - pd.Timedelta(days=LIVE_KEEP_DAYS)}
    ov = getattr(table, "capacity_override", None)
    if isinstance(ov, dict):
        lim = today - pd.Timedelta(days=CAP_KEEP_DAYS)
        table.capacity_override = {k: v for k, v in ov.items() if k[1] >= lim}


def absorb_daily(table: FlightTable, tickets_hist: pd.DataFrame | None = None, history: pd.DataFrame | None = None,
                 availability: pd.DataFrame | None = None, today=None,
                 min_ratio: float = DEFAULT_MIN_RATIO) -> dict:
    """Общая часть полного и дневного обучения: доступность, улетевшие вылеты, живые кривые.

    today: вылеты раньше этой даты считаются улетевшими. history — полноценные строки SalesHistory
    (дневной выгрузкой), они считаются улетевшими всегда, если flydate < today.
    """
    stats = {"capacity_rows": remember_capacity(table, availability)}
    parts = [x for x in (history, tickets_hist) if x is not None and len(x)]
    if not parts:
        return {**stats, "added": 0, "replaced": 0, "kept_old": 0, "live": 0}
    # если вылет есть и в SalesHistory, и в билетах, приоритет у SalesHistory (в ней полная кривая)
    allh = pd.concat(parts, ignore_index=True, sort=False)
    prio = np.concatenate([np.full(len(p), i) for i, p in enumerate(parts)])
    allh = allh.assign(_p=prio).sort_values("_p", kind="stable").drop_duplicates(["reis", "flydate"], keep="first")
    allh = allh.drop(columns="_p")
    today = pd.Timestamp(today).normalize() if today is not None else pd.Timestamp.now().normalize()
    flown = allh[allh["flydate"] < today]
    future = allh[allh["flydate"] >= today]
    stats.update(merge_flown(table, flown, min_ratio))
    stats["live"] = merge_live(table, future)
    prune_state(table, today)
    return stats


# ---------------------------------------------------------------- основной сценарий

def run(tickets=(), availability=None, history=None, out="artifacts", today=None,
        recalib_days: int = DEFAULT_RECALIB_DAYS, min_ratio: float = DEFAULT_MIN_RATIO,
        force: bool = False) -> dict:
    """Дообучение на свежих файлах. Возвращает {"version", "skipped", "stats", "metrics"}.

    tickets: путь или список путей к Tickets_SALE_Last14Days.csv; availability: файл доступности;
    history: необязательная дневная выгрузка SalesHistory (полные строки улетевших вылетов).
    Исключения: InputError (плохие входы), ModelNotFoundError (ещё нет полной версии).
    """
    if isinstance(tickets, (str, Path)):
        tickets = [tickets]
    tickets = [Path(t) for t in (tickets or [])]
    if not tickets and not availability and not history:
        raise InputError("Нет входных файлов: укажите --tickets, --availability или --history")
    files = {"tickets": tickets, "availability": [availability] if availability else [],
             "history": [history] if history else []}
    for role, what in (("tickets", "с билетами"), ("availability", "доступности"), ("history", "SalesHistory")):
        for p in files[role]:
            _check_file(p, what)

    store = ArtifactStore(out)
    parent = store.resolve_current()
    if parent is None:
        raise ModelNotFoundError("Нет обученной модели: сначала выполните полное обучение (python -m training.full_train)")

    today_arg = pd.Timestamp(today).normalize() if today is not None else None
    params = {"today": str(today_arg.date()) if today_arg is not None else None,
              "recalib_days": int(recalib_days), "min_ratio": float(min_ratio)}
    # хеш набора файлов + параметров (не зависит от родителя) и хеш версии (зависит от родителя)
    files_hash, described = hash_inputs(files, params)
    input_hash, _ = hash_inputs(files, params, extra=f"parent={parent}")
    parent_meta = store.read_metadata(parent)
    applied = list(parent_meta.get("applied_inputs") or [])
    if not force:
        existing = store.find_by_hash(input_hash)
        if existing is None and files_hash in applied:
            existing = parent          # эти файлы с этими параметрами уже учтены в текущей версии
        if existing:
            log.info("Версия уже есть: %s — те же файлы и параметры уже применены, дообучение не требуется", existing)
            return {"version": existing, "skipped": True, "stats": {}, "metrics": {}}

    ensemble, table, _ = store.load(parent)
    tickets_hist, last_deal = read_tickets_history(tickets)
    daily_hist = None
    if history:
        try:
            daily_hist = load_sales_history(history)
        except ValueError as e:
            raise InputError(f"Файл SalesHistory «{Path(history).name}» не распознан: {e}") from e
    avail = None
    if availability:
        try:
            avail = load_availability(availability)
        except ValueError as e:
            raise InputError(f"Файл доступности «{Path(availability).name}» не распознан: {e}") from e
        log.info("Доступность: %d строк (Total AU)", len(avail))

    if today_arg is None:       # «сегодня» по данным: последний день продаж в билетах, иначе системная дата
        today_arg = last_deal.normalize() if last_deal is not None else pd.Timestamp.now().normalize()
    stats = absorb_daily(table, tickets_hist, daily_hist, avail, today_arg, min_ratio)
    log.info("Дописано в таблицу: новых вылетов %d, заменено %d, оставлено прежних %d; живых кривых %d; "
             "всего вылетов %d", stats["added"], stats["replaced"], stats["kept_old"], stats["live"], len(table))
    if stats["kept_old"]:
        log.warning("У %d вылетов свежих билетов заметно меньше прежнего итога (усечённая кривая?) — "
                    "оставлены прежние строки", stats["kept_old"])

    since = today_arg - pd.Timedelta(days=int(recalib_days))
    rec = ensemble.recalibrate(table, since)
    log.info("Перекалибровка по вылетам с %s завершена", since.date())

    meta = {
        "kind": "incremental", "parent_version": parent, "input_hash": input_hash, "inputs": described,
        "params": params, "today": str(today_arg.date()), "applied_inputs": (applied + [files_hash])[-50:],
        "full_trained_utc": parent_meta.get("full_trained_utc") or parent_meta.get("created_utc"),
        "metrics": parent_meta.get("metrics", {}),       # метрики полного обучения остаются «паспортом» модели
        "recalibration": rec, "stats": stats,
        "ensemble_info": _safe_info(ensemble),
    }
    version = store.save(ensemble, table, meta, force=force)
    return {"version": version, "skipped": False, "stats": stats, "metrics": rec}


def _safe_info(ensemble) -> dict | None:
    try:
        return ensemble.info()
    except Exception:
        return None


# ---------------------------------------------------------------- CLI

def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="python -m training.incremental",
                                 description="Дневное дообучение: свежие файлы -> перекалибровка -> новая версия.")
    ap.add_argument("--tickets", action="append", default=[], help="Tickets_SALE_Last14Days.csv (можно несколько раз)")
    ap.add_argument("--availability", help="файл доступности (Total AU)")
    ap.add_argument("--history", help="дневная выгрузка SalesHistory с улетевшими вылетами (необязательно)")
    ap.add_argument("--out", default="artifacts", help="каталог с версиями модели (по умолчанию artifacts)")
    ap.add_argument("--today", help="«сегодня» (ГГГГ-ММ-ДД); по умолчанию — последний день продаж в билетах")
    ap.add_argument("--recalib-days", type=int, default=DEFAULT_RECALIB_DAYS,
                    help="по вылетам за сколько последних дней пересчитывать ошибки")
    ap.add_argument("--force", action="store_true", help="создать версию, даже если такая уже есть")
    return ap


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    try:
        res = run(tickets=args.tickets, availability=args.availability, history=args.history, out=args.out,
                  today=args.today, recalib_days=args.recalib_days, force=args.force)
    except (InputError, ModelNotFoundError) as e:
        log.error("%s", e)
        print(f"Ошибка входных данных: {e}", file=sys.stderr)
        return 2
    print(("Версия уже есть: " if res["skipped"] else "Сохранена версия: ") + res["version"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
