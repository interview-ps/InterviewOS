"""`codex exec --json` JSONL accumulation (port of `codex/CodexEventParser.ts`)."""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal

from ..interface import AgentEvent

__all__ = ["CodexExecEventParser", "ParsedExecLine", "parse_exec_line", "usage_tokens"]

CodexExecEvent = dict[str, object]


def usage_tokens(usage: object) -> dict[str, int | None]:
    """Map a codex `turn.completed.usage` onto our token fields (missing → None)."""

    if not isinstance(usage, Mapping):
        return {}

    def opt(*keys: str) -> int | None:
        for key in keys:
            value = usage.get(key)
            if isinstance(value, int) and not isinstance(value, bool):
                return value
        return None

    return {
        "input": opt("input_tokens", "inputTokens"),
        "output": opt("output_tokens", "outputTokens"),
        "thought": opt("reasoning_output_tokens", "reasoningOutputTokens"),
        "cached_read": opt("cached_input_tokens", "cachedInputTokens"),
        "total": opt("total_tokens", "totalTokens"),
    }


@dataclass(frozen=True, slots=True)
class ParsedExecLine:
    """`kind` is `"malformed"` for non-JSON stdout lines."""

    kind: Literal["event", "malformed"]
    line: str
    event: CodexExecEvent | None = None


def parse_exec_line(line: str) -> ParsedExecLine:
    trimmed = line.strip()
    if trimmed == "":
        return ParsedExecLine(kind="event", line=line, event={"type": "blank"})
    try:
        parsed = json.loads(trimmed)
    except ValueError:
        return ParsedExecLine(kind="malformed", line=line)
    if isinstance(parsed, dict) and isinstance(parsed.get("type"), str):
        return ParsedExecLine(kind="event", line=line, event=parsed)
    return ParsedExecLine(kind="malformed", line=line)


class CodexExecEventParser:
    """Thread/turn lifecycle, agent_message items, usage and non-JSON lines."""

    def __init__(self) -> None:
        self.events: list[AgentEvent] = []
        self.agent_messages: list[str] = []
        self.malformed_event_count = 0
        self.thread_id: str | None = None
        self.usage: object | None = None
        self.failed_message: str | None = None

    def feed(self, line: str) -> None:
        parsed = parse_exec_line(line)
        if parsed.kind == "malformed":
            self.malformed_event_count += 1
            self.events.append({"type": "malformed_event", "line": parsed.line})
            return
        event = parsed.event
        assert event is not None
        event_type = event.get("type")
        if event_type == "blank":
            return
        self.events.append(event)
        if event_type == "thread.started":
            thread_id = event.get("thread_id")
            self.thread_id = thread_id if isinstance(thread_id, str) else None
        elif event_type == "item.completed":
            item = event.get("item")
            if (
                isinstance(item, dict)
                and item.get("type") == "agent_message"
                and isinstance(item.get("text"), str)
            ):
                self.agent_messages.append(str(item["text"]))
        elif event_type == "turn.completed":
            self.usage = event.get("usage")
        elif event_type in ("turn.failed", "error"):
            message = event.get("message")
            error = event.get("error")
            if isinstance(message, str):
                self.failed_message = message
            elif isinstance(error, str):
                self.failed_message = error
            else:
                self.failed_message = str(event_type)

    @property
    def last_agent_message(self) -> str | None:
        return self.agent_messages[-1] if self.agent_messages else None
