"""Settings routes — port of `http/routes/settings.ts`."""

from __future__ import annotations

from fastapi import APIRouter, Request

from ..deps import StateDep
from ..respond import json_response
from ..schemas import SettingsSchema

__all__ = ["router"]

router = APIRouter(prefix="/api/settings")


@router.get("")
async def get_settings(state: StateDep) -> object:
    return json_response(await state.orchestrator.get_settings())


@router.put("")
async def update_settings(request: Request, state: StateDep) -> object:
    body = SettingsSchema.model_validate_json(await request.body())
    patch = body.model_dump(by_alias=True, exclude_unset=True)
    return json_response(await state.orchestrator.update_settings(patch))
