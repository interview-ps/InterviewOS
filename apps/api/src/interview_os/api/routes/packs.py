"""Packs routes — port of `http/routes/packs.ts`."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter
from pydantic import Field

from ...core.models import AppError, CamelModel
from ..deps import StateDep
from ..respond import json_response

__all__ = ["router"]

router = APIRouter(prefix="/api/packs")


class PackInstallSchema(CamelModel):
    kind: Literal["company", "role"]
    url: str = Field(min_length=1, max_length=2000)


@router.get("")
async def list_packs(state: StateDep) -> object:
    return json_response(await state.orchestrator.list_packs())


@router.post("/install")
async def install_pack(body: PackInstallSchema, state: StateDep) -> object:
    return json_response(
        await state.orchestrator.install_pack_from_git(body.kind, body.url), status_code=201
    )


@router.delete("/{kind}/{id}")
async def uninstall_pack(kind: str, id: str, state: StateDep) -> object:
    if kind == "company":
        await state.orchestrator.uninstall_pack("company", id)
    elif kind == "role":
        await state.orchestrator.uninstall_pack("role", id)
    else:
        raise AppError("VALIDATION", "kind must be company or role")
    return json_response({"ok": True})
