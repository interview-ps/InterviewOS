"""Candidate profile models — port of `candidate/index.ts`."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import AfterValidator, Field

from ..skill_id import SkillId
from .shared import CamelModel

__all__ = [
    "CandidateProfile",
    "CandidateSkill",
    "CandidateSkillList",
    "Education",
    "Experience",
    "Project",
    "StarStory",
]


class CandidateSkill(CamelModel):
    skill_id: SkillId
    level: float = Field(ge=0, le=1)
    source: Literal["resume"]
    evidence: str


def _dedupe_skills(skills: list[CandidateSkill]) -> list[CandidateSkill]:
    """A candidate has at most one claim per skill: the first occurrence wins.

    Models occasionally emit the same `skillId` twice; dropping duplicates keeps
    the readiness graph from getting two evidence rows for one skill.
    """

    seen: set[str] = set()
    unique: list[CandidateSkill] = []
    for skill in skills:
        if skill.skill_id in seen:
            continue
        seen.add(skill.skill_id)
        unique.append(skill)
    return unique


CandidateSkillList = Annotated[list[CandidateSkill], AfterValidator(_dedupe_skills)]


class Experience(CamelModel):
    title: str
    company: str
    start: str | None = None
    end: str | None = None
    highlights: list[str] = Field(default_factory=list)


class Project(CamelModel):
    name: str
    description: str
    technologies: list[str] = Field(default_factory=list)


class Education(CamelModel):
    institution: str
    degree: str | None = None
    field: str | None = None
    end: str | None = None


class StarStory(CamelModel):
    id: str
    title: str
    situation: str
    task: str
    action: str
    result: str
    skill_ids: list[SkillId] = Field(default_factory=list)


class CandidateProfile(CamelModel):
    id: str
    name: str | None = None
    headline: str | None = None
    experience: list[Experience] = Field(default_factory=list)
    skills: CandidateSkillList = Field(default_factory=list)
    projects: list[Project] = Field(default_factory=list)
    achievements: list[str] = Field(default_factory=list)
    education: list[Education] = Field(default_factory=list)
    star_stories: list[StarStory] = Field(default_factory=list)
