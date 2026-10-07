"""ACP payload translation for the runtime: streamed events and usage.

Kept free of transport/state so it can be unit-tested directly. Only
`agent_message_chunk` text becomes a streamed `delta`; every other
`session/update` (thoughts, tool calls, plans, mode/config changes) is ignored —
the runtime never surfaces agent tool activity to the caller. Usage is parsed
separately, never surfaced as a `RuntimeEvent`: `usage_from_update` reads the
context size + cumulative cost from a `usage_update`, and `usage_from_result`
reads per-turn token counts off the `session/prompt` result (the End-Turn Token
Usage RFD — parsed when present, never required).
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import TypeGuard

from ..errors import RuntimeErrorCode
from ..interface import RuntimeEvent

__all__ = [
    "TurnUsage",
    "UsageUpdate",
    "extract_text",
    "stop_reason_to_error",
    "update_to_event",
    "usage_from_result",
    "usage_from_update",
]


@dataclass(frozen=True, slots=True)
class UsageUpdate:
    """A parsed `session/update` `usage_update` (context size + optional cost)."""

    used: int
    size: int
    #: Cumulative session cost, when reported.
    amount: float | None = None
    currency: str | None = None


@dataclass(frozen=True, slots=True)
class TurnUsage:
    """Per-turn token counts from a `session/prompt` result (`usage`, if sent)."""

    total_tokens: int | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    thought_tokens: int | None = None
    cached_read_tokens: int | None = None
    cached_write_tokens: int | None = None

    @property
    def reported(self) -> bool:
        """True when the agent reported at least one token count."""

        return any(
            value is not None
            for value in (
                self.total_tokens,
                self.input_tokens,
                self.output_tokens,
                self.thought_tokens,
                self.cached_read_tokens,
                self.cached_write_tokens,
            )
        )


#: ACP `StopReason` → typed failure. `end_turn` is success and handled by the
#: caller; a missing/unknown reason is a protocol violation.
_STOP_REASON_ERRORS: dict[str, tuple[RuntimeErrorCode, str]] = {
    "cancelled": ("TIMEOUT", "turn was cancelled"),
    "refusal": ("PROTOCOL", "the agent refused to continue the turn"),
    "max_tokens": ("PROTOCOL", "the agent hit the model token limit"),
    "max_turn_requests": ("PROTOCOL", "the agent exceeded the per-turn request limit"),
}


def _as_mapping(value: object) -> Mapping[str, object]:
    return value if isinstance(value, Mapping) else {}


def extract_text(content: object) -> str | None:
    """The text of a `ContentBlock::Text`, or `None` for any other block."""

    block = _as_mapping(content)
    text = block.get("text")
    if block.get("type") == "text" and isinstance(text, str):
        return text
    return None


def update_to_event(update: Mapping[str, object]) -> RuntimeEvent | None:
    """Translate one `session/update` payload into a runtime event.

    Returns `None` for updates the runtime does not surface (thoughts, tool
    calls, plans, usage, mode/config changes, replayed history).
    """

    if update.get("sessionUpdate") != "agent_message_chunk":
        return None
    text = extract_text(update.get("content"))
    if text is None:
        return None
    return RuntimeEvent(type="delta", text=text)


def stop_reason_to_error(stop_reason: object) -> tuple[RuntimeErrorCode, str] | None:
    """Map a non-`end_turn` `StopReason` to a `(code, message)` pair."""

    if not isinstance(stop_reason, str):
        return ("PROTOCOL", "the agent returned no stop reason")
    if stop_reason == "end_turn":
        return None
    return _STOP_REASON_ERRORS.get(
        stop_reason, ("PROTOCOL", f'unknown stop reason "{stop_reason}"')
    )


def usage_from_update(update: Mapping[str, object]) -> UsageUpdate | None:
    """Parse a `usage_update` (context size + optional cumulative cost).

    Unknown or malformed payloads return `None` — usage is best-effort and must
    never raise. Booleans are rejected (they are `int` in Python).
    """

    if update.get("sessionUpdate") != "usage_update":
        return None
    used = update.get("used")
    size = update.get("size")
    if not _is_int(used) or not _is_int(size):
        return None
    amount: float | None = None
    currency: str | None = None
    cost = update.get("cost")
    if isinstance(cost, Mapping):
        raw_amount = cost.get("amount")
        raw_currency = cost.get("currency")
        if _is_number(raw_amount) and isinstance(raw_currency, str) and raw_currency:
            amount = float(raw_amount)
            currency = raw_currency
    return UsageUpdate(used=used, size=size, amount=amount, currency=currency)


def usage_from_result(result: Mapping[str, object]) -> TurnUsage | None:
    """Parse per-turn token counts from a `session/prompt` result.

    The End-Turn Token Usage RFD puts `usage` on the prompt response; agents that
    don't implement it simply omit the field. Missing or malformed payloads
    return `None` (usage is best-effort and must never raise).
    """

    usage = result.get("usage")
    if not isinstance(usage, Mapping):
        return None
    parsed = TurnUsage(
        total_tokens=_opt_int(usage.get("totalTokens")),
        input_tokens=_opt_int(usage.get("inputTokens")),
        output_tokens=_opt_int(usage.get("outputTokens")),
        thought_tokens=_opt_int(usage.get("thoughtTokens")),
        cached_read_tokens=_opt_int(usage.get("cachedReadTokens")),
        cached_write_tokens=_opt_int(usage.get("cachedWriteTokens")),
    )
    return parsed if parsed.reported else None


def _opt_int(value: object) -> int | None:
    return value if _is_int(value) else None


def _is_int(value: object) -> TypeGuard[int]:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_number(value: object) -> TypeGuard[int | float]:
    return isinstance(value, (int, float)) and not isinstance(value, bool)

