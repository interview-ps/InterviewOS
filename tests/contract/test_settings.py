"""Settings family: get/put."""

from __future__ import annotations

from conftest import ContractClient
from harness.snapshot import Snapshot


def test_settings_roundtrip(client: ContractClient, snapshot: Snapshot) -> None:
    snap = snapshot.check_response("get", client.get("/api/settings"))
    assert snap["status"] == 200

    resp = client.put(
        "/api/settings", json={"model": "mock", "reasoningEffort": "low"}
    )
    snap = snapshot.check_response("put", resp)
    assert snap["status"] == 200
    assert snap["body"]["model"] == "mock"


def test_settings_validation(client: ContractClient, snapshot: Snapshot) -> None:
    resp = client.put("/api/settings", json={"reasoningEffort": "extreme"})
    snap = snapshot.check_response("bad-effort", resp)
    assert snap["status"] == 400
    assert snap["body"]["error"]["code"] == "VALIDATION"
