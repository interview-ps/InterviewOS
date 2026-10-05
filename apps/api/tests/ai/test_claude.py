"""Claude runtime: the injectable SDK seam, one-shot turns, model list.

Mirrors `packages/runtime/test/claude.test.ts`: the SDK is faked so no Claude
Code binary or network is involved.
"""

from __future__ import annotations

import asyncio
import os
import re
import sys
from collections.abc import AsyncIterator

import pytest

from interview_os.ai import (
    AgentTask,
    ClaudeCodeRuntime,
    ClaudeQuery,
    ClaudeRuntimeOptions,
    ClaudeSdkMessage,
    ClaudeSdkModelInfo,
    ClaudeSdkOptions,
    RuntimeError,
    RuntimeEvent,
    RuntimeMessage,
    SessionInput,
    build_claude_child_env,
    claude_health_check,
)

#: The SDK is faked, so the bin only has to exist for the detection probe.
BASE_ENV: dict[str, str] = {
    **os.environ,
    "SECRET_TOKEN": "super-secret-value",
    "INTERVIEW_OS_CLAUDE_BIN": sys.executable,
}


@pytest.fixture(scope="module")
def workspace(tmp_path_factory: pytest.TempPathFactory) -> str:
    return str(tmp_path_factory.mktemp("ios-claude-test"))


def result_message(extra: dict[str, object] | None = None) -> dict[str, object]:
    message: dict[str, object] = {
        "type": "result",
        "subtype": "success",
        "is_error": False,
        "result": "",
        "structured_output": None,
    }
    message.update(extra or {})
    return message


class FakeScript:
    def __init__(
        self,
        messages: list[ClaudeSdkMessage] | None = None,
        models: list[ClaudeSdkModelInfo] | None = None,
        error: str | None = None,
        hang: bool = False,
    ) -> None:
        self.messages = messages or []
        self.models = models or []
        self.error = error
        self.hang = hang


class FakeQuery:
    def __init__(self, script: FakeScript) -> None:
        self._script = script

    def __aiter__(self) -> AsyncIterator[ClaudeSdkMessage]:
        return self._iterate()

    async def _iterate(self) -> AsyncIterator[ClaudeSdkMessage]:
        if self._script.hang:
            await asyncio.sleep(30)
            return
        for message in self._script.messages:
            yield message

    async def supported_models(self) -> list[ClaudeSdkModelInfo]:
        return self._script.models


class FakeSdk:
    def __init__(self, script: FakeScript, captured: dict[str, object]) -> None:
        self._script = script
        self._captured = captured

    def query(self, prompt: str, options: ClaudeSdkOptions) -> ClaudeQuery:
        self._captured["prompt"] = prompt
        self._captured["options"] = options
        if self._script.error is not None:
            raise OSError(self._script.error)
        return FakeQuery(self._script)


def runtime_for(
    workspace: str, script: FakeScript, env: dict[str, str] | None = None
) -> tuple[ClaudeCodeRuntime, dict[str, object]]:
    captured: dict[str, object] = {}
    runtime = ClaudeCodeRuntime(
        ClaudeRuntimeOptions(
            env=env or BASE_ENV,
            workspace_dir=workspace,
            sdk=FakeSdk(script, captured),
            extra_child_env={"keys": ["FAKE_CLAUDE"]},
        )
    )
    return runtime, captured


def task(**overrides: object) -> AgentTask:
    values: dict[str, object] = {
        "task_id": "t",
        "instructions": "Return JSON.",
        "input": {"x": 1},
        "output_schema": {"type": "object", "properties": {"answer": {"type": "number"}}},
    }
    values.update(overrides)
    return AgentTask(**values)  # type: ignore[arg-type]


def test_child_env_forwards_only_allowlisted_variables() -> None:
    env = build_claude_child_env(BASE_ENV)
    assert "SECRET_TOKEN" not in env
    assert "PATH" in env


