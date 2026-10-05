"""Interview OS sessions ↔ Codex app-server threads (port of `CodexSessionManager.ts`).

One-shot tasks run on an ephemeral thread over the shared app-server process;
interview turns run on a persistent thread. Sessions created under an older
(crashed) process generation are re-resumed before their next turn.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from collections import deque
from collections.abc import AsyncIterator, Callable, Mapping
from dataclasses import dataclass

from ...core.models import new_id
from ..clock import now_ms
from ..errors import RuntimeError
from ..interface import (
    AgentEvent,
    AgentResult,
    AgentTask,
    RuntimeEvent,
    RuntimeMessage,
    RuntimeSession,
    SessionInput,
    validate_model_and_effort,
)
from ..json_compat import js_dumps
from .process import CodexProcess
from .protocol import CodexProtocol, as_mapping, nested_id

__all__ = ["CodexSessionManager", "CodexSessionManagerOptions", "EventQueue"]

RETRYABLE_CODES = ("CRASHED", "SPAWN_FAILED")


@dataclass
class _TurnState:
    settled: bool = False
    last_text: str = ""


@dataclass
class ManagedSession:
    id: str
    thread_id: str
    #: `CodexProcess` generation the thread was created/resumed under.
    generation: int
    developer_instructions: str | None = None


@dataclass(frozen=True, slots=True)
class CodexSessionManagerOptions:
    workspace_dir: str
    turn_timeout_ms: int


class EventQueue:
    """An async event stream that is finished explicitly by the producer."""

    def __init__(self) -> None:
        self._items: deque[RuntimeEvent] = deque()
        self._waiters: list[asyncio.Future[None]] = []
        self._done = False

    def push(self, event: RuntimeEvent) -> None:
        self._items.append(event)
        self._wake()

    def finish(self) -> None:
        self._done = True
        self._wake()

    def _wake(self) -> None:
        waiters, self._waiters = self._waiters, []
        for waiter in waiters:
            if not waiter.done():
                waiter.set_result(None)

    def __aiter__(self) -> EventQueue:
        return self

    async def __anext__(self) -> RuntimeEvent:
        while True:
            if self._items:
                return self._items.popleft()
            if self._done:
                raise StopAsyncIteration
            waiter: asyncio.Future[None] = asyncio.get_running_loop().create_future()
            self._waiters.append(waiter)
            await waiter


class CodexSessionManager:
    def __init__(self, proc: CodexProcess, opts: CodexSessionManagerOptions) -> None:
        self._proc = proc
        self._opts = opts
        self._protocol = CodexProtocol(proc)
        self._sessions: dict[str, ManagedSession] = {}

    async def create_session(self, input: SessionInput) -> RuntimeSession:
        await self._proc.ensure_ready()
        result = await self._protocol.thread_start(
            {
                "cwd": self._opts.workspace_dir,
                "sandbox": "read-only",
                "approvalPolicy": "never",
                "ephemeral": False,
                "developerInstructions": _instructions(input),
            }
        )
        thread_id = nested_id(result, "thread")
        if thread_id is None:
            raise RuntimeError("PROTOCOL", "thread/start did not return a thread id")
        return self._track(thread_id, input)

    async def resume_session(self, thread_id: str, input: SessionInput) -> RuntimeSession:
        await self._proc.ensure_ready()
        result = await self._protocol.thread_resume(thread_id)
        return self._track(nested_id(result, "thread") or thread_id, input)

    def _track(self, thread_id: str, input: SessionInput) -> RuntimeSession:
        session = ManagedSession(
            id=new_id("sess"),
            thread_id=thread_id,
            generation=self._proc.generation,
            developer_instructions=input.developer_instructions or input.instructions,
        )
        self._sessions[session.id] = session
        return RuntimeSession(id=session.id, thread_id=thread_id)

    async def _ensure_thread_current(self, session: ManagedSession) -> None:
        """Re-resume threads created under an older (crashed) process generation."""

        await self._proc.ensure_ready()
        if session.generation == self._proc.generation:
            return
        await self._protocol.thread_resume(session.thread_id)
        session.generation = self._proc.generation

    def send_message(self, session_id: str, msg: RuntimeMessage) -> AsyncIterator[RuntimeEvent]:
        return self._stream_turn(session_id, msg)

    async def run_task(self, task: AgentTask) -> AgentResult:
        """One-shot task on an ephemeral thread over the shared app-server process."""

        started = now_ms()
        events: list[AgentEvent] = []

        def emit(event: RuntimeEvent) -> None:
            events.append(event)
            if task.on_event is not None:
                task.on_event(event)

        def fail(error: RuntimeError, raw: str | None = None) -> AgentResult:
            return AgentResult.failure(
                error=error, duration_ms=now_ms() - started, events=events, raw=raw
            )

        invalid = validate_model_and_effort(task.model, task.effort)
        if invalid is not None:
            return fail(invalid)
        timeout_ms = task.timeout_ms if task.timeout_ms is not None else self._opts.turn_timeout_ms
        emit(RuntimeEvent(type="started"))

        loop = asyncio.get_running_loop()
        done: asyncio.Future[AgentResult] = loop.create_future()
        state = _TurnState()
        thread_id: str | None = None
        turn_id: str | None = None
        queued: list[tuple[str, Mapping[str, object]]] = []
        off_notification: Callable[[], None] = _noop
        off_exit: Callable[[], None] = _noop
        timer: asyncio.TimerHandle | None = None

        def finish(result: AgentResult) -> None:
            if state.settled:
                return
            state.settled = True
            if timer is not None:
                timer.cancel()
            off_notification()
            off_exit()
            if not done.done():
                done.set_result(result)

        def dispatch(method: str, params: Mapping[str, object]) -> None:
            thread_param = params.get("threadId")
            if thread_param is not None and thread_param != thread_id:
                return
            turn_param = params.get("turnId")
            if turn_param is not None and turn_id is not None and turn_param != turn_id:
                return
            turn = as_mapping(params.get("turn"))
            if turn.get("id") is not None and turn_id is not None and turn.get("id") != turn_id:
                return

            if method == "item/agentMessage/delta":
                delta = params.get("delta")
                if isinstance(delta, str):
                    emit(RuntimeEvent(type="delta", text=delta))
            elif method == "item/completed":
                item = as_mapping(params.get("item"))
                if item.get("type") == "agentMessage" and isinstance(item.get("text"), str):
                    state.last_text = str(item["text"])
                    emit(RuntimeEvent(type="message", text=state.last_text))
            elif method == "turn/completed":
                status = turn.get("status") or "completed"
                if status != "completed":
                    finish(
                        fail(
                            RuntimeError(
                                "PROTOCOL",
                                f'codex turn ended with status "{status}": '
                                f"{js_dumps(turn.get('error'))}",
                            ),
                            state.last_text,
                        )
                    )
                    return
                if state.last_text == "":
                    finish(
                        fail(
                            RuntimeError(
                                "MALFORMED_EVENT",
                                "codex turn completed without an agent message",
                            )
                        )
                    )
                    return
                try:
                    output = json.loads(state.last_text)
                except ValueError:
                    finish(
                        fail(
                            RuntimeError(
                                "MALFORMED_OUTPUT",
                                "turn completed but the final agent message was not valid JSON",
                            ),
                            state.last_text,
                        )
                    )
                    return
                emit(RuntimeEvent(type="completed", output=output, raw=state.last_text))
                finish(
                    AgentResult.success(
                        output=output,
                        raw=state.last_text,
                        duration_ms=now_ms() - started,
                        events=events,
                    )
                )
            elif method in ("turn/failed", "error"):
                finish(
                    fail(
                        RuntimeError(
                            "PROTOCOL",
                            f"codex turn error: {params.get('message') or js_dumps(params)}",
                        ),
                        state.last_text,
                    )
                )

        def on_notification(method: str, raw_params: object) -> None:
            # Notifications are buffered until the turn id is known, then replayed:
            # a fast turn can emit turn/completed before turn/start resolves.
            params = as_mapping(raw_params)
            if turn_id is None:
                queued.append((method, params))
                return
            dispatch(method, params)

        def on_exit(code: int | None, signal_name: str | None) -> None:
            # Exits before this turn started belong to an older process; the
            # pending turn/start request is rejected and retried.
            if turn_id is None:
                return
            finish(fail(RuntimeError("CRASHED", "codex app-server exited mid-turn")))

        def on_timeout() -> None:
            timed_out = fail(
                RuntimeError("TIMEOUT", f"codex task timed out after {timeout_ms}ms"),
                state.last_text,
            )
            if thread_id is not None and turn_id is not None:
                current_thread, current_turn = thread_id, turn_id

                async def interrupt() -> None:
                    # await the interrupt so the turn is cancelled before the
                    # caller sees TIMEOUT
                    with contextlib.suppress(Exception):
                        await self._protocol.turn_interrupt(current_thread, current_turn)
                    finish(timed_out)

                asyncio.ensure_future(interrupt())
            else:
                finish(timed_out)

        off_notification = self._proc.on_notification(on_notification)
        off_exit = self._proc.on_exit(on_exit)
        timer = loop.call_later(timeout_ms / 1000, on_timeout)

        async def start_turn() -> None:
            nonlocal thread_id, turn_id
            for attempt in range(2):
                try:
                    await self._proc.ensure_ready()
                    thread = await self._protocol.thread_start(
                        omit_none(
                            cwd=self._opts.workspace_dir,
                            sandbox="read-only",
                            approvalPolicy="never",
                            ephemeral=True,
                            developerInstructions=task.instructions,
                            model=task.model,
                        )
                    )
                    thread_id = nested_id(thread, "thread")
                    if thread_id is None:
                        raise RuntimeError("PROTOCOL", "thread/start did not return a thread id")
                    turn = await self._protocol.turn_start(
                        omit_none(
                            threadId=thread_id,
                            input=[
                                {
                                    "type": "text",
                                    "text": f"Input (JSON):\n{js_dumps(task.input, indent=2)}\n",
                                    "text_elements": [],
                                }
                            ],
                            outputSchema=task.output_schema,
                            model=task.model,
                            effort=task.effort,
                        )
                    )
                    turn_id = nested_id(turn, "turn")
                    for method, params in list(queued):
                        dispatch(method, params)
                    queued.clear()
                    return
                except (RuntimeError, OSError) as err:
                    error = _as_runtime_error(err)
                    if attempt == 1 or error.code not in RETRYABLE_CODES:
                        finish(fail(error))
                        return

        starter = asyncio.ensure_future(start_turn())
        try:
            return await done
        finally:
            if timer is not None:
                timer.cancel()
            off_notification()
            off_exit()
            if not starter.done():
                starter.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await starter

    async def _stream_turn(
        self, session_id: str, msg: RuntimeMessage
    ) -> AsyncIterator[RuntimeEvent]:
        session = self._sessions.get(session_id)
        if session is None:
            yield RuntimeEvent(
                type="error",
                error=RuntimeError("PROTOCOL", f'unknown session "{session_id}"'),
            )
            return
        invalid = validate_model_and_effort(msg.model, msg.effort)
        if invalid is not None:
            yield RuntimeEvent(type="error", error=invalid)
            return
        yield RuntimeEvent(type="started")

        queue = EventQueue()
        last_message_text = ""
        turn_id: str | None = None
        turn_ended = False
        queued: list[tuple[str, Mapping[str, object]]] = []
        loop = asyncio.get_running_loop()

        def dispatch(method: str, params: Mapping[str, object]) -> None:
            nonlocal last_message_text, turn_ended
            thread_param = params.get("threadId")
            if thread_param is not None and thread_param != session.thread_id:
                return
            turn_param = params.get("turnId")
            if turn_param is not None and turn_id is not None and turn_param != turn_id:
                return
            turn = as_mapping(params.get("turn"))
            if turn.get("id") is not None and turn_id is not None and turn.get("id") != turn_id:
                return

            if method == "item/agentMessage/delta":
                delta = params.get("delta")
                if isinstance(delta, str):
                    queue.push(RuntimeEvent(type="delta", text=delta))
            elif method == "item/completed":
                item = as_mapping(params.get("item"))
                if item.get("type") == "agentMessage" and isinstance(item.get("text"), str):
                    last_message_text = str(item["text"])
                    queue.push(RuntimeEvent(type="message", text=last_message_text))
            elif method == "turn/completed":
                status = turn.get("status") or "completed"
                parse_failed = (
                    status == "completed"
                    and msg.output_schema is not None
                    and last_message_text != ""
                    and not _try_json(last_message_text).ok
                )
                if status == "completed" and not parse_failed:
                    queue.push(
                        RuntimeEvent(
                            type="completed",
                            output=_try_json(last_message_text).value,
                            raw=last_message_text,
                        )
                    )
                elif parse_failed:
                    queue.push(
                        RuntimeEvent(
                            type="error",
                            error=RuntimeError(
                                "MALFORMED_OUTPUT",
                                "turn completed but the final agent message was not valid JSON",
                            ),
                        )
                    )
                else:
                    queue.push(
                        RuntimeEvent(
                            type="error",
                            error=RuntimeError(
                                "PROTOCOL",
                                f'codex turn ended with status "{status}": '
                                f"{js_dumps(turn.get('error'))}",
                            ),
                        )
                    )
                turn_ended = True
                queue.finish()
            elif method in ("turn/failed", "error"):
                queue.push(
                    RuntimeEvent(
                        type="error",
                        error=RuntimeError(
                            "PROTOCOL",
                            f"codex turn error: {params.get('message') or js_dumps(params)}",
                        ),
                    )
                )
                turn_ended = True
                queue.finish()

        def on_notification(method: str, raw_params: object) -> None:
            params = as_mapping(raw_params)
            if turn_id is None:
                queued.append((method, params))
                return
            dispatch(method, params)

        def on_exit(code: int | None, signal_name: str | None) -> None:
            # A stale process exit before turn/start resolves is retried by the
            # attempt loop; an exit after turn/completed is not a mid-turn crash.
            if turn_id is None or turn_ended:
                return
            queue.push(
                RuntimeEvent(
                    type="error",
                    error=RuntimeError("CRASHED", "codex app-server exited mid-turn"),
                )
            )
            queue.finish()

        def on_timeout() -> None:
            queue.push(
                RuntimeEvent(
                    type="error",
                    error=RuntimeError(
                        "TIMEOUT",
                        f"codex turn timed out after {self._opts.turn_timeout_ms}ms",
                    ),
                )
            )
            queue.finish()

        off_notification = self._proc.on_notification(on_notification)
        off_exit = self._proc.on_exit(on_exit)
        timer = loop.call_later(self._opts.turn_timeout_ms / 1000, on_timeout)

        start_error: RuntimeError | None = None
        for attempt in range(2):
            try:
                await self._ensure_thread_current(session)
                result = await self._protocol.turn_start(
                    omit_none(
                        threadId=session.thread_id,
                        input=[{"type": "text", "text": msg.text, "text_elements": []}],
                        outputSchema=msg.output_schema,
                        model=msg.model,
                        effort=msg.effort,
                    )
                )
                turn_id = nested_id(result, "turn")
                for method, params in list(queued):
                    dispatch(method, params)
                queued.clear()
                break
            except (RuntimeError, OSError) as err:
                error = _as_runtime_error(err)
                if attempt == 1 or error.code not in RETRYABLE_CODES:
                    start_error = error
                    break
                # process died between health check and request: force resume + retry once
                session.generation = -1

        if start_error is not None:
            queue.push(RuntimeEvent(type="error", error=start_error))
            queue.finish()

        try:
            async for event in queue:
                yield event
        finally:
            timer.cancel()
            off_notification()
            off_exit()

    async def close_session(self, session_id: str) -> None:
        self._sessions.pop(session_id, None)

    def session_thread_id(self, session_id: str) -> str | None:
        session = self._sessions.get(session_id)
        return session.thread_id if session is not None else None

    async def model_list(self, cursor: str | None = None) -> object:
        await self._proc.ensure_ready()
        return await self._protocol.model_list(cursor)


@dataclass(frozen=True, slots=True)
class _JsonParse:
    ok: bool
    value: object | None = None


def _try_json(text: str) -> _JsonParse:
    if text == "":
        return _JsonParse(ok=True, value=None)
    try:
        return _JsonParse(ok=True, value=json.loads(text))
    except ValueError:
        return _JsonParse(ok=False)


def _instructions(input: SessionInput) -> str:
    if input.developer_instructions is not None:
        return input.developer_instructions
    return input.instructions or ""


def _as_runtime_error(err: BaseException) -> RuntimeError:
    if isinstance(err, RuntimeError):
        return err
    return RuntimeError("PROTOCOL", str(err))


def _noop() -> None:
    pass


def omit_none(**params: object) -> dict[str, object]:
    """`JSON.stringify` drops undefined values, so absent params are omitted."""

    return {key: value for key, value in params.items() if value is not None}
