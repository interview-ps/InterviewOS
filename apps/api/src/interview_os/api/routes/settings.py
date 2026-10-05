"""Settings routes — port of `http/routes/settings.ts`."""

from __future__ import annotations

from fastapi import APIRouter, Request

from ..deps import StateDep
from ..schemas import SettingsSchema

__all__ = ["router"]

router = APIRouter(prefix="/api/settings")


@router.get("")
async def get_settings(state: StateDep) -> object:
    return await state.orchestrator.get_settings()


@router.put("")
async def update_settings(request: Request, state: StateDep) -> object:
    body = SettingsSchema.model_validate(await request.json())
    patch = body.model_dump(by_alias=True, exclude_unset=True)
    return await state.orchestrator.update_settings(patch)
