"""Парсеры входных файлов: история продаж, билеты, файл доступности (Total AU).

Личные данные пассажиров (ФИО, PNR, контакты, дата рождения) не читаются вообще:
у файлов с билетами берутся только нужные колонки (usecols).
"""
from __future__ import annotations

import io
import logging
import re
from pathlib import Path

import numpy as np
import pandas as pd

log = logging.getLogger(__name__)

MAX_DTD = 180            # дальше 180 дней до вылета кривую не храним
DATE_FORMATS = ("%d.%m.%Y", "%Y-%m-%d", "%d/%m/%Y", "%d.%m.%y", "%Y%m%d")


# ---------------------------------------------------------------- кривая

def parse_curve(s, max_dtd: int = MAX_DTD) -> dict[int, int]:
    """'0:1 1:5' -> {0: 1, 1: 5}. Ключ — дней до вылета, значение — билетов, проданных в тот день.

    Пустое значение, NaN и битые куски не ломают разбор: битый кусок пропускается.
    Повторы одного дня складываются. Дни больше max_dtd сворачиваются в max_dtd.
    """
    out: dict[int, int] = {}
    if s is None or (isinstance(s, float) and np.isnan(s)):
        return out
    for tok in str(s).replace(",", " ").replace(";", " ").split():
        d, sep, n = tok.partition(":")
        if not sep:
            continue
        try:
            di, ni = int(d), int(float(n))
        except ValueError:
            continue
        if di < 0 or ni <= 0:
            continue
        di = min(di, max_dtd)
        out[di] = out.get(di, 0) + ni
    return out


def curve_to_cumulative(curve: dict[int, int] | str, max_dtd: int = MAX_DTD) -> np.ndarray:
    """cum[h] = сколько билетов продано к моменту «h дней до вылета» (продажи дней d >= h).

    cum[0] — итог на вылете; cum[max_dtd] — продано за самый ранний период.
    Массив длиной max_dtd + 1, не возрастает по h.
    """
    if not isinstance(curve, dict):
        curve = parse_curve(curve, max_dtd)
    daily = np.zeros(max_dtd + 1)
    for d, n in curve.items():
        daily[min(d, max_dtd)] += n
    return daily[::-1].cumsum()[::-1].copy()


def cumulative_to_curve(cum: np.ndarray) -> str:
    """Обратное преобразование: cum[h] -> строка 'd:n' (по возрастанию d)."""
    cum = np.asarray(cum, dtype=float)
    daily = cum - np.append(cum[1:], 0.0)
    return " ".join(f"{d}:{int(round(n))}" for d, n in enumerate(daily) if round(n) > 0)


# ---------------------------------------------------------------- даты и имена

def _norm(name: str) -> str:
    return re.sub(r"[^a-z0-9а-я]", "", str(name).lower().replace("﻿", ""))


def parse_dates(s: pd.Series) -> pd.Series:
    """Даты DD.MM.YYYY / YYYY-MM-DD / ... -> datetime64 (нормализованные до дня). Не распознанное -> NaT."""
    s = s.astype(str).str.strip().str.slice(0, 10)
    out = pd.Series(pd.NaT, index=s.index, dtype="datetime64[ns]")
    for fmt in DATE_FORMATS:
        todo = out.isna()
        if not todo.any():
            break
        out[todo] = pd.to_datetime(s[todo], format=fmt, errors="coerce")
    return out.dt.normalize()


def _read_csv(path_or_buf, **kw) -> pd.DataFrame:
    """CSV с автоопределением разделителя (, ; таб) и BOM."""
    if isinstance(path_or_buf, (str, Path)):
        raw = Path(path_or_buf).read_bytes()
    elif hasattr(path_or_buf, "read"):
        raw = path_or_buf.read()
        raw = raw.encode("utf-8") if isinstance(raw, str) else raw
    else:
        raise TypeError("нужен путь или файловый объект")
    text = raw.decode("utf-8-sig", errors="replace")
    head = text.splitlines()[0] if text else ""
    sep = max((",", ";", "\t"), key=head.count) if head else ","
    return pd.read_csv(io.StringIO(text), sep=sep, dtype=str, keep_default_na=False, **kw)


def _num(s: pd.Series) -> pd.Series:
    return pd.to_numeric(s.astype(str).str.replace(r"[^\d,.\-]", "", regex=True).str.replace(",", ".", regex=False),
                         errors="coerce")


# ---------------------------------------------------------------- SalesHistory.csv

