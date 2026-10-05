"""Resume family: review (streamed) + latest review."""

from __future__ import annotations

from conftest import ContractClient, setup_workspace
from harness.snapshot import Snapshot


def test_resume_review_flow(client: ContractClient, snapshot: Snapshot) -> None:
    setup_workspace(client)
    resp = client.post("/api/resume/review")
    snap = snapshot.check_response("review", resp)
    assert snap["status"] == 200

    snap = snapshot.check_response("latest", client.get("/api/resume/reviews/latest"))
    assert snap["status"] == 200
    assert snap["body"] is not None


def test_latest_review_empty(client: ContractClient, snapshot: Snapshot) -> None:
    snap = snapshot.check_response("empty", client.get("/api/resume/reviews/latest"))
    assert snap["status"] in (200, 404)
