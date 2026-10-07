"""`AcpRuntime` — an `AIRuntime` backed by an ACP agent subprocess.

One long-lived agent process per runtime instance (spawned lazily, health-checked
by `initialize`). One-shot tasks use a throwaway `session/new`; interview turns
reuse a persistent session. Every method maps onto the ACP client in `client.py`;
the contract in `interface.py` is unchanged.

Model/effort always pass `validate_model_and_effort` before anything reaches the
agent; a model is applied through the agent's `configOptions` selector when it
advertises one. `developer_instructions` (no ACP field) are prepended to the
session's first prompt. Structured output is validated upstream by
`run_structured` (invariant 2) — ACP has no output-schema field.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import re
from collections.abc import AsyncIterator, Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from ...core.models import new_id
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
from ..process import ensure_dir, timeout_from_env
from .client import AcpClient, AcpClientOptions
from .config import AcpAgentConfig, build_acp_child_env
from .detect import HEALTH_TIMEOUT_MS, acp_health_check, find_acp_executable
from .events import (
    TurnUsage,
    stop_reason_to_error,
    update_to_event,
    usage_from_result,
    usage_from_update,
)

__all__ = ["CANCEL_GRACE_MS", "DEFAULT_REQUEST_TIMEOUT_MS", "AcpRuntime", "AcpRuntimeOptions"]

DEFAULT_REQUEST_TIMEOUT_MS = 30_000
CANCEL_GRACE_MS = 3_000
CANCEL_TIMEOUT_MS = 5_000
RETRYABLE_CODES = ("CRASHED", "SPAWN_FAILED")

#: After the prompt result, wait this long for a spec-legal late `usage_update`
#: before snapshotting the turn (a quiet window, capped at the max).
USAGE_SETTLE_QUIET_MS = 80
USAGE_SETTLE_MAX_MS = 400
USAGE_SETTLE_STEP_MS = 20

FENCE_RE = re.compile(r"^```(?:json)?\s*([\s\S]*?)\s*```$", re.IGNORECASE)


@dataclass(frozen=True, slots=True)
class AcpRuntimeOptions:
    config: AcpAgentConfig
    env: Mapping[str, str]
    workspace_dir: str
    logger: Logger | None = None
    extra_child_env: Mapping[str, Sequence[str]] | None = None
    #: AI usage telemetry sink (best-effort; may be None).
    usage_sink: AIUsageSink | None = None


@dataclass
class _Session:
    #: Local handle id (stored as `runtime_sessions.runtime_session_id`).
    id: str
    #: ACP `sessionId` (stored as `runtime_sessions.thread_id`).
    thread_id: str
    #: Exposed thread id — equals `thread_id`, except a fallback resume keeps
    #: the caller's id while `acp_session_id` points at the fresh session.
    exposed_thread_id: str
    acp_session_id: str
    model_config_id: str | None = None
    effort_config_id: str | None = None
    developer_instructions: str | None = None
    first_turn: bool = True


@dataclass(frozen=True, slots=True)
class _OnceResult:
    output: object | None
    raw: str
    error: RuntimeError | None = None


@dataclass
class _UsageState:
    """Per-ACP-session usage seen so far (context size + cumulative cost)."""

    used: int | None = None
    size: int | None = None
    #: Latest cumulative session cost reported for `currency`.
    cumulative: float | None = None
    currency: str | None = None
    #: Cumulative amount already converted into per-turn deltas for `currency`.
    committed: float | None = None
    #: Bumped on every accepted `usage_update` (detects a fresh reading).
    seq: int = 0
    #: A resumed session reports its prior running cost first; treat that first
    #: reading as the baseline instead of recording the whole session as a delta.
    baseline_pending: bool = False


def strip_fence(text: str) -> str:
    """Strip a surrounding markdown code fence if the model wrapped its JSON."""

    trimmed = text.strip()
    match = FENCE_RE.match(trimmed)
    return match.group(1).strip() if match else trimmed


def compose_task_prompt(task: AgentTask) -> str:
    """Embed the JSON Schema in the prompt — ACP has no schema field."""

    return "\n".join(
        [
            task.instructions,
            "",
            "You are a data-extraction function, not a coding assistant. "
            "Do NOT use tools, read files, or ask questions.",
            "Reply with ONLY a single JSON value that conforms to this JSON Schema, "
            "with no prose and no markdown fences:",
            js_dumps(task.output_schema),
            "",
            "Input (JSON):",
            js_dumps(task.input),
        ]
    )


class AcpRuntime:
    """Drives a provider's ACP agent over stdio."""

    def __init__(self, opts: AcpRuntimeOptions) -> None:
        self._opts = opts
        config = opts.config
        self._timeout_ms = timeout_from_env(
            opts.env,
            f"INTERVIEW_OS_{config.kind.upper()}_TIMEOUT_MS",
            config.default_timeout_ms,
        )
        self._client: AcpClient | None = None
        self._sessions: dict[str, _Session] = {}
        self._usage: dict[str, _UsageState] = {}

    @property
    def kind(self) -> RuntimeKind:
        return self._opts.config.kind

    # ------------------------------------------------------------------ client

    async def _ensure_client(self) -> AcpClient:
        if self._client is not None and self._client.started:
            return self._client
        config = self._opts.config
        executable = await find_acp_executable(config, self._opts.env)
        if executable is None:
            raise RuntimeError("UNAVAILABLE", config.setup_message)
        await ensure_dir(self._opts.workspace_dir)
        client = AcpClient(
            AcpClientOptions(
                command=executable,
                args=config.args,
                cwd=self._opts.workspace_dir,
                env=build_acp_child_env(config, self._opts.env, self._opts.extra_child_env),
                request_timeout_ms=DEFAULT_REQUEST_TIMEOUT_MS,
            )
        )
        await client.initialize(HEALTH_TIMEOUT_MS)
        client.on_notification(self._on_usage_notification)
        self._client = client
        return client

    async def _reset_client(self) -> None:
        client = self._client
        self._client = None
        if client is not None:
            await client.close()

    # ------------------------------------------------------------------ sessions

    async def _new_session(self) -> tuple[str, object]:
        client = await self._ensure_client()
        result = await client.request(
            "session/new",
            {"cwd": self._opts.workspace_dir, "mcpServers": []},
            DEFAULT_REQUEST_TIMEOUT_MS,
        )
        session_id = result.get("sessionId") if isinstance(result, Mapping) else None
        if not isinstance(session_id, str):
            raise RuntimeError("PROTOCOL", "session/new did not return a sessionId")
        config_options = result.get("configOptions") if isinstance(result, Mapping) else None
        return session_id, config_options

    def _track_session(
        self,
        *,
        acp_session_id: str,
        exposed_thread_id: str,
        config_options: object,
        input: SessionInput,
    ) -> _Session:
        model_id, effort_id = _config_option_ids(config_options)
        session = _Session(
            id=new_id("sess"),
            thread_id=exposed_thread_id,
            exposed_thread_id=exposed_thread_id,
            acp_session_id=acp_session_id,
            model_config_id=model_id,
            effort_config_id=effort_id,
            developer_instructions=input.developer_instructions or input.instructions,
        )
        self._sessions[session.id] = session
        return session

    async def create_session(self, input: SessionInput) -> RuntimeSession:
        acp_session_id, config_options = await self._new_session()
        session = self._track_session(
            acp_session_id=acp_session_id,
            exposed_thread_id=acp_session_id,
            config_options=config_options,
            input=input,
        )
        return RuntimeSession(id=session.id, thread_id=session.exposed_thread_id)

    async def resume_session(self, thread_id: str, input: SessionInput) -> RuntimeSession:
        client = await self._ensure_client()
        config_options: object = None
        if client.load_session:
            result = await client.request(
                "session/load",
                {"sessionId": thread_id, "cwd": self._opts.workspace_dir, "mcpServers": []},
                DEFAULT_REQUEST_TIMEOUT_MS,
            )
            config_options = result.get("configOptions") if isinstance(result, Mapping) else None
            acp_session_id = thread_id
            # `session/load` replays the session, so the first cost reading is the
            # prior running total: seed the baseline instead of recording it whole.
            self._usage.setdefault(acp_session_id, _UsageState()).baseline_pending = True
        else:
            # No `loadSession`: fall back to a fresh session, exactly like the
            # one-shot wrappers (claude/opencode/devin) did — the exposed thread
            # id is preserved so saved `runtime_sessions` rows still resolve.
            acp_session_id, config_options = await self._new_session()
        session = self._track_session(
            acp_session_id=acp_session_id,
            exposed_thread_id=thread_id,
            config_options=config_options,
            input=input,
        )
        return RuntimeSession(id=session.id, thread_id=session.exposed_thread_id)

    async def close_session(self, session_id: str) -> None:
        session = self._sessions.pop(session_id, None)
        if session is None:
            return
        self._usage.pop(session.acp_session_id, None)
        client = self._client
        if client is None or not client.started:
            return
        with contextlib.suppress(Exception):
            client.notify("session/cancel", {"sessionId": session.acp_session_id})
        if "close" in client.session_capabilities:
            with contextlib.suppress(Exception):
                await client.request(
                    "session/close",
                    {"sessionId": session.acp_session_id},
                    DEFAULT_REQUEST_TIMEOUT_MS,
                )

    # ------------------------------------------------------------------ turns

    async def _apply_model(self, session: _Session, model: str | None, effort: str | None) -> None:
        if model is None and effort is None:
            return
        client = await self._ensure_client()
        if model is not None and session.model_config_id is not None:
            await self._set_config_option(client, session, session.model_config_id, model)
        if effort is not None and session.effort_config_id is not None:
            await self._set_config_option(client, session, session.effort_config_id, effort)

    async def _set_config_option(
        self, client: AcpClient, session: _Session, config_id: str, value: str
    ) -> None:
        try:
            await client.request(
                "session/set_config_option",
                {"sessionId": session.acp_session_id, "configId": config_id, "value": value},
                DEFAULT_REQUEST_TIMEOUT_MS,
            )
        except RuntimeError as err:
            # Best-effort: an agent that does not accept the value keeps its
            # default rather than failing the whole turn.
            self._warn("runtime.model_config_failed", {"configId": config_id, "code": err.code})

    async def _turn(
        self,
        session: _Session,
        text: str,
        output_schema: Mapping[str, object] | None,
        timeout_ms: int,
        task_id: str | None,
        model: str | None,
        attempt: int | None,
    ) -> AsyncIterator[RuntimeEvent]:
        """Run one `session/prompt`, streaming deltas and one terminal event."""

        started = now_ms()
        start_seq = self._usage_seq(session.acp_session_id)
        client = await self._ensure_client()
        queue: asyncio.Queue[RuntimeEvent] = asyncio.Queue()
        buffer: list[str] = []

        def on_notification(method: str, params: Mapping[str, object]) -> None:
            if method != "session/update":
                return
            update = params.get("update")
            if not isinstance(update, Mapping):
                return
            event = update_to_event(update)
            if event is not None:
                buffer.append(event["text"])
                queue.put_nowait(event)

        off = client.on_notification(on_notification)
        # Give the client a generous timeout so its own timer never preempts the
        # deadline we manage here (which also issues `session/cancel`).
        prompt_task = asyncio.ensure_future(
            client.request(
                "session/prompt",
                {
                    "sessionId": session.acp_session_id,
                    "prompt": [{"type": "text", "text": text}],
                },
                timeout_ms + CANCEL_GRACE_MS,
            )
        )
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout_ms / 1000
        try:
            while True:
                remaining = deadline - loop.time()
                if remaining <= 0:
                    async for event in self._cancel_and_fail(
                        client, session, prompt_task, task_id, started, start_seq, model, attempt
                    ):
                        yield event
                    return
                get_task = asyncio.ensure_future(queue.get())
                done, _ = await asyncio.wait(
                    {get_task, prompt_task}, timeout=remaining, return_when=asyncio.FIRST_COMPLETED
                )
                if not done:  # deadline
                    get_task.cancel()
                    get_task.add_done_callback(_swallow)
                    async for event in self._cancel_and_fail(
                        client, session, prompt_task, task_id, started, start_seq, model, attempt
                    ):
                        yield event
                    return
                if get_task in done:
                    yield get_task.result()
                else:
                    # The prompt finished with no queued delta; discard the get.
                    get_task.cancel()
                    get_task.add_done_callback(_swallow)
                if prompt_task.done():
                    # Notifications always precede the prompt response, so the
                    # remaining queue is safely drainable here.
                    while not queue.empty():
                        yield queue.get_nowait()
                    break

            stop_reason = _stop_reason(prompt_task)
            turn_usage = _result_usage(prompt_task)
            ok = True
            error_code: str | None = None
            async for event in self._terminal_event(prompt_task, "".join(buffer), output_schema):
                if event["type"] == "error":
                    ok = False
                    err = event.get("error")
                    if isinstance(err, RuntimeError):
                        error_code = err.code
                yield event
            # Record only *after* the terminal event has been yielded: the settle
            # wait must never hold the caller's reply back.
            saw_update = await self._settle_usage(session.acp_session_id, start_seq)
            self._record_usage(
                session,
                task_id,
                stop_reason,
                now_ms() - started,
                turn_usage,
                saw_update,
                model=model,
                attempt=attempt,
                ok=ok,
                error_code=error_code,
            )
        finally:
            off()
            if not prompt_task.done():
                prompt_task.cancel()
                prompt_task.add_done_callback(_swallow)

    async def _cancel_and_fail(
        self,
        client: AcpClient,
        session: _Session,
        prompt_task: asyncio.Future[object],
        task_id: str | None,
        started: int,
        start_seq: int,
        model: str | None,
        attempt: int | None,
    ) -> AsyncIterator[RuntimeEvent]:
        with contextlib.suppress(Exception):
            client.notify("session/cancel", {"sessionId": session.acp_session_id})
        with contextlib.suppress(Exception):
            await asyncio.wait_for(asyncio.shield(prompt_task), CANCEL_GRACE_MS / 1000)
        if not prompt_task.done():
            prompt_task.cancel()
            prompt_task.add_done_callback(_swallow)
        yield RuntimeEvent(type="error", error=RuntimeError("TIMEOUT", "ACP turn timed out"))
        # A cancelled turn still consumed context/cost — record what we saw, but
        # only after yielding the error so the settle wait never holds it back.
        saw_update = await self._settle_usage(session.acp_session_id, start_seq)
        self._record_usage(
            session,
            task_id,
            "cancelled",
            now_ms() - started,
            _result_usage(prompt_task),
            saw_update,
            model=model,
            attempt=attempt,
            ok=False,
            error_code="TIMEOUT",
        )

    async def _terminal_event(
        self,
        prompt_task: asyncio.Future[object],
        text: str,
        output_schema: Mapping[str, object] | None,
    ) -> AsyncIterator[RuntimeEvent]:
        try:
            result = prompt_task.result()
        except RuntimeError as err:
            yield RuntimeEvent(type="error", error=err)
            return
        stop_reason = result.get("stopReason") if isinstance(result, Mapping) else None
        mapped = stop_reason_to_error(stop_reason)
        if mapped is not None:
            code, message = mapped
            yield RuntimeEvent(type="error", error=RuntimeError(code, message))
            return
        if output_schema is not None:
            if not text.strip():
                yield RuntimeEvent(
                    type="error",
                    error=RuntimeError("MALFORMED_OUTPUT", "the agent produced no output"),
                )
                return
            raw = strip_fence(text)
            try:
                output = json.loads(raw)
            except ValueError:
                yield RuntimeEvent(
                    type="error",
                    error=RuntimeError("MALFORMED_OUTPUT", "the agent output was not valid JSON"),
                )
                return
            yield RuntimeEvent(type="completed", output=output, raw=raw)
            return
        yield RuntimeEvent(type="completed", output=None, raw=text)

    # ------------------------------------------------------------------ usage

    def _usage_seq(self, acp_session_id: str) -> int:
        state = self._usage.get(acp_session_id)
        return state.seq if state is not None else 0

    def _on_usage_notification(self, method: str, params: Mapping[str, object]) -> None:
        """Record the latest `usage_update` for a session (never raises)."""

        if method != "session/update":
            return
        update = params.get("update")
        if not isinstance(update, Mapping):
            return
        parsed = usage_from_update(update)
        if parsed is None:
            return
        session_id = params.get("sessionId")
        if not isinstance(session_id, str):
            return
        state = self._usage.setdefault(session_id, _UsageState())
        state.used = parsed.used
        state.size = parsed.size
        state.seq += 1
        if parsed.amount is not None and parsed.currency is not None:
            if state.currency != parsed.currency:
                # Cumulative cost is per-currency; a currency switch restarts the
                # delta baseline rather than mixing currencies.
                state.currency = parsed.currency
                state.committed = None
            state.cumulative = parsed.amount

    async def _settle_usage(self, acp_session_id: str, start_seq: int) -> bool:
        """Wait briefly for a trailing `usage_update`; say whether one arrived.

        The ACP spec permits `usage_update` after the `session/prompt` response,
        so snapshot the turn only once the stream has been quiet for a moment.
        Returns whether any update was seen during this turn (a fresh reading),
        so a turn with no update is not recorded with stale figures.
        """

        loop = asyncio.get_running_loop()
        last = self._usage_seq(acp_session_id)
        changed = last != start_seq
        quiet_until = loop.time() + USAGE_SETTLE_QUIET_MS / 1000
        deadline = loop.time() + USAGE_SETTLE_MAX_MS / 1000
        while loop.time() < deadline:
            await asyncio.sleep(USAGE_SETTLE_STEP_MS / 1000)
            current = self._usage_seq(acp_session_id)
            if current != last:
                last = current
                changed = True
                quiet_until = loop.time() + USAGE_SETTLE_QUIET_MS / 1000
            elif loop.time() >= quiet_until:
                break
        return changed

    def _cost_delta(self, state: _UsageState) -> tuple[float | None, str | None]:
        """Convert the cumulative session cost into this turn's per-turn delta."""

        if state.cumulative is None:
            return None, None
        if state.baseline_pending:
            # First reading after a resume is the prior running total — baseline.
            # If the agent does not report right after `session/load`, this reading
            # lands during a later turn and that turn's own cost is absorbed into
            # the baseline (a small undercount). Seeding it from the stored rows
            # would need store access, which `ai/` deliberately does not have.
            state.committed = state.cumulative
            state.baseline_pending = False
            return None, None
        previous = state.committed
        amount = state.cumulative if previous is None else max(0.0, state.cumulative - previous)
        state.committed = state.cumulative
        return amount, state.currency

    def _record_usage(
        self,
        session: _Session,
        task_id: str | None,
        stop_reason: str | None,
        duration_ms: int,
        turn_usage: TurnUsage | None = None,
        saw_update: bool = False,
        *,
        model: str | None = None,
        attempt: int | None = None,
        ok: bool | None = None,
        error_code: str | None = None,
    ) -> None:
        """Emit one usage event for a turn, or nothing when it reported none.

        Context/cost come from a `usage_update` seen *during* this turn (never a
        stale figure from an earlier one); per-turn tokens come from the prompt
        result when the agent sends them.
        """

        sink = self._opts.usage_sink
        if sink is None:
            return
        tokens = turn_usage if (turn_usage is not None and turn_usage.reported) else None
        if not saw_update and tokens is None:
            return
        context_used: int | None = None
        context_size: int | None = None
        amount: float | None = None
        currency: str | None = None
        if saw_update:
            state = self._usage.get(session.acp_session_id)
            if state is not None:
                context_used, context_size = state.used, state.size
                amount, currency = self._cost_delta(state)
        try:
            sink.record(
                AIUsageEvent(
                    runtime_kind=self.kind,
                    provider_session_id=session.acp_session_id,
                    task_id=task_id,
                    model=model,
                    attempt=attempt,
                    ok=ok,
                    error_code=error_code,
                    input_tokens=tokens.input_tokens if tokens is not None else None,
                    output_tokens=tokens.output_tokens if tokens is not None else None,
                    thought_tokens=tokens.thought_tokens if tokens is not None else None,
                    cached_read_tokens=tokens.cached_read_tokens if tokens is not None else None,
                    cached_write_tokens=tokens.cached_write_tokens if tokens is not None else None,
                    total_tokens=tokens.total_tokens if tokens is not None else None,
                    context_used=context_used,
                    context_size=context_size,
                    cost_amount=amount,
                    cost_currency=currency,
                    stop_reason=stop_reason,
                    duration_ms=duration_ms,
                )
            )
        except Exception:  # telemetry must never break a turn
            self._warn("runtime.usage_record_failed", {"runtime": self.kind})

    # ------------------------------------------------------------------ AIRuntime

    async def health_check(self) -> RuntimeStatus:
        return await acp_health_check(
            self._opts.config,
            self._opts.env,
            self._opts.workspace_dir,
            extra_child_env=self._opts.extra_child_env,
        )

    async def run_task(self, task: AgentTask) -> AgentResult:
        started = now_ms()
        invalid = validate_model_and_effort(task.model, task.effort)
        if invalid is not None:
            return AgentResult.failure(error=invalid, duration_ms=0, events=[])

        events: list[AgentEvent] = []

        def emit(event: RuntimeEvent) -> None:
            events.append(event)
            if task.on_event is not None:
                task.on_event(event)

        emit(RuntimeEvent(type="started"))
        timeout_ms = task.timeout_ms if task.timeout_ms is not None else self._timeout_ms
        try:
            result = await self._run_task_once(task, timeout_ms, emit)
        except RuntimeError as err:
            emit(RuntimeEvent(type="error", error=err))
            return AgentResult.failure(error=err, duration_ms=now_ms() - started, events=events)
        if result.error is not None:
            return AgentResult.failure(
                error=result.error, duration_ms=now_ms() - started, events=events, raw=result.raw
            )
        return AgentResult.success(
            output=result.output, raw=result.raw, duration_ms=now_ms() - started, events=events
        )

    async def _run_task_once(
        self, task: AgentTask, timeout_ms: int, emit: Callable[[RuntimeEvent], None]
    ) -> _OnceResult:
        for attempt in range(2):
            try:
                return await self._run_task_attempt(task, timeout_ms, emit)
            except RuntimeError as err:
                if attempt == 1 or err.code not in RETRYABLE_CODES:
                    raise
                await self._reset_client()
        raise RuntimeError("CRASHED", "ACP task failed")  # pragma: no cover - loop always returns

    async def _run_task_attempt(
        self, task: AgentTask, timeout_ms: int, emit: Callable[[RuntimeEvent], None]
    ) -> _OnceResult:
        acp_session_id, config_options = await self._new_session()
        session = self._track_session(
            acp_session_id=acp_session_id,
            exposed_thread_id=acp_session_id,
            config_options=config_options,
            input=SessionInput(),
        )
        try:
            await self._apply_model(session, task.model, task.effort)
            prompt = compose_task_prompt(task)
            output: object | None = None
            raw = ""
            error: RuntimeError | None = None
            async for event in self._turn(
                session,
                prompt,
                task.output_schema,
                timeout_ms,
                task.task_id,
                task.model,
                task.attempt,
            ):
                emit(event)
                if event["type"] == "completed":
                    output = event.get("output")
                    raw = _as_text(event.get("raw"))
                elif event["type"] == "error":
                    got = event.get("error")
                    if isinstance(got, RuntimeError):
                        error = got
            return _OnceResult(output=output, raw=raw, error=error)
        finally:
            with contextlib.suppress(Exception):
                await self.close_session(session.id)

    async def send_message(
        self, session_id: str, msg: RuntimeMessage
    ) -> AsyncIterator[RuntimeEvent]:
        session = self._sessions.get(session_id)
        if session is None:
            yield RuntimeEvent(
                type="error",
                error=RuntimeError("PROTOCOL", f'unknown ACP session "{session_id}"'),
            )
            return
        invalid = validate_model_and_effort(msg.model, msg.effort)
        if invalid is not None:
            yield RuntimeEvent(type="error", error=invalid)
            return
        yield RuntimeEvent(type="started")
        text = msg.text
        if session.first_turn and session.developer_instructions:
            text = f"{session.developer_instructions}\n\n{text}"
        session.first_turn = False
        try:
            await self._apply_model(session, msg.model, msg.effort)
            async for event in self._turn(
                session,
                text,
                msg.output_schema,
                self._timeout_ms,
                msg.task_id,
                msg.model,
                msg.attempt,
            ):
                yield event
        except RuntimeError as err:
            yield RuntimeEvent(type="error", error=err)

    async def list_models(self) -> list[ModelInfo]:
        try:
            acp_session_id, config_options = await self._new_session()
        except RuntimeError:
            return list(self._opts.config.default_models)
        try:
            models = _models_from_config(config_options)
        finally:
            client = self._client
            if client is not None and client.started:
                with contextlib.suppress(Exception):
                    client.notify("session/cancel", {"sessionId": acp_session_id})
                if "close" in client.session_capabilities:
                    with contextlib.suppress(Exception):
                        await client.request(
                            "session/close",
                            {"sessionId": acp_session_id},
                            DEFAULT_REQUEST_TIMEOUT_MS,
                        )
        return models if models else list(self._opts.config.default_models)

    async def dispose(self) -> None:
        client = self._client
        if client is not None and client.started:
            for session in self._sessions.values():
                with contextlib.suppress(Exception):
                    client.notify("session/cancel", {"sessionId": session.acp_session_id})
        self._sessions.clear()
        self._usage.clear()
        self._client = None
        if client is not None:
            await client.close()

    def _warn(self, event: str, fields: Mapping[str, object]) -> None:
        if self._opts.logger is not None:
            self._opts.logger.warn(event, fields)


