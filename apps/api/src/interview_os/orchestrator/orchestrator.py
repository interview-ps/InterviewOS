"""InterviewOrchestrator facade — port of `apps/server/src/orchestrator/orchestrator.ts`.

The single public surface the HTTP layer (phase 6) and the feedback-loop test
depend on. Every mutating entrypoint runs inside a lock scope; plugin events are
fire-and-forget on a serialized queue.

Locking: `LockManager` supports `global` (one lock for every scope — the parity
mode used through phases 5–8 and the default) and `fine` (one lock per scope
key, acquired in a total order). See design §8.1.
"""

from __future__ import annotations

import asyncio
import contextvars
import os
from collections.abc import AsyncIterator, Callable, Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from ..ai.interface import AIRuntime
from ..ai.logger import Logger
from ..ai.mock import MockRuntime
from ..core.models import (
    AppError,
    CamelModel,
    CandidateProfile,
    CompanyProfile,
    Gap,
    InterviewEvent,
    InterviewStatus,
    Permission,
    PluginCapability,
    ReadinessGraph,
    ResumeReview,
    SkillManifest,
    TargetRole,
    UINode,
)
from ..packs.registry import InstallablePackKind, PackDirs, PackRegistry
from ..skills import SkillHost, install_mode_mock_fallback, register_builtin_skills
from ..skills.host import PluginExecutor
from ..store.store import RuntimeSessionRow, SessionRow, Store
from .context import ProgressOptions, WorkflowContext
from .projection import OrchestratorQuestion, PrepActionRowLike
from .services import (
    AcceptPluginSuggestionResult,
    AdvanceLoopResult,
    AvailableMode,
    CompleteActionResult,
    DebriefService,
    EvaluationReviewsArgs,
    ExportService,
    HistoryService,
    InterviewService,
    InterviewServiceDeps,
    LoopService,
    McpService,
    NextQuestionResult,
    OrchestratorSettings,
    PackService,
    PluginDirs,
    PluginInterviewModeRef,
    PluginPrepSuggestionGroup,
    PluginRegistrationMeta,
    PluginReview,
    PluginRunResult,
    PluginService,
    PluginUIContributionView,
    PluginUIRenderRequest,
    PluginUIRunResult,
    PluginView,
    PreparationService,
    PreparationServiceDeps,
    ReadinessService,
    ResolvedUIFrame,
    ResumeService,
    SettingsService,
    SetupWorkspaceInput,
    SetupWorkspaceResult,
    StartInterviewInput,
    StoryService,
    SubmitAnswerInput,
    SubmitAnswerResult,
    TargetInput,
    TargetPlanResult,
    TargetService,
    UIFrameRunSelector,
    UIFrameSelector,
    WorkspaceService,
)
from .services.history import HistoryFilters
from .services.mcp import McpServerPatch
from .services.pack import CreateInterviewPackInput, QuestionBankItem
from .services.preparation import PreparationPlan
from .services.story import StoryPatch

__all__ = ["InterviewOrchestrator", "LockManager", "OrchestratorDeps"]

_LOCK_GLOBAL = "global"

#: Keys already held by the current task (the no-nesting guard, design §8.1).
_HELD_KEYS: contextvars.ContextVar[frozenset[str]] = contextvars.ContextVar(
    "interview_os_held_lock_keys", default=frozenset()
)


