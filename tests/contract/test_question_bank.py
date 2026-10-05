"""Question-bank family: list/add/import/delete user questions."""

from __future__ import annotations

from conftest import ContractClient
from harness.snapshot import Snapshot

BOGUS = "uq_00000000-0000-0000-0000-000000000000"

BANK_YAML = """\
- skillId: sql.transactions
  text: "Walk me through how you would debug a serialization anomaly."
  difficulty: medium
  mode: technical
"""


def test_question_bank_lifecycle(client: ContractClient, snapshot: Snapshot) -> None:
    snap = snapshot.check_response("empty", client.get("/api/question-bank"))
    assert snap["status"] == 200

    resp = client.post(
        "/api/question-bank",
        json={
            "skillId": "sql.transactions",
            "text": "How does snapshot isolation differ from serializable?",
            "difficulty": "hard",
            "mode": "technical",
        },
    )
    snap = snapshot.check_response("add", resp)
    assert snap["status"] == 201
    qid = resp.json().get("id") or resp.json().get("question", {}).get("id")
    assert qid

    snap = snapshot.check_response("list", client.get("/api/question-bank"))
    assert len(snap["body"]) >= 1 or len(snap["body"].get("questions", [])) >= 1

    resp = client.delete("/api/question-bank/{id}", id=qid)
    snap = snapshot.check_response("delete", resp)
    assert snap["status"] == 200


def test_add_validation(client: ContractClient, snapshot: Snapshot) -> None:
    resp = client.post("/api/question-bank", json={"skillId": "sql", "text": "short"})
    snap = snapshot.check_response("invalid", resp)
    assert snap["status"] == 400
    assert snap["body"]["error"]["code"] == "VALIDATION"


def test_import(client: ContractClient, snapshot: Snapshot) -> None:
    resp = client.post("/api/question-bank/import", json={"content": BANK_YAML})
    snap = snapshot.check_response("import", resp)
    assert snap["status"] == 201

    resp = client.post("/api/question-bank/import", json={"content": "\x00bad"})
    snap = snapshot.check_response("import-bad", resp)
    assert snap["status"] == 400


def test_delete_not_found(client: ContractClient, snapshot: Snapshot) -> None:
    resp = client.delete("/api/question-bank/{id}", id=BOGUS)
    snap = snapshot.check_response("delete", resp)
    assert snap["status"] == 404
