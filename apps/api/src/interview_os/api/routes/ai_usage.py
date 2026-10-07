"""AI usage routes — provider usage telemetry, mounted at `/api/ai-usage`.

Thin: parse the optional `from`/`to`/`runtime` filters and call one facade
method. Distinct from `/api/events` + `/api/metrics` (product analytics).
"""

from __future__ import annotations

from fastapi import APIRouter, Request

from ...core.models import AIUsageFilters
from ..deps import StateDep
from ..respond import json_response

__all__ = ["router"]

router = APIRouter(prefix="/api/ai-usage")


@router.get("")
async def get_ai_usage(request: Request, state: StateDep) -> object:
    query = request.query_params
    filters = AIUsageFilters.model_validate(
        {
            "from": query.get("from"),
            "to": query.get("to"),
            "runtime": query.get("runtime"),
            "session": query.get("session"),
        }
    )
    return json_response(await state.orchestrator.get_ai_usage(filters))


@router.delete("")
async def clear_ai_usage(state: StateDep) -> object:
    """Clear every AI usage row — an explicit user action."""
    cleared = await state.orchestrator.clear_ai_usage()
    return json_response({"ok": True, "cleared": cleared})
