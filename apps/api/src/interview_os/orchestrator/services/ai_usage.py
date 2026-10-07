"""AI usage service — records and summarises AI-provider usage telemetry.

Receives provider-agnostic `AIUsageEvent`s from the runtimes (via the sink the
`RuntimeManager` is wired with) and persists them append-only to `ai_usage`. It
resolves the interview session from `runtime_sessions` by the provider thread id
so a turn can be attributed without any provider knowledge leaking into `ai/`.

Reads aggregate in SQL (`GROUP BY`) — totals, per-runtime/skill/model breakdowns
and the latest context are summed by the store; only `recent` loads rows.

Distinct from the product-analytics `usage_events`/`HistoryService` surfaces.
"""

from __future__ import annotations

from typing import Any

from ...ai.interface import AIUsageEvent
from ...core.models import (
    AIUsageBreakdown,
    AIUsageContext,
    AIUsageCost,
    AIUsageFilters,
    AIUsageRecord,
    AIUsageSummary,
    AIUsageTotals,
    new_id,
)
from ...store.store import AIUsageRow
from ..context import WorkflowContext

__all__ = ["AIUsageService"]

_RECENT_LIMIT = 50
_UNATTRIBUTED = "unattributed"
_UNKNOWN_MODEL = "unknown"


class AIUsageService:
    def __init__(self, ctx: WorkflowContext) -> None:
        self._ctx = ctx

    # --------------------------------------------------------------- recording

    def record(self, event: AIUsageEvent) -> None:
        """Persist one usage event. Best-effort: never raises into a turn."""

        try:
            interview_session_id = self._resolve_session(event.provider_session_id)
            self._ctx.store.insert_ai_usage(
                AIUsageRow(
                    id=new_id("aiu"),
                    runtime_kind=event.runtime_kind,
                    provider_session_id=event.provider_session_id,
                    interview_session_id=interview_session_id,
                    task_id=event.task_id,
                    model=event.model,
                    attempt=event.attempt,
                    ok=None if event.ok is None else int(event.ok),
                    error_code=event.error_code,
                    input_tokens=event.input_tokens,
                    output_tokens=event.output_tokens,
                    thought_tokens=event.thought_tokens,
                    cached_read_tokens=event.cached_read_tokens,
                    cached_write_tokens=event.cached_write_tokens,
                    total_tokens=event.total_tokens,
                    context_used=event.context_used,
                    context_size=event.context_size,
                    cost_amount=event.cost_amount,
                    cost_currency=event.cost_currency,
                    stop_reason=event.stop_reason,
                    duration_ms=event.duration_ms,
                    created_at=self._ctx.iso(),
                )
            )
        except Exception:  # telemetry must never break a turn
            if self._ctx.logger is not None:
                self._ctx.logger.warn("ai_usage.record_failed", {"runtime": event.runtime_kind})

    def _resolve_session(self, provider_session_id: str | None) -> str | None:
        if provider_session_id is None:
            return None
        row = self._ctx.store.find_runtime_session_by_thread(provider_session_id)
        return None if row is None else row.session_id

    # --------------------------------------------------------------- summary

    def get_summary(self, filters: AIUsageFilters) -> AIUsageSummary:
        store = self._ctx.store
        scope: dict[str, str | None] = {
            "since": filters.from_date,
            "until": _end_of_day(filters.to),
            "runtime": filters.runtime,
            "session": filters.session,
        }
        return AIUsageSummary(
            totals=_totals(store.ai_usage_totals(**scope), store.ai_usage_costs(**scope)),
            by_runtime=_breakdown(store, "runtime", "", scope),
            by_skill=_breakdown(store, "skill", _UNATTRIBUTED, scope),
            by_model=_breakdown(store, "model", _UNKNOWN_MODEL, scope),
            latest_context=_latest_context(store.ai_usage_latest_context(**scope)),
            recent=[
                _record(row) for row in store.list_ai_usage(**scope, limit=_RECENT_LIMIT)
            ],
            filters=filters,
        )

    def clear(self) -> int:
        """Delete every usage row — an explicit user action; returns the count."""

        return self._ctx.store.clear_ai_usage()


