"""Stories routes — port of `http/routes/stories.ts`."""

from __future__ import annotations

from fastapi import APIRouter, Request
from pydantic import Field

from ...core.models import CamelModel
from ...core.skill_id import SkillId
from ...orchestrator.context import ProgressOptions
from ...orchestrator.services.story import StoryPatch
from ..deps import StateDep
from ..respond import json_response
from ..streaming import stream_or_json

__all__ = ["router"]

router = APIRouter(prefix="/api/stories")


class StoryPatchSchema(CamelModel):
    """Request body for PATCH /api/stories/{id} — mirrors `StoryPatchSchema`."""

    title: str | None = Field(default=None, min_length=1, max_length=300)
    situation: str | None = Field(default=None, max_length=20_000)
    task: str | None = Field(default=None, max_length=20_000)
    action: str | None = Field(default=None, max_length=20_000)
    result: str | None = Field(default=None, max_length=20_000)
    skill_ids: list[SkillId] | None = None


@router.get("")
async def list_stories(state: StateDep) -> object:
    return json_response(await state.orchestrator.list_stories())


@router.post("/generate")
async def generate_stories(request: Request, state: StateDep) -> object:
    return await stream_or_json(
        request,
        lambda on_progress: state.orchestrator.generate_stories(ProgressOptions(on_progress)),
    )


@router.patch("/{id}")
async def update_story(id: str, body: StoryPatchSchema, state: StateDep) -> object:
    patch = StoryPatch.model_validate(body.model_dump(by_alias=True, exclude_unset=True))
    return json_response(await state.orchestrator.update_story(id, patch))


@router.post("/{id}/coach")
async def coach_story(id: str, request: Request, state: StateDep) -> object:
    return await stream_or_json(
        request,
        lambda on_progress: state.orchestrator.coach_story(id, ProgressOptions(on_progress)),
    )
