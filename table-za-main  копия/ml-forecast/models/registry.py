"""Список базовых моделей ансамбля. Импорт ленивый: пока файла нет, модель просто пропускается."""
from __future__ import annotations

import importlib
import logging

log = logging.getLogger(__name__)

# (модуль, класс) — имя модели в ансамбле = <name модели>_<горизонт> (например lgbm_7d)
MODEL_SPECS = [
    ("models.fallback", "HierarchicalMeanModel"),   # route -> OD -> global
    ("models.lgbm", "LGBMModel"),
    ("models.sequence", "SequenceModel"),
]


def default_models(seed: int = 0) -> list:
    out = []
    for mod, cls in MODEL_SPECS:
        try:
            out.append(getattr(importlib.import_module(mod), cls)(seed=seed))
        except Exception as e:   # модуль ещё не написан или нет библиотеки
            log.warning("модель %s.%s недоступна: %s", mod, cls, e)
    return out
