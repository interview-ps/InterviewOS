"""STAR story service — port of `apps/server/src/orchestrator/story-service.ts`."""

from __future__ import annotations

from ...ai.interface import ProgressUpdate
from ...core import in_subtree, new_id
from ...core.models import AppError, CamelModel, StarStoryRow
from ...core.skill_id import SkillId
from ...skills.prepare.star_coach import (
    StarCoachGenerateOutputNormalized,
    StarCoachReviewOutput,
)
from ...skills.prepare.star_coach import (
    star_coach as star_coach_skill,
)
from ..context import ProgressOptions, WorkflowContext

__all__ = ["GenerateStoriesResult", "StoryService"]


class StoryPatch(CamelModel):
    title: str | None = None
    situation: str | None = None
    task: str | None = None
    action: str | None = None
    result: str | None = None
    skill_ids: list[SkillId] | None = None


class GenerateStoriesResult(CamelModel):
    stories: list[StarStoryRow]
    created: int


class StoryService:
    def __init__(self, ctx: WorkflowContext) -> None:
        self._ctx = ctx

    async def list_stories(self) -> list[StarStoryRow]:
        candidate, _ = await self._ctx.require_active()
        return self._ctx.store.list_stories(candidate.id)

    async def generate_stories(self, opts: ProgressOptions | None = None) -> GenerateStoriesResult:
        """Generate resume-grounded STAR stories via star-coach; dedupe by title."""

        candidate, target = await self._ctx.require_active()
        if opts is not None and opts.on_progress is not None:
            opts.on_progress(ProgressUpdate(stage="drafting stories"))
        behavioral_skill_ids = [
            requirement.skill_id
            for requirement in [*target.requirements, *target.preferred_skills]
            # behavioral ∪ communication ∪ hr subtrees — mode-independent.
            if in_subtree(requirement.skill_id, "behavioral")
            or in_subtree(requirement.skill_id, "communication")
            or in_subtree(requirement.skill_id, "hr")
        ]
        existing = self._ctx.store.list_stories(candidate.id)
        output = await self._ctx.host.invoke(
            star_coach_skill,
            {
                "mode": "generate",
                "experience": candidate.experience,
                "achievements": candidate.achievements,
                "projects": candidate.projects,
                "behavioralSkillIds": behavioral_skill_ids,
                "existingTitles": [story.title for story in existing],
            },
            await self._ctx.ctx(on_progress=opts.on_progress if opts is not None else None),
        )
        if not isinstance(output, StarCoachGenerateOutputNormalized):
            raise AppError("INTERNAL", "star-coach returned an unexpected output shape")
        # §9.6: star-coach output persists generated stories.
        self._ctx.host.assert_can("star-coach", "stories.write")
        taken = {story.title.lower() for story in existing}
        created = 0
        for draft in output.stories:
            if draft.title.lower() in taken:
                continue
            taken.add(draft.title.lower())
            story_id = new_id("story")
            self._ctx.store.insert_story(
                id=story_id,
                candidate_id=candidate.id,
                title=draft.title,
                situation=draft.situation,
                task=draft.task,
                action=draft.action,
                result=draft.result,
                skill_ids=list(draft.skill_ids),
                source="generated",
                updated_at=self._ctx.iso(),
            )
            created += 1
        self._ctx.logger.info(
            "state.mutated", {"entity": "star_story", "id": f"{created} generated"}
        )
        return GenerateStoriesResult(
            stories=self._ctx.store.list_stories(candidate.id), created=created
        )

    async def update_story(self, id: str, patch: StoryPatch) -> StarStoryRow | None:
        """User edits mark the story as theirs (source 'user')."""

        row = self._ctx.store.get_story(id)
        if row is None:
            raise AppError("NOT_FOUND", f"no story {id}")
        updates: dict[str, object] = {}
        if patch.title is not None:
            updates["title"] = patch.title
        if patch.situation is not None:
            updates["situation"] = patch.situation
        if patch.task is not None:
            updates["task"] = patch.task
        if patch.action is not None:
            updates["action"] = patch.action
        if patch.result is not None:
            updates["result"] = patch.result
        if patch.skill_ids is not None:
            updates["skill_ids"] = patch.skill_ids
        updates["source"] = "user"
        updates["updated_at"] = self._ctx.iso()
        self._ctx.store.update_story(id, updates)
        self._ctx.logger.info("state.mutated", {"entity": "star_story", "id": id})
        return self._ctx.store.get_story(id)

    async def coach_story(
        self, id: str, opts: ProgressOptions | None = None
    ) -> StarCoachReviewOutput:
        """Coach review of one story (star-coach.review); streams `feedback`."""

        _, target = await self._ctx.require_active()
        row = self._ctx.store.get_story(id)
        if row is None:
            raise AppError("NOT_FOUND", f"no story {id}")
        if opts is not None and opts.on_progress is not None:
            opts.on_progress(ProgressUpdate(stage="coaching story"))
        output = await self._ctx.host.invoke(
            star_coach_skill,
            {
                "mode": "review",
                "story": {
                    "title": row.title,
                    "situation": row.situation,
                    "task": row.task,
                    "action": row.action,
                    "result": row.result,
                    "skillIds": list(row.skill_ids),
                },
                "role": target.role,
                "level": target.level,
            },
            await self._ctx.ctx(on_progress=opts.on_progress if opts is not None else None),
        )
        if not isinstance(output, StarCoachReviewOutput):
            raise AppError("INTERNAL", "star-coach returned an unexpected output shape")
        return output
