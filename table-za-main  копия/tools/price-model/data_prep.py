"""Подготовка данных для модели «спрос от цены».

Источники (персональных данных в них нет — только рейс, даты, тариф, код тарифа):
  * shared/snapshot.json сайта КРАСАВИА — билеты из файла продаж (дата продажи, тариф, код тарифа)
    и строки загрузки (ёмкость AU, загрузка, спец. брони, статус);
  * SalesHistory.csv (Export-SalesHistory.ps1) — история по улетевшим вылетам (без цены по дням);
  * SalesTickets.csv (Export-SalesTickets.ps1, если выгружен) — та же история, но по билетам с тарифом.

Выход — папка data/ (не коммитится):
  tickets.csv      один билет = одна строка: flight, fly_date, deal_date, dtd, fare, rbd, basis, route
  departures.csv   один вылет = одна строка: flight, fly_date, route, cap (AU), seats (в продаже), load, status
  hist.csv         история по вылетам: flight, fly_date, tickets, revenue, avg_fare, curve (dtd → билеты)
  tickets_hist.csv (если дан SalesTickets.csv) билеты прошлых лет с тарифом и классом: как tickets.csv + refund_dtd, group, corp
  expected.csv     текущая модель (файл ожидаемой загрузки): cap, flight(основной), dtd, week → expected
                   прогноз к вылету текущей моделью = expected при dtd = 0 (ключ cap_class, base, 0, week)

Запуск:  python data_prep.py --snapshot ../../shared/snapshot.json --history SalesHistory.csv --out data
"""
import argparse
import json
import os
import re
from datetime import datetime

import pandas as pd

INFANT_RE = re.compile(r"/(IN|ID)\d")


def parse_date(s):
    try:
        return datetime.strptime(str(s).strip(), "%d.%m.%Y")
    except ValueError:
        return None


def clean_flight(s):
    n = re.sub(r"[^0-9]", "", str(s or ""))
    return "KV-" + n if n else ""


_BASE_SPECIAL = {151: 155, 351: 155, 355: 155, 455: 155, 152: 156, 352: 156, 356: 156, 456: 156,
                 261: 161, 262: 162, 253: 153, 254: 154, 273: 173, 274: 174, 325: 225, 326: 226, 347: 247, 348: 248}


def base_flight(f):
    """Основной номер рейса (доп. номера 3xx/4xx и т.п. → основной), как getBaseFlight на сайте."""
    n = int(re.sub(r"[^0-9]", "", str(f)) or 0)
    if n in _BASE_SPECIAL:
        return f"KV-{_BASE_SPECIAL[n]}"
    if 300 <= n <= 399:
        return f"KV-{n - 200}"
    if 400 <= n <= 499:
        return f"KV-{n - 300}"
    return clean_flight(f)


def cap_from_aircraft(code):
    """Ёмкость по типу ВС, как в файле ожидаемой загрузки: ATR-72 → 72, Як-42 → 120, иначе 46."""
    c = str(code or "").upper()
    if "AT7" in c or "ATR-72" in c:
        return 72
    if "YK2" in c or "ЯК-42" in c:
        return 120
    return 46


def week_of(d):
    """Номер недели для файла ожидаемой загрузки (как getWeekNumber на сайте, 1..52)."""
    j = datetime(d.year, 1, 1)
    mon = j - pd.Timedelta(days=6) if j.weekday() == 6 else j - pd.Timedelta(days=j.weekday())
    w = (d - mon).days // 7 + 1
    return max(1, min(52, w))


def rbd_of(basis):
    """Класс бронирования — первая буква кода тарифа (JOPOW → J)."""
    b = str(basis or "").strip().upper()
    return b[:1] if b[:1].isalpha() else "?"


def load_snapshot(path):
    with open(path, encoding="utf-8") as f:
        data = json.load(f)["data"]
    rows = []
    for key, lst in data["salesDetails"].items():
        fly_s, flight = key.split("|")
        fly = parse_date(fly_s)
        for t in lst:
            basis = t.get("basicFareStr") or ""
            if INFANT_RE.search(basis):
                continue  # младенцы без места
            deal = parse_date(t.get("dealDate"))
            if not fly or not deal:
                continue
            rows.append({
                "flight": clean_flight(flight), "fly_date": fly, "deal_date": deal,
                "dtd": (fly - deal).days, "fare": float(t.get("fare") or 0),
                "adj_fare": float(t.get("adjustedFare") or 0), "basis": basis, "rbd": rbd_of(basis),
            })
    tickets = pd.DataFrame(rows)
    deps = []
    for r in data["allData"]:
        fly = parse_date(r[1])
        if not fly:
            continue
        au = int(r[5] or 0)
        spec = int(r[8] or 0) if str(r[8]).strip().lstrip("-").isdigit() else 0
        deps.append({
            "flight": clean_flight(r[0]), "fly_date": fly, "route": r[3], "aircraft": r[4],
            "cap": au, "seats": max(0, au - spec), "load": int(r[6] or 0), "status": r[10],
        })
    departures = pd.DataFrame(deps).drop_duplicates(["flight", "fly_date"])
    closed = set(data.get("closedFlights") or [])
    departures["closed"] = [f"{d:%d.%m.%Y}|{f}" in closed for f, d in zip(departures.flight, departures.fly_date)]
    last = data.get("lastSalesUpdate")
    # Текущая модель (файл ожидаемой загрузки): ожидаемая загрузка по ёмкости, рейсу, дням до вылета и неделе года.
    exp = []
    for k, v in (data.get("expectedLoadData") or {}).items():
        cap, fl, dtd, wk = k.split("|")
        exp.append({"cap": int(cap), "flight": fl, "dtd": int(dtd), "week": int(wk), "expected": float(v)})
    expected = pd.DataFrame(exp)
    return tickets, departures, last, expected


