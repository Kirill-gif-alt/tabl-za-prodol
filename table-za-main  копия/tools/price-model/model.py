"""ML-модель дневного спроса λ(цена, время) — роль «ML-инженер».

Цель: bookings_{dep,t} ~ Poisson(λ),  log λ = f(dtd, log rel_price, неделя, месяц, день недели, направление,
      ёмкость, кресла, sold_before/seats, возраст наблюдения цены),  ∂λ/∂price ≤ 0 (monotone_constraints = −1).

ВАЖНО про цену без утечки: в панели price_seen есть только в дни, когда была продажа (минимальный проданный тариф),
поэтому price_obs ≡ (bookings>0) — это утечка цели. Признак цены здесь — ПОСЛЕДНЯЯ цена, увиденная СТРОГО ДО дня t
(price_lag), а наблюдаемость — «сколько дней назад видели цену» (price_age). Для оптимизатора price = объявленный тариф.

API для оптимизатора:
  m = DemandModel().fit(panel, asof=S)        # обучение на продажах с deal_date ≤ S, вес 0.5^(возраст/halflife)
  m.predict_daily(df, price)                  # λ на строках df (колонки панели), price — скаляр/массив, ₽
  m.predict_final(dep_row, price_path)        # E[загрузка к вылету] = sold_now + Σ λ(p_t,t), ≤ seats
  m.load_curve(dep_row, prices)               # кривая «загрузка от цены» при постоянной цене
  m.save(path) / DemandModel.load(path)
"""
import pickle
import time

import lightgbm as lgb
import numpy as np
import pandas as pd

FEATS = ["dtd", "log_rel_price", "week", "month", "dow", "route_c", "cap", "seats", "sold_frac", "left", "price_age"]
MONO = {"log_rel_price": -1}
PARAMS = dict(objective="poisson", learning_rate=0.05, num_leaves=15, min_data_in_leaf=50, feature_fraction=0.9,
              bagging_fraction=0.8, bagging_freq=1, lambda_l2=1.0, verbose=-1, seed=7, num_threads=1, max_bin=63)  # >1 потока здесь в 10+ раз медленнее
N_ROUNDS = 300


def add_features(p):
    """Добавляет признаки без утечки (только то, что известно до начала дня t)."""
    p = p.sort_values(["flight", "fly_date", "dtd"], ascending=[True, True, False]).copy()
    g = p.groupby(["flight", "fly_date"], sort=False)
    p["price_lag"] = g.price_seen.shift(1)
    p["price_lag"] = p.groupby(["flight", "fly_date"], sort=False).price_lag.ffill()
    last_dtd = p.dtd.where(p.price_seen.notna())
    p["_lo"] = last_dtd
    p["_lo"] = p.groupby(["flight", "fly_date"], sort=False)._lo.shift(1)
    p["_lo"] = p.groupby(["flight", "fly_date"], sort=False)._lo.ffill()
    p["price_age"] = (p._lo - p.dtd).fillna(999).clip(upper=999)
    p["price_x"] = p.price_lag.fillna(p.price_typ).fillna(p.ref_fare)
    p["log_rel_price"] = np.log(p.price_x / p.ref_fare)
    p["month"] = p.fly_date.dt.month
    p["sold_frac"] = p.sold_before / p.seats.clip(lower=1)
    p["left"] = (p.seats - p.sold_before).clip(lower=0)
    p["deal_date"] = p.fly_date - pd.to_timedelta(p.dtd, unit="D")
    return p.drop(columns=["_lo"])


