"""Preparation family: plan list, recalculate, action patch/complete,
plugin suggestions + resources."""

from __future__ import annotations

from conftest import ContractClient, setup_workspace
from harness.snapshot import Snapshot

BOGUS = "act_00000000-0000-0000-0000-000000000000"


def test_preparation_list(client: ContractClient, snapshot: Snapshot) -> None:
    setup_workspace(client)
    snap = snapshot.check_response("list", client.get("/api/preparation"))
    assert snap["status"] == 200
    assert "nextActions" in snap["body"] and "actions" in snap["body"]
    assert snap["body"]["actions"], "setup should produce prep actions"


def test_recalculate(client: ContractClient, snapshot: Snapshot) -> None:
    setup_workspace(client)
    snap = snapshot.check_response("recalc", client.post("/api/preparation/recalculate"))
    assert snap["status"] == 200


def test_action_patch_and_complete(client: ContractClient, snapshot: Snapshot) -> None:
    setup_workspace(client)
    action = client.get("/api/preparation").json()["actions"][0]

    resp = client.patch(
        "/api/preparation/{id}", id=action["id"], json={"status": "in_progress"}
    )
    snap = snapshot.check_response("patch", resp)
    assert snap["status"] == 200

    # checkedCriteria must match the action's declared successCriteria.
    criteria = action.get("successCriteria") or []
    resp = client.post(
        "/api/preparation/{id}/complete",
        id=action["id"],
        json={"checkedCriteria": criteria[:1]},
    )
    snap = snapshot.check_response("complete", resp)
    assert snap["status"] == 200

    resp = client.post(
        "/api/preparation/{id}/complete",
        id=action["id"],
        json={"checkedCriteria": ["not a real criterion"]},
    )
    snap = snapshot.check_response("complete-bad-criteria", resp)
    assert snap["status"] == 400


def test_action_validation_and_404(client: ContractClient, snapshot: Snapshot) -> None:
    setup_workspace(client)
    action = client.get("/api/preparation").json()["actions"][0]

    resp = client.patch("/api/preparation/{id}", id=action["id"], json={"status": "nope"})
    snap = snapshot.check_response("bad-status", resp)
    assert snap["status"] == 400
    assert snap["body"]["error"]["code"] == "VALIDATION"

    # quirk: PATCH on a nonexistent action returns 200 {ok:true} — the
    # service updates without an existence check (worth noting for the port).
    resp = client.patch("/api/preparation/{id}", id=BOGUS, json={"status": "done"})
    snap = snapshot.check_response("patch-unknown", resp)
    assert snap["status"] == 200

    resp = client.post("/api/preparation/{id}/complete", id=BOGUS, json={})
    snap = snapshot.check_response("complete-404", resp)
    assert snap["status"] == 404


def test_suggestions_and_accept(client: ContractClient, snapshot: Snapshot) -> None:
    setup_workspace(client)
    resp = client.get("/api/preparation/suggestions")
    snap = snapshot.check_response("suggestions", resp)
    assert snap["status"] == 200
    suggestions = resp.json()["suggestions"]

    if suggestions:
        s = suggestions[0]
        resp = client.post(
            "/api/preparation/suggestions/accept",
            json={"pluginId": s["pluginId"], "activity": s["activities"][0]},
        )
        snap = snapshot.check_response("accept", resp)
        assert snap["status"] == 200

    resp = client.post(
        "/api/preparation/suggestions/accept",
        json={"pluginId": "no-such-plugin", "activity": {}},
    )
    snap = snapshot.check_response("accept-unknown", resp)
    assert snap["status"] in (400, 404, 409)


def test_action_resources(client: ContractClient, snapshot: Snapshot) -> None:
    setup_workspace(client)
    action = client.get("/api/preparation").json()["actions"][0]
    resp = client.post("/api/preparation/{id}/resources", id=action["id"])
    snap = snapshot.check_response("resources", resp)
    assert snap["status"] == 200
