"""`AIRuntime` backed by the Claude Agent SDK (port of `claude/ClaudeCodeRuntime.ts`).

Structured tasks use the SDK's `output_format` JSON-schema mode. Sessions are
one-shot wrappers: each turn runs a fresh query across a local opaque
`threadId`, with no server-side resume.
"""

from __future__ import annotations

import asyncio
import re
import uuid
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass

from ..clock import now_ms
from ..errors import RuntimeError
from ..interface import (
    AgentEvent,
    AgentResult,
    AgentTask,
    AIUsageEvent,
    AIUsageSink,
    ModelInfo,
    RuntimeEvent,
    RuntimeKind,
    RuntimeMessage,
    RuntimeSession,
    RuntimeStatus,
    SessionInput,
    validate_model_and_effort,
)
from ..json_compat import js_dumps
from ..logger import Logger
from ..process import timeout_from_env
from .child_env import build_claude_child_env
from .detect import CLAUDE_SETUP_MESSAGE, claude_health_check, find_claude_executable
from .sdk import ClaudeSdk, ClaudeSdkMessage, ClaudeSdkModelInfo, ClaudeSdkOptions, RealClaudeSdk

__all__ = ["DEFAULT_MODELS", "DEFAULT_TASK_TIMEOUT_MS", "ClaudeCodeRuntime", "ClaudeRuntimeOptions"]

DEFAULT_TASK_TIMEOUT_MS = 120_000

DEFAULT_MODELS: tuple[ModelInfo, ...] = (
    ModelInfo("default", "Default", [], None, is_default=True),
    ModelInfo("sonnet", "Sonnet", [], None),
    ModelInfo("opus", "Opus", [], None),
    ModelInfo("haiku", "Haiku", [], None),
)

TIMEOUT_RE = re.compile(r"timeout|aborted", re.IGNORECASE)
NOT_FOUND_RE = re.compile(r"ENOENT|not found|spawn .*EINVAL")
NETWORK_RE = re.compile(r"fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|getaddrinfo")


@dataclass(frozen=True, slots=True)
class ClaudeRuntimeOptions:
    env: Mapping[str, str]
    workspace_dir: str
    logger: Logger | None = None
    #: Test-only SDK injection.
    sdk: ClaudeSdk | None = None
    #: Test-only escape hatch: additional env keys/prefixes forwarded to children.
    extra_child_env: Mapping[str, list[str]] | None = None
    #: AI usage telemetry sink (best-effort; may be None).
    usage_sink: AIUsageSink | None = None


def _claude_tokens(usage: object) -> dict[str, int | None]:
    """Map the Claude SDK's `usage` onto our token fields (missing → None)."""

    if not isinstance(usage, Mapping):
        return {}

    def opt(*keys: str) -> int | None:
        for key in keys:
            value = usage.get(key)
            if isinstance(value, int) and not isinstance(value, bool):
                return value
        return None

    input_tokens = opt("input_tokens", "inputTokens")
    output_tokens = opt("output_tokens", "outputTokens")
    total = (
        (input_tokens or 0) + (output_tokens or 0)
        if input_tokens is not None or output_tokens is not None
        else None
    )
    return {
        "input": input_tokens,
        "output": output_tokens,
        "cached_read": opt("cache_read_input_tokens", "cacheReadInputTokens"),
        "cached_write": opt("cache_creation_input_tokens", "cacheCreationInputTokens"),
        "total": total,
    }


def result_text(message: ClaudeSdkMessage) -> str:
    value = message.get("result")
    return value if isinstance(value, str) else ""


def as_runtime_error(err: BaseException, step: str, timeout_ms: int, aborted: bool) -> RuntimeError:
    """Turn an opaque SDK/transport error into a typed, actionable failure."""

    if isinstance(err, RuntimeError):
        return err
    message = str(err)
    if aborted or TIMEOUT_RE.search(message):
        return RuntimeError("TIMEOUT", f"claude {step} timed out after {timeout_ms}ms")
    if NOT_FOUND_RE.search(message):
        return RuntimeError(
            "UNAVAILABLE", f"could not launch the Claude Code CLI while {step}: {message}"
        )
    if NETWORK_RE.search(message):
        return RuntimeError(
            "CRASHED",
            f"claude {step} failed to reach the model API: {message}. "
            "Check network access and `claude` login.",
        )
    return RuntimeError("CRASHED", f"claude {step} failed: {message}")


