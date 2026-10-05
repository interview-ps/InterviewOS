"""resume-coach — port of `apps/server/src/skills/prepare/resume-coach/`."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field, TypeAdapter

from ...core.models import (
    CamelModel,
    Level,
    Permission,
    Requirement,
    ResumeTailoring,
    SkillKind,
    SkillManifest,
    SkillManifestInput,
)
from ...core.skill_id import SkillId
from ..common import normalize_skill_ids
from ..framework import InterviewSkill, SkillContext, SkillInput, SkillTask, run_structured
from .prompts import RESUME_COACH_BULLETS_PROMPT, RESUME_COACH_TAILOR_PROMPT

__all__ = [
    "ResumeCoach",
    "ResumeCoachBulletsInput",
    "ResumeCoachBulletsOutput",
    "ResumeCoachOutput",
    "ResumeCoachTailorInput",
    "ResumeCoachSuggestion",
    "resume_coach",
]


class ResumeCoachBulletsInput(SkillInput):
    mode: Literal["bullets"] = "bullets"
    #: Full resume text (untrusted) — context for rewrites.
    resume_text: str
    #: Up to 8 weakest bullets, pre-selected deterministically by the orchestrator.
    bullets: list[str] = Field(min_length=1, max_length=8)


class ResumeCoachTailorInput(SkillInput):
    mode: Literal["tailor"] = "tailor"
    resume_text: str
    requirements: list[Requirement]
    role: str
    level: Level


ResumeCoachInput = Annotated[
    ResumeCoachBulletsInput | ResumeCoachTailorInput, Field(discriminator="mode")
]
_RESUME_COACH_INPUT: TypeAdapter[ResumeCoachBulletsInput | ResumeCoachTailorInput] = TypeAdapter(
    ResumeCoachInput
)


class ResumeCoachSuggestion(CamelModel):
    original: str
    improved: str
    rationale: str = ""
    skill_ids: list[str] = Field(default_factory=list)


class ResumeCoachSuggestionNormalized(ResumeCoachSuggestion):
    skill_ids: list[SkillId] = Field(default_factory=list)


class ResumeCoachBulletsOutput(CamelModel):
    suggestions: list[ResumeCoachSuggestion]


class ResumeCoachBulletsOutputNormalized(CamelModel):
    suggestions: list[ResumeCoachSuggestionNormalized]


ResumeCoachOutput = ResumeCoachBulletsOutputNormalized | ResumeTailoring
_RESUME_COACH_OUTPUT: TypeAdapter[ResumeCoachOutput] = TypeAdapter(ResumeCoachOutput)

_MANIFEST = SkillManifest(
    id="resume-coach",
    version="1.0.0",
    kind=SkillKind.BUILTIN,
    description=(
        "§9.5 resume coach — rewrites weak bullets and tailors a resume to the target "
        "role, never inventing facts."
    ),
    inputs=[
        SkillManifestInput(key="mode", permission=Permission.RESUME_READ),
        SkillManifestInput(key="resumeText", permission=Permission.RESUME_READ),
        SkillManifestInput(key="bullets", permission=Permission.RESUME_READ),
        SkillManifestInput(key="requirements", permission=Permission.TARGET_READ),
        SkillManifestInput(key="role", permission=Permission.TARGET_READ),
        SkillManifestInput(key="level", permission=Permission.TARGET_READ),
    ],
    outputs=["suggestions", "tailoring"],
    permissions=[
        Permission.RESUME_READ,
        Permission.TARGET_READ,
        Permission.RUNTIME_INVOKE,
        Permission.RESUME_WRITE,
    ],
)


class ResumeCoach(
    InterviewSkill[ResumeCoachBulletsInput | ResumeCoachTailorInput, ResumeCoachOutput]
):
    id = "resume-coach"
    manifest = _MANIFEST
    input_schema = _RESUME_COACH_INPUT
    output_schema = _RESUME_COACH_OUTPUT

    async def execute(
        self, input: ResumeCoachBulletsInput | ResumeCoachTailorInput, ctx: SkillContext
    ) -> ResumeCoachOutput:
        if isinstance(input, ResumeCoachBulletsInput):
            output = await run_structured(
                ctx,
                SkillTask(
                    task_id="resume-coach.bullets",
                    instructions=RESUME_COACH_BULLETS_PROMPT,
                    input=input,
                    schema=ResumeCoachBulletsOutput,
                ),
            )
            return ResumeCoachBulletsOutputNormalized(
                suggestions=[
                    ResumeCoachSuggestionNormalized(
                        original=suggestion.original,
                        improved=suggestion.improved,
                        rationale=suggestion.rationale,
                        skill_ids=normalize_skill_ids(suggestion.skill_ids),
                    )
                    for suggestion in output.suggestions
                ]
            )

        tailoring = await run_structured(
            ctx,
            SkillTask(
                task_id="resume-coach.tailor",
                instructions=RESUME_COACH_TAILOR_PROMPT,
                input=input,
                schema=ResumeTailoring,
            ),
        )
        resume_norm = input.resume_text.lower()
        return tailoring.model_copy(
            update={
                # §9.5: evidence must be a verbatim substring of the resume.
                "alignment": [
                    alignment.model_copy(
                        update={
                            "resume_evidence": (
                                alignment.resume_evidence
                                if alignment.resume_evidence is not None
                                and alignment.resume_evidence.lower() in resume_norm
                                else None
                            )
                        }
                    )
                    for alignment in tailoring.alignment
                ]
            }
        )


resume_coach = ResumeCoach()
