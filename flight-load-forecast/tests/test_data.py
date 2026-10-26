"""Тесты слоя данных: парсеры, признаки (в том числе защита от утечки будущего), кадры для прогноза."""
from __future__ import annotations

import io

import numpy as np
import pandas as pd
import pytest

from data.features import (FEATURE_COLS, HORIZONS, SEQ_H, SEQ_V, build_flight_table, build_sequences,
                           hist_stats, inference_frames, request_curve, training_frame)
from data.parsers import (MAX_DTD, curve_to_cumulative, cumulative_to_curve, load_availability,
                          load_sales_history, load_tickets, parse_curve, tickets_to_history)
from data.synthetic import ROUTES, history_to_csv, make_history


def buf(text: str) -> io.StringIO:
    return io.StringIO(text)


# ================================================================ кривая

def test_parse_curve_basic():
    assert parse_curve("0:7") == {0: 7}
    assert parse_curve("0:1 1:5") == {0: 1, 1: 5}


def test_parse_curve_garbage_is_skipped():
    # мусор, отрицательные дни, нулевые и нечисловые значения пропускаются; запятая и ; — разделители
    got = parse_curve("abc 3:x 5:2 -1:4 2:0 :3 7:3,8:1;9:2 ::")
    assert got == {5: 2, 7: 3, 8: 1, 9: 2}


@pytest.mark.parametrize("empty", ["", "   ", None, float("nan"), "мусор без двоеточий"])
def test_parse_curve_empty(empty):
    assert parse_curve(empty) == {}
    cum = curve_to_cumulative(empty)
    assert cum.shape == (MAX_DTD + 1,)
    assert not cum.any()


def test_parse_curve_repeated_days_are_summed():
    assert parse_curve("3:2 3:4 0:1 3:1") == {3: 7, 0: 1}


def test_parse_curve_far_days_fold_into_max():
    assert parse_curve(f"500:2 {MAX_DTD + 1}:1 {MAX_DTD}:4") == {MAX_DTD: 7}


def test_cumulative_is_monotone_and_starts_with_total():
    s = "0:3 1:5 2:2 10:4 40:6 200:1"
    cum = curve_to_cumulative(s)
    assert cum[0] == 3 + 5 + 2 + 4 + 6 + 1                    # cum[0] = итог
    assert np.all(np.diff(cum) <= 0)                           # не растёт с ростом h
    assert cum[MAX_DTD] == 1                                    # самый ранний кусок (200 свернулся в 180)
    assert cum[3] == 4 + 6 + 1                                  # проданное за дни >= 3


def test_cumulative_roundtrip():
    s = "0:3 1:5 10:4 40:6"
    assert cumulative_to_curve(curve_to_cumulative(s)) == s


# ================================================================ история продаж

HISTORY_CSV = (
    "REIS,FLYDATE,CITY1,CITY2,TICKETS,REFUNDED,GROUP,CORP,REVENUE,CURVE,REFUND_CURVE\n"
    "kv-100,01.06.2025,KJA,ABA,10,1,0,1,50000,0:4 1:3 10:3,\n"
    "KV-100,02.06.2025,KJA,ABA,8,0,1,0,40000,0:2 5:6,\n"
    "KV-100,02.06.2025,KJA,ABA,9,0,1,0,45000,0:3 5:6,\n"         # дубль: должна остаться последняя
    "KV-101,2025-06-03,KJA,IKT,,0,0,0,30000,0:1 1:5,\n"          # TICKETS пустой -> сумма по кривой
    ",03.06.2025,KJA,IKT,5,0,0,0,1,0:5,\n"                       # нет рейса -> отбрасывается
    "KV-102,не дата,KJA,IKT,5,0,0,0,1,0:5,\n"                    # нет даты -> отбрасывается
)


def test_load_sales_history_cleans_and_dedups():
    h = load_sales_history(buf(HISTORY_CSV))
    assert len(h) == 3
    assert h["reis"].tolist() == ["KV-100", "KV-100", "KV-101"]       # регистр приведён
    row = h[(h["reis"] == "KV-100") & (h["flydate"] == "2025-06-02")].iloc[0]
    assert row["tickets"] == 9                                          # последняя строка дубля
    assert h.loc[h["reis"] == "KV-101", "tickets"].iloc[0] == 6         # из кривой
    assert (h["od"] == h["city1"] + "-" + h["city2"]).all()
    assert h["flydate"].is_monotonic_increasing


