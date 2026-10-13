"""Где RMS выбирает цену и какой потолок у субсидируемых рейсов.

Правило владельца: цену выбирает RMS на всех МЕЖРЕГИОНАЛЬНЫХ направлениях, а из краевых — на Богучанах,
Мотыгино и Кодинске. На субсидируемом рейсе продавать выше предельного (субсидированного) тарифа нельзя:
лестница цен обрезается потолком. Остальные краевые направления — вне RMS.

Источники (те же, что на сайте):
  js/routes.js  (рейс → «Город А — Город Б»), js/cities.js (списки краевых / межрегиональных городов);
  shared/subsidy-fares.json — предельные тарифы (взрослый, детский) по рейсам («Справочник» → «Тарифы субсидии»);
  shared/subsidy-ref.json  — периоды КОММЕРЦИИ по рейсам (в эти даты субсидии нет, потолка нет).
Если справочника тарифов нет, потолок можно задать файлом caps.csv (flight,cap) — иначе рейс считается
коммерческим и это печатается как предупреждение (не выдумываем потолок).
"""
import json
import os
import re

import pandas as pd

from data_prep import base_flight, parse_date

SITE = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
KRAI_IN_RMS = {"богучаны", "мотыгино", "кодинск"}


def _js_list(text, name):
    m = re.search(name + r"\s*:\s*\[(.*?)\]", text, re.S)
    return [s.strip().lower().replace("ё", "е") for s in re.findall(r"'([^']+)'", m.group(1))] if m else []


def load_geo(site=SITE):
    cities = open(os.path.join(site, "js", "cities.js"), encoding="utf-8").read()
    routes = open(os.path.join(site, "js", "routes.js"), encoding="utf-8").read()
    alias = dict((a.lower(), b.lower()) for a, b in re.findall(r"'([^']+)'\s*:\s*'([^']+)'", cities.split("CITY_ALIASES")[1]))
    krai, inter = set(_js_list(cities, "KRAI_CITIES")), set(_js_list(cities, "INTERREGIONAL_CITIES"))
    dirs = {}
    for fl, d in re.findall(r"'(KV-\d+)'\s*:\s*'([^']+)'", routes):
        parts = [alias.get(p.strip().lower(), p.strip().lower()).replace("ё", "е") for p in re.split(r"\s+[—-]\s+", d)]
        dirs[fl] = parts
    return dirs, krai, inter


def route_type(flight, geo):
    dirs, krai, inter = geo
    cs = dirs.get(base_flight(flight)) or dirs.get(flight) or []
    if any(c in inter for c in cs):
        return "interregional"
    if any(c in krai for c in cs):
        return "krai"
    return "unknown"


def in_rms(flight, geo):
    """RMS выбирает цену: межрегиональные + Богучаны, Мотыгино, Кодинск."""
    cs = (geo[0].get(base_flight(flight)) or geo[0].get(flight) or [])
    return route_type(flight, geo) == "interregional" or any(c in KRAI_IN_RMS for c in cs)


def load_caps(site=SITE, caps_csv=None):
    """Потолок тарифа по основному номеру рейса: {flight: adult_cap} и коммерческие периоды {flight: [(from,to)]}."""
    caps, commercial = {}, {}
    p = os.path.join(site, "shared", "subsidy-fares.json")
    if os.path.exists(p):
        for e in (json.load(open(p, encoding="utf-8")).get("entries") or []):
            if e.get("mode", "limit") != "limit" or not e.get("adult"):
                continue
            for f in e.get("flights") or []:
                caps[base_flight(f)] = float(e["adult"])
    if caps_csv and os.path.exists(caps_csv):
        for r in pd.read_csv(caps_csv).itertuples():
            caps[base_flight(r.flight)] = float(r.cap)
    p = os.path.join(site, "shared", "subsidy-ref.json")
    if os.path.exists(p):
        for fl, lst in (json.load(open(p, encoding="utf-8")).get("periods") or {}).items():
            for it in (lst if isinstance(lst, list) else []):
                a, b = parse_date(it.get("from")), parse_date(it.get("to"))
                if a and b:
                    commercial.setdefault(base_flight(fl), []).append((a, b))
    return caps, commercial


def cap_for(flight, fly_date, caps, commercial):
    """Предельный тариф на этот вылет или None (коммерческий рейс / коммерческий период / потолок не задан)."""
    b = base_flight(flight)
    if b not in caps:
        return None
    if any(a <= fly_date <= z for a, z in commercial.get(b, [])):
        return None
    return caps[b]


def apply_cap(prices, cap):
    """Лестница цен под потолком; если все классы выше потолка — продаётся по потолку."""
    if cap is None:
        return list(prices)
    ok = [p for p in prices if p <= cap + 0.5]
    return ok or [float(cap)]


if __name__ == "__main__":
    geo = load_geo()
    caps, com = load_caps(caps_csv=os.environ.get("PM_CAPS"))
    for fl in sorted(geo[0], key=lambda f: int(f[3:])):
        print(fl, " — ".join(geo[0][fl]), route_type(fl, geo), "RMS" if in_rms(fl, geo) else "вне RMS",
              f"потолок {caps[fl]:.0f}" if fl in caps else "")
    if not caps:
        print("\nВНИМАНИЕ: справочник предельных тарифов (shared/subsidy-fares.json) не найден и PM_CAPS не задан — "
              "потолки не применяются. Выгрузите справочник с сайта или задайте caps.csv (flight,cap).")
