"""Interview packs routes — port of `http/routes/interview-packs.ts`."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import Response
from pydantic import Field

from ...core.models import CamelModel, ModeId
from ...core.skill_id import SkillId
from ...orchestrator.context import ProgressOptions
from ..deps import StateDep
from ..respond import json_response
from ..streaming import stream_or_json

__all__ = ["router"]

router = APIRouter(prefix="/api/interview-packs")


class InterviewPackRoundSchema(CamelModel):
    mode: ModeId
    label: str = Field(min_length=1, max_length=80)
    planned_questions: int = Field(ge=1, le=6)


class InterviewPackCreateSchema(CamelModel):
    name: str = Field(min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=2000)
    author: str | None = Field(default=None, max_length=120)
    version: str | None = Field(default=None, min_length=1, max_length=32)
    skills: list[SkillId] = Field(min_length=1, max_length=12)
    rounds: list[InterviewPackRoundSchema] = Field(min_length=2, max_length=7)
    duration_minutes: int = Field(ge=15, le=600)


class InterviewPackImportSchema(CamelModel):
    content: str = Field(min_length=1, max_length=200_000)


@router.get("")
async def list_interview_packs(state: StateDep) -> object:
    return json_response(await state.orchestrator.list_interview_packs())


@router.post("")
async def create_interview_pack(body: InterviewPackCreateSchema, state: StateDep) -> object:
    return json_response(
        await state.orchestrator.create_interview_pack(
            body.model_dump(by_alias=True, exclude_none=True)
        ),
        status_code=201,
    )


@router.post("/import")
async def import_interview_pack(body: InterviewPackImportSchema, state: StateDep) -> object:
    return json_response(
        await state.orchestrator.import_interview_pack(body.content), status_code=201
    )


@router.delete("/{id}")
async def delete_interview_pack(id: str, state: StateDep) -> object:
    await state.orchestrator.delete_interview_pack(id)
    return json_response({"ok": True})


@router.get("/{id}/export")
async def export_interview_pack(id: str, state: StateDep) -> Response:
    result = await state.orchestrator.export_interview_pack(id)
    return Response(
        content=result.content,
        headers={
            "content-disposition": f'attachment; filename="{result.filename}"',
            "content-type": "application/yaml; charset=utf-8",
        },
    )


@router.post("/{id}/start")
async def start_loop_from_pack(id: str, request: Request, state: StateDep) -> object:
    return await stream_or_json(
        request,
        lambda on_progress: state.orchestrator.start_loop_from_pack(
            id, ProgressOptions(on_progress)
        ),
    )
