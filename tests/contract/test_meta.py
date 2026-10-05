"""Small read-only families: skills, modes, companies, platform, usage, ui."""

from __future__ import annotations

from conftest import ContractClient
from harness.snapshot import Snapshot


def test_skills(client: ContractClient, snapshot: Snapshot) -> None:
    snap = snapshot.check_response("skills", client.get("/api/skills"))
    assert snap["status"] == 200
    assert "skills" in snap["body"]
    assert "pluginErrors" in snap["body"]


def test_modes(client: ContractClient, snapshot: Snapshot) -> None:
    snap = snapshot.check_response("modes", client.get("/api/modes"))
    assert snap["status"] == 200
    ids = [m["id"] for m in snap["body"]["modes"]]
    for expected in ("technical", "behavioral", "coding", "system_design"):
        assert expected in ids, f"mode {expected} missing"


def test_companies(client: ContractClient, snapshot: Snapshot) -> None:
    snap = snapshot.check_response("companies", client.get("/api/companies"))
    assert snap["status"] == 200


def test_platform(client: ContractClient, snapshot: Snapshot) -> None:
    snap = snapshot.check_response("platform", client.get("/api/platform"))
    assert snap["status"] == 200


def test_usage(client: ContractClient, snapshot: Snapshot) -> None:
    # NB: the usage router mounts at /api — paths are /api/events + /api/metrics.
    # only allowlisted event names are accepted
    resp = client.post("/api/events", json={"event": "palette.used"})
    snap = snapshot.check_response("event", resp)
    assert snap["status"] == 200
    assert snap["body"]["ok"] is True

    snap = snapshot.check_response("metrics", client.get("/api/metrics"))
    assert snap["status"] == 200

    resp = client.post("/api/events", json={"event": ""})
    snap = snapshot.check_response("event-invalid", resp)
    assert snap["status"] == 400


def test_ui_contributions(client: ContractClient, snapshot: Snapshot) -> None:
    snap = snapshot.check_response("contributions", client.get("/api/ui/contributions"))
    assert snap["status"] == 200
    assert "contributions" in snap["body"]


def test_ui_runtime_files(client: ContractClient, snapshot: Snapshot) -> None:
    resp = client.get("/api/ui/runtime/{file}", file="plugin-runtime.js")
    snap = snapshot.check_response("runtime-js", resp)
    # 200 when packages/ui runtime bundle is built; 503 otherwise.
    assert snap["status"] in (200, 503)

    resp = client.get("/api/ui/runtime/{file}", file="nope.js")
    snap = snapshot.check_response("runtime-404", resp)
    assert snap["status"] == 404
    assert snap["body"]["error"]["code"] == "NOT_FOUND"
