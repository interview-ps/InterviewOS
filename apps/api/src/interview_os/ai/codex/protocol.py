"""JSON-RPC method wrappers for `codex app-server` (port of `CodexProtocol.ts`)."""

from __future__ import annotations

from collections.abc import Mapping

from .process import CLIENT_INFO, CodexProcess

__all__ = ["APP_SERVER_NOTIFICATIONS", "CodexProtocol"]

#: Notification methods the runtime reacts to; everything else is ignored.
APP_SERVER_NOTIFICATIONS = frozenset(
    {
        "item/agentMessage/delta",
        "item/completed",
        "turn/completed",
        "turn/failed",
        "error",
    }
)

TURN_INTERRUPT_TIMEOUT_MS = 5_000


def as_mapping(value: object) -> Mapping[str, object]:
    return value if isinstance(value, Mapping) else {}


def nested_id(result: object, key: str) -> str | None:
    """Read `result[key].id` when it is a string."""

    value = as_mapping(as_mapping(result).get(key)).get("id")
    return value if isinstance(value, str) else None


class CodexProtocol:
    def __init__(self, proc: CodexProcess) -> None:
        self._proc = proc

    async def initialize(self) -> object:
        return await self._proc.request(
            "initialize",
            {"clientInfo": CLIENT_INFO, "capabilities": None},
        )

    def initialized(self) -> None:
        self._proc.notify("initialized", {})

    async def thread_start(self, params: Mapping[str, object]) -> object:
        return await self._proc.request("thread/start", params)

    async def thread_resume(self, thread_id: str) -> object:
        return await self._proc.request("thread/resume", {"threadId": thread_id})

    async def turn_start(self, params: Mapping[str, object]) -> object:
        return await self._proc.request("turn/start", params)

    async def turn_interrupt(self, thread_id: str, turn_id: str) -> None:
        """Best-effort cancel of an in-flight turn."""

        await self._proc.request(
            "turn/interrupt",
            {"threadId": thread_id, "turnId": turn_id},
            TURN_INTERRUPT_TIMEOUT_MS,
        )

    async def model_list(self, cursor: str | None = None) -> object:
        """One page of the model catalog."""

        return await self._proc.request(
            "model/list",
            {"includeHidden": False, "cursor": cursor},
        )
