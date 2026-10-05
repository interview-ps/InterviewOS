"""HistoryService: state, skill detail, interview views, history and metrics."""

from __future__ import annotations

import pytest

from interview_os.core.models import (
    AnswerEvaluation,
    AppError,
    CandidateProfile,
    EvaluationDimension,
    EvaluationDimensions,
    InterviewStatus,
    RubricScore,
    SkillScore,
    TargetRole,
)
from interview_os.orchestrator.context import WorkflowContext
from interview_os.orchestrator.services.history import HistoryFilters, HistoryService

from .conftest import iso_now


def _dimension() -> EvaluationDimension:
    return EvaluationDimension(score=1.0, rationale="ok")


def _service(ctx: WorkflowContext) -> HistoryService:
    return HistoryService(ctx, graph_for_active=ctx.graph_for_active)


def _insert_session(
    ctx: WorkflowContext,
    session_id: str,
    *,
    round_type: str = "technical",
    status: str = InterviewStatus.QUESTION.value,
    loop_id: str | None = None,
    loop_round: int | None = None,
) -> None:
    ctx.store.insert_session(
        id=session_id,
        candidate_id="cand_test",
        target_id="target_test",
        status=status,
        mode="practice",
        round_type=round_type,
        loop_id=loop_id,
        loop_round=loop_round,
        created_at=iso_now(),
    )


def _insert_question(
    ctx: WorkflowContext, question_id: str, session_id: str, **overrides: object
) -> None:
    ctx.store.insert_question(
        id=question_id,
        session_id=session_id,
        skill_id=str(overrides.pop("skill_id", "sql")),
        text=str(overrides.pop("text", "Explain a covering index in PostgreSQL.")),
        created_at=iso_now(),
        **overrides,  # type: ignore[arg-type]
    )


def _insert_evaluation(
    ctx: WorkflowContext, session_id: str, question_id: str, *, rubric_score: float
) -> None:
    answer_id = f"ans_{question_id}"
    ctx.store.insert_answer(
        id=answer_id,
        question_id=question_id,
        session_id=session_id,
        text="I used a covering index.",
        created_at=iso_now(),
    )
    ctx.store.insert_evaluation(
        id=f"ev_{question_id}",
        answer_id=answer_id,
        question_id=question_id,
        session_id=session_id,
        data=AnswerEvaluation(
            summary="Solid answer",
            dimensions=EvaluationDimensions(
                correctness=_dimension(),
                technical_depth=_dimension(),
                reasoning=_dimension(),
                structure=_dimension(),
                communication=_dimension(),
                evidence=_dimension(),
                role_relevance=_dimension(),
            ),
            strengths=[],
            weaknesses=[],
            scores=[SkillScore(skill="sql", score=rubric_score, confidence=0.5)],
            missing_concepts=[],
            better_approach="",
            follow_up_topics=[],
            rubric=[RubricScore(id="clarity", label="Clarity", score=rubric_score)],
        ),
        created_at=iso_now(),
    )


async def test_get_state_without_a_workspace(ctx: WorkflowContext) -> None:
    state = await _service(ctx).get_state()
    assert state.candidate.id == "none"
    assert state.target.id == "none"
    assert state.readiness.overall == 0
    assert state.assessment.gaps == []
    assert state.preparation.next_actions == []
    assert state.interview.session_id is None
    assert state.interview.active_question is None


async def test_get_state_with_workspace(
    ctx: WorkflowContext, workspace: tuple[CandidateProfile, TargetRole]
) -> None:
    store = ctx.store
    store.insert_evidence(
        id="ev_1",
        candidate_id="cand_test",
        skill_id="sql",
        type="interview_answer",
        score=0.3,
        confidence=0.5,
        observation="Struggled with indexes",
        created_at=iso_now(),
    )
    store.insert_action(
        id="act_1",
        skill_id="sql",
        target_id="target_test",
        priority=1.0,
        action="Practice index questions",
        status="open",
        created_at=iso_now(),
    )
    _insert_session(ctx, "sess_1")
    _insert_question(ctx, "q_1", "sess_1")

    state = await _service(ctx).get_state()

    assert state.candidate.id == "cand_test"
    assert state.target.id == "target_test"
    assert state.readiness.overall > 0
    assert set(state.readiness.dimensions) >= {"sql", "distributed-systems"}
    assert [item.note for item in state.assessment.weak_answers] == ["Struggled with indexes"]
    assert state.assessment.gaps
    assert state.preparation.priorities == ["sql"]
    assert [action.id for action in state.preparation.next_actions] == ["act_1"]
    assert state.interview.session_id == "sess_1"
    assert [question.id for question in state.interview.previous_questions] == ["q_1"]
    assert state.interview.active_question is not None
    assert state.interview.active_question.id == "q_1"


