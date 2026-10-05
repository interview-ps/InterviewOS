"""Resume review service — port of `apps/server/src/orchestrator/resume-service.ts`."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable

from pydantic import ValidationError

from ...ai.interface import ProgressUpdate
from ...core import new_id, taxonomy
from ...core.models import (
    AppError,
    Gap,
    ResumeGuard,
    ResumeReview,
    ResumeSuggestion,
    ResumeTailoring,
)
from ...core.resume import ats_check, guard_suggestion, select_weakest_bullets
from ...skills.prepare.resume_coach import ResumeCoachBulletsOutputNormalized
from ...skills.prepare.resume_coach import resume_coach as resume_coach_skill
from ..context import ProgressOptions, WorkflowContext

__all__ = ["ResumeService"]


async def _empty_bullets_output() -> ResumeCoachBulletsOutputNormalized:
    return ResumeCoachBulletsOutputNormalized(suggestions=[])


class ResumeService:
    def __init__(
        self,
        ctx: WorkflowContext,
        *,
        calculate_gaps: Callable[[], Awaitable[list[Gap]]],
        record_usage_event: Callable[[str], Awaitable[None]],
    ) -> None:
        self._ctx = ctx
        self._calculate_gaps = calculate_gaps
        self._record_usage_event = record_usage_event

    async def review_resume(self, opts: ProgressOptions | None = None) -> ResumeReview:
        """Deterministic ATS check + resume-coach bullets/tailor (run
        concurrently). Every suggestion passes `guard_suggestion` before
        persisting — the coach never creates evidence and never changes
        readiness."""

        candidate, target = await self._ctx.require_active()
        candidate_row = self._ctx.store.get_active_candidate()
        if candidate_row is None:
            raise AppError("NOT_FOUND", "no active candidate")
        resume_text = candidate_row.resume_text
        if not resume_text.strip():
            raise AppError("VALIDATION", "no resume on file — set up the workspace first")

        progress = opts.on_progress if opts is not None else None
        if progress is not None:
            progress(ProgressUpdate(stage="checking ATS"))
        requirements = self._ctx.all_requirements(target)
        ats = ats_check(resume_text, requirements)
        weak_bullets = select_weakest_bullets(resume_text, 8)

        if progress is not None:
            progress(ProgressUpdate(stage="improving bullets"))
            progress(ProgressUpdate(stage="tailoring to role"))
        skill_ctx = await self._ctx.ctx(on_progress=progress)
        bullets_out, tailor_out = await asyncio.gather(
            self._ctx.host.invoke(
                resume_coach_skill,
                {"mode": "bullets", "resumeText": resume_text, "bullets": weak_bullets},
                skill_ctx,
            )
            if weak_bullets
            else _empty_bullets_output(),
            self._ctx.host.invoke(
                resume_coach_skill,
                {
                    "mode": "tailor",
                    "resumeText": resume_text,
                    "requirements": requirements,
                    "role": target.role,
                    "level": target.level,
                },
                skill_ctx,
            ),
        )
        bullet_suggestions = (
            bullets_out.suggestions
            if isinstance(bullets_out, ResumeCoachBulletsOutputNormalized)
            else []
        )
        tailoring: ResumeTailoring | None = (
            tailor_out if isinstance(tailor_out, ResumeTailoring) else None
        )

        # §9.5 guard: substitute invented numbers, drop invented entities.
        substitutions: list[str] = []
        dropped = 0
        suggestions: list[ResumeSuggestion] = []
        for suggestion in bullet_suggestions:
            guarded = guard_suggestion(suggestion.original, suggestion.improved, resume_text)
            substitutions.extend(guarded.substitutions)
            if not guarded.ok:
                dropped += 1
                suggestions.append(
                    ResumeSuggestion(
                        original=suggestion.original,
                        improved=guarded.improved,
                        rationale=suggestion.rationale,
                        skill_ids=list(suggestion.skill_ids),
                        dropped=guarded.dropped,
                    )
                )
                continue
            suggestions.append(
                ResumeSuggestion(
                    original=suggestion.original,
                    improved=guarded.improved,
                    rationale=suggestion.rationale,
                    skill_ids=list(suggestion.skill_ids),
                )
            )
        self._ctx.logger.info(
            "resume.guard", {"substitutions": len(substitutions), "dropped": dropped}
        )

        # §9.5: link prepGaps to real requirement gaps — no evidence, no
        # readiness change.
        gaps = await self._calculate_gaps()
        linked_gap_skill_ids: list[str] = []
        for prep_gap in tailoring.prep_gaps if tailoring is not None else []:
            normalized = taxonomy.normalize_skill_id(prep_gap)
            hit = next(
                (
                    gap
                    for gap in gaps
                    if gap.skill_id == normalized or gap.label.lower() == prep_gap.lower()
                ),
                None,
            )
            if hit is not None and hit.skill_id not in linked_gap_skill_ids:
                linked_gap_skill_ids.append(hit.skill_id)

        review = ResumeReview(
            id=new_id("rev"),
            candidate_id=candidate.id,
            target_id=target.id,
            ats=ats,
            suggestions=suggestions,
            tailoring=tailoring,
            linked_gap_skill_ids=linked_gap_skill_ids,
            guard=ResumeGuard(substitutions=len(substitutions), dropped=dropped),
            created_at=self._ctx.iso(),
        )
        self._ctx.host.assert_can("resume-coach", "resume.write")
        self._ctx.store.insert_resume_review(
            id=review.id,
            candidate_id=review.candidate_id,
            target_id=review.target_id,
            ats=review.ats,
            suggestions=review.suggestions,
            tailoring=review.tailoring,
            linked_gap_skill_ids=review.linked_gap_skill_ids,
            guard=review.guard,
            created_at=review.created_at,
        )
        await self._record_usage_event("resume.coach.used")
        self._ctx.logger.info("state.mutated", {"entity": "resume_review", "id": review.id})
        return review

    async def latest_resume_review(self) -> ResumeReview | None:
        """Most recent persisted resume review, or null."""

        row = self._ctx.store.latest_resume_review()
        if row is None:
            return None
        try:
            return ResumeReview.model_validate(
                {
                    "id": row.id,
                    "candidateId": row.candidate_id,
                    "targetId": row.target_id,
                    "ats": row.ats,
                    "suggestions": row.suggestions,
                    "tailoring": row.tailoring,
                    "linkedGapSkillIds": row.linked_gap_skill_ids,
                    "guard": row.guard,
                    "createdAt": row.created_at,
                }
            )
        except ValidationError:
            return None
