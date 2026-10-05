"""UI routes — port of `http/routes/ui.ts`.

v0.4: the UI contributions of enabled + compatible plugins, and the built
iframe runtime bundle (`packages/ui build:runtime`) served to sandboxed frames.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Response

from ...core.models import AppError
from ..deps import StateDep
from ..respond import json_response

__all__ = ["router"]

router = APIRouter(prefix="/api/ui")

_RUNTIME_FILES: dict[str, str] = {
    "plugin-runtime.js": "text/javascript; charset=utf-8",
    "plugin-runtime.css": "text/css; charset=utf-8",
}


@router.get("/contributions")
async def list_contributions(state: StateDep) -> object:
    """UI contributions of enabled + compatible plugins (nav, commands, slots,
    pages, interview modes). Disabled plugins contribute nothing."""

    return json_response({"contributions": await state.orchestrator.list_ui_contributions()})


@router.get("/runtime/{file}")
async def get_runtime_file(file: str, state: StateDep) -> object:
    media_type = _RUNTIME_FILES.get(file)
    if media_type is None:
        raise AppError("NOT_FOUND", f'unknown runtime file "{file}"')
    target = Path(state.ui_runtime_dir) / file
    try:
        data = target.read_bytes()
    except OSError:
        raise AppError(
            "UNAVAILABLE",
            "plugin UI runtime is not built — run `pnpm --filter @interview-os/ui build:runtime`",
        ) from None
    return Response(
        content=data,
        media_type=media_type,
        headers={
            "x-content-type-options": "nosniff",
            "cache-control": "no-store",
            # the consumer is an opaque-origin sandbox document: module fetches
            # need CORS, and no-cors fetches need CORP≠same-origin. These are
            # static host assets — deliberately world-readable.
            "cross-origin-resource-policy": "cross-origin",
            "access-control-allow-origin": "*",
        },
    )
