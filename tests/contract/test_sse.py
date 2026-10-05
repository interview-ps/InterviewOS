"""SSE contract: ?stream=1 / Accept header, event sequence, disconnect."""

from __future__ import annotations

from conftest import ContractClient, load_example, setup_workspace, wait_for
from harness.normalize import default_normalizer
from harness.server import REPO_ROOT
from harness.snapshot import Snapshot


def _setup_payload(client: ContractClient) -> dict:
    ex = load_example(client)
    return {
        "resumeText": ex["resumeText"],
        "jobDescription": ex["jobDescription"],
        "company": ex["company"],
        "role": ex["role"],
        "level": ex["level"],
    }


def test_stream_events_shape(client: ContractClient, snapshot: Snapshot) -> None:
    payload = _setup_payload(client)
    with client.stream("POST", "/api/workspace/setup", json=payload) as stream:
        assert stream.status == 200
        t = stream.collect()
    assert t.error is None
    assert t.result is not None
    assert t.stages, "expected at least one stage event"
    snapshot.check("transcript", t.snapshot())
    # ping heartbeats are dropped by the transcript; no other event names
    # beyond the contract set.
    names = {e.event for e in t.events}
    assert names <= {"stage", "delta", "result", "error"}


def test_stream_via_accept_header(client: ContractClient) -> None:
    payload = _setup_payload(client)
    with client.stream(
        "POST",
        "/api/workspace/setup",
        json=payload,
        headers={"accept": "text/event-stream"},
    ) as stream:
        t = stream.collect()
    assert stream.status == 200
    assert t.result is not None and t.error is None


def test_streamed_result_matches_non_stream(
    client: ContractClient, snapshot: Snapshot
) -> None:
    """The streamed `result` event must carry the same JSON the plain
    endpoint returns — checked on two endpoints, each run fresh after reset."""
    payload = _setup_payload(client)

    # Endpoint 1: POST /api/workspace/setup
    # Each side gets its own Normalizer so generated ids map to #1..N in the
    # same order on both runs.
    plain = client.post("/api/workspace/setup", json=payload).json()
    client.post("/api/test/reset")
    with client.stream("POST", "/api/workspace/setup", json=payload) as stream:
        t = stream.collect()
    assert default_normalizer(REPO_ROOT).normalize(
        t.result
    ) == default_normalizer(REPO_ROOT).normalize(plain)

    # Endpoint 2: POST /api/interviews (needs a workspace)
    setup_workspace(client)
    plain = client.post("/api/interviews", json={"plannedQuestions": 1}).json()
    client.post("/api/test/reset")
    setup_workspace(client)
    with client.stream("POST", "/api/interviews", json={"plannedQuestions": 1}) as stream:
        t = stream.collect()
    assert default_normalizer(REPO_ROOT).normalize(
        t.result
    ) == default_normalizer(REPO_ROOT).normalize(plain)


def test_stream_error_event(client: ContractClient, snapshot: Snapshot) -> None:
    with client.stream(
        "POST",
        "/api/interviews/{id}/complete",
        path_params={"id": "int_00000000-0000-0000-0000-000000000000"},
    ) as stream:
        assert stream.status == 200  # stays 200 once streaming starts
        t = stream.collect()
    assert t.error is not None
    assert t.result is None
    snapshot.check("error", t.snapshot())
    assert t.error["code"] == "NOT_FOUND"


def test_disconnect_does_not_abort(client: ContractClient) -> None:
    """Closing the stream mid-operation must not cancel the mutation."""
    payload = _setup_payload(client)
    with client.stream("POST", "/api/workspace/setup", json=payload) as stream:
        assert stream.status == 200
        for _ in stream.events():  # got at least one event, then bail
            break
        stream.close()

    def profile_ready():
        state = client.get("/api/state").json()
        return state["candidate"]["id"] != "none"

    assert wait_for(profile_ready, timeout_s=30.0)
