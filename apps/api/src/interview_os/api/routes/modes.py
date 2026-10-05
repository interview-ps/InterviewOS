"""Modes routes — port of `http/routes/modes.ts`."""

from __future__ import annotations

from fastapi import APIRouter

from ..deps import StateDep
from ..respond import json_response

__all__ = ["router"]

router = APIRouter(prefix="/api/modes")


@router.get("")
async def list_modes(state: StateDep) -> object:
    return json_response({"modes": state.orchestrator.list_modes()})
