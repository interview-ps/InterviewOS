"""Preparation service — port of `apps/server/src/orchestrator/preparation-service.ts`."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from pydantic import ValidationError

from ...core import new_id, taxonomy
from ...core.models import AppError, CamelModel, PrepResource, Requirement
from ...core.resources import builtin_resources_for, merge_resources
from ...skills.prepare.prep_planner import PrepActionOut, PrepPlannerOutputNormalized
from ...skills.prepare.prep_planner import prep_planner as prep_planner_skill
from ..context import WorkflowContext
from ..projection import PrepActionRowLike, row_to_action

if TYPE_CHECKING:
    from ...packs.registry import PackRegistry
    from ...store.store import PrepActionRow
    from .readiness import ReadinessService

__all__ = [
    "CompleteActionResult",
    "PreparationPlan",
    "PreparationService",
    "PreparationServiceDeps",
]

_SEV_WEIGHT = {"high": 3, "medium": 2, "low": 1}


@dataclass(frozen=True)
class PreparationServiceDeps:
    """v0.4: resources-capability plugin bridge."""

    #: Run a resources-capability plugin; returns raw output or raises.
    run_resource_plugin: Callable[[str, object], Awaitable[object]]
    #: ids of enabled+compatible plugins with the resources capability.
    enabled_resource_plugins: Callable[[], Awaitable[list[str]]]


class PreparationPlan(CamelModel):
    actions: list[PrepActionRowLike]
    created: list[PrepActionRowLike]


class CompleteActionResult(CamelModel):
    ok: bool
    evidence_id: str | None
    actions: list[PrepActionRowLike]


class PreparationService:
    def __init__(
        self,
        ctx: WorkflowContext,
        readiness: ReadinessService,
        *,
        deps: PreparationServiceDeps | None = None,
    ) -> None:
        self._ctx = ctx
        self._readiness = readiness
        self._deps = deps

    async def build_preparation_plan_internal(self) -> PreparationPlan:
        candidate, target = await self._ctx.require_active()
        gaps = await self._readiness.calculate_gaps_internal()
        evidence = self._ctx.evidence_for_active(candidate.id)
        open_skills = {a.skill_id for a in self._ctx.store.list_actions("open", target.id)}

        targets: list[dict[str, object]] = []
        seen: set[str] = set()

        for gap in [g for g in gaps if g.severity != "low"][:5]:
            seen.add(gap.skill_id)
            targets.append(
                {
                    "skill_id": gap.skill_id,
                    "label": gap.label,
                    "reason": gap.reason,
                    "missing_concepts": [],
                    "severity": gap.severity,
                }
            )

        weak_skill_ids = {
            e.skill_id for e in evidence if e.type == "interview_answer" and e.score < 0.5
        }
        for skill_id in sorted(weak_skill_ids):
            if skill_id in seen or skill_id in open_skills:
                continue
            obs = next(
                (
                    e
                    for e in evidence
                    if e.skill_id == skill_id
                    and e.type == "interview_answer"
                    and e.score < 0.5
                ),
                None,
            )
            observation = obs.observation if obs is not None else ""
            targets.append(
                {
                    "skill_id": skill_id,
                    "label": taxonomy.label_for(skill_id),
                    "reason": f"weak interview evidence: {observation}".strip(),
                    "missing_concepts": [],
                    "severity": "medium",
                }
            )

        created: list[PrepActionRowLike] = []
        if targets:
            plan: PrepPlannerOutputNormalized = await self._ctx.host.invoke(
                prep_planner_skill,
                {"targets": targets, "role": target.role, "level": target.level},
                await self._ctx.ctx(),
            )
            by_skill = {a.skill_id: a for a in plan.actions}
            for t in targets:
                skill_id = str(t["skill_id"])
                action = by_skill.get(skill_id)
                if action is None:
                    continue
                created.append(
                    await self.insert_planned_action(
                        skill_id,
                        action,
                        candidate.id,
                        str(t["severity"]),
                        target.id,
                    )
                )

        await self.renumber_action_priorities(self._ctx.all_requirements(target), target.id)

        actions = [
            row_to_action(row.model_dump())
            for row in self._ctx.store.list_actions(None, target.id)
            if row.status in ("open", "in_progress")
        ]
        return PreparationPlan(actions=actions, created=created)

    async def insert_planned_action(
        self,
        skill_id: str,
        action: PrepActionOut,
        candidate_id: str,
        severity: str = "medium",
        target_id: str | None = None,
    ) -> PrepActionRowLike:
        # §9.6: planned actions persist prep-planner output.
        self._ctx.host.assert_can("prep-planner", "preparation.write")
        # v0.4: resources = builtin catalog + the target's role-pack resources.
        resources = await self._resources_for_skill(skill_id, target_id)
        # Atomic supersede + insert: a failure must not drop the action entirely.
        created_at = self._ctx.iso()
        with self._ctx.store.transaction() as tx:
            existing = tx.open_action_for_skill(skill_id, target_id)
            if existing is not None:
                tx.update_action_status(existing.id, "superseded")
            source_evidence_ids = [
                e.id for e in tx.evidence_for_skill(skill_id, candidate_id)
            ]
            row_id = new_id("action")
            tx.insert_action(
                id=row_id,
                skill_id=skill_id,
                priority=0,
                action=action.action,
                created_at=created_at,
                target_id=target_id,
                reason=action.reason,
                success_criteria=list(action.success_criteria),
                status="open",
                severity=severity,
                source_evidence_ids=source_evidence_ids,
                resources=resources,
            )
        self._ctx.logger.info(
            "state.mutated", {"entity": "prep_action", "id": row_id, "skillId": skill_id}
        )
        return row_to_action(
            {
                "id": row_id,
                "skill_id": skill_id,
                "priority": 0,
                "reason": action.reason,
                "action": action.action,
                "success_criteria": list(action.success_criteria),
                "status": "open",
                "severity": severity,
                "created_at": created_at,
                "source_evidence_ids": source_evidence_ids,
                "resources": resources,
            }
        )

    async def renumber_action_priorities(
        self, requirements: list[Requirement], target_id: str | None = None
    ) -> None:
        """Renumber open/in_progress actions 1..n (interview-evidenced actions outrank)."""

        req_map = {r.skill_id: r for r in requirements}

        def nearest_req(skill_id: str) -> Requirement | None:
            cur: str | None = skill_id
            while cur is not None:
                hit = req_map.get(cur)
                if hit is not None:
                    return hit
                cur = taxonomy.parent_of(cur)
            return None

        # Atomic renumber: priorities are a unique 1..n invariant, so never leave a
        # half-renumbered plan visible.
        with self._ctx.store.transaction() as tx:
            interview_evidence_ids = {
                e.id for e in tx.list_evidence() if e.type == "interview_answer"
            }
            open_actions = [
                a
                for a in tx.list_actions(None, target_id)
                if a.status in ("open", "in_progress")
            ]
            scored: list[tuple[PrepActionRow, float]] = []
            for a in open_actions:
                source_ids = list(a.source_evidence_ids or [])
                has_interview_evidence = any(
                    evidence_id in interview_evidence_ids for evidence_id in source_ids
                )
                nearest = nearest_req(a.skill_id)
                score = (
                    _SEV_WEIGHT.get(a.severity, 2)
                    * (1.5 if has_interview_evidence else 1)
                    * (nearest.importance if nearest is not None else 0.5)
                )
                scored.append((a, score))
            scored.sort(key=lambda item: item[0].skill_id)
            scored.sort(key=lambda item: item[0].created_at, reverse=True)
            scored.sort(key=lambda item: item[1], reverse=True)
            for index, (action, _score) in enumerate(scored):
                tx.update_action_priority(action.id, index + 1)

    async def _resources_for_skill(
        self, skill_id: str, target_id: str | None = None
    ) -> list[PrepResource]:
        """builtin catalog + role-pack resources for an action's skill."""

        packs = self._packs()
        await packs.ready()
        target_row = (
            self._ctx.store.get_target(target_id)
            if target_id is not None
            else self._ctx.store.get_active_target()
        )
        role_pack_id = target_row.data.role_pack_id if target_row is not None else None
        return merge_resources(
            builtin_resources_for(skill_id),
            packs.role_pack_resources(role_pack_id, skill_id),
        )

    async def fetch_plugin_resources(self, action_id: str) -> PrepActionRowLike:
        """v0.4: fetch + merge resources from enabled `resources` plugins."""

        action = self._ctx.store.get_action(action_id)
        if action is None:
            raise AppError("NOT_FOUND", f"no prep action {action_id}")
        merged = list(action.resources)
        enabled = await self._deps.enabled_resource_plugins() if self._deps is not None else []
        for plugin_id in enabled:
            try:
                assert self._deps is not None
                output = await self._deps.run_resource_plugin(
                    plugin_id, {"kind": "resources", "skillIds": [action.skill_id]}
                )
                listing = output.get("resources") if isinstance(output, dict) else None
                if not isinstance(listing, list):
                    continue
                dropped = 0
                valid: list[PrepResource] = []
                for entry in listing:
                    if not isinstance(entry, dict):
                        dropped += 1
                        continue
                    try:
                        valid.append(
                            PrepResource.model_validate(
                                {
                                    **entry,
                                    "skillId": action.skill_id,
                                    "source": f"plugin:{plugin_id}",
                                }
                            )
                        )
                    except ValidationError:
                        dropped += 1
                if dropped > 0:
                    self._ctx.logger.warn(
                        "resources.invalid", {"plugin": plugin_id, "dropped": dropped}
                    )
                merged = merge_resources(merged, valid)
            except Exception as err:  # noqa: BLE001 - plugin failure is logged, never thrown
                self._ctx.logger.warn(
                    "resources.plugin_failed",
                    {"plugin": plugin_id, "error": str(err)[:200]},
                )
        self._ctx.store.update_action_resources(action_id, merged)
        row = self._ctx.store.get_action(action_id)
        if row is None:
            raise AppError("NOT_FOUND", f"no prep action {action_id}")
        return row_to_action(row.model_dump())

    async def list_preparation_actions(self) -> list[PrepActionRowLike]:
        return [row_to_action(row.model_dump()) for row in self._ctx.store.list_actions()]

    async def complete_action(
        self, action_id: str, opts: Mapping[str, Any] | None = None
    ) -> CompleteActionResult:
        """Self-check completion (§8.1)."""

        action = self._ctx.store.get_action(action_id)
        if action is None:
            raise AppError("NOT_FOUND", f"no prep action {action_id}")
        candidate, _target = await self._ctx.require_active()
        criteria = list(action.success_criteria)

        checked = None
        if opts is not None:
            # The HTTP contract sends camelCase `checkedCriteria`; keep the
            # snake_case alias working for in-process callers.
            checked = opts.get("checkedCriteria", opts.get("checked_criteria"))
        evidence_id: str | None = None
        if checked is not None:
            checked_list = [str(item) for item in checked]
            bad = [cc for cc in checked_list if cc not in criteria]
            if bad:
                raise AppError("VALIDATION", f"unknown success criteria: {'; '.join(bad)}")
            evidence_id = new_id("ev")
            self._ctx.store.insert_evidence(
                id=evidence_id,
                candidate_id=candidate.id,
                skill_id=action.skill_id,
                type="self_report",
                score=0 if not criteria else len(checked_list) / len(criteria),
                confidence=0.5,
                observation=(
                    f"Self-check: met {len(checked_list)}/{len(criteria)} criteria — "
                    f"{'; '.join(checked_list)}"
                ),
                created_at=self._ctx.iso(),
            )

        self._ctx.store.update_action_status(action_id, "done")
        self._ctx.logger.info(
            "state.mutated", {"entity": "prep_action", "id": action_id, "status": "done"}
        )
        await self._readiness.recompute_readiness_internal("practice")
        plan = await self.build_preparation_plan_internal()
        return CompleteActionResult(ok=True, evidence_id=evidence_id, actions=plan.actions)

    async def update_action_status(self, action_id: str, status: str) -> None:
        self._ctx.store.update_action_status(action_id, status)
        self._ctx.logger.info(
            "state.mutated", {"entity": "prep_action", "id": action_id, "status": status}
        )

    def _packs(self) -> PackRegistry:
        packs = self._ctx.packs
        if packs is None:
            raise AppError("VALIDATION", "no pack registry configured")
        return packs
