"""Switchable runtime manager (port of `manager.ts`).

Selection precedence: `INTERVIEW_OS_RUNTIME` env > `preferred_kind` (the
persisted `runtimeKind` setting) > `codex`. Sessions do not migrate across a
switch: the old delegate is disposed and its live threads die, so interview
sessions rehydrate through `resume_session` on the new provider.
"""

from __future__ import annotations

import asyncio
import inspect
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Protocol

from .errors import RuntimeError
from .interface import (
    AgentResult,
    AgentTask,
    AIRuntime,
    AIUsageSink,
    ModelInfo,
    RuntimeEvent,
    RuntimeKind,
    RuntimeMessage,
    RuntimeSession,
    RuntimeStatus,
    SessionInput,
)
from .logger import Logger, NullLogger
from .process import ensure_dir
from .providers import (
    RuntimeHealthChecker,
    all_runtime_kinds,
    health_checker_for,
    instantiate_provider,
    is_runtime_kind,
    workspace_dir_for,
)

__all__ = [
    "RuntimeFactory",
    "RuntimeManager",
    "RuntimeManagerOptions",
    "create_runtime",
]


class RuntimeFactory(Protocol):
    """Test seam: build delegates without spawning real providers."""

    def __call__(
        self,
        kind: RuntimeKind,
        *,
        env: Mapping[str, str],
        workspace_dir: str,
        logger: Logger,
        usage_sink: AIUsageSink | None = None,
    ) -> AIRuntime | Awaitable[AIRuntime]: ...


SwitchHook = Callable[[AIRuntime], object | Awaitable[object]]


@dataclass(frozen=True, slots=True)
class RuntimeManagerOptions:
    env: Mapping[str, str]
    logger: Logger | None = None
    workspace_dir: str | None = None
    #: Saved UI selection (`runtimeKind` setting); only consulted when
    #: `INTERVIEW_OS_RUNTIME` is unset — the env var always wins.
    preferred_kind: str | None = None
    #: Fires for the initial runtime and every switch.
    on_switch: SwitchHook | None = None
    factory: RuntimeFactory | None = None
    #: Test seam: override per-provider detection probes.
    health_checkers: Mapping[str, RuntimeHealthChecker] | None = None
    #: AI usage telemetry sink forwarded to every provider it instantiates.
    usage_sink: AIUsageSink | None = None


async def _resolve(value: object | Awaitable[object]) -> object:
    if inspect.isawaitable(value):
        return await value
    return value


async def _instantiate(opts: RuntimeManagerOptions, kind: RuntimeKind) -> AIRuntime:
    logger = opts.logger if opts.logger is not None else NullLogger()
    workspace_dir = workspace_dir_for(kind, opts.env, opts.workspace_dir)
    if opts.factory is not None:
        created = opts.factory(
            kind,
            env=opts.env,
            workspace_dir=workspace_dir,
            logger=logger,
            usage_sink=opts.usage_sink,
        )
        if inspect.isawaitable(created):
            created = await created
        return created
    await ensure_dir(workspace_dir)
    return await instantiate_provider(
        kind, env=opts.env, workspace_dir=workspace_dir, logger=logger, usage_sink=opts.usage_sink
    )


class RuntimeManager:
    """Delegates every call to the currently selected provider."""

    def __init__(
        self, opts: RuntimeManagerOptions, initial: AIRuntime, initial_kind: RuntimeKind
    ) -> None:
        self._opts = opts
        self._current = initial
        self._current_kind = initial_kind
        self._disposed = False

    @property
    def kind(self) -> RuntimeKind:
        return self._current_kind

    @classmethod
    async def create(cls, opts: RuntimeManagerOptions) -> RuntimeManager:
        env = opts.env
        logger = opts.logger if opts.logger is not None else NullLogger()
        raw_kind = env.get("INTERVIEW_OS_RUNTIME")
        if raw_kind is None:
            raw_kind = opts.preferred_kind
        if raw_kind is None:
            raw_kind = "codex"
        kind: RuntimeKind = raw_kind if is_runtime_kind(raw_kind) else "codex"

        runtime = await _instantiate(opts, kind)
        status = await runtime.health_check()
        if not status.available:
            if env.get("INTERVIEW_OS_RUNTIME_FALLBACK") == "mock" and kind != "mock":
                logger.warn(
                    "runtime.unavailable_fallback",
                    {"runtime": kind, "message": status.message, "fallback": "mock"},
                )
                await runtime.dispose()
                runtime = await _instantiate(opts, "mock")
                kind = "mock"
            else:
                logger.warn("runtime.unavailable", {"runtime": kind, "message": status.message})
        manager = cls(opts, runtime, kind)
        if opts.on_switch is not None:
            await _resolve(opts.on_switch(runtime))
        return manager

    async def switch_to(self, kind: RuntimeKind) -> RuntimeStatus:
        """Swap the delegate and health-check it.

        The choice is kept even when the provider is unavailable — the returned
        status carries the setup hint.
        """

        if self._disposed:
            raise RuntimeError("UNAVAILABLE", "runtime manager is disposed")
        next_runtime = await _instantiate(self._opts, kind)
        status = await next_runtime.health_check()
        previous = self._current
        self._current = next_runtime
        self._current_kind = kind
        if self._opts.on_switch is not None:
            await _resolve(self._opts.on_switch(next_runtime))
        if previous is not next_runtime:
            await previous.dispose()
        if not status.available and self._opts.logger is not None:
            self._opts.logger.warn(
                "runtime.unavailable", {"runtime": kind, "message": status.message}
            )
        return status

    async def probe_all(self) -> list[RuntimeStatus]:
        """Probe every provider's detect path in parallel (PATH scan + `--version`)."""

        async def probe(kind: RuntimeKind) -> RuntimeStatus:
            checkers = self._opts.health_checkers
            checker = (checkers.get(kind) if checkers is not None else None) or health_checker_for(
                kind
            )
            workspace_dir = workspace_dir_for(
                kind,
                self._opts.env,
                self._opts.workspace_dir if kind == self._current.kind else None,
            )
            try:
                return await checker(self._opts.env, workspace_dir)
            except Exception as err:
                return RuntimeStatus(
                    runtime=kind,
                    available=False,
                    workspace=workspace_dir,
                    status="error",
                    message=str(err),
                )

        return list(await asyncio.gather(*(probe(kind) for kind in all_runtime_kinds())))

    async def health_check(self) -> RuntimeStatus:
        return await self._current.health_check()

    async def run_task(self, task: AgentTask) -> AgentResult:
        return await self._current.run_task(task)

    async def create_session(self, input: SessionInput) -> RuntimeSession:
        return await self._current.create_session(input)

    async def resume_session(self, thread_id: str, input: SessionInput) -> RuntimeSession:
        return await self._current.resume_session(thread_id, input)

    def send_message(self, session_id: str, msg: RuntimeMessage) -> AsyncIterator[RuntimeEvent]:
        return self._current.send_message(session_id, msg)

    async def close_session(self, session_id: str) -> None:
        await self._current.close_session(session_id)

    async def list_models(self) -> list[ModelInfo]:
        return await self._current.list_models()

    async def dispose(self) -> None:
        self._disposed = True
        await self._current.dispose()


async def create_runtime(opts: RuntimeManagerOptions | None = None) -> RuntimeManager:
    """`createRuntime`: returns a manager so the provider can be swapped later.

    When the selected provider is unavailable the runtime still reports via
    `health_check`; it falls back to mock only when
    `INTERVIEW_OS_RUNTIME_FALLBACK=mock`.
    """

    return await RuntimeManager.create(opts if opts is not None else RuntimeManagerOptions(env={}))
