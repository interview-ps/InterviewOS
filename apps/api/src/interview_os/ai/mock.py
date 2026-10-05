"""Deterministic, network-free runtime (port of `mock/MockRuntime.ts`).

Task handlers are registered per task id; the default handlers ship with the
skill layer. Sessions stream the JSON payload in 40-character chunks, which
makes the streaming path observable in demos and e2e runs.
"""

from __future__ import annotations

import asyncio
import inspect
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass

from ..core.models import new_id
from .clock import now_ms
from .errors import RuntimeError
from .interface import (
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
)
from .json_compat import js_dumps

__all__ = [
    "CHUNK",
    "MockRuntime",
    "MockRuntimeOptions",
    "MockTaskFallback",
    "MockTaskHandler",
]

MockTaskHandler = Callable[[object, AgentTask], object | Awaitable[object]]

#: Fallback for task ids with no registered handler. Returning `None` means
#: "not handled" — the runtime then reports its usual no-handler error.
MockTaskFallback = Callable[[str, object, AgentTask], object | Awaitable[object]]

CHUNK = 40


@dataclass(frozen=True, slots=True)
class MockRuntimeOptions:
    #: Delay between streamed delta chunks (`INTERVIEW_OS_MOCK_DELAY_MS`).
    chunk_delay_ms: int = 0


@dataclass
class _MockThread:
    session: RuntimeSession
    turns: int = 0


def _chunks(text: str) -> list[str]:
    return [text[i : i + CHUNK] for i in range(0, len(text), CHUNK)]


async def _resolve(value: object | Awaitable[object]) -> object:
    if inspect.isawaitable(value):
        return await value
    return value


class MockRuntime:
    kind: RuntimeKind = "mock"

    def __init__(self, opts: MockRuntimeOptions | None = None) -> None:
        self._handlers: dict[str, MockTaskHandler] = {}
        self._fallback: MockTaskFallback | None = None
        self._threads: dict[str, _MockThread] = {}
        self._delay_ms = opts.chunk_delay_ms if opts is not None else 0
        self._thread_seq = 0

    def register(self, task_id: str, handler: MockTaskHandler) -> None:
        self._handlers[task_id] = handler

    def set_fallback(self, handler: MockTaskFallback | None) -> None:
        """Generic last-resort resolver for task ids with no registered handler."""

        self._fallback = handler

    async def health_check(self) -> RuntimeStatus:
        return RuntimeStatus(runtime="mock", available=True, status="ready")

    async def list_models(self) -> list[ModelInfo]:
        return [
            ModelInfo(
                id="mock",
                display_name="Mock (deterministic)",
                supported_reasoning_efforts=[],
                default_reasoning_effort=None,
            )
        ]

    async def run_task(self, task: AgentTask) -> AgentResult:
        started = now_ms()
        handler = self._handlers.get(task.task_id)
        output: object
        if handler is not None:
            output = await _resolve(handler(task.input, task))
        elif self._fallback is not None:
            output = await _resolve(self._fallback(task.task_id, task.input, task))
            if output is None:
                return self._unhandled(task, started)
        else:
            return self._unhandled(task, started)

        raw = js_dumps(output)
        events: list[AgentEvent] = [RuntimeEvent(type="started")]
        if task.on_event is not None:
            task.on_event(RuntimeEvent(type="started"))
        for chunk in _chunks(raw):
            if self._delay_ms > 0:
                await asyncio.sleep(self._delay_ms / 1000)
            event = RuntimeEvent(type="delta", text=chunk)
            events.append(event)
            if task.on_event is not None:
                task.on_event(event)
        message = RuntimeEvent(type="message", text=raw)
        completed = RuntimeEvent(type="completed", output=output, raw=raw)
        events.append(message)
        events.append(completed)
        if task.on_event is not None:
            task.on_event(message)
            task.on_event(completed)
        return AgentResult.success(
            output=output, raw=raw, duration_ms=now_ms() - started, events=events
        )

    @staticmethod
    def _unhandled(task: AgentTask, started: int) -> AgentResult:
        return AgentResult.failure(
            error=RuntimeError(
                "PROTOCOL",
                f'mock runtime has no handler registered for task "{task.task_id}"',
            ),
            duration_ms=now_ms() - started,
            events=[RuntimeEvent(type="started")],
        )

    async def create_session(self, input: SessionInput) -> RuntimeSession:
        self._thread_seq += 1
        session = RuntimeSession(id=new_id("sess"), thread_id=f"mock-thread-{self._thread_seq}")
        self._threads[session.id] = _MockThread(session=session)
        return session

    async def resume_session(self, thread_id: str, input: SessionInput) -> RuntimeSession:
        for thread in self._threads.values():
            if thread.session.thread_id == thread_id:
                return thread.session
        session = RuntimeSession(id=new_id("sess"), thread_id=thread_id)
        self._threads[session.id] = _MockThread(session=session)
        return session

    async def send_message(  # noqa: C901 - mirrors the TS control flow
        self, session_id: str, msg: RuntimeMessage
    ) -> AsyncIterator[RuntimeEvent]:
        thread = self._threads.get(session_id)
        if thread is None:
            yield RuntimeEvent(
                type="error",
                error=RuntimeError("PROTOCOL", f'unknown mock session "{session_id}"'),
            )
            return
        thread.turns += 1
        yield RuntimeEvent(type="started")

        handler = self._handlers.get(msg.task_id) if msg.task_id else None
        if msg.task_id and handler is None and self._fallback is None:
            yield RuntimeEvent(type="error", error=_no_handler(msg.task_id))
            return

        task = AgentTask(
            task_id=msg.task_id or "",
            instructions="",
            input=msg.input,
            output_schema=msg.output_schema or {},
        )
        text: str
        output: object | None = None
        handled = True
        if handler is not None:
            output = await _resolve(handler(msg.input if msg.input is not None else msg.text, task))
            text = js_dumps(output)
        elif msg.task_id and self._fallback is not None:
            output = await _resolve(
                self._fallback(msg.task_id, msg.input if msg.input is not None else msg.text, task)
            )
            if output is None:
                yield RuntimeEvent(type="error", error=_no_handler(msg.task_id))
                return
            text = js_dumps(output)
        else:
            handled = False
            text = f"[mock turn {thread.turns}] {len(msg.text)} chars"

        for chunk in _chunks(text):
            if self._delay_ms > 0:
                await asyncio.sleep(self._delay_ms / 1000)
            yield RuntimeEvent(type="delta", text=chunk)
        yield RuntimeEvent(type="message", text=text)
        if handled:
            yield RuntimeEvent(type="completed", output=output, raw=text)
        else:
            yield RuntimeEvent(type="completed", raw=text)

    async def close_session(self, session_id: str) -> None:
        self._threads.pop(session_id, None)

    async def dispose(self) -> None:
        self._threads.clear()


def _no_handler(task_id: str) -> RuntimeError:
    return RuntimeError("PROTOCOL", f'mock runtime has no handler registered for task "{task_id}"')
