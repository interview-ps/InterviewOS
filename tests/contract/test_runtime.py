"""Runtime family: models/status/check/available/switch."""

from __future__ import annotations

from conftest import ContractClient
from harness.snapshot import Snapshot


def test_runtime_status(client: ContractClient, snapshot: Snapshot) -> None:
    snap = snapshot.check_response("status", client.get("/api/runtime/status"))
    assert snap["status"] == 200
    assert snap["body"]["mode"] == "mock"
    assert snap["body"]["available"] is True

    snap = snapshot.check_response("check", client.post("/api/runtime/check"))
    assert snap["status"] == 200


def test_runtime_models(client: ContractClient, snapshot: Snapshot) -> None:
    snap = snapshot.check_response("models", client.get("/api/runtime/models"))
    assert snap["status"] == 200
    assert snap["body"][0]["id"] == "mock"


def test_runtime_available(client: ContractClient, snapshot: Snapshot) -> None:
    resp = client.get("/api/runtime/available")
    body = snapshot.normalizer.normalize(resp.json())
    # Availability and probe results depend on which CLIs are installed on the
    # machine running the suite — mask them so the fixture holds on a dev box
    # with all four providers installed and on a bare CI runner with none.
    for p in body["providers"]:
        for env_key in ("executable", "version", "message", "available", "status"):
            if env_key in p:
                p[env_key] = "<env>"
    snapshot.check("available", {"status": resp.status_code, "body": body})
    assert resp.status_code == 200
    assert body["active"] == "mock"
    providers = {p["runtime"] for p in body["providers"]}
    assert "mock" in providers


def test_runtime_switch_same_kind(client: ContractClient, snapshot: Snapshot) -> None:
    resp = client.put("/api/runtime", json={"kind": "mock"})
    snap = snapshot.check_response("switch-mock", resp)
    assert snap["status"] == 200
    assert snap["body"]["mode"] == "mock"


def test_runtime_switch_unknown(client: ContractClient, snapshot: Snapshot) -> None:
    resp = client.put("/api/runtime", json={"kind": "bogus-runtime"})
    snap = snapshot.check_response("switch-unknown", resp)
    assert snap["status"] == 400
    assert snap["body"]["error"]["code"] == "VALIDATION"

    resp = client.put("/api/runtime", json={})
    snap = snapshot.check_response("switch-missing", resp)
    assert snap["status"] == 400
