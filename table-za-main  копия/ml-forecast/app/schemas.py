"""Схемы запроса и ответа API (pydantic v2). Тексты ошибок — по-русски."""
from __future__ import annotations

import re
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

DATE_RE = re.compile(r"^\d{2}\.\d{2}\.\d{4}$")
DATE_HINT = "должна быть в формате ДД.ММ.ГГГГ (например, 25.12.2025) и существовать в календаре"


def parse_flydate(value: str) -> date:
    """'DD.MM.YYYY' -> date. Бросает ValueError с русским текстом."""
    v = str(value).strip()
    if not DATE_RE.match(v):
        raise ValueError(DATE_HINT)
    try:
        d = datetime.strptime(v, "%d.%m.%Y").date()
    except ValueError:
        raise ValueError(DATE_HINT) from None
    if not 2000 <= d.year <= 2100:
        raise ValueError("год должен быть между 2000 и 2100")
    return d


def _no_bool(v):
    if isinstance(v, bool):
        raise ValueError("должно быть числом, а не true/false")
    return v


class PredictRequest(BaseModel):
    """Запрос прогноза от RMS."""
    model_config = ConfigDict(str_strip_whitespace=True, extra="ignore")

    reis: str = Field(..., min_length=1, max_length=16, description="Номер рейса, например KV-110")
    flydate: str = Field(..., description="Дата вылета ДД.ММ.ГГГГ")
    current_booked: float = Field(..., ge=0, allow_inf_nan=False, description="Сколько пассажиров продано сейчас")
    total_au: float = Field(..., gt=0, allow_inf_nan=False, description="Total AU — жёсткий потолок вместимости")
    dtd: int = Field(..., ge=0, le=180, description="Дней до вылета")

    @field_validator("flydate")
    @classmethod
    def _check_date(cls, v: str) -> str:
        parse_flydate(v)
        return v

    @field_validator("current_booked", "total_au", "dtd", mode="before")
    @classmethod
    def _reject_bool(cls, v):
        return _no_bool(v)

    @property
    def flydate_date(self) -> date:
        return parse_flydate(self.flydate)


class HorizonOut(BaseModel):
    pred: int = Field(..., description="Прогноз итога пассажиров на вылете")
    confidence: float = Field(..., ge=0, le=1, description="Уверенность 0..1")


class CriticOut(BaseModel):
    ok: bool
    chosen_model: str
    flags: list[str] = Field(default_factory=list)


class PredictResponse(BaseModel):
    reis: str
    flydate: str
    horizons: dict[str, HorizonOut]
    critic: CriticOut


class RetrainRequest(BaseModel):
    """Необязательное тело для /retrain и /incremental."""
    model_config = ConfigDict(extra="ignore")

    force: bool = Field(False, description="Обучить заново, даже если входные файлы не менялись")
    synthetic: bool = Field(False, description="Учить на синтетике (демо), если боевых файлов нет")



class BatchRequest(BaseModel):
    """Пачка запросов (окно сравнения моделей в сайте). Каждый элемент проверяется отдельно."""
    model_config = ConfigDict(extra="ignore")

    items: list[dict] = Field(..., min_length=1, max_length=500, description="Список запросов как в /predict")
