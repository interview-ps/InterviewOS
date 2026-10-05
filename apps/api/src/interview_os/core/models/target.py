"""Target role models — port of `target/index.ts`."""

from __future__ import annotations

from enum import StrEnum

from pydantic import Field

from ..skill_id import SkillId
from .shared import CamelModel

__all__ = ["CompanyNotesProfile", "Level", "Requirement", "TargetRole"]


class Level(StrEnum):
    JUNIOR = "junior"
    MID = "mid"
    SENIOR = "senior"
    STAFF = "staff"


class RequirementKind(StrEnum):
    REQUIRED = "required"
    PREFERRED = "preferred"


class Requirement(CamelModel):
    skill_id: SkillId
    label: str
    importance: float = Field(ge=0, le=1)
    # JD-analyzer importance before any boosts — boosts recompute from it (§9.3).
    base_importance: float | None = Field(default=None, ge=0, le=1)
    kind: RequirementKind
    evidence: str
    # e.g. "company-profile" / "company-profile:amazon" — why importance was raised.
    boosted_by: str | None = None
    # v0.4: where the requirement came from ("jd" default, "role_pack").
    origin: str | None = Field(default=None, max_length=64)


class CompanyNotesProfile(CamelModel):
    """§8.4: profile derived from untrusted pasted company notes (an overlay)."""

    values: list[str] = Field(default_factory=list)
    interview_style: str = ""
    focus_skill_ids: list[SkillId] = Field(default_factory=list)
    behavioral_themes: list[str] = Field(default_factory=list)


class TargetRole(CamelModel):
    id: str
    company: str
    role: str
    level: Level
    job_description: str
    company_notes: str | None = None
    requirements: list[Requirement] = Field(default_factory=list)
    preferred_skills: list[Requirement] = Field(default_factory=list)
    company_profile: CompanyNotesProfile | None = None
    # §9.3 built-in company profile id (auto-matched from `company`).
    company_profile_id: str | None = None
    # v0.4: assigned role pack id (packs add requirements + rubrics).
    role_pack_id: str | None = Field(default=None, max_length=80)