def load_history(path):
    df = pd.read_csv(path, dtype=str, encoding="utf-8-sig")
    out = []
    for r in df.itertuples(index=False):
        fly = parse_date(r.FLYDATE)
        if not fly:
            continue
        tickets = int(r.TICKETS or 0)
        rev = float(r.REVENUE or 0)
        curve = {}
        for part in str(r.CURVE or "").split():
            m = re.match(r"^(-?\d+):(\d+)$", part)
            if m:
                curve[max(0, int(m.group(1)))] = curve.get(max(0, int(m.group(1))), 0) + int(m.group(2))
        out.append({
            "flight": clean_flight(r.REIS), "fly_date": fly, "route": f"{r.CITY1}-{r.CITY2}",
            "tickets": tickets, "refunded": int(r.REFUNDED or 0), "group": int(r.GROUP or 0), "corp": int(r.CORP or 0),
            "revenue": rev, "avg_fare": rev / tickets if tickets else None, "curve": json.dumps(curve),
        })
    return pd.DataFrame(out)


def load_ticket_history(path):
    """SalesTickets.csv (Export-SalesTickets.ps1): билеты прошлых периодов с тарифом и классом на момент покупки.
    Возвращённые билеты остаются (refund_dtd) — для спроса их можно учитывать как бронирования, для загрузки — нет."""
    df = pd.read_csv(path, dtype=str, encoding="utf-8-sig")
    out = pd.DataFrame({
        "flight": df.REIS.map(clean_flight),
        "fly_date": pd.to_datetime(df.FLYDATE, format="%d.%m.%Y", errors="coerce"),
        "deal_date": pd.to_datetime(df.DEALDATE, format="%d.%m.%Y", errors="coerce"),
        "dtd": pd.to_numeric(df.DTD, errors="coerce"),
        "fare": pd.to_numeric(df.NFARE, errors="coerce").fillna(0.0),
        "basis": df.BASICFARE.fillna(""),
        "rbd": df.RBD.fillna(""),
        "city_route": df.CITY1.fillna("") + "-" + df.CITY2.fillna(""),
        "refund_dtd": pd.to_numeric(df.REFUND_DTD, errors="coerce"),
        "group": pd.to_numeric(df.GROUP, errors="coerce").fillna(0).astype(int),
        "corp": pd.to_numeric(df.CORP, errors="coerce").fillna(0).astype(int),
    })
    out["adj_fare"] = out.fare
    return out.dropna(subset=["fly_date", "deal_date"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--snapshot", required=True)
    ap.add_argument("--history")
    ap.add_argument("--tickets-hist", help="SalesTickets.csv из Export-SalesTickets.ps1 (если выгружен)")
    ap.add_argument("--out", default="data")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    tickets, departures, last, expected = load_snapshot(a.snapshot)
    departures["base"] = departures.flight.map(base_flight)
    departures["cap_class"] = departures.aircraft.map(cap_from_aircraft)
    departures["week"] = departures.fly_date.map(week_of)
    expected.to_csv(os.path.join(a.out, "expected.csv"), index=False)
    route = departures.set_index(["flight", "fly_date"])["route"]
    tickets["route"] = [route.get((f, d), "") for f, d in zip(tickets.flight, tickets.fly_date)]
    tickets.to_csv(os.path.join(a.out, "tickets.csv"), index=False, date_format="%Y-%m-%d")
    departures.to_csv(os.path.join(a.out, "departures.csv"), index=False, date_format="%Y-%m-%d")
    with open(os.path.join(a.out, "meta.json"), "w", encoding="utf-8") as f:
        json.dump({"last_sales_update": last}, f)
    print(f"tickets {len(tickets)}, departures {len(departures)}, sales data as of {last}")
    if a.history:
        hist = load_history(a.history)
        hist.to_csv(os.path.join(a.out, "hist.csv"), index=False, date_format="%Y-%m-%d")
        print(f"history departures {len(hist)}")
    if a.tickets_hist:
        th = load_ticket_history(a.tickets_hist)
        th.to_csv(os.path.join(a.out, "tickets_hist.csv"), index=False, date_format="%Y-%m-%d")
        print(f"ticket history rows {len(th)}")


if __name__ == "__main__":
    main()
