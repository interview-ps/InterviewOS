"""AcpRuntime over the shared Node fixture `tests/fixtures/fake-acp-agent.mjs`.

The fixture speaks ACP over stdio and echoes whether the prompt (and a secret)
reached it, so these tests verify the transport, the event mapping, the model
wiring, and the security posture (permission always rejected, no fs/terminal
capability, prompt never in argv, child env allowlisted).
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from pathlib import Path

import pytest

from interview_os.ai import (
    AcpRuntime,
    AcpRuntimeOptions,
    AgentTask,
    AIUsageEvent,
    AIUsageSink,
    RuntimeEvent,
    RuntimeMessage,
    SessionInput,
    build_acp_child_env,
    find_acp_executable,
    stop_reason_to_error,
    update_to_event,
)
from interview_os.ai.acp.events import (
    TurnUsage,
    UsageUpdate,
    usage_from_result,
    usage_from_update,
)
from interview_os.ai.providers import OPENCODE_ACP

BASE_ENV: dict[str, str] = {**os.environ, "SECRET_TOKEN": "super-secret-value"}
PROMPT_MARKER = "PROMPT_MARKER-12345"


@pytest.fixture(scope="module")
def agent(repo_root: Path) -> str:
    path = repo_root / "apps" / "api" / "tests" / "fixtures" / "fake-acp-agent.mjs"
    assert path.exists(), f"missing fixture {path}"
    return str(path)


@pytest.fixture(scope="module")
def workspace(tmp_path_factory: pytest.TempPathFactory) -> str:
    return str(tmp_path_factory.mktemp("ios-acp-test"))


def env_for(
    agent: str,
    mode: str = "ok",
    *,
    record: Path | None = None,
    load_session: bool = True,
) -> dict[str, str]:
    env = {
        **BASE_ENV,
        "INTERVIEW_OS_OPENCODE_BIN": agent,
        "FAKE_ACP_MODE": mode,
    }
    if record is not None:
        env["FAKE_ACP_RECORD"] = str(record)
    if not load_session:
        env["FAKE_ACP_LOAD_SESSION"] = "0"
    return env


def runtime_for(env: Mapping[str, str], workspace: str) -> AcpRuntime:
    return AcpRuntime(
        AcpRuntimeOptions(
            config=OPENCODE_ACP,
            env=env,
            workspace_dir=workspace,
            extra_child_env={"prefixes": ["FAKE_ACP_"]},
        )
    )


def task(**overrides: object) -> AgentTask:
    values: dict[str, object] = {
        "task_id": "t",
        "instructions": f"Return JSON. {PROMPT_MARKER}",
        "input": {"x": 1},
        "output_schema": {"type": "object", "properties": {"answer": {"type": "number"}}},
    }
    values.update(overrides)
    return AgentTask(**values)  # type: ignore[arg-type]


def read_record(path: Path) -> list[dict[str, object]]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return []
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def find_event(records: list[dict[str, object]], event: str) -> dict[str, object] | None:
    return next((record for record in records if record["event"] == event), None)


# ---------------------------------------------------------------- pure units


def test_update_to_event_maps_agent_message_chunks_only() -> None:
    chunk = {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "hi"}}
    assert update_to_event(chunk) == {"type": "delta", "text": "hi"}
    assert update_to_event({"sessionUpdate": "agent_thought_chunk"}) is None
    assert update_to_event({"sessionUpdate": "tool_call"}) is None
    assert (
        update_to_event(
            {"sessionUpdate": "agent_message_chunk", "content": {"type": "image", "data": "x"}}
        )
        is None
    )


def test_stop_reason_mapping() -> None:
    assert stop_reason_to_error("end_turn") is None
    assert stop_reason_to_error("refusal") == ("PROTOCOL", "the agent refused to continue the turn")
    assert stop_reason_to_error("cancelled") is not None
    assert stop_reason_to_error(None) is not None


def test_build_acp_child_env_strips_secrets() -> None:
    env = build_acp_child_env(OPENCODE_ACP, BASE_ENV)
    assert "SECRET_TOKEN" not in env
    assert "PATH" in env


# ---------------------------------------------------------------- detection


async def test_health_check_parses_the_version(agent: str, workspace: str) -> None:
    status = await runtime_for(env_for(agent), workspace).health_check()
    assert (status.available, status.status) == (True, "ready")
    assert status.version == "9.9.9"
    assert status.runtime == "opencode"
    assert status.workspace == workspace


async def test_health_check_reports_unavailable_without_the_binary(workspace: str) -> None:
    runtime = runtime_for(
        {**BASE_ENV, "INTERVIEW_OS_OPENCODE_BIN": "/nonexistent/opencode"}, workspace
    )
    status = await runtime.health_check()
    assert status.available is False
    assert status.status == "unavailable"


async def test_find_acp_executable_honours_the_override(agent: str) -> None:
    assert await find_acp_executable(OPENCODE_ACP, env_for(agent)) == agent


# ---------------------------------------------------------------- run_task


async def test_run_task_streams_deltas_and_parses_structured_output(
    agent: str, workspace: str
) -> None:
    seen: list[RuntimeEvent] = []
    runtime = runtime_for(env_for(agent), workspace)
    try:
        result = await runtime.run_task(task(on_event=seen.append))
        assert result.ok is True
        assert isinstance(result.output, dict)
        assert result.output["answer"] == 42
        # the prompt travelled in session/prompt, never argv
        assert result.output["promptMarkerSeen"] is True
        assert result.output["promptLen"] > len(PROMPT_MARKER)
        # SECRET_TOKEN is stripped from the child environment
        assert result.output["env"] == {"SECRET_TOKEN": False}
        deltas = [event for event in seen if event["type"] == "delta"]
        assert len(deltas) == 2
        assert "".join(str(event["text"]) for event in deltas) == result.raw
        assert seen[0]["type"] == "started"
        assert seen[-1]["type"] == "completed"
        assert result.events == seen
    finally:
        await runtime.dispose()


async def test_run_task_records_argv_and_capabilities(agent: str, workspace: str) -> None:
    record = Path(workspace) / "record-cap.jsonl"
    runtime = runtime_for(env_for(agent, record=record), workspace)
    try:
        result = await runtime.run_task(task())
        assert result.ok is True
        records = read_record(record)
        init = find_event(records, "initialize")
        assert init is not None
        caps = init["capabilities"]
        assert caps == {
            "fs": {"readTextFile": False, "writeTextFile": False},
            "terminal": False,
        }
        prompt = find_event(records, "prompt")
        assert prompt is not None
        argv = prompt["argv"]
        assert isinstance(argv, list)
        assert argv == ["acp"]
        assert PROMPT_MARKER not in " ".join(str(part) for part in argv)
    finally:
        await runtime.dispose()


async def test_permission_requests_are_always_rejected(agent: str, workspace: str) -> None:
    record = Path(workspace) / "record-perm.jsonl"
    runtime = runtime_for(env_for(agent, record=record), workspace)
    try:
        result = await runtime.run_task(task())
        assert result.ok is True
        assert isinstance(result.output, dict)
        # the client selected the reject option; the allow option is never chosen
        assert result.output["permissionOutcome"] == "selected"
        assert result.output["permissionOption"] == "reject"
        permission = find_event(read_record(record), "permission")
        assert permission is not None
        assert permission["optionId"] == "reject"
    finally:
        await runtime.dispose()


async def test_unsupported_server_requests_are_refused(agent: str, workspace: str) -> None:
    record = Path(workspace) / "record-fs.jsonl"
    runtime = runtime_for(env_for(agent, "fs", record=record), workspace)
    try:
        result = await runtime.run_task(task())
        assert result.ok is True
        fs_event = find_event(read_record(record), "fs_request")
        assert fs_event is not None
        outcome = fs_event["outcome"]
        assert isinstance(outcome, dict)
        assert outcome["error"]["code"] == -32601
    finally:
        await runtime.dispose()


async def test_run_task_applies_model_and_effort_via_config_options(
    agent: str, workspace: str
) -> None:
    record = Path(workspace) / "record-model.jsonl"
    runtime = runtime_for(env_for(agent, record=record), workspace)
    try:
        result = await runtime.run_task(task(model="fake-large", effort="high"))
        assert result.ok is True
        assert isinstance(result.output, dict)
        assert result.output["model"] == "fake-large"
        assert result.output["effort"] == "high"
        records = read_record(record)
        model_set = find_event(records, "set_config_option")
        assert model_set is not None
        assert (model_set["configId"], model_set["value"]) == ("model", "fake-large")
        assert any(
            record["event"] == "set_config_option" and record["value"] == "high"
            for record in records
        )
    finally:
        await runtime.dispose()


async def test_run_task_reports_malformed_output(agent: str, workspace: str) -> None:
    runtime = runtime_for(env_for(agent, "malformed"), workspace)
    try:
        result = await runtime.run_task(task())
        assert result.ok is False
        assert result.error is not None
        assert result.error.code == "MALFORMED_OUTPUT"
    finally:
        await runtime.dispose()


async def test_run_task_reports_crashed_when_the_agent_dies(agent: str, workspace: str) -> None:
    runtime = runtime_for(env_for(agent, "crash"), workspace)
    try:
        result = await runtime.run_task(task())
        assert result.ok is False
        assert result.error is not None
        assert result.error.code == "CRASHED"
    finally:
        await runtime.dispose()


async def test_run_task_reports_refusal(agent: str, workspace: str) -> None:
    runtime = runtime_for(env_for(agent, "refuse"), workspace)
    try:
        result = await runtime.run_task(task())
        assert result.ok is False
        assert result.error is not None
        assert result.error.code == "PROTOCOL"
    finally:
        await runtime.dispose()


async def test_run_task_timeout_cancels_the_turn(agent: str, workspace: str) -> None:
    record = Path(workspace) / "record-hang.jsonl"
    runtime = runtime_for(env_for(agent, "hang", record=record), workspace)
    try:
        result = await runtime.run_task(task(timeout_ms=1200))
        assert result.ok is False
        assert result.error is not None
        assert result.error.code == "TIMEOUT"
        assert find_event(read_record(record), "cancel") is not None
    finally:
        await runtime.dispose()


async def test_invalid_model_and_effort_are_rejected_before_spawning(
    agent: str, workspace: str
) -> None:
    record = Path(workspace) / "record-invalid.jsonl"
    runtime = runtime_for(env_for(agent, record=record), workspace)
    try:
        bad_model = await runtime.run_task(task(model="bad model!!"))
        assert bad_model.error is not None and bad_model.error.code == "PROTOCOL"
        bad_effort = await runtime.run_task(task(effort="extreme"))
        assert bad_effort.error is not None and bad_effort.error.code == "PROTOCOL"
        assert read_record(record) == []
    finally:
        await runtime.dispose()


# ---------------------------------------------------------------- sessions


async def test_session_streams_turns_and_prepends_developer_instructions(
    agent: str, workspace: str
) -> None:
    record = Path(workspace) / "record-session.jsonl"
    runtime = runtime_for(env_for(agent, record=record), workspace)
    try:
        session = await runtime.create_session(
            SessionInput(developer_instructions="DEVELOPER_MARKER-xyz")
        )
        assert isinstance(session.thread_id, str)

        async def collect(text: str) -> list[RuntimeEvent]:
            events: list[RuntimeEvent] = []
            async for event in runtime.send_message(
                session.id, RuntimeMessage(text=text, output_schema={"type": "object"})
            ):
                events.append(event)
            return events

        first = await collect("first turn")
        assert first[0]["type"] == "started"
        assert first[-1]["type"] == "completed"
        first_output = first[-1].get("output")
        assert isinstance(first_output, dict)
        assert first_output["turn"] == 1

        second = await collect("second turn")
        assert second[-1]["type"] == "completed"
        second_output = second[-1].get("output")
        assert isinstance(second_output, dict)
        assert second_output["turn"] == 2

        prompts = [r for r in read_record(record) if r["event"] == "prompt"]
        # the developer instructions (no ACP field) are prepended once, to turn 1
        first_len = prompts[0]["len"]
        second_len = prompts[1]["len"]
        assert isinstance(first_len, int) and first_len > len("first turn")
        assert second_len == len("second turn")
    finally:
        await runtime.dispose()


async def test_unknown_session_reports_a_protocol_error(agent: str, workspace: str) -> None:
    runtime = runtime_for(env_for(agent), workspace)
    try:
        events: list[RuntimeEvent] = []
        async for event in runtime.send_message("ghost", RuntimeMessage(text="hi")):
            events.append(event)
        assert events[0]["type"] == "error"
        assert events[0]["error"] is not None
        assert events[0]["error"].code == "PROTOCOL"
    finally:
        await runtime.dispose()


async def test_resume_session_loads_when_supported(agent: str, workspace: str) -> None:
    record = Path(workspace) / "record-load.jsonl"
    runtime = runtime_for(env_for(agent, record=record), workspace)
    try:
        session = await runtime.resume_session("ses_existing", SessionInput())
        assert session.thread_id == "ses_existing"
        assert find_event(read_record(record), "session/load") is not None
    finally:
        await runtime.dispose()


async def test_resume_session_falls_back_without_load_support(agent: str, workspace: str) -> None:
    record = Path(workspace) / "record-fallback.jsonl"
    runtime = runtime_for(env_for(agent, record=record, load_session=False), workspace)
    try:
        session = await runtime.resume_session("ses_existing", SessionInput())
        # the caller's thread id is preserved, but a fresh session was created
        assert session.thread_id == "ses_existing"
        records = read_record(record)
        assert find_event(records, "session/load") is None
        assert find_event(records, "session/new") is not None
    finally:
        await runtime.dispose()


async def test_close_session_drops_the_thread(agent: str, workspace: str) -> None:
    runtime = runtime_for(env_for(agent), workspace)
    try:
        session = await runtime.create_session(SessionInput())
        await runtime.close_session(session.id)
        events: list[RuntimeEvent] = []
        async for event in runtime.send_message(session.id, RuntimeMessage(text="hi")):
            events.append(event)
        assert events[0]["type"] == "error"
    finally:
        await runtime.dispose()


# ---------------------------------------------------------------- models / dispose


async def test_list_models_maps_the_config_options(agent: str, workspace: str) -> None:
    runtime = runtime_for(env_for(agent), workspace)
    try:
        models = await runtime.list_models()
        assert [model.id for model in models] == ["fake-small", "fake-large"]
        assert models[0].display_name == "Fake Small"
        assert models[0].is_default is True
    finally:
        await runtime.dispose()


async def test_list_models_falls_back_without_the_binary(workspace: str) -> None:
    config = OPENCODE_ACP
    runtime = runtime_for(
        {**BASE_ENV, "INTERVIEW_OS_OPENCODE_BIN": "/nonexistent/opencode"}, workspace
    )
    assert await runtime.list_models() == list(config.default_models)


async def test_dispose_is_idempotent(agent: str, workspace: str) -> None:
    runtime = runtime_for(env_for(agent), workspace)
    await runtime.create_session(SessionInput())
    await runtime.dispose()
    await runtime.dispose()


# ---------------------------------------------------------------- usage


def _usage_sink(events: list[AIUsageEvent]) -> AIUsageSink:
    class _Recorder:
        def record(self, event: AIUsageEvent) -> None:
            events.append(event)

    return _Recorder()


def runtime_with_sink(env: Mapping[str, str], workspace: str, sink: AIUsageSink) -> AcpRuntime:
    return AcpRuntime(
        AcpRuntimeOptions(
            config=OPENCODE_ACP,
            env=env,
            workspace_dir=workspace,
            extra_child_env={"prefixes": ["FAKE_ACP_"]},
            usage_sink=sink,
        )
    )


def test_usage_from_update_parses_and_skips() -> None:
    assert usage_from_update(
        {"sessionUpdate": "usage_update", "used": 10, "size": 100}
    ) == UsageUpdate(used=10, size=100)
    assert usage_from_update(
        {
            "sessionUpdate": "usage_update",
            "used": 10,
            "size": 100,
            "cost": {"amount": 0.5, "currency": "USD"},
        }
    ) == UsageUpdate(used=10, size=100, amount=0.5, currency="USD")
    # malformed / unknown payloads are skipped, never raised
    assert usage_from_update({"sessionUpdate": "usage_update", "used": 10}) is None
    assert usage_from_update({"sessionUpdate": "usage_update", "used": True, "size": 100}) is None
    assert usage_from_update({"sessionUpdate": "agent_message_chunk"}) is None
    assert usage_from_update(
        {
            "sessionUpdate": "usage_update",
            "used": 10,
            "size": 100,
            "cost": {"amount": "x", "currency": "USD"},
        }
    ) == UsageUpdate(used=10, size=100)


def test_usage_from_result_parses_and_skips() -> None:
    assert usage_from_result(
        {"usage": {"totalTokens": 10, "inputTokens": 7, "outputTokens": 3}}
    ) == TurnUsage(total_tokens=10, input_tokens=7, output_tokens=3)
    assert usage_from_result({"usage": {"inputTokens": 7}}) == TurnUsage(input_tokens=7)
    assert usage_from_result(
        {"usage": {"cachedReadTokens": 5, "cachedWriteTokens": 2}}
    ) == TurnUsage(cached_read_tokens=5, cached_write_tokens=2)
    # no usage field / empty / non-int values are skipped, never raised
    assert usage_from_result({"stopReason": "end_turn"}) is None
    assert usage_from_result({"usage": {}}) is None
    assert usage_from_result({"usage": {"inputTokens": True}}) is None


async def test_run_task_records_tokens_context_and_cost(agent: str, workspace: str) -> None:
    usage: list[AIUsageEvent] = []
    runtime = runtime_with_sink(env_for(agent), workspace, _usage_sink(usage))
    try:
        result = await runtime.run_task(task())
        assert result.ok is True
        assert len(usage) == 1
        event = usage[0]
        assert event.runtime_kind == "opencode"
        assert event.provider_session_id is not None
        assert event.provider_session_id.startswith("ses_fake_")
        assert event.task_id == "t"
        assert event.context_used == 1000 and event.context_size == 200000
        assert event.cost_amount == 0.005 and event.cost_currency == "USD"
        assert event.stop_reason == "end_turn"
        assert event.duration_ms >= 0
        # per-turn tokens from the prompt result (End-Turn Token Usage RFD)
        assert (event.input_tokens, event.output_tokens, event.total_tokens) == (70, 30, 100)
        assert event.ok is True and event.error_code is None
    finally:
        await runtime.dispose()


async def test_attempt_is_recorded(agent: str, workspace: str) -> None:
    usage: list[AIUsageEvent] = []
    runtime = runtime_with_sink(env_for(agent), workspace, _usage_sink(usage))
    try:
        await runtime.run_task(task(attempt=3))
        assert usage[0].attempt == 3
    finally:
        await runtime.dispose()


async def test_failed_turn_records_ok_false_and_the_error_code(agent: str, workspace: str) -> None:
    usage: list[AIUsageEvent] = []
    runtime = runtime_with_sink(env_for(agent, "malformed"), workspace, _usage_sink(usage))
    try:
        result = await runtime.run_task(task())
        assert result.ok is False
        assert result.error is not None and result.error.code == "MALFORMED_OUTPUT"
        assert len(usage) == 1
        event = usage[0]
        assert event.ok is False and event.error_code == "MALFORMED_OUTPUT"
        # the wasted tokens are still recorded
        assert (event.input_tokens, event.output_tokens) == (70, 30)
    finally:
        await runtime.dispose()


async def test_session_cost_is_de_cumulated_per_turn(agent: str, workspace: str) -> None:
    usage: list[AIUsageEvent] = []
    runtime = runtime_with_sink(env_for(agent), workspace, _usage_sink(usage))
    try:
        session = await runtime.create_session(SessionInput())

        async def one_turn(text: str) -> None:
            async for _event in runtime.send_message(
                session.id, RuntimeMessage(text=text, output_schema={"type": "object"})
            ):
                pass

        await one_turn("first")
        await one_turn("second")

        assert len(usage) == 2
        # the agent reports cumulative cost; the runtime emits per-turn deltas
        assert [event.cost_amount for event in usage] == pytest.approx([0.005, 0.010])
        assert [event.context_used for event in usage] == [1000, 2000]
        assert [event.input_tokens for event in usage] == [70, 140]
        assert usage[0].provider_session_id == usage[1].provider_session_id == session.thread_id
    finally:
        await runtime.dispose()


async def test_resumed_session_treats_the_first_cost_reading_as_baseline(
    agent: str, workspace: str
) -> None:
    usage: list[AIUsageEvent] = []
    runtime = runtime_with_sink(env_for(agent), workspace, _usage_sink(usage))
    try:
        session = await runtime.resume_session("ses_resumed", SessionInput())

        async def one_turn(text: str) -> None:
            async for _event in runtime.send_message(
                session.id, RuntimeMessage(text=text, output_schema={"type": "object"})
            ):
                pass

        await one_turn("first")
        await one_turn("second")

        # A resumed session's first cost reading is the prior running total: it
        # seeds the baseline instead of being recorded as this turn's cost.
        assert usage[0].cost_amount is None
        assert usage[1].cost_amount == pytest.approx(0.010)
    finally:
        await runtime.dispose()


async def test_turn_without_tokens_records_context_and_cost_only(
    agent: str, workspace: str
) -> None:
    usage: list[AIUsageEvent] = []
    runtime = runtime_with_sink(env_for(agent, "no-tokens"), workspace, _usage_sink(usage))
    try:
        result = await runtime.run_task(task())
        assert result.ok is True
        assert len(usage) == 1
        event = usage[0]
        assert event.context_used == 1000 and event.cost_amount == 0.005
        assert event.input_tokens is None and event.output_tokens is None
    finally:
        await runtime.dispose()


async def test_turn_without_usage_records_nothing(agent: str, workspace: str) -> None:
    usage: list[AIUsageEvent] = []
    runtime = runtime_with_sink(env_for(agent, "no-usage"), workspace, _usage_sink(usage))
    try:
        result = await runtime.run_task(task())
        assert result.ok is True
        assert usage == []
    finally:
        await runtime.dispose()


async def test_timed_out_turn_still_records_usage(agent: str, workspace: str) -> None:
    usage: list[AIUsageEvent] = []
    runtime = runtime_with_sink(env_for(agent, "hang"), workspace, _usage_sink(usage))
    try:
        result = await runtime.run_task(task(timeout_ms=1200))
        assert result.ok is False
        assert result.error is not None and result.error.code == "TIMEOUT"
        assert len(usage) == 1
        event = usage[0]
        assert event.stop_reason == "cancelled"
        assert (event.input_tokens, event.output_tokens) == (70, 30)
    finally:
        await runtime.dispose()
