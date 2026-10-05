"""Preparation models — port of `preparation/index.ts` and `resources.ts`."""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated

from pydantic import AfterValidator, Field, StringConstraints

from ..skill_id import SkillId
from .shared import CamelModel

__all__ = [
    "HttpsUrl",
    "PracticeRecord",
    "PrepAction",
    "PrepActionStatus",
    "PrepResource",
    "PrepResourceKind",
    "PreparationState",
]


def _require_https(value: str) -> str:
    """https only — no arbitrary schemes reach the UI."""

    if not value.startswith("https://"):
        raise ValueError("URLs must be https")
    return value


HttpsUrl = Annotated[str, StringConstraints(max_length=2000), AfterValidator(_require_https)]


class PrepResourceKind(StrEnum):
    DOCS = "docs"
    EXPLANATION = "explanation"
    PRACTICE = "practice"
    ARTICLE = "article"
    VIDEO = "video"


class PrepResource(CamelModel):
    """A learning resource attached to a preparation action."""

    skill_id: SkillId
    title: str = Field(min_length=1, max_length=200)
    url: HttpsUrl | None = None
    summary: str | None = Field(default=None, max_length=600)
    kind: PrepResourceKind
    # "builtin" | "pack:<id>" | "plugin:<id>" — where the resource came from.
    source: str = Field(min_length=1, max_length=120)


class PrepActionStatus(StrEnum):
    OPEN = "open"
    IN_PROGRESS = "in_progress"
    DONE = "done"
    SUPERSEDED = "superseded"


class PrepAction(CamelModel):
    id: str
    skill_id: SkillId
    priority: float
    reason: str
    action: str
    success_criteria: list[str] = Field(default_factory=list)
    status: PrepActionStatus = PrepActionStatus.OPEN
    created_at: str
    source_evidence_ids: list[str] = Field(default_factory=list)


class PracticeRecord(CamelModel):
    id: str
    skill_id: SkillId
    action_id: str | None = None
    note: str
    score: float | None = Field(default=None, ge=0, le=1)
    created_at: str


class PreparationState(CamelModel):
    priorities: list[SkillId] = Field(default_factory=list)
    completed_topics: list[str] = Field(default_factory=list)
    next_actions: list[PrepAction] = Field(default_factory=list)
    practice_history: list[PracticeRecord] = Field(default_factory=list)
