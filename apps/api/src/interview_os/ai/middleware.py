"""`MiddlewareRuntime` — wraps an `AIRuntime` with plugin middleware hooks (§7.3).

Every model call (a `run_task` or a session turn) is bracketed by the chain's
`before_model` / `after_model` hooks. Middleware methods are optional: a plugin
may implement either or neither, and returning `None` means "leave unchanged".

Ordering follows the locked phase-7 rule "lower priority runs earlier":
`build_middleware_chain` sorts ascending, and `before_model`/`after_model` both
run in that order. `after_model`'s return value replaces the result for
`run_task`; for a streamed `send_message` it is observation-only, since the
events have already been yielded.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from typing import Literal, cast

from .interface import (
    AgentResult,
    AgentTask,
    AIRuntime,
    ModelInfo,
    RuntimeEvent,
    RuntimeKind,
    RuntimeMessage,
    RuntimeSession,
    RuntimeStatus,
    SessionInput,
)

__all__ = [
    "AfterModelHook",
    "BeforeModelHook",
    "MiddlewareRuntime",
    "ModelCall",
    "ModelResult",
]

ModelCallOperation = Literal["run_task", "send_message"]


@dataclass(frozen=True, slots=True)
class ModelCall:
    """One model call as it enters the middleware chain."""

    operation: ModelCallOperation
    #: Set for `run_task`.
    task: AgentTask | None = None
    #: Set for `send_message`.
    session_id: str | None = None
    message: RuntimeMessage | None = None


@dataclass(frozen=True, slots=True)
class ModelResult:
    """The outcome of a `ModelCall` as it leaves the chain."""

    call: ModelCall
    #: Set for `run_task`.
    result: AgentResult | None = None
    #: Collected events for a streamed `send_message`.
    events: tuple[RuntimeEvent, ...] = field(default=())

    @property
    def output(self) -> object | None:
        return self.result.output if self.result is not None else None


BeforeModelHook = Callable[[ModelCall], Awaitable[ModelCall | None]]
AfterModelHook = Callable[[ModelCall, ModelResult], Awaitable[ModelResult | None]]


def _before_hook(target: object) -> BeforeModelHook | None:
    attr: object = getattr(target, "before_model", None)
    return cast(BeforeModelHook, attr) if callable(attr) else None


def _after_hook(target: object) -> AfterModelHook | None:
    attr: object = getattr(target, "after_model", None)
    return cast(AfterModelHook, attr) if callable(attr) else None


class MiddlewareRuntime:
    """A drop-in `AIRuntime` that runs each call through plugin middleware."""

    def __init__(self, inner: AIRuntime, chain: Sequence[object]) -> None:
        self._inner = inner
        self._chain = list(chain)

    @property
    def inner(self) -> AIRuntime:
        return self._inner

    @property
    def chain(self) -> list[object]:
        return list(self._chain)

    # ------------------------------------------------------------------ helpers

    async def _run_before(self, call: ModelCall) -> ModelCall:
        current = call
        for middleware in self._chain:
            hook = _before_hook(middleware)
            if hook is None:
                continue
            updated = await hook(current)
            if updated is not None:
                current = updated
        return current

    async def _run_after(self, call: ModelCall, result: ModelResult) -> ModelResult:
        current = result
        for middleware in self._chain:
            hook = _after_hook(middleware)
            if hook is None:
                continue
            updated = await hook(call, current)
            if updated is not None:
                current = updated
        return current

    # ---------------------------------------------------------------- AIRuntime

    @property
    def kind(self) -> RuntimeKind:
        return self._inner.kind

    async def health_check(self) -> RuntimeStatus:
        return await self._inner.health_check()

    async def run_task(self, task: AgentTask) -> AgentResult:
        call = await self._run_before(ModelCall(operation="run_task", task=task))
        effective = call.task if call.task is not None else task
        result = await self._inner.run_task(effective)
        outcome = await self._run_after(call, ModelResult(call=call, result=result))
        return outcome.result if outcome.result is not None else result

    async def create_session(self, input: SessionInput) -> RuntimeSession:
        return await self._inner.create_session(input)

    async def resume_session(self, thread_id: str, input: SessionInput) -> RuntimeSession:
        return await self._inner.resume_session(thread_id, input)

    def send_message(self, session_id: str, msg: RuntimeMessage) -> AsyncIterator[RuntimeEvent]:
        return self._stream(session_id, msg)

    async def _stream(
        self, session_id: str, message: RuntimeMessage
    ) -> AsyncIterator[RuntimeEvent]:
        call = await self._run_before(
            ModelCall(operation="send_message", session_id=session_id, message=message)
        )
        effective = call.message if call.message is not None else message
        collected: list[RuntimeEvent] = []
        async for event in self._inner.send_message(session_id, effective):
            collected.append(event)
            yield event
        await self._run_after(call, ModelResult(call=call, events=tuple(collected)))

    async def close_session(self, session_id: str) -> None:
        await self._inner.close_session(session_id)

    async def list_models(self) -> list[ModelInfo]:
        return await self._inner.list_models()

    async def dispose(self) -> None:
        await self._inner.dispose()
