"""Loops family: multi-round interview loops."""

from __future__ import annotations

from conftest import ContractClient, setup_workspace
from harness.snapshot import Snapshot

BOGUS = "loop_00000000-0000-0000-0000-000000000000"


def test_loop_lifecycle(client: ContractClient, snapshot: Snapshot) -> None:
    setup_workspace(client)
    resp = client.post(
        "/api/loops",
        json={
            "rounds": [
                {"mode": "technical", "plannedQuestions": 1},
                {"mode": "behavioral", "plannedQuestions": 1},
            ]
        },
    )
    snap = snapshot.check_response("start", resp)
    assert snap["status"] == 200
    loop_id = resp.json()["loop"]["id"]

    resp = client.get("/api/loops")
    snapshot.check_response("list", resp)
    assert any(item["id"] == loop_id for item in resp.json())

    snap = snapshot.check_response("get", client.get("/api/loops/{id}", id=loop_id))
    assert snap["body"]["id"] == "<loop#1>"  # GET returns the loop unwrapped

    resp = client.post("/api/loops/{id}/abandon", id=loop_id)
    snap = snapshot.check_response("abandon", resp)
    assert snap["status"] == 200


def test_loop_validation(client: ContractClient, snapshot: Snapshot) -> None:
    setup_workspace(client)
    # rounds must have >= 2 entries
    resp = client.post("/api/loops", json={"rounds": [{"mode": "technical"}]})
    snap = snapshot.check_response("too-few-rounds", resp)
    assert snap["status"] == 400
    assert snap["body"]["error"]["code"] == "VALIDATION"


def test_loop_not_found(client: ContractClient, snapshot: Snapshot) -> None:
    snap = snapshot.check_response("get", client.get("/api/loops/{id}", id=BOGUS))
    assert snap["status"] == 404
    snap = snapshot.check_response(
        "abandon", client.post("/api/loops/{id}/abandon", id=BOGUS)
    )
    assert snap["status"] == 404
