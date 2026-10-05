"""Platform routes — port of `http/routes/platform.ts`.

v1.1: the plugin-api surface — hooks, events, capabilities, manifest features.
"""

from __future__ import annotations

from fastapi import APIRouter

from ..deps import StateDep
from ..respond import json_response

__all__ = ["router"]

router = APIRouter(prefix="/api/platform")


@router.get("")
async def get_platform(state: StateDep) -> object:
    return json_response(state.orchestrator.platform_info())
