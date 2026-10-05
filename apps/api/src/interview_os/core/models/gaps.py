"""Gap models — port of `gaps/schema.ts`."""

from __future__ import annotations

from enum import StrEnum

from pydantic import Field

from ..skill_id import SkillId
from .shared import CamelModel

__all__ = ["Gap", "GapSeverity"]


class GapSeverity(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class Gap(CamelModel):
    skill_id: SkillId
    label: str
    importance: float = Field(ge=0, le=1)
    target_score: float = Field(ge=0, le=1)
    current_score: float | None = Field(default=None, ge=0, le=1)
    gap: float = Field(ge=0)
    uncertainty: float = Field(ge=0, le=1)
    severity: GapSeverity
    reason: str