def test_load_sales_history_is_idempotent_on_duplicates():
    lines = HISTORY_CSV.strip().split("\n")
    doubled = "\n".join(lines + lines[1:])                              # весь файл дважды
    a = load_sales_history(buf(HISTORY_CSV))
    b = load_sales_history(buf(doubled))
    pd.testing.assert_frame_equal(a, b)


def test_load_sales_history_roundtrip_through_csv(tmp_path):
    h0 = make_history(start="2025-01-01", end="2025-01-20", routes=ROUTES[:2])
    p = tmp_path / "SalesHistory.csv"
    history_to_csv(h0, p)
    a = load_sales_history(p)
    history_to_csv(a, p)                                                # повторная запись/чтение — тот же результат
    b = load_sales_history(p)
    assert len(a) == len(h0)
    pd.testing.assert_frame_equal(a[["reis", "flydate", "tickets", "curve"]], b[["reis", "flydate", "tickets", "curve"]])


def test_load_sales_history_semicolon_and_bom():
    text = "﻿REIS;FLYDATE;TICKETS;CURVE\nKV-1;01.02.2025;3;0:3\n"
    h = load_sales_history(buf(text))
    assert len(h) == 1 and h["tickets"].iloc[0] == 3


def test_load_sales_history_requires_key_columns():
    with pytest.raises(ValueError):
        load_sales_history(buf("A,B\n1,2\n"))


# ================================================================ доступность (Total AU)

def test_availability_column_name_variants():
    for head in ("REIS,FLYDATE,Total AU", "Flight,Date,TotalAU", "reis,flydate,AU", "Рейс,Дата вылета,Всего мест"):
        a = load_availability(buf(head + "\nkv-100,05.07.2025,180\n"))
        assert len(a) == 1, head
        assert a["total_au"].iloc[0] == 180, head
        assert a["reis"].iloc[0] == "KV-100", head


def test_availability_digits_from_y180():
    a = load_availability(buf("REIS,FLYDATE,Total AU,Config\nKV-1,05.07.2025,Y180,Y180\n"))
    assert a["total_au"].iloc[0] == 180
    assert a["config"].iloc[0] == "Y180"


@pytest.mark.parametrize("sep", [";", "\t"])
def test_availability_separators(sep):
    text = sep.join(["REIS", "FLYDATE", "Total AU", "SegBkd", "Free"]) + "\n" + \
        sep.join(["KV-1", "05.07.2025", "100", "40", "60"]) + "\n"
    a = load_availability(buf(text))
    assert len(a) == 1
    assert a["total_au"].iloc[0] == 100 and a["seg_booked"].iloc[0] == 40 and a["seg_free"].iloc[0] == 60


def test_availability_ceiling_restored_without_total_au():
    # из Total SegBkd
    a = load_availability(buf("REIS,FLYDATE,Total SegBkd\nKV-1,05.07.2025,150\n"))
    assert a["total_au"].iloc[0] == 150
    # из SegBkd + Free
    a = load_availability(buf("REIS,FLYDATE,SegBkd,Free\nKV-1,05.07.2025,40,60\n"))
    assert a["total_au"].iloc[0] == 100


def test_availability_drops_rows_without_ceiling_and_dedups():
    text = ("REIS,FLYDATE,Total AU\n"
            "KV-1,05.07.2025,100\n"
            "KV-1,05.07.2025,120\n"       # дубль: последняя
            "KV-2,05.07.2025,\n"          # потолка нет -> строка отбрасывается
            "KV-3,05.07.2025,0\n")        # нулевой потолок невозможен
    a = load_availability(buf(text))
    assert a["reis"].tolist() == ["KV-1"] and a["total_au"].iloc[0] == 120


# ================================================================ билеты без персональных данных

