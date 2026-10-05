"""Stories family: STAR story list/generate/patch/coach."""

from __future__ import annotations

from conftest import ContractClient, setup_workspace
from harness.snapshot import Snapshot

BOGUS = "story_00000000-0000-0000-0000-000000000000"


def test_stories_flow(client: ContractClient, snapshot: Snapshot) -> None:
    setup_workspace(client)
    snap = snapshot.check_response("empty", client.get("/api/stories"))
    assert snap["status"] == 200

    resp = client.post("/api/stories/generate")
    snap = snapshot.check_response("generate", resp)
    assert snap["status"] == 200

    stories = client.get("/api/stories").json()
    assert stories, "generate should produce at least one story"
    story_id = stories[0]["id"]

    resp = client.patch(
        "/api/stories/{id}", id=story_id, json={"title": "Retitled story"}
    )
    snap = snapshot.check_response("patch", resp)
    assert snap["status"] == 200

    resp = client.post("/api/stories/{id}/coach", id=story_id)
    snap = snapshot.check_response("coach", resp)
    assert snap["status"] == 200


def test_story_not_found(client: ContractClient, snapshot: Snapshot) -> None:
    resp = client.patch("/api/stories/{id}", id=BOGUS, json={"title": "x"})
    snap = snapshot.check_response("patch", resp)
    assert snap["status"] == 404

    # quirk: coach checks for an active profile before the story id —
    # without a workspace it is 409 NO_ACTIVE_PROFILE, not 404.
    resp = client.post("/api/stories/{id}/coach", id=BOGUS)
    snap = snapshot.check_response("coach-no-profile", resp)
    assert snap["status"] == 409
    assert snap["body"]["error"]["code"] == "NO_ACTIVE_PROFILE"

    setup_workspace(client)
    resp = client.post("/api/stories/{id}/coach", id=BOGUS)
    snap = snapshot.check_response("coach-404", resp)
    assert snap["status"] == 404


def test_story_patch_validation(client: ContractClient, snapshot: Snapshot) -> None:
    setup_workspace(client)
    client.post("/api/stories/generate")
    story_id = client.get("/api/stories").json()[0]["id"]
    resp = client.patch("/api/stories/{id}", id=story_id, json={"title": ""})
    snap = snapshot.check_response("bad-title", resp)
    assert snap["status"] == 400
    assert snap["body"]["error"]["code"] == "VALIDATION"
