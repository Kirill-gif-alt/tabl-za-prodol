"""Общий интерфейс базовых моделей ансамбля."""
from __future__ import annotations

import numpy as np


class BaseModel:
    """Модель прогноза итога пассажиров на вылете для ОДНОГО горизонта.

    fit(frame, horizon): frame — словарь из data.features.training_frame:
        X (DataFrame, колонки FEATURE_COLS), y (итог), booked, cap, H (N,28), V (N,8), meta.
    predict(frame): тот же словарь без y (так выглядит и кадр из inference_frames:
        «X», «H», «V» + добавьте «booked» = X.booked.values, «cap» = X.cap.values).
        Возвращает массив ИТОГОВЫХ пассажиров (float, может выходить за границы — клиппинг делает критик).
    Модель обязана переживать pickle/joblib и не падать на NaN во входе.
    """
    name = "base"

    def fit(self, frame: dict, horizon: str) -> "BaseModel":
        raise NotImplementedError

    def predict(self, frame: dict) -> np.ndarray:
        raise NotImplementedError


def as_frame(inf: dict) -> dict:
    """Элемент inference_frames[horizon] -> словарь в формате predict()."""
    X = inf["X"]
    return {"X": X, "H": inf["H"], "V": inf["V"], "booked": X["booked"].values, "cap": X["cap"].values}
