"""JSON response helper applying the Zod-compatible serializer."""

from __future__ import annotations

from typing import Any

from fastapi.responses import JSONResponse

from ..core.serialize import dump_json

__all__ = ["json_response"]


def json_response(value: Any, *, status_code: int = 200) -> JSONResponse:
    return JSONResponse(status_code=status_code, content=dump_json(value))
