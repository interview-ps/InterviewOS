"""Workspace service — port of `apps/server/src/orchestrator/workspace-service.ts`."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable
from typing import TYPE_CHECKING

from ...ai.interface import ProgressUpdate
from ...core import new_id
from ...core.js_compat import js_round
from ...core.models import (
    AppError,
    CamelModel,
    CandidateProfile,
    CompanyNotesProfile,
    Gap,
    Level,
    Requirement,
    TargetRole,
)
from ...skills import (
    SkillRuntimeError,
    company_profiler,
    jd_analyzer,
    resume_analyzer,
    taxonomy_entries,
)
from ...skills.analyze.jd_analyzer import JdAnalyzerOutput
from ...skills.analyze.resume_analyzer import ResumeAnalyzerOutput
from ..context import ProgressOptions, WorkflowContext
from ..projection import PrepActionRowLike
from .preparation import PreparationService
from .readiness import ReadinessService

if TYPE_CHECKING:
    from ...packs.registry import PackRegistry

__all__ = [
    "SetupWorkspaceInput",
    "SetupWorkspaceResult",
    "TargetInput",
    "WorkspaceService",
]


async def _no_company_profile() -> None:
    return None


class TargetInput(CamelModel):
    job_description: str
    company: str
    role: str
    level: Level
    company_notes: str | None = None


class SetupWorkspaceInput(TargetInput):
    """A new target plus the resume to seed the active candidate."""

    resume_text: str


class SetupWorkspaceResult(CamelModel):
    candidate: CandidateProfile
    target: TargetRole
    gaps: list[Gap]
    actions: list[PrepActionRowLike]


class WorkspaceService:
    def __init__(
        self,
        ctx: WorkflowContext,
        readiness: ReadinessService,
        preparation: PreparationService,
    ) -> None:
        self._ctx = ctx
        self._readiness = readiness
        self._preparation = preparation

    async def setup_workspace(
        self, input: SetupWorkspaceInput, opts: ProgressOptions | None = None
    ) -> SetupWorkspaceResult:
        self._ctx.logger.info("workflow.started", {"workflow": "setupWorkspace"})
        on_progress = opts.on_progress if opts is not None else None
        try:
            # resume and JD analysis are independent — run them concurrently;
            # persistence stays sequential.
            if on_progress is not None:
                on_progress(ProgressUpdate(stage="analyzing resume"))
                on_progress(ProgressUpdate(stage="analyzing job description"))
            notes = input.company_notes
            if notes is not None and notes.strip():
                if on_progress is not None:
                    on_progress(ProgressUpdate(stage="profiling company"))
                profile_task: Awaitable[CompanyNotesProfile | None] = self._ctx.host.invoke(
                    company_profiler,
                    {
                        "company": input.company,
                        "companyNotes": notes,
                        "taxonomy": taxonomy_entries(),
                    },
                    await self._ctx.ctx(on_progress=on_progress),
                )
            else:
                profile_task = _no_company_profile()
            candidate_out, target_out, company_profile = await asyncio.gather(
                self._ctx.host.invoke(
                    resume_analyzer,
                    {"resumeText": input.resume_text, "taxonomy": taxonomy_entries()},
                    await self._ctx.ctx(on_progress=on_progress),
                ),
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
                profile_task,
            )
            candidate = await self.persist_candidate(input.resume_text, candidate_out)
            target = await self.persist_target(input, target_out, company_profile)
            await self._readiness.recompute_readiness_internal("setup")
            if on_progress is not None:
                on_progress(ProgressUpdate(stage="calculating gaps"))
            gaps = await self._readiness.calculate_gaps_internal()
            if on_progress is not None:
                on_progress(ProgressUpdate(stage="building prep plan"))
            plan = await self._preparation.build_preparation_plan_internal()
            self._ctx.logger.info("workflow.completed", {"workflow": "setupWorkspace"})
            return SetupWorkspaceResult(
                candidate=candidate, target=target, gaps=gaps, actions=plan.actions
            )
        except Exception as err:  # noqa: BLE001 - logged, then re-raised unchanged
            detail: dict[str, object] = {
                "workflow": "setupWorkspace",
                "error": str(err),
            }
            if isinstance(err, SkillRuntimeError):
                detail["skill"] = err.task_id
                detail["runtimeCode"] = err.runtime_code
            self._ctx.logger.warn("workflow.failed", detail)
            raise

    async def analyze_candidate_internal(self, resume_text: str) -> CandidateProfile:
        output = await self._ctx.host.invoke(
            resume_analyzer,
            {"resumeText": resume_text, "taxonomy": taxonomy_entries()},
            await self._ctx.ctx(),
        )
        return await self.persist_candidate(resume_text, output)

    async def persist_candidate(
        self, resume_text: str, output: ResumeAnalyzerOutput
    ) -> CandidateProfile:
        # §9.6: the skill's outputs persist candidate profile + evidence + stories.
        self._ctx.host.assert_can("resume-analyzer", "candidate.write")
        self._ctx.host.assert_can("resume-analyzer", "evidence.write")
        self._ctx.host.assert_can("resume-analyzer", "stories.write")
        candidate = CandidateProfile(
            id=new_id("cand"),
            name=output.name,
            headline=output.headline,
            experience=output.experience,
            skills=output.skills,
            projects=output.projects,
            achievements=output.achievements,
            education=output.education,
            star_stories=output.star_stories,
        )
        # Atomic swap: never leave the workspace with no active candidate.
        with self._ctx.store.transaction() as tx:
            tx.deactivate_candidates()
            tx.insert_candidate(
                id=candidate.id,
                active=1,
                name=candidate.name,
                headline=candidate.headline,
                resume_text=resume_text,
                data=candidate,
                created_at=self._ctx.iso(),
            )
            # STAR stories extracted from the resume seed the story bank (§8.4)
            for story in candidate.star_stories:
                tx.insert_story(
                    id=new_id("story"),
                    candidate_id=candidate.id,
                    title=story.title,
                    situation=story.situation,
                    task=story.task,
                    action=story.action,
                    result=story.result,
                    skill_ids=story.skill_ids,
                    source="resume",
                    updated_at=self._ctx.iso(),
                )
            created_at = self._ctx.iso()
            for skill in candidate.skills:
                self._ctx.register_skill_node(skill.skill_id, tx)
                tx.insert_evidence(
                    id=new_id("ev"),
                    candidate_id=candidate.id,
                    skill_id=skill.skill_id,
                    type="resume_claim",
                    score=skill.level,
                    confidence=0.5,
                    observation=skill.evidence,
                    created_at=created_at,
                )
            self._ctx.logger.info("state.mutated", {"entity": "candidate", "id": candidate.id})
            return candidate

    async def profile_company(self, input: TargetInput) -> CompanyNotesProfile | None:
        """§8.4: profile the company when untrusted notes were supplied."""

        notes = input.company_notes
        if notes is None or not notes.strip():
            return None
        output: CompanyNotesProfile = await self._ctx.host.invoke(
            company_profiler,
            {
                "company": input.company,
                "companyNotes": notes,
                "taxonomy": taxonomy_entries(),
            },
            await self._ctx.ctx(),
        )
        return output

    async def analyze_target_internal(self, input: TargetInput) -> TargetRole:
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
                await self._ctx.ctx(),
            ),
            self.profile_company(input),
        )
        return await self.persist_target(input, output, profile)

    async def apply_requirement_boosts(
        self,
        req: Requirement,
        company_profile_id: str | None,
        notes_focus: set[str],
    ) -> Requirement:
        """§9.3 importance: recompute from `baseImportance` (the JD-analyzer value)
        so boosts never compound. Built-in profile emphasis applies
        `boostedBy: "company-profile:<id>"`; the pasted-notes overlay keeps the
        v0.2 `+0.05` / `"company-profile"` semantics.
        """

        base = req.base_importance if req.base_importance is not None else req.importance
        profile = self._packs().company_profile(company_profile_id) if company_profile_id else None
        importance = base
        boosted_by: str | None = None
        emphasis = (
            next((item for item in profile.emphasis if item.skill_id == req.skill_id), None)
            if profile is not None
            else None
        )
        if emphasis is not None and profile is not None and profile.id != "generic":
            importance = min(0.95, importance + emphasis.weight)
            boosted_by = f"company-profile:{profile.id}"
        if req.skill_id in notes_focus:
            importance = min(0.95, importance + 0.05)
            boosted_by = boosted_by if boosted_by is not None else "company-profile"
        return req.model_copy(
            update={
                "base_importance": base,
                "importance": js_round(importance * 100) / 100,
                "boosted_by": boosted_by,
            }
        )

    async def persist_target(
        self,
        input: TargetInput,
        output: JdAnalyzerOutput,
        company_profile: CompanyNotesProfile | None = None,
    ) -> TargetRole:
        # §9.6: skill outputs persist the target row (+ its notes-derived profile).
        self._ctx.host.assert_can("jd-analyzer", "target.write")
        if company_profile is not None:
            self._ctx.host.assert_can("company-profiler", "target.write")
        # §9.3: auto-match a company profile (built-ins + packs); §8.4 notes profile
        # stays an overlay.
        packs = self._packs()
        await packs.ready()
        profile_id = packs.match_company_profile(input.company).id
        notes_focus = set(company_profile.focus_skill_ids) if company_profile is not None else set()
        requirements: list[Requirement] = []
        for req in output.requirements:
            requirements.append(await self.apply_requirement_boosts(req, profile_id, notes_focus))
        preferred_skills: list[Requirement] = []
        for req in output.preferred_skills:
            preferred_skills.append(
                await self.apply_requirement_boosts(req, profile_id, notes_focus)
            )
        target = TargetRole(
            id=new_id("target"),
            company=input.company,
            role=input.role,
            level=input.level,
            job_description=input.job_description,
            company_notes=input.company_notes,
            requirements=requirements,
            preferred_skills=preferred_skills,
            company_profile=company_profile,
            company_profile_id=profile_id,
        )
        # Atomic swap: never leave the workspace with no active target.
        with self._ctx.store.transaction() as tx:
            tx.deactivate_targets()
            tx.insert_target(
                id=target.id,
                active=1,
                company=target.company,
                role=target.role,
                level=target.level,
                job_description=target.job_description,
                data=target,
                created_at=self._ctx.iso(),
            )
            for req in [*target.requirements, *target.preferred_skills]:
                self._ctx.register_skill_node(req.skill_id, tx)
            self._ctx.logger.info("state.mutated", {"entity": "target", "id": target.id})
            return target

    def _packs(self) -> PackRegistry:
        packs = self._ctx.packs
        if packs is None:
            raise AppError("VALIDATION", "no pack registry configured")
        return packs
