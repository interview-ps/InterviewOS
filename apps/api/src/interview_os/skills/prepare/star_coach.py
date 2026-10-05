"""star-coach — port of `apps/server/src/skills/prepare/star-coach/`."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field, TypeAdapter

from ...core.models import (
    CamelModel,
    Experience,
    Level,
    Permission,
    Project,
    SkillKind,
    SkillManifest,
    SkillManifestInput,
)
from ...core.skill_id import SkillId
from ..common import normalize_skill_ids
from ..framework import InterviewSkill, SkillContext, SkillInput, SkillTask, run_structured
from .prompts import STAR_COACH_GENERATE_PROMPT, STAR_COACH_REVIEW_PROMPT

__all__ = [
    "StarCoach",
    "StarCoachGenerateInput",
    "StarCoachGenerateOutput",
    "StarCoachOutput",
    "StarCoachReviewInput",
    "StarCoachReviewOutput",
    "star_coach",
]


class StarCoachGenerateInput(SkillInput):
    mode: Literal["generate"] = "generate"
    experience: list[Experience] = Field(default_factory=list)
    achievements: list[str] = Field(default_factory=list)
    projects: list[Project] = Field(default_factory=list)
    #: Behavioral requirement skills the stories should cover.
    behavioral_skill_ids: list[str] = Field(default_factory=list)
    existing_titles: list[str] = Field(default_factory=list)


class StoryDraftInput(CamelModel):
    title: str
    situation: str
    task: str
    action: str
    result: str
    skill_ids: list[str] = Field(default_factory=list)


class StarCoachReviewInput(SkillInput):
    mode: Literal["review"] = "review"
    story: StoryDraftInput
    role: str
    level: Level


StarCoachInput = Annotated[
    StarCoachGenerateInput | StarCoachReviewInput, Field(discriminator="mode")
]
_STAR_COACH_INPUT: TypeAdapter[StarCoachGenerateInput | StarCoachReviewInput] = TypeAdapter(
    StarCoachInput
)


class StoryDraft(CamelModel):
    title: str
    situation: str = ""
    task: str = ""
    action: str = ""
    result: str = ""
    skill_ids: list[str] = Field(default_factory=list)


class StoryDraftNormalized(StoryDraft):
    skill_ids: list[SkillId] = Field(default_factory=list)


class StarCoachGenerateOutput(CamelModel):
    stories: list[StoryDraft]


class StarCoachGenerateOutputNormalized(CamelModel):
    stories: list[StoryDraftNormalized]


class StarCoachImprovedDraft(CamelModel):
    situation: str
    task: str
    action: str
    result: str


class StarCoachReviewOutput(CamelModel):
    feedback: str
    missing: list[str] = Field(default_factory=list)
    suggestions: list[str] = Field(default_factory=list)
    improved_draft: StarCoachImprovedDraft


StarCoachOutput = StarCoachGenerateOutputNormalized | StarCoachReviewOutput
_STAR_COACH_OUTPUT: TypeAdapter[StarCoachOutput] = TypeAdapter(StarCoachOutput)

_MANIFEST = SkillManifest(
    id="star-coach",
    version="1.0.0",
    kind=SkillKind.BUILTIN,
    description=(
        "Generates resume-grounded STAR story drafts and reviews user stories against "
        "the STAR shape."
    ),
    inputs=[
        SkillManifestInput(key="mode", permission=Permission.STORIES_READ),
        SkillManifestInput(key="experience", permission=Permission.CANDIDATE_READ),
        SkillManifestInput(key="achievements", permission=Permission.CANDIDATE_READ),
        SkillManifestInput(key="projects", permission=Permission.CANDIDATE_READ),
        SkillManifestInput(key="behavioralSkillIds", permission=Permission.TARGET_READ),
        SkillManifestInput(key="existingTitles", permission=Permission.STORIES_READ),
        SkillManifestInput(key="story", permission=Permission.STORIES_READ),
        SkillManifestInput(key="role", permission=Permission.TARGET_READ),
        SkillManifestInput(key="level", permission=Permission.TARGET_READ),
    ],
    outputs=["stories", "review"],
    permissions=[
        Permission.CANDIDATE_READ,
        Permission.TARGET_READ,
        Permission.STORIES_READ,
        Permission.RUNTIME_INVOKE,
        Permission.STORIES_WRITE,
    ],
)


class StarCoach(InterviewSkill[StarCoachGenerateInput | StarCoachReviewInput, StarCoachOutput]):
    id = "star-coach"
    manifest = _MANIFEST
    input_schema = _STAR_COACH_INPUT
    output_schema = _STAR_COACH_OUTPUT

    async def execute(
        self, input: StarCoachGenerateInput | StarCoachReviewInput, ctx: SkillContext
    ) -> StarCoachOutput:
        if isinstance(input, StarCoachGenerateInput):
            output = await run_structured(
                ctx,
                SkillTask(
                    task_id="star-coach.generate",
                    instructions=STAR_COACH_GENERATE_PROMPT,
                    input=input,
                    schema=StarCoachGenerateOutput,
                ),
            )
            return StarCoachGenerateOutputNormalized(
                stories=[
                    StoryDraftNormalized(
                        title=story.title,
                        situation=story.situation,
                        task=story.task,
                        action=story.action,
                        result=story.result,
                        skill_ids=normalize_skill_ids(story.skill_ids),
                    )
                    for story in output.stories
                ]
            )
        return await run_structured(
            ctx,
            SkillTask(
                task_id="star-coach.review",
                instructions=STAR_COACH_REVIEW_PROMPT,
                input=input,
                schema=StarCoachReviewOutput,
                stream_field="feedback",
            ),
        )


star_coach = StarCoach()
