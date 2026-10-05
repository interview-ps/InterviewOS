"""History routes — port of `http/routes/history.ts`."""

from __future__ import annotations

from fastapi import APIRouter, Request

from ..deps import StateDep
from ..respond import json_response

__all__ = ["router"]

router = APIRouter(prefix="/api/history")


@router.get("")
async def list_history(request: Request, state: StateDep) -> object:
    query = request.query_params
    filters: dict[str, object] = {
        "mode": query.get("mode") or None,
        "targetId": query.get("targetId") or None,
        "loopId": query.get("loopId") or None,
        "weakOnly": query.get("weakOnly") in ("1", "true"),
    }
    return json_response(await state.orchestrator.get_history(filters))


@router.get("/{id}")
async def get_session_history(id: str, state: StateDep) -> object:
    await state.orchestrator.record_usage_event("history.viewed")
    return json_response(await state.orchestrator.get_session_history(id))