async def test_health_check_reports_unavailable_without_the_binary(workspace: str) -> None:
    status = await claude_health_check(
        {**BASE_ENV, "INTERVIEW_OS_CLAUDE_BIN": "/nonexistent/claude"}, workspace
    )
    assert status.available is False
    assert status.runtime == "claude"


async def test_run_task_returns_structured_output_without_leaking_the_secret(
    workspace: str,
) -> None:
    runtime, captured = runtime_for(
        workspace, FakeScript(messages=[result_message({"structured_output": {"answer": 42}})])
    )
    result = await runtime.run_task(task())
    assert result.ok is True
    assert result.output == {"answer": 42}
    options = captured["options"]
    assert isinstance(options, dict)
    assert options["permission_mode"] == "dontAsk"
    child_env = options["env"]
    assert isinstance(child_env, dict)
    assert "SECRET_TOKEN" not in child_env
    assert options["output_format"] == {
        "type": "json_schema",
        "schema": {"type": "object", "properties": {"answer": {"type": "number"}}},
    }


async def test_run_task_passes_instructions_through_the_system_prompt(workspace: str) -> None:
    runtime, captured = runtime_for(workspace, FakeScript(messages=[result_message()]))
    await runtime.run_task(task())
    options = captured["options"]
    assert isinstance(options, dict)
    assert options["system_prompt"] == "Return JSON."
    assert captured["prompt"] == 'Return JSON.\n\nInput (JSON):\n{"x":1}'


async def test_run_task_reports_unavailable_when_the_cli_is_missing(workspace: str) -> None:
    runtime, _captured = runtime_for(
        workspace,
        FakeScript(messages=[result_message({"structured_output": {}})]),
        env={**BASE_ENV, "INTERVIEW_OS_CLAUDE_BIN": "/nonexistent/claude"},
    )
    result = await runtime.run_task(task())
    assert result.ok is False
    assert result.error is not None
    assert result.error.code == "UNAVAILABLE"


async def test_run_task_reports_malformed_event_when_no_result_arrives(workspace: str) -> None:
    runtime, _captured = runtime_for(workspace, FakeScript(messages=[]))
    result = await runtime.run_task(task())
    assert result.ok is False
    assert result.error is not None
    assert result.error.code == "MALFORMED_EVENT"


async def test_run_task_reports_crashed_when_the_model_reports_an_error(workspace: str) -> None:
    runtime, _captured = runtime_for(
        workspace,
        FakeScript(messages=[result_message({"is_error": True, "result": "rate limited"})]),
    )
    result = await runtime.run_task(task())
    assert result.ok is False
    assert result.error is not None
    assert result.error.code == "CRASHED"
    assert "rate limited" in result.error.message


async def test_run_task_maps_transport_errors_to_typed_codes(workspace: str) -> None:
    runtime, _captured = runtime_for(workspace, FakeScript(error="spawn claude ENOENT"))
    unavailable = await runtime.run_task(task())
    assert unavailable.error is not None
    assert unavailable.error.code == "UNAVAILABLE"

    runtime, _captured = runtime_for(workspace, FakeScript(error="fetch failed"))
    network = await runtime.run_task(task())
    assert network.error is not None
    assert network.error.code == "CRASHED"
    assert "Check network access" in network.error.message

    runtime, _captured = runtime_for(workspace, FakeScript(error="boom"))
    crashed = await runtime.run_task(task())
    assert crashed.error is not None
    assert crashed.error.code == "CRASHED"


async def test_run_task_times_out_a_hung_stream(workspace: str) -> None:
    runtime, _captured = runtime_for(workspace, FakeScript(hang=True))
    result = await runtime.run_task(task(timeout_ms=300))
    assert result.ok is False
    assert result.error is not None
    assert result.error.code == "TIMEOUT"


