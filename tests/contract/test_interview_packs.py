"""Interview-packs family: list/create/import/export/delete/start."""

from __future__ import annotations

from conftest import ContractClient, setup_workspace
from harness.snapshot import Snapshot

BOGUS = "ipack_00000000-0000-0000-0000-000000000000"

PACK_BODY = {
    "name": "Contract Pack",
    "description": "Two-round pack created by the contract suite.",
    "skills": ["sql", "apis"],
    "rounds": [
        {"mode": "technical", "label": "Tech", "plannedQuestions": 1},
        {"mode": "behavioral", "label": "Behav", "plannedQuestions": 1},
    ],
    "durationMinutes": 45,
}

PACK_YAML = """\
format: interview-os.interview-pack
id: contract-imported
name: Contract Imported Pack
version: 1.0.0
description: Imported via the contract suite.
skills:
  - sql
rounds:
  - mode: technical
    label: Tech
    plannedQuestions: 1
  - mode: behavioral
    label: Behav
    plannedQuestions: 1
durationMinutes: 30
"""


def test_list_bundled(client: ContractClient, snapshot: Snapshot) -> None:
    snap = snapshot.check_response("list", client.get("/api/interview-packs"))
    assert snap["status"] == 200
    ids = [p.get("id") or p.get("pack", {}).get("id") for p in snap["body"]]
    assert "senior-backend" in ids


def test_create_export_delete(client: ContractClient, snapshot: Snapshot) -> None:
    resp = client.post("/api/interview-packs", json=PACK_BODY)
    snap = snapshot.check_response("create", resp)
    assert snap["status"] == 201
    pack_id = resp.json().get("id") or resp.json().get("pack", {}).get("id")
    assert pack_id

    resp = client.get("/api/interview-packs/{id}/export", id=pack_id)
    snap = snapshot.check_response("export", resp)
    assert snap["status"] == 200
    assert "interview-os.interview-pack" in resp.text

    resp = client.delete("/api/interview-packs/{id}", id=pack_id)
    snap = snapshot.check_response("delete", resp)
    assert snap["status"] == 200


def test_import(client: ContractClient, snapshot: Snapshot) -> None:
    resp = client.post("/api/interview-packs/import", json={"content": PACK_YAML})
    snap = snapshot.check_response("import", resp)
    assert snap["status"] == 201

    resp = client.post("/api/interview-packs/import", json={"content": "not: [valid"})
    snap = snapshot.check_response("import-bad", resp)
    assert snap["status"] == 400


def test_create_validation(client: ContractClient, snapshot: Snapshot) -> None:
    resp = client.post("/api/interview-packs", json={"name": "x"})
    snap = snapshot.check_response("invalid", resp)
    assert snap["status"] == 400
    assert snap["body"]["error"]["code"] == "VALIDATION"


def test_not_found(client: ContractClient, snapshot: Snapshot) -> None:
    snap = snapshot.check_response(
        "export", client.get("/api/interview-packs/{id}/export", id=BOGUS)
    )
    assert snap["status"] == 404
    snap = snapshot.check_response(
        "delete", client.delete("/api/interview-packs/{id}", id=BOGUS)
    )
    assert snap["status"] == 404
    snap = snapshot.check_response(
        "start", client.post("/api/interview-packs/{id}/start", id=BOGUS)
    )
    assert snap["status"] == 404


def test_start_loop_from_pack(client: ContractClient, snapshot: Snapshot) -> None:
    setup_workspace(client)
    resp = client.post(
        "/api/interview-packs",
        json={
            "name": "Startable",
            "skills": ["sql"],
            "rounds": [
                {"mode": "technical", "label": "Tech", "plannedQuestions": 1},
                {"mode": "behavioral", "label": "Behav", "plannedQuestions": 1},
            ],
            "durationMinutes": 30,
        },
    )
    pack_id = resp.json().get("id") or resp.json().get("pack", {}).get("id")
    resp = client.post("/api/interview-packs/{id}/start", id=pack_id)
    snap = snapshot.check_response("start", resp)
    assert snap["status"] == 200
    body = resp.json()
    assert "loop" in body or "session" in body
