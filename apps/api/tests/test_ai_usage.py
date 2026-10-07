"""AI usage aggregation — SQL totals/breakdowns over `ai_usage` rows."""

from __future__ import annotations

from typing import Any

from interview_os.orchestrator.services.ai_usage import (
    _breakdown,
    _end_of_day,
    _latest_context,
    _record,
    _totals,
)
from interview_os.store import AIUsageRow, Store

ALL_FILTERS: dict[str, Any] = {
    "since": None,
    "until": None,
    "runtime": None,
    "session": None,
}


def row(**overrides: object) -> AIUsageRow:
    values: dict[str, object] = {
        "id": "aiu_1",
        "runtime_kind": "mock",
        "provider_session_id": "t1",
        "interview_session_id": None,
        "task_id": "resume-analyzer",
        "model": "mock-model",
        "attempt": 1,
        "ok": 1,
        "error_code": None,
        "input_tokens": 10,
        "output_tokens": 4,
        "thought_tokens": 2,
        "cached_read_tokens": 1,
        "cached_write_tokens": 0,
        "total_tokens": 16,
        "context_used": 16,
        "context_size": 200000,
        "cost_amount": 0.5,
        "cost_currency": "USD",
        "stop_reason": "end_turn",
        "duration_ms": 5,
        "created_at": "2026-01-01T00:00:00Z",
    }
    values.update(overrides)
    return AIUsageRow(**values)  # type: ignore[arg-type]


def insert(store: Store, **overrides: object) -> None:
    store.insert_ai_usage(row(**overrides))


def totals_of(store: Store, **filters: Any) -> Any:
    return _totals(store.ai_usage_totals(**filters), store.ai_usage_costs(**filters))


def test_totals_and_costs_keep_currencies_separate(memory_store: Store) -> None:
    insert(memory_store, id="a", input_tokens=10, output_tokens=4, total_tokens=16, cost_amount=0.5)
    insert(memory_store, id="b", input_tokens=5, output_tokens=1, total_tokens=6, cost_amount=0.25)
    insert(
        memory_store,
        id="c",
        cost_amount=0.1,
        cost_currency="EUR",
        input_tokens=None,
        output_tokens=None,
        thought_tokens=None,
        cached_read_tokens=None,
        cached_write_tokens=None,
        total_tokens=None,
    )
    totals = totals_of(memory_store)
    assert totals.turns == 3
    assert totals.input_tokens == 15
    assert totals.output_tokens == 5
    assert totals.total_tokens == 22
    assert totals.tokens_reported is True
    # sorted by currency, amounts summed independently (never mixed)
    assert [(c.currency, c.amount) for c in totals.cost] == [("EUR", 0.1), ("USD", 0.75)]


def test_totals_report_whether_tokens_were_reported(memory_store: Store) -> None:
    insert(
        memory_store,
        input_tokens=None,
        output_tokens=None,
        thought_tokens=None,
        cached_read_tokens=None,
        cached_write_tokens=None,
        total_tokens=None,
    )
    assert totals_of(memory_store).tokens_reported is False


def test_breakdowns_group_by_runtime_skill_and_model(memory_store: Store) -> None:
    insert(memory_store, id="a", runtime_kind="mock", task_id="resume-analyzer", model="m1")
    insert(memory_store, id="b", runtime_kind="mock", task_id="jd-analyzer", model="m2")
    insert(memory_store, id="c", runtime_kind="devin", task_id="resume-analyzer", model="m1")
    insert(memory_store, id="d", runtime_kind="mock", task_id=None, model=None)

    by_runtime = _breakdown(memory_store, "runtime", "", ALL_FILTERS)
    assert {entry.key: entry.turns for entry in by_runtime} == {"mock": 3, "devin": 1}

    by_skill = _breakdown(memory_store, "skill", "unattributed", ALL_FILTERS)
    assert {entry.key: entry.turns for entry in by_skill} == {
        "resume-analyzer": 2,
        "jd-analyzer": 1,
        "unattributed": 1,
    }

    by_model = _breakdown(memory_store, "model", "unknown", ALL_FILTERS)
    assert {entry.key: entry.turns for entry in by_model} == {"m1": 2, "m2": 1, "unknown": 1}


def test_breakdown_carries_cost_per_group(memory_store: Store) -> None:
    insert(memory_store, id="a", runtime_kind="mock", cost_amount=0.5)
    insert(memory_store, id="b", runtime_kind="devin", cost_amount=0.25)
    by_runtime = {
        entry.key: entry for entry in _breakdown(memory_store, "runtime", "", ALL_FILTERS)
    }
    assert [(c.currency, c.amount) for c in by_runtime["mock"].cost] == [("USD", 0.5)]
    assert [(c.currency, c.amount) for c in by_runtime["devin"].cost] == [("USD", 0.25)]


def test_latest_context_prefers_an_interview_session(memory_store: Store) -> None:
    insert(memory_store, id="a", interview_session_id=None, context_used=10, context_size=100)
    insert(memory_store, id="b", interview_session_id="sess_1", context_used=20, context_size=200)
    context = _latest_context(memory_store.ai_usage_latest_context())
    assert context is not None and context.used == 20
    # without an interview row it falls back to the newest reading
    insert(memory_store, id="c", interview_session_id=None, context_used=30, context_size=300)
    fallback = _latest_context(memory_store.ai_usage_latest_context())
    assert fallback is not None and fallback.used == 20


def test_list_ai_usage_filters_and_limits(memory_store: Store) -> None:
    insert(memory_store, id="a", created_at="2026-01-01T00:00:00Z")
    insert(
        memory_store,
        id="b",
        created_at="2026-01-02T00:00:00Z",
        interview_session_id="sess_1",
    )
    insert(memory_store, id="c", created_at="2026-01-03T00:00:00Z")
    assert [row.id for row in memory_store.list_ai_usage(limit=2)] == ["c", "b"]
    assert [row.id for row in memory_store.list_ai_usage(session="sess_1")] == ["b"]


def test_clear_ai_usage_removes_rows(memory_store: Store) -> None:
    insert(memory_store, id="a")
    insert(memory_store, id="b")
    assert memory_store.clear_ai_usage() == 2
    assert memory_store.list_ai_usage() == []


def test_record_round_trips_the_enriched_fields(memory_store: Store) -> None:
    insert(memory_store, model="opencode/sonnet", attempt=2, ok=0, error_code="MALFORMED_OUTPUT")
    result = _record(memory_store.list_ai_usage()[0])
    assert result.model == "opencode/sonnet"
    assert result.attempt == 2
    assert result.ok is False
    assert result.error_code == "MALFORMED_OUTPUT"


def test_end_of_day_expands_a_bare_date() -> None:
    assert _end_of_day(None) is None
    assert _end_of_day("2026-10-07") == "2026-10-07T23:59:59.999999Z"
    assert _end_of_day("2026-10-07T12:00:00Z") == "2026-10-07T12:00:00Z"
