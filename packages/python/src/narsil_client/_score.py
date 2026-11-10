from __future__ import annotations

import math
from typing import Any

from pydantic import (
    SerializerFunctionWrapHandler,
    ValidationInfo,
    field_serializer,
    field_validator,
    model_serializer,
)

from narsil_client._model import ApiModel


class ScoredHitModel(ApiModel):
    @field_validator("score", mode="before", check_fields=False)
    @classmethod
    def decode_score(cls, value: Any, info: ValidationInfo) -> int | float:
        if isinstance(value, str) and value in ("NaN", "Infinity", "-Infinity"):
            return float(value)
        if isinstance(value, int | float) and not isinstance(value, bool):
            try:
                finite = math.isfinite(value)
            except OverflowError:
                finite = False
            if finite or (info.mode == "python" and isinstance(value, float)):
                return value
        raise ValueError("A score must be a float64 number or an exact non-finite score token")

    @field_serializer("score", when_used="json", check_fields=False)
    def encode_score(self, value: int | float | None) -> int | float | str | None:
        if value is None or math.isfinite(value):
            return value
        if math.isnan(value):
            return "NaN"
        return "Infinity" if value > 0 else "-Infinity"

    @model_serializer(mode="wrap")
    def omit_absent_score(self, handler: SerializerFunctionWrapHandler) -> dict[str, Any]:
        encoded: dict[str, Any] = handler(self)
        if encoded.get("score") is None:
            encoded.pop("score", None)
        return encoded
