"""Walk-forward бэктест ML-модели спроса против текущей модели (файл ожидаемой загрузки) и наивной кривой.

Для каждой даты среза S: билеты с deal_date ≤ S → build_panel(cutoff=S) → обучение → прогноз вылетов с fly_date > S.
Оценка (только на том, что реально наблюдалось к 07.10):
  A) итог к вылету на улетевших вылетах (fly_date ≤ среза данных), по горизонтам 1-3/4-7/8-14/15-30 дней;
     факт = число билетов в данных (как в панели) и, справочно, load из файла загрузки;
  B) бронирования за k=7 дней после S (S+7 ≤ среза данных) на ВСЕХ вылетах, включая будущие.
Запуск: PM_DATA=... python3 backtest.py   → out/ml/*.csv, модель out/ml/model_latest.pkl
"""
import json
import os

import numpy as np
import pandas as pd
from scipy import stats

from common import build_panel, data_dir, load
from model import DemandModel, add_features, hist_panel, state_at

OUT = os.environ.get("PM_OUT") or os.path.join(os.path.dirname(data_dir()), "out", "ml")
os.makedirs(OUT, exist_ok=True)
K = 7
HB = [(1, 3, "1-3"), (4, 7, "4-7"), (8, 14, "8-14"), (15, 30, "15-30")]


def hbucket(d):
    for a, b, n in HB:
        if a <= d <= b:
            return n
    return None


def naive_curves(hist):
    """Средняя дневная кривая бронирований прошлых улетевших вылетов: flight → fly_date, curve[dtd]."""
    rows = []
    for fl, fd, c in zip(hist.flight, hist.fly_date, hist.curve):
        cur = json.loads(c) if isinstance(c, str) else {}
        v = np.zeros(121)
        for k, n in cur.items():
            v[min(int(k), 120)] += n
        rows.append((fl, fd, v))
    return rows


def naive_pickup(curves, S, flights, lo, hi, lookback=90):
    """Σ_{lo ≤ dtd < hi} средней кривой рейса за вылеты в (S-lookback, S] (без цены). Нет рейса → среднее по всем."""
    sel = [(fl, v) for fl, fd, v in curves if S - pd.Timedelta(days=lookback) < fd <= S]
    allm = np.mean([v for _, v in sel], axis=0)
    byfl = {}
    for fl, v in sel:
        byfl.setdefault(fl, []).append(v)
    byfl = {k: np.mean(v, axis=0) for k, v in byfl.items()}
    cum = {k: np.concatenate([[0], np.cumsum(v)]) for k, v in byfl.items()}
    call = np.concatenate([[0], np.cumsum(allm)])
    out = []
    for fl, a, b in zip(flights, lo, hi):
        c = cum.get(fl, call)
        out.append(c[min(b, 121)] - c[min(a, 121)])
    return np.array(out)


