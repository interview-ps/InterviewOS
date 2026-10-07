"""Thin seam over the Python Claude Agent SDK (port of `claude/sdk.ts`).

The seam exists so tests can inject a fake without spawning the real Claude
Code binary. The real implementation wraps `claude_agent_sdk.query`, which
returns an async iterator; the SDK exposes no model catalog, so
`supported_models()` returns an empty list and the runtime falls back to its
alias list.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol

from ..errors import RuntimeError

__all__ = [
    "ClaudeQuery",
    "ClaudeSdk",
    "ClaudeSdkMessage",
    "ClaudeSdkModelInfo",
    "ClaudeSdkOptions",
    "RealClaudeSdk",
]

#: Options handed to the SDK query, in `ClaudeAgentOptions` field names.
ClaudeSdkOptions = dict[str, Any]

#: A SDK message, reduced to the fields the runtime reads.
ClaudeSdkMessage = Mapping[str, object]


@dataclass(frozen=True, slots=True)
class ClaudeSdkModelInfo:
    value: str
    display_name: str = ""
    supported_effort_levels: list[str] = field(default_factory=list)


class ClaudeQuery(Protocol):
    def __aiter__(self) -> AsyncIterator[ClaudeSdkMessage]: ...

    async def supported_models(self) -> list[ClaudeSdkModelInfo]: ...


class ClaudeSdk(Protocol):
    def query(self, prompt: str, options: ClaudeSdkOptions) -> ClaudeQuery: ...


class RealClaudeSdk:
    """`claude_agent_sdk.query`, imported lazily so the seam stays optional."""

    def query(self, prompt: str, options: ClaudeSdkOptions) -> ClaudeQuery:
        return _RealClaudeQuery(prompt, options)


class _RealClaudeQuery:
    def __init__(self, prompt: str, options: ClaudeSdkOptions) -> None:
        try:
            from claude_agent_sdk import ClaudeAgentOptions, query
        except ImportError as err:  # pragma: no cover - dependency is declared
            raise RuntimeError(
                "UNAVAILABLE",
                "the Python claude-agent-sdk is not installed: pip install claude-agent-sdk",
            ) from err
        self._stream = query(prompt=prompt, options=ClaudeAgentOptions(**options))

    def __aiter__(self) -> AsyncIterator[ClaudeSdkMessage]:
        return self._iterate()

    async def _iterate(self) -> AsyncIterator[ClaudeSdkMessage]:
        async for message in self._stream:
            yield _message_to_mapping(message)

    async def supported_models(self) -> list[ClaudeSdkModelInfo]:
        return []


def _message_to_mapping(message: object) -> ClaudeSdkMessage:
    """Reduce a SDK message to the shape the runtime reads.

    The Python SDK's messages carry no `type` discriminator (the TypeScript SDK
    does), so the mapping supplies one.
    """

    from claude_agent_sdk import AssistantMessage, ResultMessage, SystemMessage, UserMessage

    if isinstance(message, ResultMessage):
        return {
            "type": "result",
            "subtype": message.subtype,
            "structured_output": message.structured_output,
            "is_error": message.is_error,
            "result": message.result,
            # Usage/cost for the AI usage page (absent on older SDKs).
            "usage": getattr(message, "usage", None),
            "total_cost_usd": getattr(message, "total_cost_usd", None),
            "duration_ms": getattr(message, "duration_ms", None),
        }
    if isinstance(message, AssistantMessage):
        return {"type": "assistant", "content": message.content, "model": message.model}
    if isinstance(message, UserMessage):
        return {"type": "user", "content": message.content}
    if isinstance(message, SystemMessage):
        return {"type": "system", "subtype": message.subtype, "data": message.data}
    if isinstance(message, Mapping):
        return message
    return {"type": getattr(message, "type", "unknown")}
