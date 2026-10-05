"""Mock-runtime handlers — port of `apps/server/src/skills/mock/index.ts`.

Registers each AI skill's deterministic handler on a `MockRuntime`. Handlers
are added here as their skills are ported.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from ...ai.interface import AgentTask
from ...ai.mock import MockRuntime
from ..analyze.mocks import company_profiler_mock, jd_analyzer_mock, resume_analyzer_mock

__all__ = ["install_mode_mock_fallback", "register_mock_handlers"]

#: Deterministic handler per task id (sync or async, `(input) -> output`).
MOCK_HANDLERS: dict[str, Callable[[object], object]] = {
    "resume-analyzer": resume_analyzer_mock,
    "jd-analyzer": jd_analyzer_mock,
    "company-profiler": company_profiler_mock,
}


def install_mode_mock_fallback(
    runtime: MockRuntime,
    resolve: Callable[[str, object], Awaitable[object | None]],
) -> None:
    """v1: last-resort resolver for `interviewer.<mode>` / `answer-evaluator.<mode>`."""

    def fallback(task_id: str, input: object, task: AgentTask) -> Awaitable[object | None]:
        return resolve(task_id, input)

    runtime.set_fallback(fallback)


def register_mock_handlers(runtime: MockRuntime) -> None:
    """Registers every ported AI skill's deterministic handler on a MockRuntime."""
    for task_id, handler in MOCK_HANDLERS.items():

        def adapt(
            input: object,
            task: AgentTask,
            _handler: Callable[[object], object] = handler,
        ) -> object:
            return _handler(input)

        runtime.register(task_id, adapt)
