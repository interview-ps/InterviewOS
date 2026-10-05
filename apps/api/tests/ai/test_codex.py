"""Codex runtime: `codex exec` one-shot tasks and app-server sessions.

The provider is the shared Node fixture `tests/fixtures/fake-codex.mjs`, driven
through `INTERVIEW_OS_CODEX_BIN` exactly like the TypeScript suite.
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from pathlib import Path

import pytest

from interview_os.ai import (
    AgentTask,
    CodexRuntime,
    CodexRuntimeOptions,
    RuntimeEvent,
    RuntimeMessage,
    SessionInput,
    codex_health_check,
)

BASE_ENV: dict[str, str] = {**os.environ, "SECRET_TOKEN": "super-secret-value"}
PROMPT_MARKER = "PROMPT_MARKER-12345"


@pytest.fixture(scope="module")
def fake_codex(repo_root: Path) -> str:
    path = repo_root / "tests" / "fixtures" / "fake-codex.mjs"
    assert path.exists(), f"missing fixture {path}"
    return str(path)


@pytest.fixture(scope="module")
def workspace(tmp_path_factory: pytest.TempPathFactory) -> str:
    return str(tmp_path_factory.mktemp("ios-codex-test"))


def fake_env(fake_codex: str, mode: str, record: Path | None = None) -> dict[str, str]:
    env = {
        **BASE_ENV,
        "INTERVIEW_OS_CODEX_BIN": fake_codex,
        "FAKE_CODEX_MODE": mode,
    }
    if record is not None:
        env["FAKE_CODEX_RECORD"] = str(record)
    return env


def fake_runtime(
    fake_codex: str, workspace: str, mode: str, record: Path | None = None
) -> CodexRuntime:
    return CodexRuntime(
        CodexRuntimeOptions(
            env=fake_env(fake_codex, mode, record),
            workspace_dir=workspace,
            extra_child_env={"prefixes": ["FAKE_CODEX_"]},
        )
    )


def exec_task(**overrides: object) -> AgentTask:
    values: dict[str, object] = {
        "task_id": "test-task",
        "instructions": f"Return JSON. {PROMPT_MARKER}",
        "input": {"x": 1},
        "output_schema": {"type": "object", "properties": {"answer": {"type": "number"}}},
        "task_mode": "exec",
    }
    values.update(overrides)
    return AgentTask(**values)  # type: ignore[arg-type]


def runtime_message(text: str, output_schema: Mapping[str, object] | None = None) -> RuntimeMessage:
    return RuntimeMessage(text=text, output_schema=dict(output_schema or {}))


def read_record(path: Path) -> list[dict[str, object]]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return []
    return [json.loads(line) for line in text.splitlines() if line.strip()]


async def drain(runtime: CodexRuntime, session_id: str) -> list[RuntimeEvent]:
    events: list[RuntimeEvent] = []
    async for event in runtime.send_message(
        session_id, runtime_message("go", output_schema={"type": "object"})
    ):
        events.append(event)
    return events


async def test_health_check_reports_unavailable_for_a_bogus_bin(workspace: str) -> None:
    status = await codex_health_check(
        {**BASE_ENV, "INTERVIEW_OS_CODEX_BIN": "/nonexistent/codex"}, workspace
    )
    assert status.available is False
    assert status.status == "unavailable"
    assert "codex login" in (status.message or "")


def test_omit_none_matches_json_stringify() -> None:
    from interview_os.ai.codex.session_manager import omit_none

    assert omit_none(model=None, effort="high", threadId="t1") == {
        "effort": "high",
        "threadId": "t1",
    }


async def test_health_check_parses_the_version(fake_codex: str, workspace: str) -> None:
    status = await codex_health_check(fake_env(fake_codex, "ok"), workspace)
    assert (status.available, status.status) == (True, "ready")
    assert status.version == "0.157.0"
    assert status.executable == fake_codex


async def test_exec_fails_unavailable_when_codex_is_missing(workspace: str) -> None:
    runtime = CodexRuntime(
        CodexRuntimeOptions(
            env={**BASE_ENV, "INTERVIEW_OS_CODEX_BIN": "/nonexistent/codex"},
            workspace_dir=workspace,
        )
    )
    result = await runtime.run_task(exec_task())
    assert result.ok is False
    assert result.error is not None
    assert result.error.code == "UNAVAILABLE"


async def test_exec_parses_the_last_agent_message_and_strips_the_secret(
    fake_codex: str, workspace: str
) -> None:
    runtime = fake_runtime(fake_codex, workspace, "ok")
    result = await runtime.run_task(exec_task())
    assert result.ok is True
    assert isinstance(result.output, dict)
    output = result.output
    assert output["answer"] == 42
    # the malformed stdout line was tolerated and recorded
    assert any(event["type"] == "malformed_event" for event in result.events)
    # the prompt travelled on stdin, never in argv
    assert output["promptMarkerSeen"] is True
    assert PROMPT_MARKER not in " ".join(str(part) for part in output["argv"])
    # SECRET_TOKEN is stripped from the child environment
    assert output["env"] == {"SECRET_TOKEN": False}


async def test_exec_argv_and_stdin_marker_are_recorded_by_the_fixture(
    fake_codex: str, workspace: str
) -> None:
    record = Path(workspace) / "record-exec.jsonl"
    runtime = fake_runtime(fake_codex, workspace, "ok", record)
    result = await runtime.run_task(exec_task())
    assert result.ok is True
    assert isinstance(result.output, dict)
    records = read_record(record)
    exec_record = next(record for record in records if record["event"] == "exec")
    argv = exec_record["argv"]
    assert isinstance(argv, list)
    assert argv[0:2] == ["exec", "--json"]
    assert argv[-1] == "-"  # the prompt is read from stdin
    assert argv[argv.index("-C") + 1] == workspace
    schema_file = argv[argv.index("--output-schema") + 1]
    assert isinstance(schema_file, str)
    assert schema_file.endswith("output-schema.json")
    assert PROMPT_MARKER not in " ".join(str(part) for part in argv)
    assert result.output["promptMarkerSeen"] is True
    assert result.output["promptLen"] > len(PROMPT_MARKER)


async def test_exec_reports_crashed_on_a_non_zero_exit(fake_codex: str, workspace: str) -> None:
    result = await fake_runtime(fake_codex, workspace, "crash").run_task(exec_task())
    assert result.ok is False
    assert result.error is not None
    assert result.error.code == "CRASHED"
    assert "simulated crash" in result.error.message


async def test_exec_reports_malformed_event_without_an_agent_message(
    fake_codex: str, workspace: str
) -> None:
    result = await fake_runtime(fake_codex, workspace, "malformed-event").run_task(exec_task())
    assert result.ok is False
    assert result.error is not None
    assert result.error.code == "MALFORMED_EVENT"


async def test_exec_reports_malformed_output_for_non_json_messages(
    fake_codex: str, workspace: str
) -> None:
    result = await fake_runtime(fake_codex, workspace, "malformed-output").run_task(exec_task())
    assert result.ok is False
    assert result.error is not None
    assert result.error.code == "MALFORMED_OUTPUT"


async def test_exec_reports_timeout_and_kills_a_hung_child(fake_codex: str, workspace: str) -> None:
    result = await fake_runtime(fake_codex, workspace, "hang").run_task(exec_task(timeout_ms=1500))
    assert result.ok is False
    assert result.error is not None
    assert result.error.code == "TIMEOUT"


async def test_exec_cleans_up_the_temp_schema_dir(fake_codex: str, workspace: str) -> None:
    await fake_runtime(fake_codex, workspace, "ok").run_task(exec_task())
    assert list((Path(workspace) / ".tmp").iterdir()) == []


async def test_exec_passes_model_and_effort_via_argv(fake_codex: str, workspace: str) -> None:
    record = Path(workspace) / "record-model.jsonl"
    runtime = fake_runtime(fake_codex, workspace, "ok", record)
    result = await runtime.run_task(exec_task(model="fake-large", effort="high"))
    assert result.ok is True
    exec_record = next(record for record in read_record(record) if record["event"] == "exec")
    argv = exec_record["argv"]
    assert isinstance(argv, list)
    assert argv[argv.index("-m") + 1] == "fake-large"
    assert 'model_reasoning_effort="high"' in argv


async def test_app_server_task_streams_deltas_and_records_the_turn(
    fake_codex: str, workspace: str
) -> None:
    record = Path(workspace) / "record-app.jsonl"
    runtime = fake_runtime(fake_codex, workspace, "ok", record)
    try:
        seen: list[RuntimeEvent] = []
        result = await runtime.run_task(exec_task(task_mode=None, on_event=seen.append))
        assert result.ok is True
        assert isinstance(result.output, dict)
        assert result.output["answer"] == 42
        assert result.output["approvalDeclined"] is True
        deltas = [event for event in seen if event["type"] == "delta"]
        assert len(deltas) == 2
        assert "".join(str(event["text"]) for event in deltas) == result.raw
        assert seen[0]["type"] == "started"
        assert result.events == seen

        records = read_record(record)
        thread_start = next(record for record in records if record["event"] == "thread/start")
        assert thread_start["ephemeral"] is True
        turn_start = next(record for record in records if record["event"] == "turn/start")
        assert turn_start["outputSchema"] is True
    finally:
        await runtime.dispose()


async def test_app_server_reports_malformed_output(fake_codex: str, workspace: str) -> None:
    runtime = fake_runtime(fake_codex, workspace, "malformed-output")
    try:
        result = await runtime.run_task(exec_task(task_mode="app-server"))
        assert result.ok is False
        assert result.error is not None
        assert result.error.code == "MALFORMED_OUTPUT"
    finally:
        await runtime.dispose()


async def test_app_server_timeout_interrupts_the_turn(fake_codex: str, workspace: str) -> None:
    record = Path(workspace) / "record-hang.jsonl"
    runtime = fake_runtime(fake_codex, workspace, "hang", record)
    try:
        result = await runtime.run_task(exec_task(task_mode="app-server", timeout_ms=1200))
        assert result.ok is False
        assert result.error is not None
        assert result.error.code == "TIMEOUT"
        assert any(record["event"] == "turn/interrupt" for record in read_record(record))
    finally:
        await runtime.dispose()


async def test_app_server_crash_mid_turn_is_retried_on_the_next_task(
    fake_codex: str, workspace: str
) -> None:
    record = Path(workspace) / "record-crash.jsonl"
    runtime = fake_runtime(fake_codex, workspace, "app-crash-midturn-once", record)
    try:
        crashed = await runtime.run_task(exec_task(task_mode="app-server"))
        assert crashed.ok is False
        assert crashed.error is not None
        assert crashed.error.code == "CRASHED"

        after = await runtime.run_task(exec_task(task_mode="app-server"))
        assert after.ok is True
        assert isinstance(after.output, dict)
        assert after.output["answer"] == 42
    finally:
        await runtime.dispose()


async def test_app_server_passes_model_and_effort_through_the_protocol(
    fake_codex: str, workspace: str
) -> None:
    record = Path(workspace) / "record-effort.jsonl"
    runtime = fake_runtime(fake_codex, workspace, "ok", record)
    try:
        result = await runtime.run_task(
            exec_task(task_mode="app-server", model="fake-large", effort="high")
        )
        assert result.ok is True
        records = read_record(record)
        thread_start = next(record for record in records if record["event"] == "thread/start")
        assert thread_start["model"] == "fake-large"
        turn_start = next(record for record in records if record["event"] == "turn/start")
        assert turn_start["model"] == "fake-large"
        assert turn_start["effort"] == "high"
    finally:
        await runtime.dispose()


async def test_invalid_model_and_effort_are_rejected_before_spawning(
    fake_codex: str, workspace: str
) -> None:
    record = Path(workspace) / "record-invalid.jsonl"
    runtime = fake_runtime(fake_codex, workspace, "ok", record)
    try:
        for task_mode in ("app-server", "exec"):
            bad_model = await runtime.run_task(exec_task(task_mode=task_mode, model="bad model!!"))
            assert bad_model.ok is False
            assert bad_model.error is not None
            assert bad_model.error.code == "PROTOCOL"
            bad_effort = await runtime.run_task(exec_task(task_mode=task_mode, effort="extreme"))
            assert bad_effort.ok is False
            assert bad_effort.error is not None
            assert bad_effort.error.code == "PROTOCOL"
        assert read_record(record) == []
    finally:
        await runtime.dispose()


async def test_list_models_paginates_and_maps_efforts(fake_codex: str, workspace: str) -> None:
    runtime = fake_runtime(fake_codex, workspace, "ok")
    try:
        models = await runtime.list_models()
        assert [model.id for model in models] == ["fake-small", "fake-large"]
        assert models[0].display_name == "Fake Small"
        assert models[0].supported_reasoning_efforts == ["low", "medium"]
        assert models[0].default_reasoning_effort == "medium"
        assert models[1].default_reasoning_effort == "high"
    finally:
        await runtime.dispose()


async def test_session_runs_multi_turn_and_declines_approvals(
    fake_codex: str, workspace: str
) -> None:
    runtime = fake_runtime(fake_codex, workspace, "ok")
    try:
        session = await runtime.create_session(SessionInput(instructions="be helpful"))
        assert session.thread_id == "thread-1"

        async def collect(text: str) -> list[RuntimeEvent]:
            events: list[RuntimeEvent] = []
            async for event in runtime.send_message(
                session.id, runtime_message(text, output_schema={"type": "object"})
            ):
                events.append(event)
            return events

        first = await collect("first")
        assert first[-1]["type"] == "completed"
        assert isinstance(first[-1]["output"], dict)
        assert first[-1]["output"]["answer"] == 42
        assert first[-1]["output"]["approvalDeclined"] is True
        assert any(event["type"] == "delta" for event in first)
        assert any(event["type"] == "message" for event in first)

        second = await collect("second")
        assert second[-1]["type"] == "completed"
        assert isinstance(second[-1]["output"], dict)
        assert second[-1]["output"]["turn"] == 2
    finally:
        await runtime.dispose()


async def test_session_resumes_the_thread_after_an_app_server_crash(
    fake_codex: str, workspace: str
) -> None:
    record = Path(workspace) / "record-resume.jsonl"
    runtime = fake_runtime(fake_codex, workspace, "app-crash-once", record)
    try:
        session = await runtime.create_session(SessionInput())
        first = await drain(runtime, session.id)
        assert first[-1]["type"] == "completed"

        # the fake app-server exited after the first turn; the next message must
        # restart the process, re-initialize, and resume the thread
        second = await drain(runtime, session.id)
        assert second[-1]["type"] == "completed"
        assert isinstance(second[-1]["output"], dict)
        # the restarted fake counts turns from scratch — proof of the restart
        assert second[-1]["output"]["turn"] == 1
        assert second[-1]["output"]["answer"] == 42

        # both turns targeted the same (resumed) thread id
        turn_threads = [
            record["threadId"] for record in read_record(record) if record["event"] == "turn/start"
        ]
        assert turn_threads == [session.thread_id, session.thread_id]
    finally:
        await runtime.dispose()


async def test_app_server_that_crashes_mid_turn_always_reports_crashed(
    fake_codex: str, workspace: str
) -> None:
    runtime = fake_runtime(fake_codex, workspace, "app-crash-midturn")
    try:
        for _ in range(2):
            result = await runtime.run_task(exec_task(task_mode="app-server"))
            assert result.ok is False
            assert result.error is not None
            assert result.error.code == "CRASHED"
    finally:
        await runtime.dispose()


async def test_resume_session_tracks_the_thread_id(fake_codex: str, workspace: str) -> None:
    runtime = fake_runtime(fake_codex, workspace, "ok")
    try:
        session = await runtime.create_session(SessionInput())
        resumed = await runtime.resume_session(session.thread_id, SessionInput())
        assert resumed.thread_id == session.thread_id
        assert resumed.id != session.id
        assert (await drain(runtime, resumed.id))[-1]["type"] == "completed"
    finally:
        await runtime.dispose()


async def test_unknown_session_reports_a_protocol_error(fake_codex: str, workspace: str) -> None:
    runtime = fake_runtime(fake_codex, workspace, "ok")
    try:
        events: list[RuntimeEvent] = []
        async for event in runtime.send_message("ghost", runtime_message("hi")):
            events.append(event)
        assert events[0]["type"] == "error"
        assert events[0]["error"] is not None
        assert events[0]["error"].code == "PROTOCOL"
    finally:
        await runtime.dispose()


async def test_close_session_drops_the_thread(fake_codex: str, workspace: str) -> None:
    runtime = fake_runtime(fake_codex, workspace, "ok")
    try:
        session = await runtime.create_session(SessionInput())
        await runtime.close_session(session.id)
        assert (await drain(runtime, session.id))[0]["type"] == "error"
    finally:
        await runtime.dispose()


async def test_dispose_is_idempotent(fake_codex: str, workspace: str) -> None:
    runtime = fake_runtime(fake_codex, workspace, "ok")
    await runtime.create_session(SessionInput())
    await runtime.dispose()
    await runtime.dispose()
