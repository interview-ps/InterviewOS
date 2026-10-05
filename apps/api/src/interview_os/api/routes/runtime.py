"""Runtime routes — port of `http/routes/runtime.ts`."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request

from ...ai.interface import ModelInfo
from ...ai.providers import is_runtime_kind
from ...core.models import AppError
from ..deps import StateDep
from ..respond import json_response
from ..schemas import RuntimeSwitchSchema

__all__ = ["router"]

router = APIRouter(prefix="/api/runtime")

#: RuntimeStatus dataclass fields → JSON aliases. Optional fields are omitted
#: when unset (Zod `.optional()`), matching the Hono response.
_STATUS_FIELDS: tuple[tuple[str, str], ...] = (
    ("runtime", "runtime"),
    ("available", "available"),
    ("status", "status"),
    ("version", "version"),
    ("executable", "executable"),
    ("workspace", "workspace"),
    ("trustedLocal", "trusted_local"),
    ("message", "message"),
)


def _status_fields(status: object) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for alias, name in _STATUS_FIELDS:
        value = getattr(status, name, None)
        if value is None:
            continue
        out[alias] = value
    return out


def _status_body(status: object, kind: str) -> dict[str, Any]:
    return {**_status_fields(status), "mode": kind}


def _model_info(model: ModelInfo) -> dict[str, Any]:
    return {
        "id": model.id,
        "displayName": model.display_name,
        "supportedReasoningEfforts": list(model.supported_reasoning_efforts),
        "defaultReasoningEffort": model.default_reasoning_effort,
    }


@router.get("/models")
async def models(state: StateDep) -> object:
    return json_response([_model_info(m) for m in await state.runtime.list_models()])


@router.get("/status")
async def status(state: StateDep) -> object:
    return json_response(_status_body(await state.runtime.health_check(), state.runtime.kind))


@router.post("/check")
async def check(state: StateDep) -> object:
    return json_response(_status_body(await state.runtime.health_check(), state.runtime.kind))


@router.get("/available")
async def available(state: StateDep) -> object:
    providers = await state.runtimes.probe_all() if state.runtimes is not None else []
    return json_response(
        {"active": state.runtime.kind, "providers": [_status_fields(p) for p in providers]}
    )


@router.put("")
async def switch(request: Request, state: StateDep) -> object:
    runtimes = state.runtimes
    if runtimes is None:
        raise AppError("VALIDATION", "runtime switching is not enabled on this server")
    body = RuntimeSwitchSchema.model_validate_json(await request.body())
    kind = body.kind
    if not is_runtime_kind(kind):
        raise AppError("VALIDATION", f'unknown runtime "{kind}"')
    result = await runtimes.switch_to(kind)
    state.store.set_setting("runtimeKind", runtimes.kind)
    current = await state.orchestrator.get_settings()
    if current.model:
        await state.orchestrator.update_settings({"model": current.model})
    return json_response(_status_body(result, runtimes.kind))
