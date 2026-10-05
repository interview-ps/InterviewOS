"""Workspace / analysis / state family + the test-only reset endpoint."""

from __future__ import annotations

from conftest import ContractClient, load_example, setup_workspace
from harness.snapshot import Snapshot


def test_setup_happy_path(client: ContractClient, snapshot: Snapshot) -> None:
    body = setup_workspace(client)
    assert body["gaps"], "setup should produce gaps"
    assert body["actions"], "setup should produce prep actions"
    snap = snapshot.check_response("state", client.get("/api/state"))
    assert snap["status"] == 200
    state = snap["body"]
    assert state["candidate"]["id"] != "none"
    assert state["target"]["id"] != "none"
    assert "readiness" in state and "preparation" in state


def test_setup_validation(client: ContractClient, snapshot: Snapshot) -> None:
    ex = load_example(client)
    payload = {
        "resumeText": ex["resumeText"],
        "jobDescription": ex["jobDescription"],
        "company": ex["company"],
        "role": ex["role"],
        "level": "principal",  # not in the enum
    }
    resp = client.post("/api/workspace/setup", json=payload)
    snap = snapshot.check_response("bad-level", resp)
    assert snap["status"] == 400
    assert snap["body"]["error"]["code"] == "VALIDATION"

    resp = client.post("/api/workspace/setup", json={})
    snap = snapshot.check_response("empty", resp)
    assert snap["status"] == 400
    assert snap["body"]["error"]["code"] == "VALIDATION"


def test_setup_non_json_body(client: ContractClient, snapshot: Snapshot) -> None:
    resp = client.post(
        "/api/workspace/setup",
        content=b"not json",
        headers={"content-type": "application/json"},
    )
    snap = snapshot.check_response("non-json", resp)
    assert snap["status"] == 400
    assert snap["body"]["error"]["code"] == "VALIDATION"


def test_analysis_resume(client: ContractClient, snapshot: Snapshot) -> None:
    ex = load_example(client)
    resp = client.post("/api/analysis/resume", json={"resumeText": ex["resumeText"]})
    snap = snapshot.check_response("resume", resp)
    assert snap["status"] == 200
    assert "skills" in snap["body"] or "evidence" in snap["body"]

    resp = client.post("/api/analysis/resume", json={"resumeText": ""})
    snap = snapshot.check_response("resume-empty", resp)
    assert snap["status"] == 400
    assert snap["body"]["error"]["code"] == "VALIDATION"


def test_analysis_job(client: ContractClient, snapshot: Snapshot) -> None:
    ex = load_example(client)
    resp = client.post(
        "/api/analysis/job",
        json={
            "jobDescription": ex["jobDescription"],
            "company": ex["company"],
            "role": ex["role"],
            "level": ex["level"],
        },
    )
    snap = snapshot.check_response("job", resp)
    assert snap["status"] == 200
    assert snap["body"]["company"] == ex["company"]

    resp = client.post("/api/analysis/job", json={"jobDescription": "x"})
    snap = snapshot.check_response("job-invalid", resp)
    assert snap["status"] == 400


def test_analysis_gaps(client: ContractClient, workspace, snapshot: Snapshot) -> None:
    resp = client.post("/api/analysis/gaps")
    snap = snapshot.check_response("gaps", resp)
    assert snap["status"] == 200
    assert isinstance(snap["body"], (list, dict))


def test_state_empty_then_filled(client: ContractClient, snapshot: Snapshot) -> None:
    snap = snapshot.check_response("state-empty", client.get("/api/state"))
    assert snap["status"] == 200
    assert snap["body"]["candidate"]["id"] == "none"
    setup_workspace(client)
    snap = snapshot.check_response("state-filled", client.get("/api/state"))
    assert snap["body"]["candidate"]["id"] != "none"


def test_reset_endpoint(client: ContractClient, snapshot: Snapshot) -> None:
    setup_workspace(client)
    resp = client.post("/api/test/reset")
    snap = snapshot.check_response("reset", resp)
    assert snap["status"] == 200
    state = client.get("/api/state").json()
    assert state["candidate"]["id"] == "none"
    assert state["target"]["id"] == "none"


def test_body_limit(client: ContractClient, snapshot: Snapshot) -> None:
    # apiBodyLimit: 200 KB. Chunked (no Content-Length) so the server reads the
    # stream to the limit instead of rejecting on the header mid-upload.
    resp = client.post(
        "/api/analysis/resume",
        content=iter([b'{"resumeText": "' + b"x" * 210_000 + b'"}']),
        headers={"content-type": "application/json"},
    )
    snap = snapshot.check_response("too-large", resp)
    assert snap["status"] == 413
    assert snap["body"]["error"]["code"] == "TOO_LARGE"