def load_sales_history(path_or_buf) -> pd.DataFrame:
    """SalesHistory.csv -> по строке на вылет (reis, flydate).

    Колонки результата: reis, flydate, city1, city2, od, tickets, refunded, group, corp, revenue, curve.
    Повторы (reis, flydate) схлопываются (берётся последняя строка) — загрузка идемпотентна.
    Строки без рейса/даты или с билетами < 0 отбрасываются; число отброшенных пишется в лог.
    """
    raw = _read_csv(path_or_buf)
    cols = {_norm(c): c for c in raw.columns}

    def col(*names):
        for n in names:
            if _norm(n) in cols:
                return raw[cols[_norm(n)]]
        return None

    reis, fd = col("REIS", "flight"), col("FLYDATE", "date")
    if reis is None or fd is None:
        raise ValueError("В SalesHistory нет колонок REIS и FLYDATE")
    df = pd.DataFrame({
        "reis": reis.str.strip().str.upper(),
        "flydate": parse_dates(fd),
        "city1": (col("CITY1") if col("CITY1") is not None else pd.Series("", index=raw.index)).str.strip().str.upper(),
        "city2": (col("CITY2") if col("CITY2") is not None else pd.Series("", index=raw.index)).str.strip().str.upper(),
    })
    for tgt, names in (("tickets", ("TICKETS",)), ("refunded", ("REFUNDED",)), ("group", ("GROUP",)),
                       ("corp", ("CORP",)), ("revenue", ("REVENUE",))):
        c = col(*names)
        df[tgt] = _num(c) if c is not None else np.nan
    c = col("CURVE")
    df["curve"] = c.str.strip() if c is not None else ""
    # если билетов нет в явном виде — берём сумму по кривой
    csum = df["curve"].map(lambda s: sum(parse_curve(s).values()))
    df["tickets"] = df["tickets"].fillna(csum)
    for k in ("refunded", "group", "corp"):
        df[k] = df[k].fillna(0)
    df["revenue"] = df["revenue"].fillna(0)
    n0 = len(df)
    df = df[(df["reis"] != "") & df["flydate"].notna() & (df["tickets"] >= 0)]
    df = df.drop_duplicates(["reis", "flydate"], keep="last")
    if len(df) < n0:
        log.warning("SalesHistory: отброшено %d строк (пустой рейс/дата, дубли)", n0 - len(df))
    df["od"] = df["city1"] + "-" + df["city2"]
    return df.sort_values(["flydate", "reis"]).reset_index(drop=True)


# ---------------------------------------------------------------- билеты (без персональных данных)

_TICKET_USECOLS = {"flydate", "dealdate", "reis", "city1", "city2", "nfare", "fare", "dtd", "rbd", "type",
                   "group", "corp"}   # НЕ читаем: FIO, PNR, CONTACTS, BIRTH_DATE и т.п.


def load_tickets(path_or_buf) -> pd.DataFrame:
    """SalesTickets.csv / Tickets_SALE_Last14Days.csv -> по строке на билет, только безопасные поля.

    Колонки: reis, flydate, city1, city2, dtd, nfare, rbd, group, corp.
    dtd берётся из файла, а если его нет — считается как FLYDATE − DEALDATE.
    Билеты с типом возврата и нулевым/отрицательным тарифом не считаются платными продажами
    только если их тип явно помечен REFUND; тариф 0 остаётся (его фильтруют выше по необходимости).
    """
    raw = _read_csv(path_or_buf, usecols=lambda c: _norm(c) in _TICKET_USECOLS)
    raw.columns = [_norm(c) for c in raw.columns]
    if "reis" not in raw or "flydate" not in raw:
        raise ValueError("В файле билетов нет колонок REIS и FLYDATE")
    out = pd.DataFrame({"reis": raw["reis"].str.strip().str.upper(), "flydate": parse_dates(raw["flydate"])})
    for k in ("city1", "city2"):
        out[k] = raw[k].str.strip().str.upper() if k in raw else ""
    if "dtd" in raw:
        out["dtd"] = _num(raw["dtd"])
    elif "dealdate" in raw:
        out["dtd"] = (out["flydate"] - parse_dates(raw["dealdate"])).dt.days
    else:
        raise ValueError("В файле билетов нет ни DTD, ни DEALDATE")
    nf = raw["nfare"] if "nfare" in raw else raw.get("fare")
    out["nfare"] = _num(nf) if nf is not None else np.nan
    out["rbd"] = raw["rbd"].str.strip().str.upper() if "rbd" in raw else ""
    for k in ("group", "corp"):
        out[k] = _num(raw[k]).fillna(0) if k in raw else 0.0
    if "type" in raw:
        out = out[~raw["type"].str.upper().str.contains("REFUND|RFND|ВОЗВРАТ", regex=True)]
    out = out[out["flydate"].notna() & out["dtd"].notna() & (out["reis"] != "")]
    out["dtd"] = out["dtd"].clip(lower=0).astype(int)
    out["od"] = out["city1"] + "-" + out["city2"]
    return out.reset_index(drop=True)


