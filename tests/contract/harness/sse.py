"""Minimal SSE client/parser for the contract suite.

The backend streams when `?stream=1` or `Accept: text/event-stream`. Events:
`stage {name}`, `delta {field, text}`, `result <same JSON as non-stream>`,
`error {code, message}`, `ping {}` every 10 s. HTTP status stays 200 once
streaming starts; a client disconnect never aborts the operation.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any

import httpx


@dataclass
class SSEEvent:
    event: str
    data: Any


@dataclass
class SSETranscript:
    """Collected events. `ping` heartbeats are dropped on collection."""

    status: int
    events: list[SSEEvent] = field(default_factory=list)
    truncated: bool = False  # client closed before the stream ended

    @property
    def stages(self) -> list[str]:
        return [e.data.get("name") for e in self.events if e.event == "stage"]

    @property
    def deltas(self) -> dict[str, str]:
        """Per-field concatenation of delta text (chunking is not contractual)."""
        out: dict[str, str] = {}
        for e in self.events:
            if e.event == "delta" and isinstance(e.data, dict):
                out[e.data.get("field", "")] = (
                    out.get(e.data.get("field", ""), "") + e.data.get("text", "")
                )
        return out

    @property
    def result(self) -> Any:
        for e in self.events:
            if e.event == "result":
                return e.data
        return None

    @property
    def error(self) -> Any:
        for e in self.events:
            if e.event == "error":
                return e.data
        return None

    def snapshot(self) -> dict[str, Any]:
        """What a client can depend on: ordered stage names, concatenated
        deltas, and the terminal result/error."""
        return {
            "status": self.status,
            "stages": self.stages,
            "deltas": self.deltas,
            "result": self.result,
            "error": self.error,
        }


class SSEStream:
    """An open SSE response. Iterate `events()` or call `collect()`.

    `close()` aborts the client side without waiting — used by the
    disconnect-does-not-abort contract test.
    """

    def __init__(self, cm: Any):
        self._cm = cm
        self._resp: httpx.Response | None = None

    def __enter__(self) -> SSEStream:
        self._resp = self._cm.__enter__()
        return self

    def __exit__(self, *exc: object) -> None:
        self._cm.__exit__(*exc)

    @property
    def status(self) -> int:
        assert self._resp is not None
        return self._resp.status_code

    def events(self) -> Iterator[SSEEvent]:
        assert self._resp is not None
        event: str | None = None
        data_lines: list[str] = []
        for line in self._resp.iter_lines():
            if line == "":
                if event is not None or data_lines:
                    raw = "\n".join(data_lines)
                    try:
                        data = json.loads(raw)
                    except json.JSONDecodeError:
                        data = raw
                    yield SSEEvent(event or "message", data)
                event, data_lines = None, []
                continue
            if line.startswith(":"):
                continue
            if line.startswith("event:"):
                event = line[len("event:") :].strip()
            elif line.startswith("data:"):
                data_lines.append(line[len("data:") :].lstrip())
        if event is not None or data_lines:
            raw = "\n".join(data_lines)
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                data = raw
            yield SSEEvent(event or "message", data)

    def collect(self) -> SSETranscript:
        t = SSETranscript(status=self.status)
        for e in self.events():
            if e.event != "ping":
                t.events.append(e)
        return t

    def close(self) -> None:
        if self._resp is not None:
            self._resp.close()
