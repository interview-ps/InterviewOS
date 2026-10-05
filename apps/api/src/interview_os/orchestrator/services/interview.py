"""Interview service — port of `apps/server/src/orchestrator/interview-service.ts`.

Owns the interview session lifecycle: starting a session (built-in, practice or
plugin mode), asking the next question (skills, question sources, mode state,
follow-ups), evaluating a submitted answer (evidence, readiness, prep plan,
follow-up decision) and the §9.3 profile/role guidance blocks fed to the
interviewer and evaluator prompts.
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal

from pydantic import BaseModel, ValidationError

from ...ai.errors import RuntimeError
from ...ai.interface import ProgressUpdate, SessionInput
from ...core import new_id, taxonomy
from ...core.assessment import normalize_evaluation
from ...core.models import (
    AnswerEvaluation,
    AnswerFieldType,
    AnswerFormat,
    AppError,
    CamelModel,
    EvaluationWeakness,
    ExpectedConcept,
    InterviewEvent,
    InterviewStatus,
    ModeState,
    PackItem,
    PackSource,
    PluginInterviewMode,
    QuestionCandidate,
    QuestionDifficulty,
    QuestionSource,
    QuestionSourceKind,
    ReadinessGraph,
    RoundType,
    RubricDimension,
    TargetRole,
    VoiceFeedback,
    VoiceMetrics,
)
from ...core.modes import (
    FollowUpDecision,
    ModeAnswerField,
    ModeDefinition,
    ModeQuestionContext,
    all_modes,
    get_mode,
    is_mode_available,
)
from ...core.plugin_api import PluginReviewObservation
from ...core.prioritize import SelectNextSkillResult
from ...core.skill_id import SkillId
from ...core.state_machine import transition
from ...core.voice import voice_feedback
from ...skills.evaluate.answer_evaluator import answer_evaluator
from ...skills.framework import SkillRuntimeError
from ...skills.interview.interview_planner import interview_planner
from ...skills.interview.interviewer import InterviewerOutput, interviewer
from ...skills.prepare.prep_planner import PrepPlannerOutputNormalized
from ...skills.prepare.prep_planner import prep_planner as prep_planner_skill
from ...store import (
    AnswerPluginReview,
    AnswerVoice,
    QuestionRow,
    ReadinessDeltaEntry,
    SessionRow,
)
from ..context import ProgressOptions, WorkflowContext
from ..projection import OrchestratorQuestion, PrepActionRowLike, row_to_question
from .settings import QuestionSources

if TYPE_CHECKING:
    from ...packs.registry import PackRegistry
    from .loop import LoopContext
    from .preparation import PreparationService
    from .readiness import ReadinessService

__all__ = [
    "INTERVIEWER_SESSION_INSTRUCTIONS",
    "AvailableMode",
    "InternalStartInput",
    "InterviewService",
    "InterviewServiceDeps",
    "ModeHookName",
    "NextQuestionResult",
    "PluginInterviewModeRef",
    "PluginReview",
    "PluginReviewPublic",
    "SkillImpact",
    "StartInterviewInput",
    "SubmitAnswerInput",
    "SubmitAnswerResult",
    "validate_answer_fields",
]

INTERVIEWER_SESSION_INSTRUCTIONS = (
    "You are the interviewer thread for Interview OS, a mock-interview tool. Each message asks "
    "you to produce ONE interview question as JSON matching the provided schema. Never repeat "
    "earlier questions."
)

MODE_SIGNALS_MAX_BYTES = 8 * 1024

PACK_GUIDANCE_BUDGET = 1500

ModeHookName = Literal["mode.reduce", "mode.followUp", "mode.mock", "mode.prepareTurn"]


# --------------------------------------------------------------------- inputs


class StartInterviewInput(CamelModel):
    planned_questions: int | None = None
    mode: Literal["interview", "practice"] = "interview"
    focus_skill_id: SkillId | None = None
    action_id: str | None = None
    #: §8.4 round type; practice sessions ignore it (focus skill wins).
    round_type: RoundType | None = None
    #: v0.4: stored external context (MCP fetch) to ground questions on.
    context_id: str | None = None
    #: v0.4: "<pluginId>:<modeId>" — a plugin-declared interview mode.
    plugin_mode_id: str | None = None


class InternalStartInput(StartInterviewInput):
    loop_id: str | None = None
    loop_round: int | None = None


class SubmitAnswerInput(CamelModel):
    text: str
    #: §9.1 coding rounds: optional submitted code (reviewed, not executed).
    code: str | None = None
    language: str | None = None
    #: v1.1: structured values for modes declaring answerFields.
    fields: dict[str, str | int | float] | None = None
    #: v0.4 voice mode: client-measured delivery metrics (feedback only).
    voice: VoiceMetrics | None = None


class PluginInterviewModeRef(CamelModel):
    """A `<pluginId>:<modeId>` interview-mode descriptor + its owner plugin."""

    plugin_id: str
    mode: PluginInterviewMode


@dataclass(frozen=True, slots=True)
class PluginReview:
    """v1: one `evaluation.review` plugin result (the plugin service supplies these).

    `evidence_proposals` are opaque here — the service hands them back to the
    `persist_plugin_evidence` dependency, which applies the standard gate.
    """

    plugin_id: str
    plugin_name: str
    observations: list[PluginReviewObservation]
    evidence_proposals: list[object]


@dataclass(frozen=True, slots=True)
class InterviewServiceDeps:
    """v0.4/v1 plugin + loop bridges the orchestrator wires in."""

    #: §9.4: prior-round weak skills/observations, provided by the loop service.
    loop_context_for: Callable[[SessionRow], Awaitable[LoopContext]]
    #: v0.4: run a question-source plugin; returns raw output or raises.
    run_question_plugin: Callable[[str, object], Awaitable[object]]
    #: v0.4: ids of enabled+compatible question_source plugins.
    enabled_question_plugins: Callable[[], Awaitable[list[str]]]
    #: v0.4: resolve a "<pluginId>:<modeId>" interview mode (enabled+compatible).
    plugin_interview_mode: Callable[[str], Awaitable[PluginInterviewModeRef]]
    #: v1: evaluation.review hooks — optional; absent means no review plugins.
    evaluation_reviews: Callable[[Mapping[str, object]], Awaitable[list[PluginReview]]] | None = (
        None
    )
    #: v1: persist gated plugin-event/review evidence under the lock.
    persist_plugin_evidence: (
        Callable[[str, list[object]], Awaitable[object]] | None
    ) = None
    #: v1: invoke a plugin `mode.*` hook for the plugin owning `modeId`
    #: (returns None when the mode has no hook; raises on invocation failure).
    mode_hook: Callable[[str, ModeHookName, object], Awaitable[object | None]] | None = None


# ---------------------------------------------------------------------- views


class AvailableMode(CamelModel):
    """Descriptor a plugin/built-in mode exposes via GET /api/modes."""

    id: str
    label: str
    description: str
    rubric: list[RubricDimension]
    answer_format: AnswerFormat
    #: v1.1: declared answer widgets for "fields" modes (else empty).
    answer_fields: list[ModeAnswerField]
    #: Present only when the mode is declared by a plugin.
    plugin_id: str | None = None


class SkillImpact(CamelModel):
    skill_id: SkillId
    before: float | None
    after: float | None


class PluginReviewPublic(CamelModel):
    """Plugin review observations surfaced on a submitted answer."""

    plugin_id: str
    plugin_name: str
    observations: list[PluginReviewObservation]


class SubmitAnswerResult(CamelModel):
    evaluation: AnswerEvaluation
    skill_impact: list[SkillImpact]
    new_actions: list[PrepActionRowLike]
    next_available: Literal["question", "complete"]
    #: v0.4: delivery hints, present only when the client sent voice metrics.
    voice_feedback: VoiceFeedback | None
    #: v1: review observations from `evaluation` plugins (attributed).
    plugin_reviews: list[PluginReviewPublic] | None = None


class NextQuestionResult(CamelModel):
    session: SessionRow | None
    question: OrchestratorQuestion | None


# ------------------------------------------------------------------ helpers


def _dump(value: object) -> str:
    """Encode a JSON column the way the store's own writers do."""

    return json.dumps(value, separators=(",", ":"), ensure_ascii=False, default=_dump_default)


