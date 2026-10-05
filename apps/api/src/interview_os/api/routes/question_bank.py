"""Question bank routes — port of `http/routes/question-bank.ts`."""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import Field

from ...core.models import CamelModel, ModeId, QuestionDifficulty
from ...core.skill_id import SkillId
from ..deps import StateDep
from ..respond import json_response

__all__ = ["router"]

router = APIRouter(prefix="/api/question-bank")


class QuestionBankAddSchema(CamelModel):
    skill_id: SkillId
    text: str = Field(min_length=10, max_length=1200)
    difficulty: QuestionDifficulty | None = None
    mode: ModeId | None = None


class QuestionBankImportSchema(CamelModel):
    content: str = Field(min_length=1, max_length=500_000)


@router.get("")
async def list_question_bank(state: StateDep) -> object:
    return json_response(await state.orchestrator.list_question_bank())


@router.post("")
async def add_user_question(body: QuestionBankAddSchema, state: StateDep) -> object:
    return json_response(
        await state.orchestrator.add_user_question(
            body.model_dump(by_alias=True, exclude_none=True)
        ),
        status_code=201,
    )


@router.post("/import")
async def import_question_bank(body: QuestionBankImportSchema, state: StateDep) -> object:
    return json_response(
        await state.orchestrator.import_question_bank(body.content), status_code=201
    )


@router.delete("/{id}")
async def delete_user_question(id: str, state: StateDep) -> object:
    await state.orchestrator.delete_user_question(id)
    return json_response({"ok": True})
