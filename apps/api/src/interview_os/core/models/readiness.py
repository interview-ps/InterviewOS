"""Readiness graph models — port of `readiness/schema.ts`."""

from __future__ import annotations

from enum import StrEnum

from pydantic import Field

from ..skill_id import SkillId
from .shared import CamelModel

__all__ = [
    "Evidence",
    "EvidenceType",
    "ReadinessGraph",
    "ReadinessStatus",
    "SkillReadiness",
]


class EvidenceType(StrEnum):
    RESUME_CLAIM = "resume_claim"
    INTERVIEW_ANSWER = "interview_answer"
    PRACTICE = "practice"
    SELF_REPORT = "self_report"
    PLUGIN = "plugin"


class Evidence(CamelModel):
    id: str
    skill_id: SkillId
    type: EvidenceType
    score: float = Field(ge=0, le=1)
    confidence: float = Field(ge=0, le=1)
    observation: str
    session_id: str | None = None
    question_id: str | None = None
    # e.g. "plugin:<id>" — where the evidence came from.
    source: str | None = None
    created_at: str


class ReadinessStatus(StrEnum):
    UNKNOWN = "unknown"
    WEAK = "weak"
    DEVELOPING = "developing"
    STRONG = "strong"


class SkillReadiness(CamelModel):
    skill_id: SkillId
    label: str
    score: float | None = Field(default=None, ge=0, le=1)
    confidence: float = Field(ge=0, le=1)
    evidence_ids: list[str] = Field(default_factory=list)
    children: list[SkillId] = Field(default_factory=list)
    status: ReadinessStatus


class ReadinessGraph(CamelModel):
    overall: float = Field(ge=0, le=1)
    overall_confidence: float = Field(ge=0, le=1)
    dimensions: dict[str, SkillReadiness] = Field(default_factory=dict)
    last_updated: str