async def test_run_task_rejects_an_invalid_model_before_querying(workspace: str) -> None:
    runtime, captured = runtime_for(
        workspace, FakeScript(messages=[result_message({"structured_output": {}})])
    )
    result = await runtime.run_task(task(model="bad model!"))
    assert result.ok is False
    assert result.error is not None
    assert result.error.code == "PROTOCOL"
    assert "options" not in captured


async def test_session_returns_a_local_opaque_thread_id(workspace: str) -> None:
    runtime, _captured = runtime_for(
        workspace, FakeScript(messages=[result_message({"structured_output": {"answer": 7}})])
    )
    session = await runtime.create_session(SessionInput())
    assert re.fullmatch(r"[0-9a-f-]{36}", session.thread_id)
    events: list[RuntimeEvent] = []
    async for event in runtime.send_message(session.id, RuntimeMessage(text="hi")):
        events.append(event)
    assert events[-1]["type"] == "completed"
    assert events[-1]["output"] == {"answer": 7}


async def test_send_message_rejects_an_unknown_session(workspace: str) -> None:
    runtime, _captured = runtime_for(workspace, FakeScript(messages=[]))
    events: list[RuntimeEvent] = []
    async for event in runtime.send_message("nope", RuntimeMessage(text="hi")):
        events.append(event)
    assert events[-1]["type"] == "error"
    assert events[-1]["error"] is not None
    assert events[-1]["error"].code == "PROTOCOL"


async def test_resume_session_reuses_a_known_thread(workspace: str) -> None:
    runtime, _captured = runtime_for(workspace, FakeScript(messages=[]))
    session = await runtime.create_session(SessionInput())
    resumed = await runtime.resume_session(session.thread_id, SessionInput())
    assert resumed.id == session.id
    fresh = await runtime.resume_session("unknown-thread", SessionInput())
    assert fresh.thread_id == "unknown-thread"


async def test_create_session_requires_the_cli(workspace: str) -> None:
    runtime, _captured = runtime_for(
        workspace,
        FakeScript(messages=[]),
        env={**BASE_ENV, "INTERVIEW_OS_CLAUDE_BIN": "/nonexistent/claude"},
    )
    with pytest.raises(RuntimeError) as excinfo:
        await runtime.create_session(SessionInput())
    assert excinfo.value.code == "UNAVAILABLE"


async def test_list_models_maps_the_sdk_catalog_and_falls_back(workspace: str) -> None:
    runtime, _captured = runtime_for(
        workspace,
        FakeScript(
            models=[
                ClaudeSdkModelInfo(
                    value="claude-sonnet-5",
                    display_name="Sonnet 5",
                    supported_effort_levels=["low", "high"],
                )
            ]
        ),
    )
    models = await runtime.list_models()
    assert models[0].id == "claude-sonnet-5"
    assert models[0].is_default is True
    assert models[0].supported_reasoning_efforts == ["low", "high"]

    runtime, _captured = runtime_for(workspace, FakeScript())
    fallback = await runtime.list_models()
    assert [model.id for model in fallback] == ["default", "sonnet", "opus", "haiku"]
    assert fallback[0].is_default is True


async def test_list_models_without_the_cli_returns_the_alias_list(workspace: str) -> None:
    runtime, _captured = runtime_for(
        workspace,
        FakeScript(),
        env={**BASE_ENV, "INTERVIEW_OS_CLAUDE_BIN": "/nonexistent/claude"},
    )
    assert [model.id for model in await runtime.list_models()] == [
        "default",
        "sonnet",
        "opus",
        "haiku",
    ]


async def test_dispose_drops_sessions(workspace: str) -> None:
    runtime, _captured = runtime_for(workspace, FakeScript(messages=[]))
    session = await runtime.create_session(SessionInput())
    await runtime.dispose()
    events: list[RuntimeEvent] = []
    async for event in runtime.send_message(session.id, RuntimeMessage(text="hi")):
        events.append(event)
    assert events[0]["type"] == "error"
