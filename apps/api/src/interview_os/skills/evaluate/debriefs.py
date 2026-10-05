"""interview-debrief and loop-debrief — ports of `skills/evaluate/*-debrief/`."""

from __future__ import annotations

from pydantic import Field

from ...core.models import (
    CamelModel,
    LoopDebrief,
    Permission,
    ReadinessChange,
    RoundHandoff,
    SkillKind,
    SkillManifest,
    SkillManifestInput,
)
from ..framework import InterviewSkill, SkillContext, SkillInput, SkillTask, run_structured
from .prompts import INTERVIEW_DEBRIEF_PROMPT, LOOP_DEBRIEF_PROMPT

__all__ = [
    "InterviewDebrief",
    "InterviewDebriefInput",
    "InterviewDebriefOutput",
    "LoopDebriefInput",
    "LoopDebriefRoundInput",
    "LoopDebriefSkill",
    "interview_debrief",
    "loop_debrief",
]


class DebriefQuestion(CamelModel):
    text: str
    skill_id: str
    topic: str = ""


class DebriefOpenAction(CamelModel):
    skill_id: str
    action: str


class InterviewDebriefInput(SkillInput):
    role: str
    questions: list[DebriefQuestion]
    evaluations: list[object]
    readiness_before: dict[str, float | None] = Field(default_factory=dict)
    readiness_after: dict[str, float | None] = Field(default_factory=dict)
    open_actions: list[DebriefOpenAction] = Field(default_factory=list)


class InterviewDebriefOutput(CamelModel):
    summary: str
    went_well: list[str]
    to_improve: list[str]
    next_actions: list[str]


_INTERVIEW_DEBRIEF_MANIFEST = SkillManifest(
    id="interview-debrief",
    version="1.0.0",
    kind=SkillKind.BUILTIN,
    description=(
        "Summarises a completed interview session: what went well, what to improve, next actions."
    ),
    inputs=[
        SkillManifestInput(key="role", permission=Permission.TARGET_READ),
        SkillManifestInput(key="questions", permission=Permission.INTERVIEW_READ),
        SkillManifestInput(key="evaluations", permission=Permission.INTERVIEW_READ),
        SkillManifestInput(key="readinessBefore", permission=Permission.READINESS_READ),
        SkillManifestInput(key="readinessAfter", permission=Permission.READINESS_READ),
        SkillManifestInput(key="openActions", permission=Permission.READINESS_READ),
    ],
    outputs=["debrief"],
    permissions=[
        Permission.TARGET_READ,
        Permission.INTERVIEW_READ,
        Permission.READINESS_READ,
        Permission.RUNTIME_INVOKE,
        Permission.INTERVIEW_WRITE,
    ],
)


class InterviewDebrief(InterviewSkill[InterviewDebriefInput, InterviewDebriefOutput]):
    id = "interview-debrief"
    manifest = _INTERVIEW_DEBRIEF_MANIFEST
    input_schema = InterviewDebriefInput
    output_schema = InterviewDebriefOutput

    async def execute(
        self, input: InterviewDebriefInput, ctx: SkillContext
    ) -> InterviewDebriefOutput:
        return await run_structured(
            ctx,
            SkillTask(
                task_id="interview-debrief",
                instructions=INTERVIEW_DEBRIEF_PROMPT,
                input=input,
                schema=InterviewDebriefOutput,
                stream_field="summary",
            ),
        )


class LoopDebriefRoundInput(CamelModel):
    """§9.4: one completed loop round as the debrief sees it."""

    mode: str
    label: str = ""
    summaries: list[str] = Field(default_factory=list)
    #: Mean score per rubric dimension this round.
    rubric_averages: dict[str, float] = Field(default_factory=dict)
    handoff: RoundHandoff | None = None


class LoopDebriefInput(SkillInput):
    role: str
    company: str = ""
    rounds: list[LoopDebriefRoundInput]
    readiness_change: ReadinessChange


_LOOP_DEBRIEF_MANIFEST = SkillManifest(
    id="loop-debrief",
    version="1.0.0",
    kind=SkillKind.BUILTIN,
    description=(
        "Summarises a completed multi-round loop into per-round signals and a "
        "readiness change — never a hire verdict."
    ),
    inputs=[
        SkillManifestInput(key="role", permission=Permission.TARGET_READ),
        SkillManifestInput(key="company", permission=Permission.TARGET_READ),
        SkillManifestInput(key="rounds", permission=Permission.INTERVIEW_READ),
        SkillManifestInput(key="readinessChange", permission=Permission.READINESS_READ),
    ],
    outputs=["loopDebrief"],
    permissions=[
        Permission.TARGET_READ,
        Permission.INTERVIEW_READ,
        Permission.READINESS_READ,
        Permission.RUNTIME_INVOKE,
        Permission.INTERVIEW_WRITE,
    ],
)


class LoopDebriefSkill(InterviewSkill[LoopDebriefInput, LoopDebrief]):
    id = "loop-debrief"
    manifest = _LOOP_DEBRIEF_MANIFEST
    input_schema = LoopDebriefInput
    output_schema = LoopDebrief

    async def execute(self, input: LoopDebriefInput, ctx: SkillContext) -> LoopDebrief:
        return await run_structured(
            ctx,
            SkillTask(
                task_id="loop-debrief",
                instructions=LOOP_DEBRIEF_PROMPT,
                input=input,
                schema=LoopDebrief,
                stream_field="summary",
            ),
        )


interview_debrief = InterviewDebrief()
loop_debrief = LoopDebriefSkill()
