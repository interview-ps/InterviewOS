"""Examples routes — port of `http/routes/examples.ts`."""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from ...adapters.examples import list_examples, read_example
from ..deps import StateDep
from ..respond import json_response

__all__ = ["router"]

router = APIRouter(prefix="/api/examples")


@router.get("")
async def list_route(state: StateDep) -> object:
    return json_response(list_examples(state.examples_dir))


@router.get("/{name}")
async def get_route(name: str, state: StateDep) -> object:
    entry = read_example(state.examples_dir, name)
    if entry is None:
        return JSONResponse(
            status_code=404,
            content={"error": {"code": "NOT_FOUND", "message": "unknown example"}},
        )
    return json_response(entry)
