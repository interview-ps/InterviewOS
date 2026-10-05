"""Request body limits — port of `http/middleware/body-limit.ts`.

Pure ASGI middleware (no response buffering, so SSE is untouched): rejects
over-size requests by Content-Length with the same 413 shape as Hono.
"""

from __future__ import annotations

import json

from starlette.types import ASGIApp, Message, Receive, Scope, Send

__all__ = ["BodyLimitMiddleware"]

_API_MAX = 200 * 1024
_IMPORT_MAX = 25 * 1024 * 1024
_DOC_MAX = 5 * 1024 * 1024


def _limit_for(path: str, method: str) -> tuple[int, str]:
    if path == "/api/documents/extract":
        return _DOC_MAX, "file exceeds 5MB"
    if path == "/api/import" and method == "POST":
        return _IMPORT_MAX, "import bundle exceeds 25MB"
    return _API_MAX, "body exceeds 200KB"


class BodyLimitMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path = scope.get("path", "")
        if not path.startswith("/api"):
            await self.app(scope, receive, send)
            return
        method = scope.get("method", "")
        headers = {key.decode().lower(): value.decode() for key, value in scope["headers"]}
        raw_length = headers.get("content-length")
        if raw_length is not None:
            try:
                size = int(raw_length)
            except ValueError:
                size = -1
            limit, message = _limit_for(path, method)
            if size > limit:
                body = json.dumps({"error": {"code": "TOO_LARGE", "message": message}}).encode()
                start: Message = {
                    "type": "http.response.start",
                    "status": 413,
                    "headers": [
                        (b"content-type", b"application/json"),
                        (b"content-length", str(len(body)).encode()),
                    ],
                }
                await send(start)
                await send({"type": "http.response.body", "body": body})
                return
        await self.app(scope, receive, send)
