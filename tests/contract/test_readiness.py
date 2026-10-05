"""Readiness family: graph + per-skill detail."""

from __future__ import annotations

from conftest import ContractClient, setup_workspace
from harness.snapshot import Snapshot


def test_readiness_after_setup(client: ContractClient, snapshot: Snapshot) -> None:
    setup_workspace(client)
    snap = snapshot.check_response("graph", client.get("/api/readiness"))
    assert snap["status"] == 200
    assert "dimensions" in snap["body"]
    assert "python" in snap["body"]["dimensions"]


def test_skill_detail(client: ContractClient, snapshot: Snapshot) -> None:
    setup_workspace(client)
    snap = snapshot.check_response(
        "detail", client.get("/api/readiness/{skillId}", skillId="sql")
    )
    assert snap["status"] == 200


def test_skill_detail_unknown(client: ContractClient, snapshot: Snapshot) -> None:
    setup_workspace(client)
    resp = client.get("/api/readiness/{skillId}", skillId="no-such-skill")
    snap = snapshot.check_response("unknown", resp)
    assert snap["status"] in (200, 404)
