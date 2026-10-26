"""Критик: журнал недавних ошибок моделей и итоговый вердикт по прогнозу.

ErrorLedger — кольцевой буфер ошибок (модель, горизонт, рейс, направление), из которого берётся «недавний MAE»
с иерархическим запасным уровнем рейс -> направление (OD) -> всё вместе.
Critic.review — выбирает модель, отбрасывает мусор, ограничивает прогноз [продано, Total AU] и считает
уверенность. review НИКОГДА не бросает исключений.

Единицы: abs_err — в пассажирах, pct_err — в процентах (100 * |err| / y), None если y == 0.
"""
from __future__ import annotations

import logging
import math
import numbers
import threading
from collections import deque
from dataclasses import dataclass, field
from itertools import islice

log = logging.getLogger(__name__)

# Предельные «здравые» значения: всё, что больше, считаем мусором на входе
SANE_LIMIT = 1e6
# Минимум записей на уровне иерархии, чтобы ему доверять
MIN_REIS = 5
MIN_OD = 10


def _num(x) -> float | None:
    """Конечное вещественное число или None (строки, bool, NaN, Inf, None, огромные числа -> None)."""
    try:
        if isinstance(x, bool) or not isinstance(x, numbers.Real):
            return None
        v = float(x)
    except (OverflowError, ValueError, TypeError):
        return None
    return v if math.isfinite(v) else None


def _when_str(when) -> str | None:
    if when is None:
        return None
    try:
        return when.isoformat()
    except AttributeError:
        return str(when)


# ====================================================================== журнал ошибок

class ErrorLedger:
    """Кольцевой буфер ошибок. Запись: (model, horizon, reis, od, abs_err, pct_err, when, key).

    key — необязательный ключ идемпотентности (например (reis, flydate, horizon, model)):
    запись с уже виденным ключом не добавляется повторно.
    """

    def __init__(self, maxlen: int = 20000):
        self.maxlen = max(int(maxlen), 1)
        self._buf: deque = deque()
        self._idx: dict = {}          # (model, horizon) -> deque записей этой пары (в порядке добавления)
        self._keys: set = set()
        self._lock = threading.RLock()

    # ---- запись
    def record(self, model, horizon, reis, od, abs_err, pct_err=None, when=None, key=None) -> bool:
        """Добавить ошибку. Возвращает False, если запись отброшена (дубль ключа или нечисловая ошибка)."""
        a = _num(abs_err)
        if a is None or a < 0:
            return False
        p = _num(pct_err)
        k = tuple(str(x) for x in key) if key is not None else None
        rec = (str(model), str(horizon), None if reis is None else str(reis), None if od is None else str(od),
               a, p, _when_str(when), k)
        with self._lock:
            if k is not None:
                if k in self._keys:
                    return False
                self._keys.add(k)
            self._buf.append(rec)
            self._idx.setdefault((rec[0], rec[1]), deque()).append(rec)
            while len(self._buf) > self.maxlen:
                self._evict()
        return True

    def _evict(self):
        old = self._buf.popleft()
        dq = self._idx.get((old[0], old[1]))
        if dq:
            dq.popleft()          # самая старая запись пары — она же самая старая в своей очереди
            if not dq:
                del self._idx[(old[0], old[1])]
        if old[7] is not None:
            self._keys.discard(old[7])

    def has(self, key) -> bool:
        k = tuple(str(x) for x in key)
        with self._lock:
            return k in self._keys

    def __len__(self):
        return len(self._buf)

    # ---- чтение
    def stats(self, model, horizon, reis=None, od=None, window: int = 200):
        """(mae, n, уровень) по иерархии reis -> od -> global. Нет данных -> (None, 0, None)."""
        window = max(int(window), 1)
        reis = None if reis is None else str(reis)
        od = None if od is None else str(od)
        with self._lock:
            dq = self._idx.get((str(model), str(horizon)))
            if not dq:
                return None, 0, None
            levels = []
            if reis is not None:
                levels.append(("reis", 2, reis, MIN_REIS))
            if od is not None:
                levels.append(("od", 3, od, MIN_OD))
            for name, pos, val, min_n in levels:
                vals = []
                for r in reversed(dq):
                    if r[pos] == val:
                        vals.append(r[4])
                        if len(vals) >= window:
                            break
                if len(vals) >= min_n:
                    return sum(vals) / len(vals), len(vals), name
            vals = [r[4] for r in islice(reversed(dq), window)]
        return (sum(vals) / len(vals), len(vals), "global") if vals else (None, 0, None)

    def recent_mae(self, model, horizon, reis=None, od=None, window: int = 200):
        """Недавний MAE модели на горизонте; запасной уровень reis -> od -> global. Нет ошибок -> None."""
        return self.stats(model, horizon, reis, od, window)[0]

    # ---- сериализация (JSON-совместимая)
    def to_dict(self) -> dict:
        with self._lock:
            recs = [[r[0], r[1], r[2], r[3], r[4], r[5], r[6], list(r[7]) if r[7] is not None else None]
                    for r in self._buf]
        return {"version": 1, "maxlen": self.maxlen, "records": recs}

    @classmethod
    def from_dict(cls, d: dict) -> "ErrorLedger":
        led = cls(int((d or {}).get("maxlen", 20000)))
        for r in (d or {}).get("records", []):
            try:
                led.record(r[0], r[1], r[2], r[3], r[4], r[5], r[6], key=r[7])
            except Exception as e:      # битая запись не должна ронять загрузку
                log.warning("запись журнала ошибок пропущена: %s", e)
        return led

    def __reduce__(self):                # замок не пиклится — собираем объект из словаря
        return (ErrorLedger.from_dict, (self.to_dict(),))


