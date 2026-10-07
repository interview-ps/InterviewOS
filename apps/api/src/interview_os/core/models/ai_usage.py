"""AI usage models — token/context/cost telemetry reported by the AI runtimes.

This is *AI provider* usage (context-window tokens, cumulative cost), not the
product-analytics `usage_events` table/`/api/events`/`/api/metrics` surfaces.

Only ACP reports these today (opencode/Devin): context size + cumulative cost
via `session/update` `usage_update`, and per-turn token counts on the
`session/prompt` result (the End-Turn Token Usage RFD — parsed when the agent
sends it, so the `*Tokens` fields stay null for agents that don't). The shapes
are provider-agnostic so Codex/Claude can be added later.
"""

from __future__ import annotations

from pydantic import Field

from .shared import CamelModel

__all__ = [
    "AIUsageBreakdown",
    "AIUsageContext",
    "AIUsageCost",
    "AIUsageFilters",
    "AIUsageRecord",
    "AIUsageSummary",
    "AIUsageTotals",
]


class AIUsageCost(CamelModel):
    """A monetary amount in a single ISO-4217 currency (never summed across)."""

    currency: str
    amount: float


class AIUsageRecord(CamelModel):
    """One prompt turn's AI usage — numbers and ids only, never prompt text."""

    id: str
    runtime_kind: str
    #: ACP `sessionId` (the provider's thread), when the turn ran in a session.
    provider_session_id: str | None
    #: The interview session this turn belongs to, resolved from `runtime_sessions`.
    interview_session_id: str | None
    #: Skill/task identifier (`AgentTask.task_id` / `RuntimeMessage.task_id`).
    task_id: str | None
    #: The model the turn ran with (provider-qualified), when known.
    model: str | None
    #: Retry attempt for this task (1-based), when the caller reports one.
    attempt: int | None
    #: Whether the turn succeeded; `error_code` holds its failure code otherwise.
    ok: bool | None
    error_code: str | None
    input_tokens: int | None
    output_tokens: int | None
    thought_tokens: int | None
    cached_read_tokens: int | None
    cached_write_tokens: int | None
    total_tokens: int | None
    context_used: int | None
    context_size: int | None
    #: Per-turn delta of the provider's cumulative session cost.
    cost_amount: float | None
    cost_currency: str | None
    stop_reason: str | None
    duration_ms: int
    created_at: str


class AIUsageTotals(CamelModel):
    input_tokens: int
    output_tokens: int
    thought_tokens: int
    cached_read_tokens: int
    cached_write_tokens: int
    total_tokens: int
    turns: int
    #: Whether any turn reported token counts (vs. context/cost only). Lets the
    #: UI show "not reported" instead of a misleading 0.
    tokens_reported: bool
    #: One entry per currency observed; never mixed into a single number.
    cost: list[AIUsageCost]


class AIUsageBreakdown(CamelModel):
    """Totals for one group (a runtime kind, or a skill/task id)."""

    key: str
    label: str
    input_tokens: int
    output_tokens: int
    total_tokens: int
    turns: int
    cost: list[AIUsageCost]


class AIUsageContext(CamelModel):
    """The latest session context-window reading (for the usage bar)."""

    runtime_kind: str
    provider_session_id: str | None
    used: int
    size: int
    created_at: str


class AIUsageFilters(CamelModel):
    #: `from` is a Python keyword; the wire alias stays `from`.
    from_date: str | None = Field(default=None, alias="from")
    to: str | None = None
    runtime: str | None = None
    #: Restrict to one interview session (`interview_session_id`).
    session: str | None = None


class AIUsageSummary(CamelModel):
    """`GET /api/ai-usage` response."""

    totals: AIUsageTotals
    by_runtime: list[AIUsageBreakdown]
    by_skill: list[AIUsageBreakdown]
    by_model: list[AIUsageBreakdown]
    latest_context: AIUsageContext | None
    recent: list[AIUsageRecord]
    filters: AIUsageFilters
