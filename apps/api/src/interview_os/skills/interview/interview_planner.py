"""interview-planner — port of `apps/server/src/skills/interview/interview-planner/`.

Deterministic — wraps `core.interview.prioritize`.
"""

from __future__ import annotations

from pydantic import Field, TypeAdapter

from ...core.models import (
    Evidence,
    Level,
    Permission,
    Requirement,
    RoundType,
    SkillKind,
    SkillManifest,
    SkillManifestInput,
    SkillReadiness,
)
from ...core.prioritize import LoopWeakSkill, SelectNextSkillInput, SelectNextSkillResult
from ...core.prioritize import select_next_skill as _select_next_skill
from ...core.skill_id import SkillId
from ..framework import InterviewSkill, SkillContext, SkillInput

__all__ = [
    "InterviewPlanner",
    "InterviewPlannerInput",
    "InterviewPlannerOutput",
    "interview_planner",
]

InterviewPlannerOutput = SelectNextSkillResult | None

_OUTPUT_ADAPTER: TypeAdapter[InterviewPlannerOutput] = TypeAdapter(InterviewPlannerOutput)


class InterviewPlannerInput(SkillInput):
    requirements: list[Requirement]
    readiness: dict[str, SkillReadiness]
    evidence: list[Evidence]
    asked_this_session: list[SkillId]
    asked_previous_session: list[SkillId]
    question_index: int = Field(ge=0)
    round_type: RoundType | None = None
    mode: RoundType | None = None
    level: Level | None = None
    ask_counts: dict[str, int] = Field(default_factory=dict)
    loop_weak_skills: list[LoopWeakSkill] = Field(default_factory=list)
    focus_skills: list[SkillId] = Field(default_factory=list)

    # `roundType` / `mode` / `level` are `.optional()` in TS.
    js_undefined = frozenset({"round_type", "mode", "level"})


_MANIFEST = SkillManifest(
    id="interview-planner",
    version="1.0.0",
    kind=SkillKind.BUILTIN,
    description=(
        "Deterministic engine — picks the next skill to ask about from requirements, "
        "readiness, evidence and loop weakness handoffs."
    ),
    inputs=[
        SkillManifestInput(key="requirements", permission=Permission.TARGET_READ),
        SkillManifestInput(key="readiness", permission=Permission.READINESS_READ),
        SkillManifestInput(key="evidence", permission=Permission.READINESS_READ),
        SkillManifestInput(key="askedThisSession", permission=Permission.INTERVIEW_READ),
        SkillManifestInput(key="askedPreviousSession", permission=Permission.INTERVIEW_READ),
        SkillManifestInput(key="questionIndex", permission=Permission.INTERVIEW_READ),
        SkillManifestInput(key="roundType", permission=Permission.INTERVIEW_READ),
        SkillManifestInput(key="mode", permission=Permission.INTERVIEW_READ),
        SkillManifestInput(key="level", permission=Permission.TARGET_READ),
        SkillManifestInput(key="askCounts", permission=Permission.INTERVIEW_READ),
        SkillManifestInput(key="loopWeakSkills", permission=Permission.INTERVIEW_READ),
        SkillManifestInput(key="focusSkills", permission=Permission.INTERVIEW_READ),
    ],
    outputs=["selection"],
    permissions=[
        Permission.TARGET_READ,
        Permission.READINESS_READ,
        Permission.INTERVIEW_READ,
    ],
)


class InterviewPlanner(InterviewSkill[InterviewPlannerInput, InterviewPlannerOutput]):
    id = "interview-planner"
    manifest = _MANIFEST
    input_schema = InterviewPlannerInput
    output_schema = _OUTPUT_ADAPTER

    async def execute(
        self, input: InterviewPlannerInput, ctx: SkillContext
    ) -> InterviewPlannerOutput:
        return _select_next_skill(
            SelectNextSkillInput(
                requirements=input.requirements,
                readiness=input.readiness,
                evidence=input.evidence,
                asked_this_session=input.asked_this_session,
                asked_previous_session=input.asked_previous_session,
                question_index=input.question_index,
                round_type=input.round_type,
                mode=input.mode,
                level=input.level if input.level is not None else Level.MID,
                ask_counts=input.ask_counts,
                loop_weak_skills=input.loop_weak_skills,
                focus_skills=input.focus_skills,
            )
        )


interview_planner = InterviewPlanner()
