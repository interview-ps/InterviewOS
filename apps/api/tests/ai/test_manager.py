"""RuntimeManager: selection precedence, hot-swap, probes, delegation."""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from interview_os.ai import (
    AgentResult,
    AgentTask,
    AIRuntime,
    MockRuntime,
    ModelInfo,
    RuntimeError,
    RuntimeEvent,
    RuntimeHealthChecker,
    RuntimeManager,
    RuntimeManagerOptions,
    RuntimeMessage,
    RuntimeSession,
    RuntimeStatus,
    SessionInput,
    create_runtime,
)

DISPOSED: list[str] = []
CREATED: list[str] = []


@dataclass
class FakeRuntime:
    """A MockRuntime posing as another provider (kind + health check swapped)."""

    kind: str
    available: bool = True
    version: str | None = None
    inner: MockRuntime = field(default_factory=MockRuntime)

    async def health_check(self) -> RuntimeStatus:
        return RuntimeStatus(
            runtime=self.kind,
            available=self.available,
            version=self.version,
            status="ready" if self.available else "unavailable",
        )

    async def run_task(self, task: AgentTask) -> AgentResult:
        return await self.inner.run_task(task)

    async def create_session(self, input: SessionInput) -> RuntimeSession:
        return await self.inner.create_session(input)

    async def resume_session(self, thread_id: str, input: SessionInput) -> RuntimeSession:
        return await self.inner.resume_session(thread_id, input)

    def send_message(self, session_id: str, msg: RuntimeMessage) -> AsyncIterator[RuntimeEvent]:
        return self.inner.send_message(session_id, msg)

    async def close_session(self, session_id: str) -> None:
        await self.inner.close_session(session_id)

    async def list_models(self) -> list[ModelInfo]:
        return await self.inner.list_models()

    async def dispose(self) -> None:
        DISPOSED.append(self.kind)


def factory(kind: str, *, env: Mapping[str, str], workspace_dir: str, logger: object) -> AIRuntime:
    CREATED.append(kind)
    return FakeRuntime(kind=kind, available=env.get("FAKE_UNAVAILABLE_KIND") != kind)


def reset() -> None:
    DISPOSED.clear()
    CREATED.clear()


async def make_manager(
    *,
    env: Mapping[str, str],
    preferred_kind: str | None = None,
    on_switch: Callable[[AIRuntime], object] | None = None,
) -> RuntimeManager:
    return await RuntimeManager.create(
        RuntimeManagerOptions(
            env=env,
            factory=factory,
            preferred_kind=preferred_kind,
            on_switch=on_switch,
        )
    )


async def test_env_var_wins_over_the_persisted_preference() -> None:
    reset()
    manager = await make_manager(env={"INTERVIEW_OS_RUNTIME": "mock"}, preferred_kind="devin")
    assert manager.kind == "mock"


async def test_preferred_kind_applies_when_the_env_var_is_unset() -> None:
    reset()
    manager = await make_manager(env={}, preferred_kind="devin")
    assert manager.kind == "devin"


async def test_defaults_to_codex_and_ignores_a_bogus_persisted_kind() -> None:
    reset()
    manager = await make_manager(env={}, preferred_kind="not-a-thing")
    assert manager.kind == "codex"


async def test_falls_back_to_mock_when_asked() -> None:
    reset()
    manager = await make_manager(
        env={
            "INTERVIEW_OS_RUNTIME": "devin",
            "INTERVIEW_OS_RUNTIME_FALLBACK": "mock",
            "FAKE_UNAVAILABLE_KIND": "devin",
        }
    )
    assert manager.kind == "mock"
    assert DISPOSED == ["devin"]


async def test_keeps_an_unavailable_provider_without_the_fallback() -> None:
    reset()
    manager = await make_manager(
        env={"INTERVIEW_OS_RUNTIME": "devin", "FAKE_UNAVAILABLE_KIND": "devin"}
    )
    assert manager.kind == "devin"
    assert DISPOSED == []


async def test_fires_on_switch_for_the_initial_runtime() -> None:
    reset()
    seen: list[str] = []
    await make_manager(
        env={"INTERVIEW_OS_RUNTIME": "mock"}, on_switch=lambda runtime: seen.append(runtime.kind)
    )
    assert seen == ["mock"]


