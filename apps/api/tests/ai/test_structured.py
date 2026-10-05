"""`run_structured`: schema conversion, validation, retry, typed errors."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator

import pytest
from pydantic import BaseModel

from interview_os.ai import (
    MAX_ATTEMPTS,
    AgentResult,
    AgentTask,
    MockRuntime,
    ProgressUpdate,
    RuntimeError,
    RuntimeErrorCode,
    RuntimeEvent,
    RuntimeMessage,
    SessionInput,
    SessionRef,
    StructuredOutputError,
    StructuredRuntimeError,
    StructuredTask,
    run_structured,
    to_strict_json_schema,
)


class Inner(BaseModel):
    value: int


class Summary(BaseModel):
    summary: str
    score: float
    inner: Inner
    tags: list[str] = []
    note: str | None = None


class ScriptedRuntime(MockRuntime):
    """A MockRuntime whose `run_task` returns scripted results."""

    def __init__(self, results: list[AgentResult]) -> None:
        super().__init__()
        self._results = results
        self.calls: list[AgentTask] = []

    async def run_task(self, task: AgentTask) -> AgentResult:
        self.calls.append(task)
        index = min(len(self.calls) - 1, len(self._results) - 1)
        return self._results[index]


def success(output: object) -> AgentResult:
    return AgentResult.success(output=output, raw=json.dumps(output), duration_ms=1, events=[])


def failure(code: RuntimeErrorCode, message: str) -> AgentResult:
    return AgentResult.failure(error=RuntimeError(code, message), duration_ms=1, events=[])


def structured_task(**overrides: object) -> StructuredTask[Summary]:
    values: dict[str, object] = {
        "task_id": "summarize",
        "instructions": "Summarize the answer.",
        "input": {"x": 1},
        "schema": Summary,
    }
    values.update(overrides)
    return StructuredTask(**values)  # type: ignore[arg-type]


def valid_output() -> dict[str, object]:
    return {"summary": "ok", "score": 0.5, "inner": {"value": 3}}


def test_to_strict_json_schema_closes_every_object() -> None:
    schema = to_strict_json_schema(Summary)
    assert schema["additionalProperties"] is False
    assert schema["required"] == ["summary", "score", "inner", "tags", "note"]
    definitions = schema["$defs"]
    assert isinstance(definitions, dict)
    inner = definitions["Inner"]
    assert inner["additionalProperties"] is False
    assert inner["required"] == ["value"]


async def test_returns_the_validated_model() -> None:
    runtime = MockRuntime()
    runtime.register("summarize", lambda _input, _task: valid_output())
    parsed = await run_structured(runtime, structured_task())
    assert isinstance(parsed, Summary)
    assert parsed.summary == "ok"
    assert parsed.inner.value == 3
    assert parsed.note is None


async def test_sends_the_strict_schema_to_the_runtime() -> None:
    runtime = MockRuntime()
    seen: list[AgentTask] = []

    def handler(_input: object, task: AgentTask) -> object:
        seen.append(task)
        return valid_output()

    runtime.register("summarize", handler)
    await run_structured(runtime, structured_task())
    assert seen[0].output_schema["additionalProperties"] is False
    assert seen[0].instructions == "Summarize the answer."


async def test_retries_invalid_output_with_the_error_appended() -> None:
    runtime = ScriptedRuntime(
        [success({"summary": 1}), success({"summary": 1}), success(valid_output())]
    )
    parsed = await run_structured(runtime, structured_task())
    assert parsed.summary == "ok"
    assert len(runtime.calls) == 3
    assert runtime.calls[1].instructions.startswith("Summarize the answer.")
    assert "Your previous response was invalid:" in runtime.calls[1].instructions
    assert "summary" in runtime.calls[1].instructions


async def test_retries_retryable_runtime_failures() -> None:
    runtime = ScriptedRuntime([failure("MALFORMED_OUTPUT", "not json"), success(valid_output())])
    parsed = await run_structured(runtime, structured_task())
    assert parsed.summary == "ok"
    assert len(runtime.calls) == 2
    assert "MALFORMED_OUTPUT: not json" in runtime.calls[1].instructions


async def test_raises_a_typed_output_error_after_the_attempts_are_exhausted() -> None:
    runtime = ScriptedRuntime([success({"summary": 1})])
    with pytest.raises(StructuredOutputError) as excinfo:
        await run_structured(runtime, structured_task())
    assert len(runtime.calls) == MAX_ATTEMPTS
    assert excinfo.value.code == "SKILL_OUTPUT"
    assert excinfo.value.task_id == "summarize"
    assert "summary" in str(excinfo.value)


async def test_raises_a_typed_runtime_error_for_non_retryable_failures() -> None:
    runtime = ScriptedRuntime([failure("PROTOCOL", "no handler")])
    with pytest.raises(StructuredRuntimeError) as excinfo:
        await run_structured(runtime, structured_task())
    assert len(runtime.calls) == 1  # not retried
    assert excinfo.value.code == "SKILL_RUNTIME"
    assert excinfo.value.runtime_code == "PROTOCOL"
    assert excinfo.value.task_id == "summarize"


async def test_retryable_failures_end_in_a_typed_output_error() -> None:
    runtime = ScriptedRuntime([failure("MALFORMED_EVENT", "no agent message")])
    with pytest.raises(StructuredOutputError) as excinfo:
        await run_structured(runtime, structured_task())
    assert len(runtime.calls) == MAX_ATTEMPTS
    assert "MALFORMED_EVENT" in str(excinfo.value)


async def test_streams_partial_field_text_and_retry_stages() -> None:
    runtime = MockRuntime()
    outputs = [{"summary": 1}, valid_output()]

    def handler(_input: object, _task: AgentTask) -> object:
        return outputs.pop(0)

    runtime.register("summarize", handler)
    updates: list[ProgressUpdate] = []
    await run_structured(
        runtime,
        structured_task(stream_field="summary", on_progress=updates.append),
    )
    streamed = [update.text for update in updates if update.field == "summary"]
    assert streamed == ["ok"]  # the invalid first attempt streamed a number, not a string
    assert any(update.stage == "retrying" for update in updates)


async def test_routes_through_an_existing_runtime_session() -> None:
    runtime = MockRuntime()
    runtime.register("summarize", lambda _input, _task: valid_output())
    session = await runtime.create_session(SessionInput())
    parsed = await run_structured(
        runtime, structured_task(session=SessionRef(runtime_session_id=session.id))
    )
    assert parsed.summary == "ok"


async def test_reports_an_unknown_session_as_a_runtime_error() -> None:
    runtime = MockRuntime()
    with pytest.raises(StructuredRuntimeError) as excinfo:
        await run_structured(runtime, structured_task(session=SessionRef("ghost")))
    assert excinfo.value.runtime_code == "PROTOCOL"


async def test_session_turns_without_json_output_are_retryable() -> None:
    class BadSessionRuntime(MockRuntime):
        """A session turn that completes with a non-JSON raw payload."""

        def send_message(self, session_id: str, msg: RuntimeMessage) -> AsyncIterator[RuntimeEvent]:
            return self._turns()

        async def _turns(self) -> AsyncIterator[RuntimeEvent]:
            yield RuntimeEvent(type="started")
            yield RuntimeEvent(type="completed", raw="not json")

    runtime = BadSessionRuntime()
    with pytest.raises(StructuredOutputError) as excinfo:
        await run_structured(runtime, structured_task(session=SessionRef("sess-1")))
    assert "MALFORMED_OUTPUT" in str(excinfo.value)


async def test_logs_invocation_and_validation_events() -> None:
    events: list[tuple[str, dict[str, object]]] = []

    class Recorder:
        level = "debug"

        def debug(self, event: str, fields: dict[str, object] | None = None) -> None:
            pass

        def info(self, event: str, fields: dict[str, object] | None = None) -> None:
            events.append((event, dict(fields or {})))

        def warn(self, event: str, fields: dict[str, object] | None = None) -> None:
            events.append((event, dict(fields or {})))

        def error(self, event: str, fields: dict[str, object] | None = None) -> None:
            pass

        def child(self, fields: dict[str, object]) -> Recorder:
            return self

    runtime = MockRuntime()
    runtime.register("summarize", lambda _input, _task: valid_output())
    await run_structured(runtime, structured_task(logger=Recorder()))
    names = [event for event, _fields in events]
    assert names == ["skill.invoked", "runtime.invoked", "output.validated"]
