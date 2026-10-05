"""Interviews family: full lifecycle start → answer → next → complete → debrief."""

from __future__ import annotations

from conftest import ContractClient, run_session_to_debrief, setup_workspace
from harness.snapshot import Snapshot

BOGUS = "int_00000000-0000-0000-0000-000000000000"


def test_interview_lifecycle(client: ContractClient, snapshot: Snapshot) -> None:
    setup_workspace(client)

    resp = client.post("/api/interviews", json={"plannedQuestions": 2})
    snap = snapshot.check_response("start", resp)
    assert snap["status"] == 200
    session_id = resp.json()["session"]["id"]
    assert resp.json()["session"]["status"] in ("question", "ready")

    resp = client.get("/api/interviews/{id}", id=session_id)
    snap = snapshot.check_response("get", resp)
    assert resp.json()["session"]["id"].startswith("int_")
    assert resp.json()["session"]["id"] == session_id
    assert resp.json()["questions"], "GET should return the session's questions"

    resp = client.post(
        "/api/interviews/{id}/answer",
        id=session_id,
        json={
            "answer": "I would put Redis in front of the database using "
            "cache-aside so reads are fast."
        },
    )
    snap = snapshot.check_response("answer", resp)
    assert snap["status"] == 200
    assert "evaluation" in snap["body"]

    resp = client.post("/api/interviews/{id}/next", id=session_id)
    snap = snapshot.check_response("next", resp)
    assert snap["status"] == 200

    run_session_to_debrief(client, session_id)

    cur = client.get("/api/interviews/{id}", id=session_id).json()
    assert cur["session"]["status"] == "debrief"

    snap = snapshot.check_response(
        "debrief", client.get("/api/interviews/{id}/debrief", id=session_id)
    )
    assert snap["status"] == 200
    assert "summary" in snap["body"] or "strengths" in snap["body"]

    resp = client.get("/api/interviews")
    snapshot.check_response("list", resp)
    assert any(s["id"] == session_id for s in resp.json())


def test_interview_start_validation(client: ContractClient, snapshot: Snapshot) -> None:
    resp = client.post("/api/interviews", json={"plannedQuestions": "many"})
    snap = snapshot.check_response("bad-type", resp)
    assert snap["status"] == 400
    assert snap["body"]["error"]["code"] == "VALIDATION"

    setup_workspace(client)
    resp = client.post("/api/interviews", json={"mode": "not-a-mode"})
    snap = snapshot.check_response("bad-mode", resp)
    assert snap["status"] == 400
    assert snap["body"]["error"]["code"] == "VALIDATION"


def test_interview_not_found(client: ContractClient, snapshot: Snapshot) -> None:
    for label, resp in [
        ("get", client.get("/api/interviews/{id}", id=BOGUS)),
        ("next", client.post("/api/interviews/{id}/next", id=BOGUS)),
        (
            "answer",
            client.post("/api/interviews/{id}/answer", id=BOGUS, json={"answer": "hi"}),
        ),
        ("complete", client.post("/api/interviews/{id}/complete", id=BOGUS)),
        ("debrief", client.get("/api/interviews/{id}/debrief", id=BOGUS)),
    ]:
        snap = snapshot.check_response(label, resp)
        assert snap["status"] == 404, f"{label}: {snap}"
        assert snap["body"]["error"]["code"] == "NOT_FOUND"


def test_answer_validation(client: ContractClient, snapshot: Snapshot) -> None:
    setup_workspace(client)
    session_id = client.post("/api/interviews", json={"plannedQuestions": 1}).json()[
        "session"
    ]["id"]
    resp = client.post(
        "/api/interviews/{id}/answer", id=session_id, json={"answer": 42}
    )
    snap = snapshot.check_response("bad-answer", resp)
    assert snap["status"] == 400
    assert snap["body"]["error"]["code"] == "VALIDATION"


def test_debrief_before_complete(client: ContractClient, snapshot: Snapshot) -> None:
    setup_workspace(client)
    session_id = client.post("/api/interviews", json={"plannedQuestions": 1}).json()[
        "session"
    ]["id"]
    resp = client.get("/api/interviews/{id}/debrief", id=session_id)
    snap = snapshot.check_response("no-debrief", resp)
    assert snap["status"] == 404
    assert snap["body"]["error"]["code"] == "NOT_FOUND"


def test_answer_after_complete(client: ContractClient, snapshot: Snapshot) -> None:
    setup_workspace(client)
    session_id = client.post("/api/interviews", json={"plannedQuestions": 1}).json()[
        "session"
    ]["id"]
    run_session_to_debrief(client, session_id)
    resp = client.post(
        "/api/interviews/{id}/answer", id=session_id, json={"answer": "too late"}
    )
    snap = snapshot.check_response("late-answer", resp)
    # completed/debriefed sessions reject further answers
    assert snap["status"] in (400, 404, 409)
