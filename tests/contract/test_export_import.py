"""Export/import family: full bundle, per-part slices, replace-mode import."""

from __future__ import annotations

from conftest import ContractClient, setup_workspace
from harness.snapshot import Snapshot


def test_export_full_and_part(client: ContractClient, snapshot: Snapshot) -> None:
    setup_workspace(client)

    resp = client.get("/api/export")
    snap = snapshot.check_response("export", resp)
    assert snap["status"] == 200
    bundle = resp.json()
    assert "candidate" in bundle and "targets" in bundle

    resp = client.get("/api/export/{part}", part="targets")
    snap = snapshot.check_response("export-part", resp)
    assert snap["status"] == 200

    resp = client.get("/api/export/{part}", part="nonsense")
    snap = snapshot.check_response("export-bad-part", resp)
    assert snap["status"] == 404


def test_import_roundtrip(client: ContractClient, snapshot: Snapshot) -> None:
    setup_workspace(client)
    bundle = client.get("/api/export").json()

    # wipe, then re-import the recorded bundle
    client.post("/api/test/reset")
    assert client.get("/api/state").json()["candidate"]["id"] == "none"

    resp = client.post("/api/import", json={"bundle": bundle, "confirm": "replace"})
    snap = snapshot.check_response("import", resp)
    assert snap["status"] == 200
    assert snap["body"]["ok"] is True
    assert snap["body"]["counts"]["candidate.profiles"] >= 1

    state = client.get("/api/state").json()
    assert state["candidate"]["id"] != "none"


def test_import_requires_confirm(client: ContractClient, snapshot: Snapshot) -> None:
    resp = client.post("/api/import", json={"bundle": {}})
    snap = snapshot.check_response("no-confirm", resp)
    assert snap["status"] == 400
    assert snap["body"]["error"]["code"] == "VALIDATION"


def test_import_invalid_bundle(client: ContractClient, snapshot: Snapshot) -> None:
    resp = client.post(
        "/api/import", json={"bundle": {"bogus": True}, "confirm": "replace"}
    )
    snap = snapshot.check_response("bad-bundle", resp)
    assert snap["status"] == 400
    assert snap["body"]["error"]["code"] == "VALIDATION"
