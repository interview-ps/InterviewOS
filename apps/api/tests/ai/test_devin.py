"""Devin runtime: child env, detection, one-shot runs, sessions, models.

The runner seam mirrors `packages/runtime/test/devin.test.ts`; the real-spawn
tests drive `apps/api/tests/fixtures/fake_provider_cli.mjs` so the
`--prompt-file` transport (never argv, never stdin) is verified end to end.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from interview_os.ai import (
    AgentTask,
    DevinRunner,
    DevinRunResult,
    DevinRuntime,
    DevinRuntimeOptions,
    RuntimeEvent,
    RuntimeMessage,
    SessionInput,
    build_devin_child_env,
    devin_health_check,
    parse_models_json,
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
    return str(tmp_path_factory.mktemp("ios-devin-test"))


def runner_for(*, text: str | None = None, stderr: str = "", code: int | None = 0) -> DevinRunner:
    """Fake `devin -p` output: the response text lands directly on stdout."""

    async def runner(
        args: list[str], *, timeout_ms: int, prompt: str | None = None
    ) -> DevinRunResult:
        stdout = f"{text}\n" if text is not None else ""
        return DevinRunResult(stdout=stdout, stderr=stderr, code=code)

    return runner


def runtime_with_runner(fake_cli: str, workspace: str, runner: DevinRunner) -> DevinRuntime:
    return DevinRuntime(
        DevinRuntimeOptions(
            env={**BASE_ENV, "INTERVIEW_OS_DEVIN_BIN": fake_cli},
            workspace_dir=workspace,
            runner=runner,
        )
    )


def real_runtime(fake_cli: str, workspace: str, mode: str = "ok") -> DevinRuntime:
    return DevinRuntime(
        DevinRuntimeOptions(
            env={
                **BASE_ENV,
                "INTERVIEW_OS_DEVIN_BIN": fake_cli,
                "DEVIN_FAKE_MODE": mode,
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


def prompt_files(workspace: str) -> list[Path]:
    return list(Path(workspace).glob(".devin-prompt-*.txt"))


def test_child_env_forwards_only_allowlisted_variables() -> None:
    env = build_devin_child_env(BASE_ENV)
    assert "SECRET_TOKEN" not in env
    assert "PATH" in env


def test_strip_fence_unwraps_markdown() -> None:
    assert strip_fence('```json\n{"a":1}\n```') == '{"a":1}'


def test_parse_models_json_walks_the_catalog() -> None:
    models = parse_models_json(
        json.dumps({"families": [{"models": [{"id": "opus"}, {"id": "swe"}]}]})
    )
    assert sorted(model.id for model in models) == ["opus", "swe"]
    assert parse_models_json("not json") == []


async def test_health_check_reports_unavailable_without_the_binary(workspace: str) -> None:
    status = await devin_health_check(
        {**BASE_ENV, "INTERVIEW_OS_DEVIN_BIN": "/nonexistent/devin"}, workspace
    )
    assert status.available is False
    assert status.runtime == "devin"


async def test_health_check_parses_the_version(fake_cli: str, workspace: str) -> None:
    status = await devin_health_check({**BASE_ENV, "INTERVIEW_OS_DEVIN_BIN": fake_cli}, workspace)
    assert (status.available, status.version) == (True, "1.2.3")


async def test_run_task_parses_stdout_as_structured_output(fake_cli: str, workspace: str) -> None:
    runtime = runtime_with_runner(fake_cli, workspace, runner_for(text='{"answer":42}'))
    result = await runtime.run_task(task())
    assert result.ok is True
    assert result.output == {"answer": 42}


async def test_run_task_passes_the_prompt_via_prompt_file(fake_cli: str, workspace: str) -> None:
    seen: list[str] = []

    async def runner(
        args: list[str], *, timeout_ms: int, prompt: str | None = None
    ) -> DevinRunResult:
        seen.extend(args)
        assert prompt is not None
        assert "Return JSON." in prompt
        return DevinRunResult(stdout='{"answer":1}\n', stderr="", code=0)

    result = await runtime_with_runner(fake_cli, workspace, runner).run_task(task())
    assert result.ok is True
    assert "-p" in seen
    flag = seen.index("--prompt-file")
    assert flag > -1
    assert seen[flag + 1].endswith(".txt")
    assert PROMPT_MARKER not in " ".join(seen)


async def test_run_task_strips_a_markdown_code_fence(fake_cli: str, workspace: str) -> None:
    runtime = runtime_with_runner(
        fake_cli, workspace, runner_for(text='```json\n{"answer":7}\n```')
    )
    result = await runtime.run_task(task())
    assert result.ok is True
    assert result.output == {"answer": 7}


async def test_run_task_reports_malformed_output_for_non_json(
    fake_cli: str, workspace: str
) -> None:
    runtime = runtime_with_runner(fake_cli, workspace, runner_for(text="not json"))
    result = await runtime.run_task(task())
    assert result.ok is False
    assert result.error is not None
    assert result.error.code == "MALFORMED_OUTPUT"


async def test_run_task_reports_malformed_output_for_empty_stdout(
    fake_cli: str, workspace: str
) -> None:
    runtime = runtime_with_runner(fake_cli, workspace, runner_for(text=""))
    result = await runtime.run_task(task())
    assert result.ok is False
    assert result.error is not None
    assert result.error.code == "MALFORMED_OUTPUT"


async def test_run_task_reports_crashed_with_the_stderr_detail(
    fake_cli: str, workspace: str
) -> None:
    runtime = runtime_with_runner(
        fake_cli, workspace, runner_for(code=1, stderr="Error: Agent error: quota exhausted")
    )
    result = await runtime.run_task(task())
    assert result.ok is False
    assert result.error is not None
    assert result.error.code == "CRASHED"
    assert "quota exhausted" in result.error.message
    assert "Error:" not in result.error.message


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


async def test_run_task_forwards_a_valid_model_as_model_flag(fake_cli: str, workspace: str) -> None:
    seen: list[str] = []

    async def runner(
        args: list[str], *, timeout_ms: int, prompt: str | None = None
    ) -> DevinRunResult:
        seen.extend(args)
        return DevinRunResult(stdout='{"answer":1}\n', stderr="", code=0)

    await runtime_with_runner(fake_cli, workspace, runner).run_task(task(model="opus"))
    assert seen[0:2] == ["--model", "opus"]


async def test_real_cli_uses_a_workspace_prompt_file(fake_cli: str, workspace: str) -> None:
    result = await real_runtime(fake_cli, workspace).run_task(task())
    assert result.ok is True
    assert isinstance(result.output, dict)
    assert result.output["promptMarkerSeen"] is True
    argv = result.output["argv"]
    assert PROMPT_MARKER not in " ".join(str(part) for part in argv)
    assert argv[0] == "-p"
    flag = argv.index("--prompt-file")
    assert str(argv[flag + 1]).endswith(".txt")
    assert result.output["env"] == {"SECRET_TOKEN": False}
    assert prompt_files(workspace) == []


async def test_real_cli_reports_crashed_on_a_non_zero_exit(fake_cli: str, workspace: str) -> None:
    result = await real_runtime(fake_cli, workspace, mode="crash").run_task(task())
    assert result.ok is False
    assert result.error is not None
    assert result.error.code == "CRASHED"
    assert "simulated crash" in result.error.message
    assert prompt_files(workspace) == []


async def test_real_cli_reports_malformed_output(fake_cli: str, workspace: str) -> None:
    result = await real_runtime(fake_cli, workspace, mode="malformed").run_task(task())
    assert result.ok is False
    assert result.error is not None
    assert result.error.code == "MALFORMED_OUTPUT"


async def test_real_cli_timeout_kills_the_child(fake_cli: str, workspace: str) -> None:
    result = await real_runtime(fake_cli, workspace, mode="hang").run_task(task(timeout_ms=1500))
    assert result.ok is False
    assert result.error is not None
    assert result.error.code == "TIMEOUT"
    assert prompt_files(workspace) == []


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
    session = await runtime.resume_session("thread-3", SessionInput())
    assert session.thread_id == "thread-3"


async def test_list_models_parses_the_cli_catalog(fake_cli: str, workspace: str) -> None:
    models = await real_runtime(fake_cli, workspace).list_models()
    assert sorted(model.id for model in models) == ["opus", "swe"]


async def test_list_models_falls_back_to_family_aliases(fake_cli: str, workspace: str) -> None:
    async def runner(
        args: list[str], *, timeout_ms: int, prompt: str | None = None
    ) -> DevinRunResult:
        return DevinRunResult(stdout="", stderr="error: unexpected argument 'models' found", code=2)

    models = await runtime_with_runner(fake_cli, workspace, runner).list_models()
    assert len(models) > 0
    assert any(model.is_default for model in models)


async def test_list_models_falls_back_without_the_binary(workspace: str) -> None:
    runtime = DevinRuntime(
        DevinRuntimeOptions(
            env={**BASE_ENV, "INTERVIEW_OS_DEVIN_BIN": "/nonexistent/devin"},
            workspace_dir=workspace,
        )
    )
    models = await runtime.list_models()
    assert [model.id for model in models][0] == "adaptive"