PERSONAL = ["IVANOV IVAN", "ABC123", "+79990001122", "1980-01-01", "ivan@example.com"]
TICKETS_CSV = (
    "FIO,PNR,CONTACTS,BIRTH_DATE,DEALDATE,FLYDATE,REIS,CITY1,CITY2,TYPE,RBD,NFARE\n"
    "IVANOV IVAN,ABC123,+79990001122,1980-01-01,01.06.2025,10.06.2025,kv-100,KJA,ABA,SALE,y,5000\n"
    "IVANOV IVAN,ABC123,ivan@example.com,1980-01-01,05.06.2025,10.06.2025,KV-100,KJA,ABA,SALE,B,6000\n"
    "IVANOV IVAN,ABC123,ivan@example.com,1980-01-01,05.06.2025,10.06.2025,KV-100,KJA,ABA,REFUND,B,6000\n"
    "IVANOV IVAN,ABC123,ivan@example.com,1980-01-01,10.06.2025,10.06.2025,KV-100,KJA,ABA,SALE,M,0\n"
)


def test_tickets_have_no_personal_columns():
    t = load_tickets(buf(TICKETS_CSV))
    forbidden = {"fio", "pnr", "contacts", "birth_date", "birthdate"}
    assert not forbidden & {c.lower() for c in t.columns}
    dump = t.to_csv()
    for p in PERSONAL:
        assert p not in dump
    # а полезные данные на месте
    assert {"reis", "flydate", "dtd", "nfare", "rbd"} <= set(t.columns)


def test_tickets_dtd_from_dealdate_and_refund_dropped():
    t = load_tickets(buf(TICKETS_CSV))
    assert len(t) == 3                                          # REFUND убран
    assert sorted(t["dtd"].tolist()) == [0, 5, 9]
    assert set(t["reis"]) == {"KV-100"}


def test_tickets_to_history_curve_and_paid_only():
    t = load_tickets(buf(TICKETS_CSV))
    h = tickets_to_history(t)                                   # тариф 0 не считается платной продажей
    assert len(h) == 1
    assert h["tickets"].iloc[0] == 2
    assert parse_curve(h["curve"].iloc[0]) == {5: 1, 9: 1}
    assert "fio" not in {c.lower() for c in h.columns}
    assert tickets_to_history(t.iloc[0:0]).empty


def test_tickets_use_dtd_column_when_present():
    t = load_tickets(buf("FLYDATE,REIS,DTD,NFARE\n10.06.2025,KV-1,12,100\n"))
    assert t["dtd"].tolist() == [12]


# ================================================================ признаки

@pytest.fixture(scope="module")
def history() -> pd.DataFrame:
    return make_history(start="2024-03-01", end="2024-07-31", routes=ROUTES[:2], seed=3)


@pytest.fixture(scope="module")
def table(history):
    return build_flight_table(history)


def test_flight_table_shapes_and_curves(table, history):
    assert len(table) == len(history)
    assert table.cum.shape == (len(table), MAX_DTD + 1)
    assert np.all(np.diff(table.cum, axis=1) <= 1e-9)
    np.testing.assert_allclose(table.cum[:, 0], table.df["tickets"].values, atol=0.51)
    assert (table.df["cap"] >= table.df["tickets"]).all()


def _flat(frame: dict) -> pd.DataFrame:
    """Признаки + ключи строки (reis, flydate, dtd, as_of) одной таблицей."""
    return pd.concat([frame["meta"], frame["X"].drop(columns=["dtd"]).reset_index(drop=True)], axis=1)