class LockManager:
    """Aggregate-lock manager (design §8.1).

    `global` (the parity default) maps every scope to one lock. `fine` acquires
    one lock per scope key, in a total order (sorted keys) so concurrent
    acquisitions cannot deadlock; keys default to `global` when a caller passes
    none, so an unkeyed call still serializes with everything. Nesting with new
    keys is rejected; re-entering only already-held keys is allowed.
    """

    MODES = ("global", "fine")

    def __init__(self, mode: str | None = None) -> None:
        resolved = mode or os.environ.get("INTERVIEW_OS_LOCK_MODE", "global")
        self.mode = resolved if resolved in self.MODES else "global"
        self._locks: dict[str, asyncio.Lock] = {}

    def lock_for(self, key: str) -> asyncio.Lock:
        lock = self._locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[key] = lock
        return lock

    @asynccontextmanager
    async def hold(self, *keys: str) -> AsyncIterator[None]:
        if self.mode == "global":
            async with self.lock_for(_LOCK_GLOBAL):
                yield
            return

        wanted = frozenset(key for key in keys if key) or frozenset({_LOCK_GLOBAL})
        ordered = sorted(wanted)
        held = _HELD_KEYS.get()
        if held:
            if wanted <= held:
                yield  # re-entrant: every requested key is already held
                return
            raise RuntimeError(
                "nested lock acquisition with new keys is not allowed (design §8.1)"
            )

        acquired: list[str] = []
        try:
            for key in ordered:
                await self.lock_for(key).acquire()
                acquired.append(key)
            token = _HELD_KEYS.set(wanted)
            try:
                yield
            finally:
                _HELD_KEYS.reset(token)
        finally:
            for key in reversed(acquired):
                self.lock_for(key).release()


@dataclass
class OrchestratorDeps:
    store: Store
    runtime: AIRuntime
    logger: Logger
    now: Callable[[], datetime] | None = None
    #: v0.4: plugin dirs for install/uninstall; omit to disable those paths.
    plugin_dirs: PluginDirs | None = None
    #: v0.4: pack dirs; omit → only built-in profiles exist.
    pack_dirs: PackDirs | None = None
    #: v0.4: MCP manager; omit → MCP surfaces empty/disabled.
    mcp: Any = None
    lock_mode: str | None = None


class CompleteInterviewResult(CamelModel):
    session: SessionRow | None
    debrief: Any
    loop: Any
    next_session: SessionRow | None
    next_question: OrchestratorQuestion | None


