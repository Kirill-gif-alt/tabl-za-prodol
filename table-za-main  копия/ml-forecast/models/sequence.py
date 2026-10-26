"""Модель по последовательностям: горизонтальная кривая H (28 дней продаж), вертикальная V (8 прошлых вылетов
того же рейса на тот же DTD) и статические признаки FEATURE_COLS (без h_n_reis). Цель — остаток (y - booked) / масштаб.

Выбор ветки автоматический (backend="auto"), интерфейс один, имя "seq":
  * torch есть  -> GRU по H и по V, их финальные состояния + MLP по статике (ветка `_fit_torch`);
  * torch нет   -> запасная ветка на sklearn: MLPRegressor по склеенным [log1p(H), log1p(V), статика] с
                   StandardScaler и ансамблем из нескольких инициализаций (ветка `_fit_sklearn`).

ВНИМАНИЕ: в среде разработки torch НЕ установлен, ветка torch (`_fit_torch`, `_predict_torch`, `_build_net`)
написана по документации и здесь не запускалась и не проверялась. Проверена только запасная ветка sklearn.
Ранняя остановка в обеих ветках — по хвосту выборки во времени (meta.as_of), а не случайная.
Модель переживает pickle/joblib: веса torch хранятся как numpy-массивы, сеть пересобирается лениво.
"""
from __future__ import annotations

import copy
import logging
import warnings

import numpy as np

from data.features import FEATURE_COLS, SEQ_H, SEQ_V
from .fallback import finish, n_rows, num, time_split

log = logging.getLogger(__name__)

N_SKLEARN_NETS = 3     # сколько инициализаций MLP усредняем
MAX_EPOCHS = 60
PATIENCE = 6
# h_n_reis растёт со временем (число прошлых вылетов рейса): нейросеть экстраполирует его и ошибается
# на более поздних датах (на синтетике MAE 30d: 18.2 -> 8.9 без него), поэтому в статику не берём.
DROP_STATIC = ("h_n_reis",)
STATIC_COLS = [c for c in FEATURE_COLS if c not in DROP_STATIC]


def torch_available() -> bool:
    """Есть ли torch (импорт только здесь и в ветке torch, внутри try/except)."""
    try:
        import torch  # noqa: F401
        return True
    except Exception:
        return False


def _one_thread():
    """Один поток BLAS на время обучения маленького MLP (быстрее и не душит общую машину)."""
    try:
        from threadpoolctl import threadpool_limits
        return threadpool_limits(limits=1)
    except Exception:
        import contextlib
        return contextlib.nullcontext()