async def test_switch_swaps_the_delegate_and_disposes_the_previous_one() -> None:
    reset()
    seen: list[str] = []
    manager = await make_manager(
        env={"INTERVIEW_OS_RUNTIME": "mock"}, on_switch=lambda runtime: seen.append(runtime.kind)
    )
    previous = (await manager.health_check()).runtime
    status = await manager.switch_to("devin")
    assert manager.kind == "devin"
    assert (status.runtime, status.available) == ("devin", True)
    assert seen == ["mock", "devin"]
    assert DISPOSED == ["mock"]
    assert previous == "mock"


async def test_switch_keeps_an_unavailable_selection() -> None:
    reset()
    manager = await make_manager(
        env={"INTERVIEW_OS_RUNTIME": "mock", "FAKE_UNAVAILABLE_KIND": "codex"}
    )
    status = await manager.switch_to("codex")
    assert manager.kind == "codex"
    assert status.available is False


async def test_delegates_calls_to_the_current_provider() -> None:
    reset()
    manager = await make_manager(env={"INTERVIEW_OS_RUNTIME": "mock"})
    result = await manager.run_task(
        AgentTask(task_id="x", instructions="x", input={}, output_schema={})
    )
    assert result.ok is False  # no handlers registered on the mock delegate
    await manager.switch_to("claude")
    assert [model.id for model in await manager.list_models()] == ["mock"]


async def test_dispose_marks_the_manager_disposed() -> None:
    reset()
    manager = await make_manager(env={"INTERVIEW_OS_RUNTIME": "mock"})
    await manager.dispose()
    assert DISPOSED == ["mock"]
    with pytest.raises(RuntimeError) as excinfo:
        await manager.switch_to("mock")
    assert excinfo.value.code == "UNAVAILABLE"


async def test_probe_all_returns_one_status_per_kind() -> None:
    reset()

    async def codex_probe(env: Mapping[str, str], workspace_dir: str) -> RuntimeStatus:
        return RuntimeStatus(
            runtime="codex", available=False, status="unavailable", message="not installed"
        )

    async def devin_probe(env: Mapping[str, str], workspace_dir: str) -> RuntimeStatus:
        return RuntimeStatus(runtime="devin", available=True, version="2026.8.18", status="ready")

    async def claude_probe(env: Mapping[str, str], workspace_dir: str) -> RuntimeStatus:
        raise OSError("spawn exploded")

    manager = await RuntimeManager.create(
        RuntimeManagerOptions(
            env={"INTERVIEW_OS_RUNTIME": "mock"},
            factory=factory,
            health_checkers={
                "codex": codex_probe,
                "devin": devin_probe,
                "claude": claude_probe,
            },
        )
    )
    probes = await manager.probe_all()
    assert len(probes) == 5
    by_kind = {probe.runtime: probe for probe in probes}
    assert by_kind["codex"].available is False
    assert by_kind["devin"].version == "2026.8.18"
    assert by_kind["claude"].status == "error"
    assert by_kind["mock"].available is True
    assert by_kind["opencode"].available is False


async def test_probe_all_uses_the_workspace_override_for_the_current_kind(
    tmp_path: Path,
) -> None:
    reset()
    seen: dict[str, str] = {}

    def checker_for(kind: str) -> RuntimeHealthChecker:
        async def checker(env: Mapping[str, str], workspace_dir: str) -> RuntimeStatus:
            seen[kind] = workspace_dir
            return RuntimeStatus(runtime=kind, available=True, status="ready")

        return checker

    override = str(tmp_path.resolve())
    manager = await RuntimeManager.create(
        RuntimeManagerOptions(
            env={"INTERVIEW_OS_RUNTIME": "mock"},
            workspace_dir=override,
            factory=factory,
            health_checkers={"codex": checker_for("codex"), "mock": checker_for("mock")},
        )
    )
    await manager.probe_all()
    assert seen["mock"] == override
    assert seen["codex"] != override


async def test_create_runtime_honours_the_env_selection() -> None:
    reset()
    runtime = await create_runtime(
        RuntimeManagerOptions(env={"INTERVIEW_OS_RUNTIME": "mock"}, factory=factory)
    )
    assert isinstance(runtime, RuntimeManager)
    assert runtime.kind == "mock"


async def test_manager_send_message_delegates() -> None:
    reset()
    manager = await make_manager(env={"INTERVIEW_OS_RUNTIME": "mock"})
    events: list[RuntimeEvent] = []
    async for event in manager.send_message("ghost", RuntimeMessage(text="hi")):
        events.append(event)
    assert events[0]["type"] == "error"
