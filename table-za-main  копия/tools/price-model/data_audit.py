"""Аудит данных для модели «спрос от цены» (роль: аналитик).
Запуск: PM_DATA=... python3 data_audit.py   → печать + CSV в $PM_OUT (по умолчанию <PM_DATA>/../out/analyst)."""
import json, os, re
import numpy as np, pandas as pd
from common import load, data_dir

D = data_dir(); OUT = os.environ.get("PM_OUT") or os.path.join(os.path.dirname(os.path.abspath(D)), "out", "analyst")
os.makedirs(OUT, exist_ok=True)
def save(df, name): df.to_csv(os.path.join(OUT, name), index=True)
def h(s): print("\n=== " + s + " ===")

t, dep, cutoff, meta = load()
t["basis"] = t.basis.fillna("")
t["fam"] = t.basis.str[1:].str.replace(r"/.*$", "", regex=True)          # семейство без класса и /CN..
t["mod"] = t.basis.str.extract(r"(/\w+)$")[0].fillna("")
print(f"билетов {len(t)}, вылетов {len(dep)}, срез {cutoff:%d.%m.%Y}, продажи {t.deal_date.min():%d.%m.%Y}–{t.deal_date.max():%d.%m.%Y}")

h("1. Структура тарифов")
fam = t.groupby("fam").agg(n=("fare", "size"), zero=("fare", lambda x: (x == 0).mean()), med=("fare", "median"),
                           routes=("route", "nunique"), dtd_med=("dtd", "median")).sort_values("n", ascending=False)
print(fam.head(25).round(2)); save(fam, "fare_families.csv")
mods = t[t["mod"] != ""].copy()
base_key = mods.basis.str.replace(r"/\w+$", "", regex=True)
adult = t[t["mod"] == ""].groupby(["route", "basis"]).fare.median()
mods["adult_fare"] = [adult.get((r, b)) for r, b in zip(mods.route, base_key)]
mods["ratio"] = mods.fare / mods.adult_fare
mr = mods.groupby("mod").agg(n=("fare", "size"), ratio_med=("ratio", "median"), zero=("fare", lambda x: (x == 0).mean()))
print("модификаторы (цена / цена того же кода без модификатора на направлении):"); print(mr.sort_values("n", ascending=False).round(2))
save(mr, "modifiers.csv")
ap = t[t.adult & (t.fare > 0)]
lad = ap.groupby(["route", "basis"]).agg(n=("fare", "size"), fare_med=("fare", "median"), n_prices=("fare", "nunique"),
                                         share_mode=("fare", lambda x: x.value_counts(normalize=True).iloc[0]))
save(lad, "ladder_route_basis.csv")
print(f"(направление, код): {len(lad)}; одна цена: {(lad.n_prices == 1).mean():.0%}; мода ≥95% билетов: {(lad.share_mode >= .95).mean():.0%}")
rl = ap.groupby("route").agg(n=("fare", "size"), levels=("fare", "nunique"), codes=("basis", "nunique"),
                             pmin=("fare", "min"), pmed=("fare", "median"), pmax=("fare", "max"))
rl["spread"] = rl.pmax / rl.pmin
save(rl, "route_levels.csv"); print(rl.sort_values("n", ascending=False).head(15))
print(f"уровней цены на направлении: медиана {rl.levels.median():.0f}, макс/мин цены медиана {rl.spread.median():.2f}")
# смена цены кода во времени: по неделям продажи
ap2 = ap.assign(wk=ap.deal_date.dt.to_period("W"))
wk = ap2.groupby(["route", "basis", "wk"]).fare.median().reset_index()
chg = wk.groupby(["route", "basis"]).fare.apply(lambda s: (s.diff().fillna(0) != 0).sum()).rename("changes")
nw = wk.groupby(["route", "basis"]).size().rename("weeks")
cc = pd.concat([chg, nw], axis=1); save(cc, "code_price_changes.csv")
print(f"пар (направление, код) с ≥2 неделями продаж: {(cc.weeks >= 2).sum()}, из них цена менялась: {((cc.weeks >= 2) & (cc.changes > 0)).sum()}")
# порядок классов по цене (сквозной ранг)
cls = ap[ap.fam.isin(["STOW", "OPOW", "SPOW"])].groupby(["route", "rbd"]).fare.median().reset_index()
cls["rank"] = cls.groupby("route").fare.rank(ascending=False)
cr = cls.groupby("rbd")["rank"].agg(["median", "size"]).sort_values("median"); print("ранг класса (1=дороже) в семьях ST/OP/SP:"); print(cr.T)

