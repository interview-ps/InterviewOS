"""Debrief service — port of `apps/server/src/orchestrator/debrief-service.ts`."""

from __future__ import annotations

from typing import Any

from ...ai.interface import ProgressUpdate
from ...core import new_id
from ...core.models import AppError, InterviewEvent, InterviewStatus
from ...core.state_machine import transition
from ...skills import interview_debrief
from ..context import ProgressOptions, WorkflowContext

__all__ = ["DebriefService"]

OVERALL_SKILL_ID = "__overall__"


class DebriefService:
    def __init__(self, ctx: WorkflowContext) -> None:
        self._ctx = ctx

    async def create_debrief(
        self, session_id: str, opts: ProgressOptions | None = None
    ) -> Any:
        return await self.create_debrief_internal(session_id, opts)

    async def create_debrief_internal(
        self, session_id: str, opts: ProgressOptions | None = None
    ) -> Any:
        session = self._ctx.store.get_session(session_id)
        if session is None:
            raise AppError("NOT_FOUND", f"no session {session_id}")
        existing = self._ctx.store.get_debrief(session_id)
        status = InterviewStatus(session.status)
        if status == InterviewStatus.COMPLETE:
            self._ctx.transition_session(
                session_id, InterviewStatus.DEBRIEF, InterviewEvent.DEBRIEF
            )
        elif status != InterviewStatus.DEBRIEF:
            transition(status, InterviewEvent.DEBRIEF)  # throws

        _candidate, target = await self._ctx.require_active()
        questions = self._ctx.store.list_questions(session_id)
        evaluations = [row.data for row in self._ctx.store.list_evaluations(session_id)]
        latest = self._ctx.store.latest_readiness_by_skill()
        after_map: dict[str, float | None] = {}
        before_map: dict[str, float | None] = {}
        for skill_id, row in latest.items():
            if skill_id == OVERALL_SKILL_ID:
                continue
            after_map[skill_id] = row.score
        # readiness "before" = latest snapshot at or before session creation
        for skill_id in after_map:
            history = self._ctx.store.readiness_history(skill_id)
            before_row = next(
                (row for row in history if row.computed_at <= session.created_at), None
            )
            before_map[skill_id] = None if before_row is None else before_row.score

        output: Any
        if existing is not None:
            output = existing.data
        else:
            if opts is not None and opts.on_progress is not None:
                opts.on_progress(ProgressUpdate(stage="writing debrief"))
            output = await self._ctx.host.invoke(
                interview_debrief,
                {
                    "role": target.role,
                    "questions": [
                        {
                            "text": question.text,
                            "skillId": question.skill_id,
                            "topic": question.topic,
                        }
                        for question in questions
                    ],
                    "evaluations": evaluations,
                    "readinessBefore": before_map,
                    "readinessAfter": after_map,
                    "openActions": [
                        {"skillId": action.skill_id, "action": action.action}
                        for action in self._ctx.store.list_actions("open")
                    ],
                },
                await self._ctx.ctx(
                    session_id=session_id,
                    on_progress=opts.on_progress if opts is not None else None,
                ),
            )
            self._ctx.host.assert_can("interview-debrief", "interview.write")
            self._ctx.store.insert_debrief(
                id=new_id("debrief"),
                session_id=session_id,
                data=output,
                created_at=self._ctx.iso(),
            )
        return output
