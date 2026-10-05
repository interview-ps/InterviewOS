"""Companies routes — port of `http/routes/companies.ts`."""

from __future__ import annotations

from fastapi import APIRouter

from ..deps import StateDep

__all__ = ["router"]

router = APIRouter(prefix="/api/companies")


@router.get("")
async def list_companies(state: StateDep) -> object:
    return await state.orchestrator.list_company_profiles()
