"""History service — port of `apps/server/src/orchestrator/history-service.ts`."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from pydantic import Field, TypeAdapter

from ...core import new_id, taxonomy
from ...core.companies import generic_profile
from ...core.gaps import calculate_gaps
from ...core.models import (
    Answer,
    AnswerEvaluation,
    AnswerFormat,
    AppError,
    AssessedItem,
    AssessmentState,
    CamelModel,
    CandidateProfile,
    CompanyProfile,
    InterviewOSState,
    InterviewStateSlice,
    Level,
    LoopRound,
    PrepAction,
    PreparationState,
    Question,
    ReadinessGraph,
    SkillReadiness,
    TargetRole,
)
from ...core.modes import ModeAnswerField, get_mode
from ...core.readiness import build_readiness_graph
from ...store import (
    AnswerRow,
    AnswerVoice,
    EvidenceRow,
    ReadinessDeltaEntry,
    ReadinessRow,
    SessionRow,
)
from ..context import WorkflowContext
from ..projection import OrchestratorQuestion, PrepActionRowLike, row_to_action, row_to_question

__all__ = [
    "HistoryFilters",
    "HistoryService",
    "InterviewDetail",
    "InterviewListItem",
    "MetricsView",
    "SessionHistoryEntry",
    "SkillDetail",
]

_LOOP_ROUNDS = TypeAdapter(list[LoopRound])


class HistoryFilters(CamelModel):
    mode: str | None = None
    target_id: str | None = None
    loop_id: str | None = None
    weak_only: bool = False


class InterviewTargetRef(CamelModel):
    id: str
    role: str
    company: str


class InterviewListItem(SessionRow):
    mode_label: str
    target: InterviewTargetRef | None = None
    questions: int = 0
    debrief: Any = Field(default=None, json_schema_extra={"emit_null": True})


class SkillDetail(CamelModel):
    skill_id: str
    readiness: SkillReadiness | None = Field(default=None, json_schema_extra={"emit_null": True})
    evidence: list[EvidenceRow]
    history: list[ReadinessRow]
    actions: list[PrepActionRowLike]
    recommended_action: PrepActionRowLike | None = Field(
        default=None, json_schema_extra={"emit_null": True}
    )


class InterviewSessionView(SessionRow):
    mode_label: str
    answer_format: AnswerFormat
    answer_fields: list[ModeAnswerField]


class CompanyProfileRef(CamelModel):
    id: str
    name: str
    disclaimer: str


class InterviewDetail(CamelModel):
    session: InterviewSessionView
    questions: list[OrchestratorQuestion]
    answers: list[AnswerRow]
    evaluations: list[AnswerEvaluation]
    debrief: Any = Field(default=None, json_schema_extra={"emit_null": True})
    company_profile: CompanyProfileRef


class HistorySessionView(SessionRow):
    mode_label: str


class HistoryTargetRef(CamelModel):
    id: str
    role: str
    company: str
    company_profile_id: str


class HistoryLoopRef(CamelModel):
    id: str
    round: int | None = None
    total_rounds: int
    label: str | None = None


class HistoryAnswerView(CamelModel):
    id: str
    text: str
    code: str | None = Field(default=None, json_schema_extra={"emit_null": True})
    language: str | None = Field(default=None, json_schema_extra={"emit_null": True})
    voice: AnswerVoice | None = Field(default=None, json_schema_extra={"emit_null": True})
    created_at: str


class HistoryQuestionNode(CamelModel):
    question: OrchestratorQuestion
    answer: HistoryAnswerView | None = Field(
        default=None, json_schema_extra={"emit_null": True}
    )
    evaluation: AnswerEvaluation | None = Field(
        default=None, json_schema_extra={"emit_null": True}
    )
    readiness_delta: list[ReadinessDeltaEntry]
    weak: bool


class HistoryMainQuestion(HistoryQuestionNode):
    follow_ups: list[HistoryQuestionNode]


class SessionHistoryEntry(CamelModel):
    session: HistorySessionView
    target: HistoryTargetRef | None = None
    loop: HistoryLoopRef | None = Field(default=None, json_schema_extra={"emit_null": True})
    questions: list[HistoryMainQuestion]
    actions_created: list[PrepActionRowLike]
    debrief: Any = Field(default=None, json_schema_extra={"emit_null": True})
    has_weak_answer: bool


class WeaknessRetestRate(CamelModel):
    weak_skills: int
    retested: int
    rate: float | None = None


class CompletionRate(CamelModel):
    done: int
    total: int
    rate: float | None = None


class CoverageRate(CamelModel):
    covered: int
    total: int
    rate: float | None = None


class MetricsView(CamelModel):
    loops_started: int
    loops_completed: int
    sessions_per_mode: dict[str, int]
    weakness_retest_rate: WeaknessRetestRate
    improvement_after_prep: float | None = None
    prep_completion_rate: CompletionRate
    readiness_coverage: CoverageRate
    usage: dict[str, int]


def _first_or_none[T](items: list[T], predicate: Callable[[T], bool]) -> T | None:
    return next((item for item in items if predicate(item)), None)


def _to_prep_action(action: PrepActionRowLike) -> PrepAction:
    return PrepAction.model_validate(action.model_dump())


def _to_question(question: OrchestratorQuestion) -> Question:
    return Question.model_validate(question.model_dump())


def _to_orchestrator_question(question: Question) -> OrchestratorQuestion:
    return OrchestratorQuestion.model_validate(question.model_dump())


class HistoryService:
    """§9.7 history, skill detail, session history and metrics.

    Usage events carry a name + timestamp only — never content (resumes,
    answers, notes).
    """

    USAGE_EVENTS: tuple[str, ...] = (
        "history.viewed",
        "target.switched",
        "resume.coach.used",
        "palette.used",
    )

    def __init__(
        self, ctx: WorkflowContext, *, graph_for_active: Callable[[], ReadinessGraph]
    ) -> None:
        self._ctx = ctx
        self._graph_for_active = graph_for_active

    async def get_state(self) -> InterviewOSState:
        store = self._ctx.store
        candidate_row = store.get_active_candidate()
        target_row = store.get_active_target()
        candidate: CandidateProfile = (
            candidate_row.data if candidate_row is not None else CandidateProfile(id="none")
        )
        target: TargetRole = (
            target_row.data
            if target_row is not None
            else TargetRole(id="none", company="", role="", level=Level.MID, job_description="")
        )

        evidence = self._ctx.evidence_for_active(candidate.id) if candidate_row is not None else []
        requirements = self._ctx.all_requirements(target) if target_row is not None else []
        graph = (
            build_readiness_graph(
                evidence=evidence,
                requirements=requirements,
                taxonomy=taxonomy,
                now=self._ctx.now(),
            )
            if evidence or requirements
            else ReadinessGraph(
                dimensions={}, overall=0, overall_confidence=0, last_updated=self._ctx.iso()
            )
        )
        latest = store.latest_readiness_by_skill()
        last_updated = (
            max((row.computed_at for row in latest.values()), default=graph.last_updated)
            if latest
            else graph.last_updated
        )

        gaps = (
            calculate_gaps(
                requirements=requirements,
                readiness=graph.dimensions,
                level=target.level,
                taxonomy=taxonomy,
            )
            if requirements
            else []
        )

        open_actions = [
            row_to_action(row.model_dump()) for row in store.list_actions("open", target.id)
        ]
        in_progress = [
            row_to_action(row.model_dump()) for row in store.list_actions("in_progress", target.id)
        ]
        done_actions = store.list_actions("done")

        sessions = store.list_sessions()
        active_session = sessions[0] if sessions else None
        session_questions = (
            [row_to_question(row.model_dump()) for row in store.list_questions(active_session.id)]
            if active_session is not None
            else []
        )
        session_answers: list[Answer] = (
            [
                Answer(
                    id=answer.id,
                    question_id=answer.question_id,
                    session_id=answer.session_id,
                    text=answer.text,
                    created_at=answer.created_at,
                )
                for answer in store.list_answers(active_session.id)
            ]
            if active_session is not None
            else []
        )
        answered_ids = {
            answer.question_id
            for answer in store.list_answers(active_session.id if active_session else "")
            if answer.status != "failed"
        }
        active_question = (
            next(
                (
                    question
                    for question in reversed(session_questions)
                    if question.id not in answered_ids
                ),
                None,
            )
            if active_session is not None and active_session.status == "question"
            else None
        )

        weak_evidence = [
            item for item in evidence if item.type == "interview_answer" and item.score < 0.5
        ]
        strong_evidence = [
            item for item in evidence if item.type == "interview_answer" and item.score >= 0.75
        ]
        session_evaluations = (
            store.list_evaluations(active_session.id) if active_session is not None else []
        )

        return InterviewOSState(
            candidate=candidate,
            target=target,
            assessment=AssessmentState(
                strengths=[
                    AssessedItem(
                        skill_id=item.skill_id, note=item.observation, evidence_ids=[item.id]
                    )
                    for item in strong_evidence
                ],
                gaps=gaps,
                weak_answers=[
                    AssessedItem(
                        skill_id=item.skill_id, note=item.observation, evidence_ids=[item.id]
                    )
                    for item in weak_evidence
                ],
                strong_answers=[
                    AssessedItem(
                        skill_id=item.skill_id, note=item.observation, evidence_ids=[item.id]
                    )
                    for item in strong_evidence
                ],
                observations=[row.data.summary or "" for row in session_evaluations],
                skill_assessments=graph.dimensions,
            ),
            preparation=PreparationState(
                priorities=[action.skill_id for action in open_actions],
                completed_topics=[action.skill_id for action in done_actions],
                next_actions=[_to_prep_action(action) for action in [*open_actions, *in_progress]],
                practice_history=[],
            ),
            interview=InterviewStateSlice(
                session_id=active_session.id if active_session is not None else None,
                current_round=active_session.current_round if active_session is not None else 0,
                previous_questions=[_to_question(question) for question in session_questions],
                previous_answers=session_answers,
                interviewer_observations=[],
                active_question=_to_question(active_question) if active_question else None,
            ),
            readiness=ReadinessGraph(
                overall=graph.overall,
                overall_confidence=graph.overall_confidence,
                dimensions=graph.dimensions,
                last_updated=last_updated,
            ),
        )

    async def get_skill_detail(self, skill_id: str) -> SkillDetail:
        store = self._ctx.store
        graph = self._graph_for_active()
        candidate_row = store.get_active_candidate()
        if candidate_row is None:
            raise AppError("NOT_FOUND", "no active candidate")
        target_row = store.get_active_target()
        target_id = target_row.id if target_row is not None else None
        open_action = store.open_action_for_skill(skill_id, target_id)
        return SkillDetail(
            skill_id=skill_id,
            readiness=graph.dimensions.get(skill_id),
            evidence=store.evidence_for_skill(skill_id, candidate_row.id),
            history=store.readiness_history(skill_id),
            actions=[
                row_to_action(row.model_dump())
                for row in store.actions_for_skill(skill_id, target_id)
            ],
            recommended_action=(
                None if open_action is None else row_to_action(open_action.model_dump())
            ),
        )

    async def list_interviews(self) -> list[InterviewListItem]:
        store = self._ctx.store
        entries: list[InterviewListItem] = []
        for session in store.list_sessions():
            target = store.get_target(session.target_id) if session.target_id else None
            debrief = store.get_debrief(session.id)
            entries.append(
                InterviewListItem(
                    **session.model_dump(),
                    mode_label=get_mode(session.round_type).label,
                    target=(
                        InterviewTargetRef(id=target.id, role=target.role, company=target.company)
                        if target is not None
                        else None
                    ),
                    questions=len(store.list_questions(session.id)),
                    debrief=None if debrief is None else debrief.data,
                )
            )
        return entries

    async def get_interview(self, id: str) -> InterviewDetail:
        store = self._ctx.store
        session = store.get_session(id)
        if session is None:
            raise AppError("NOT_FOUND", f"no session {id}")
        target = store.get_target(session.target_id) if session.target_id else None
        mode = get_mode(session.round_type)
        packs = self._ctx.packs
        if packs is not None:
            await packs.ready()
        company_profile: CompanyProfile = (
            packs.company_profile(target.data.company_profile_id or "generic")
            if packs is not None and target is not None
            else generic_profile
        )
        debrief = store.get_debrief(id)
        return InterviewDetail(
            session=InterviewSessionView(
                **session.model_dump(),
                mode_label=mode.label,
                answer_format=mode.answer_format,
                answer_fields=list(mode.answer_fields),
            ),
            questions=[row_to_question(row.model_dump()) for row in store.list_questions(id)],
            answers=store.list_answers(id),
            evaluations=[row.data for row in store.list_evaluations(id)],
            debrief=None if debrief is None else debrief.data,
            company_profile=CompanyProfileRef(
                id=company_profile.id,
                name=company_profile.name,
                disclaimer=company_profile.disclaimer,
            ),
        )

    async def record_usage_event(self, event: str) -> None:
        if event not in HistoryService.USAGE_EVENTS:
            raise AppError("VALIDATION", f'unknown usage event "{event}"')
        self._ctx.store.insert_usage_event(
            id=new_id("evt"), event=event, created_at=self._ctx.iso()
        )

    async def get_history(self, filters: HistoryFilters | None = None) -> list[SessionHistoryEntry]:
        """§9.7: session list for the History view. `weak_only` keeps sessions that
        contain at least one answer whose mean rubric (or primary score) < 0.5."""

        active = filters if filters is not None else HistoryFilters()
        sessions = [
            session
            for session in self._ctx.store.list_sessions()
            if (active.mode is None or session.round_type == active.mode)
            and (active.target_id is None or session.target_id == active.target_id)
            and (active.loop_id is None or session.loop_id == active.loop_id)
        ]
        entries = [await self._session_history_entry(session) for session in sessions]
        return [entry for entry in entries if not active.weak_only or entry.has_weak_answer]

    async def get_session_history(self, id: str) -> SessionHistoryEntry:
        session = self._ctx.store.get_session(id)
        if session is None:
            raise AppError("NOT_FOUND", f"no session {id}")
        return await self._session_history_entry(session)

    def _answer_mean_score(self, evaluation: AnswerEvaluation) -> float:
        """Mean of rubric scores when present, else mean of per-skill scores."""

        values = (
            [dimension.score for dimension in evaluation.rubric]
            if evaluation.rubric
            else [score.score for score in evaluation.scores]
        )
        return sum(values) / len(values) if values else 0

    async def _session_history_entry(self, session: SessionRow) -> SessionHistoryEntry:
        store = self._ctx.store
        target = store.get_target(session.target_id) if session.target_id else None
        loop = store.get_loop(session.loop_id) if session.loop_id else None
        loop_rounds = _LOOP_ROUNDS.validate_python(loop.rounds) if loop is not None else []
        questions = [row_to_question(row.model_dump()) for row in store.list_questions(session.id)]
        answers = store.list_answers(session.id)
        evaluations = store.list_evaluations(session.id)
        session_evidence_ids = {
            row.id
            for row in store.list_evidence(session.candidate_id)
            if row.session_id == session.id
        }
        actions_created = [
            row_to_action(action.model_dump())
            for action in store.list_actions()
            if session_evidence_ids.intersection(action.source_evidence_ids)
        ]

        def node(question: Question | OrchestratorQuestion) -> HistoryQuestionNode:
            answer = _first_or_none(
                answers,
                lambda item: item.question_id == question.id and item.status == "evaluated",
            ) or _first_or_none(answers, lambda item: item.question_id == question.id)
            evaluation_row = _first_or_none(
                evaluations, lambda item: item.question_id == question.id
            )
            evaluation = evaluation_row.data if evaluation_row is not None else None
            mean = self._answer_mean_score(evaluation) if evaluation is not None else None
            return HistoryQuestionNode(
                question=(
                    question
                    if isinstance(question, OrchestratorQuestion)
                    else _to_orchestrator_question(question)
                ),
                answer=(
                    HistoryAnswerView(
                        id=answer.id,
                        text=answer.text,
                        code=answer.code,
                        language=answer.language,
                        voice=answer.voice,
                        created_at=answer.created_at,
                    )
                    if answer is not None
                    else None
                ),
                evaluation=evaluation,
                readiness_delta=(
                    list(evaluation_row.readiness_delta) if evaluation_row is not None else []
                ),
                weak=mean is not None and mean < 0.5,
            )

        mains = [
            HistoryMainQuestion(
                **node(question).model_dump(),
                follow_ups=[
                    node(follow_up)
                    for follow_up in questions
                    if follow_up.follow_up_of == question.id
                ],
            )
            for question in questions
            if not question.follow_up_of
        ]
        has_weak_answer = any(
            main.weak or any(follow_up.weak for follow_up in main.follow_ups) for main in mains
        )
        loop_label: str | None = None
        if loop is not None:
            index = (session.loop_round or 1) - 1
            loop_label = loop_rounds[index].label if 0 <= index < len(loop_rounds) else None
        debrief = store.get_debrief(session.id)
        return SessionHistoryEntry(
            session=HistorySessionView(
                **session.model_dump(), mode_label=get_mode(session.round_type).label
            ),
            target=(
                HistoryTargetRef(
                    id=target.id,
                    role=target.role,
                    company=target.company,
                    company_profile_id=target.data.company_profile_id or "generic",
                )
                if target is not None
                else None
            ),
            loop=(
                HistoryLoopRef(
                    id=loop.id,
                    round=session.loop_round,
                    total_rounds=len(loop_rounds),
                    label=loop_label,
                )
                if loop is not None
                else None
            ),
            questions=mains,
            actions_created=actions_created,
            debrief=None if debrief is None else debrief.data,
            has_weak_answer=has_weak_answer,
        )

    async def get_metrics(self) -> MetricsView:
        """§9.7 metrics.

        - loopsStarted / loopsCompleted: loops created / status 'complete' and not
          abandoned.
        - sessionsPerMode: interview sessions grouped by roundType.
        - weaknessRetestRate: a weak skill is one with interview evidence < 0.5;
          it is "retested" when a later question (later createdAt) targets the
          same skill or a `relatedTo` skill. rate = retested / weak skills
          (null when there are no weak skills yet).
        - improvementAfterPrep: for each done action, first non-self_report
          evidence score for its skill after the action was created minus the
          latest score at/before creation; the metric is the mean delta
          (null when no action has both sides).
        - prepCompletionRate: done ÷ non-superseded actions.
        - readinessCoverage: requirements whose latest readiness snapshot has
          confidence ≥ 0.4 ÷ total requirements of the active target.
        - usage counters: counts of the allowed usage events by name.
        """

        store = self._ctx.store
        sessions = store.list_sessions()
        loops = store.list_loops()
        actions = store.list_actions()
        evidence = store.list_evidence()
        all_questions = [
            question for session in sessions for question in store.list_questions(session.id)
        ]

        sessions_per_mode: dict[str, int] = {}
        for session in sessions:
            mode = session.round_type or "mixed"
            sessions_per_mode[mode] = sessions_per_mode.get(mode, 0) + 1

        weak_skills = {
            item.skill_id
            for item in evidence
            if item.type == "interview_answer" and item.score < 0.5
        }
        retested = 0
        for skill_id in weak_skills:
            first_weak = min(
                (
                    item.created_at
                    for item in evidence
                    if item.skill_id == skill_id
                    and item.type == "interview_answer"
                    and item.score < 0.5
                ),
                default=None,
            )
            if first_weak is None:
                continue
            related = {skill_id, *taxonomy.related_to(skill_id)}
            if any(
                question.skill_id in related and question.created_at > first_weak
                for question in all_questions
            ):
                retested += 1

        deltas: list[float] = []
        for action in [item for item in actions if item.status == "done"]:
            items = sorted(
                (
                    item
                    for item in store.evidence_for_skill(action.skill_id)
                    if item.type != "self_report"
                ),
                key=lambda item: item.created_at,
            )
            before = next(
                (item for item in reversed(items) if item.created_at <= action.created_at), None
            )
            after = next((item for item in items if item.created_at > action.created_at), None)
            if before is not None and after is not None:
                deltas.append(after.score - before.score)

        active_target = store.get_active_target()
        requirements = active_target.data.requirements if active_target is not None else []
        latest = store.latest_readiness_by_skill()
        covered = sum(
            1
            for requirement in requirements
            if (latest[requirement.skill_id].confidence if requirement.skill_id in latest else 0)
            >= 0.4
        )

        done_actions = [action for action in actions if action.status == "done"]
        non_superseded = [action for action in actions if action.status != "superseded"]
        return MetricsView(
            loops_started=len(loops),
            loops_completed=len(
                [loop for loop in loops if loop.status == "complete" and not loop.abandoned]
            ),
            sessions_per_mode=sessions_per_mode,
            weakness_retest_rate=WeaknessRetestRate(
                weak_skills=len(weak_skills),
                retested=retested,
                rate=retested / len(weak_skills) if weak_skills else None,
            ),
            improvement_after_prep=(sum(deltas) / len(deltas) if deltas else None),
            prep_completion_rate=CompletionRate(
                done=len(done_actions),
                total=len(non_superseded),
                rate=len(done_actions) / len(non_superseded) if non_superseded else None,
            ),
            readiness_coverage=CoverageRate(
                covered=covered,
                total=len(requirements),
                rate=covered / len(requirements) if requirements else None,
            ),
            usage={event: store.count_usage_events(event) for event in HistoryService.USAGE_EVENTS},
        )
