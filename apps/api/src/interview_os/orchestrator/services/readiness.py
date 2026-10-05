"""Readiness service — port of `apps/server/src/orchestrator/readiness-service.ts`."""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING

from ...core.gaps import calculate_gaps
from ...core.models import Gap, ReadinessGraph

if TYPE_CHECKING:
    from ..context import WorkflowContext

__all__ = ["ReadinessService"]

OVERALL_SKILL_ID = "__overall__"


class ReadinessService:
    def __init__(
        self,
        ctx: WorkflowContext,
        *,
        on_readiness_changed: Callable[[list[str], str], None] | None = None,
    ) -> None:
        self._ctx = ctx
        #: v1: fired (inside the lock; expected to enqueue) when a recompute
        #: appends snapshots whose scores differ from the previous ones.
        self._on_readiness_changed = on_readiness_changed

    def graph_for_active(self) -> ReadinessGraph:
        return self._ctx.graph_for_active()

    async def calculate_gaps_internal(self) -> list[Gap]:
        _candidate, target = await self._ctx.require_active()
        graph = self.graph_for_active()
        return calculate_gaps(
            requirements=self._ctx.all_requirements(target),
            readiness=graph.dimensions,
            level=target.level,
        )

    async def recompute_readiness_internal(self, reason: str) -> ReadinessGraph:
        graph = self._ctx.graph_for_active()
        latest = self._ctx.store.latest_readiness_by_skill()
        computed_at = self._ctx.iso()

        def changed(skill_id: str, score: float | None, confidence: float) -> bool:
            prev = latest.get(skill_id)
            if prev is None:
                return True
            return prev.score != score or abs(prev.confidence - confidence) > 1e-9

        appended = 0
        changed_skill_ids: list[str] = []
        for dim in graph.dimensions.values():
            if not changed(dim.skill_id, dim.score, dim.confidence):
                continue
            prev = latest.get(dim.skill_id)
            if prev is None or prev.score != dim.score:
                changed_skill_ids.append(dim.skill_id)
            self._ctx.store.append_readiness_snapshot(
                skill_id=dim.skill_id,
                score=dim.score,
                confidence=dim.confidence,
                evidence_ids=list(dim.evidence_ids),
                reason=reason,
                computed_at=computed_at,
            )
            appended += 1
        if changed(OVERALL_SKILL_ID, graph.overall, graph.overall_confidence):
            self._ctx.store.append_readiness_snapshot(
                skill_id=OVERALL_SKILL_ID,
                score=graph.overall,
                confidence=graph.overall_confidence,
                evidence_ids=[],
                reason=reason,
                computed_at=computed_at,
            )
            appended += 1
        self._ctx.logger.info("readiness.updated", {"reason": reason, "nodesChanged": appended})
        if appended > 0:
            self._ctx.bump_ui_epoch()
        if changed_skill_ids and self._on_readiness_changed is not None:
            self._on_readiness_changed(changed_skill_ids, reason)
        return graph