def _dump_default(value: object) -> object:
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json", by_alias=True)
    raise TypeError(f"{type(value).__name__} is not JSON serializable")


def _normalize_question_text(text: str) -> str:
    """Question-text comparison for "don't re-ask" — case/whitespace-insensitive."""

    return re.sub(r"[?.!]+$", "", re.sub(r"\s+", " ", text.strip().lower()))


def validate_answer_fields(
    mode: ModeDefinition,
    fields: Mapping[str, str | int | float] | None,
) -> dict[str, str | int | float] | None:
    """v1.1: validate a submitted `fields` record against the mode's declared
    answerFields. Untrusted values are checked, never logged (lengths only).
    """

    declared = {field.key: field for field in mode.answer_fields}
    submitted = fields if fields is not None else {}
    for key in submitted:
        if key not in declared:
            raise AppError("VALIDATION", f'answer field "{key}" is not declared by mode')
    out: dict[str, str | int | float] = {}
    for field in declared.values():
        value = submitted.get(field.key)
        if value is None or value == "":
            if field.required:
                raise AppError("VALIDATION", f'answer field "{field.key}" is required')
            continue
        if field.type in (AnswerFieldType.TEXT, AnswerFieldType.CODE):
            if not isinstance(value, str):
                raise AppError("VALIDATION", f'field "{field.key}" must be a string')
            cap = 100_000 if field.type == AnswerFieldType.CODE else 50_000
            if len(value) > cap:
                raise AppError("VALIDATION", f'field "{field.key}" exceeds {cap // 1000}k chars')
            out[field.key] = value
        elif field.type == AnswerFieldType.CHOICE:
            if not isinstance(value, str) or value not in (field.options or []):
                raise AppError(
                    "VALIDATION", f'field "{field.key}" must be one of the declared options'
                )
            out[field.key] = value
        elif field.type == AnswerFieldType.NUMBER:
            if (
                isinstance(value, bool)
                or not isinstance(value, int | float)
                or not math.isfinite(value)
            ):
                raise AppError("VALIDATION", f'field "{field.key}" must be a finite number')
            out[field.key] = value
    return out if out else None


# -------------------------------------------------------------------- service


