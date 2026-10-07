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


def test_settings_ai_budget(client: ContractClient, snapshot: Snapshot) -> None:
    snap = snapshot.check_response("budget-set", client.put("/api/settings", json={"aiBudgetMonthly": 25}))
    assert snap["status"] == 200
    assert snap["body"]["aiBudgetMonthly"] == 25

    resp = client.put("/api/settings", json={"aiBudgetMonthly": -1})
    snap = snapshot.check_response("budget-invalid", resp)
    assert snap["status"] == 400
    assert snap["body"]["error"]["code"] == "VALIDATION"

    snap = snapshot.check_response("budget-clear", client.put("/api/settings", json={"aiBudgetMonthly": None}))
    assert snap["body"].get("aiBudgetMonthly") is None
