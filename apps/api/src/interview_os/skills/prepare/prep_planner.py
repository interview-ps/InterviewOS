"""prep-planner — port of `apps/server/src/skills/prepare/prep-planner/`."""

from __future__ import annotations

from pydantic import Field

from ...core.models import (
    CamelModel,
    GapSeverity,
    Level,
    Permission,
    SkillKind,
    SkillManifest,
    SkillManifestInput,
)
from ...core.skill_id import SkillId
from ..common import normalize_skill_id_value
from ..framework import InterviewSkill, SkillContext, SkillInput, SkillTask, run_structured
from .prompts import PREP_PLANNER_PROMPT

__all__ = ["PrepPlanner", "PrepPlannerInput", "PrepPlannerOutput", "prep_planner"]


class PrepTarget(CamelModel):
    skill_id: str
    label: str
    reason: str
    missing_concepts: list[str] = Field(default_factory=list)
    severity: GapSeverity


class PrepPlannerInput(SkillInput):
    targets: list[PrepTarget]
    role: str
    level: Level


class PrepActionOut(CamelModel):
    skill_id: str
    action: str
    success_criteria: list[str] = Field(min_length=2, max_length=4)
    reason: str


class PrepPlannerOutput(CamelModel):
    actions: list[PrepActionOut]


class PrepAction(PrepActionOut):
    """The persisted shape: `skillId` is normalized to a taxonomy id."""

    skill_id: SkillId


class PrepPlannerOutputNormalized(CamelModel):
    actions: list[PrepAction]


_MANIFEST = SkillManifest(
    id="prep-planner",
    version="1.0.0",
    kind=SkillKind.BUILTIN,
    description="Turns ranked gaps into concrete preparation actions with success criteria.",
    inputs=[
        SkillManifestInput(key="targets", permission=Permission.READINESS_READ),
        SkillManifestInput(key="role", permission=Permission.TARGET_READ),
        SkillManifestInput(key="level", permission=Permission.TARGET_READ),
    ],
    outputs=["actions"],
    permissions=[
        Permission.TARGET_READ,
        Permission.READINESS_READ,
        Permission.RUNTIME_INVOKE,
        Permission.PREPARATION_WRITE,
    ],
)


class PrepPlanner(InterviewSkill[PrepPlannerInput, PrepPlannerOutputNormalized]):
    id = "prep-planner"
    manifest = _MANIFEST
    input_schema = PrepPlannerInput
    output_schema = PrepPlannerOutputNormalized

    async def execute(
        self, input: PrepPlannerInput, ctx: SkillContext
    ) -> PrepPlannerOutputNormalized:
        output = await run_structured(
            ctx,
            SkillTask(
                task_id="prep-planner",
                instructions=PREP_PLANNER_PROMPT,
                input=input,
                schema=PrepPlannerOutput,
            ),
        )
        actions: list[PrepAction] = []
        for action in output.actions:
            skill_id = normalize_skill_id_value(action.skill_id)
            if skill_id is not None:
                actions.append(
                    PrepAction(
                        skill_id=skill_id,
                        action=action.action,
                        success_criteria=action.success_criteria,
                        reason=action.reason,
                    )
                )
        return PrepPlannerOutputNormalized(actions=actions)


prep_planner = PrepPlanner()
