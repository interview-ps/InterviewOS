"""Request body limits — port of `http/middleware/body-limit.ts`.

Pure ASGI middleware (no response buffering, so SSE is untouched). Rejects
over-size requests on Content-Length, and — like Hono's bodyLimit — also reads
chunked bodies up to the limit, aborting with 413 as soon as it is exceeded.
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


def _too_large(message: str) -> bytes:
    return json.dumps({"error": {"code": "TOO_LARGE", "message": message}}).encode()


class BodyLimitMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not scope.get("path", "").startswith("/api"):
            await self.app(scope, receive, send)
            return

        limit, message = _limit_for(scope.get("path", ""), scope.get("method", ""))
        headers = {key.decode().lower(): value.decode() for key, value in scope["headers"]}
        raw_length = headers.get("content-length")
        if raw_length is not None:
            try:
                size = int(raw_length)
            except ValueError:
                size = -1
            if size > limit:
                await self._reject(send, message)
                return

        # Read the (possibly chunked) body, aborting once the limit is exceeded.
        body = bytearray()
        while True:
            event = await receive()
            if event["type"] == "http.disconnect":
                return
            body += event.get("body", b"")
            if len(body) > limit:
                await self._reject(send, message)
                return
            if not event.get("more_body", False):
                break

        sent = False

        async def replay() -> Message:
            nonlocal sent
            if not sent:
                sent = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            # Hand control back to the real channel: streaming responses rely on
            # a subsequent http.disconnect to detect a real client disconnect.
            return await receive()

        await self.app(scope, replay, send)

    @staticmethod
    async def _reject(send: Send, message: str) -> None:
        payload = _too_large(message)
        await send(
            {
                "type": "http.response.start",
                "status": 413,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(payload)).encode()),
                ],
            }
        )
        await send({"type": "http.response.body", "body": payload})
