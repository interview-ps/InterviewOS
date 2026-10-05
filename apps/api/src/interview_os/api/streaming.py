"""SSE / JSON response helper — port of `http/middleware/stream.ts`.

Streaming activates on `?stream=1` or `Accept: text/event-stream`. Events:
`stage {name}`, `delta {field, text}`, `result <same JSON as non-stream>`,
`error {code, message}`, plus a `ping {}` heartbeat every 10 s. HTTP status
stays 200 once streaming has started; a client disconnect never aborts the
operation (the work runs in a task that outlives the response).
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

from fastapi import Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse, Response, StreamingResponse

from ..ai.interface import ProgressUpdate
from .errors import error_status

__all__ = ["stream_or_json", "wants_stream"]

ProgressCb = Callable[[ProgressUpdate], None]
Runner = Callable[[ProgressCb], Awaitable[Any]]

_PING_SECONDS = 10.0


def wants_stream(request: Request) -> bool:
    if request.query_params.get("stream") == "1":
        return True
    return "text/event-stream" in request.headers.get("accept", "")


def _frame(event: str, data: object) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


def stream_or_json(request: Request, run: Runner) -> Awaitable[Response]:
    if not wants_stream(request):
        return _json_response(run)
    return _streaming_response(run)


async def _streaming_response(run: Runner) -> Response:
    return StreamingResponse(_event_stream(run), media_type="text/event-stream")


async def _json_response(run: Runner) -> JSONResponse:
    result = await run(lambda _p: None)
    return JSONResponse(content=jsonable_encoder(result))


async def _event_stream(run: Runner) -> AsyncIterator[str]:
    queue: asyncio.Queue[ProgressUpdate] = asyncio.Queue()

    def on_progress(update: ProgressUpdate) -> None:
        queue.put_nowait(update)

    # The operation outlives the response: never cancel it on client disconnect.
    task = asyncio.ensure_future(run(on_progress))
    try:
        while True:
            if task.done() and queue.empty():
                break
            getter = asyncio.ensure_future(queue.get())
            done, _pending = await asyncio.wait(
                {getter, task}, timeout=_PING_SECONDS, return_when=asyncio.FIRST_COMPLETED
            )
            if getter in done:
                update = getter.result()
                if update.stage is not None:
                    yield _frame("stage", {"name": update.stage})
                else:
                    yield _frame("delta", {"field": update.field, "text": update.text})
                continue
            if not getter.done():
                getter.cancel()
                await asyncio.gather(getter, return_exceptions=True)
            if task in done:
                continue
            yield _frame("ping", {})
    finally:
        pass

    try:
        result = await task
        yield _frame("result", jsonable_encoder(result))
    except Exception as err:  # noqa: BLE001 - mapped to an SSE error event
        status, code, message = error_status(err)
        yield _frame("error", {"code": code, "message": message})
