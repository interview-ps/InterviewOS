"""Documents routes — port of `http/routes/documents.ts`."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from starlette.datastructures import UploadFile

from ...adapters.documents import extract_document
from ...core.models import AppError
from ..deps import StateDep
from ..respond import json_response

__all__ = ["router"]

router = APIRouter(prefix="/api/documents")

#: docBodyLimit: 5 MB (the global ASGI middleware rejects a declared
#: Content-Length; a chunked upload is counted here instead).
_DOC_MAX = 5 * 1024 * 1024


@router.post("/extract")
async def extract(request: Request, state: StateDep) -> object:
    form = await request.form()
    file = form.get("file")
    if not isinstance(file, UploadFile):
        raise AppError("VALIDATION", "multipart field 'file' is required")
    data = await file.read()
    filename = file.filename or ""
    await file.close()
    if len(data) > _DOC_MAX:
        return JSONResponse(
            status_code=413,
            content={"error": {"code": "TOO_LARGE", "message": "file exceeds 5MB"}},
        )
    result = extract_document(data, filename)
    # lengths only — never log document contents
    state.logger.info(
        "document.extracted",
        {
            "nameLength": len(filename),
            "bytes": len(data),
            "format": result.format,
            "chars": len(result.text),
        },
    )
    return json_response(result)
