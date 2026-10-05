"""Central error translation — port of `http/middleware/error.ts`."""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from ..ai.errors import RuntimeError as RuntimeFailure
from ..ai.structured import StructuredOutputError, StructuredRuntimeError
from ..core.models import AppError

__all__ = ["error_status", "install_error_handlers"]

#: AppError code → HTTP status (the fallback for an unmapped code is 400).
_APP_STATUS: dict[str, int] = {
    "INVALID_TRANSITION": 409,
    "NOT_FOUND": 404,
    "NO_ACTIVE_PROFILE": 409,
    "UNSUPPORTED_FORMAT": 415,
    "EXTRACTION_FAILED": 422,
    "VALIDATION": 400,
    "PLUGIN_OUTPUT": 422,
    "PLUGIN_DISABLED": 409,
    "PLUGIN_INCOMPATIBLE": 409,
    "PLUGIN_INSTALL": 400,
    "PACK_INSTALL": 400,
    "CONFLICT": 409,
    "MCP_UNAVAILABLE": 502,
    "UNAVAILABLE": 503,
}


def error_status(err: BaseException) -> tuple[int, str, str]:
    """Every layer's error taxonomy → (status, code, message)."""

    if isinstance(err, StructuredRuntimeError):
        if err.runtime_code == "UNAVAILABLE":
            return 503, "UNAVAILABLE", str(err.args[0])
        if err.runtime_code == "TIMEOUT":
            return (
                504,
                "RUNTIME_TIMEOUT",
                f'The AI runtime timed out while running "{err.task_id}". {err.args[0]}',
            )
        return (
            502,
            "RUNTIME_FAILED",
            f'The AI runtime failed while running "{err.task_id}". {err.args[0]}',
        )
    if isinstance(err, RuntimeFailure):
        if err.code == "UNAVAILABLE":
            return 503, "UNAVAILABLE", err.message
        if err.code == "TIMEOUT":
            return 504, "RUNTIME_TIMEOUT", err.message
        return 502, "RUNTIME_FAILED", err.message
    if isinstance(err, StructuredOutputError):
        return 502, err.code, str(err.args[0])
    if isinstance(err, AppError):
        return _APP_STATUS.get(err.code, 400), err.code, str(err.args[0])
    return 500, "INTERNAL", str(err)


def _error_response(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message}})


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(_req: Request, exc: Exception) -> JSONResponse:
        status, code, message = error_status(exc)
        return _error_response(status, code, message)

    @app.exception_handler(RuntimeFailure)
    async def _runtime_error(_req: Request, exc: Exception) -> JSONResponse:
        status, code, message = error_status(exc)
        return _error_response(status, code, message)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_req: Request, exc: RequestValidationError) -> JSONResponse:
        # Mirrors the Hono `validate` middleware's message shape.
        parts = []
        for error in exc.errors():
            loc = ".".join(str(item) for item in error.get("loc", []) if item != "body")
            parts.append(f"{loc or 'body'}: {error.get('msg', 'invalid')}")
        return _error_response(400, "VALIDATION", f"invalid request body: {'; '.join(parts)}")

    @app.exception_handler(Exception)
    async def _unhandled(_req: Request, exc: Exception) -> JSONResponse:
        status, code, message = error_status(exc)
        return _error_response(status, code, message)