class InterviewService:
    def __init__(
        self,
        ctx: WorkflowContext,
        readiness: ReadinessService,
        preparation: PreparationService,
        *,
        deps: InterviewServiceDeps | None = None,
    ) -> None:
        self._ctx = ctx
        self._readiness = readiness
        self._preparation = preparation
        self._deps = deps

    # ------------------------------------------------------------ public API

    def list_modes(self) -> list[AvailableMode]:
        """v1: modes a new session may start with (built-ins + enabled plugin modes)."""

        return [
            AvailableMode(
                id=mode.id,
                label=mode.label,
                description=mode.description,
                rubric=list(mode.rubric),
                answer_format=mode.answer_format,
                answer_fields=list(mode.answer_fields),
                plugin_id=mode.source.plugin_id if mode.source is not None else None,
            )
            for mode in all_modes()
        ]

    async def start_interview_internal(
        self,
        input: InternalStartInput | StartInterviewInput | Mapping[str, object],
        opts: ProgressOptions | None = None,
    ) -> NextQuestionResult:
        parsed = _as_internal_start(input)
        store = self._ctx.store
        candidate, target = await self._ctx.require_active()
        mode = parsed.mode
        if mode == "practice" and not parsed.focus_skill_id:
            raise AppError("VALIDATION", "practice sessions require focusSkillId")
        if parsed.action_id:
            action = store.get_action(parsed.action_id)
            if action is None:
                raise AppError("NOT_FOUND", f"no prep action {parsed.action_id}")
        if parsed.context_id:
            context = store.get_external_context(parsed.context_id)
            if context is None:
                raise AppError("NOT_FOUND", f"no external context {parsed.context_id}")
        # v0.4: a plugin interview mode fixes roundType/plan/focus skills
        plugin_focus_skills: list[SkillId] = []
        if parsed.plugin_mode_id:
            resolved = await self._require_deps().plugin_interview_mode(parsed.plugin_mode_id)
            parsed.round_type = resolved.mode.round_type
            parsed.planned_questions = resolved.mode.planned_questions
            plugin_focus_skills = list(resolved.mode.focus_skills)
        # practice sessions are single-question verifications
        planned_questions = (
            1
            if mode == "practice"
            else (
                parsed.planned_questions if parsed.planned_questions is not None else 4
            )
        )
        round_type: RoundType = parsed.round_type or "mixed"
        # v1: starting a mode requires it registered (built-in or enabled plugin)
        if round_type != "mixed" and not is_mode_available(round_type):
            raise AppError(
                "VALIDATION",
                f'interview mode "{round_type}" is unavailable — its plugin is not installed '
                "or not enabled",
            )
        session_id = new_id("int")
        created_at = self._ctx.iso()
        store.insert_session(
            id=session_id,
            candidate_id=candidate.id,
            target_id=target.id,
            status="created",
            planned_questions=planned_questions,
            mode=mode,
            round_type=round_type,
            focus_skill_id=parsed.focus_skill_id,
            action_id=parsed.action_id,
            mode_state=get_mode(round_type).initial_state(),
            loop_id=parsed.loop_id,
            loop_round=parsed.loop_round,
            context_id=parsed.context_id,
            focus_skills=plugin_focus_skills,
            plugin_mode_id=parsed.plugin_mode_id,
            created_at=created_at,
        )
        self._ctx.transition_session(
            session_id, InterviewStatus.ANALYZING, InterviewEvent.ANALYZE
        )
        self._ctx.transition_session(
            session_id, InterviewStatus.READY, InterviewEvent.ANALYSIS_COMPLETE
        )

        # runtime session for the interviewer thread
        rt_session = await self._ctx.runtime.create_session(
            SessionInput(developer_instructions=INTERVIEWER_SESSION_INSTRUCTIONS)
        )
        store.insert_runtime_session(
            id=new_id("rts"),
            session_id=session_id,
            runtime=self._ctx.runtime.kind,
            runtime_session_id=rt_session.id,
            thread_id=rt_session.thread_id,
            status="open",
            created_at=self._ctx.iso(),
        )
        self._ctx.logger.info(
            "workflow.completed", {"workflow": "startInterview", "sessionId": session_id}
        )
        return await self.next_question_internal(session_id, opts)

    async def next_question_internal(
        self, session_id: str, opts: ProgressOptions | None = None
    ) -> NextQuestionResult:
        store = self._ctx.store
        session = store.get_session(session_id)
        if session is None:
            raise AppError("NOT_FOUND", f"no session {session_id}")
        questions = store.list_questions(session_id)
        status = InterviewStatus(session.status)

        round_type: RoundType = session.round_type or "mixed"
        mode_state: ModeState = dict(session.mode_state)
        # §9.1: a decided follow-up is asked next (same skill, not counted).
        pending_raw = mode_state.pop("__pendingFollowUp", None)
        pending_follow_up: dict[str, Any] | None = (
            pending_raw if isinstance(pending_raw, dict) else None
        )
        if pending_follow_up is not None:
            store.update_session(session_id, {"mode_state": _dump(mode_state)})

        # §9.1: follow-ups don't count toward plannedQuestions — count mains only
        main_count = sum(1 for question in questions if not question.follow_up_of)
        if status == InterviewStatus.READY:
            self._ctx.transition_session(
                session_id, InterviewStatus.QUESTION, InterviewEvent.ASK
            )
        elif status == InterviewStatus.FOLLOW_UP:
            if pending_follow_up is None and main_count >= session.planned_questions:
                self._ctx.transition_session(
                    session_id, InterviewStatus.COMPLETE, InterviewEvent.COMPLETE
                )
                return NextQuestionResult(session=store.get_session(session_id), question=None)
            self._ctx.transition_session(
                session_id, InterviewStatus.QUESTION, InterviewEvent.NEXT
            )
        else:
            # produces InvalidTransitionError for anything else
            transition(status, InterviewEvent.ASK)

        candidate, target = await self._ctx.require_active()
        graph = self._readiness.graph_for_active()
        evidence = self._ctx.evidence_for_active(candidate.id)
        previous_session = next(
            (
                entry
                for entry in store.list_sessions()
                if entry.id != session_id
                and entry.status != InterviewStatus.CREATED
                and entry.status != InterviewStatus.ANALYZING
            ),
            None,
        )
        asked_previous_session: list[SkillId] = (
            [question.skill_id for question in store.list_questions(previous_session.id)]
            if previous_session is not None
            else []
        )
        all_previous_texts: list[str] = []
        for entry in store.list_sessions():
            for question in store.list_questions(entry.id):
                all_previous_texts.append(question.text)

        # §9.4: loop sessions carry prior rounds' weak skills + observations forward
        loop_ctx = await self._require_deps().loop_context_for(session)
        prior_weak_skills = loop_ctx.prior_weak_skills
        prior_round_observations = loop_ctx.prior_round_observations
        # v0.4: loops feed pack focus skills; standalone sessions feed their own
        # (plugin interview-mode) focus skills.
        if session.loop_id:
            loop_row = store.get_loop(session.loop_id)
            focus_skills: list[SkillId] = (
                list(loop_row.focus_skills) if loop_row is not None else []
            )
        else:
            focus_skills = list(session.focus_skills)

        skill_id: SkillId
        question_reason: str
        question_priority: float | None
        question_difficulty: QuestionDifficulty
        selection_factors: dict[str, float] | None = None
        follow_up_of: str | None = None
        follow_up_focus: str | None = None

        if pending_follow_up is not None:
            parent_id = str(pending_follow_up.get("parentQuestionId", ""))
            focus = str(pending_follow_up.get("focus", ""))
            parent = store.get_question(parent_id)
            skill_id = parent.skill_id if parent is not None else "communication"
            question_reason = f'follow-up on "{focus}"'
            question_priority = None
            question_difficulty = (
                QuestionDifficulty(parent.difficulty)
                if parent is not None
                else QuestionDifficulty.MEDIUM
            )
            follow_up_of = parent_id
            follow_up_focus = focus
        else:
            _progress(opts, "selecting skill")
            ask_counts: dict[str, int] = {}
            for entry in store.list_sessions():
                for question in store.list_questions(entry.id):
                    ask_counts[question.skill_id] = ask_counts.get(question.skill_id, 0) + 1
            if session.mode == "practice" and session.focus_skill_id:
                skill_id = session.focus_skill_id
                question_reason = (
                    f"practice: verifying {taxonomy.label_for(session.focus_skill_id)}"
                )
                question_priority = 99
                question_difficulty = QuestionDifficulty.MEDIUM
                selection_factors = None
            else:
                selection: SelectNextSkillResult | None = await self._ctx.host.invoke(
                    interview_planner,
                    {
                        "requirements": self._ctx.all_requirements(target),
                        "readiness": graph.dimensions,
                        "evidence": evidence,
                        "askedThisSession": [
                            question.skill_id for question in questions
                        ],
                        "askedPreviousSession": asked_previous_session,
                        "questionIndex": main_count,
                        "roundType": round_type,
                        "mode": round_type,
                        "level": target.level,
                        "askCounts": ask_counts,
                        "loopWeakSkills": prior_weak_skills,
                        "focusSkills": focus_skills,
                    },
                    await self._ctx.ctx(session_id=session_id),
                )
                if selection is None:
                    self._ctx.transition_session(
                        session_id, InterviewStatus.COMPLETE, InterviewEvent.COMPLETE
                    )
                    return NextQuestionResult(session=store.get_session(session_id), question=None)
                skill_id = selection.skill_id
                question_reason = selection.reason
                question_priority = selection.priority
                question_difficulty = selection.difficulty
                selection_factors = selection.factors.model_dump(by_alias=True)

        # v0.4: question sources only feed main questions, never follow-ups. The
        # orchestrator picked the skill — a source only suggests the question text.
        seed_question: dict[str, object] | None = None
        question_source: QuestionSource | None = None
        if pending_follow_up is None:
            sourced = await self._pick_sourced_question(
                target, skill_id, round_type, all_previous_texts
            )
            if sourced is not None:
                kind = sourced.source.kind
                if kind == QuestionSourceKind.PLUGIN:
                    source_label = f"plugin:{sourced.source.id}"
                elif kind == QuestionSourceKind.USER_BANK:
                    source_label = "your question bank"
                else:
                    pack_kind = "company" if kind == QuestionSourceKind.COMPANY_PACK else "role"
                    source_label = f'{pack_kind} pack "{sourced.source.id}"'
                seed_question = {
                    "text": sourced.text,
                    "expectedConcepts": sourced.expected_concepts,
                    "sourceLabel": source_label,
                }
                question_source = sourced.source

        # v0.4: a stored external context grounds the question (untrusted data).
        external_context: dict[str, str] | None = None
        if session.context_id:
            context_row = store.get_external_context(session.context_id)
            external_context = (
                {"title": context_row.title, "text": context_row.text}
                if context_row is not None
                else None
            )

        # v1: a mode's descriptor declares which host-side context the
        # interviewer needs (company themes / story titles) — never mode ids.
        mode_def = get_mode(round_type)
        context_needs = mode_def.context
        # v1: a plugin mode may prepare per-turn input (focusDimension etc.)
        # via its mode.prepareTurn hook; failure/absence → {}.
        mode_turn = await self._prepare_mode_turn(
            round_type, mode_def, mode_state, pending_follow_up is not None
        )
        turn_focus = mode_turn.get("focusDimension")
        focus_dimension = (
            None
            if pending_follow_up is not None
            else (turn_focus if isinstance(turn_focus, str) and turn_focus else None)
        )
        interviewer_input: dict[str, object] = {
            "skillId": skill_id,
            "label": taxonomy.label_for(skill_id),
            "role": target.role,
            "level": target.level,
            "company": target.company,
            "reason": question_reason,
            "previousQuestions": list(all_previous_texts),
            "candidateSummary": (
                f"{candidate.name or 'candidate'} — {candidate.headline or ''}".strip()
            ),
            "roundType": round_type,
            "mode": round_type,
            "modeState": mode_state,
            "modeTurn": mode_turn,
            "followUp": (
                {
                    "parentQuestion": pending_follow_up.get("parentText"),
                    "focus": pending_follow_up.get("focus"),
                }
                if pending_follow_up is not None
                else None
            ),
            "companyGuidance": await self.company_guidance_for(
                target, round_type, session.plugin_mode_id
            ),
            "difficulty": question_difficulty,
            "focusDimension": focus_dimension,
            "companyThemes": (
                (target.company_profile.behavioral_themes if target.company_profile else [])
                if context_needs is not None and context_needs.company_themes
                else []
            ),
            "storyTitles": (
                [story.title for story in store.list_stories(candidate.id)][:10]
                if context_needs is not None and context_needs.story_titles
                else []
            ),
            "priorRoundObservations": prior_round_observations,
            "seedQuestion": seed_question,
            "roleRubric": await self._role_rubric_for(target, skill_id, round_type),
            "externalContext": external_context,
        }

        runtime_session_id = self._ensure_runtime_session(session_id)
        interview_ctx = await self._ctx.ctx(
            session_id=session_id,
            runtime_session_id=runtime_session_id,
            on_progress=opts.on_progress if opts is not None else None,
        )
        _progress(opts, "writing question")
        produced: InterviewerOutput
        try:
            produced = await self._ctx.host.invoke(interviewer, interviewer_input, interview_ctx)
        except (RuntimeError, SkillRuntimeError) as err:
            # in-memory runtime session gone (server restart): resume by thread and retry once
            message = err.message if isinstance(err, RuntimeError) else str(err)
            if re.search(r"unknown (mock )?session", message) is None:
                raise
            resumed = await self._resume_runtime_session(session_id)
            produced = await self._ctx.host.invoke(
                interviewer,
                interviewer_input,
                await self._ctx.ctx(session_id=session_id, runtime_session_id=resumed),
            )

        # §9.6: the interviewer skill writes question rows.
        self._ctx.host.assert_can("interviewer", "interview.write")
        question_id = new_id("q")
        extra: dict[str, object] = {}
        if produced.problem is not None:
            extra["problem"] = produced.problem
        if produced.focus_dimension:
            extra["focusDimension"] = produced.focus_dimension
        if question_source is not None:
            extra["source"] = question_source
        store.insert_question(
            id=question_id,
            session_id=session_id,
            skill_id=produced.skill_id,
            topic=produced.topic,
            text=produced.question,
            sub_skills=produced.sub_skills,
            expected_concepts=[
                ExpectedConcept(
                    concept=concept.concept,
                    skill_id=concept.skill_id,
                    keywords=list(concept.keywords),
                )
                for concept in produced.expected_concepts
            ],
            difficulty=produced.difficulty,
            selection_priority=question_priority,
            selection_reason=question_reason,
            selection_factors=selection_factors if selection_factors is not None else {},
            follow_up_of=follow_up_of,
            follow_up_focus=follow_up_focus,
            extra=extra,
            position=len(questions) + 1,
            created_at=self._ctx.iso(),
        )
        store.update_session(session_id, {"current_round": len(questions) + 1})
        row = store.get_question(question_id)
        return NextQuestionResult(
            session=store.get_session(session_id),
            question=None if row is None else row_to_question(row.model_dump()),
        )

    async def submit_answer(
        self,
        session_id: str,
        answer: str | SubmitAnswerInput | Mapping[str, object],
        opts: ProgressOptions | None = None,
    ) -> SubmitAnswerResult:
        store = self._ctx.store
        parsed = _as_submit_answer(answer)
        answer_text = parsed.text
        code = parsed.code
        language = parsed.language
        fields = parsed.fields
        voice = parsed.voice
        # v0.4 voice mode: feedback is computed server-side from the transcript —
        # the client supplies only raw metrics, never counts.
        feedback = voice_feedback(voice, answer_text) if voice is not None else None
        session = store.get_session(session_id)
        if session is None:
            raise AppError("NOT_FOUND", f"no session {session_id}")

        round_type: RoundType = session.round_type or "mixed"
        mode_def = get_mode(round_type)
        # v1.1: "fields" modes collect declared widgets instead of free text.
        answer_fields = validate_answer_fields(mode_def, fields)
        if mode_def.answer_format != "fields" and answer_text.strip() == "":
            raise AppError("VALIDATION", "answer text is required")

        questions = store.list_questions(session_id)
        active = None
        for question in reversed(questions):
            if store.get_evaluated_answer_for_question(question.id) is None:
                active = question
                break
        if active is None:
            raise AppError("NOT_FOUND", "no unanswered question in session")
        before = self._readiness.graph_for_active()
        self._ctx.transition_session(
            session_id, InterviewStatus.ANSWER, InterviewEvent.ANSWER
        )
        answer_id = new_id("ans")
        store.insert_answer(
            id=answer_id,
            question_id=active.id,
            session_id=session_id,
            text=answer_text,
            code=code,
            language=language,
            fields=answer_fields,
            voice=(
                AnswerVoice(metrics=voice, feedback=feedback)
                if voice is not None and feedback is not None
                else None
            ),
            created_at=self._ctx.iso(),
        )
        self._ctx.transition_session(
            session_id, InterviewStatus.EVALUATING, InterviewEvent.EVALUATE
        )

        pre_mode_state: ModeState = dict(session.mode_state)

        candidate, target = await self._ctx.require_active()
        evaluation: AnswerEvaluation
        skill_impact: list[SkillImpact] = []
        follow_up_pending = False
        plugin_reviews: list[PluginReviewPublic] | None = None
        new_actions: list[PrepActionRowLike] = []
        _progress(opts, "evaluating answer")
        try:
            evaluated = await self._ctx.host.invoke(
                answer_evaluator,
                {
                    "question": {
                        "text": active.text,
                        "topic": active.topic,
                        "skillId": active.skill_id,
                        "expectedConcepts": active.expected_concepts,
                        "difficulty": active.difficulty,
                    },
                    "answer": answer_text,
                    "code": code,
                    "language": language,
                    "fields": answer_fields,
                    "role": target.role,
                    "level": target.level,
                    "roundType": round_type,
                    "mode": round_type,
                    "modeState": pre_mode_state,
                    "companyGuidance": await self.company_guidance_for(
                        target, round_type, session.plugin_mode_id
                    ),
                    "roleRubric": await self._role_rubric_for(
                        target, active.skill_id, round_type
                    ),
                },
                await self._ctx.ctx(
                    session_id=session_id,
                    on_progress=opts.on_progress if opts is not None else None,
                ),
            )
            # defensive: merge duplicate per-skill entries before persisting
            evaluation = normalize_evaluation(
                evaluated
                if isinstance(evaluated, AnswerEvaluation)
                else AnswerEvaluation.model_validate(evaluated)
            )
            # v1.1: modeSignals are opaque to the host — drop oversized payloads.
            if (
                evaluation.mode_signals is not None
                and len(json.dumps(evaluation.mode_signals)) > MODE_SIGNALS_MAX_BYTES
            ):
                self._ctx.logger.warn(
                    "evaluation.mode_signals_dropped",
                    {
                        "sessionId": session_id,
                        "questionId": active.id,
                        "bytes": len(json.dumps(evaluation.mode_signals)),
                    },
                )
                evaluation = evaluation.model_copy(update={"mode_signals": None})
            # §9.6: the evaluator's outputs persist evaluation + evidence rows.
            self._ctx.host.assert_can("answer-evaluator", "interview.write")
            self._ctx.host.assert_can("answer-evaluator", "evidence.write")
            eval_id = new_id("eval")
            store.insert_evaluation(
                id=eval_id,
                answer_id=answer_id,
                question_id=active.id,
                session_id=session_id,
                data=evaluation,
                created_at=self._ctx.iso(),
            )
            self._ctx.logger.info(
                "evaluation.recorded",
                {"sessionId": session_id, "questionId": active.id, "skillId": active.skill_id},
            )

            evidence_type = "practice" if session.mode == "practice" else "interview_answer"
            created_evidence_ids: list[str] = []
            evidence_created_at = self._ctx.iso()
            for score in evaluation.scores:
                skill_id = score.skill
                weakness_evidence = next(
                    (w.evidence for w in evaluation.weaknesses if w.skill == skill_id), None
                )
                strength_evidence = next(
                    (s.evidence for s in evaluation.strengths if s.skill == skill_id), None
                )
                observation = (
                    strength_evidence if strength_evidence is not None else evaluation.summary
                )
                match = weakness_evidence if weakness_evidence is not None else observation
                evidence_id = new_id("ev")
                store.insert_evidence(
                    id=evidence_id,
                    candidate_id=candidate.id,
                    skill_id=skill_id,
                    type=evidence_type,
                    score=score.score,
                    confidence=score.confidence,
                    observation=match,
                    session_id=session_id,
                    question_id=active.id,
                    created_at=evidence_created_at,
                )
                created_evidence_ids.append(evidence_id)
                self._ctx.register_skill_node(skill_id)

            _progress(opts, "updating readiness")
            after = await self._readiness.recompute_readiness_internal("answer")
            # §9.7: dedup by skill, preserving the first occurrence's order.
            impacts: dict[str, SkillImpact] = {}
            for score in evaluation.scores:
                if score.skill in impacts:
                    continue
                impacts[score.skill] = SkillImpact(
                    skill_id=score.skill,
                    before=_dimension_score(before, score.skill),
                    after=_dimension_score(after, score.skill),
                )
            skill_impact = list(impacts.values())
            # §9.7: the skillImpact list is persisted on the evaluation as its
            # readiness delta for the History view.
            store.update_evaluation_delta(
                eval_id,
                [
                    ReadinessDeltaEntry(
                        skill_id=impact.skill_id, before=impact.before, after=impact.after
                    )
                    for impact in skill_impact
                ],
            )

            # plan update for medium+ weaknesses, one target per skill
            weak_targets: list[EvaluationWeakness] = []
            seen_weak: set[str] = set()
            for weakness in evaluation.weaknesses:
                if weakness.severity == "low" or weakness.skill in seen_weak:
                    continue
                seen_weak.add(weakness.skill)
                weak_targets.append(weakness)
            if weak_targets:
                _progress(opts, "updating prep plan")
                concepts = active.expected_concepts
                plan: PrepPlannerOutputNormalized = await self._ctx.host.invoke(
                    prep_planner_skill,
                    {
                        "targets": [
                            {
                                "skillId": weakness.skill,
                                "label": taxonomy.label_for(weakness.skill),
                                "reason": f"weak answer: {weakness.evidence}",
                                # only the missed concepts the question mapped to this skill
                                "missingConcepts": [
                                    concept.concept
                                    for concept in concepts
                                    if concept.skill_id == weakness.skill
                                    and concept.concept in evaluation.missing_concepts
                                ],
                                "severity": weakness.severity,
                            }
                            for weakness in weak_targets
                        ],
                        "role": target.role,
                        "level": target.level,
                    },
                    await self._ctx.ctx(session_id=session_id),
                )
                for planned in plan.actions:
                    action_skill = planned.skill_id
                    severity = next(
                        (w.severity for w in weak_targets if w.skill == action_skill), None
                    )
                    new_actions.append(
                        await self._preparation.insert_planned_action(
                            action_skill,
                            planned,
                            candidate.id,
                            severity if severity is not None else "medium",
                            target.id,
                        )
                    )
                await self._preparation.renumber_action_priorities(
                    self._ctx.all_requirements(target), target.id
                )

            # practice session linked to a prep action: a demonstrated focus-skill
            # score ≥ 0.7 closes the action; otherwise attach the new evidence ids
            if session.action_id:
                focus_skill_id = session.focus_skill_id
                demonstrated = (
                    next(
                        (
                            score.score
                            for score in evaluation.scores
                            if score.skill == focus_skill_id
                        ),
                        None,
                    )
                    if focus_skill_id
                    else None
                )
                if demonstrated is not None and demonstrated >= 0.7:
                    store.update_action_status(session.action_id, "done")
                else:
                    prep_action = store.get_action(session.action_id)
                    if prep_action is not None:
                        existing = list(prep_action.source_evidence_ids or [])
                        store.update_action_source_evidence(
                            session.action_id, [*existing, *created_evidence_ids]
                        )

            # §9.1: reduce mode state, then decide whether to dig deeper. Plugin
            # modes consult their mode.* hooks first — failures fall back to the
            # descriptor's declarative reduce/followUp.
            mode_state = await self._reduce_mode_state(
                round_type,
                mode_def,
                pre_mode_state,
                evaluation,
                ModeQuestionContext(
                    skill_id=active.skill_id, topic=active.topic, extra=active.extra
                ),
            )
            if session.mode != "practice" and round_type != "mixed":
                main_id = active.follow_up_of or active.id
                chain_depth = sum(1 for q in questions if q.follow_up_of == main_id)
                max_depth = (
                    self._packs()
                    .company_profile(target.company_profile_id or "generic")
                    .follow_up_depth
                )
                decision = await self._follow_up_decision(
                    round_type, mode_def, evaluation, mode_state, chain_depth, max_depth
                )
                if decision.ask:
                    follow_up_pending = True
                    mode_state = {
                        **mode_state,
                        "__pendingFollowUp": {
                            "parentQuestionId": main_id,
                            "parentText": active.text,
                            "focus": (
                                decision.focus
                                if decision.focus is not None
                                else "the weakest dimension"
                            ),
                        },
                    }
                    self._ctx.logger.info(
                        "interview.follow_up",
                        {"sessionId": session_id, "questionId": main_id, "depth": chain_depth + 1},
                    )
            # v1: after the built-in evaluation persists, `evaluation` plugins
            # review the answer (answer text only when granted `answers.read`).
            # Observations attach to the answer row; evidence proposals go through
            # the standard gate. Plugin failures were already logged+skipped.
            review_hook = self._deps.evaluation_reviews if self._deps is not None else None
            if review_hook is not None:
                reviews = await review_hook(_evaluation_review_args(
                    active, evaluation, answer_text, code, language, answer_fields, round_type
                ))
                if reviews:
                    plugin_reviews = [
                        PluginReviewPublic(
                            plugin_id=review.plugin_id,
                            plugin_name=review.plugin_name,
                            observations=list(review.observations),
                        )
                        for review in reviews
                    ]
                    store.update_answer_plugin_reviews(
                        answer_id,
                        [
                            AnswerPluginReview(
                                plugin_id=review.plugin_id,
                                plugin_name=review.plugin_name,
                                observations=list(review.observations),
                            )
                            for review in plugin_reviews
                        ],
                    )
                    persist = (
                        self._deps.persist_plugin_evidence if self._deps is not None else None
                    )
                    for review in reviews:
                        if review.evidence_proposals and persist is not None:
                            await persist(review.plugin_id, review.evidence_proposals)

            store.update_session(session_id, {"mode_state": _dump(mode_state)})
        except Exception as err:
            # keep the session usable: mark the stored answer failed and roll the
            # session back to QUESTION so the answer can be resubmitted.
            store.update_answer_status(answer_id, "failed")
            self._ctx.transition_session(
                session_id, InterviewStatus.QUESTION, InterviewEvent.EVALUATION_FAILED
            )
            self._ctx.logger.warn(
                "evaluation.failed",
                {"sessionId": session_id, "questionId": active.id, "error": str(err)},
            )
            raise

        self._ctx.transition_session(
            session_id, InterviewStatus.FOLLOW_UP, InterviewEvent.FOLLOW_UP
        )
        main_count = sum(1 for question in questions if not question.follow_up_of)
        remaining = follow_up_pending or main_count < session.planned_questions
        return SubmitAnswerResult(
            evaluation=evaluation,
            skill_impact=skill_impact,
            new_actions=new_actions,
            next_available="question" if remaining else "complete",
            voice_feedback=feedback,
            plugin_reviews=plugin_reviews,
        )

    # --------------------------------------------------------- §9.3 guidance

    async def company_guidance_for(
        self,
        target: TargetRole,
        round_type: RoundType,
        plugin_mode_id: str | None = None,
    ) -> str:
        """§9.3: rendered profile guidance fed to interviewer/evaluator prompts."""

        packs = self._packs()
        await packs.ready()
        profile = packs.company_profile(target.company_profile_id or "generic")
        lines = [
            f"Interview profile: {profile.name} ({profile.id}). Typical loop: "
            f"{' → '.join(stage.label for stage in profile.typical_loop)}.",
            f"Behavioral framework: {profile.behavioral_framework.name} — "
            f"{profile.behavioral_framework.guidance}",
            f"Follow-up depth: {profile.follow_up_depth}. {profile.disclaimer}",
        ]
        expectations = profile.role_expectations.get(target.level)
        if expectations:
            lines.append(f"Level expectations ({target.level}): {'; '.join(expectations)}.")
        if round_type != "mixed":
            loop_stage = next(
                (stage for stage in profile.typical_loop if stage.mode == round_type), None
            )
            if loop_stage is not None:
                lines.append(f'This round plays the "{loop_stage.label}" part of the loop.')
        # v1: plugin interview-mode guidance is untrusted pack-like text —
        # rendered with provenance so the model weights it accordingly.
        plugin_guidance_lines = 0
        if plugin_mode_id:
            plugin_id = plugin_mode_id[: plugin_mode_id.find(":")]
            try:
                resolved = await self._require_deps().plugin_interview_mode(plugin_mode_id)
                if resolved.mode.guidance:
                    lines.append(
                        f"Plugin mode guidance ({plugin_id}, unverified): "
                        f"{resolved.mode.guidance[:1500]}"
                    )
                    plugin_guidance_lines = 1
            except Exception:  # noqa: BLE001 - plugin disabled/removed mid-session
                pass
        # v0.4: pack items render their provenance — sourced lines name the source,
        # community lines are marked unverified.
        pack = packs.company_pack(profile.id)
        if pack is None:
            return "\n".join(lines)

        def render_items(heading: str, items: list[PackItem]) -> None:
            for item in items:
                if item.provenance == "sourced":
                    lines.append(
                        f"{heading} Sourced ({_pack_source_title(pack.sources, item.source)}): "
                        f"{item.text}"
                    )
                else:
                    lines.append(f"{heading} Community observation (unverified): {item.text}")

        render_items("Competency:", pack.competencies)
        render_items("Question style:", pack.question_style)
        render_items("Evaluation guidance:", pack.evaluation_guidance)
        for overlay in pack.overlays:
            if not packs.overlay_applies(overlay, target.role, round_type):
                continue
            render_items("Overlay competency:", overlay.competencies)
            render_items("Overlay question style:", overlay.question_style)
            render_items("Overlay evaluation guidance:", overlay.evaluation_guidance)
        # cap the pack-authored portion of the guidance block
        head_len = (
            3
            + (1 if expectations else 0)
            + (1 if round_type != "mixed" else 0)
            + plugin_guidance_lines
        )
        head = lines[:head_len]
        tail = lines[len(head) :]
        kept: list[str] = []
        used = 0
        for line in tail:
            if used + len(line) > PACK_GUIDANCE_BUDGET:
                break
            kept.append(line)
            used += len(line)
        return "\n".join([*head, *kept])

    # -------------------------------------------------------------- internals

    def _packs(self) -> PackRegistry:
        packs = self._ctx.packs
        if packs is None:
            raise AppError("VALIDATION", "no pack registry configured")
        return packs

    def _require_deps(self) -> InterviewServiceDeps:
        if self._deps is None:
            raise AppError("INTERNAL", "interview service dependencies are not configured")
        return self._deps

    async def _role_rubric_for(
        self, target: TargetRole, skill_id: SkillId, round_type: RoundType
    ) -> list[str]:
        """Role-pack rubric lines for the interviewer + evaluator."""

        packs = self._packs()
        await packs.ready()
        criteria = packs.role_rubrics(target.role_pack_id, skill_id, round_type)
        pack = packs.role_pack(target.role_pack_id) if target.role_pack_id else None
        return (
            [f"Role rubric ({pack.name}): {criterion}" for criterion in criteria]
            if criteria and pack is not None
            else criteria
        )

    async def _question_sources(self) -> QuestionSources:
        """Settings-backed question-source toggles."""

        raw = self._ctx.store.get_setting("questionSources")
        if not raw:
            return QuestionSources()
        try:
            return QuestionSources.model_validate(json.loads(raw))
        except (json.JSONDecodeError, ValidationError):
            return QuestionSources()

    async def _pick_sourced_question(
        self,
        target: TargetRole,
        skill_id: SkillId,
        round_type: RoundType,
        all_previous_texts: list[str],
    ) -> QuestionCandidate | None:
        """v0.4 question sources, in priority order: user bank → company pack
        (overlay questions first) → role pack → plugins. Only eligible candidates
        (exact/descendant skill, mode-compatible, never asked before) are offered.
        """

        store = self._ctx.store
        settings = await self._question_sources()
        packs = self._packs()
        await packs.ready()
        asked = {_normalize_question_text(text) for text in all_previous_texts}

        candidates: list[QuestionCandidate] = []
        if settings.user_bank:
            for row in store.list_user_questions():
                matches = row.skill_id == skill_id or row.skill_id.startswith(f"{skill_id}.")
                mode_ok = not row.mode or row.mode == round_type or round_type == "mixed"
                if not matches or not mode_ok:
                    continue
                candidates.append(
                    QuestionCandidate(
                        skill_id=row.skill_id,
                        text=row.text,
                        difficulty=(
                            QuestionDifficulty(row.difficulty)
                            if row.difficulty is not None
                            else None
                        ),
                        mode=row.mode,
                        source=QuestionSource(kind=QuestionSourceKind.USER_BANK, id=row.id),
                    )
                )
        if settings.company_packs:
            candidates.extend(
                packs.company_pack_questions(
                    target.company_profile_id or "generic",
                    skill_id,
                    round_type,
                    target.role,
                )
            )
        if settings.role_packs and target.role_pack_id:
            candidates.extend(
                packs.role_pack_questions(target.role_pack_id, skill_id, round_type)
            )
        if settings.plugins:
            enabled = set(await self._require_deps().enabled_question_plugins())
            for plugin_id in settings.plugins:
                if plugin_id not in enabled:
                    continue
                try:
                    output = await self._require_deps().run_question_plugin(
                        plugin_id,
                        {
                            "kind": "questions",
                            "skillId": skill_id,
                            "roundType": round_type,
                            "level": target.level,
                            "count": 5,
                        },
                    )
                    listing = output.get("questions") if isinstance(output, dict) else None
                    if not isinstance(listing, list):
                        continue
                    dropped = 0
                    for entry in listing:
                        try:
                            candidate = QuestionCandidate.model_validate(
                                {
                                    **(entry if isinstance(entry, dict) else {}),
                                    "source": {"kind": "plugin", "id": plugin_id},
                                }
                            )
                        except ValidationError:
                            dropped += 1
                            continue
                        if (
                            candidate.skill_id == skill_id
                            or candidate.skill_id.startswith(f"{skill_id}.")
                        ) and (
                            not candidate.mode
                            or candidate.mode == round_type
                            or round_type == "mixed"
                        ):
                            candidates.append(candidate)
                    if dropped > 0:
                        self._ctx.logger.warn(
                            "questionsource.invalid", {"plugin": plugin_id, "dropped": dropped}
                        )
                except Exception as err:  # noqa: BLE001 - a failing source never breaks the flow
                    self._ctx.logger.warn(
                        "questionsource.failed",
                        {"plugin": plugin_id, "error": str(err)[:200]},
                    )
        return next(
            (
                candidate
                for candidate in candidates
                if _normalize_question_text(candidate.text) not in asked
            ),
            None,
        )

    async def _prepare_mode_turn(
        self,
        mode_id: str,
        mode_def: ModeDefinition,
        state: ModeState,
        follow_up: bool,
    ) -> dict[str, object]:
        """v1: plugin mode.prepareTurn hook → {} on absence/failure."""

        hook = self._deps.mode_hook if self._deps is not None else None
        if mode_def.source is not None and hook is not None:
            try:
                result = await hook(
                    mode_id,
                    "mode.prepareTurn",
                    {"modeId": mode_id, "state": state, "followUp": follow_up},
                )
                turn = result.get("turn") if isinstance(result, dict) else None
                if isinstance(turn, dict):
                    return dict(turn)
            except Exception as err:  # noqa: BLE001 - hook failure falls back to {}
                self._ctx.logger.warn(
                    "interview.mode_hook_failed",
                    {"hook": "mode.prepareTurn", "modeId": mode_id, "error": str(err)[:200]},
                )
        return {}

    async def _reduce_mode_state(
        self,
        mode_id: str,
        mode_def: ModeDefinition,
        state: ModeState,
        evaluation: AnswerEvaluation,
        question: ModeQuestionContext,
    ) -> ModeState:
        """v1: plugin mode.reduce hook → declarative fallback on absence/failure."""

        hook = self._deps.mode_hook if self._deps is not None else None
        if mode_def.source is not None and hook is not None:
            try:
                result = await hook(
                    mode_id,
                    "mode.reduce",
                    {
                        "modeId": mode_id,
                        "state": state,
                        "evaluation": evaluation,
                        "question": question,
                    },
                )
                next_state = result.get("state") if isinstance(result, dict) else None
                if isinstance(next_state, dict):
                    return dict(next_state)
            except Exception as err:  # noqa: BLE001 - hook failure falls back to declarative
                self._ctx.logger.warn(
                    "interview.mode_hook_failed",
                    {"hook": "mode.reduce", "modeId": mode_id, "error": str(err)[:200]},
                )
        return mode_def.reduce(state, evaluation, question)

    async def _follow_up_decision(
        self,
        mode_id: str,
        mode_def: ModeDefinition,
        evaluation: AnswerEvaluation,
        state: ModeState,
        depth: int,
        max_depth: int,
    ) -> FollowUpDecision:
        """v1: plugin mode.followUp hook → declarative fallback on absence/failure."""

        hook = self._deps.mode_hook if self._deps is not None else None
        if mode_def.source is not None and hook is not None:
            try:
                result = await hook(
                    mode_id,
                    "mode.followUp",
                    {
                        "modeId": mode_id,
                        "evaluation": evaluation,
                        "state": state,
                        "depth": depth,
                        "maxDepth": max_depth,
                    },
                )
                if isinstance(result, dict) and isinstance(result.get("ask"), bool):
                    focus = result.get("focus")
                    reason = result.get("reason")
                    return FollowUpDecision(
                        ask=result["ask"],
                        focus=focus if isinstance(focus, str) else None,
                        reason=(
                            reason if isinstance(reason, str) else "plugin mode.followUp"
                        ),
                    )
            except Exception as err:  # noqa: BLE001 - hook failure falls back to declarative
                self._ctx.logger.warn(
                    "interview.mode_hook_failed",
                    {"hook": "mode.followUp", "modeId": mode_id, "error": str(err)[:200]},
                )
        return mode_def.follow_up(evaluation, state, depth, max_depth)

    def _ensure_runtime_session(self, session_id: str) -> str | None:
        row = self._ctx.store.get_runtime_session(session_id)
        return None if row is None else row.runtime_session_id

    async def _resume_runtime_session(self, session_id: str) -> str:
        store = self._ctx.store
        row = store.get_runtime_session(session_id)
        if row is None:
            raise AppError("NOT_FOUND", f"no runtime session for {session_id}")
        rt_session = await self._ctx.runtime.resume_session(
            row.thread_id,
            SessionInput(developer_instructions=INTERVIEWER_SESSION_INSTRUCTIONS),
        )
        store.update_runtime_session_status(row.id, "resumed")
        store.insert_runtime_session(
            id=new_id("rts"),
            session_id=session_id,
            runtime=self._ctx.runtime.kind,
            runtime_session_id=rt_session.id,
            thread_id=rt_session.thread_id,
            status="open",
            created_at=self._ctx.iso(),
        )
        return rt_session.id