def _models_from_config(config_options: object) -> list[ModelInfo]:
    option = _find_config_option(config_options, category="model", fallback_id="model")
    if option is None:
        return []
    current = option.get("currentValue")
    values = option.get("options")
    models: list[ModelInfo] = []
    for value in values if isinstance(values, list) else []:
        if not isinstance(value, Mapping):
            continue
        model_id = value.get("value")
        if not isinstance(model_id, str):
            continue
        name = value.get("name")
        models.append(
            ModelInfo(
                id=model_id,
                display_name=name if isinstance(name, str) else model_id,
                supported_reasoning_efforts=[],
                default_reasoning_effort=None,
                is_default=model_id == current,
            )
        )
    return models


def _config_option_ids(config_options: object) -> tuple[str | None, str | None]:
    model = _find_config_option(config_options, category="model", fallback_id="model")
    effort = _find_config_option(config_options, category="thought_level", fallback_id=None) or (
        _find_config_option(config_options, category="model_config", fallback_id=None)
    )
    model_id = model.get("id") if model is not None else None
    effort_id = effort.get("id") if effort is not None else None
    return (
        model_id if isinstance(model_id, str) else None,
        effort_id if isinstance(effort_id, str) else None,
    )


def _find_config_option(
    config_options: object, *, category: str, fallback_id: str | None
) -> Mapping[str, object] | None:
    if not isinstance(config_options, list):
        return None
    for entry in config_options:
        if not isinstance(entry, Mapping):
            continue
        if entry.get("category") == category:
            return entry
    if fallback_id is not None:
        for entry in config_options:
            if isinstance(entry, Mapping) and entry.get("id") == fallback_id:
                return entry
    return None


def _as_text(value: object) -> str:
    return value if isinstance(value, str) else ""


def _stop_reason(prompt_task: asyncio.Future[object]) -> str | None:
    if not prompt_task.done():
        return None
    try:
        result = prompt_task.result()
    except Exception:
        return None
    if not isinstance(result, Mapping):
        return None
    reason = result.get("stopReason")
    return reason if isinstance(reason, str) else None


def _result_usage(prompt_task: asyncio.Future[object]) -> TurnUsage | None:
    if not prompt_task.done():
        return None
    try:
        result = prompt_task.result()
    except Exception:
        return None
    if not isinstance(result, Mapping):
        return None
    return usage_from_result(result)


def _swallow(task: asyncio.Future[Any]) -> None:
    with contextlib.suppress(asyncio.CancelledError, Exception):
        task.exception()