# ====================================================================== вердикт и критик

@dataclass
class Verdict:
    pred: int
    chosen_model: str
    flags: list = field(default_factory=list)
    ok: bool = True
    confidence: float = 0.5
    interval: tuple = (0, 0)

    def to_dict(self) -> dict:
        return {"pred": self.pred, "chosen_model": self.chosen_model, "flags": list(self.flags),
                "ok": self.ok, "confidence": self.confidence, "interval": list(self.interval)}


# множители уверенности за флаги
_FLAG_PENALTY = {"fallback_model": 0.85, "sparse_route": 0.85, "far_from_horizon": 0.85,
                 "clipped_to_capacity": 0.9, "clipped_to_booked": 0.9, "total_au_below_booked": 0.5}


class Critic:
    def __init__(self, ledger: ErrorLedger | None = None):
        self.ledger = ledger if ledger is not None else ErrorLedger()

    # ------------------------------------------------------------------
    def review(self, horizon, preds, current_booked, total_au, dtd=None, reis=None, od=None,
               distance=0) -> Verdict:
        try:
            return self._review(horizon, preds, current_booked, total_au, dtd, reis, od, distance)
        except Exception as e:           # критик не имеет права падать
            log.exception("критик: сбой при проверке (%s)", e)
            b = _num(current_booked)
            b = int(round(b)) if b is not None and 0 <= b <= SANE_LIMIT else 0
            return Verdict(pred=b, chosen_model=f"booked_{horizon}", flags=["critic_error"], ok=False,
                           confidence=0.05, interval=(b, b))

    # ------------------------------------------------------------------
    def _review(self, horizon, preds, current_booked, total_au, dtd, reis, od, distance) -> Verdict:
        flags: list[str] = []
        ok = True

        # ---- входы
        booked = _num(current_booked)
        if booked is None or booked < 0 or booked > SANE_LIMIT:
            flags.append("bad_input:current_booked")
            ok = False
            booked = 0.0
        cap = _num(total_au)
        if cap is not None and (cap < 0 or cap > SANE_LIMIT):
            cap = None
        if cap is None:
            flags.append("bad_input:total_au")
            ok = False
        elif cap < booked:
            flags.append("total_au_below_booked")
            ok = False
        elif cap == 0:
            flags.append("total_au_zero")
            ok = False
        dist = _num(distance)
        dist = max(dist, 0.0) if dist is not None else 0.0
        if dist > 3:
            flags.append("far_from_horizon")

        # ---- кандидаты
        cands: dict[str, float] = {}
        if not isinstance(preds, dict):
            if preds is not None:
                flags.append("bad_input:preds")
            preds = {}
        for k, v in preds.items():
            name = str(k)
            x = _num(v)
            if x is None:
                flags.append(f"non_finite_model:{name}")
            elif x < 0:
                flags.append(f"negative_model:{name}")
            else:
                cands[name] = x

        # ---- ранжирование по недавнему MAE (reis -> od -> global)
        info = {n: self.ledger.stats(n, horizon, reis, od) for n in cands}

        def rank_key(n):
            mae = info[n][0]
            prio = 0 if n == "ensemble" else 1 if n == "hmean" else 2
            return (mae if mae is not None else math.inf, prio, n)

        order = sorted(cands, key=rank_key)

        def implausible(p):
            if cap is not None and cap > 0 and p > 1.5 * cap + 2:
                return True
            return p < 0.5 * booked - 2

        chosen = next((n for n in order if not implausible(cands[n])), None)
        if chosen is not None and chosen != order[0]:
            flags.append("fallback_model")

        # ---- итоговое значение
        fell_to_booked = chosen is None
        if fell_to_booked:
            raw = booked
            chosen_name = "booked"
            ok = False
            mae, level = None, None
        else:
            raw = cands[chosen]
            chosen_name = chosen
            mae, _, level = info[chosen]
        if cap is not None and cap < booked:
            raw, chosen_name, fell_to_booked, ok = booked, "booked", True, False
            mae, level = None, None
        if level in ("od", "global"):
            flags.append("sparse_route")

        lo_int = math.ceil(booked - 1e-9)
        hi_int = math.floor(cap + 1e-9) if cap is not None else int(SANE_LIMIT)
        hi_int = max(hi_int, lo_int)
        p = raw
        if cap is not None and cap >= booked and p > cap + 0.5:
            flags.append("clipped_to_capacity")
        if p < booked - 0.5:
            flags.append("clipped_to_booked")
        pred = int(min(max(round(p), lo_int), hi_int))

        # ---- интервал
        if fell_to_booked:
            lo, hi = (pred, hi_int) if (cap is not None and cap >= booked) else (pred, pred)
        else:
            width = 1.6 * mae * (1 + 0.1 * dist) if mae is not None else max(2.0, 0.15 * pred)
            lo = int(max(lo_int, min(pred, math.floor(pred - width))))
            hi = int(min(hi_int, max(pred, math.ceil(pred + width))))

        # ---- уверенность: падает с distance и с относительным недавним MAE
        scale = max(pred - booked, 0.1 * (cap if cap is not None else pred), 1.0)
        err_factor = 1.0 / (1.0 + 2.0 * mae / scale) if mae is not None else 0.7
        conf = 0.97 * math.exp(-0.10 * dist) * err_factor
        for f in flags:
            conf *= _FLAG_PENALTY.get(f, 0.9 if f.startswith(("non_finite_model", "negative_model")) else 1.0)
        if fell_to_booked:
            conf *= 0.4
        if not ok:
            conf *= 0.7
        conf = float(min(max(conf, 0.05), 0.99))

        # дубли флагов убираем, порядок сохраняем
        flags = list(dict.fromkeys(flags))
        return Verdict(pred=pred, chosen_model=f"{chosen_name}_{horizon}", flags=flags, ok=ok,
                       confidence=round(conf, 4), interval=(lo, hi))