def _progress(opts: ProgressOptions | None, stage: str) -> None:
    if opts is not None and opts.on_progress is not None:
        opts.on_progress(ProgressUpdate(stage=stage))


def _as_internal_start(
    input: InternalStartInput | StartInterviewInput | Mapping[str, object],
) -> InternalStartInput:
    if isinstance(input, InternalStartInput):
        return input
    if isinstance(input, StartInterviewInput):
        return InternalStartInput(**input.model_dump())
    return InternalStartInput.model_validate(input)


def _as_submit_answer(answer: str | SubmitAnswerInput | Mapping[str, object]) -> SubmitAnswerInput:
    if isinstance(answer, str):
        return SubmitAnswerInput(text=answer)
    if isinstance(answer, SubmitAnswerInput):
        return answer
    return SubmitAnswerInput.model_validate(answer)


def _dimension_score(graph: ReadinessGraph, skill_id: str) -> float | None:
    dimension = graph.dimensions.get(skill_id)
    return None if dimension is None else dimension.score


def _pack_source_title(sources: list[PackSource], id: str | None) -> str:
    return next((source.title for source in sources if source.id == id), None) or id or "unknown"


def _evaluation_review_args(
    question: QuestionRow,
    evaluation: AnswerEvaluation,
    answer_text: str,
    code: str | None,
    language: str | None,
    answer_fields: Mapping[str, str | int | float] | None,
    round_type: RoundType,
) -> dict[str, object]:
    answer: dict[str, object] = {"text": answer_text}
    if code:
        answer["code"] = code
    if language:
        answer["language"] = language
    if answer_fields:
        answer["fields"] = dict(answer_fields)
    return {
        "question": {
            "skillId": question.skill_id,
            "text": question.text,
            "roundType": round_type,
            "expectedConcepts": [
                concept.concept for concept in (question.expected_concepts or [])
            ][:16],
        },
        "evaluation": evaluation,
        "answer": answer,
    }
