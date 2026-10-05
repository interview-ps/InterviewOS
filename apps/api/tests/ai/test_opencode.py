"""opencode runtime: child env, detection, one-shot runs, sessions, models.

The runner seam mirrors `packages/runtime/test/opencode.test.ts`; the
real-spawn tests drive `apps/api/tests/fixtures/fake_provider_cli.mjs` so the
stdin-only prompt and the env allowlist are verified end to end.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from interview_os.ai import (
    AgentTask,
    OpencodeRunner,
    OpencodeRunResult,
    OpencodeRuntime,
    OpencodeRuntimeOptions,
    RuntimeEvent,
    RuntimeMessage,
    SessionInput,
    build_opencode_child_env,
    extract_assistant_text,
    opencode_health_check,
    parse_model,
    strip_fence,
)

BASE_ENV: dict[str, str] = {**os.environ, "SECRET_TOKEN": "super-secret-value"}
PROMPT_MARKER = "PROMPT_MARKER-12345"


@pytest.fixture(scope="module")
def fake_cli() -> str:
    path = Path(__file__).parent.parent / "fixtures" / "fake_provider_cli.mjs"
    assert path.exists(), f"missing fixture {path}"
    return str(path)


@pytest.fixture(scope="module")
def workspace(tmp_path_factory: pytest.TempPathFactory) -> str:
    return str(tmp_path_factory.mktemp("ios-opencode-test"))


def runner_for(
    *, text: str | None = None, error: str | None = None, code: int | None = 0
) -> OpencodeRunner:
    """Fake `opencode run --format json` output: NDJSON text parts."""

    async def runner(
        args: list[str], *, timeout_ms: int, stdin: str | None = None
    ) -> OpencodeRunResult:
        if error is not None:
            payload: object = {
                "type": "error",
                "error": {"name": "UnknownError", "data": {"message": error}},
            }
            return OpencodeRunResult(stdout=json.dumps(payload) + "\n", stderr="", code=code)
        text_payload: object = {
            "type": "text",
            "part": {"type": "text", "text": text or '{"answer":42}'},
        }
        return OpencodeRunResult(stdout=json.dumps(text_payload) + "\n", stderr="", code=code)

    return runner


def runtime_with_runner(fake_cli: str, workspace: str, runner: OpencodeRunner) -> OpencodeRuntime:
    return OpencodeRuntime(
        OpencodeRuntimeOptions(
            env={**BASE_ENV, "INTERVIEW_OS_OPENCODE_BIN": fake_cli},
            workspace_dir=workspace,
            runner=runner,
        )
    )


def real_runtime(fake_cli: str, workspace: str, mode: str = "ok") -> OpencodeRuntime:
    return OpencodeRuntime(
        OpencodeRuntimeOptions(
            env={
                **BASE_ENV,
                "INTERVIEW_OS_OPENCODE_BIN": fake_cli,
                "OPENCODE_FAKE_MODE": mode,
            },
            workspace_dir=workspace,
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


def test_child_env_forwards_only_allowlisted_variables() -> None:
    env = build_opencode_child_env(BASE_ENV)
    assert "SECRET_TOKEN" not in env
    assert "PATH" in env


def test_parse_model_requires_a_provider_prefix() -> None:
    assert parse_model("anthropic/claude-sonnet-5") == "anthropic/claude-sonnet-5"
    assert parse_model("sonnet") is None
    assert parse_model("/sonnet") is None
    assert parse_model(None) is None


def test_strip_fence_unwraps_markdown() -> None:
    assert strip_fence('```json\n{"a":1}\n```') == '{"a":1}'
    assert strip_fence('{"a":1}') == '{"a":1}'


def test_extract_assistant_text_collects_text_and_errors() -> None:
    text_lines = "\n".join(
        [
            json.dumps({"type": "text", "part": {"type": "text", "text": "one "}}),
            json.dumps({"type": "text", "part": {"type": "text", "text": "two"}}),
            "not json",
        ]
    )
    result = extract_assistant_text(text_lines)
    assert result.text == "one two"
    assert result.provider_error is None

    error_lines = json.dumps({"type": "error", "error": {"data": {"message": "boom"}}})
    assert extract_assistant_text(error_lines).provider_error == "boom"


async def test_health_check_reports_unavailable_without_the_binary(workspace: str) -> None:
    status = await opencode_health_check(
        {**BASE_ENV, "INTERVIEW_OS_OPENCODE_BIN": "/nonexistent/opencode"}, workspace
    )
    assert status.available is False
    assert status.runtime == "opencode"


async def test_health_check_parses_the_version(fake_cli: str, workspace: str) -> None:
    status = await opencode_health_check(
        {**BASE_ENV, "INTERVIEW_OS_OPENCODE_BIN": fake_cli}, workspace
    )
    assert (status.available, status.version) == (True, "1.2.3")


async def test_run_task_parses_the_assistant_text_part(fake_cli: str, workspace: str) -> None:
    result = await runtime_with_runner(fake_cli, workspace, runner_for()).run_task(task())
    assert result.ok is True
    assert result.output == {"answer": 42}


async def test_run_task_strips_a_markdown_code_fence(fake_cli: str, workspace: str) -> None:
    runtime = runtime_with_runner(
        fake_cli, workspace, runner_for(text='```json\n{"answer":7}\n```')
    )
    result = await runtime.run_task(task())
    assert result.ok is True
    assert result.output == {"answer": 7}


async def test_run_task_reports_malformed_output(fake_cli: str, workspace: str) -> None:
    runtime = runtime_with_runner(fake_cli, workspace, runner_for(text="not json"))
    result = await runtime.run_task(task())
    assert result.ok is False
    assert result.error is not None
    assert result.error.code == "MALFORMED_OUTPUT"


async def test_run_task_reports_a_provider_error_event(fake_cli: str, workspace: str) -> None:
    runtime = runtime_with_runner(fake_cli, workspace, runner_for(error="Unexpected server error"))
    result = await runtime.run_task(task())
    assert result.ok is False
    assert result.error is not None
    assert result.error.code == "CRASHED"
    assert "Unexpected server error" in result.error.message


async def test_run_task_reports_timeout_when_the_process_was_killed(
    fake_cli: str, workspace: str
) -> None:
    runtime = runtime_with_runner(fake_cli, workspace, runner_for(code=None))
    result = await runtime.run_task(task())
    assert result.ok is False
    assert result.error is not None
    assert result.error.code == "TIMEOUT"


async def test_run_task_rejects_an_invalid_model_before_running(
    fake_cli: str, workspace: str
) -> None:
    runtime = runtime_with_runner(fake_cli, workspace, runner_for())
    result = await runtime.run_task(task(model="bad model!"))
    assert result.ok is False
    assert result.error is not None
    assert result.error.code == "PROTOCOL"


async def test_real_cli_keeps_the_prompt_on_stdin(fake_cli: str, workspace: str) -> None:
    result = await real_runtime(fake_cli, workspace).run_task(task())
    assert result.ok is True
    assert isinstance(result.output, dict)
    assert result.output["promptMarkerSeen"] is True
    assert PROMPT_MARKER not in " ".join(str(part) for part in result.output["argv"])
    assert result.output["argv"][0:3] == ["run", "--format", "json"]
    assert result.output["env"] == {"SECRET_TOKEN": False}


async def test_real_cli_passes_a_provider_qualified_model(fake_cli: str, workspace: str) -> None:
    result = await real_runtime(fake_cli, workspace).run_task(
        task(model="anthropic/claude-sonnet-5")
    )
    assert result.ok is True
    assert isinstance(result.output, dict)
    argv = result.output["argv"]
    assert argv[argv.index("-m") + 1] == "anthropic/claude-sonnet-5"


async def test_real_cli_reports_crashed_on_a_non_zero_exit(fake_cli: str, workspace: str) -> None:
    result = await real_runtime(fake_cli, workspace, mode="crash").run_task(task())
    assert result.ok is False
    assert result.error is not None
    assert result.error.code == "CRASHED"
    assert "simulated crash" in result.error.message


async def test_real_cli_reports_malformed_output(fake_cli: str, workspace: str) -> None:
    result = await real_runtime(fake_cli, workspace, mode="malformed").run_task(task())
    assert result.ok is False
    assert result.error is not None
    assert result.error.code == "MALFORMED_OUTPUT"


async def test_real_cli_reports_no_output(fake_cli: str, workspace: str) -> None:
    result = await real_runtime(fake_cli, workspace, mode="empty").run_task(task())
    assert result.ok is False
    assert result.error is not None
    assert result.error.code == "MALFORMED_OUTPUT"
    assert "no text output" in result.error.message


async def test_real_cli_timeout_kills_the_child(fake_cli: str, workspace: str) -> None:
    result = await real_runtime(fake_cli, workspace, mode="hang").run_task(task(timeout_ms=1500))
    assert result.ok is False
    assert result.error is not None
    assert result.error.code == "TIMEOUT"


async def test_session_turn_is_a_one_shot_call(fake_cli: str, workspace: str) -> None:
    runtime = runtime_with_runner(fake_cli, workspace, runner_for(text='{"reply":"hello"}'))
    session = await runtime.create_session(SessionInput())
    assert isinstance(session.thread_id, str)
    events: list[RuntimeEvent] = []
    async for event in runtime.send_message(session.id, RuntimeMessage(text="hi", input={"x": 1})):
        events.append(event)
    assert events[-1]["type"] == "completed"
    assert events[-1]["output"] == {"reply": "hello"}


async def test_unknown_session_errors(fake_cli: str, workspace: str) -> None:
    runtime = runtime_with_runner(fake_cli, workspace, runner_for())
    events: list[RuntimeEvent] = []
    async for event in runtime.send_message("nope", RuntimeMessage(text="hi")):
        events.append(event)
    assert events[0]["type"] == "error"


async def test_resume_session_keeps_the_thread_id(fake_cli: str, workspace: str) -> None:
    runtime = runtime_with_runner(fake_cli, workspace, runner_for())
    session = await runtime.resume_session("thread-9", SessionInput())
    assert session.thread_id == "thread-9"
    await runtime.close_session(session.id)
    events: list[RuntimeEvent] = []
    async for event in runtime.send_message(session.id, RuntimeMessage(text="hi")):
        events.append(event)
    assert events[0]["type"] == "error"


async def test_list_models_maps_provider_qualified_ids(fake_cli: str, workspace: str) -> None:
    models = await real_runtime(fake_cli, workspace).list_models()
    assert [model.id for model in models] == [
        "anthropic/claude-sonnet-5",
        "opencode-go/gpt-5.6-luna",
    ]


async def test_list_models_returns_nothing_without_the_binary(workspace: str) -> None:
    runtime = OpencodeRuntime(
        OpencodeRuntimeOptions(
            env={**BASE_ENV, "INTERVIEW_OS_OPENCODE_BIN": "/nonexistent/opencode"},
            workspace_dir=workspace,
        )
    )
    assert await runtime.list_models() == []
