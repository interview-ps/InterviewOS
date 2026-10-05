"""Install/uninstall routes (POST /api/plugins/install, DELETE /api/plugins/{id},
POST /api/packs/install, DELETE /api/packs/{kind}/{id}).

Installed plugin/pack files and registry entries are NOT wiped by
/api/test/reset (they live outside SQLite tables it truncates), so this module
runs on its own server to keep the session-suite clean.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from conftest import ContractClient
from harness.server import launch_server, stop_server
from harness.snapshot import Snapshot

GIT_SRC = Path(__file__).resolve().parent / "git-src"


@pytest.fixture(scope="module")
def base_url(tmp_path_factory: pytest.TempPathFactory):
    handle = launch_server(tmp_path_factory.mktemp("contract-installs"))
    yield handle.base_url
    stop_server(handle)


def _git_repo(src: str, tmp_path: Path) -> str:
    dst = tmp_path / src
    shutil.copytree(GIT_SRC / src, dst)
    subprocess.run(["git", "init", "-q"], cwd=dst, check=True)
    subprocess.run(["git", "add", "-A"], cwd=dst, check=True)
    subprocess.run(
        ["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"],
        cwd=dst,
        check=True,
    )
    return str(dst)


def test_plugin_install_enable_run_uninstall(
    client: ContractClient, tmp_path: Path, snapshot: Snapshot
) -> None:
    repo = _git_repo("plugin", tmp_path)

    resp = client.post("/api/plugins/install", json={"url": repo})
    snap = snapshot.check_response("install", resp)
    assert snap["status"] == 201
    assert snap["body"]["plugin"]["manifest"]["id"] == "contract-demo-plugin"
    assert snap["body"]["plugin"]["enabled"] is False

    resp = client.put(
        "/api/plugins/{id}", id="contract-demo-plugin", json={"enabled": True}
    )
    assert resp.status_code == 200

    resp = client.post(
        "/api/plugins/{id}/run",
        id="contract-demo-plugin",
        json={"request": {"probe": 1}},
    )
    snap = snapshot.check_response("run", resp)
    assert snap["status"] == 200
    assert snap["body"]["output"]["from"] == "contract-demo-plugin"

    resp = client.delete("/api/plugins/{id}", id="contract-demo-plugin")
    snap = snapshot.check_response("uninstall", resp)
    assert snap["status"] == 200

    plugins = client.get("/api/plugins").json()["plugins"]
    assert "contract-demo-plugin" not in [p["manifest"]["id"] for p in plugins]


def test_plugin_install_rejects_bad_source(
    client: ContractClient, snapshot: Snapshot
) -> None:
    resp = client.post(
        "/api/plugins/install", json={"url": "https://user:pw@example.com/x.git"}
    )
    snap = snapshot.check_response("creds", resp)
    assert snap["status"] == 400

    resp = client.post("/api/plugins/install", json={"url": "--upload-pack=/bin/sh"})
    snap = snapshot.check_response("arg-injection", resp)
    assert snap["status"] == 400

    resp = client.post("/api/plugins/install", json={})
    snap = snapshot.check_response("missing-url", resp)
    assert snap["status"] == 400


def test_uninstall_bundled_plugin_rejected(
    client: ContractClient, snapshot: Snapshot
) -> None:
    resp = client.delete("/api/plugins/{id}", id="interview-day-checklist")
    snap = snapshot.check_response("bundled", resp)
    assert snap["status"] == 400


def test_uninstall_unknown_plugin(client: ContractClient, snapshot: Snapshot) -> None:
    resp = client.delete("/api/plugins/{id}", id="no-such-plugin")
    snap = snapshot.check_response("unknown", resp)
    assert snap["status"] == 404


def test_pack_install_and_uninstall(
    client: ContractClient, tmp_path: Path, snapshot: Snapshot
) -> None:
    repo = _git_repo("pack-company", tmp_path)
    resp = client.post("/api/packs/install", json={"kind": "company", "url": repo})
    snap = snapshot.check_response("install-company", resp)
    assert snap["status"] == 201

    resp = client.delete("/api/packs/{kind}/{id}", kind="company", id="contract-demo-co")
    snap = snapshot.check_response("uninstall-company", resp)
    assert snap["status"] == 200

    repo = _git_repo("pack-role", tmp_path / "role")
    resp = client.post("/api/packs/install", json={"kind": "role", "url": repo})
    snap = snapshot.check_response("install-role", resp)
    assert snap["status"] == 201

    resp = client.delete(
        "/api/packs/{kind}/{id}", kind="role", id="contract-demo-role"
    )
    snap = snapshot.check_response("uninstall-role", resp)
    assert snap["status"] == 200


def test_pack_install_errors(client: ContractClient, snapshot: Snapshot) -> None:
    resp = client.post(
        "/api/packs/install", json={"kind": "interview", "url": "/tmp/x"}
    )
    snap = snapshot.check_response("bad-kind", resp)
    assert snap["status"] == 400

    resp = client.post("/api/packs/install", json={"kind": "company"})
    snap = snapshot.check_response("missing-url", resp)
    assert snap["status"] == 400


def test_pack_delete_errors(client: ContractClient, snapshot: Snapshot) -> None:
    resp = client.delete("/api/packs/{kind}/{id}", kind="interview", id="x")
    snap = snapshot.check_response("bad-kind", resp)
    assert snap["status"] == 400

    resp = client.delete("/api/packs/{kind}/{id}", kind="company", id="stripe")
    snap = snapshot.check_response("bundled", resp)
    assert snap["status"] == 400

    resp = client.delete("/api/packs/{kind}/{id}", kind="company", id="no-such")
    snap = snapshot.check_response("unknown", resp)
    assert snap["status"] == 404


def test_list_packs(client: ContractClient, snapshot: Snapshot) -> None:
    snap = snapshot.check_response("list", client.get("/api/packs"))
    assert snap["status"] == 200