class ClaudeCodeRuntime:
    kind: RuntimeKind = "claude"

    def __init__(self, opts: ClaudeRuntimeOptions) -> None:
        self._opts = opts
        self._sdk: ClaudeSdk = opts.sdk if opts.sdk is not None else RealClaudeSdk()
        self._timeout_ms = timeout_from_env(
            opts.env, "INTERVIEW_OS_CLAUDE_TIMEOUT_MS", DEFAULT_TASK_TIMEOUT_MS
        )
        self._threads: dict[str, RuntimeSession] = {}

    async def health_check(self) -> RuntimeStatus:
        return await claude_health_check(self._opts.env, self._opts.workspace_dir)

    def _base_options(self, instructions: str, model: str | None) -> ClaudeSdkOptions:
        options: ClaudeSdkOptions = {
            "cwd": self._opts.workspace_dir,
            "env": build_claude_child_env(self._opts.env, self._opts.extra_child_env),
            "permission_mode": "dontAsk",
            "allowed_tools": [],
            "setting_sources": [],
            "system_prompt": instructions,
        }
        if model:
            options["model"] = model
        return options

    async def run_task(self, task: AgentTask) -> AgentResult:
        started = now_ms()
        invalid = validate_model_and_effort(task.model, task.effort)
        if invalid is not None:
            return AgentResult.failure(error=invalid, duration_ms=0, events=[])
        bin_path = await find_claude_executable(self._opts.env)
        if bin_path is None:
            return AgentResult.failure(
                error=RuntimeError("UNAVAILABLE", CLAUDE_SETUP_MESSAGE),
                duration_ms=now_ms() - started,
                events=[],
            )

        events: list[AgentEvent] = [RuntimeEvent(type="started")]
        if task.on_event is not None:
            task.on_event(RuntimeEvent(type="started"))
        timeout_ms = task.timeout_ms if task.timeout_ms is not None else self._timeout_ms
        step = "starting the task"
        try:
            result: dict[str, object] | None = None
            step = "waiting for the model response"
            options: ClaudeSdkOptions = {
                **self._base_options(task.instructions, task.model),
                "cli_path": bin_path,
                "output_format": {"type": "json_schema", "schema": task.output_schema},
            }
            stream = self._sdk.query(
                f"{task.instructions}\n\nInput (JSON):\n{js_dumps(task.input)}",
                options,
            )
            async with asyncio.timeout(timeout_ms / 1000):
                async for message in stream:
                    if message.get("type") != "result":
                        continue
                    text = result_text(message)
                    if message.get("is_error"):
                        error = RuntimeError(
                            "CRASHED",
                            f"claude {step} failed: {text or 'the model reported an error'}",
                        )
                        self._warn(
                            "runtime.provider_error",
                            {
                                "runtime": "claude",
                                "taskId": task.task_id,
                                "step": step,
                                "detail": text[:300],
                            },
                        )
                        self._emit_usage(
                            task,
                            usage=message.get("usage"),
                            cost=message.get("total_cost_usd"),
                            ok=False,
                            error_code="CRASHED",
                            duration_ms=now_ms() - started,
                        )
                        return AgentResult.failure(
                            error=error,
                            duration_ms=now_ms() - started,
                            events=events,
                            raw=text,
                        )
                    result = {
                        "structured": message.get("structured_output"),
                        "text": text,
                        "usage": message.get("usage"),
                        "cost": message.get("total_cost_usd"),
                    }
        except TimeoutError:
            return AgentResult.failure(
                error=RuntimeError("TIMEOUT", f"claude task timed out after {timeout_ms}ms"),
                duration_ms=now_ms() - started,
                events=events,
            )
        except Exception as err:  # mirrors the TS catch-all around the SDK stream
            error = as_runtime_error(err, step, timeout_ms, aborted=False)
            self._warn(
                "runtime.task_failed",
                {
                    "runtime": "claude",
                    "taskId": task.task_id,
                    "step": step,
                    "code": error.code,
                    "message": error.message,
                },
            )
            return AgentResult.failure(error=error, duration_ms=now_ms() - started, events=events)

        if result is None:
            return AgentResult.failure(
                error=RuntimeError("MALFORMED_EVENT", "claude stream ended without a result"),
                duration_ms=now_ms() - started,
                events=events,
            )
        structured = result["structured"]
        result_text_value = result["text"]
        raw = (
            js_dumps(structured)
            if structured is not None
            else (result_text_value if isinstance(result_text_value, str) else "")
        )
        completed = RuntimeEvent(type="completed", output=structured, raw=raw)
        events.append(completed)
        if task.on_event is not None:
            task.on_event(completed)
        self._emit_usage(
            task,
            usage=result.get("usage"),
            cost=result.get("cost"),
            ok=True,
            error_code=None,
            duration_ms=now_ms() - started,
        )
        return AgentResult.success(
            output=structured, raw=raw, duration_ms=now_ms() - started, events=events
        )

    async def create_session(self, input: SessionInput) -> RuntimeSession:
        if await find_claude_executable(self._opts.env) is None:
            raise RuntimeError("UNAVAILABLE", CLAUDE_SETUP_MESSAGE)
        session = RuntimeSession(id=str(uuid.uuid4()), thread_id=str(uuid.uuid4()))
        self._threads[session.id] = session
        return session

    async def resume_session(self, thread_id: str, input: SessionInput) -> RuntimeSession:
        if await find_claude_executable(self._opts.env) is None:
            raise RuntimeError("UNAVAILABLE", CLAUDE_SETUP_MESSAGE)
        for session in self._threads.values():
            if session.thread_id == thread_id:
                return session
        session = RuntimeSession(id=str(uuid.uuid4()), thread_id=thread_id)
        self._threads[session.id] = session
        return session

    async def send_message(
        self, session_id: str, msg: RuntimeMessage
    ) -> AsyncIterator[RuntimeEvent]:
        if session_id not in self._threads:
            yield RuntimeEvent(
                type="error",
                error=RuntimeError("PROTOCOL", f'unknown claude session "{session_id}"'),
            )
            return
        invalid = validate_model_and_effort(msg.model, msg.effort)
        if invalid is not None:
            yield RuntimeEvent(type="error", error=invalid)
            return
        # One-shot transport: each turn is a fresh query carrying the full prompt
        # (the caller already includes prior context). No server-side resume.
        yield RuntimeEvent(type="started")
        result = await self.run_task(
            AgentTask(
                task_id=msg.task_id or "session-turn",
                instructions=msg.text,
                input=msg.input if msg.input is not None else {},
                output_schema=msg.output_schema
                if msg.output_schema is not None
                else {"type": "object"},
                model=msg.model,
                effort=msg.effort,
            )
        )
        if result.ok:
            yield RuntimeEvent(type="completed", output=result.output, raw=result.raw or "")
        else:
            assert result.error is not None
            self._warn(
                "runtime.turn_failed",
                {
                    "runtime": "claude",
                    "sessionId": session_id,
                    "code": result.error.code,
                    "message": result.error.message,
                },
            )
            yield RuntimeEvent(type="error", error=result.error)

    async def close_session(self, session_id: str) -> None:
        self._threads.pop(session_id, None)

    async def list_models(self) -> list[ModelInfo]:
        bin_path = await find_claude_executable(self._opts.env)
        if bin_path is None:
            return list(DEFAULT_MODELS)
        try:
            stream = self._sdk.query(
                "",
                {**self._base_options("", None), "cli_path": bin_path, "max_turns": 0},
            )
            models = await stream.supported_models()
            if not models:
                return list(DEFAULT_MODELS)
            return [_model_info(model, index) for index, model in enumerate(models)]
        except Exception:  # mirrors the TS catch-all around the SDK query
            return list(DEFAULT_MODELS)

    async def dispose(self) -> None:
        self._threads.clear()

    def _warn(self, event: str, fields: Mapping[str, object]) -> None:
        if self._opts.logger is not None:
            self._opts.logger.warn(event, fields)

    def _emit_usage(
        self,
        task: AgentTask,
        *,
        usage: object,
        cost: object,
        ok: bool,
        error_code: str | None,
        duration_ms: int,
    ) -> None:
        """Record a claude task's usage/cost (best-effort; no-op without data)."""

        sink = self._opts.usage_sink
        if sink is None:
            return
        tokens = _claude_tokens(usage)
        amount = (
            float(cost)
            if isinstance(cost, (int, float)) and not isinstance(cost, bool)
            else None
        )
        if amount is None and not any(value is not None for value in tokens.values()):
            return
        try:
            sink.record(
                AIUsageEvent(
                    runtime_kind="claude",
                    task_id=task.task_id,
                    model=task.model,
                    attempt=task.attempt,
                    ok=ok,
                    error_code=error_code,
                    input_tokens=tokens.get("input"),
                    output_tokens=tokens.get("output"),
                    cached_read_tokens=tokens.get("cached_read"),
                    cached_write_tokens=tokens.get("cached_write"),
                    total_tokens=tokens.get("total"),
                    cost_amount=amount,
                    cost_currency="USD" if amount is not None else None,
                    stop_reason="end_turn" if ok else None,
                    duration_ms=duration_ms,
                )
            )
        except Exception:  # telemetry must never break a task
            pass


def _model_info(model: ClaudeSdkModelInfo, index: int) -> ModelInfo:
    return ModelInfo(
        id=model.value,
        display_name=model.display_name or model.value,
        supported_reasoning_efforts=list(model.supported_effort_levels),
        default_reasoning_effort=None,
        is_default=index == 0,
    )