h("2. Тарифы 0 ₽")
z = t[t.fare == 0]
print(f"нулевых: {len(z)} ({len(z)/len(t):.1%})"); zb = z.basis.value_counts(); print(zb.head(15))
zr = z.groupby("route").size().rename("zero").to_frame().join(t.groupby("route").size().rename("all"))
zr["share"] = zr.zero / zr["all"]; print(zr.sort_values("zero", ascending=False).head(12).round(2)); save(zr, "zero_by_route.csv")
w = t[t.basis == "WOW"]
print(f"WOW: {len(w)}, с ненулевым тарифом {(w.fare > 0).sum()}, adj_fare>0 {(w.adj_fare > 0).sum()}, направлений {w.route.nunique()}, "
      f"медиана dtd {w.dtd.median():.0f}, доля продаж в день вылета {(w.dtd == 0).mean():.0%}")
wg = w.groupby(["flight", "fly_date", "deal_date"]).size(); print(f"WOW: билетов в одной (вылет, дата продажи) — медиана {wg.median():.0f}, макс {wg.max()}")

h("3. Фиксированная цена (субсидия?)")
rp = ap.groupby("route").fare.agg(levels="nunique", n="size", top=lambda x: x.value_counts(normalize=True).iloc[0], price="median")
fixed = rp[(rp.top >= .9) & (rp.n >= 30)].sort_values("n", ascending=False)
print(f"направлений (≥30 взрослых платных) с одной ценой ≥90% билетов: {len(fixed)}"); print(fixed.round(2)); save(rp, "route_fixed_price.csv")

h("4. Вариация цены во времени")
dm = ap.groupby(["flight", "fly_date", "dtd"]).fare.min().reset_index().sort_values(["flight", "fly_date", "dtd"], ascending=[1, 1, 0])
dm["prev"] = dm.groupby(["flight", "fly_date"]).fare.shift()
dm["chg"] = dm.prev.notna() & (dm.fare != dm.prev)
dm = dm.merge(dep[["flight", "fly_date", "route"]], on=["flight", "fly_date"])
dfl = dm.groupby(["flight", "fly_date"]).agg(route=("route", "first"), days=("fare", "size"), chg=("chg", "sum"), lv=("fare", "nunique"))
print(f"вылет-дней с продажей взрослым платным: {len(dm)}; доля дней, где мин. цена ≠ предыдущему дню продаж: {dm.chg.sum()/dm.prev.notna().sum():.0%}")
m2 = dfl[dfl.days >= 2]
print(f"вылетов с ≥2 днями продаж: {len(m2)}, из них с ≥1 сменой мин. цены: {(m2.chg > 0).mean():.0%}")
rv = dfl.groupby("route").agg(deps=("days", "size"), with_chg=("chg", lambda x: (x > 0).sum()))
print(f"направлений с хоть одной сменой: {(rv.with_chg > 0).sum()} из {len(rv)}"); save(dfl, "dep_price_variation.csv")
# естественные эксперименты: route × dtd, разные вылеты, разная мин. цена
dm["hb"] = pd.cut(dm.dtd, [-1, 3, 7, 14, 30, 60, 400], labels=["0-3", "4-7", "8-14", "15-30", "31-60", "61+"])
ne = dm.groupby(["route", "dtd"]).agg(deps=("fare", "size"), lv=("fare", "nunique"), cv=("fare", lambda x: x.std() / x.mean()))
ok = ne[ne.deps >= 3]
print(f"ячейки (направление, dtd) с ≥3 вылетами: {len(ok)}, из них с разными мин. ценами: {(ok.lv > 1).mean():.0%}, "
      f"медиана CV цены {ok.cv.median():.2f}")