def test_no_future_leak_in_hist_stats(history):
    """Ядовитые вылеты с flydate = D и огромным итогом не должны менять признаки строк с as_of <= D."""
    D = pd.Timestamp("2024-06-15")
    base_tbl = build_flight_table(history)
    # ядовитый вылет у каждого рейса (и направления), чтобы затронуть все уровни иерархии
    poisons = [{**g.iloc[0].to_dict(), "flydate": D, "tickets": 99999, "capacity": 99999,
                "curve": "30:50000 0:49999", "group": 1, "corp": 1, "revenue": 10 ** 9}
               for _, g in history.groupby("reis")]
    dirty_tbl = build_flight_table(pd.concat([history, pd.DataFrame(poisons)], ignore_index=True))
    assert len(dirty_tbl) == len(base_tbl) + len(poisons)

    hist_cols = [c for c in FEATURE_COLS if c.startswith(("h_", "grp", "corp", "rev", "booked_vs"))]
    for hz in ("30d", "7d"):
        a, b = _flat(training_frame(base_tbl, hz)), _flat(training_frame(dirty_tbl, hz))
        a, b = a[a["flydate"] != D], b[b["flydate"] != D]        # сами ядовитые строки (и их двойники) не сравниваем
        m = a.merge(b, on=["reis", "flydate", "dtd"], suffixes=("_a", "_b"))
        assert len(m) == len(a)                                  # ядовитые строки сюда не попали
        safe, affected = m[m["as_of_a"] <= D], m[m["as_of_a"] > D]   # as_of == D тоже не должен видеть flydate == D
        assert len(safe) > 100 and len(affected) > 100
        for c in hist_cols:
            np.testing.assert_allclose(safe[c + "_a"], safe[c + "_b"], rtol=1e-9, err_msg=c)
        # контроль: после D яд виден (иначе тест ничего не проверяет)
        assert not np.allclose(affected["h_final_a"], affected["h_final_b"])
        # и в строках с as_of == D ровно на границе тоже ничего не изменилось
        edge = m[m["as_of_a"] == D]
        assert len(edge) > 0
        np.testing.assert_allclose(edge["h_final_a"], edge["h_final_b"], rtol=1e-9)


def test_hist_stats_counts_only_earlier_flights(table):
    f = table.df
    reis = f["reis"].iloc[10]
    rows = pd.DataFrame({"reis": [reis], "od": [f["od"].iloc[10]], "dow": [f["dow"].iloc[10]],
                         "as_of": [pd.Timestamp("2024-05-10")]})
    hs = hist_stats(table, rows, h0=7)
    expected = int(((f["reis"] == reis) & (f["flydate"] < pd.Timestamp("2024-05-10"))).sum())
    assert hs["h_n_reis"].iloc[0] == expected
    # вылет ровно в день as_of ещё не «известен»
    rows["as_of"] = f.loc[(f["reis"] == reis), "flydate"].iloc[5]
    n_before = int(((f["reis"] == reis) & (f["flydate"] < rows["as_of"].iloc[0])).sum())
    assert hist_stats(table, rows, h0=7)["h_n_reis"].iloc[0] == n_before == 5


def test_hist_stats_without_history_does_not_use_future(table):
    """Если до as_of нет ни одного вылета, признаки пустые (0), а не среднее по всей таблице (то есть по будущему)."""
    f = table.df
    rows = pd.DataFrame({"reis": [f["reis"].iloc[0]], "od": [f["od"].iloc[0]], "dow": [f["dow"].iloc[0]],
                         "as_of": [f["flydate"].min()]})
    hs = hist_stats(table, rows, h0=7)
    assert hs["h_n_reis"].iloc[0] == 0 and hs["h_level"].iloc[0] == 0
    assert hs["h_final"].iloc[0] == 0 and hs["h_rem"].iloc[0] == 0


def test_training_frame_structure(table):
    for hz, (h0, lo, hi) in HORIZONS.items():
        fr = training_frame(table, hz)
        first = table.df["flydate"].min()
        # строки, у которых дата прогноза раньше самого первого вылета истории, не берутся
        # (им нечего знать о прошлом; иначе пришлось бы подставлять среднее по всей выборке, то есть и по будущему)
        n = sum(int(((table.df["flydate"] - pd.Timedelta(days=d)) >= first).sum()) for d in range(lo, hi + 1))
        assert (fr["meta"]["as_of"] >= first).all()
        assert len(fr["X"]) == len(fr["y"]) == len(fr["booked"]) == len(fr["cap"]) == n
        assert list(fr["X"].columns) == FEATURE_COLS
        assert fr["meta"]["dtd"].between(lo, hi).all()
        assert (fr["booked"] <= fr["y"] + 1e-6).all()           # продано к dtd не больше итога
        assert not fr["X"].isna().any().any()