class InterviewOrchestrator:
    def __init__(self, deps: OrchestratorDeps) -> None:
        self._store = deps.store
        self._runtime = deps.runtime
        self._logger = deps.logger
        self._now: Callable[[], datetime] = deps.now or (lambda: datetime.now(UTC))
        self._locks = LockManager(deps.lock_mode)

        self.host = SkillHost(deps.logger)
        register_builtin_skills(self.host)

        self._workflow = WorkflowContext(
            store=self._store,
            host=self.host,
            runtime=self._runtime,
            logger=self._logger,
            now=self._now,
            packs=PackRegistry(deps.pack_dirs, deps.logger),
        )

        self._settings = SettingsService(self._workflow, self._runtime)
        self._readiness = ReadinessService(
            self._workflow,
            on_readiness_changed=self._on_readiness_changed,
        )
        self._preparation = PreparationService(
            self._workflow,
            self._readiness,
            deps=PreparationServiceDeps(
                run_resource_plugin=self._run_resource_plugin,
                enabled_resource_plugins=lambda: self._plugins.enabled_capability_ids(
                    PluginCapability.RESOURCES
                ),
            ),
        )
        self._workspace = WorkspaceService(self._workflow, self._readiness, self._preparation)
        self._targets = TargetService(
            self._workflow,
            self._readiness,
            self._preparation,
            self._workspace,
            record_usage_event=self._record_usage_event,
        )
        self._resume = ResumeService(
            self._workflow,
            calculate_gaps=self._calculate_gaps_internal,
            record_usage_event=self._record_usage_event,
        )
        self._stories = StoryService(self._workflow)
        self._plugins = PluginService(
            self._workflow,
            graph_for_active=self._graph_for_active,
            calculate_gaps=self._calculate_gaps_internal,
            recompute_readiness=self._recompute_readiness_internal,
            plugin_dirs=deps.plugin_dirs,
        )
        self._debrief = DebriefService(self._workflow)
        self._history = HistoryService(
            self._workflow, graph_for_active=self._readiness.graph_for_active
        )
        self._interview = InterviewService(
            self._workflow,
            self._readiness,
            self._preparation,
            deps=InterviewServiceDeps(
                loop_context_for=lambda session: self._loop.loop_context_for(session),
                run_question_plugin=self._run_question_plugin,
                enabled_question_plugins=lambda: self._plugins.enabled_capability_ids(
                    PluginCapability.QUESTION_SOURCE
                ),
                plugin_interview_mode=self._plugin_interview_mode,
                evaluation_reviews=self._evaluation_reviews,
                persist_plugin_evidence=self._persist_plugin_evidence,
                mode_hook=lambda mode_id, hook, req: self._plugins.mode_hook(mode_id, hook, req),
            ),
        )
        self._loop = LoopService(self._workflow, self._readiness, self._interview)
        self._packs = PackService(
            self._workflow,
            start_loop=lambda input, opts: self._loop.start_loop(input, opts),
        )
        self._mcp = McpService(self._workflow, deps.mcp)
        self._exporter = ExportService(self._workflow)
        self._exporter.recompute_after_import = lambda: self._recompute_readiness_internal("import")

        # v1: plugin-mode mock tasks resolve through mode.mock hooks.
        if isinstance(self._runtime, MockRuntime):
            install_mode_mock_fallback(
                self._runtime,
                lambda task_id, value: self._plugins.mode_mock_fallback(task_id, value),
            )

        self._event_queue: asyncio.Task[None] | None = None

    # ------------------------------------------------------------- lock helper

    def _hold(self, *keys: str) -> Any:
        return self._locks.hold(*(keys or (_LOCK_GLOBAL,)))

    # ------------------------------------------------------------ plugin events

    def _on_readiness_changed(self, changed_skill_ids: list[str], reason: str) -> None:
        # Loop guard: plugin-caused recomputes never re-fire events back.
        if reason.startswith("plugin"):
            return
        self._enqueue_plugin_event(
            "events.readinessUpdated", {"changedSkillIds": changed_skill_ids}
        )

    def _enqueue_plugin_event(self, name: str, payload: object) -> None:
        previous = self._event_queue

        async def run() -> None:
            if previous is not None:
                try:
                    await previous
                except Exception:  # noqa: BLE001 - the chain must never break
                    pass
            await self._dispatch_plugin_event(name, payload)

        self._event_queue = asyncio.create_task(run())

    async def flush_plugin_events(self) -> None:
        if self._event_queue is not None:
            await self._event_queue

    async def _dispatch_plugin_event(self, name: str, payload: object) -> None:
        try:
            fired = await self._plugins.fire_plugin_event(name, payload)
            for item in fired:
                plugin_id = str(item["pluginId"])
                proposals = item.get("proposals")
                async with self._hold():
                    result = await self._plugins.persist_plugin_evidence(
                        plugin_id, list(proposals) if isinstance(proposals, list) else []
                    )
                    if result.written > 0:
                        await self._recompute_readiness_internal(f"plugin-event:{plugin_id}")
        except Exception as err:  # noqa: BLE001 - fire-and-forget
            self._logger.warn(
                "plugin.events_failed", {"event": name, "error": str(err)[:200]}
            )

    def _enqueue_target_changed(self) -> None:
        async def run() -> None:
            row = self._store.get_active_target()
            if row is None:
                return
            data = row.data
            payload: dict[str, object] = {"targetId": row.id, "role": data.role}
            if data.company:
                payload["company"] = data.company
            self._enqueue_plugin_event("events.targetChanged", payload)

        asyncio.create_task(run())

    async def _run_resource_plugin(self, plugin_id: str, request: object) -> object:
        output, _granted = await self._plugins.invoke_hook(
            plugin_id, "resources.suggest", request
        )
        return output

    async def _run_question_plugin(self, plugin_id: str, request: object) -> object:
        output, _granted = await self._plugins.invoke_hook(plugin_id, "questions.suggest", request)
        return output

    async def _persist_plugin_evidence(
        self, plugin_id: str, proposals: list[object]
    ) -> object:
        return await self._plugins.persist_plugin_evidence(plugin_id, proposals)

    async def _plugin_interview_mode(self, plugin_mode_id: str) -> PluginInterviewModeRef:
        ref = await self._plugins.plugin_interview_mode(plugin_mode_id)
        return PluginInterviewModeRef(plugin_id=ref.plugin_id, mode=ref.mode)

    async def _evaluation_reviews(self, args: Mapping[str, object]) -> list[PluginReview]:
        reviews = await self._plugins.evaluation_reviews(
            EvaluationReviewsArgs.model_validate(args)
        )
        return [
            PluginReview(
                plugin_id=r.plugin_id,
                plugin_name=r.plugin_name,
                observations=list(r.observations),
                evidence_proposals=list(r.evidence_proposals),
            )
            for r in reviews
        ]

    # ----------------------------------------------------------------- settings

    async def get_settings(self) -> OrchestratorSettings:
        return await self._settings.get_settings()

    async def update_settings(self, patch: Mapping[str, object]) -> OrchestratorSettings:
        async with self._hold():
            return await self._settings.update_settings(patch)

    # ----------------------------------------------------------------- pipeline

    async def setup_workspace(
        self, input: SetupWorkspaceInput, opts: ProgressOptions | None = None
    ) -> SetupWorkspaceResult:
        async with self._hold():
            result = await self._workspace.setup_workspace(input, opts)
        self._enqueue_target_changed()
        return result

    async def analyze_candidate(self, resume_text: str) -> CandidateProfile:
        async with self._hold():
            return await self._workspace.analyze_candidate_internal(resume_text)

    async def analyze_target(self, input: TargetInput) -> TargetRole:
        async with self._hold():
            target = await self._workspace.analyze_target_internal(input)
        self._enqueue_target_changed()
        return target

    # ------------------------------------------------------------------ targets

    async def list_targets(self):  # type: ignore[no-untyped-def]
        return await self._targets.list_targets()

    async def add_target(
        self, input: TargetInput, opts: ProgressOptions | None = None
    ) -> TargetPlanResult:
        async with self._hold():
            result = await self._targets.add_target(input, opts)
        self._enqueue_target_changed()
        return result

    async def activate_target(self, id: str) -> TargetPlanResult:
        async with self._hold():
            result = await self._targets.activate_target(id)
        self._enqueue_target_changed()
        return result

    async def list_company_profiles(self) -> list[CompanyProfile]:
        return await self._targets.list_company_profiles()

    async def update_target_company_profile(
        self, target_id: str, company_profile_id: str
    ) -> TargetPlanResult:
        async with self._hold():
            return await self._targets.update_target_company_profile(target_id, company_profile_id)

    async def set_target_role_pack(
        self, target_id: str, role_pack_id: str | None
    ) -> TargetPlanResult:
        async with self._hold():
            return await self._targets.set_target_role_pack(target_id, role_pack_id)

    # ---------------------------------------------------------------- readiness

    async def _graph_for_active(self) -> ReadinessGraph:
        return self._readiness.graph_for_active()

    async def recompute_readiness(self, reason: str) -> ReadinessGraph:
        async with self._hold():
            return await self._recompute_readiness_internal(reason)

    async def _recompute_readiness_internal(self, reason: str) -> ReadinessGraph:
        return await self._readiness.recompute_readiness_internal(reason)

    async def calculate_gaps(self) -> list[Gap]:
        async with self._hold():
            return await self._calculate_gaps_internal()

    async def _calculate_gaps_internal(self) -> list[Gap]:
        return await self._readiness.calculate_gaps_internal()

    # ------------------------------------------------------------ gaps + plan

    async def build_preparation_plan(self) -> list[PrepActionRowLike]:
        async with self._hold():
            plan = await self._build_preparation_plan_internal()
        return plan.actions

    async def _build_preparation_plan_internal(self) -> PreparationPlan:
        return await self._preparation.build_preparation_plan_internal()

    # ------------------------------------------------------------- interviews

    def list_modes(self) -> list[AvailableMode]:
        return self._interview.list_modes()

    def platform_info(self) -> dict[str, Any]:
        return self._plugins.platform_info()

    async def start_interview(
        self,
        input: Mapping[str, object] | StartInterviewInput | None = None,
        opts: ProgressOptions | None = None,
    ) -> NextQuestionResult:
        async with self._hold():
            return await self._interview.start_interview_internal(
                input if input is not None else {}, opts
            )

    async def next_question(
        self, session_id: str, opts: ProgressOptions | None = None
    ) -> NextQuestionResult:
        async with self._hold():
            return await self._interview.next_question_internal(session_id, opts)

    async def submit_answer(
        self,
        session_id: str,
        answer: str | SubmitAnswerInput | Mapping[str, object],
        opts: ProgressOptions | None = None,
    ) -> SubmitAnswerResult:
        async with self._hold():
            result = await self._interview.submit_answer(session_id, answer, opts)
        await self._enqueue_answer_evaluated(session_id, result)
        return result

    async def _enqueue_answer_evaluated(
        self, session_id: str, result: SubmitAnswerResult
    ) -> None:
        evaluations = self._store.list_evaluations(session_id)
        last = evaluations[-1] if evaluations else None
        question = self._store.get_question(last.question_id) if last is not None else None
        session = self._store.get_session(session_id)
        if last is None or question is None or session is None:
            return
        self._enqueue_plugin_event(
            "events.answerEvaluated",
            {
                "sessionId": session_id,
                "questionId": last.question_id,
                "skillId": question.skill_id,
                "roundType": session.round_type or "mixed",
                "rubric": [{"id": r.id, "score": r.score} for r in result.evaluation.rubric],
                "scores": [{"skill": s.skill, "score": s.score} for s in result.evaluation.scores],
            },
        )

    async def complete_interview(
        self, session_id: str, opts: ProgressOptions | None = None
    ) -> CompleteInterviewResult:
        async with self._hold():
            session = self._store.get_session(session_id)
            if session is None:
                raise AppError("NOT_FOUND", f"no session {session_id}")
            status = session.status
            if status in (InterviewStatus.FOLLOW_UP.value, InterviewStatus.QUESTION.value):
                self._workflow.transition_session(
                    session_id, InterviewStatus.COMPLETE, InterviewEvent.COMPLETE
                )
                self._store.update_session(session_id, {"completed_at": self._workflow.iso()})
            debrief = await self._create_debrief_internal(session_id, opts)
            loop = None
            next_session = None
            next_question = None
            if session.loop_id:
                adv = await self._advance_loop_internal(session_id, opts)
                loop = adv.loop
                next_session = adv.next_session
                next_question = adv.next_question
            result = CompleteInterviewResult(
                session=self._store.get_session(session_id),
                debrief=debrief,
                loop=loop,
                next_session=next_session,
                next_question=next_question,
            )
        self._enqueue_plugin_event(
            "events.sessionCompleted",
            {
                "sessionId": session_id,
                "roundType": (result.session.round_type if result.session else None) or "mixed",
                "scores": self._session_score_summary(session_id),
            },
        )
        if result.loop is not None and getattr(result.loop, "status", None) == "complete":
            self._enqueue_plugin_event(
                "events.loopCompleted",
                {
                    "loopId": result.loop.id,
                    "rounds": [
                        {"mode": r.mode, "sessionId": r.session_id}
                        for r in (result.loop.rounds or [])
                    ],
                },
            )
        return result

    def _session_score_summary(self, session_id: str) -> dict[str, dict[str, float]]:
        acc: dict[str, dict[str, float]] = {}
        for row in self._store.list_evaluations(session_id):
            for score in row.data.scores:
                entry = acc.setdefault(score.skill, {"total": 0.0, "answers": 0.0})
                entry["total"] += score.score
                entry["answers"] += 1
        return {
            skill: {"meanScore": e["total"] / e["answers"], "answers": e["answers"]}
            for skill, e in acc.items()
        }

    async def create_debrief(self, session_id: str, opts: ProgressOptions | None = None):  # type: ignore[no-untyped-def]
        async with self._hold():
            return await self._create_debrief_internal(session_id, opts)

    async def _create_debrief_internal(self, session_id: str, opts: ProgressOptions | None):  # type: ignore[no-untyped-def]
        return await self._debrief.create_debrief_internal(session_id, opts)

    # ------------------------------------------------------------------- loops

    async def start_loop(
        self,
        input: Mapping[str, object] | None = None,
        opts: ProgressOptions | None = None,
    ) -> Any:
        async with self._hold():
            return await self._loop.start_loop(input, opts)

    async def _advance_loop_internal(
        self, session_id: str, opts: ProgressOptions | None
    ) -> AdvanceLoopResult:
        return await self._loop.advance_loop_internal(session_id, opts)

    async def get_loop(self, id: str) -> Any:
        return await self._loop.get_loop(id)

    async def list_loops(self) -> Any:
        return await self._loop.list_loops()

    async def abandon_loop(self, id: str) -> Any:
        async with self._hold():
            return await self._loop.abandon_loop(id)

    # ------------------------------------------------------------------- packs

    async def list_packs(self) -> Any:
        return await self._packs.list_packs()

    async def install_pack_from_git(self, kind: InstallablePackKind, url: str) -> Any:
        async with self._hold():
            return await self._packs.install_pack_from_git(kind, url)

    async def uninstall_pack(self, kind: InstallablePackKind, id: str) -> None:
        async with self._hold():
            await self._packs.uninstall_pack(kind, id)

    async def list_interview_packs(self) -> Any:
        return await self._packs.list_interview_packs()

    async def get_interview_pack(self, id: str) -> Any:
        return await self._packs.get_interview_pack(id)

    async def create_interview_pack(self, input: object) -> Any:
        async with self._hold():
            return await self._packs.create_interview_pack(
                CreateInterviewPackInput.model_validate(input)
            )

    async def delete_interview_pack(self, id: str) -> None:
        async with self._hold():
            await self._packs.delete_interview_pack(id)

    async def export_interview_pack(self, id: str) -> Any:
        return await self._packs.export_interview_pack(id)

    async def import_interview_pack(self, content: str) -> Any:
        async with self._hold():
            return await self._packs.import_interview_pack(content)

    async def start_loop_from_pack(self, id: str, opts: ProgressOptions | None = None) -> Any:
        async with self._hold():
            return await self._packs.start_loop_from_pack(id, opts)

    # ----------------------------------------------------------- question bank

    async def list_question_bank(self) -> Any:
        return await self._packs.list_question_bank()

    async def add_user_question(self, item: object) -> Any:
        async with self._hold():
            return await self._packs.add_user_question(QuestionBankItem.model_validate(item))

    async def delete_user_question(self, id: str) -> None:
        async with self._hold():
            await self._packs.delete_user_question(id)

    async def import_question_bank(self, content: str) -> Any:
        async with self._hold():
            return await self._packs.import_question_bank(content)

    async def fetch_plugin_resources(self, action_id: str) -> PrepActionRowLike:
        async with self._hold():
            return await self._preparation.fetch_plugin_resources(action_id)

    # ----------------------------------------------------------------- queries

    async def get_state(self) -> Any:
        return await self._history.get_state()

    async def get_skill_detail(self, skill_id: str) -> Any:
        return await self._history.get_skill_detail(skill_id)

    async def list_interviews(self) -> Any:
        return await self._history.list_interviews()

    async def get_interview(self, id: str) -> Any:
        return await self._history.get_interview(id)

    async def record_usage_event(self, event: str) -> None:
        await self._history.record_usage_event(event)

    async def _record_usage_event(self, event: str) -> None:
        await self._history.record_usage_event(event)

    async def get_history(self, filters: Mapping[str, object] | None = None) -> Any:
        parsed = HistoryFilters.model_validate(filters) if filters is not None else None
        return await self._history.get_history(parsed)

    async def get_session_history(self, id: str) -> Any:
        return await self._history.get_session_history(id)

    async def get_metrics(self) -> Any:
        return await self._history.get_metrics()

    # -------------------------------------------------------------- preparation

    async def list_preparation_actions(self) -> list[PrepActionRowLike]:
        return await self._preparation.list_preparation_actions()

    async def complete_action(
        self, action_id: str, opts: Mapping[str, object] | None = None
    ) -> CompleteActionResult:
        async with self._hold():
            return await self._preparation.complete_action(action_id, opts)

    async def update_action_status(self, action_id: str, status: str) -> None:
        async with self._hold():
            await self._preparation.update_action_status(action_id, status)

    # ----------------------------------------------------------------- stories

    async def list_stories(self) -> Any:
        return await self._stories.list_stories()

    async def generate_stories(self, opts: ProgressOptions | None = None) -> Any:
        async with self._hold():
            return await self._stories.generate_stories(opts)

    async def update_story(self, id: str, patch: StoryPatch) -> Any:
        async with self._hold():
            return await self._stories.update_story(id, patch)

    async def coach_story(self, id: str, opts: ProgressOptions | None = None) -> Any:
        async with self._hold():
            return await self._stories.coach_story(id, opts)

    # ------------------------------------------------------------ resume coach

    async def review_resume(self, opts: ProgressOptions | None = None) -> ResumeReview:
        async with self._hold():
            return await self._resume.review_resume(opts)

    async def latest_resume_review(self) -> ResumeReview | None:
        return await self._resume.latest_resume_review()

    # ----------------------------------------------------------------- plugins

    def register_plugin(
        self,
        manifest: SkillManifest,
        executor: PluginExecutor,
        meta: PluginRegistrationMeta | None = None,
    ) -> None:
        self._plugins.register_plugin(manifest, executor, meta)

    def set_plugin_load_errors(self, errors: list[Any]) -> None:
        self._plugins.set_plugin_load_errors(errors)

    async def sync_plugin_modes(self) -> None:
        async with self._hold():
            await self._plugins.sync_plugin_modes()

    async def plugin_mode_mock_fallback(self, task_id: str, input: object) -> object | None:
        return await self._plugins.mode_mock_fallback(task_id, input)

    async def register_skill_node(self, skill_id: str) -> None:
        async with self._hold():
            self._workflow.register_skill_node(skill_id)

    def list_skill_manifests(self) -> list[SkillManifest]:
        return self._plugins.list_skill_manifests()

    async def list_plugins(self) -> list[PluginView]:
        return await self._plugins.list_plugins()

    async def set_plugin_enabled(
        self, id: str, enabled: bool, granted_permissions: list[Permission] | None = None
    ) -> PluginView:
        async with self._hold():
            return await self._plugins.set_plugin_enabled(id, enabled, granted_permissions)

    async def install_plugin_from_git(self, url: str) -> PluginView:
        async with self._hold():
            return await self._plugins.install_plugin_from_git(url)

    async def uninstall_plugin(self, id: str) -> None:
        async with self._hold():
            await self._plugins.uninstall_plugin(id)

    async def invoke_plugin_hook(self, id: str, hook: str, req: object) -> object:
        output, _granted = await self._plugins.invoke_hook(id, hook, req)
        return output

    def plugin_settings_spec(self, id: str) -> Any:
        return self._plugins.plugin_settings_spec(id)

    async def get_plugin_settings(self, id: str) -> dict[str, object]:
        return await self._plugins.get_plugin_settings(id)

    async def set_plugin_settings(
        self, id: str, values: Mapping[str, object]
    ) -> dict[str, object]:
        async with self._hold():
            return await self._plugins.set_plugin_settings(id, values)

    async def plugin_prep_suggestions(self) -> list[PluginPrepSuggestionGroup]:
        return await self._plugins.plugin_prep_suggestions()

    async def accept_plugin_suggestion(
        self, plugin_id: str, activity: object
    ) -> AcceptPluginSuggestionResult:
        async with self._hold():
            return await self._plugins.accept_plugin_suggestion(plugin_id, activity)

    async def sync_plugin_packs(self) -> None:
        await self._plugins.sync_plugin_packs()

    async def find_plugins_by_capability(self, cap: PluginCapability) -> list[SkillManifest]:
        return await self._plugins.find_plugins_by_capability(cap)

    async def run_plugin(self, id: str, request: object | None = None) -> PluginRunResult:
        async with self._hold():
            return await self._plugins.run_plugin(id, request)

    async def render_plugin_ui(self, id: str, req: PluginUIRenderRequest) -> UINode:
        return await self._plugins.render_plugin_ui(id, req)

    async def list_ui_contributions(self) -> list[PluginUIContributionView]:
        return await self._plugins.list_ui_contributions()

    async def resolve_ui_frame(self, id: str, sel: UIFrameSelector) -> ResolvedUIFrame:
        return await self._plugins.resolve_ui_frame(id, sel)

    async def resolve_ui_asset_dir(self, id: str) -> str:
        return await self._plugins.resolve_ui_asset_dir(id)

    async def plugin_ui_data(self, id: str, sel: UIFrameSelector) -> dict[str, object]:
        return await self._plugins.plugin_ui_data(id, sel)

    async def plugin_ui_run(self, id: str, sel: UIFrameRunSelector) -> PluginUIRunResult:
        return await self._plugins.plugin_ui_run(id, sel)

    # --------------------------------------------------------------------- MCP

    async def list_mcp_servers(self) -> Any:
        return await self._mcp.list_mcp_servers()

    async def update_mcp_server(self, id: str, patch: object) -> Any:
        async with self._hold():
            return await self._mcp.update_mcp_server(id, McpServerPatch.model_validate(patch))

    async def list_mcp_tools(self, id: str) -> Any:
        return await self._mcp.list_mcp_tools(id)

    async def fetch_external_context(self, input: Mapping[str, object]) -> Any:
        server_id = input.get("serverId", input.get("server_id"))
        tool = input.get("tool")
        args = input.get("args")
        title = input.get("title")
        async with self._hold():
            return await self._mcp.fetch_external_context(
                server_id=str(server_id),
                tool=str(tool),
                args=dict(args) if isinstance(args, Mapping) else None,
                title=title if isinstance(title, str) else None,
            )

    async def list_external_contexts(self) -> Any:
        return await self._mcp.list_external_contexts()

    async def delete_external_context(self, id: str) -> None:
        async with self._hold():
            await self._mcp.delete_external_context(id)

    # ------------------------------------------------------------ export/import

    async def export_state(self) -> Any:
        return await self._exporter.export_state()

    async def export_state_part(self, part: str) -> Any:
        return await self._exporter.export_state_part(part)

    async def import_state(self, bundle: object, opts: Mapping[str, object] | None = None) -> Any:
        mode = str(opts["mode"]) if opts is not None and opts.get("mode") is not None else "replace"
        async with self._hold():
            return await self._exporter.import_state(bundle, mode=mode)

    # -------------------------------------------------------------------- misc

    def get_runtime_session_row(self, session_id: str) -> RuntimeSessionRow | None:
        return self._store.get_runtime_session(session_id)

    async def reset_all(self) -> None:
        self._store.reset_all()
