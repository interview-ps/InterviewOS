"""Interviews routes — port of `http/routes/interviews.ts`."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Request
from pydantic import Field, TypeAdapter, ValidationError

from ...core.models import AppError, CamelModel, RoundType, VoiceMetrics
from ...core.skill_id import SkillId
from ...orchestrator.context import ProgressOptions
from ..deps import StateDep
from ..respond import json_response
from ..streaming import stream_or_json

__all__ = ["router"]

router = APIRouter(prefix="/api/interviews")

# §9.1: a §9.1 ModeId (or "mixed") — a well-formed slug whose availability the
# service enforces; only the shape is validated here.
_ROUND_TYPE: TypeAdapter[RoundType] = TypeAdapter(RoundType)

CodeLanguage = Literal[
    "python",
    "javascript",
    "typescript",
    "java",
    "go",
    "cpp",
    "csharp",
    "ruby",
    "rust",
    "kotlin",
    "swift",
    "sql",
    "other",
]


class InterviewCreateSchema(CamelModel):
    """Body of `POST /api/interviews` (mirrors `InterviewCreateSchema`)."""

    planned_questions: int | None = Field(default=None, gt=0, le=20)
    # "interview"|"practice" = session mode (v0.2); a §9.1 ModeId also accepted.
    mode: str | None = Field(default=None, max_length=32)
    focus_skill_id: SkillId | None = None
    action_id: str | None = Field(default=None, min_length=1)
    round_type: RoundType | None = None
    # v0.4: ground the session on a stored external context.
    context_id: str | None = Field(default=None, min_length=1, max_length=120)
    # v0.4: "<pluginId>:<modeId>" — a plugin-declared interview mode.
    plugin_mode_id: str | None = Field(default=None, min_length=3, max_length=160)


class AnswerSchema(CamelModel):
    """Body of `POST /api/interviews/{id}/answer` (mirrors `AnswerSchema`)."""

    # Optional for "fields"-format modes; required otherwise (service check).
    answer: str = Field(default="", max_length=190_000)
    # §9.1: optional code submission, ≤ 50 KB, reviewed but not executed.
    code: str | None = Field(default=None, max_length=50 * 1024)
    language: CodeLanguage | None = None
    # v1.1: structured values for modes declaring answerFields.
    fields: dict[str, str | int | float] | None = None
    # v0.4 voice mode: client-measured delivery metrics (feedback only).
    voice: VoiceMetrics | None = None


async def _start_input(request: Request) -> dict[str, object]:
    """`parseOptionalBody(InterviewCreateSchema)` + the §9.1 mode resolution.

    `parseOptionalBody` collapses every body failure (bad JSON or schema) to the
    detail-less "invalid request body" message, so this path normalizes it here
    rather than through the central validation handler.
    """

    raw = await request.body()
    try:
        body = (
            InterviewCreateSchema()
            if not raw.strip()
            else InterviewCreateSchema.model_validate_json(raw)
        )
    except (ValueError, ValidationError) as err:
        raise AppError("VALIDATION", "invalid request body") from err

    session_mode: Literal["interview", "practice"] | None = None
    round_type = body.round_type
    mode = body.mode
    if mode == "interview":
        session_mode = "interview"
    elif mode == "practice":
        session_mode = "practice"
    elif mode is not None:
        # built-in or plugin-mode slug — availability is enforced downstream.
        try:
            round_type = _ROUND_TYPE.validate_python(mode)
        except ValidationError as err:
            raise AppError("VALIDATION", f'unknown interview mode "{mode}"') from err

    payload: dict[str, object] = {
        "plannedQuestions": body.planned_questions,
        "focusSkillId": body.focus_skill_id,
        "actionId": body.action_id,
        "contextId": body.context_id,
        "pluginModeId": body.plugin_mode_id,
        "roundType": round_type,
    }
    if session_mode is not None:
        payload["mode"] = session_mode
    return payload


@router.post("")
async def start_interview(request: Request, state: StateDep) -> object:
    payload = await _start_input(request)
    return await stream_or_json(
        request,
        lambda on_progress: state.orchestrator.start_interview(
            payload, ProgressOptions(on_progress)
        ),
    )


@router.get("")
async def list_interviews(state: StateDep) -> object:
    return json_response(await state.orchestrator.list_interviews())


@router.get("/{id}")
async def get_interview(id: str, state: StateDep) -> object:
    return json_response(await state.orchestrator.get_interview(id))


@router.post("/{id}/answer")
async def submit_answer(id: str, request: Request, state: StateDep) -> object:
    body = AnswerSchema.model_validate(await request.json())
    return await stream_or_json(
        request,
        lambda on_progress: state.orchestrator.submit_answer(
            id,
            {
                "text": body.answer,
                "code": body.code,
                "language": body.language,
                "fields": body.fields,
                "voice": body.voice,
            },
            ProgressOptions(on_progress),
        ),
    )


@router.post("/{id}/next")
async def next_question(id: str, request: Request, state: StateDep) -> object:
    return await stream_or_json(
        request,
        lambda on_progress: state.orchestrator.next_question(
            id, ProgressOptions(on_progress)
        ),
    )


@router.post("/{id}/complete")
async def complete_interview(id: str, request: Request, state: StateDep) -> object:
    return await stream_or_json(
        request,
        lambda on_progress: state.orchestrator.complete_interview(
            id, ProgressOptions(on_progress)
        ),
    )


@router.post("/{id}/abandon")
async def abandon_interview(id: str, state: StateDep) -> object:
    return json_response(await state.orchestrator.abandon_interview(id))


@router.get("/{id}/debrief")
async def get_debrief(id: str, state: StateDep) -> object:
    interview = await state.orchestrator.get_interview(id)
    if interview.debrief is None:
        raise AppError("NOT_FOUND", "no debrief for this session")
    return json_response(interview.debrief)