def test_build_sequences_shapes_and_values(table):
    fr = training_frame(table, "14d")
    H, V = fr["H"], fr["V"]
    n = len(fr["X"])
    assert H.shape == (n, SEQ_H) and V.shape == (n, SEQ_V)
    assert (H >= 0).all() and np.isfinite(H).all() and np.isfinite(V).all()
    # последний элемент H — продажи за сам день dtd; сумма H не больше проданного к dtd + хвост окна
    i = 123
    d = int(fr["meta"]["dtd"].iloc[i])
    idx = int(np.where((table.df["reis"] == fr["meta"]["reis"].iloc[i]) &
                       (table.df["flydate"] == fr["meta"]["flydate"].iloc[i]))[0][0])
    assert H[i, -1] == pytest.approx(table.cum[idx, d] - table.cum[idx, d + 1])
    assert H[i].sum() <= table.cum[idx, d] + 1e-6


def test_build_sequences_small_input(table):
    rows = pd.DataFrame({"reis": [table.df["reis"].iloc[0]], "flydate": [pd.Timestamp("2024-06-20")],
                         "od": [table.df["od"].iloc[0]], "dow": [3], "cap": [100.0], "dtd": [5],
                         "as_of": [pd.Timestamp("2024-06-15")]})
    cum = np.zeros((1, MAX_DTD + 1))
    H, V = build_sequences(table, rows, cum)
    assert H.shape == (1, SEQ_H) and V.shape == (1, SEQ_V)


# ================================================================ кадры для прогноза по запросу

@pytest.mark.parametrize("dtd", [0, 1, 2, 4, 7, 10, 14, 20, 30, 45, 120, 180])
def test_inference_frames_four_horizons_and_curve(table, dtd):
    reis = table.df["reis"].iloc[0]
    fd = pd.Timestamp("2024-08-20")
    booked = 37
    inf = inference_frames(table, reis, fd, booked, total_au=100, dtd=dtd)
    assert set(inf) == set(HORIZONS) == {"30d", "14d", "7d", "1_3d"}
    for key, part in inf.items():
        assert list(part["X"].columns) == FEATURE_COLS and len(part["X"]) == 1
        assert part["H"].shape == (1, SEQ_H) and part["V"].shape == (1, SEQ_V)
        assert part["distance"] == abs(part["h_dtd"] - dtd)
        assert part["X"]["cap"].iloc[0] == 100
        assert np.isfinite(part["X"].to_numpy(dtype=float)).all()

    od = table.df.loc[table.df["reis"] == reis, "od"].iloc[-1]
    curve = request_curve(table, reis, od, fd, booked, dtd)
    assert np.all(np.diff(curve) <= 1e-9)                       # монотонна (не растёт с ростом h)
    assert curve[dtd] == pytest.approx(booked)                  # проходит через current_booked
    assert curve[0] >= booked - 1e-9                            # будущее не меньше текущего


def test_inference_booked_equals_current_on_matching_horizon(table):
    reis = table.df["reis"].iloc[0]
    for dtd, key in ((30, "30d"), (14, "14d"), (7, "7d"), (2, "1_3d")):
        inf = inference_frames(table, reis, pd.Timestamp("2024-08-20"), 55, 120, dtd)
        assert inf[key]["X"]["booked"].iloc[0] == pytest.approx(55)
        assert inf[key]["distance"] == 0


def test_inference_unknown_flight_and_zero_booked(table):
    inf = inference_frames(table, "ZZ-999", pd.Timestamp("2024-08-20"), 0, 50, 10)
    assert set(inf) == set(HORIZONS)
    curve = request_curve(table, "ZZ-999", "", pd.Timestamp("2024-08-20"), 0, 10)
    assert np.all(np.diff(curve) <= 1e-9) and curve[10] == 0


def test_inference_on_empty_table_does_not_crash():
    empty = build_flight_table(make_history(start="2024-01-01", end="2024-01-02", routes=ROUTES[:1]).iloc[0:0]
                               .assign(curve=pd.Series(dtype=str)))
    curve = request_curve(empty, "KV-1", "", pd.Timestamp("2024-02-01"), 5, 10)
    assert np.all(np.diff(curve) <= 1e-9) and curve[10] == 5
