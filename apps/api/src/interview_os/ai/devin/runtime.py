"""`AIRuntime` over one-shot `devin -p --prompt-file <file>` invocations.

Port of `devin/DevinRuntime.ts`. Each task is a fresh process — there is no
long-lived server to manage. `-p` prints only the assistant response on stdout;
structured output is the model's JSON reply, validated upstream by
`run_structured`. Sessions are local one-shot wrappers, like claude/opencode.
"""

from __future__ import annotations

import json
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
    EventCallback,
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
from .cli import DevinRunner, run_devin_cli
from .detect import DEVIN_SETUP_MESSAGE, devin_health_check, find_devin_executable

__all__ = ["DEFAULT_MODELS", "DEFAULT_TASK_TIMEOUT_MS", "DevinRuntime", "DevinRuntimeOptions"]

DEFAULT_TASK_TIMEOUT_MS = 120_000
LIST_MODELS_TIMEOUT_MS = 30_000

FENCE_RE = re.compile(r"^```(?:json)?\s*([\s\S]*?)\s*```$", re.IGNORECASE)
MODEL_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
ERROR_PREFIX_RE = re.compile(r"^Error:\s*", re.IGNORECASE)

#: Model family aliases accepted by `devin --model` (see `devin docs`: models).
DEFAULT_MODELS: tuple[ModelInfo, ...] = (
    ModelInfo("adaptive", "Adaptive (auto)", [], None, is_default=True),
    ModelInfo("swe", "SWE (latest)", [], None),
    ModelInfo("opus", "Opus (latest)", [], None),
    ModelInfo("sonnet", "Sonnet (latest)", [], None),
    ModelInfo("gpt", "GPT (latest)", [], None),
    ModelInfo("codex", "Codex (latest)", [], None),
    ModelInfo("gemini", "Gemini (latest)", [], None),
)


@dataclass(frozen=True, slots=True)
class DevinRuntimeOptions:
    env: Mapping[str, str]
    workspace_dir: str
    logger: Logger | None = None
    #: Test-only: run the CLI without spawning it.
    runner: DevinRunner | None = None


def strip_fence(text: str) -> str:
    """Strip a leading/trailing markdown code fence if the model wrapped its JSON."""

    trimmed = text.strip()
    match = FENCE_RE.match(trimmed)
    return match.group(1).strip() if match else trimmed


def as_runtime_error(err: BaseException, step: str) -> RuntimeError:
    if isinstance(err, RuntimeError):
        return err
    message = str(err)
    if re.search(r"timeout|aborted", message, re.IGNORECASE):
        return RuntimeError("TIMEOUT", f"devin {step} timed out")
    if re.search(r"ENOENT|not found|EINVAL", message):
        return RuntimeError(
            "UNAVAILABLE", f"could not launch the Devin CLI while {step}: {message}"
        )
    return RuntimeError("CRASHED", f"devin {step} failed: {message}")


def parse_models_json(stdout: str) -> list[ModelInfo]:
    """Tolerant parse of `devin models list --format json` (newer CLI versions)."""

    try:
        parsed = json.loads(stdout)
    except ValueError:
        return []
    ids: list[str] = []

    def visit(value: object) -> None:
        if isinstance(value, str):
            if MODEL_ID_RE.match(value) and value not in ids:
                ids.append(value)
            return
        if isinstance(value, list):
            for item in value:
                visit(item)
            return
        if isinstance(value, dict):
            for key in ("id", "slug", "name", "model"):
                candidate = value.get(key)
                if isinstance(candidate, str) and MODEL_ID_RE.match(candidate):
                    if candidate not in ids:
                        ids.append(candidate)
                    return
            for item in value.values():
                visit(item)

    visit(parsed)
    return [ModelInfo(model_id, model_id, [], None) for model_id in ids]


