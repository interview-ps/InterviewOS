"""Assessment models — port of `assessment/index.ts`."""

from __future__ import annotations

from enum import StrEnum
from typing import Any

from pydantic import Field

from ..skill_id import SkillId
from .gaps import Gap
from .readiness import SkillReadiness
from .shared import CamelModel

__all__ = [
    "AnswerEvaluation",
    "AssessedItem",
    "AssessmentState",
    "DesignUpdate",
    "DesignUpdateStatus",
    "EvaluationDimension",
    "EvaluationDimensions",
    "EvaluationStrength",
    "EvaluationWeakness",
    "RubricScore",
    "SkillScore",
    "StarAssessment",
    "WeaknessSeverity",
]


class EvaluationDimension(CamelModel):
    score: float = Field(ge=0, le=1)
    rationale: str


class StarAssessment(CamelModel):
    """STAR coverage for behavioral/hr answers (§8.4); null for other rounds."""

    situation: bool
    task: bool
    action: bool
    result: bool
    notes: str


class RubricScore(CamelModel):
    """§9.1: one independently-scored rubric dimension of an interview mode."""

    id: str
    label: str = ""
    score: float = Field(ge=0, le=1)
    rationale: str = ""


class DesignUpdateStatus(StrEnum):
    NOT_COVERED = "not_covered"
    PARTIAL = "partial"
    COVERED = "covered"


class DesignUpdate(CamelModel):
    """§9.1: evaluator's per-dimension status update.

    Deprecated: new modes should emit opaque payloads under `modeSignals`
    (e.g. `modeSignals.designUpdates`); kept for stored rows and older plugins.
    """

    dimension: str
    status: DesignUpdateStatus
    notes: str = ""


class EvaluationDimensions(CamelModel):
    correctness: EvaluationDimension
    technical_depth: EvaluationDimension
    reasoning: EvaluationDimension
    structure: EvaluationDimension
    communication: EvaluationDimension
    evidence: EvaluationDimension
    role_relevance: EvaluationDimension


class EvaluationStrength(CamelModel):
    skill: SkillId
    evidence: str


class WeaknessSeverity(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class EvaluationWeakness(CamelModel):
    skill: SkillId
    severity: WeaknessSeverity
    evidence: str


class SkillScore(CamelModel):
    skill: SkillId
    score: float = Field(ge=0, le=1)
    confidence: float = Field(ge=0, le=1)


class AnswerEvaluation(CamelModel):
    summary: str
    dimensions: EvaluationDimensions
    strengths: list[EvaluationStrength]
    weaknesses: list[EvaluationWeakness]
    scores: list[SkillScore]
    missing_concepts: list[str]
    better_approach: str
    follow_up_topics: list[str]
    star: StarAssessment | None = Field(default=None, json_schema_extra={"emit_null": True})
    # §9.1 mode rubric — exactly the mode's rubric ids (empty for "mixed").
    rubric: list[RubricScore] = Field(default_factory=list)
    # Deprecated: prefer `modeSignals.designUpdates`.
    design_updates: list[DesignUpdate] | None = Field(
        default=None, json_schema_extra={"emit_null": True}
    )
    # v1.1: opaque per-mode signal payload the evaluator may emit. The host
    # drops payloads over 8 KB of JSON (logged, never persisted).
    mode_signals: dict[str, Any] | None = Field(
        default=None, json_schema_extra={"emit_null": True}
    )


class AssessedItem(CamelModel):
    skill_id: SkillId
    note: str
    evidence_ids: list[str] = Field(default_factory=list)


class AssessmentState(CamelModel):
    strengths: list[AssessedItem] = Field(default_factory=list)
    gaps: list[Gap] = Field(default_factory=list)
    weak_answers: list[AssessedItem] = Field(default_factory=list)
    strong_answers: list[AssessedItem] = Field(default_factory=list)
    observations: list[str] = Field(default_factory=list)
    skill_assessments: dict[str, SkillReadiness] = Field(default_factory=dict)
