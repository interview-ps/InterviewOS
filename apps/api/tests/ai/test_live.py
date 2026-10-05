"""Opt-in smoke tests against real local provider installs.

Gated by the same `INTERVIEW_OS_LIVE_*` variables as the TypeScript suites and
skipped by default, so the normal test run needs no provider CLI and no network:

    INTERVIEW_OS_LIVE_CODEX=1 uv run pytest tests/ai/test_live.py
    INTERVIEW_OS_LIVE_CLAUDE=1 uv run pytest tests/ai/test_live.py
    INTERVIEW_OS_LIVE_OPENCODE=1 uv run pytest tests/ai/test_live.py
    INTERVIEW_OS_LIVE_DEVIN=1 uv run pytest tests/ai/test_live.py
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from interview_os.ai import (
    AgentResult,
    AgentTask,
    ClaudeCodeRuntime,
    ClaudeRuntimeOptions,
    CodexRuntime,
    CodexRuntimeOptions,
    DevinRuntime,
    DevinRuntimeOptions,
    OpencodeRuntime,
    OpencodeRuntimeOptions,
    RuntimeEvent,
    RuntimeMessage,
    SessionInput,
    find_claude_executable,
    find_devin_executable,
    find_opencode_executable,
)

LIVE_CODEX = os.environ.get("INTERVIEW_OS_LIVE_CODEX") == "1"
LIVE_CLAUDE = os.environ.get("INTERVIEW_OS_LIVE_CLAUDE") == "1"
LIVE_OPENCODE = os.environ.get("INTERVIEW_OS_LIVE_OPENCODE") == "1"
LIVE_DEVIN = os.environ.get("INTERVIEW_OS_LIVE_DEVIN") == "1"

LIVE_ENV: dict[str, str] = {**os.environ}


def message(result: AgentResult) -> str:
    return result.error.message if result.error is not None else "unknown error"


@pytest.mark.skipif(not LIVE_CODEX, reason="set INTERVIEW_OS_LIVE_CODEX=1 to run")
async def test_live_codex_health_task_and_session(tmp_path: Path) -> None:
    env = {**LIVE_ENV, "INTERVIEW_OS_CODEX_TIMEOUT_MS": "90000"}
    runtime = CodexRuntime(CodexRuntimeOptions(env=env, workspace_dir=str(tmp_path)))
    try:
        status = await runtime.health_check()
        assert status.available, status.message
        assert status.status == "ready"

        result = await runtime.run_task(
            AgentTask(
                task_id="live-smoke",
                instructions=(
                    "Return a JSON object answering the input question. "
                    "Output only JSON per the schema."
                ),
                input={"question": "What is 6 * 7? Put the number in `answer`."},
                output_schema={
                    "type": "object",
                    "properties": {"answer": {"type": "number"}},
                    "required": ["answer"],
                    "additionalProperties": False,
                },
                timeout_ms=90_000,
            )
        )
        assert result.ok, message(result)
        if result.ok:
            assert isinstance(result.output, dict)
            assert result.output["answer"] == 42

        session = await runtime.create_session(
            SessionInput(developer_instructions='Reply with short JSON: {"echo": <text>}')
        )
        events: list[RuntimeEvent] = []
        async for event in runtime.send_message(
            session.id,
            RuntimeMessage(
                text="ping",
                output_schema={
                    "type": "object",
                    "properties": {"echo": {"type": "string"}},
                    "required": ["echo"],
                    "additionalProperties": False,
                },
            ),
        ):
            events.append(event)
        assert events[-1]["type"] == "completed"
        output = events[-1]["output"]
        assert isinstance(output, dict)
        assert "ping" in str(output["echo"])
    finally:
        await runtime.dispose()


@pytest.mark.skipif(not LIVE_CLAUDE, reason="set INTERVIEW_OS_LIVE_CLAUDE=1 to run")
async def test_live_claude_detects_and_completes_a_structured_task() -> None:
    bin_path = await find_claude_executable(LIVE_ENV)
    assert bin_path, "claude CLI not found"
    runtime = ClaudeCodeRuntime(ClaudeRuntimeOptions(env=LIVE_ENV, workspace_dir=str(Path.cwd())))
    try:
        result = await runtime.run_task(
            AgentTask(
                task_id="live-smoke",
                instructions="Return the JSON object described by the schema.",
                input={"question": "what is 2+2?"},
                output_schema={
                    "type": "object",
                    "properties": {"answer": {"type": "number"}},
                    "required": ["answer"],
                },
                timeout_ms=90_000,
            )
        )
        assert result.ok, message(result)
    finally:
        await runtime.dispose()


@pytest.mark.skipif(not LIVE_OPENCODE, reason="set INTERVIEW_OS_LIVE_OPENCODE=1 to run")
async def test_live_opencode_detects_and_lists_models() -> None:
    bin_path = await find_opencode_executable(LIVE_ENV)
    assert bin_path, "opencode CLI not found"
    runtime = OpencodeRuntime(OpencodeRuntimeOptions(env=LIVE_ENV, workspace_dir=str(Path.cwd())))
    try:
        assert isinstance(await runtime.list_models(), list)
    finally:
        await runtime.dispose()


@pytest.mark.skipif(not LIVE_DEVIN, reason="set INTERVIEW_OS_LIVE_DEVIN=1 to run")
async def test_live_devin_detects_lists_models_and_runs_a_task() -> None:
    bin_path = await find_devin_executable(LIVE_ENV)
    assert bin_path, "devin CLI not found"
    runtime = DevinRuntime(DevinRuntimeOptions(env=LIVE_ENV, workspace_dir=str(Path.cwd())))
    try:
        assert isinstance(await runtime.list_models(), list)
        result = await runtime.run_task(
            AgentTask(
                task_id="devin-live-smoke",
                instructions="Return JSON.",
                input={},
                output_schema={"type": "object", "properties": {"answer": {"type": "number"}}},
                timeout_ms=90_000,
            )
        )
        assert result.ok, message(result)
    finally:
        await runtime.dispose()
