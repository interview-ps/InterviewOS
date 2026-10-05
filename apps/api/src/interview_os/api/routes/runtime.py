"""Runtime routes — port of `http/routes/runtime.ts`."""

from __future__ import annotations

import dataclasses
from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel

from ...ai.providers import is_runtime_kind
from ...core.models import AppError
from ..deps import StateDep

__all__ = ["router"]

router = APIRouter(prefix="/api/runtime")


def _status_body(status: object, kind: str) -> dict[str, Any]:
    if isinstance(status, BaseModel):
        data = status.model_dump(by_alias=True)
    elif dataclasses.is_dataclass(status) and not isinstance(status, type):
        data = dataclasses.asdict(status)
    else:
        data = dict(vars(status))
    return {**data, "mode": kind}


@router.get("/models")
async def models(state: StateDep) -> object:
    return await state.runtime.list_models()


@router.get("/status")
async def status(state: StateDep) -> dict[str, Any]:
    return _status_body(await state.runtime.health_check(), state.runtime.kind)


@router.post("/check")
async def check(state: StateDep) -> dict[str, Any]:
    return _status_body(await state.runtime.health_check(), state.runtime.kind)


@router.get("/available")
async def available(state: StateDep) -> dict[str, Any]:
    providers = await state.runtimes.probe_all() if state.runtimes is not None else []
    return {
        "active": state.runtime.kind,
        "providers": [
            p.model_dump(by_alias=True) if isinstance(p, BaseModel) else dataclasses.asdict(p)
            for p in providers
        ],
    }


@router.put("")
async def switch(request: Request, state: StateDep) -> dict[str, Any]:
    runtimes = state.runtimes
    if runtimes is None:
        raise AppError("VALIDATION", "runtime switching is not enabled on this server")
    body = await request.json()
    kind = body.get("kind") if isinstance(body, dict) else None
    if not isinstance(kind, str) or not is_runtime_kind(kind):
        raise AppError("VALIDATION", f'unknown runtime "{kind}"')
    result = await runtimes.switch_to(kind)
    state.store.set_setting("runtimeKind", runtimes.kind)
    current = await state.orchestrator.get_settings()
    if current.model:
        await state.orchestrator.update_settings({"model": current.model})
    return _status_body(result, runtimes.kind)