def tickets_to_history(tickets: pd.DataFrame, paid_only: bool = True) -> pd.DataFrame:
    """Билеты -> строки в формате SalesHistory (кривая, итог, выручка). paid_only: только NFARE > 0."""
    t = tickets
    if paid_only and t["nfare"].notna().any():
        t = t[t["nfare"] > 0]
    if t.empty:
        return pd.DataFrame(columns=["reis", "flydate", "city1", "city2", "od", "tickets", "refunded",
                                     "group", "corp", "revenue", "curve"])
    rows = []
    for (reis, fd), g in t.groupby(["reis", "flydate"]):
        daily = g.groupby(g["dtd"].clip(upper=MAX_DTD)).size()
        curve = " ".join(f"{d}:{n}" for d, n in daily.sort_index().items())
        rows.append({"reis": reis, "flydate": fd, "city1": g["city1"].iloc[0], "city2": g["city2"].iloc[0],
                     "od": g["od"].iloc[0], "tickets": len(g), "refunded": 0,
                     "group": int(g["group"].max()), "corp": int(g["corp"].max()),
                     "revenue": float(g["nfare"].sum(skipna=True)), "curve": curve})
    return pd.DataFrame(rows)


# ---------------------------------------------------------------- файл доступности (Total AU)

_AU_ALIASES = {
    "reis": ("reis", "flight", "flt", "flightno", "рейс"),
    "flydate": ("flydate", "date", "depdate", "departure", "flightdate", "дата", "датавылета"),
    "total_au": ("totalau", "au", "authorization", "authorized", "capacity", "cap", "мест", "всегомест"),
    "seg_total": ("totalsegbkd", "segtotal", "segbkdtotal", "totalseg"),
    "seg_free": ("freesegbkd", "free", "segfree", "avail", "available", "свободно"),
    "seg_booked": ("segbkd", "booked", "bkd", "sold", "продано"),
    "config": ("config", "configuration", "конфигурация", "layout"),
}


def _first_int(x) -> float:
    m = re.search(r"\d+", str(x))
    return float(m.group()) if m else np.nan


def load_availability(path_or_buf) -> pd.DataFrame:
    """Ежедневный файл доступности -> reis, flydate, total_au, seg_booked, seg_free, config.

    Названия колонок распознаются гибко (Total AU / TotalAU / AU, Free SegBkd, Total SegBkd, Config ...).
    Total AU — жёсткий потолок вместимости. Если Total AU нет, но есть Total SegBkd или (booked + free),
    потолок восстанавливается из них; если нет и этого — строка отбрасывается.
    Берётся только цифровая часть («Y180» -> 180). Повторы (reis, flydate) -> последняя строка.
    """
    raw = _read_csv(path_or_buf)
    norm = {_norm(c): c for c in raw.columns}

    def pick(key):
        for a in _AU_ALIASES[key]:
            if a in norm:
                return raw[norm[a]]
        return None

    reis, fd = pick("reis"), pick("flydate")
    if reis is None or fd is None:
        raise ValueError("В файле доступности нет колонок рейса и даты")
    df = pd.DataFrame({"reis": reis.str.strip().str.upper(), "flydate": parse_dates(fd)})
    au, st, sf, sb, cfg = pick("total_au"), pick("seg_total"), pick("seg_free"), pick("seg_booked"), pick("config")
    df["seg_free"] = sf.map(_first_int) if sf is not None else np.nan
    df["seg_booked"] = sb.map(_first_int) if sb is not None else np.nan
    df["config"] = cfg.str.strip() if cfg is not None else ""
    cap = au.map(_first_int) if au is not None else pd.Series(np.nan, index=df.index)
    if st is not None:
        cap = cap.fillna(st.map(_first_int))
    cap = cap.fillna(df["seg_booked"] + df["seg_free"])
    df["total_au"] = cap
    n0 = len(df)
    df = df[(df["reis"] != "") & df["flydate"].notna() & df["total_au"].notna() & (df["total_au"] > 0)]
    df = df.drop_duplicates(["reis", "flydate"], keep="last")
    if len(df) < n0:
        log.warning("Доступность: отброшено %d строк без рейса, даты или Total AU", n0 - len(df))
    return df.reset_index(drop=True)
