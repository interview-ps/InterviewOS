"""Modes routes — port of `http/routes/modes.ts`."""

from __future__ import annotations

from fastapi import APIRouter

from ..deps import StateDep

__all__ = ["router"]

router = APIRouter(prefix="/api/modes")


@router.get("")
async def list_modes(state: StateDep) -> dict[str, object]:
    return {"modes": state.orchestrator.list_modes()}