async def test_get_skill_detail_requires_a_workspace(ctx: WorkflowContext) -> None:
    with pytest.raises(AppError) as error:
        await _service(ctx).get_skill_detail("sql")
    assert error.value.code == "NO_ACTIVE_PROFILE"


async def test_get_skill_detail(
    ctx: WorkflowContext, workspace: tuple[CandidateProfile, TargetRole]
) -> None:
    ctx.store.insert_evidence(
        id="ev_1",
        candidate_id="cand_test",
        skill_id="sql",
        type="interview_answer",
        score=0.8,
        confidence=0.5,
        observation="Strong",
        created_at=iso_now(),
    )
    detail = await _service(ctx).get_skill_detail("sql")
    assert detail.skill_id == "sql"
    assert [row.id for row in detail.evidence] == ["ev_1"]
    assert detail.readiness is not None
    assert detail.recommended_action is None
    assert detail.actions == []


async def test_list_interviews_and_get_interview(
    ctx: WorkflowContext, workspace: tuple[CandidateProfile, TargetRole]
) -> None:
    _insert_session(ctx, "sess_1")
    _insert_question(ctx, "q_1", "sess_1")

    entries = await _service(ctx).list_interviews()
    assert len(entries) == 1
    assert entries[0].id == "sess_1"
    assert entries[0].questions == 1
    assert entries[0].debrief is None
    assert entries[0].target is not None
    assert entries[0].target.role == "Senior Backend Engineer"

    detail = await _service(ctx).get_interview("sess_1")
    assert detail.session.mode_label == "Technical"
    assert detail.session.answer_format == "text"
    assert [question.id for question in detail.questions] == ["q_1"]
    assert detail.answers == []
    assert detail.evaluations == []
    assert detail.company_profile.id == "generic"

    with pytest.raises(AppError) as error:
        await _service(ctx).get_interview("sess_missing")
    assert error.value.code == "NOT_FOUND"
    assert error.value.args[0] == "no session sess_missing"


async def test_record_usage_event(ctx: WorkflowContext) -> None:
    service = _service(ctx)
    await service.record_usage_event("history.viewed")
    with pytest.raises(AppError) as error:
        await service.record_usage_event("nope")
    assert error.value.code == "VALIDATION"
    assert error.value.args[0] == 'unknown usage event "nope"'

    metrics = await service.get_metrics()
    assert metrics.usage == {
        "history.viewed": 1,
        "target.switched": 0,
        "resume.coach.used": 0,
        "palette.used": 0,
    }


async def test_history_filters_and_weak_only(
    ctx: WorkflowContext, workspace: tuple[CandidateProfile, TargetRole]
) -> None:
    _insert_session(ctx, "sess_tech", round_type="technical")
    _insert_question(ctx, "q_tech", "sess_tech")
    _insert_evaluation(ctx, "sess_tech", "q_tech", rubric_score=0.3)

    _insert_session(ctx, "sess_behav", round_type="behavioral")
    _insert_question(ctx, "q_behav", "sess_behav", skill_id="behavioral.ownership")
    _insert_evaluation(ctx, "sess_behav", "q_behav", rubric_score=0.9)

    service = _service(ctx)
    assert [entry.session.id for entry in await service.get_history()] == [
        "sess_behav",
        "sess_tech",
    ]
    assert [
        entry.session.id for entry in await service.get_history(HistoryFilters(mode="technical"))
    ] == ["sess_tech"]
    assert await service.get_history(HistoryFilters(target_id="other")) == []
    assert await service.get_history(HistoryFilters(loop_id="loop_x")) == []
    weak = await service.get_history(HistoryFilters(weak_only=True))
    assert [entry.session.id for entry in weak] == ["sess_tech"]
    assert weak[0].has_weak_answer is True
    assert weak[0].questions[0].weak is True
    assert weak[0].questions[0].evaluation is not None
    assert weak[0].questions[0].answer is not None

    single = await service.get_session_history("sess_behav")
    assert single.session.id == "sess_behav"
    assert single.questions[0].weak is False

    with pytest.raises(AppError) as error:
        await service.get_session_history("sess_missing")
    assert error.value.code == "NOT_FOUND"