print(ok.groupby(dm.groupby(['route','dtd']).hb.first().reindex(ok.index)).agg(cells=("lv", "size"), varied=("lv", lambda x: (x > 1).mean())).round(2))
save(ne, "natural_experiments.csv")

h("5. Качество")
key = ["flight", "fly_date", "deal_date", "basis", "fare"]
dup = t.duplicated(keep=False).sum(); print(f"полных дублей строк (без ID билета различить нельзя): {t.duplicated().sum()} лишних ({dup} строк в группах)")
print(f"dtd<0: {(t.dtd < 0).sum()}, dtd=0: {(t.dtd == 0).sum()} ({(t.dtd == 0).mean():.1%}), fare<0: {(t.fare < 0).sum()}, без направления: {(t.route.isna() | (t.route == '')).sum()}")
print(f"adj_fare≠fare: {(t.adj_fare != t.fare).mean():.1%}")
fl = dep[dep.fly_date <= cutoff]
cnt = t.groupby(["flight", "fly_date"]).size().rename("tix")
c = fl.set_index(["flight", "fly_date"]).join(cnt).fillna({"tix": 0})
c = c[c["load"] > 0]; c["diff"] = c.tix - c["load"]
print(f"улетевших вылетов с load>0: {len(c)}; билетов−load: медиана {c['diff'].median():.0f}, |diff|≤2: {(c['diff'].abs() <= 2).mean():.0%}, "
      f"билетов>load: {(c['diff'] > 2).mean():.0%}, билетов<load: {(c['diff'] < -2).mean():.0%}"); save(c, "tickets_vs_load.csv")
fd = t.groupby(["flight", "fly_date"]).agg(first_deal=("deal_date", "min"), maxdtd=("dtd", "max"), n=("fare", "size")).reset_index()
fd["m"] = fd.fly_date.dt.to_period("M")
fm = fd.groupby("m").agg(deps=("n", "size"), first_deal_min=("first_deal", "min"), maxdtd_med=("maxdtd", "median"), tix_med=("n", "median"))
print("полнота кривых по месяцу вылета:"); print(fm); save(fm, "curve_completeness.csv")
g = t.groupby(["flight", "fly_date", "deal_date", "basis"]).size()
print(f"групп ≥5 билетов одного кода в один день: {(g >= 5).sum()} ({g[g >= 5].sum()} билетов, {g[g >= 5].sum()/len(t):.1%}); ≥10: {(g >= 10).sum()}")
gb = g[g >= 5].reset_index().basis.value_counts().head(8); print(gb)
gp = g.reset_index(); gp = gp[(gp[0] >= 5)]; gpaid = gp[~gp.basis.eq("WOW")][0].sum(); print(f"из них платных/не WOW билетов: {gpaid}")

h("6. Что есть / чего нет")
for k, v in [("цена/код тарифа на момент покупки", "есть (fare, basis) — только для проданных"), ("дата брони/продажи", "есть deal_date (день, без времени)"),
             ("дата вылета", "есть"), ("ёмкость", "есть cap/seats на срез (не история)"), ("закрытые классы", "НЕТ — нет истории инвентаря"),
             ("предложенная, но не купленная цена", "НЕТ"), ("возвраты по билету", "НЕТ в tickets (в hist только число)"), ("конкуренты", "НЕТ")]:
    print(f"  {k}: {v}")
hist = pd.read_csv(os.path.join(D, "hist.csv"))
print(f"hist: {len(hist)} вылетов, group>0 у {(hist.group > 0).mean():.0%}, refunded/tickets {hist.refunded.sum()/max(1,hist.tickets.sum()):.1%}")
