"""jd-analyzer — port of `apps/server/src/skills/analyze/jd-analyzer/`."""

from __future__ import annotations

from collections.abc import Callable

from pydantic import Field

from ...core.models import (
    CamelModel,
    Level,
    Permission,
    Requirement,
    RequirementKind,
    SkillKind,
    SkillManifest,
    SkillManifestInput,
)
from ..common import TaxonomyEntry, normalize_skill_id_value
from ..framework import InterviewSkill, SkillContext, SkillInput, SkillTask, run_structured
from .prompts import JD_ANALYZER_PROMPT

__all__ = [
    "AnalyzedRequirement",
    "JdAnalyzer",
    "JdAnalyzerAiOutput",
    "JdAnalyzerInput",
    "JdAnalyzerOutput",
    "jd_analyzer",
]


class JdAnalyzerInput(SkillInput):
    job_description: str
    company: str
    role: str
    level: Level
    taxonomy: list[TaxonomyEntry]


class AnalyzedRequirement(CamelModel):
    skill_id: str
    label: str
    importance: float = Field(ge=0, le=1)
    evidence: str


class JdAnalyzerAiOutput(CamelModel):
    requirements: list[AnalyzedRequirement]
    preferred_skills: list[AnalyzedRequirement]


class JdAnalyzerOutput(CamelModel):
    requirements: list[Requirement]
    preferred_skills: list[Requirement]


_MANIFEST = SkillManifest(
    id="jd-analyzer",
    version="1.0.0",
    kind=SkillKind.BUILTIN,
    description=(
        "Extracts a TargetRole's requirements (required/preferred, importance) "
        "from a job description."
    ),
    inputs=[
        SkillManifestInput(key="jobDescription", permission=Permission.TARGET_READ),
        SkillManifestInput(key="company", permission=Permission.TARGET_READ),
        SkillManifestInput(key="role", permission=Permission.TARGET_READ),
        SkillManifestInput(key="level", permission=Permission.TARGET_READ),
        SkillManifestInput(key="taxonomy", permission=Permission.TAXONOMY_READ),
    ],
    outputs=["requirements", "preferredSkills"],
    permissions=[
        Permission.TARGET_READ,
        Permission.TAXONOMY_READ,
        Permission.RUNTIME_INVOKE,
        Permission.TARGET_WRITE,
    ],
)


class JdAnalyzer(InterviewSkill[JdAnalyzerInput, JdAnalyzerOutput]):
    id = "jd-analyzer"
    manifest = _MANIFEST
    input_schema = JdAnalyzerInput
    output_schema = JdAnalyzerOutput

    async def execute(self, input: JdAnalyzerInput, ctx: SkillContext) -> JdAnalyzerOutput:
        output = await run_structured(
            ctx,
            SkillTask(
                task_id="jd-analyzer",
                instructions=JD_ANALYZER_PROMPT,
                input=input,
                schema=JdAnalyzerAiOutput,
            ),
        )

        def to_requirement(
            kind: RequirementKind,
        ) -> Callable[[AnalyzedRequirement], Requirement | None]:
            def convert(item: AnalyzedRequirement) -> Requirement | None:
                skill_id = normalize_skill_id_value(item.skill_id)
                if skill_id is None:
                    return None
                return Requirement(
                    skill_id=skill_id,
                    label=item.label,
                    importance=item.importance,
                    kind=kind,
                    evidence=item.evidence,
                )

            return convert

        required = to_requirement(RequirementKind.REQUIRED)
        preferred = to_requirement(RequirementKind.PREFERRED)
        return JdAnalyzerOutput(
            requirements=[r for item in output.requirements if (r := required(item))],
            preferred_skills=[r for item in output.preferred_skills if (r := preferred(item))],
        )


jd_analyzer = JdAnalyzer()