class DemandModel:
    def __init__(self, halflife=60, n_rounds=N_ROUNDS, kind="lgb"):
        self.halflife, self.n_rounds, self.kind = halflife, n_rounds, kind

    # ---------- обучение ----------
    def _X(self, df):
        X = df.reindex(columns=[f for f in FEATS if f != "route_c"]).astype(float)
        X["route_c"] = pd.Categorical(df.route, categories=self.routes).codes
        X.loc[X.route_c < 0, "route_c"] = np.nan
        return X[FEATS]

    def fit(self, panel, asof, extra=None):
        t0 = time.time()
        tr = panel[(panel.deal_date <= asof) & panel.ref_fare.notna()]
        if extra is not None and len(extra):
            tr = pd.concat([tr, extra[extra.deal_date <= asof]], ignore_index=True)
        self.asof = pd.Timestamp(asof)
        self.routes = sorted(tr.route.unique())
        w = 0.5 ** ((self.asof - tr.deal_date).dt.days / self.halflife) if self.halflife else np.ones(len(tr))
        if self.kind == "lgb":
            ds = lgb.Dataset(self._X(tr), tr.bookings.values, weight=np.asarray(w), categorical_feature=["route_c"],
                             free_raw_data=False)
            prm = dict(PARAMS, monotone_constraints=[MONO.get(f, 0) for f in FEATS], monotone_constraints_method="intermediate")
            self.booster = lgb.train(prm, ds, self.n_rounds)
        else:
            import statsmodels.api as sm
            self.glm_cols = None
            X = self._glm_X(tr)
            self.glm = sm.GLM(tr.bookings.values, X, family=sm.families.Poisson(), var_weights=np.asarray(w)).fit(maxiter=100)
        self.fit_seconds = time.time() - t0
        return self

    def _glm_X(self, df):
        X = pd.DataFrame(index=df.index)
        X["const"] = 1.0
        X["log_rel_price"] = df.log_rel_price.clip(-2, 2)
        d = df.dtd.clip(upper=120)
        for k, (a, b) in enumerate([(0, 0), (1, 2), (3, 5), (6, 9), (10, 14), (15, 21), (22, 35), (36, 60)]):
            X[f"dtd{k}"] = ((d >= a) & (d <= b)).astype(float)
        X["sold_frac"] = df.sold_frac.clip(0, 1.5)
        X["log_cap"] = np.log(df.cap.clip(lower=1))
        X["stale"] = (df.price_age > 30).astype(float)
        for v in range(1, 7):
            X[f"dow{v}"] = (df.dow == v).astype(float)
        for r in self.routes[1:]:
            X[f"r_{r}"] = (df.route == r).astype(float)
        if self.glm_cols is None:
            self.glm_cols = [c for c in X.columns if X[c].std() > 0 or c == "const"]
        return X.reindex(columns=self.glm_cols, fill_value=0.0)

    # ---------- прогноз ----------
    def predict_daily(self, df, price=None):
        """λ (ожид. бронирований в день) на строках df; price (₽) подменяет цену, если задана."""
        df = df.copy()
        if price is not None:
            df["log_rel_price"] = np.log(np.asarray(price, dtype=float) / df.ref_fare.values)
        if self.kind == "lgb":
            return self.booster.predict(self._X(df))
        return np.asarray(self.glm.predict(self._glm_X(df)))

    def _future_rows(self, dep_row, dtd_now):
        """Строки будущих дней t = dtd_now-1 … 0 для одного вылета (dep_row — последняя строка панели на дату среза)."""
        ts = np.arange(int(dtd_now) - 1, -1, -1)
        f = pd.DataFrame({c: dep_row[c] for c in ["route", "ref_fare", "week", "month", "dow", "cap", "seats"]}, index=range(len(ts)))
        f["dtd"] = ts
        f["price_age"] = np.arange(1, len(ts) + 1) + float(min(dep_row.get("price_age_now", 0), 900))
        return f

    def predict_final(self, dep_row, price_path=None, return_path=False):
        """E[загрузка к вылету] = sold_now + Σ_{t<now} λ(p_t, t); sold_before обновляется ожиданием; ≤ seats.
        dep_row: Series с полями панели + sold_now, dtd_now, price_now. price_path: скаляр или массив длины dtd_now
        (цены для t = dtd_now-1 … 0); None → последняя наблюдённая цена (price_now)."""
        sold, now = float(dep_row["sold_now"]), int(dep_row["dtd_now"])
        if now <= 0:
            return (sold, np.array([])) if return_path else sold
        f = self._future_rows(dep_row, now)
        pp = np.broadcast_to(np.asarray(dep_row["price_now"] if price_path is None else price_path, float), (len(f),))
        f["log_rel_price"] = np.log(pp / f.ref_fare.values)
        lam = np.zeros(len(f))
        seats = float(dep_row["seats"])
        # sold_before зависит от прошлых прогнозов → считаем по дням (вектор на 1 вылет, дёшево при ≤120 днях)
        Xall = f.copy()
        for i in range(len(f)):
            Xall.loc[i, "sold_frac"] = sold / max(seats, 1)
            Xall.loc[i, "left"] = max(seats - sold, 0)
            li = float(self.predict_daily(Xall.iloc[[i]])[0])
            li = min(li, max(seats - sold, 0))
            lam[i] = li
            sold += li
        return (sold, lam) if return_path else sold

    def predict_final_batch(self, states, price=None, kmax=None):
        """Векторно для многих вылетов (строки state_at). price: None → price_now; скаляр-множитель не нужен —
        передайте массив цен по вылетам (постоянная цена до вылета). Возвращает (E_final, lam[n, T]) где lam[:, j] —
        λ в день dtd_now-1-j. kmax — горизонт симуляции (по умолчанию до вылета)."""
        st = states.reset_index(drop=True)
        now = st.dtd_now.values.astype(int)
        T = int(now.max()) if kmax is None else int(min(kmax, now.max()))
        sold = st.sold_now.values.astype(float).copy()
        seats = st.seats.values.astype(float)
        pr = np.asarray(st.price_now if price is None else price, float) * np.ones(len(st))
        lam = np.zeros((len(st), T))
        f = st[["route", "ref_fare", "week", "month", "dow", "cap", "seats"]].copy()
        f["log_rel_price"] = np.log(pr / st.ref_fare.values)
        for j in range(T):
            act = now - 1 - j >= 0
            if not act.any():
                break
            f["dtd"] = np.maximum(now - 1 - j, 0)
            f["price_age"] = np.minimum(st.price_age_now.values + j + 1, 999)
            f["sold_frac"] = sold / np.maximum(seats, 1)
            f["left"] = np.maximum(seats - sold, 0)
            li = np.minimum(self.predict_daily(f), np.maximum(seats - sold, 0)) * act
            lam[:, j] = li
            sold += li
        return sold, lam

    def load_curve(self, dep_row, prices):
        return pd.Series([self.predict_final(dep_row, p) for p in prices], index=prices, name="E_load")

    def save(self, path):
        with open(path, "wb") as fh:
            pickle.dump(self, fh)

    @staticmethod
    def load(path):
        with open(path, "rb") as fh:
            return pickle.load(fh)


