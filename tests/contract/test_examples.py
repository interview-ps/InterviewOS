"""Examples family: bundled example listing + fetch."""

from __future__ import annotations

from conftest import ContractClient
from harness.snapshot import Snapshot


def test_list_examples(client: ContractClient, snapshot: Snapshot) -> None:
    snap = snapshot.check_response("list", client.get("/api/examples"))
    assert snap["status"] == 200
    assert "backend-engineer" in snap["body"]


def test_get_example(client: ContractClient, snapshot: Snapshot) -> None:
    resp = client.get("/api/examples/{name}", name="backend-engineer")
    snap = snapshot.check_response("backend-engineer", resp)
    assert snap["status"] == 200
    assert snap["body"]["company"]
    assert len(snap["body"]["resumeText"]) > 0


def test_example_not_found(client: ContractClient, snapshot: Snapshot) -> None:
    resp = client.get("/api/examples/{name}", name="no-such-example")
    snap = snapshot.check_response("missing", resp)
    assert snap["status"] == 404
    assert snap["body"]["error"]["code"] == "NOT_FOUND"

    resp = client.get("/api/examples/{name}", name="..escape..")
    snap = snapshot.check_response("bad-name", resp)
    assert snap["status"] == 404
