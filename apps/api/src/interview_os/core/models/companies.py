"""Company-profile models — port of `companies/types.ts`."""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from ..skill_id import SkillId
from .interview import ModeId
from .shared import CamelModel

__all__ = [
    "COMPANY_DISCLAIMER",
    "MODE_ID_LIST",
    "CompanyBehavioralFramework",
    "CompanyEmphasis",
    "CompanyPackInfo",
    "CompanyProfile",
    "CompanyTypicalLoopStage",
]

# Soft mode ids used in profiles/packs — may name modes not currently loaded.
MODE_ID_LIST: tuple[str, ...] = (
    "technical",
    "coding",
    "system_design",
    "behavioral",
    "hiring_manager",
    "hr",
)

COMPANY_DISCLAIMER = (
    "Based on commonly reported public interview patterns; real loops vary by team, role and level."
)


class CompanyTypicalLoopStage(CamelModel):
    mode: ModeId
    label: str
    planned_questions: int = Field(gt=0)


class CompanyEmphasis(CamelModel):
    skill_id: SkillId
    weight: float = Field(ge=0, le=0.1)


class CompanyBehavioralFramework(CamelModel):
    name: str
    themes: list[str]
    guidance: str


class CompanyPackInfo(CamelModel):
    version: str
    kind: Literal["company"]
    sourced_count: int = Field(ge=0)
    community_count: int = Field(ge=0)


class CompanyProfile(CamelModel):
    """§9.3 built-in company interview profile — originally-written public patterns."""

    id: str
    name: str
    aliases: list[str] = Field(default_factory=list)
    disclaimer: str
    typical_loop: list[CompanyTypicalLoopStage]
    # Requirement importance boost (≤ 0.1 each) applied at persist time.
    emphasis: list[CompanyEmphasis]
    behavioral_framework: CompanyBehavioralFramework
    # Max follow-up chain depth under one main question.
    follow_up_depth: Literal[1, 2, 3]
    rubric_emphasis: dict[str, float] = Field(default_factory=dict)
    role_expectations: dict[str, list[str]] = Field(default_factory=dict)
    # v0.4: present when the profile was compiled from a company pack.
    pack: CompanyPackInfo | None = None
