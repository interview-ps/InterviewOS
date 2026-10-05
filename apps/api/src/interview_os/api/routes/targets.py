"""Targets routes — port of `http/routes/targets.ts`."""

from __future__ import annotations

from fastapi import APIRouter, Request

from ...core.models import CamelModel, Level
from ...orchestrator.context import ProgressOptions
from ...orchestrator.services import TargetInput
from ..deps import StateDep
from ..respond import json_response
from ..streaming import stream_or_json

__all__ = ["router"]

router = APIRouter(prefix="/api/targets")


class TargetCreateSchema(CamelModel):
    job_description: str
    company: str
    role: str
    level: Level
    company_notes: str | None = None


class TargetPatchSchema(CamelModel):
    company_profile_id: str


class RolePackAssignSchema(CamelModel):
    # Zod `.nullable()` → required key, may be null.
    role_pack_id: str | None


@router.get("")
async def list_targets(state: StateDep) -> object:
    # `list_targets` is untyped on the orchestrator facade (see its no-untyped-def).
    targets = await state.orchestrator.list_targets()  # type: ignore[no-untyped-call]
    return json_response(targets)


@router.post("")
async def add_target(request: Request, body: TargetCreateSchema, state: StateDep) -> object:
    parsed = TargetInput(
        job_description=body.job_description,
        company=body.company,
        role=body.role,
        level=body.level,
        company_notes=body.company_notes,
    )
    return await stream_or_json(
        request,
        lambda on_progress: state.orchestrator.add_target(parsed, ProgressOptions(on_progress)),
    )


@router.post("/{id}/activate")
async def activate_target(id: str, state: StateDep) -> object:
    return json_response(await state.orchestrator.activate_target(id))


# §9.3: switch the target's company profile; boosts recompute from base.
@router.patch("/{id}")
async def update_target(id: str, body: TargetPatchSchema, state: StateDep) -> object:
    return json_response(
        await state.orchestrator.update_target_company_profile(id, body.company_profile_id)
    )


# v0.4: assign/clear a role pack — pack dimensions join the requirements.
@router.put("/{id}/role-pack")
async def set_target_role_pack(id: str, body: RolePackAssignSchema, state: StateDep) -> object:
    return json_response(await state.orchestrator.set_target_role_pack(id, body.role_pack_id))
