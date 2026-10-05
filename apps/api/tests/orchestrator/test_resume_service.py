"""ResumeService: deterministic ATS + guarded coach suggestions (§9.5)."""

from __future__ import annotations

import pytest

from interview_os.core import taxonomy
from interview_os.core.gaps import calculate_gaps
from interview_os.core.models import AppError, CandidateProfile, Gap, TargetRole
from interview_os.orchestrator.context import WorkflowContext
from interview_os.orchestrator.services.resume import ResumeService

from .conftest import iso_now


def _make_service(ctx: WorkflowContext, usage: list[str]) -> ResumeService:
    async def calculate_gaps_for_active() -> list[Gap]:
        _, target = await ctx.require_active()
        graph = ctx.graph_for_active()
        return calculate_gaps(
            requirements=ctx.all_requirements(target),
            readiness=graph.dimensions,
            level=target.level,
            taxonomy=taxonomy,
        )

    async def record_usage_event(event: str) -> None:
        usage.append(event)

    return ResumeService(
        ctx, calculate_gaps=calculate_gaps_for_active, record_usage_event=record_usage_event
    )


async def test_review_resume_guards_suggestions_and_persists(
    ctx: WorkflowContext, workspace: tuple[CandidateProfile, TargetRole]
) -> None:
    usage: list[str] = []
    service = _make_service(ctx, usage)

    review = await service.review_resume()

    assert review.id.startswith("rev_")
    assert review.candidate_id == "cand_test"
    assert review.target_id == "target_test"
    assert 0 <= review.ats.score <= 100
    assert review.ats.checks
    assert review.suggestions
    # the mock coach emits "[add metric]" placeholders, which the guard keeps
    assert any("[add metric]" in suggestion.improved for suggestion in review.suggestions)
    assert review.tailoring is not None
    assert review.tailoring.summary
    assert review.guard.substitutions >= 0
    assert review.guard.dropped == sum(1 for item in review.suggestions if item.dropped)
    assert usage == ["resume.coach.used"]
    assert all(
        skill_id
        in {
            gap.skill_id
            for gap in calculate_gaps(
                requirements=ctx.all_requirements(workspace[1]),
                readiness=ctx.graph_for_active().dimensions,
                level=workspace[1].level,
                taxonomy=taxonomy,
            )
        }
        for skill_id in review.linked_gap_skill_ids
    )

    latest = await service.latest_resume_review()
    assert latest is not None
    assert latest.id == review.id
    assert latest.ats == review.ats
    assert latest.suggestions == review.suggestions
    assert latest.guard == review.guard


async def test_review_resume_requires_a_resume(ctx: WorkflowContext, workspace: object) -> None:
    store = ctx.store
    store.update_row("candidate_profiles", "cand_test", {"resume_text": "   "})

    with pytest.raises(AppError) as error:
        await _make_service(ctx, []).review_resume()
    assert error.value.code == "VALIDATION"
    assert error.value.args[0] == "no resume on file — set up the workspace first"


async def test_latest_review_is_none_before_the_first_review(ctx: WorkflowContext) -> None:
    assert await _make_service(ctx, []).latest_resume_review() is None


async def test_latest_review_ignores_unparseable_rows(ctx: WorkflowContext) -> None:
    ctx.store.insert_resume_review(
        id="rev_broken",
        candidate_id=None,
        target_id=None,
        ats={},
        suggestions=[],
        tailoring=None,
        linked_gap_skill_ids=[],
        guard={},
        created_at=iso_now(),
    )
    assert await _make_service(ctx, []).latest_resume_review() is None
