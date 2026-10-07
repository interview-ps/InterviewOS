"""Provider registry: kinds, workspaces, factories, local provider loading."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from pathlib import Path

import pytest

from interview_os.ai import (
    DEFAULT_WORKSPACE_DIR,
    RUNTIME_KINDS,
    AcpRuntime,
    ClaudeCodeRuntime,
    CodexRuntime,
    Logger,
    MockRuntime,
    RuntimeProviderSpec,
    RuntimeStatus,
    all_runtime_kinds,
    health_checker_for,
    instantiate_provider,
    is_runtime_kind,
    load_runtime_providers,
    mock_delay_ms,
    register_runtime_provider,
    registered_runtime_providers,
    workspace_dir_for,
)
from interview_os.ai import providers as providers_module

PROVIDER_MODULE = """
from interview_os.ai import MockRuntime, RuntimeProviderSpec, RuntimeStatus


def create(*, env, workspace_dir, logger=None, usage_sink=None):
    return MockRuntime()


async def health_check(env, workspace_dir):
    return RuntimeStatus(
        runtime="fixture-runtime",
        available=True,
        workspace=workspace_dir,
        status="ready",
        message="fixture provider (wraps mock)",
    )


PROVIDER = RuntimeProviderSpec(
    kind="fixture-runtime",
    label="Fixture provider",
    create=create,
    health_check=health_check,
)
"""


def make_mock(
    *,
    env: Mapping[str, str],
    workspace_dir: str,
    logger: Logger | None = None,
    usage_sink: object = None,
) -> MockRuntime:
    return MockRuntime()


class _Sink:
    """Records nothing; used to prove the sink is forwarded to the provider."""

    def record(self, event: object) -> None:
        pass


async def ready_status(env: Mapping[str, str], workspace_dir: str) -> RuntimeStatus:
    return RuntimeStatus(
        runtime="fixture-runtime", available=True, workspace=workspace_dir, status="ready"
    )


@pytest.fixture
def registry(monkeypatch: pytest.MonkeyPatch) -> dict[str, RuntimeProviderSpec]:
    fresh: dict[str, RuntimeProviderSpec] = {}
    monkeypatch.setattr(providers_module, "_custom_providers", fresh)
    return fresh


def write_config(directory: Path, entries: Sequence[Mapping[str, object]]) -> Path:
    path = directory / "interview-os.runtimes.json"
    path.write_text(json.dumps({"providers": entries}), encoding="utf-8")
    return path


def write_provider_module(directory: Path) -> Path:
    path = directory / "provider.py"
    path.write_text(PROVIDER_MODULE, encoding="utf-8")
    return path


def test_builtin_kinds_match_the_typescript_port() -> None:
    assert RUNTIME_KINDS == ("codex", "mock", "claude", "opencode", "devin")
    assert all_runtime_kinds() == list(RUNTIME_KINDS)
    assert is_runtime_kind("mock") is True
    assert is_runtime_kind("nope") is False


def test_workspace_dir_for_prefers_the_override_then_the_env_var(tmp_path: Path) -> None:
    assert workspace_dir_for("codex", {}, str(tmp_path)) == str(tmp_path.resolve())
    env = {"INTERVIEW_OS_DEVIN_WORKSPACE": str(tmp_path / "devin")}
    assert workspace_dir_for("devin", env) == str((tmp_path / "devin").resolve())
    assert workspace_dir_for("mock", env) == DEFAULT_WORKSPACE_DIR
    claude = Path(workspace_dir_for("claude", env))
    assert (claude.name, claude.parent.name) == ("claude-workspace", "data")


def test_mock_delay_ms_clamps_and_tolerates_junk() -> None:
    assert mock_delay_ms({}) == 0
    assert mock_delay_ms({"INTERVIEW_OS_MOCK_DELAY_MS": "25"}) == 25
    assert mock_delay_ms({"INTERVIEW_OS_MOCK_DELAY_MS": "-5"}) == 0
    assert mock_delay_ms({"INTERVIEW_OS_MOCK_DELAY_MS": "not-a-number"}) == 0


def test_register_rejects_invalid_specs(registry: dict[str, RuntimeProviderSpec]) -> None:
    with pytest.raises(ValueError, match="invalid runtime provider kind"):
        register_runtime_provider(RuntimeProviderSpec(kind="Bad Slug", create=make_mock))
    with pytest.raises(ValueError, match="collides with a built-in runtime"):
        register_runtime_provider(RuntimeProviderSpec(kind="codex", create=make_mock))
    assert registry == {}


def test_register_and_list_custom_providers(registry: dict[str, RuntimeProviderSpec]) -> None:
    spec = RuntimeProviderSpec(kind="fixture-runtime", create=make_mock)
    register_runtime_provider(spec)
    assert registered_runtime_providers() == [spec]
    assert "fixture-runtime" in all_runtime_kinds()


async def test_instantiate_provider_builds_every_builtin(tmp_path: Path) -> None:
    env: Mapping[str, str] = {"PATH": ""}
    workspace = str(tmp_path)
    assert isinstance(
        await instantiate_provider("mock", env=env, workspace_dir=workspace), MockRuntime
    )
    assert isinstance(
        await instantiate_provider("codex", env=env, workspace_dir=workspace), CodexRuntime
    )
    assert isinstance(
        await instantiate_provider("claude", env=env, workspace_dir=workspace), ClaudeCodeRuntime
    )
    assert isinstance(
        await instantiate_provider("opencode", env=env, workspace_dir=workspace), AcpRuntime
    )
    assert isinstance(
        await instantiate_provider("devin", env=env, workspace_dir=workspace), AcpRuntime
    )
    assert (await instantiate_provider("opencode", env=env, workspace_dir=workspace)).kind == (
        "opencode"
    )


async def test_health_checker_for_an_unknown_kind_reports_unavailable(tmp_path: Path) -> None:
    status = await health_checker_for("mystery")({}, str(tmp_path))
    assert (status.available, status.status) == (False, "unavailable")
    assert 'unknown runtime "mystery"' in (status.message or "")


async def test_health_checker_for_a_custom_provider_marks_it_trusted_local(
    registry: dict[str, RuntimeProviderSpec], tmp_path: Path
) -> None:
    register_runtime_provider(
        RuntimeProviderSpec(kind="fixture-runtime", create=make_mock, health_check=ready_status)
    )
    status = await health_checker_for("fixture-runtime")({}, str(tmp_path))
    assert status.trusted_local is True
    assert status.available is True


async def test_health_checker_for_a_custom_provider_without_a_probe(
    registry: dict[str, RuntimeProviderSpec], tmp_path: Path
) -> None:
    register_runtime_provider(RuntimeProviderSpec(kind="fixture-runtime", create=make_mock))
    status = await health_checker_for("fixture-runtime")({}, str(tmp_path))
    assert status.trusted_local is True
    assert status.runtime == "mock"  # the wrapped MockRuntime's own health check


async def test_load_runtime_providers_loads_a_local_module(
    registry: dict[str, RuntimeProviderSpec], tmp_path: Path
) -> None:
    module = write_provider_module(tmp_path)
    config = write_config(tmp_path, [{"kind": "fixture-runtime", "module": str(module)}])
    result = load_runtime_providers(config)
    assert result.loaded == ["fixture-runtime"]
    assert result.errors == []
    runtime = await instantiate_provider("fixture-runtime", env={}, workspace_dir=str(tmp_path))
    assert isinstance(runtime, MockRuntime)
    status = await health_checker_for("fixture-runtime")({}, str(tmp_path))
    assert status.trusted_local is True
    assert status.message == "fixture provider (wraps mock)"


async def test_load_runtime_providers_resolves_relative_module_paths(
    registry: dict[str, RuntimeProviderSpec], tmp_path: Path
) -> None:
    write_provider_module(tmp_path)
    config = write_config(tmp_path, [{"kind": "fixture-runtime", "module": "./provider.py"}])
    assert load_runtime_providers(config).loaded == ["fixture-runtime"]


def test_load_runtime_providers_reports_bad_entries_and_keeps_going(
    registry: dict[str, RuntimeProviderSpec], tmp_path: Path
) -> None:
    module = write_provider_module(tmp_path)
    config = write_config(
        tmp_path,
        [
            {"kind": "fixture-runtime", "module": str(module)},
            {"kind": "broken-runtime", "module": "./does-not-exist.py"},
            {"kind": "codex", "module": str(module)},  # collides with a built-in
            {"module": str(module)},  # malformed entry
        ],
    )
    result = load_runtime_providers(config)
    assert result.loaded == ["fixture-runtime"]
    assert len(result.errors) == 3
    assert any("broken-runtime" in error for error in result.errors)
    assert any("collides with a built-in runtime" in error for error in result.errors)


def test_load_runtime_providers_accepts_a_bare_array(
    registry: dict[str, RuntimeProviderSpec], tmp_path: Path
) -> None:
    module = write_provider_module(tmp_path)
    config = tmp_path / "runtimes.json"
    config.write_text(json.dumps([{"kind": "fixture-runtime", "module": str(module)}]), "utf-8")
    result = load_runtime_providers(config)
    assert result.loaded == ["fixture-runtime"]


def test_load_runtime_providers_ignores_a_missing_file(tmp_path: Path) -> None:
    result = load_runtime_providers(tmp_path / "absent.json")
    assert (result.loaded, result.errors) == ([], [])


def test_load_runtime_providers_reports_malformed_config(tmp_path: Path) -> None:
    config = tmp_path / "broken.json"
    config.write_text("{not json", encoding="utf-8")
    result = load_runtime_providers(config)
    assert result.loaded == []
    assert len(result.errors) == 1

    wrong_shape = tmp_path / "wrong.json"
    wrong_shape.write_text(json.dumps({"providers": {}}), encoding="utf-8")
    shape_result = load_runtime_providers(wrong_shape)
    assert "expected an array" in shape_result.errors[0]


def test_load_runtime_providers_accepts_a_declarative_acp_agent(
    registry: dict[str, RuntimeProviderSpec], tmp_path: Path
) -> None:
    config = write_config(
        tmp_path,
        [
            {
                "kind": "my-acp",
                "acp": {"command": "/opt/bin/agent", "args": ["acp"], "env": ["MYAGENT_TOKEN"]},
            }
        ],
    )
    result = load_runtime_providers(config)
    assert result.loaded == ["my-acp"]
    assert result.errors == []
    assert "my-acp" in all_runtime_kinds()


async def test_declarative_acp_provider_builds_an_acp_runtime(
    registry: dict[str, RuntimeProviderSpec], tmp_path: Path
) -> None:
    config = write_config(tmp_path, [{"kind": "my-acp", "acp": {"command": "/no/such/agent"}}])
    load_runtime_providers(config)
    runtime = await instantiate_provider("my-acp", env={}, workspace_dir=str(tmp_path))
    assert isinstance(runtime, AcpRuntime)
    assert runtime.kind == "my-acp"
    status = await health_checker_for("my-acp")({}, str(tmp_path))
    assert status.trusted_local is True
    assert status.runtime == "my-acp"
    # a fixed command that cannot be spawned degrades, never raises
    assert status.available is False


async def test_declarative_acp_provider_forwards_the_usage_sink(
    registry: dict[str, RuntimeProviderSpec], tmp_path: Path
) -> None:
    config = write_config(tmp_path, [{"kind": "my-acp", "acp": {"command": "/no/such/agent"}}])
    load_runtime_providers(config)
    sink = _Sink()
    runtime = await instantiate_provider(
        "my-acp", env={}, workspace_dir=str(tmp_path), usage_sink=sink
    )
    assert isinstance(runtime, AcpRuntime)
    assert runtime._opts.usage_sink is sink


def test_load_runtime_providers_reports_bad_acp_entries(
    registry: dict[str, RuntimeProviderSpec], tmp_path: Path
) -> None:
    config = write_config(tmp_path, [{"kind": "my-acp", "acp": {"args": ["acp"]}}])
    result = load_runtime_providers(config)
    assert result.loaded == []
    assert len(result.errors) == 1
    assert "acp.command" in result.errors[0]
