"""Targets family: list, add, activate, company-profile patch, role pack."""

from __future__ import annotations

from conftest import ContractClient, setup_workspace
from harness.snapshot import Snapshot

BOGUS = "tgt_00000000-0000-0000-0000-000000000000"


def _target_payload() -> dict:
    ex2 = {
        "jobDescription": "Senior platform engineer — Go, Kubernetes, Terraform.",
        "company": "Acme Infra",
        "role": "Platform Engineer",
        "level": "senior",
    }
    return ex2


def test_targets_empty_list(client: ContractClient, snapshot: Snapshot) -> None:
    snap = snapshot.check_response("empty", client.get("/api/targets"))
    assert snap["status"] == 200
    assert snap["body"] == [] or snap["body"] == {"targets": []}


def test_add_and_activate_target(client: ContractClient, snapshot: Snapshot) -> None:
    setup_workspace(client)
    first = client.get("/api/targets").json()
    assert len(first) == 1

    resp = client.post("/api/targets", json=_target_payload())
    snap = snapshot.check_response("add", resp)
    assert snap["status"] == 200
    added = resp.json()
    second_id = added["id"] if "id" in added else added["target"]["id"]

    listed = client.get("/api/targets").json()
    assert len(listed) == 2

    resp = client.post("/api/targets/{id}/activate", id=first[0]["id"])
    snap = snapshot.check_response("activate", resp)
    assert snap["status"] == 200

    resp = client.post("/api/targets/{id}/activate", id=second_id)
    snapshot.check_response("reactivate", resp)


def test_add_target_validation(client: ContractClient, snapshot: Snapshot) -> None:
    setup_workspace(client)
    resp = client.post("/api/targets", json={"company": "x"})
    snap = snapshot.check_response("invalid", resp)
    assert snap["status"] == 400
    assert snap["body"]["error"]["code"] == "VALIDATION"


def test_target_not_found(client: ContractClient, snapshot: Snapshot) -> None:
    resp = client.post("/api/targets/{id}/activate", id=BOGUS)
    snap = snapshot.check_response("activate-404", resp)
    assert snap["status"] == 404
    assert snap["body"]["error"]["code"] == "NOT_FOUND"

    resp = client.patch("/api/targets/{id}", id=BOGUS, json={"companyProfileId": "x"})
    snap = snapshot.check_response("patch-404", resp)
    assert snap["status"] == 404

    resp = client.put("/api/targets/{id}/role-pack", id=BOGUS, json={"rolePackId": None})
    snap = snapshot.check_response("rolepack-404", resp)
    assert snap["status"] == 404


def test_target_company_profile(client: ContractClient, snapshot: Snapshot) -> None:
    setup_workspace(client)
    tid = client.get("/api/targets").json()[0]["id"]
    resp = client.patch("/api/targets/{id}", id=tid, json={"companyProfileId": "stripe"})
    snap = snapshot.check_response("patch", resp)
    assert snap["status"] == 200

    resp = client.patch("/api/targets/{id}", id=tid, json={})
    snap = snapshot.check_response("patch-invalid", resp)
    assert snap["status"] == 400


def test_target_role_pack(client: ContractClient, snapshot: Snapshot) -> None:
    setup_workspace(client)
    tid = client.get("/api/targets").json()[0]["id"]
    resp = client.put(
        "/api/targets/{id}/role-pack", id=tid, json={"rolePackId": "backend-engineer"}
    )
    snap = snapshot.check_response("assign", resp)
    assert snap["status"] == 200

    resp = client.put("/api/targets/{id}/role-pack", id=tid, json={"rolePackId": None})
    snap = snapshot.check_response("clear", resp)
    assert snap["status"] == 200
