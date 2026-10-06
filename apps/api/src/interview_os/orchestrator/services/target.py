"""Target service — port of `apps/server/src/orchestrator/target-service.ts`."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING

from pydantic import ValidationError

from ...ai.interface import ProgressUpdate
from ...core import taxonomy
from ...core.models import (
    AppError,
    CamelModel,
    CompanyNotesProfile,
    CompanyProfile,
    Requirement,
    RequirementKind,
    TargetRole,
)
from ...core.skill_id import SkillId
from ...core.taxonomy_seed import TaxonomyNodeSeed
from ...skills import jd_analyzer, taxonomy_entries
from ..context import ProgressOptions, WorkflowContext
from ..projection import PrepActionRowLike, row_to_action
from .preparation import PreparationService
from .readiness import ReadinessService
from .workspace import TargetInput, WorkspaceService

if TYPE_CHECKING:
    from ...packs.registry import PackRegistry

__all__ = [
    "TargetPlanResult",
    "TargetService",
    "TargetSummary",
    "WorkspaceSources",
]


class TargetSummary(CamelModel):
    id: str
    company: str
    role: str
    level: str
    active: bool
    created_at: str
    company_profile: CompanyNotesProfile | None = None
    company_profile_id: str
    boosted_skill_ids: list[SkillId]


class WorkspaceSources(CamelModel):
    """Persisted resume + active target sources, for prefilling the setup form."""

    resume_text: str
    job_description: str
    company: str
    role: str
    level: str
    company_notes: str | None = None
    has_candidate: bool
    has_target: bool


class TargetPlanResult(CamelModel):
    target: TargetRole
    actions: list[PrepActionRowLike]


class TargetService:
    def __init__(
        self,
        ctx: WorkflowContext,
        readiness: ReadinessService,
        preparation: PreparationService,
        workspace: WorkspaceService,
        *,
        record_usage_event: Callable[[str], Awaitable[None]],
    ) -> None:
        self._ctx = ctx
        self._readiness = readiness
        self._preparation = preparation
        self._workspace = workspace
        self._record_usage_event = record_usage_event

    async def list_targets(self) -> list[TargetSummary]:
        targets: list[TargetSummary] = []
        for row in self._ctx.store.list_targets():
            try:
                data = TargetRole.model_validate(row.data)
            except ValidationError:
                data = None
            targets.append(
                TargetSummary(
                    id=row.id,
                    company=row.company,
                    role=row.role,
                    level=row.level,
                    active=row.active == 1,
                    created_at=row.created_at,
                    company_profile=None if data is None else data.company_profile,
                    company_profile_id=(
                        "generic"
                        if data is None or data.company_profile_id is None
                        else data.company_profile_id
                    ),
                    boosted_skill_ids=(
                        [
                            req.skill_id
                            for req in [*data.requirements, *data.preferred_skills]
                            if req.boosted_by
                        ]
                        if data is not None
                        else []
                    ),
                )
            )
        return targets

    async def get_sources(self) -> WorkspaceSources:
        """Read the persisted resume + active target so the UI can prefill them."""
        candidate = self._ctx.store.get_active_candidate()
        target = self._ctx.store.get_active_target()
        notes: str | None = None
        if target is not None:
            try:
                notes = TargetRole.model_validate(target.data).company_notes
            except ValidationError:
                notes = None
        return WorkspaceSources(
            resume_text="" if candidate is None else candidate.resume_text,
            job_description="" if target is None else target.job_description,
            company="" if target is None else target.company,
            role="" if target is None else target.role,
            level="" if target is None else target.level,
            company_notes=notes,
            has_candidate=candidate is not None and candidate.id not in ("", "none"),
            has_target=target is not None,
        )

    async def add_target(
        self, input: TargetInput, opts: ProgressOptions | None = None
    ) -> TargetPlanResult:
        """Add another target role for the active candidate; becomes the active target."""

        candidate, _target = await self._ctx.require_active()
        if not candidate.id or candidate.id == "none":
            raise AppError("NO_ACTIVE_PROFILE", "no active candidate")
        on_progress = opts.on_progress if opts is not None else None
        if on_progress is not None:
            on_progress(ProgressUpdate(stage="analyzing job description"))
        output, profile = await asyncio.gather(
            self._ctx.host.invoke(
                jd_analyzer,
                {
                    "jobDescription": input.job_description,
                    "company": input.company,
                    "role": input.role,
                    "level": input.level,
                    "taxonomy": taxonomy_entries(),
                },
                await self._ctx.ctx(on_progress=on_progress),
            ),
            self._workspace.profile_company(input),
        )
        target = await self._workspace.persist_target(input, output, profile)
        if on_progress is not None:
            on_progress(ProgressUpdate(stage="calculating gaps"))
            on_progress(ProgressUpdate(stage="building prep plan"))
        plan = await self._preparation.build_preparation_plan_internal()
        self._ctx.logger.info(
            "workflow.completed", {"workflow": "addTarget", "targetId": target.id}
        )
        return TargetPlanResult(target=target, actions=plan.actions)

    async def activate_target(self, id: str) -> TargetPlanResult:
        row = self._ctx.store.get_target(id)
        if row is None:
            raise AppError("NOT_FOUND", f"no target {id}")
        self._ctx.store.activate_target(id)
        self._ctx.bump_ui_epoch()
        await self._record_usage_event("target.switched")
        self._ctx.logger.info("state.mutated", {"entity": "target", "id": id, "active": True})
        open_actions = self._ctx.store.list_actions("open", id)
        actions = [row_to_action(action.model_dump()) for action in open_actions]
        if not open_actions:
            plan = await self._preparation.build_preparation_plan_internal()
            actions = plan.actions
        target = TargetRole.model_validate(row.data)
        return TargetPlanResult(target=target, actions=actions)

    async def list_company_profiles(self) -> list[CompanyProfile]:
        """§9.3/v0.4: built-in + pack-compiled company profiles (with disclaimers)."""

        packs = self._packs()
        packs.ensure_loaded()
        return packs.list_company_profiles()

    async def update_target_company_profile(
        self, target_id: str, company_profile_id: str
    ) -> TargetPlanResult:
        """§9.3: change a target's company profile. Importances are recomputed from
        the JD-analyzer `baseImportance` so boosts never compound; the notes
        overlay (§8.4) re-applies on top. Then readiness + plan rebuild.
        """

        row = self._ctx.store.get_target(target_id)
        if row is None:
            raise AppError("NOT_FOUND", f"no target {target_id}")
        packs = self._packs()
        await packs.ready()
        if not any(profile.id == company_profile_id for profile in packs.list_company_profiles()):
            raise AppError("VALIDATION", f'unknown company profile "{company_profile_id}"')
        target = TargetRole.model_validate(row.data)
        target.company_profile_id = company_profile_id
        notes_focus = (
            set(target.company_profile.focus_skill_ids)
            if target.company_profile is not None
            else set()
        )
        requirements: list[Requirement] = []
        for req in target.requirements:
            requirements.append(
                await self._workspace.apply_requirement_boosts(
                    req, company_profile_id, notes_focus
                )
            )
        target.requirements = requirements
        preferred_skills: list[Requirement] = []
        for req in target.preferred_skills:
            preferred_skills.append(
                await self._workspace.apply_requirement_boosts(
                    req, company_profile_id, notes_focus
                )
            )
        target.preferred_skills = preferred_skills
        self._ctx.store.update_target_data(target_id, target)
        self._ctx.logger.info(
            "state.mutated",
            {"entity": "target", "id": target_id, "companyProfileId": company_profile_id},
        )
        await self._readiness.recompute_readiness_internal("company-profile")
        plan = await self._preparation.build_preparation_plan_internal()
        return TargetPlanResult(target=target, actions=plan.actions)

    async def set_target_role_pack(
        self, target_id: str, role_pack_id: str | None
    ) -> TargetPlanResult:
        """v0.4: assign/clear a role pack. Pack dimensions join the requirements as
        `origin: "role_pack"` entries (importance = weight, never compounded);
        re-applying replaces prior role-pack requirements rather than stacking.
        """

        row = self._ctx.store.get_target(target_id)
        if row is None:
            raise AppError("NOT_FOUND", f"no target {target_id}")
        packs = self._packs()
        await packs.ready()
        pack = packs.role_pack(role_pack_id) if role_pack_id else None
        if role_pack_id and pack is None:
            raise AppError("VALIDATION", f'unknown role pack "{role_pack_id}"')
        target = TargetRole.model_validate(row.data)
        target.role_pack_id = role_pack_id
        if pack is not None and pack.taxonomy:
            taxonomy.register_nodes(
                [
                    TaxonomyNodeSeed(id=node.id, label=node.label, keywords=list(node.keywords))
                    for node in pack.taxonomy
                ]
            )
            for node in pack.taxonomy:
                self._ctx.register_skill_node(node.id)
        # drop previous role-pack requirements, then re-add the new pack's dims
        target.requirements = [
            req for req in target.requirements if req.origin != "role_pack"
        ]
        if pack is not None:
            have = {req.skill_id for req in self._ctx.all_requirements(target)}
            for dim in pack.dimensions:
                if dim.skill_id in have:
                    continue
                target.requirements.append(
                    Requirement(
                        skill_id=dim.skill_id,
                        label=taxonomy.label_for(dim.skill_id),
                        importance=dim.weight,
                        base_importance=dim.weight,
                        kind=RequirementKind.REQUIRED,
                        evidence=f'role pack "{pack.name}"',
                        boosted_by=f"role-pack:{pack.id}",
                        origin="role_pack",
                    )
                )
                self._ctx.register_skill_node(dim.skill_id)
        # re-apply company emphasis + notes overlay on top (non-compounding)
        notes_focus = (
            set(target.company_profile.focus_skill_ids)
            if target.company_profile is not None
            else set()
        )
        requirements: list[Requirement] = []
        for req in target.requirements:
            requirements.append(
                await self._workspace.apply_requirement_boosts(
                    req, target.company_profile_id, notes_focus
                )
            )
        target.requirements = requirements
        preferred_skills: list[Requirement] = []
        for req in target.preferred_skills:
            preferred_skills.append(
                await self._workspace.apply_requirement_boosts(
                    req, target.company_profile_id, notes_focus
                )
            )
        target.preferred_skills = preferred_skills
        self._ctx.store.update_target_data(target_id, target)
        self._ctx.logger.info(
            "state.mutated",
            {"entity": "target", "id": target_id, "rolePackId": role_pack_id},
        )
        await self._readiness.recompute_readiness_internal("role-pack")
        plan = await self._preparation.build_preparation_plan_internal()
        return TargetPlanResult(target=target, actions=plan.actions)

    def _packs(self) -> PackRegistry:
        packs = self._ctx.packs
        if packs is None:
            raise AppError("VALIDATION", "no pack registry configured")
        return packs
