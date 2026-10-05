"""Codex runtime: `codex exec` one-shot tasks and app-server sessions.

Port of `codex/CodexRuntime.ts`.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Mapping, Sequence
from dataclasses import dataclass

from ..clock import now_ms
from ..errors import RuntimeError
from ..interface import (
    AgentResult,
    AgentTask,
    ModelInfo,
    RuntimeEvent,
    RuntimeKind,
    RuntimeMessage,
    RuntimeSession,
    RuntimeStatus,
    SessionInput,
    validate_model_and_effort,
)
from ..logger import Logger
from ..process import ensure_dir, timeout_from_env
from .detect import CODEX_SETUP_MESSAGE, codex_health_check, find_codex_executable
from .exec_adapter import DEFAULT_TASK_TIMEOUT_MS, CodexExecAdapter, CodexExecOptions
from .process import CodexProcess, CodexProcessOptions
from .protocol import as_mapping
from .session_manager import CodexSessionManager, CodexSessionManagerOptions

__all__ = ["CodexRuntime", "CodexRuntimeOptions"]

MODEL_PAGE_LIMIT = 10


@dataclass(frozen=True, slots=True)
class CodexRuntimeOptions:
    env: Mapping[str, str]
    workspace_dir: str
    logger: Logger | None = None
    #: Test-only escape hatch: additional env keys/prefixes forwarded to children.
    extra_child_env: Mapping[str, Sequence[str]] | None = None


class CodexRuntime:
    kind: RuntimeKind = "codex"

    def __init__(self, opts: CodexRuntimeOptions) -> None:
        self._opts = opts
        self._timeout_ms = timeout_from_env(
            opts.env, "INTERVIEW_OS_CODEX_TIMEOUT_MS", DEFAULT_TASK_TIMEOUT_MS
        )
        self._proc: CodexProcess | None = None
        self._sessions: CodexSessionManager | None = None

    async def health_check(self) -> RuntimeStatus:
        return await codex_health_check(self._opts.env, self._opts.workspace_dir)

    async def run_task(self, task: AgentTask) -> AgentResult:
        started = now_ms()
        invalid = validate_model_and_effort(task.model, task.effort)
        if invalid is not None:
            return AgentResult.failure(error=invalid, duration_ms=0, events=[])
        bin_path = await find_codex_executable(self._opts.env)
        if bin_path is None:
            return AgentResult.failure(
                error=RuntimeError("UNAVAILABLE", CODEX_SETUP_MESSAGE),
                duration_ms=now_ms() - started,
                events=[],
            )
        await ensure_dir(self._opts.workspace_dir)
        if (task.task_mode or "app-server") == "exec":
            adapter = CodexExecAdapter(
                CodexExecOptions(
                    bin=bin_path,
                    workspace_dir=self._opts.workspace_dir,
                    env=self._opts.env,
                    default_timeout_ms=self._timeout_ms,
                    extra_child_env=self._opts.extra_child_env,
                )
            )
            return await adapter.run_task(task)
        return await self._session_manager_for(bin_path).run_task(task)

    async def create_session(self, input: SessionInput) -> RuntimeSession:
        bin_path = await find_codex_executable(self._opts.env)
        if bin_path is None:
            raise RuntimeError("UNAVAILABLE", CODEX_SETUP_MESSAGE)
        await ensure_dir(self._opts.workspace_dir)
        return await self._session_manager_for(bin_path).create_session(input)

    async def resume_session(self, thread_id: str, input: SessionInput) -> RuntimeSession:
        bin_path = await find_codex_executable(self._opts.env)
        if bin_path is None:
            raise RuntimeError("UNAVAILABLE", "Codex CLI not found")
        await ensure_dir(self._opts.workspace_dir)
        return await self._session_manager_for(bin_path).resume_session(thread_id, input)

    def _session_manager_for(self, bin_path: str) -> CodexSessionManager:
        if self._sessions is None:
            self._proc = CodexProcess(
                CodexProcessOptions(
                    bin=bin_path,
                    workspace_dir=self._opts.workspace_dir,
                    env=self._opts.env,
                    extra_child_env=self._opts.extra_child_env,
                )
            )
            self._sessions = CodexSessionManager(
                self._proc,
                CodexSessionManagerOptions(
                    workspace_dir=self._opts.workspace_dir,
                    turn_timeout_ms=self._timeout_ms,
                ),
            )
        return self._sessions

    def send_message(self, session_id: str, msg: RuntimeMessage) -> AsyncIterator[RuntimeEvent]:
        manager = self._sessions
        if manager is None:
            return _unknown_session(session_id)
        return manager.send_message(session_id, msg)

    async def close_session(self, session_id: str) -> None:
        if self._sessions is not None:
            await self._sessions.close_session(session_id)

    async def list_models(self) -> list[ModelInfo]:
        """Model catalog via `model/list` on the warm app-server process."""

        bin_path = await find_codex_executable(self._opts.env)
        if bin_path is None:
            return []
        manager = self._session_manager_for(bin_path)
        models: list[ModelInfo] = []
        cursor: str | None = None
        for _ in range(MODEL_PAGE_LIMIT):
            result = as_mapping(await manager.model_list(cursor))
            data = result.get("data")
            for raw in data if isinstance(data, list) else []:
                entry = as_mapping(raw)
                if entry.get("hidden"):
                    continue
                model_id = entry.get("id")
                if not isinstance(model_id, str):
                    continue
                display_name = entry.get("displayName")
                efforts = entry.get("supportedReasoningEfforts")
                default_effort = entry.get("defaultReasoningEffort")
                models.append(
                    ModelInfo(
                        id=model_id,
                        display_name=display_name if isinstance(display_name, str) else model_id,
                        supported_reasoning_efforts=_efforts(efforts),
                        default_reasoning_effort=(
                            default_effort if isinstance(default_effort, str) else None
                        ),
                    )
                )
            next_cursor = result.get("nextCursor")
            if not isinstance(next_cursor, str) or not next_cursor:
                break
            cursor = next_cursor
        return models

    async def dispose(self) -> None:
        proc = self._proc
        self._proc = None
        self._sessions = None
        if proc is not None:
            await proc.close()


def _efforts(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value:
        effort = as_mapping(item).get("reasoningEffort")
        if isinstance(effort, str):
            out.append(effort)
    return out


async def _unknown_session(session_id: str) -> AsyncIterator[RuntimeEvent]:
    yield RuntimeEvent(
        type="error",
        error=RuntimeError("PROTOCOL", f'unknown session "{session_id}"'),
    )
