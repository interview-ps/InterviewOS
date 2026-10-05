"""company-profiler — port of `apps/server/src/skills/analyze/company-profiler/`."""

from __future__ import annotations

from pydantic import Field

from ...core.models import (
    CamelModel,
    CompanyNotesProfile,
    Permission,
    SkillKind,
    SkillManifest,
    SkillManifestInput,
)
from ..common import TaxonomyEntry, normalize_skill_ids
from ..framework import InterviewSkill, SkillContext, SkillInput, SkillTask, run_structured
from .prompts import COMPANY_PROFILER_PROMPT

__all__ = [
    "CompanyProfiler",
    "CompanyProfilerAiOutput",
    "CompanyProfilerInput",
    "company_profiler",
]


class CompanyProfilerInput(SkillInput):
    company: str
    #: Untrusted free text (careers page notes, values). Delimited for the model.
    company_notes: str
    taxonomy: list[TaxonomyEntry]


class CompanyProfilerAiOutput(CamelModel):
    values: list[str] = Field(default_factory=list)
    interview_style: str = ""
    focus_skill_ids: list[str] = Field(default_factory=list)
    behavioral_themes: list[str] = Field(default_factory=list)


_MANIFEST = SkillManifest(
    id="company-profiler",
    version="1.0.0",
    kind=SkillKind.BUILTIN,
    description=(
        "Derives a company profile (values, interview style, focus skills, themes) "
        "from untrusted careers-page notes."
    ),
    inputs=[
        SkillManifestInput(key="company", permission=Permission.TARGET_READ),
        SkillManifestInput(key="companyNotes", permission=Permission.TARGET_READ),
        SkillManifestInput(key="taxonomy", permission=Permission.TAXONOMY_READ),
    ],
    outputs=["companyProfile"],
    permissions=[
        Permission.TARGET_READ,
        Permission.TAXONOMY_READ,
        Permission.RUNTIME_INVOKE,
        Permission.TARGET_WRITE,
    ],
)


class CompanyProfiler(InterviewSkill[CompanyProfilerInput, CompanyNotesProfile]):
    id = "company-profiler"
    manifest = _MANIFEST
    input_schema = CompanyProfilerInput
    output_schema = CompanyNotesProfile

    async def execute(self, input: CompanyProfilerInput, ctx: SkillContext) -> CompanyNotesProfile:
        output = await run_structured(
            ctx,
            SkillTask(
                task_id="company-profiler",
                instructions=COMPANY_PROFILER_PROMPT,
                input={
                    "company": input.company,
                    "taxonomy": [entry.model_dump(by_alias=True) for entry in input.taxonomy],
                    "companyNotes": (
                        f"<<<COMPANY-NOTES>>>\n{input.company_notes}\n<<<END-COMPANY-NOTES>>>"
                    ),
                },
                schema=CompanyProfilerAiOutput,
            ),
        )
        return CompanyNotesProfile(
            values=output.values,
            interview_style=output.interview_style,
            focus_skill_ids=normalize_skill_ids(output.focus_skill_ids),
            behavioral_themes=output.behavioral_themes,
        )


company_profiler = CompanyProfiler()