def main():
    t, dep, cutoff, meta = load()
    hist = pd.read_csv(os.path.join(data_dir(), "hist.csv"), parse_dates=["fly_date"])
    curves = naive_curves(hist)
    e = pd.read_csv(os.path.join(data_dir(), "expected.csv")).set_index(["cap", "flight", "week", "dtd"]).expected
    fin_tk = t.groupby(["flight", "fly_date"]).size().rename("final_tk")
    cutoffs = [cutoff - pd.Timedelta(days=3 + 7 * i) for i in range(8)][::-1]
    print(f"Срез данных {cutoff:%d.%m.%Y}; срезы бэктеста: {', '.join(f'{c:%d.%m}' for c in cutoffs)}")

    fin_rows, k_rows, timing = [], [], []
    alpha_nb = {"lgb": 0.0, "glm": 0.0}
    for S in cutoffs:
        tS = t[t.deal_date <= S]
        pan = add_features(build_panel(tS, dep, S))
        hx = hist_panel(hist, dep, pan, S)
        models = {}
        for name, kw in [("lgb", dict(kind="lgb", halflife=60)), ("glm", dict(kind="glm", halflife=60)),
                         ("lgb_hl30", dict(kind="lgb", halflife=30)), ("lgb_nohl", dict(kind="lgb", halflife=None))]:
            models[name] = DemandModel(**kw).fit(pan, S, extra=hx)
            timing.append((S, name, len(pan), models[name].fit_seconds))
        st = state_at(pan, S)
        st = st[st.ref_fare.notna()].reset_index(drop=True)
        st = st.merge(fin_tk, left_on=["flight", "fly_date"], right_index=True, how="left")
        kk = min(K, (cutoff - S).days)
        fut = t[(t.deal_date > S) & (t.deal_date <= S + pd.Timedelta(days=kk))].groupby(["flight", "fly_date"]).size()
        st["y_k"] = [fut.get((a, b), 0) for a, b in zip(st.flight, st.fly_date)]
        st["exp0"] = [e.get((c, b, w, 0), np.nan) for c, b, w in zip(st.cap_class, st.base, st.week)]
        st["exp_now"] = [e.get((c, b, w, min(d, 90)), np.nan) for c, b, w, d in zip(st.cap_class, st.base, st.week, st.dtd_now)]
        st["exp_k"] = [e.get((c, b, w, min(max(d - kk, 0), 90)), np.nan) for c, b, w, d in zip(st.cap_class, st.base, st.week, st.dtd_now)]
        lo = np.maximum(st.dtd_now.values - kk, 0)
        st["naive_rem"] = naive_pickup(curves, S, st.flight, np.zeros(len(st), int), st.dtd_now.values)
        st["naive_k"] = naive_pickup(curves, S, st.flight, lo, st.dtd_now.values)
        for name in ["lgb", "glm", "lgb_hl30", "lgb_nohl"]:
            fin, lam = models[name].predict_final_batch(st)
            st[f"{name}_final"] = fin
            st[f"{name}_k"] = lam[:, :kk].sum(1)
            if name in ("lgb", "glm"):   # кривая «загрузка от цены» (−20%, текущая, +20%) для проверки знака
                for m_ in (0.8, 1.2):
                    st[f"{name}_final_p{int(m_*100)}"] = models[name].predict_final_batch(st, price=st.price_now.values * m_)[0]
                # интервалы 80%: Пуассон и НБ (α оценено на ПРЕДЫДУЩИХ срезах)
                mu = np.maximum(st[f"{name}_final"] - st.sold_now, 1e-6)
                st[f"{name}_pi_lo"] = st.sold_now + stats.poisson.ppf(0.1, mu)
                st[f"{name}_pi_hi"] = st.sold_now + stats.poisson.ppf(0.9, mu)
                a = max(alpha_nb[name], 1e-6)
                n_ = 1 / a
                st[f"{name}_nb_lo"] = st.sold_now + stats.nbinom.ppf(0.1, n_, n_ / (n_ + mu))
                st[f"{name}_nb_hi"] = np.minimum(st.sold_now + stats.nbinom.ppf(0.9, n_, n_ / (n_ + mu)), st.seats)
                mk = np.maximum(st[f"{name}_k"], 1e-6)
                st[f"{name}_k_nb_lo"] = stats.nbinom.ppf(0.1, n_, n_ / (n_ + mk))
                st[f"{name}_k_nb_hi"] = stats.nbinom.ppf(0.9, n_, n_ / (n_ + mk))
                st[f"{name}_k_pi_lo"] = stats.poisson.ppf(0.1, mk)
                st[f"{name}_k_pi_hi"] = stats.poisson.ppf(0.9, mk)
                # обновляем α по моментам на 7-дневных ошибках этого среза (используется только СЛЕДУЮЩИМИ срезами,
                # и только если окно k уже закрыто к следующему срезу — консервативно: S+k ≤ следующий срез)
                mu_k = st[f"{name}_k"].values
                alpha_nb[name] = max(0.0, np.mean((st.y_k - mu_k) ** 2 - mu_k) / max(np.mean(mu_k ** 2), 1e-9))
        st["S"] = S
        st["k"] = kk
        k_rows.append(st)
        fl = st[st.fly_date <= cutoff].copy()
        fl["hb"] = fl.dtd_now.map(hbucket)
        fin_rows.append(fl[fl.hb.notna()])
        print(f"  {S:%d.%m}: панель {len(pan)} + hist {len(hx)} строк, открытых вылетов {len(st)}, улетевших к оценке {fl.hb.notna().sum()}, "
              f"LGB {models['lgb'].fit_seconds:.1f}s, GLM {models['glm'].fit_seconds:.1f}s")
    models["lgb"].save(os.path.join(OUT, "model_latest.pkl"))

    K_ = pd.concat(k_rows, ignore_index=True)
    F = pd.concat(fin_rows, ignore_index=True)
    F.to_csv(os.path.join(OUT, "bt_final.csv"), index=False)
    K_.drop(columns=[c for c in K_.columns if K_[c].dtype == object and c not in ("flight", "route")]).to_csv(
        os.path.join(OUT, "bt_kday.csv"), index=False)

    def met(y, p):
        ok = ~np.isnan(p)
        y, p = y[ok], p[ok]
        return dict(n=len(y), MAE=np.mean(np.abs(p - y)), WAPE=np.sum(np.abs(p - y)) / max(np.sum(y), 1), bias=np.mean(p - y))

    # --- A. итог к вылету ---
    F["base_final"] = F.exp0                                   # текущая модель как есть
    F["base_pickup"] = F.sold_now + (F.exp0 - F.exp_now).clip(lower=0)   # текущая + уже проданное
    F["naive_final"] = F.sold_now + F.naive_rem
    F["load"] = F["load"].astype(float)
    cmp = {"ML LightGBM": "lgb_final", "GLM Пуассон": "glm_final", "LGB hl=30": "lgb_hl30_final", "LGB без затухания": "lgb_nohl_final",
           "Наивная кривая (без цены)": "naive_final", "Текущая модель (expected, dtd=0)": "base_final",
           "Текущая + продано (pickup)": "base_pickup", "Только sold_now": "sold_now"}
    res = []
    for truth in ["final_tk", "load"]:
        for hb in ["1-3", "4-7", "8-14", "15-30", "все"]:
            sub = F if hb == "все" else F[F.hb == hb]
            sub = sub[sub.exp0.notna()]                          # только где текущая модель даёт прогноз
            for lab, c in cmp.items():
                res.append(dict(truth=truth, horizon=hb, model=lab, **met(sub[truth].values.astype(float), sub[c].values.astype(float))))
    R = pd.DataFrame(res)
    R.to_csv(os.path.join(OUT, "metrics_final.csv"), index=False)
    print("\nA) Итог к вылету (улетевшие, вылет×срез; факт = билеты в данных; только где есть прогноз текущей модели):")
    print(R[R.truth == "final_tk"].pivot_table(index="model", columns="horizon", values="MAE").round(2)[["1-3", "4-7", "8-14", "15-30", "все"]].to_string())
    print("  WAPE / смещение (все горизонты):")
    print(R[(R.truth == "final_tk") & (R.horizon == "все")].set_index("model")[["n", "WAPE", "bias"]].round(3).to_string())
    print("  Справочно MAE против load из файла загрузки (все горизонты):")
    print(R[(R.truth == "load") & (R.horizon == "все")].set_index("model")[["MAE", "bias"]].round(2).to_string())

    # --- B. бронирования за 7 дней после среза (все вылеты) ---
    K_["base_k"] = (K_.exp_k - K_.exp_now).clip(lower=0)
    resk = []
    for lab, c in {"ML LightGBM": "lgb_k", "GLM Пуассон": "glm_k", "LGB hl=30": "lgb_hl30_k", "LGB без затухания": "lgb_nohl_k",
                   "Наивная кривая": "naive_k", "Текущая модель (приращение expected)": "base_k"}.items():
        sub = K_[K_.exp_now.notna()]
        resk.append(dict(model=lab, **met(sub.y_k.values.astype(float), sub[c].values.astype(float))))
    RK = pd.DataFrame(resk)
    RK.to_csv(os.path.join(OUT, "metrics_kday.csv"), index=False)
    print(f"\nB) Бронирования за следующие ≤{K} дней после среза (все открытые вылеты, вылет×срез):")
    print(RK.set_index("model").round(3).to_string())
    stab = K_[K_.exp_now.notna()].groupby("S").apply(lambda g: pd.Series({m: np.sum(np.abs(g[c] - g.y_k)) / max(g.y_k.sum(), 1)
                                                                         for m, c in [("lgb", "lgb_k"), ("glm", "glm_k"), ("naive", "naive_k"), ("base", "base_k")]}))
    stab.to_csv(os.path.join(OUT, "wape_kday_by_cutoff.csv"))
    print("  WAPE по срезам (стабильность):\n" + stab.round(3).to_string())

    # --- калибровка ---
    print("\nКалибровка:")
    cov = []
    for name in ["lgb", "glm"]:
        f2 = F[F.S > cutoffs[0]]
        k2 = K_[K_.S > cutoffs[0]]
        cov.append(dict(model=name, final_pois80=np.mean((f2.final_tk >= f2[f"{name}_pi_lo"]) & (f2.final_tk <= f2[f"{name}_pi_hi"])),
                        final_nb80=np.mean((f2.final_tk >= f2[f"{name}_nb_lo"]) & (f2.final_tk <= f2[f"{name}_nb_hi"])),
                        k_pois80=np.mean((k2.y_k >= k2[f"{name}_k_pi_lo"]) & (k2.y_k <= k2[f"{name}_k_pi_hi"])),
                        k_nb80=np.mean((k2.y_k >= k2[f"{name}_k_nb_lo"]) & (k2.y_k <= k2[f"{name}_k_nb_hi"]))))
    C = pd.DataFrame(cov)
    C.to_csv(os.path.join(OUT, "coverage.csv"), index=False)
    print("  Покрытие 80%-интервалов (номинал 0.80), без первого среза:\n" + C.round(3).to_string(index=False))
    K_["dec"] = pd.qcut(K_.lgb_k.rank(method="first"), 10, labels=False)
    cal = K_.groupby("dec").agg(pred_lgb=("lgb_k", "mean"), fact=("y_k", "mean"), pred_glm=("glm_k", "mean"), n=("y_k", "size"))
    cal.to_csv(os.path.join(OUT, "calibration_kday_deciles.csv"))
    print("  Ожидаемое vs факт (7-дн. бронирования) по децилям прогноза LGB:\n" + cal.round(2).to_string())

    # --- цена: знак эффекта ---
    el = pd.DataFrame({m: {"-20%": (K_[f"{m}_final_p80"] - K_[f"{m}_final"]).mean(),
                           "+20%": (K_[f"{m}_final_p120"] - K_[f"{m}_final"]).mean()} for m in ["lgb", "glm"]})
    el.to_csv(os.path.join(OUT, "price_effect.csv"))
    print("\nСредний сдвиг прогноза загрузки к вылету при изменении цены на ±20% (пасс.):\n" + el.round(2).to_string())
    T = pd.DataFrame(timing, columns=["S", "model", "rows", "sec"])
    T.to_csv(os.path.join(OUT, "fit_time.csv"), index=False)
    print("\nВремя обучения, с (среднее): " + T.groupby("model").sec.mean().round(2).to_string().replace("\n", "; "))


if __name__ == "__main__":
    main()
