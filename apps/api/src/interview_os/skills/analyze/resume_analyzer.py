"""resume-analyzer — port of `apps/server/src/skills/analyze/resume-analyzer/`."""

from __future__ import annotations

from pydantic import Field

from ...core.models import (
    CamelModel,
    CandidateSkill,
    CandidateSkillList,
    Education,
    Experience,
    Permission,
    Project,
    SkillKind,
    SkillManifest,
    SkillManifestInput,
    StarStory,
)
from ..common import TaxonomyEntry, normalize_skill_id_value
from ..framework import InterviewSkill, SkillContext, SkillInput, SkillTask, run_structured
from .prompts import RESUME_ANALYZER_PROMPT

__all__ = [
    "AnalyzedSkill",
    "ResumeAnalyzer",
    "ResumeAnalyzerAiOutput",
    "ResumeAnalyzerInput",
    "ResumeAnalyzerOutput",
    "resume_analyzer",
]


class ResumeAnalyzerInput(SkillInput):
    resume_text: str
    taxonomy: list[TaxonomyEntry]


class AnalyzedSkill(CamelModel):
    """AI output is looser on skillId (normalized + validated post-hoc)."""

    skill_id: str
    level: float = Field(ge=0, le=1)
    evidence: str


class ResumeAnalyzerAiOutput(CamelModel):
    name: str | None
    headline: str | None
    experience: list[Experience]
    skills: list[AnalyzedSkill]
    projects: list[Project]
    achievements: list[str]
    education: list[Education]
    star_stories: list[StarStory]


class ResumeAnalyzerOutput(CamelModel):
    """The persisted shape: `skills` is the deduped, normalized candidate list."""

    name: str | None
    headline: str | None
    experience: list[Experience]
    skills: CandidateSkillList = Field(default_factory=list)
    projects: list[Project]
    achievements: list[str]
    education: list[Education]
    star_stories: list[StarStory]


_MANIFEST = SkillManifest(
    id="resume-analyzer",
    version="1.0.0",
    kind=SkillKind.BUILTIN,
    description=(
        "Extracts a CandidateProfile (experience, skills, projects, STAR seeds) "
        "from raw resume text."
    ),
    inputs=[
        SkillManifestInput(key="resumeText", permission=Permission.RESUME_READ),
        SkillManifestInput(key="taxonomy", permission=Permission.TAXONOMY_READ),
    ],
    outputs=["candidateProfile", "evidence", "starStories"],
    permissions=[
        Permission.RESUME_READ,
        Permission.TAXONOMY_READ,
        Permission.RUNTIME_INVOKE,
        Permission.CANDIDATE_WRITE,
        Permission.EVIDENCE_WRITE,
        Permission.STORIES_WRITE,
    ],
)


class ResumeAnalyzer(InterviewSkill[ResumeAnalyzerInput, ResumeAnalyzerOutput]):
    id = "resume-analyzer"
    manifest = _MANIFEST
    input_schema = ResumeAnalyzerInput
    output_schema = ResumeAnalyzerOutput

    async def execute(self, input: ResumeAnalyzerInput, ctx: SkillContext) -> ResumeAnalyzerOutput:
        output = await run_structured(
            ctx,
            SkillTask(
                task_id="resume-analyzer",
                instructions=RESUME_ANALYZER_PROMPT,
                input=input,
                schema=ResumeAnalyzerAiOutput,
            ),
        )
        skills: list[CandidateSkill] = []
        seen: set[str] = set()
        for analyzed in output.skills:
            skill_id = normalize_skill_id_value(analyzed.skill_id)
            if skill_id is None or skill_id in seen:
                continue
            seen.add(skill_id)
            skills.append(
                CandidateSkill(
                    skill_id=skill_id,
                    level=analyzed.level,
                    source="resume",
                    evidence=analyzed.evidence,
                )
            )
        return ResumeAnalyzerOutput(
            name=output.name,
            headline=output.headline,
            experience=output.experience,
            skills=skills,
            projects=output.projects,
            achievements=output.achievements,
            education=output.education,
            star_stories=output.star_stories,
        )


resume_analyzer = ResumeAnalyzer()
