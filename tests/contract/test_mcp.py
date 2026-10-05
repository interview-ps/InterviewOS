"""MCP family: servers (enable/allowlist), tools, external contexts.

MCP enablement (mcp_servers) and stored contexts (external_contexts) are NOT
wiped by /api/test/reset, so this module runs on its own server. The fake
server (tests/fixtures/fake-mcp-server.mjs) is configured via the mcp.json the
launcher writes into the server tmpdir.
"""

from __future__ import annotations

import pytest

from conftest import ContractClient
from harness.server import launch_server, stop_server
from harness.snapshot import Snapshot


@pytest.fixture(scope="module")
def base_url(tmp_path_factory: pytest.TempPathFactory):
    handle = launch_server(tmp_path_factory.mktemp("contract-mcp"))
    yield handle.base_url
    stop_server(handle)


def test_servers_disabled_by_default(client: ContractClient, snapshot: Snapshot) -> None:
    snap = snapshot.check_response("servers", client.get("/api/mcp/servers"))
    assert snap["status"] == 200
    servers = {s["id"]: s for s in snap["body"]["servers"]}
    assert servers["fake"]["enabled"] is False
    assert snap["body"]["loadError"] is None


def test_enable_and_list_tools(client: ContractClient, snapshot: Snapshot) -> None:
    resp = client.put(
        "/api/mcp/servers/{id}",
        id="fake",
        json={"enabled": True, "allowedTools": ["get_repository"]},
    )
    snap = snapshot.check_response("enable", resp)
    assert snap["status"] == 200
    assert snap["body"]["enabled"] is True

    resp = client.get("/api/mcp/servers/{id}/tools", id="fake")
    snap = snapshot.check_response("tools", resp)
    assert snap["status"] == 200
    names = [t["name"] for t in snap["body"]["tools"]]
    assert "get_repository" in names


def test_update_unknown_server(client: ContractClient, snapshot: Snapshot) -> None:
    resp = client.put("/api/mcp/servers/{id}", id="nope", json={"enabled": True})
    snap = snapshot.check_response("unknown", resp)
    assert snap["status"] == 404

    resp = client.put("/api/mcp/servers/{id}", id="fake", json={"enabled": "yes"})
    snap = snapshot.check_response("invalid", resp)
    assert snap["status"] == 400


def test_fetch_context(client: ContractClient, snapshot: Snapshot) -> None:
    client.put(
        "/api/mcp/servers/{id}",
        id="fake",
        json={"enabled": True, "allowedTools": ["get_repository"]},
    )
    resp = client.post(
        "/api/mcp/contexts",
        json={
            "serverId": "fake",
            "tool": "get_repository",
            "args": {"repo": "acme/widgets"},
            "title": "acme-widgets-repo",
        },
    )
    snap = snapshot.check_response("fetch", resp)
    assert snap["status"] == 201
    ctx_id = resp.json()["id"]

    resp = client.get("/api/mcp/contexts")
    snapshot.check_response("list", resp)
    assert resp.status_code == 200
    assert any(c["id"] == ctx_id for c in resp.json())

    resp = client.delete("/api/mcp/contexts/{id}", id=ctx_id)
    snap = snapshot.check_response("delete", resp)
    assert snap["status"] == 200


def test_fetch_context_disallowed_tool(
    client: ContractClient, snapshot: Snapshot
) -> None:
    client.put(
        "/api/mcp/servers/{id}",
        id="fake",
        json={"enabled": True, "allowedTools": ["get_repository"]},
    )
    resp = client.post(
        "/api/mcp/contexts", json={"serverId": "fake", "tool": "echo_env"}
    )
    snap = snapshot.check_response("disallowed", resp)
    assert snap["status"] in (400, 403, 502)

    resp = client.post("/api/mcp/contexts", json={"serverId": "nope", "tool": "x"})
    snap = snapshot.check_response("unknown-server", resp)
    assert snap["status"] in (400, 404)

    resp = client.post("/api/mcp/contexts", json={})
    snap = snapshot.check_response("invalid", resp)
    assert snap["status"] == 400


def test_delete_context_not_found(client: ContractClient, snapshot: Snapshot) -> None:
    resp = client.delete("/api/mcp/contexts/{id}", id="ctx_00000000-0000-0000-0000-000000000000")
    snap = snapshot.check_response("delete-404", resp)
    assert snap["status"] == 404
