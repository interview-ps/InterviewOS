"""Shared workflow context — port of `apps/server/src/orchestrator/context.ts`.

Owns the primitives every orchestrator service needs (active profile lookup,
evidence, readiness graph, session transitions, runtime overrides) so the
services stay behaviour-identical without re-deriving them.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from ..ai.interface import AIRuntime, ReasoningEffort
from ..ai.logger import Logger
from ..core import taxonomy
from ..core.models import (
    AppError,
    CandidateProfile,
    Evidence,
    EvidenceType,
    InterviewEvent,
    InterviewStatus,
    ReadinessGraph,
    Requirement,
    TargetRole,
)
from ..core.readiness import build_readiness_graph
from ..core.skill_id import SkillId
from ..core.state_machine import transition
from ..skills.framework import RuntimeOptions, SkillContext
from ..skills.host import SkillHost
from ..store.store import Store

if TYPE_CHECKING:
    from ..packs.registry import PackRegistry  # type: ignore[import-not-found]

__all__ = ["ProgressOptions", "WorkflowContext"]


def _utcnow() -> datetime:
    return datetime.now(UTC)


class ProgressOptions:
    """Streaming progress pushed to SSE/API callers during long AI operations."""

    def __init__(self, on_progress: Callable[[object], None] | None = None) -> None:
        self.on_progress = on_progress


class WorkflowContext:
    def __init__(
        self,
        *,
        store: Store,
        host: SkillHost,
        runtime: AIRuntime,
        logger: Logger,
        now: Callable[[], datetime] = _utcnow,
        packs: PackRegistry | None = None,
    ) -> None:
        self.store = store
        self.host = host
        self.runtime = runtime
        self.logger = logger
        self.now = now
        self.packs = packs
        #: v0.4: bumped whenever plugin-rendered UI could be stale (readiness
        #: snapshots, evidence, target switches, plugin enable/grant changes).
        self.ui_epoch = 0

    def bump_ui_epoch(self) -> None:
        self.ui_epoch += 1

    async def ctx(self, **extra: object) -> SkillContext:
        """Skill invocation context, with settings-backed runtime overrides (§8.3)."""
        options = await self.runtime_options()
        return SkillContext(
            runtime=self.runtime,
            logger=self.logger,
            now=self.now,
            runtime_options=options,
            **extra,  # type: ignore[arg-type]
        )

    def iso(self) -> str:
        return self.now().isoformat().replace("+00:00", "Z")

    async def require_active(self) -> tuple[CandidateProfile, TargetRole]:
        candidate_row = self.store.get_active_candidate()
        target_row = self.store.get_active_target()
        if candidate_row is None or target_row is None:
            raise AppError(
                "NO_ACTIVE_PROFILE",
                "no active candidate/target — call /api/workspace/setup first",
            )
        return candidate_row.data, target_row.data

    def all_requirements(self, target: TargetRole) -> list[Requirement]:
        return [*target.requirements, *target.preferred_skills]

    def evidence_for_active(self, candidate_id: str) -> list[Evidence]:
        return [
            Evidence(
                id=row.id,
                skill_id=row.skill_id,
                type=EvidenceType(row.type),
                score=row.score,
                confidence=row.confidence,
                observation=row.observation,
                session_id=row.session_id,
                question_id=row.question_id,
                source=row.source,
                created_at=row.created_at,
            )
            for row in self.store.list_evidence(candidate_id)
        ]

    def graph_for_active(self) -> ReadinessGraph:
        candidate, target = self._require_active_sync()
        return build_readiness_graph(
            evidence=self.evidence_for_active(candidate.id),
            requirements=self.all_requirements(target),
            taxonomy=taxonomy,
            now=self.now(),
        )

    def _require_active_sync(self) -> tuple[CandidateProfile, TargetRole]:
        candidate_row = self.store.get_active_candidate()
        target_row = self.store.get_active_target()
        if candidate_row is None or target_row is None:
            raise AppError(
                "NO_ACTIVE_PROFILE",
                "no active candidate/target — call /api/workspace/setup first",
            )
        return candidate_row.data, target_row.data

    def register_skill_node(self, skill_id: SkillId, store: Store | None = None) -> None:
        target_store = store if store is not None else self.store
        for node_id in [skill_id, *taxonomy.ancestors(skill_id)]:
            node = taxonomy.get_node(node_id)
            target_store.upsert_skill_node(
                node_id,
                node.label if node is not None else taxonomy.label_for(node_id),
                taxonomy.parent_of(node_id),
            )

    def transition_session(
        self,
        session_id: str,
        next_status: InterviewStatus,
        event: InterviewEvent,
    ) -> None:
        row = self.store.get_session(session_id)
        if row is None:
            raise AppError("NOT_FOUND", f"no session {session_id}")
        from_status = InterviewStatus(row.status)
        to_status = transition(from_status, event)  # raises InvalidTransitionError
        if to_status != next_status:
            raise AppError("INTERNAL", f"unexpected transition {event}: {from_status}→{to_status}")
        self.store.update_session(session_id, {"status": to_status})

    async def runtime_options(self) -> RuntimeOptions:
        """Settings-backed runtime overrides, read at call time (§8.3)."""
        effort: str | None = self.store.get_setting("reasoningEffort")
        task_mode = self.store.get_setting("taskMode")
        normalized_effort: ReasoningEffort | None = (
            effort if effort in ("low", "medium", "high") else None  # type: ignore[assignment]
        )
        return RuntimeOptions(
            model=self.store.get_setting("model") or None,
            effort=normalized_effort,
            task_mode="exec" if task_mode == "exec" else "app-server",
        )
