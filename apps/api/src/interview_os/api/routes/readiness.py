"""Readiness routes — port of `http/routes/readiness.ts`."""

from __future__ import annotations

from fastapi import APIRouter

from ..deps import StateDep
from ..respond import json_response

__all__ = ["router"]

router = APIRouter(prefix="/api/readiness")


@router.get("")
async def get_readiness(state: StateDep) -> object:
    app_state = await state.orchestrator.get_state()
    return json_response(app_state.readiness)


@router.get("/{skill_id}")
async def get_skill_detail(skill_id: str, state: StateDep) -> object:
    return json_response(await state.orchestrator.get_skill_detail(skill_id))
