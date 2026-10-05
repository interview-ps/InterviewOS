"""Resume-review models — port of `resume/{index,ats}.ts`."""

from __future__ import annotations

from enum import StrEnum

from pydantic import Field

from .shared import CamelModel

__all__ = [
    "AtsCheck",
    "AtsCheckStatus",
    "AtsKeywordCoverage",
    "AtsKeywordMissing",
    "AtsKeywordPresent",
    "AtsResult",
    "ResumeAlignment",
    "ResumeGuard",
    "ResumeReview",
    "ResumeSuggestion",
    "ResumeTailoring",
]


class AtsCheckStatus(StrEnum):
    PASS = "pass"
    WARN = "warn"
    FAIL = "fail"


class AtsCheck(CamelModel):
    id: str
    label: str
    status: AtsCheckStatus
    detail: str
    weight: float


class AtsKeywordPresent(CamelModel):
    skill_id: str
    label: str
    # First resume line matching this skill's keywords, trimmed.
    snippet: str


class AtsKeywordMissing(CamelModel):
    skill_id: str
    label: str


class AtsKeywordCoverage(CamelModel):
    present: list[AtsKeywordPresent]
    missing: list[AtsKeywordMissing]


class AtsResult(CamelModel):
    # 0–100 weighted pass ratio (pass 1, warn 0.5, fail 0).
    score: int = Field(ge=0, le=100)
    checks: list[AtsCheck]
    keyword_coverage: AtsKeywordCoverage


class ResumeSuggestion(CamelModel):
    """§9.5: one guarded bullet-rewrite suggestion persisted in a review."""

    original: str
    improved: str
    rationale: str = ""
    skill_ids: list[str] = Field(default_factory=list)
    # Set when the no-invented-facts guard dropped this suggestion.
    dropped: str | None = None


class ResumeAlignment(CamelModel):
    requirement: str
    # Verbatim substring of the resume, or null when none exists.
    resume_evidence: str | None
    suggestion: str = ""


class ResumeTailoring(CamelModel):
    summary: str
    emphasize: list[str] = Field(default_factory=list)
    de_emphasize: list[str] = Field(default_factory=list)
    alignment: list[ResumeAlignment] = Field(default_factory=list)
    prep_gaps: list[str] = Field(default_factory=list)


class ResumeGuard(CamelModel):
    substitutions: int = Field(ge=0)
    dropped: int = Field(ge=0)


class ResumeReview(CamelModel):
    """§9.5: persisted `resume_reviews` row payload."""

    id: str
    candidate_id: str
    target_id: str | None
    ats: AtsResult
    suggestions: list[ResumeSuggestion]
    tailoring: ResumeTailoring | None
    # Requirement gap skill ids the tailoring prepGaps link to.
    linked_gap_skill_ids: list[str] = Field(default_factory=list)
    guard: ResumeGuard = Field(default_factory=lambda: ResumeGuard(substitutions=0, dropped=0))
    created_at: str
