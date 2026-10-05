"""Companies routes — port of `http/routes/companies.ts`."""

from __future__ import annotations

from fastapi import APIRouter

from ..deps import StateDep
from ..respond import json_response

__all__ = ["router"]

router = APIRouter(prefix="/api/companies")


@router.get("")
async def list_companies(state: StateDep) -> object:
    return json_response(await state.orchestrator.list_company_profiles())