class SequenceModel:
    """seq: нейросеть по H, V и статике (torch GRU либо sklearn MLP)."""
    name = "seq"

    def __init__(self, seed: int = 0, backend: str = "auto", n_nets: int | None = None,
                 max_epochs: int | None = None):
        self.seed = seed
        self.backend = backend            # "auto" | "torch" | "sklearn"
        # None -> значения модуля на момент обучения (их подменяют в быстрых тестах)
        self.n_nets = n_nets              # sklearn: сколько MLP усредняем
        self.max_epochs = max_epochs
        self.backend_used_ = None
        self.horizon = None
        self.scale_ = 1.0
        self.const_ = 0.0
        self.imputer_ = None
        self.scaler_ = None
        self.nets_ = []                    # sklearn: список MLPRegressor
        self.torch_state_ = None           # torch: {"states": [dict numpy], "meta": ...}
        self._tnets = None                 # кэш собранных torch-сетей (не пиклится)

    def __getstate__(self):
        d = self.__dict__.copy()
        d["_tnets"] = None
        return d

    # ------------------------------------------------------------------ данные
    @staticmethod
    def _seqs(frame: dict):
        n = n_rows(frame)
        H = frame.get("H")
        V = frame.get("V")
        H = np.zeros((n, SEQ_H)) if H is None or len(H) != n else np.asarray(H, dtype=float)
        V = np.zeros((n, SEQ_V)) if V is None or len(V) != n else np.asarray(V, dtype=float)
        H = np.clip(np.nan_to_num(H, nan=0.0, posinf=0.0, neginf=0.0), 0, None)
        V = np.clip(np.nan_to_num(V, nan=0.0, posinf=0.0, neginf=0.0), 0, None)
        return H, V

    @staticmethod
    def _static(frame: dict) -> np.ndarray:
        """Статика: FEATURE_COLS без DROP_STATIC (NaN остаются — их заполнит imputer)."""
        X = frame["X"]
        cols = [np.asarray(X[c].values, dtype=float) if c in X.columns else np.full(len(X), np.nan)
                for c in STATIC_COLS]
        S = np.column_stack(cols)
        S[~np.isfinite(S)] = np.nan
        return S

    def _design(self, frame: dict):
        """Склеенная матрица для sklearn: log1p(H), log1p(V), V относительно booked, статика."""
        H, V = self._seqs(frame)
        booked = np.maximum(num(frame, "booked"), 0.0)
        cap = np.maximum(num(frame, "cap", 1.0), 1.0)
        Vrel = V / (booked[:, None] + 1.0)
        Hn = H / cap[:, None] * 10
        return np.column_stack([np.log1p(H), Hn, np.log1p(V), np.log1p(Vrel), self._static(frame)])

    # ------------------------------------------------------------------ обучение
    def fit(self, frame: dict, horizon: str):
        self.horizon = horizon
        self.nets_, self.torch_state_, self._tnets = [], None, None
        n = n_rows(frame)
        booked = np.maximum(num(frame, "booked"), 0.0)
        y = np.asarray(frame["y"], dtype=float) if frame.get("y") is not None else booked
        ok = np.isfinite(y)
        if n == 0 or ok.sum() < 50:
            self.const_ = float(np.maximum(y[ok] - booked[ok], 0).mean()) if ok.any() else 0.0
            self.backend_used_ = "const"
            return self
        r = np.where(ok, np.maximum(y - booked, 0.0), 0.0)
        self.scale_ = float(max(np.std(r[ok]), 1.0))
        tr, va = time_split(frame)
        tr = tr[ok[tr]]
        if va is not None:
            va = va[ok[va]]
        use_torch = self.backend == "torch" or (self.backend == "auto" and torch_available())
        if use_torch:
            try:
                self._fit_torch(frame, r, tr, va)
                self.backend_used_ = "torch"
                return self
            except Exception as e:     # любой сбой torch -> запасная ветка
                log.warning("seq: ветка torch упала (%s), используем sklearn", e)
        self._fit_sklearn(frame, r, tr, va)
        self.backend_used_ = "sklearn"
        return self

    # ---- sklearn
    def _fit_sklearn(self, frame, r, tr, va):
        from sklearn.impute import SimpleImputer
        from sklearn.neural_network import MLPRegressor
        from sklearn.preprocessing import StandardScaler
        D = self._design(frame)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            self.imputer_ = SimpleImputer(strategy="median", keep_empty_features=True).fit(D[tr])
            Z = self.imputer_.transform(D)
            self.scaler_ = StandardScaler().fit(Z[tr])
            Z = np.clip(self.scaler_.transform(Z), -8, 8)
            t = r / self.scale_
            with _one_thread():
                for k in range(self.n_nets or N_SKLEARN_NETS):
                    self.nets_.append(self._train_mlp(Z, t, tr, va, self.seed * 1000 + k, MLPRegressor,
                                                      self.max_epochs or MAX_EPOCHS))

    @staticmethod
    def _train_mlp(Z, t, tr, va, seed, MLPRegressor, max_epochs=MAX_EPOCHS):
        """MLP с ручной ранней остановкой по хвосту во времени (partial_fit по эпохам)."""
        rng = np.random.default_rng(seed)
        net = MLPRegressor(hidden_layer_sizes=(128, 64), activation="relu", alpha=1e-3, batch_size=256,
                           learning_rate_init=2e-3, random_state=seed)
        best, best_net, bad = np.inf, None, 0
        for ep in range(max_epochs):
            perm = rng.permutation(tr)
            for i in range(0, len(perm), 2048):          # крупные куски; внутри partial_fit — один шаг на кусок
                b = perm[i:i + 2048]
                net.partial_fit(Z[b], t[b])
            if va is None:
                continue
            err = float(np.abs(net.predict(Z[va]) - t[va]).mean())
            if err < best - 1e-4:
                best, best_net, bad = err, copy.deepcopy(net), 0
            else:
                bad += 1
                if bad >= PATIENCE:
                    break
        if va is None:
            return net
        return best_net if best_net is not None else net

    # ---- torch (НЕ ПРОВЕРЕНО в среде без torch)
    @staticmethod
    def _build_net(n_static: int, hidden: int = 32):
        import torch
        from torch import nn

        class Net(nn.Module):
            def __init__(self):
                super().__init__()
                self.gru_h = nn.GRU(input_size=1, hidden_size=hidden, batch_first=True)
                self.gru_v = nn.GRU(input_size=1, hidden_size=hidden // 2, batch_first=True)
                self.stat = nn.Sequential(nn.Linear(n_static, 64), nn.ReLU())
                self.head = nn.Sequential(nn.Linear(hidden + hidden // 2 + 64, 64), nn.ReLU(),
                                          nn.Dropout(0.1), nn.Linear(64, 1))

            def forward(self, h, v, s):
                _, hh = self.gru_h(h)          # hh: (1, B, hidden)
                _, hv = self.gru_v(v)
                z = torch.cat([hh[-1], hv[-1], self.stat(s)], dim=1)
                return self.head(z).squeeze(1)

        return Net()

    def _torch_inputs(self, frame):
        H, V = self._seqs(frame)
        S = self._static(frame)
        S = self.scaler_.transform(self.imputer_.transform(S))
        S = np.clip(S, -8, 8).astype(np.float32)
        return (np.log1p(H)[:, :, None].astype(np.float32), np.log1p(V)[:, :, None].astype(np.float32), S)

    def _fit_torch(self, frame, r, tr, va):
        import torch
        from sklearn.impute import SimpleImputer
        from sklearn.preprocessing import StandardScaler
        S0 = self._static(frame)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            self.imputer_ = SimpleImputer(strategy="median", keep_empty_features=True).fit(S0[tr])
            self.scaler_ = StandardScaler().fit(self.imputer_.transform(S0)[tr])
        Ht, Vt, St = (torch.from_numpy(a) for a in self._torch_inputs(frame))
        yt = torch.from_numpy((r / self.scale_).astype(np.float32))
        torch.set_num_threads(4)
        states = []
        for k in range(2):
            seed = self.seed * 1000 + k
            torch.manual_seed(seed)
            gen = torch.Generator().manual_seed(seed)
            net = self._build_net(St.shape[1])
            opt = torch.optim.Adam(net.parameters(), lr=2e-3, weight_decay=1e-5)
            loss_fn = torch.nn.HuberLoss(delta=1.0)
            tri = torch.from_numpy(tr)
            best, best_state, bad = np.inf, None, 0
            for ep in range(40):
                net.train()
                perm = tri[torch.randperm(len(tri), generator=gen)]
                for i in range(0, len(perm), 256):
                    b = perm[i:i + 256]
                    opt.zero_grad()
                    loss = loss_fn(net(Ht[b], Vt[b], St[b]), yt[b])
                    loss.backward()
                    opt.step()
                if va is None:
                    continue
                net.eval()
                with torch.no_grad():
                    vi = torch.from_numpy(va)
                    err = float((net(Ht[vi], Vt[vi], St[vi]) - yt[vi]).abs().mean())
                if err < best - 1e-4:
                    best, bad = err, 0
                    best_state = {kk: vv.detach().cpu().numpy().copy() for kk, vv in net.state_dict().items()}
                else:
                    bad += 1
                    if bad >= PATIENCE:
                        break
            if best_state is None:
                best_state = {kk: vv.detach().cpu().numpy().copy() for kk, vv in net.state_dict().items()}
            states.append(best_state)
        self.torch_state_ = {"states": states, "n_static": int(St.shape[1])}

    def _predict_torch(self, frame) -> np.ndarray:
        import torch
        if self._tnets is None:
            nets = []
            for st in self.torch_state_["states"]:
                net = self._build_net(self.torch_state_["n_static"])
                net.load_state_dict({k: torch.from_numpy(v) for k, v in st.items()})
                net.eval()
                nets.append(net)
            self._tnets = nets
        h, v, s = (torch.from_numpy(a) for a in self._torch_inputs(frame))
        with torch.no_grad():
            return np.mean([net(h, v, s).numpy() for net in self._tnets], axis=0)

    # ------------------------------------------------------------------ прогноз
    def _resid(self, frame: dict) -> np.ndarray:
        n = n_rows(frame)
        if self.backend_used_ == "torch" and self.torch_state_ is not None:
            z = self._predict_torch(frame)
        elif self.nets_:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                Z = np.clip(self.scaler_.transform(self.imputer_.transform(self._design(frame))), -8, 8)
                z = np.mean([m.predict(Z) for m in self.nets_], axis=0)
        else:
            return np.full(n, self.const_)
        return np.maximum(np.nan_to_num(z * self.scale_, nan=0.0, posinf=0.0, neginf=0.0), 0.0)

    def predict(self, frame: dict) -> np.ndarray:
        if n_rows(frame) == 0:
            return np.zeros(0)
        booked = np.maximum(num(frame, "booked"), 0.0)
        return finish(booked + self._resid(frame), booked, num(frame, "cap", np.inf))