class DevinRuntime:
    kind: RuntimeKind = "devin"

    def __init__(self, opts: DevinRuntimeOptions) -> None:
        self._opts = opts
        self._timeout_ms = timeout_from_env(
            opts.env, "INTERVIEW_OS_DEVIN_TIMEOUT_MS", DEFAULT_TASK_TIMEOUT_MS
        )
        self._threads: dict[str, RuntimeSession] = {}

    async def health_check(self) -> RuntimeStatus:
        return await devin_health_check(self._opts.env, self._opts.workspace_dir)

    async def _run(
        self,
        *,
        task_id: str,
        instructions: str,
        input: object,
        output_schema: object | None,
        prompt: str | None,
        model: str | None,
        timeout_ms: int | None,
        on_event: EventCallback | None = None,
    ) -> AgentResult:
        started = now_ms()
        invalid = validate_model_and_effort(model, None)
        if invalid is not None:
            return AgentResult.failure(error=invalid, duration_ms=0, events=[])

        bin_path = await find_devin_executable(self._opts.env)
        if bin_path is None:
            return AgentResult.failure(
                error=RuntimeError("UNAVAILABLE", DEVIN_SETUP_MESSAGE),
                duration_ms=now_ms() - started,
                events=[],
            )

        if prompt is None:
            prompt = "\n".join(
                [
                    instructions,
                    "",
                    "You are a data-extraction function, not a coding assistant. "
                    "Do NOT use tools, read files, or ask questions.",
                    "Reply with ONLY a single JSON value that conforms to this JSON Schema, "
                    "with no prose and no markdown fences:",
                    js_dumps(output_schema if output_schema is not None else {}),
                    "",
                    "Input (JSON):",
                    js_dumps(input),
                ]
            )

        args = ["-p"]
        if model:
            args = ["--model", model, *args]

        effective_timeout = timeout_ms if timeout_ms is not None else self._timeout_ms
        events: list[AgentEvent] = [RuntimeEvent(type="started")]
        if on_event is not None:
            on_event(RuntimeEvent(type="started"))
        step = "running the task"
        try:
            result = await run_devin_cli(
                bin_path,
                args,
                env=self._opts.env,
                workspace_dir=self._opts.workspace_dir,
                prompt=f"{prompt}\n",
                timeout_ms=effective_timeout,
                runner=self._opts.runner,
            )
        except Exception as err:  # mirrors the TS catch-all around the CLI run
            error = as_runtime_error(err, step)
            self._warn(
                "runtime.task_failed",
                {
                    "runtime": "devin",
                    "taskId": task_id,
                    "step": step,
                    "code": error.code,
                    "message": error.message,
                },
            )
            return AgentResult.failure(error=error, duration_ms=now_ms() - started, events=events)

        duration_ms = now_ms() - started
        if result.code is None:
            return AgentResult.failure(
                error=RuntimeError("TIMEOUT", f"devin did not finish within {effective_timeout}ms"),
                duration_ms=duration_ms,
                events=events,
            )
        if result.code != 0:
            detail = ERROR_PREFIX_RE.sub("", result.stderr.strip())[:300]
            return AgentResult.failure(
                error=RuntimeError(
                    "CRASHED",
                    f"devin exited with code {result.code}{f': {detail}' if detail else ''}",
                ),
                duration_ms=duration_ms,
                events=events,
                raw=result.stdout,
            )

        text = result.stdout.strip()
        if not text:
            return AgentResult.failure(
                error=RuntimeError("MALFORMED_OUTPUT", "devin produced no output"),
                duration_ms=duration_ms,
                events=events,
                raw=result.stdout,
            )

        raw = strip_fence(text)
        try:
            output = json.loads(raw)
        except ValueError:
            return AgentResult.failure(
                error=RuntimeError("MALFORMED_OUTPUT", "devin output was not valid JSON"),
                duration_ms=duration_ms,
                events=events,
                raw=raw,
            )
        completed = RuntimeEvent(type="completed", output=output, raw=raw)
        events.append(completed)
        if on_event is not None:
            on_event(completed)
        return AgentResult.success(output=output, raw=raw, duration_ms=duration_ms, events=events)

    async def run_task(self, task: AgentTask) -> AgentResult:
        return await self._run(
            task_id=task.task_id,
            instructions=task.instructions,
            input=task.input,
            output_schema=task.output_schema,
            prompt=None,
            model=task.model,
            timeout_ms=task.timeout_ms,
            on_event=task.on_event,
        )

    async def create_session(self, input: SessionInput) -> RuntimeSession:
        # One-shot transport: a devin session is a local handle; each turn runs
        # the full prompt anew, so no server-side session is created.
        session = RuntimeSession(id=str(uuid.uuid4()), thread_id=str(uuid.uuid4()))
        self._threads[session.id] = session
        return session

    async def resume_session(self, thread_id: str, input: SessionInput) -> RuntimeSession:
        session = RuntimeSession(id=str(uuid.uuid4()), thread_id=thread_id)
        self._threads[session.id] = session
        return session

    async def send_message(
        self, session_id: str, msg: RuntimeMessage
    ) -> AsyncIterator[RuntimeEvent]:
        if session_id not in self._threads:
            yield RuntimeEvent(
                type="error",
                error=RuntimeError("PROTOCOL", f'unknown devin session "{session_id}"'),
            )
            return
        invalid = validate_model_and_effort(msg.model, msg.effort)
        if invalid is not None:
            yield RuntimeEvent(type="error", error=invalid)
            return
        yield RuntimeEvent(type="started")
        result = await self._run(
            task_id=msg.task_id or "session-turn",
            instructions=msg.text,
            input=msg.input if msg.input is not None else {},
            output_schema=None,
            prompt=msg.text,
            model=msg.model,
            timeout_ms=None,
        )
        if result.ok:
            yield RuntimeEvent(type="completed", output=result.output, raw=result.raw or "")
        else:
            assert result.error is not None
            self._warn(
                "runtime.turn_failed",
                {
                    "runtime": "devin",
                    "sessionId": session_id,
                    "code": result.error.code,
                    "message": result.error.message,
                },
            )
            yield RuntimeEvent(type="error", error=result.error)

    async def close_session(self, session_id: str) -> None:
        self._threads.pop(session_id, None)

    async def list_models(self) -> list[ModelInfo]:
        bin_path = await find_devin_executable(self._opts.env)
        if bin_path is None:
            return list(DEFAULT_MODELS)
        try:
            result = await run_devin_cli(
                bin_path,
                ["models", "list", "--format", "json"],
                env=self._opts.env,
                workspace_dir=self._opts.workspace_dir,
                prompt=None,
                timeout_ms=LIST_MODELS_TIMEOUT_MS,
                runner=self._opts.runner,
            )
            if result.code != 0:
                return list(DEFAULT_MODELS)
            models = parse_models_json(result.stdout)
            return models if models else list(DEFAULT_MODELS)
        except Exception as err:  # mirrors the TS catch-all around the CLI run
            self._warn("runtime.list_models_failed", {"runtime": "devin", "message": str(err)})
            return list(DEFAULT_MODELS)

    async def dispose(self) -> None:
        self._threads.clear()

    def _warn(self, event: str, fields: Mapping[str, object]) -> None:
        if self._opts.logger is not None:
            self._opts.logger.warn(event, fields)
