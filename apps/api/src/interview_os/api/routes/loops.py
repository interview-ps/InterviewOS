"""Loops routes — port of `http/routes/loops.ts`."""

from __future__ import annotations

from fastapi import APIRouter, Request
from pydantic import Field

from ...core.models import CamelModel, LoopMode
from ...orchestrator.context import ProgressOptions
from ..deps import StateDep
from ..respond import json_response
from ..streaming import stream_or_json

__all__ = ["router"]

router = APIRouter(prefix="/api/loops")


class LoopRoundCreateSchema(CamelModel):
    """One round spec of `LoopCreateSchema` (§9.4)."""

    # Built-in or plugin-mode slug — availability enforced by the service.
    mode: LoopMode
    label: str | None = Field(default=None, max_length=80)
    planned_questions: int | None = Field(default=None, ge=1, le=6)


class LoopCreateSchema(CamelModel):
    """Body of `POST /api/loops` (mirrors `LoopCreateSchema`)."""

    rounds: list[LoopRoundCreateSchema] | None = Field(
        default=None, min_length=2, max_length=7
    )


@router.post("")
async def start_loop(request: Request, state: StateDep) -> object:
    body = LoopCreateSchema.model_validate(await request.json())
    payload = body.model_dump(by_alias=True, exclude_unset=True)
    return await stream_or_json(
        request,
        lambda on_progress: state.orchestrator.start_loop(
            payload, ProgressOptions(on_progress)
        ),
    )


@router.get("")
async def list_loops(state: StateDep) -> object:
    return json_response(await state.orchestrator.list_loops())


@router.get("/{id}")
async def get_loop(id: str, state: StateDep) -> object:
    return json_response(await state.orchestrator.get_loop(id))


@router.post("/{id}/abandon")
async def abandon_loop(id: str, state: StateDep) -> object:
    return json_response(await state.orchestrator.abandon_loop(id))
