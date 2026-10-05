"""MCP: local config loading, lazy stdio clients, service views and allowlists."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from interview_os.ai.logger import NullLogger
from interview_os.core.models import AppError, ExternalContext, McpConfig, McpServerConfig
from interview_os.mcp import McpConfigLoad, McpManager, McpServerState, McpToolInfo
from interview_os.orchestrator.context import WorkflowContext
from interview_os.orchestrator.services.mcp import McpServerPatch, McpService

REPO_ROOT = Path(__file__).resolve().parents[4]
FIXTURE = REPO_ROOT / "tests" / "fixtures" / "fake-mcp-server.mjs"

HAS_NODE = shutil.which("node") is not None


def _config_path(tmp_path: Path, servers: object) -> Path:
    path = tmp_path / "interview-os.mcp.json"
    if isinstance(servers, str):
        path.write_text(servers, encoding="utf-8")
    else:
        path.write_text(json.dumps({"servers": servers}), encoding="utf-8")
    return path


def _fake_server(**overrides: object) -> dict[str, object]:
    return {
        "id": "fake",
        "name": "Fake MCP",
        "command": "node",
        "args": [str(FIXTURE)],
        "envPassthrough": ["TEST_PASSTHROUGH_VAR"],
        **overrides,
    }


def _manager(ctx: WorkflowContext, path: Path) -> McpManager:
    def state_for(server_id: str) -> McpServerState:
        row = ctx.store.get_mcp_server(server_id)
        return McpServerState(
            enabled=(row is not None and row.enabled == 1),
            allowed_tools=tuple(row.allowed_tools) if row is not None else (),
        )

    return McpManager(path, NullLogger(), state_for)


# --------------------------------------------------------------- config only


def test_missing_config_file_means_no_servers(tmp_path: Path, ctx: WorkflowContext) -> None:
    manager = _manager(ctx, tmp_path / "missing.json")
    loaded = manager.load()
    assert loaded.config.servers == []
    assert loaded.load_error is None
    assert manager.server_config("fake") is None


def test_invalid_config_surfaces_a_load_error(tmp_path: Path, ctx: WorkflowContext) -> None:
    manager = _manager(ctx, _config_path(tmp_path, "{ not json"))
    loaded = manager.load()
    assert loaded.config.servers == []
    assert loaded.load_error is not None
    assert loaded.load_error.startswith("invalid MCP config: ")

    bad_shape = _manager(ctx, _config_path(tmp_path, [{"id": "fake"}]))
    assert bad_shape.load().load_error is not None

    duplicate = _manager(ctx, _config_path(tmp_path, [_fake_server(), _fake_server(name="Other")]))
    assert duplicate.load().load_error == 'invalid MCP config: duplicate server id "fake"'


def test_server_config_lookup(tmp_path: Path, ctx: WorkflowContext) -> None:
    manager = _manager(ctx, _config_path(tmp_path, [_fake_server()]))
    config = manager.server_config("fake")
    assert config is not None
    assert config.name == "Fake MCP"
    assert config.env_passthrough == ["TEST_PASSTHROUGH_VAR"]


# ------------------------------------------------------- real stdio clients


pytestmark_node = pytest.mark.skipif(not HAS_NODE, reason="node is not on PATH")


@pytestmark_node
async def test_disabled_server_and_allowlist_gate(tmp_path: Path, ctx: WorkflowContext) -> None:
    manager = _manager(ctx, _config_path(tmp_path, [_fake_server()]))
    try:
        with pytest.raises(AppError) as disabled:
            await manager.list_tools("fake")
        assert disabled.value.code == "VALIDATION"
        assert disabled.value.args[0] == 'MCP server "fake" is disabled'

        ctx.store.upsert_mcp_server(id="fake", enabled=1, allowed_tools=[], updated_at="now")
        with pytest.raises(AppError) as denied:
            await manager.call_tool("fake", "get_repository", {"repo": "acme/widgets"})
        assert denied.value.code == "VALIDATION"
        assert denied.value.args[0] == (
            'tool "get_repository" is not in allowedTools for MCP server "fake"'
        )

        with pytest.raises(AppError) as unknown:
            await manager.call_tool("nope", "x", {})
        assert unknown.value.code == "NOT_FOUND"
        assert unknown.value.args[0] == 'no MCP server "nope"'
    finally:
        await manager.close_all()


@pytestmark_node
async def test_lists_tools_calls_tools_and_truncates(tmp_path: Path, ctx: WorkflowContext) -> None:
    manager = _manager(ctx, _config_path(tmp_path, [_fake_server()]))
    ctx.store.upsert_mcp_server(
        id="fake", enabled=1, allowed_tools=["get_repository", "big_output"], updated_at="now"
    )
    try:
        tools = await manager.list_tools("fake")
        assert [tool.name for tool in tools] == ["get_repository", "echo_env", "big_output"]
        assert all(isinstance(tool, McpToolInfo) for tool in tools)

        probed = await manager.probe_tools("fake")
        assert len(probed) == 3

        text = await manager.call_tool("fake", "get_repository", {"repo": "acme/widgets"})
        assert text.startswith("# acme/widgets")
        assert "src/index.ts" in text

        big = await manager.call_tool("fake", "big_output", {})
        assert len(big) == 12_000
    finally:
        await manager.close_all()


@pytestmark_node
async def test_child_env_keeps_only_basics_and_passthrough(
    tmp_path: Path, ctx: WorkflowContext, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TEST_PASSTHROUGH_VAR", "present")
    monkeypatch.setenv("INTERVIEW_OS_DUMMY_SECRET", "should-not-leak")
    manager = _manager(ctx, _config_path(tmp_path, [_fake_server()]))
    ctx.store.upsert_mcp_server(id="fake", enabled=1, allowed_tools=["echo_env"], updated_at="now")
    try:
        names = json.loads(await manager.call_tool("fake", "echo_env", {}))
        assert "TEST_PASSTHROUGH_VAR" in names
        assert "INTERVIEW_OS_DUMMY_SECRET" not in names
    finally:
        await manager.close_all()


@pytestmark_node
async def test_unreachable_server_fails_cleanly(tmp_path: Path, ctx: WorkflowContext) -> None:
    manager = _manager(
        ctx,
        _config_path(tmp_path, [_fake_server(command="definitely-not-a-real-binary-xyz", args=[])]),
    )
    try:
        with pytest.raises(AppError) as error:
            await manager.probe_tools("fake")
        assert error.value.code == "MCP_UNAVAILABLE"
        assert error.value.args[0] == 'MCP server "fake" could not be reached'
    finally:
        await manager.close_all()


@pytestmark_node
async def test_oversized_args_are_rejected(tmp_path: Path, ctx: WorkflowContext) -> None:
    manager = _manager(ctx, _config_path(tmp_path, [_fake_server()]))
    ctx.store.upsert_mcp_server(id="fake", enabled=1, allowed_tools=["echo_env"], updated_at="now")
    try:
        with pytest.raises(AppError) as error:
            await manager.call_tool("fake", "echo_env", {"blob": "x" * 5000})
        assert error.value.code == "VALIDATION"
        assert error.value.args[0] == "tool args exceed 4 KB"
    finally:
        await manager.close_all()


# ------------------------------------------------------------- service layer


class FakeManager:
    """A no-op stand-in for the real manager (no child processes)."""

    def __init__(self, config: McpServerConfig, *, tools: list[str] | None = None) -> None:
        self._config = config
        self._tools = tools if tools is not None else ["get_repository"]
        self.probe_error: Exception | None = None
        self.disconnected: list[str] = []
        self.calls: list[tuple[str, str, dict[str, object]]] = []

    def load(self) -> McpConfigLoad:
        return McpConfigLoad(config=McpConfig(servers=[self._config]), load_error=None)

    def server_config(self, server_id: str) -> McpServerConfig | None:
        return self._config if server_id == self._config.id else None

    async def list_tools(self, server_id: str) -> list[McpToolInfo]:
        return [McpToolInfo(name=name, description=f"{name} tool") for name in self._tools]

    async def probe_tools(self, server_id: str) -> list[McpToolInfo]:
        if self.probe_error is not None:
            raise self.probe_error
        return await self.list_tools(server_id)

    async def call_tool(self, server_id: str, tool: str, args: dict[str, object]) -> str:
        self.calls.append((server_id, tool, args))
        return "repo text"

    async def disconnect(self, server_id: str) -> None:
        self.disconnected.append(server_id)


FAKE_CONFIG = McpServerConfig(
    id="fake",
    name="Fake MCP",
    description="fixture",
    command="node",
    args=["server.mjs"],
    env_passthrough=["TEST_PASSTHROUGH_VAR"],
)


async def test_list_servers_without_a_manager(ctx: WorkflowContext) -> None:
    service = McpService(ctx, None)
    view = await service.list_mcp_servers()
    assert view.servers == []
    assert view.load_error is None
    with pytest.raises(AppError) as error:
        await service.list_mcp_tools("fake")
    assert error.value.code == "VALIDATION"
    assert error.value.args[0] == "MCP is not configured on this orchestrator"


async def test_update_server_toggles_and_validates(ctx: WorkflowContext) -> None:
    manager = FakeManager(FAKE_CONFIG)
    service = McpService(ctx, manager)

    listing = await service.list_mcp_servers()
    assert listing.load_error is None
    assert [server.id for server in listing.servers] == ["fake"]
    assert listing.servers[0].enabled is False
    assert listing.servers[0].env_passthrough == ["TEST_PASSTHROUGH_VAR"]
    assert listing.servers[0].allowed_tools == []

    enabled = await service.update_mcp_server("fake", McpServerPatch(enabled=True))
    assert enabled.enabled is True
    assert ctx.store.get_mcp_server("fake") is not None

    with pytest.raises(AppError) as short_error:
        await service.update_mcp_server("fake", McpServerPatch(allowed_tools=[""]))
    assert short_error.value.code == "VALIDATION"
    assert short_error.value.args[0] == "allowedTools entries must be 1–64 chars"

    with pytest.raises(AppError) as long_error:
        await service.update_mcp_server("fake", McpServerPatch(allowed_tools=["x" * 65]))
    assert long_error.value.code == "VALIDATION"

    with pytest.raises(AppError) as unknown_tool:
        await service.update_mcp_server("fake", McpServerPatch(allowed_tools=["nope"]))
    assert unknown_tool.value.code == "VALIDATION"
    assert unknown_tool.value.args[0] == 'tool "nope" is not exposed by MCP server "fake"'

    updated = await service.update_mcp_server(
        "fake", McpServerPatch(allowed_tools=["get_repository"])
    )
    assert updated.allowed_tools == ["get_repository"]

    with pytest.raises(AppError) as missing:
        await service.update_mcp_server("other", McpServerPatch(enabled=True))
    assert missing.value.code == "NOT_FOUND"
    assert missing.value.args[0] == 'no MCP server "other"'

    disabled = await service.update_mcp_server("fake", McpServerPatch(enabled=False))
    assert disabled.enabled is False
    assert manager.disconnected == ["fake"]


async def test_update_server_survives_an_unreachable_probe(ctx: WorkflowContext) -> None:
    manager = FakeManager(FAKE_CONFIG)
    manager.probe_error = RuntimeError("boom")
    service = McpService(ctx, manager)

    updated = await service.update_mcp_server(
        "fake", McpServerPatch(enabled=True, allowed_tools=["get_repository"])
    )
    assert updated.enabled is True
    assert updated.allowed_tools == ["get_repository"]


async def test_external_contexts_roundtrip(ctx: WorkflowContext) -> None:
    manager = FakeManager(FAKE_CONFIG)
    service = McpService(ctx, manager)

    context = await service.fetch_external_context(
        server_id="fake", tool="get_repository", args={"repo": "acme/widgets"}
    )
    assert isinstance(context, ExternalContext)
    assert context.id.startswith("ctx_")
    assert context.title == "Fake MCP: get_repository"
    assert context.text == "repo text"
    assert manager.calls == [("fake", "get_repository", {"repo": "acme/widgets"})]

    titled = await service.fetch_external_context(
        server_id="fake", tool="get_repository", title="acme/widgets repo"
    )
    assert titled.title == "acme/widgets repo"

    listed = await service.list_external_contexts()
    assert [item.id for item in listed] == [titled.id, context.id]

    await service.delete_external_context(context.id)
    assert [item.id for item in await service.list_external_contexts()] == [titled.id]

    with pytest.raises(AppError) as error:
        await service.delete_external_context(context.id)
    assert error.value.code == "NOT_FOUND"
    assert error.value.args[0] == f"no external context {context.id}"


async def test_service_with_the_real_manager_over_the_fixture(
    tmp_path: Path, ctx: WorkflowContext
) -> None:
    if not HAS_NODE:
        pytest.skip("node is not on PATH")
    manager = _manager(ctx, _config_path(tmp_path, [_fake_server()]))
    service = McpService(ctx, manager)
    try:
        with pytest.raises(AppError) as error:
            await service.fetch_external_context(server_id="fake", tool="get_repository")
        assert error.value.code == "VALIDATION"

        await service.update_mcp_server(
            "fake", McpServerPatch(enabled=True, allowed_tools=["get_repository"])
        )
        context = await service.fetch_external_context(
            server_id="fake", tool="get_repository", args={"repo": "acme/widgets"}
        )
        assert "acme/widgets" in context.text
        assert [item.id for item in await service.list_external_contexts()] == [context.id]

        tools = await service.list_mcp_tools("fake")
        assert "get_repository" in {tool.name for tool in tools}
    finally:
        await manager.close_all()