def _end_of_day(value: str | None) -> str | None:
    """Make a bare `YYYY-MM-DD` `to` include the whole day (strings sort lexically)."""

    if value is not None and len(value) == 10 and value[4] == "-" and value[7] == "-":
        return f"{value}T23:59:59.999999Z"
    return value


def _costs(rows: list[dict[str, Any]]) -> list[AIUsageCost]:
    """One `AIUsageCost` per currency (never mixed); rows come pre-grouped by SQL."""

    return [
        AIUsageCost(currency=str(row["currency"]), amount=round(float(row["amount"]), 6))
        for row in rows
    ]


def _totals(row: dict[str, Any], cost_rows: list[dict[str, Any]]) -> AIUsageTotals:
    return AIUsageTotals(
        input_tokens=int(row.get("input_tokens") or 0),
        output_tokens=int(row.get("output_tokens") or 0),
        thought_tokens=int(row.get("thought_tokens") or 0),
        cached_read_tokens=int(row.get("cached_read_tokens") or 0),
        cached_write_tokens=int(row.get("cached_write_tokens") or 0),
        total_tokens=int(row.get("total_tokens") or 0),
        turns=int(row.get("turns") or 0),
        tokens_reported=bool(row.get("tokens_reported") or 0),
        cost=_costs(cost_rows),
    )


def _breakdown(
    store: Any,
    group: str,
    empty_label: str,
    scope: dict[str, str | None],
) -> list[AIUsageBreakdown]:
    costs: dict[str, list[AIUsageCost]] = {}
    for row in store.ai_usage_costs(group=group, **scope):
        key = "" if row.get("group_key") is None else str(row["group_key"])
        costs.setdefault(key, []).append(
            AIUsageCost(currency=str(row["currency"]), amount=round(float(row["amount"]), 6))
        )
    breakdowns: list[AIUsageBreakdown] = []
    for entry in store.ai_usage_groups(group, **scope):
        raw = entry.get("group_key")
        key = "" if raw is None else str(raw)
        breakdowns.append(
            AIUsageBreakdown(
                key=key or empty_label,
                label=key or empty_label,
                input_tokens=int(entry.get("input_tokens") or 0),
                output_tokens=int(entry.get("output_tokens") or 0),
                total_tokens=int(entry.get("total_tokens") or 0),
                turns=int(entry.get("turns") or 0),
                cost=costs.get(key, []),
            )
        )
    return breakdowns


def _latest_context(row: dict[str, Any] | None) -> AIUsageContext | None:
    if row is None:
        return None
    return AIUsageContext(
        runtime_kind=str(row["runtime_kind"]),
        provider_session_id=row["provider_session_id"],
        used=int(row["used"]),
        size=int(row["size"]),
        created_at=str(row["created_at"]),
    )


def _record(row: AIUsageRow) -> AIUsageRecord:
    return AIUsageRecord(
        id=row.id,
        runtime_kind=row.runtime_kind,
        provider_session_id=row.provider_session_id,
        interview_session_id=row.interview_session_id,
        task_id=row.task_id,
        model=row.model,
        attempt=row.attempt,
        ok=None if row.ok is None else bool(row.ok),
        error_code=row.error_code,
        input_tokens=row.input_tokens,
        output_tokens=row.output_tokens,
        thought_tokens=row.thought_tokens,
        cached_read_tokens=row.cached_read_tokens,
        cached_write_tokens=row.cached_write_tokens,
        total_tokens=row.total_tokens,
        context_used=row.context_used,
        context_size=row.context_size,
        cost_amount=row.cost_amount,
        cost_currency=row.cost_currency,
        stop_reason=row.stop_reason,
        duration_ms=row.duration_ms,
        created_at=row.created_at,
    )
