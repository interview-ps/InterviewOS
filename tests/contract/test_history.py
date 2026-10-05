"""History family: session list + per-session detail."""

from __future__ import annotations

from conftest import ContractClient, run_session_to_debrief, setup_workspace
from harness.snapshot import Snapshot

BOGUS = "int_00000000-0000-0000-0000-000000000000"


def test_history(client: ContractClient, snapshot: Snapshot) -> None:
    setup_workspace(client)
    sid = client.post("/api/interviews", json={"plannedQuestions": 1}).json()["session"][
        "id"
    ]
    run_session_to_debrief(client, sid)

    snap = snapshot.check_response("list", client.get("/api/history"))
    assert snap["status"] == 200

    snap = snapshot.check_response(
        "filtered", client.get("/api/history", params={"weakOnly": "1"})
    )
    assert snap["status"] == 200

    snap = snapshot.check_response(
        "detail", client.get("/api/history/{id}", id=sid)
    )
    assert snap["status"] == 200


def test_history_not_found(client: ContractClient, snapshot: Snapshot) -> None:
    snap = snapshot.check_response("detail", client.get("/api/history/{id}", id=BOGUS))
    assert snap["status"] == 404
