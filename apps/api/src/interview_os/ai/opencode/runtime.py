"""`AIRuntime` over one-shot `opencode run` CLI invocations.

Port of `opencode/OpencodeRuntime.ts`. Each task is a fresh process — there is
no long-lived server to manage or crash. Structured output is the model's JSON
reply, validated upstream by `run_structured`.
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
from .cli import OpencodeRunner, OpencodeRunResult, run_opencode_cli
from .detect import OPENCODE_SETUP_MESSAGE, find_opencode_executable, opencode_health_check

__all__ = ["DEFAULT_TASK_TIMEOUT_MS", "OpencodeRuntime", "OpencodeRuntimeOptions"]

DEFAULT_TASK_TIMEOUT_MS = 120_000
LIST_MODELS_TIMEOUT_MS = 30_000

ANSI_RE = re.compile(r"\u001b\[[0-9;]*m")
MODEL_ID_LINE_RE = re.compile(r"^[^/\s]+/[^/\s]+$")
FENCE_RE = re.compile(r"^```(?:json)?\s*([\s\S]*?)\s*```$", re.IGNORECASE)


@dataclass(frozen=True, slots=True)
class OpencodeRuntimeOptions:
    env: Mapping[str, str]
    workspace_dir: str
    logger: Logger | None = None
    #: Test-only: run the CLI without spawning it.
    runner: OpencodeRunner | None = None


@dataclass(frozen=True, slots=True)
class _AssistantText:
    text: str
    provider_error: str | None = None


def parse_model(model: str | None) -> str | None:
    """Only provider-qualified ids (`provider/model`) are forwarded to the CLI."""

    if not model:
        return None
    if model.find("/") <= 0:
        return None
    return model


def extract_assistant_text(stdout: str) -> _AssistantText:
    """Collect the assistant text from `opencode run --format json` NDJSON lines."""

    text = ""
    provider_error: str | None = None
    for line in stdout.split("\n"):
        trimmed = line.strip()
        if not trimmed.startswith("{"):
            continue
        try:
            event = json.loads(trimmed)
        except ValueError:
            continue
        if not isinstance(event, dict):
            continue
        part = event.get("part")
        if (
            event.get("type") == "text"
            and isinstance(part, dict)
            and part.get("type") == "text"
            and isinstance(part.get("text"), str)
        ):
            text += str(part["text"])
        elif event.get("type") == "error":
            error = event.get("error")
            data = error.get("data") if isinstance(error, dict) else None
            detail = data.get("message") if isinstance(data, dict) else None
            name = error.get("name") if isinstance(error, dict) else None
            provider_error = (
                detail
                if isinstance(detail, str)
                else (name if isinstance(name, str) else "unknown error")
            )
    return _AssistantText(text=text, provider_error=provider_error)


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
        return RuntimeError("TIMEOUT", f"opencode {step} timed out")
    if re.search(r"ENOENT|not found|EINVAL", message):
        return RuntimeError(
            "UNAVAILABLE", f"could not launch the opencode CLI while {step}: {message}"
        )
    return RuntimeError("CRASHED", f"opencode {step} failed: {message}")


class OpencodeRuntime:
    kind: RuntimeKind = "opencode"

    def __init__(self, opts: OpencodeRuntimeOptions) -> None:
        self._opts = opts
        self._timeout_ms = timeout_from_env(
            opts.env, "INTERVIEW_OS_OPENCODE_TIMEOUT_MS", DEFAULT_TASK_TIMEOUT_MS
        )
        self._threads: dict[str, RuntimeSession] = {}

    async def health_check(self) -> RuntimeStatus:
        return await opencode_health_check(self._opts.env, self._opts.workspace_dir)

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
    ) -> AgentResult:
        started = now_ms()
        invalid = validate_model_and_effort(model, None)
        if invalid is not None:
            return AgentResult.failure(error=invalid, duration_ms=0, events=[])

        bin_path = await find_opencode_executable(self._opts.env)
        if bin_path is None:
            return AgentResult.failure(
                error=RuntimeError("UNAVAILABLE", OPENCODE_SETUP_MESSAGE),
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
        parsed_model = parse_model(model)
        args = ["run", "--format", "json"]
        if parsed_model:
            args += ["-m", parsed_model]

        effective_timeout = timeout_ms if timeout_ms is not None else self._timeout_ms
        events: list[AgentEvent] = [RuntimeEvent(type="started")]
        step = "running the task"
        try:
            result = await run_opencode_cli(
                bin_path,
                args,
                env=self._opts.env,
                workspace_dir=self._opts.workspace_dir,
                stdin=f"{prompt}\n",
                timeout_ms=effective_timeout,
                runner=self._opts.runner,
            )
        except Exception as err:  # mirrors the TS catch-all around the CLI run
            error = as_runtime_error(err, step)
            self._warn(
                "runtime.task_failed",
                {
                    "runtime": "opencode",
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
                error=RuntimeError(
                    "TIMEOUT", f"opencode did not finish within {effective_timeout}ms"
                ),
                duration_ms=duration_ms,
                events=events,
            )

        assistant = extract_assistant_text(result.stdout)
        if assistant.provider_error is not None:
            self._warn(
                "runtime.provider_error",
                {
                    "runtime": "opencode",
                    "taskId": task_id,
                    "detail": assistant.provider_error[:300],
                },
            )
            return AgentResult.failure(
                error=RuntimeError(
                    "CRASHED", f"opencode reported an error: {assistant.provider_error}"
                ),
                duration_ms=duration_ms,
                events=events,
                raw=result.stdout,
            )
        if result.code != 0:
            detail = result.stderr.strip()[:300]
            return AgentResult.failure(
                error=RuntimeError(
                    "CRASHED",
                    f"opencode exited with code {result.code}{f': {detail}' if detail else ''}",
                ),
                duration_ms=duration_ms,
                events=events,
                raw=result.stdout,
            )
        if not assistant.text.strip():
            return AgentResult.failure(
                error=RuntimeError("MALFORMED_OUTPUT", "opencode produced no text output"),
                duration_ms=duration_ms,
                events=events,
                raw=result.stdout,
            )

        raw = strip_fence(assistant.text)
        try:
            output = json.loads(raw)
        except ValueError:
            return AgentResult.failure(
                error=RuntimeError("MALFORMED_OUTPUT", "opencode output was not valid JSON"),
                duration_ms=duration_ms,
                events=events,
                raw=raw,
            )
        return AgentResult.success(
            output=output,
            raw=raw,
            duration_ms=duration_ms,
            events=[*events, RuntimeEvent(type="completed", output=output, raw=raw)],
        )

    async def run_task(self, task: AgentTask) -> AgentResult:
        return await self._run(
            task_id=task.task_id,
            instructions=task.instructions,
            input=task.input,
            output_schema=task.output_schema,
            prompt=None,
            model=task.model,
            timeout_ms=task.timeout_ms,
        )

    async def create_session(self, input: SessionInput) -> RuntimeSession:
        # One-shot transport: an opencode session is a local handle; each turn
        # runs the full prompt anew, so no server-side thread is created.
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
                error=RuntimeError("PROTOCOL", f'unknown opencode session "{session_id}"'),
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
            yield RuntimeEvent(type="error", error=result.error)

    async def close_session(self, session_id: str) -> None:
        self._threads.pop(session_id, None)

    async def list_models(self) -> list[ModelInfo]:
        bin_path = await find_opencode_executable(self._opts.env)
        if bin_path is None:
            return []
        try:
            result: OpencodeRunResult = await run_opencode_cli(
                bin_path,
                ["models"],
                env=self._opts.env,
                workspace_dir=self._opts.workspace_dir,
                stdin=None,
                timeout_ms=LIST_MODELS_TIMEOUT_MS,
                runner=self._opts.runner,
            )
            if result.code != 0:
                return []
            models: list[ModelInfo] = []
            for line in result.stdout.split("\n"):
                model_id = ANSI_RE.sub("", line).strip()
                if not MODEL_ID_LINE_RE.match(model_id):
                    continue
                models.append(
                    ModelInfo(
                        id=model_id,
                        display_name=model_id,
                        supported_reasoning_efforts=[],
                        default_reasoning_effort=None,
                    )
                )
            return models
        except Exception as err:  # mirrors the TS catch-all around the CLI run
            self._warn(
                "runtime.list_models_failed",
                {"runtime": "opencode", "message": str(err)},
            )
            return []

    async def dispose(self) -> None:
        self._threads.clear()

    def _warn(self, event: str, fields: Mapping[str, object]) -> None:
        if self._opts.logger is not None:
            self._opts.logger.warn(event, fields)