def state_at(panel, S):
    """Состояние каждого вылета (fly_date > S) на дату среза S: sold_now, dtd_now, price_now, price_age_now."""
    p = panel[(panel.deal_date <= S) & (panel.fly_date > S)]
    last = p.sort_values("dtd").groupby(["flight", "fly_date"]).head(1).copy()   # день S (минимальный dtd)
    last["sold_now"] = last.sold_before + last.bookings
    last["dtd_now"] = (last.fly_date - S).dt.days
    seen = p[p.price_seen.notna()].sort_values("dtd").groupby(["flight", "fly_date"]).head(1)
    last = last.merge(seen[["flight", "fly_date", "price_seen", "dtd"]].rename(columns={"price_seen": "price_now", "dtd": "dtd_seen"}),
                      on=["flight", "fly_date"], how="left")
    last["price_age_now"] = (last.dtd_seen - last.dtd_now).fillna(999)
    last["price_now"] = last.price_now.fillna(last.price_x)
    return last


def hist_panel(hist, dep, panel, asof, lookback=150, t_max=60):
    """Доп. обучающие строки из hist.csv (улетевшие вылеты с fly_date ≤ asof, дневная кривая бронирований).
    Нужны, т.к. в окне билетов вылеты начинаются с 23.09 и до этой даты в панели НЕТ ближних к вылету дней.
    Дневной цены там нет: цена = средний тариф вылета (avg_fare), price_age = 999 («цена не наблюдалась»).
    Направление/ёмкость — наиболее частые для номера рейса в departures (допущение). Вылеты, уже входящие в панель, исключены."""
    import json
    asof = pd.Timestamp(asof)
    h = hist[(hist.fly_date <= asof) & (hist.fly_date > asof - pd.Timedelta(days=lookback)) & (hist.tickets > 0)]
    fm = dep.groupby("flight").agg(route=("route", lambda x: x.mode().iat[0]), cap=("cap", "median"), seats=("seats", "median"))
    h = h.drop(columns=["route"]).merge(fm, left_on="flight", right_index=True)
    have = set(zip(panel.flight, panel.fly_date))
    ref = panel.groupby("route").ref_fare.first()
    rows = []
    for r in h.itertuples(index=False):
        if (r.flight, r.fly_date) in have or r.route not in ref.index or not (r.avg_fare > 0):
            continue
        cur = {int(k): v for k, v in json.loads(r.curve).items()}
        sold = sum(v for k, v in cur.items() if k > t_max)
        for d in range(t_max, -1, -1):
            b = cur.get(d, 0)
            rows.append((r.flight, r.fly_date, d, b, sold, r.route, r.cap, r.seats, r.avg_fare))
            sold += b
    x = pd.DataFrame(rows, columns=["flight", "fly_date", "dtd", "bookings", "sold_before", "route", "cap", "seats", "price_x"])
    x["ref_fare"] = x.route.map(ref)
    x["log_rel_price"] = np.log(x.price_x / x.ref_fare)
    x["week"] = x.fly_date.dt.isocalendar().week.astype(int)
    x["month"] = x.fly_date.dt.month
    x["dow"] = x.fly_date.dt.dayofweek
    x["price_age"] = 999.0
    x["sold_frac"] = x.sold_before / x.seats.clip(lower=1)
    x["left"] = (x.seats - x.sold_before).clip(lower=0)
    x["deal_date"] = x.fly_date - pd.to_timedelta(x.dtd, unit="D")
    return x
