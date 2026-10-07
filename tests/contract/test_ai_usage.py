"""AI usage family: GET /api/ai-usage (provider usage telemetry).

Distinct from `/api/events` + `/api/metrics` (product analytics). The autouse
reset wipes `ai_usage` before each test, so the empty snapshot is deterministic;
the populated snapshot is curated to the fields that are stable run-to-run.
"""

from __future__ import annotations

from typing import Any

from conftest import ContractClient, setup_workspace
from harness.snapshot import Snapshot


def test_ai_usage_empty(client: ContractClient, snapshot: Snapshot) -> None:
    resp = client.get("/api/ai-usage")
    snap = snapshot.check_response("empty", resp)
    assert snap["status"] == 200
    body = snap["body"]
    assert body["totals"]["turns"] == 0
    assert body["totals"]["totalTokens"] == 0
    assert body["totals"]["cost"] == []
    assert body["byRuntime"] == []
    assert body["bySkill"] == []
    # nullable+unset fields are omitted by the serializer, like the rest of the API
    assert body.get("latestContext") is None
    assert body["recent"] == []
    assert body["filters"] == {}


def test_ai_usage_after_setup(client: ContractClient, snapshot: Snapshot) -> None:
    setup_workspace(client)
    resp = client.get("/api/ai-usage")
    body: dict[str, Any] = resp.json()
    assert resp.status_code == 200

    curated = {
        "turns": body["totals"]["turns"],
        "inputTokens": body["totals"]["inputTokens"],
        "outputTokens": body["totals"]["outputTokens"],
        "totalTokens": body["totals"]["totalTokens"],
        "cost": body["totals"]["cost"],
        "byRuntimeKeys": sorted(entry["key"] for entry in body["byRuntime"]),
        "bySkillKeys": sorted(entry["key"] for entry in body["bySkill"]),
        "byModelKeys": sorted(entry["key"] for entry in body["byModel"]),
        "latestContextSize": (
            None if body.get("latestContext") is None else body["latestContext"]["size"]
        ),
        "recentCount": len(body["recent"]),
        "filters": body["filters"],
    }
    snapshot.check("after-setup", {"status": 200, "body": curated})

    assert body["totals"]["turns"] > 0
    assert body["totals"]["totalTokens"] > 0
    assert all(entry["currency"] == "USD" for entry in body["totals"]["cost"])


def test_ai_usage_runtime_filter(client: ContractClient, snapshot: Snapshot) -> None:
    setup_workspace(client)
    resp = client.get("/api/ai-usage", params={"runtime": "opencode"})
    body: dict[str, Any] = resp.json()
    assert resp.status_code == 200
    # only the mock runtime has run, so the filter yields an empty summary
    snapshot.check(
        "runtime-filter",
        {"status": 200, "turns": body["totals"]["turns"], "byRuntime": body["byRuntime"]},
    )
    assert body["totals"]["turns"] == 0
    assert body["filters"]["runtime"] == "opencode"


def test_ai_usage_session_filter(client: ContractClient, snapshot: Snapshot) -> None:
    setup_workspace(client)
    resp = client.get("/api/ai-usage", params={"session": "nope"})
    body: dict[str, Any] = resp.json()
    assert resp.status_code == 200
    # no turn belongs to an interview session during setup
    snapshot.check(
        "session-filter",
        {"status": 200, "turns": body["totals"]["turns"], "byModel": body["byModel"]},
    )
    assert body["totals"]["turns"] == 0
    assert body["filters"]["session"] == "nope"


def test_ai_usage_clear(client: ContractClient, snapshot: Snapshot) -> None:
    setup_workspace(client)
    assert client.get("/api/ai-usage").json()["totals"]["turns"] > 0

    snap = snapshot.check_response("clear", client.delete("/api/ai-usage"))
    assert snap["status"] == 200
    assert snap["body"]["ok"] is True

    after: dict[str, Any] = client.get("/api/ai-usage").json()
    assert after["totals"]["turns"] == 0
    assert after["recent"] == []
