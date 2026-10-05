"""StoryService: STAR story generation, edits and coaching on the mock runtime."""

from __future__ import annotations

import pytest

from interview_os.core.models import AppError
from interview_os.orchestrator.context import WorkflowContext
from interview_os.orchestrator.services.story import StoryPatch, StoryService
from interview_os.skills.prepare.star_coach import StarCoachReviewOutput


async def test_generate_dedupes_by_title(ctx: WorkflowContext, workspace: object) -> None:
    service = StoryService(ctx)
    assert await service.list_stories() == []

    first = await service.generate_stories()
    assert first.created == 4
    assert len(first.stories) == 4
    assert all(story.source == "generated" for story in first.stories)
    assert all(story.candidate_id == "cand_test" for story in first.stories)
    titles = {story.title for story in first.stories}
    assert "Acme: Built the billing service in Go and PostgreSQL" in titles

    second = await service.generate_stories()
    assert second.created == 0
    assert len(second.stories) == 4


async def test_update_story_marks_it_user_owned(ctx: WorkflowContext, workspace: object) -> None:
    service = StoryService(ctx)
    story = (await service.generate_stories()).stories[0]

    updated = await service.update_story(
        story.id,
        StoryPatch(title="Rewritten", result="Cut latency by 40%"),
    )
    assert updated is not None
    assert updated.title == "Rewritten"
    assert updated.result == "Cut latency by 40%"
    assert updated.source == "user"
    assert updated.situation == story.situation

    untouched = await service.update_story(story.id, StoryPatch())
    assert untouched is not None
    assert untouched.title == "Rewritten"
    assert untouched.source == "user"

    with pytest.raises(AppError) as error:
        await service.update_story("story_missing", StoryPatch(title="x"))
    assert error.value.code == "NOT_FOUND"
    assert error.value.args[0] == "no story story_missing"


async def test_coach_story_reports_placeholders(ctx: WorkflowContext, workspace: object) -> None:
    service = StoryService(ctx)
    story = (await service.generate_stories()).stories[0]

    review = await service.coach_story(story.id)
    assert isinstance(review, StarCoachReviewOutput)
    assert story.title in review.feedback
    assert "Result" in review.feedback
    assert review.suggestions

    with pytest.raises(AppError) as error:
        await service.coach_story("story_missing")
    assert error.value.code == "NOT_FOUND"
    assert error.value.args[0] == "no story story_missing"


async def test_stories_require_an_active_workspace(ctx: WorkflowContext) -> None:
    service = StoryService(ctx)
    with pytest.raises(AppError) as error:
        await service.generate_stories()
    assert error.value.code == "NO_ACTIVE_PROFILE"
    assert error.value.args[0] == "no active candidate/target — call /api/workspace/setup first"