async def test_session_history_links_loop_and_actions(
    ctx: WorkflowContext, workspace: tuple[CandidateProfile, TargetRole]
) -> None:
    ctx.store.insert_loop(
        id="loop_1",
        target_id="target_test",
        rounds=[
            {"mode": "technical", "label": "Tech screen", "plannedQuestions": 2},
            {"mode": "behavioral", "label": "Behavioral", "plannedQuestions": 2},
        ],
        status="in_progress",
        created_at=iso_now(),
    )
    _insert_session(ctx, "sess_1", loop_id="loop_1", loop_round=1)
    _insert_question(ctx, "q_1", "sess_1")
    ctx.store.insert_evidence(
        id="ev_1",
        candidate_id="cand_test",
        skill_id="sql",
        type="interview_answer",
        score=0.4,
        confidence=0.5,
        observation="weak",
        session_id="sess_1",
        created_at=iso_now(),
    )
    ctx.store.insert_action(
        id="act_1",
        skill_id="sql",
        target_id="target_test",
        priority=1.0,
        action="Practice",
        source_evidence_ids=["ev_1"],
        created_at=iso_now(),
    )

    entry = await _service(ctx).get_session_history("sess_1")
    assert entry.loop is not None
    assert entry.loop.id == "loop_1"
    assert entry.loop.label == "Tech screen"
    assert entry.loop.total_rounds == 2
    assert entry.loop.round == 1
    assert [action.id for action in entry.actions_created] == ["act_1"]
    assert entry.has_weak_answer is False


async def test_metrics(
    ctx: WorkflowContext, workspace: tuple[CandidateProfile, TargetRole]
) -> None:
    ctx.store.insert_loop(
        id="loop_done",
        target_id="target_test",
        rounds=[],
        status="complete",
        created_at=iso_now(),
    )
    ctx.store.insert_loop(
        id="loop_abandoned",
        target_id="target_test",
        rounds=[],
        status="complete",
        abandoned=1,
        created_at=iso_now(),
    )
    _insert_session(ctx, "sess_tech", round_type="technical")
    _insert_session(
        ctx, "sess_tech_2", round_type="technical", status=InterviewStatus.COMPLETE.value
    )
    _insert_session(ctx, "sess_behav", round_type="behavioral")
    _insert_question(ctx, "q_late", "sess_behav", skill_id="sql")
    ctx.store.insert_evidence(
        id="ev_weak",
        candidate_id="cand_test",
        skill_id="sql",
        type="interview_answer",
        score=0.4,
        confidence=0.5,
        observation="weak",
        session_id="sess_tech",
        created_at="2024-01-01T00:00:00.000Z",
    )
    ctx.store.insert_evidence(
        id="ev_after",
        candidate_id="cand_test",
        skill_id="sql",
        type="interview_answer",
        score=0.8,
        confidence=0.5,
        observation="improved",
        created_at="2024-03-01T00:00:00.000Z",
    )
    ctx.store.insert_action(
        id="act_done",
        skill_id="sql",
        target_id="target_test",
        priority=1.0,
        action="Practice",
        status="done",
        created_at="2024-02-01T00:00:00.000Z",
    )
    ctx.store.insert_action(
        id="act_open",
        skill_id="sql",
        target_id="target_test",
        priority=2.0,
        action="More practice",
        created_at=iso_now(),
    )
    ctx.store.insert_action(
        id="act_superseded",
        skill_id="sql",
        target_id="target_test",
        priority=3.0,
        action="Old",
        status="superseded",
        created_at=iso_now(),
    )
    ctx.store.append_readiness_snapshot(
        skill_id="sql",
        score=0.8,
        confidence=0.5,
        evidence_ids=["ev_after"],
        reason="test",
        computed_at=iso_now(),
    )

    metrics = await _service(ctx).get_metrics()

    assert metrics.loops_started == 2
    assert metrics.loops_completed == 1
    assert metrics.sessions_per_mode == {"technical": 2, "behavioral": 1}
    assert metrics.weakness_retest_rate.weak_skills == 1
    assert metrics.weakness_retest_rate.retested == 1
    assert metrics.weakness_retest_rate.rate == 1.0
    assert metrics.improvement_after_prep == pytest.approx(0.4)
    assert metrics.prep_completion_rate.done == 1
    assert metrics.prep_completion_rate.total == 2
    assert metrics.prep_completion_rate.rate == pytest.approx(0.5)
    assert metrics.readiness_coverage.covered == 1
    assert metrics.readiness_coverage.total == 2
    assert metrics.readiness_coverage.rate == 0.5
