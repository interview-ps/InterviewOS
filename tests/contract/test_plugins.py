"""Plugins family: list, enable/disable, run, UI routes, settings.

Install/uninstall live in test_installs.py on an isolated server (installed
plugin files + registry entries survive /api/test/reset).
"""

from __future__ import annotations

from conftest import ContractClient
from harness.snapshot import Snapshot

PG = "postgres-interviewer"
BOGUS = "no-such-plugin"


def test_list_plugins(client: ContractClient, snapshot: Snapshot) -> None:
    snap = snapshot.check_response("list", client.get("/api/plugins"))
    assert snap["status"] == 200
    ids = [p["manifest"]["id"] for p in snap["body"]["plugins"]]
    assert PG in ids
    assert "interview-day-checklist" in ids


def test_enable_disable(client: ContractClient, snapshot: Snapshot) -> None:
    resp = client.put("/api/plugins/{id}", id=PG, json={"enabled": False})
    snap = snapshot.check_response("disable", resp)
    assert snap["status"] == 200
    assert snap["body"]["plugin"]["enabled"] is False

    resp = client.put(
        "/api/plugins/{id}",
        id=PG,
        json={"enabled": True, "grantedPermissions": ["candidate.read", "target.read"]},
    )
    snap = snapshot.check_response("enable", resp)
    assert snap["status"] == 200
    assert snap["body"]["plugin"]["enabled"] is True

    resp = client.put("/api/plugins/{id}", id=BOGUS, json={"enabled": True})
    snap = snapshot.check_response("enable-404", resp)
    assert snap["status"] == 404

    resp = client.put("/api/plugins/{id}", id=PG, json={})
    snap = snapshot.check_response("enable-invalid", resp)
    assert snap["status"] == 400


def test_run_plugin(client: ContractClient, snapshot: Snapshot) -> None:
    resp = client.post("/api/plugins/{id}/run", id="interview-day-checklist")
    snap = snapshot.check_response("run", resp)
    assert snap["status"] == 200
    assert "output" in snap["body"]
    assert "evidenceWritten" in snap["body"]

    resp = client.post("/api/plugins/{id}/run", id=BOGUS)
    snap = snapshot.check_response("run-404", resp)
    assert snap["status"] == 404


def test_ui_render(client: ContractClient, snapshot: Snapshot) -> None:
    resp = client.post(
        "/api/plugins/{id}/ui/render",
        id=PG,
        json={"component": "readiness-card", "slot": "dashboard.cards"},
    )
    snap = snapshot.check_response("render", resp)
    assert snap["status"] == 200
    assert "ui" in snap["body"]

    resp = client.post("/api/plugins/{id}/ui/render", id=PG, json={})
    snap = snapshot.check_response("render-invalid", resp)
    assert snap["status"] == 400

    resp = client.post(
        "/api/plugins/{id}/ui/render", id=BOGUS, json={"component": "x"}
    )
    snap = snapshot.check_response("render-404", resp)
    assert snap["status"] in (404, 409)


def test_ui_frame(client: ContractClient, snapshot: Snapshot) -> None:
    resp = client.get(
        "/api/plugins/{id}/ui/frame",
        id=PG,
        params={"component": "postgres-skill-tree"},
    )
    snap = snapshot.check_response("frame", resp)
    assert snap["status"] == 200
    assert "<html" in snap["body"].lower() or "<!doctype" in snap["body"].lower()

    resp = client.get("/api/plugins/{id}/ui/frame", id=PG)
    snap = snapshot.check_response("frame-no-selector", resp)
    assert snap["status"] == 400
    assert snap["body"]["error"]["code"] == "VALIDATION"


def test_ui_assets(client: ContractClient, snapshot: Snapshot) -> None:
    resp = client.get(
        "/api/plugins/{id}/ui/assets/{path}", id=PG, path="index.js"
    )
    snap = snapshot.check_response("asset", resp)
    assert snap["status"] == 200

    resp = client.get(
        "/api/plugins/{id}/ui/assets/{path}", id=PG, path="missing.js"
    )
    snap = snapshot.check_response("asset-404", resp)
    assert snap["status"] == 404

    resp = client.get(
        "/api/plugins/{id}/ui/assets/{path}", id=PG, path="..%2F..%2Fsecret"
    )
    snap = snapshot.check_response("asset-escape", resp)
    assert snap["status"] == 400


def test_ui_data_and_run(client: ContractClient, snapshot: Snapshot) -> None:
    resp = client.post(
        "/api/plugins/{id}/ui/data",
        id=PG,
        json={"component": "postgres-skill-tree"},
    )
    snap = snapshot.check_response("data", resp)
    assert snap["status"] == 200
    assert "slices" in snap["body"]

    resp = client.post(
        "/api/plugins/{id}/ui/run",
        id=PG,
        json={
            "component": "postgres-skill-tree",
            "request": {"skillId": "sql", "count": 2},
        },
    )
    snap = snapshot.check_response("run", resp)
    assert snap["status"] == 200

    resp = client.post("/api/plugins/{id}/ui/data", id=PG, json={})
    snap = snapshot.check_response("data-invalid", resp)
    assert snap["status"] == 400

    resp = client.post("/api/plugins/{id}/ui/run", id=PG, json={})
    snap = snapshot.check_response("run-invalid", resp)
    assert snap["status"] == 400


def test_plugin_settings(client: ContractClient, snapshot: Snapshot) -> None:
    resp = client.get("/api/plugins/{id}/settings", id=PG)
    snap = snapshot.check_response("get", resp)
    assert snap["status"] == 200
    assert "fields" in snap["body"] and "values" in snap["body"]
    assert snap["body"]["values"]["difficulty-bias"] == "medium"

    resp = client.put(
        "/api/plugins/{id}/settings", id=PG, json={"values": {"difficulty-bias": "hard"}}
    )
    snap = snapshot.check_response("put", resp)
    assert snap["status"] == 200
    assert snap["body"]["values"]["difficulty-bias"] == "hard"

    # plugin_settings is NOT covered by /api/test/reset — restore the default
    # so later tests see a clean slate.
    client.put("/api/plugins/{id}/settings", id=PG, json={"values": {"difficulty-bias": "medium"}})

    resp = client.put(
        "/api/plugins/{id}/settings", id=PG, json={"values": {"difficulty-bias": "bogus"}}
    )
    snap = snapshot.check_response("put-invalid", resp)
    assert snap["status"] in (400, 422)

    resp = client.get("/api/plugins/{id}/settings", id=BOGUS)
    snap = snapshot.check_response("get-404", resp)
    assert snap["status"] == 404
