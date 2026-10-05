"""Store tests: migration, CRUD, JSON columns, transactions, append-only snapshots."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from interview_os.core.models import (
    AnswerEvaluation,
    CandidateProfile,
    ExpectedConcept,
    PrepResource,
    TargetRole,
)
from interview_os.store import (
    AnswerPluginReview,
    AnswerVoice,
    ReadinessDeltaEntry,
    Store,
    StoreDataError,
    open_store,
)
from interview_os.store.schema import TABLE_NAMES

CREATED_AT = "2026-01-01T00:00:00.000Z"


def _candidate() -> CandidateProfile:
    return CandidateProfile(
        id="cand_1",
        name="Jordan Reyes",
        headline="Backend engineer",
        skills=[],
    )


def _target() -> TargetRole:
    return TargetRole.model_validate(
        {
            "id": "target_1",
            "company": "Northwind Cloud",
            "role": "Senior Backend Engineer",
            "level": "senior",
            "jobDescription": "Own the payments API.",
            "requirements": [],
        }
    )


def _evaluation() -> AnswerEvaluation:
    return AnswerEvaluation.model_validate(
        {
            "summary": "Solid answer.",
            "dimensions": {
                "correctness": {"score": 0.8, "rationale": "ok"},
                "technicalDepth": {"score": 0.7, "rationale": "ok"},
                "reasoning": {"score": 0.75, "rationale": "ok"},
                "structure": {"score": 0.9, "rationale": "ok"},
                "communication": {"score": 0.85, "rationale": "ok"},
                "evidence": {"score": 0.6, "rationale": "ok"},
                "roleRelevance": {"score": 0.8, "rationale": "ok"},
            },
            "strengths": [{"skill": "apis.rest", "evidence": "idempotency keys"}],
            "weaknesses": [
                {"skill": "sql.transactions", "severity": "medium", "evidence": "no isolation"}
            ],
            "scores": [{"skill": "apis.rest", "score": 0.9, "confidence": 0.7}],
            "missingConcepts": ["conditional requests"],
            "betterApproach": "Lead with the contract.",
            "followUpTopics": ["pagination"],
        }
    )


def test_migrate_is_idempotent_and_creates_every_table(file_store: Store) -> None:
    file_store.migrate()
    file_store.migrate()
    existing = set(file_store._table_names())
    assert set(TABLE_NAMES) <= existing
    assert "alembic_version" in existing


def test_memory_store_has_every_table(memory_store: Store) -> None:
    assert set(TABLE_NAMES) <= set(memory_store._table_names())


def test_settings_crud(file_store: Store) -> None:
    assert file_store.get_setting("model") is None
    file_store.set_setting("model", "gpt-5")
    file_store.set_setting("model", "gpt-5-mini")
    assert file_store.get_setting("model") == "gpt-5-mini"
    assert file_store.all_settings() == {"model": "gpt-5-mini"}
    file_store.set_setting("model", None)
    assert file_store.all_settings() == {}


def test_candidate_and_target_json_columns_deserialize(file_store: Store) -> None:
    file_store.insert_candidate(
        id="cand_1",
        active=1,
        name="Jordan Reyes",
        headline="Backend engineer",
        resume_text="resume text",
        data=_candidate(),
        created_at=CREATED_AT,
    )
    file_store.insert_target(
        id="target_1",
        active=1,
        company="Northwind Cloud",
        role="Senior Backend Engineer",
        level="senior",
        job_description="Own the payments API.",
        data=_target(),
        created_at=CREATED_AT,
    )

    candidate = file_store.get_active_candidate()
    assert candidate is not None
    assert isinstance(candidate.data, CandidateProfile)
    assert candidate.data.name == "Jordan Reyes"
    assert candidate.resume_text == "resume text"

    target = file_store.get_active_target()
    assert target is not None
    assert isinstance(target.data, TargetRole)
    assert target.data.level == "senior"
    assert [row.id for row in file_store.list_targets()] == ["target_1"]

    stored = file_store.get_row("candidate_profiles", "cand_1")
    assert stored is not None
    assert json.loads(stored["data"])["id"] == "cand_1"


def test_activate_target_is_atomic(file_store: Store) -> None:
    for target_id in ("target_1", "target_2"):
        file_store.insert_target(
            id=target_id,
            active=1 if target_id == "target_1" else 0,
            company="Northwind Cloud",
            role="Senior Backend Engineer",
            level="senior",
            job_description="",
            data=_target(),
            created_at=CREATED_AT,
        )
    file_store.activate_target("target_2")
    active = file_store.get_active_target()
    assert active is not None and active.id == "target_2"
    assert sum(row.active for row in file_store.list_targets()) == 1


def test_session_question_answer_evaluation_evidence_round_trip(file_store: Store) -> None:
    file_store.insert_session(
        id="sess_1",
        created_at=CREATED_AT,
        candidate_id="cand_1",
        target_id="target_1",
        status="question",
        round_type="technical",
        mode_state={"covered": ["btree"]},
        focus_skills=["sql.indexing"],
        planned_questions=4,
    )
    session = file_store.get_session("sess_1")
    assert session is not None
    assert session.mode_state == {"covered": ["btree"]}
    assert session.focus_skills == ["sql.indexing"]
    assert session.status == "question"

    for position, question_id in enumerate(("q_2", "q_1")):
        file_store.insert_question(
            id=question_id,
            session_id="sess_1",
            skill_id="sql.indexing",
            text=f"Question {question_id}",
            created_at=CREATED_AT,
            topic="Index selection",
            sub_skills=["sql.query-optimization"],
            expected_concepts=[ExpectedConcept(concept="composite index", skill_id="sql.indexing")],
            selection_priority=0.7,
            selection_reason="high severity gap",
            selection_factors={"gap": 0.8},
            extra={"source": {"kind": "user_bank", "id": "bank"}},
            position=position,
        )
    questions = file_store.list_questions("sess_1")
    assert [question.id for question in questions] == ["q_2", "q_1"]
    assert questions[0].expected_concepts[0].concept == "composite index"
    assert questions[0].extra["source"]["kind"] == "user_bank"
    assert questions[0].selection_factors == {"gap": 0.8}

    file_store.insert_answer(
        id="ans_1",
        question_id="q_2",
        session_id="sess_1",
        text="Start from selectivity.",
        created_at=CREATED_AT,
        code="SELECT 1",
        language="sql",
        voice=AnswerVoice.model_validate(
            {
                "metrics": {"durationSec": 92.5, "longPauseCount": 3, "longestPauseSec": 9},
                "feedback": {
                    "signals": [
                        {"id": "structure", "status": "ok", "message": "Structured."},
                        {"id": "filler", "status": "ok", "message": "Normal."},
                        {"id": "pauses", "status": "watch", "message": "3 long pauses."},
                        {"id": "length", "status": "ok", "message": "Good range."},
                        {"id": "conclusion", "status": "ok", "message": "Lands."},
                        {"id": "clarity", "status": "ok", "message": "Parseable."},
                    ],
                    "wordCount": 184,
                    "fillerCount": 3,
                    "wordsPerMinute": 122.0,
                    "disclaimer": "Delivery hints only.",
                },
            }
        ),
        plugin_reviews=[
            AnswerPluginReview.model_validate(
                {"pluginId": "fake", "pluginName": "Fake", "observations": [{"text": "ok"}]}
            )
        ],
        fields={"approach": "selectivity", "indexes": 2},
    )
    answer = file_store.get_answer_for_question("q_2")
    assert answer is not None
    assert answer.code == "SELECT 1"
    assert answer.voice is not None and answer.voice.metrics.duration_sec == 92.5
    assert answer.plugin_reviews is not None
    assert answer.plugin_reviews[0].plugin_id == "fake"
    assert answer.fields == {"approach": "selectivity", "indexes": 2}
    assert file_store.get_evaluated_answer_for_question("q_2") is not None

    file_store.update_answer_status("ans_1", "failed")
    assert file_store.get_evaluated_answer_for_question("q_2") is None
    file_store.update_answer_status("ans_1", "evaluated")

    file_store.insert_evaluation(
        id="eval_1",
        answer_id="ans_1",
        question_id="q_2",
        session_id="sess_1",
        data=_evaluation(),
        created_at=CREATED_AT,
        readiness_delta=[
            ReadinessDeltaEntry.model_validate({"skillId": "sql", "before": 0.6, "after": 0.65})
        ],
    )
    evaluation = file_store.list_evaluations("sess_1")[0]
    assert isinstance(evaluation.data, AnswerEvaluation)
    assert evaluation.data.dimensions.correctness.score == 0.8
    assert evaluation.readiness_delta[0].skill_id == "sql"
    assert evaluation.readiness_delta[0].after == 0.65

    file_store.insert_evidence(
        id="ev_1",
        candidate_id="cand_1",
        skill_id="sql.indexing",
        type="interview_answer",
        score=0.9,
        confidence=0.5,
        observation="Explained composite ordering.",
        session_id="sess_1",
        question_id="q_2",
        source="plugin:postgres-interviewer",
        created_at=CREATED_AT,
    )
    evidence = file_store.evidence_for_skill("sql.indexing", "cand_1")
    assert [row.id for row in evidence] == ["ev_1"]
    assert evidence[0].source == "plugin:postgres-interviewer"
    assert file_store.list_evidence("cand_1") == evidence
    assert file_store.list_evidence() == evidence


def test_prep_action_json_columns_round_trip(file_store: Store) -> None:
    file_store.insert_action(
        id="act_1",
        skill_id="sql.indexing",
        priority=0.4,
        action="Practice index selection.",
        created_at=CREATED_AT,
        target_id="target_1",
        reason="high severity gap",
        success_criteria=["Names a composite index"],
        severity="high",
        source_evidence_ids=["ev_1"],
        resources=[
            PrepResource.model_validate(
                {
                    "skillId": "sql.indexing",
                    "title": "Use The Index, Luke",
                    "url": "https://use-the-index-luke.com/",
                    "kind": "article",
                    "source": "builtin",
                }
            )
        ],
    )
    file_store.insert_action(
        id="act_0",
        skill_id="sql",
        priority=0.1,
        action="Read the SQL tutorial.",
        created_at=CREATED_AT,
        target_id="target_1",
    )
    actions = file_store.list_actions("open", "target_1")
    assert [action.id for action in actions] == ["act_0", "act_1"]
    assert actions[1].resources[0].url == "https://use-the-index-luke.com/"
    assert actions[1].success_criteria == ["Names a composite index"]
    assert actions[1].source == "planner"

    assert file_store.open_action_for_skill("sql", "target_1") is not None
    file_store.update_action_status("act_1", "done")
    assert [action.id for action in file_store.actions_for_skill("sql.indexing")] == ["act_1"]
    file_store.update_action_priority("act_1", 0.9)
    prioritized = file_store.get_action("act_1")
    assert prioritized is not None and prioritized.priority == 0.9
    file_store.update_action_source_evidence("act_1", ["ev_1", "ev_2"])
    file_store.update_action_resources("act_1", [])
    updated = file_store.get_action("act_1")
    assert updated is not None
    assert updated.source_evidence_ids == ["ev_1", "ev_2"]
    assert updated.resources == []


def test_append_readiness_snapshot_appends(file_store: Store) -> None:
    for index, score in enumerate((0.4, 0.55, 0.62)):
        file_store.append_readiness_snapshot(
            skill_id="sql",
            score=score,
            confidence=0.1 * (index + 1),
            evidence_ids=[f"ev_{index}"],
            reason=f"snapshot {index}",
            computed_at=CREATED_AT,
        )
    assert file_store.count_readiness_snapshots() == 3
    history = file_store.readiness_history("sql")
    assert [row.id for row in history] == [3, 2, 1]
    assert history[0].score == 0.62
    assert history[0].evidence_ids == ["ev_2"]
    assert file_store.latest_readiness_by_skill()["sql"].score == 0.62
    assert [row.id for row in file_store.list_all_readiness()] == [1, 2, 3]


def test_readiness_snapshots_are_append_only(file_store: Store) -> None:
    file_store.append_readiness_snapshot(
        skill_id="sql",
        score=0.5,
        confidence=0.4,
        evidence_ids=["ev_1"],
        reason="one evidence row",
        computed_at=CREATED_AT,
    )
    with pytest.raises(StoreDataError):
        file_store.update_row("readiness_scores", 1, {"score": 0.9})
    with pytest.raises(StoreDataError):
        file_store.delete_row("readiness_scores", 1)
    with pytest.raises(StoreDataError):
        file_store.delete_rows_where("readiness_scores", skill_id="sql")
    assert file_store.count_readiness_snapshots() == 1


def test_transaction_commits_and_rolls_back(file_store: Store) -> None:
    with file_store.transaction() as tx:
        tx.set_setting("committed", "1")
    assert file_store.get_setting("committed") == "1"

    with pytest.raises(RuntimeError):
        with file_store.transaction() as tx:
            tx.set_setting("rolled", "1")
            raise RuntimeError("boom")
    assert file_store.get_setting("rolled") is None


def test_nested_transaction_uses_savepoint(file_store: Store) -> None:
    with file_store.transaction() as tx:
        tx.set_setting("outer", "1")
        with pytest.raises(RuntimeError):
            with tx.transaction() as inner:
                inner.set_setting("inner", "1")
                raise RuntimeError("boom")
        assert tx.get_setting("inner") is None
        tx.set_setting("after", "1")

    assert file_store.all_settings() == {"outer": "1", "after": "1"}


def test_transaction_reentered_through_the_root_store(file_store: Store) -> None:
    with file_store.transaction() as tx:
        tx.set_setting("outer", "1")
        with file_store.transaction() as inner:
            inner.set_setting("inner", "1")
    assert file_store.all_settings() == {"outer": "1", "inner": "1"}


def test_generic_row_access(file_store: Store) -> None:
    file_store.insert_row(
        "usage_events",
        {"id": "usage_1", "event": "workflow.started", "created_at": CREATED_AT},
    )
    assert file_store.list_rows("usage_events") == [
        {"id": "usage_1", "event": "workflow.started", "created_at": CREATED_AT}
    ]
    assert file_store.get_row("usage_events", "usage_1") == {
        "id": "usage_1",
        "event": "workflow.started",
        "created_at": CREATED_AT,
    }
    file_store.update_row("usage_events", "usage_1", {"event": "workflow.completed"})
    updated = file_store.get_row("usage_events", "usage_1")
    assert updated is not None and updated["event"] == "workflow.completed"
    file_store.delete_row("usage_events", "usage_1")
    assert file_store.list_rows("usage_events") == []

    file_store.insert_row(
        "plugin_settings",
        {"plugin_id": "fake", "key": "difficulty", "value": json.dumps("hard")},
    )
    file_store.delete_rows_where("plugin_settings", plugin_id="fake")
    assert file_store.list_rows("plugin_settings") == []


def test_unknown_table_and_composite_pk_are_rejected(file_store: Store) -> None:
    with pytest.raises(StoreDataError):
        file_store.list_rows("not_a_table")
    with pytest.raises(StoreDataError):
        file_store.get_row("plugin_settings", "fake")


def test_corrupt_json_column_raises_store_data_error(file_store: Store) -> None:
    file_store.insert_row(
        "candidate_profiles",
        {
            "id": "cand_broken",
            "active": 1,
            "resume_text": "",
            "data": "{not json",
            "created_at": CREATED_AT,
        },
    )
    with pytest.raises(StoreDataError) as error:
        file_store.get_active_candidate()
    assert error.value.table == "candidate_profiles"
    assert error.value.column == "data"


def test_row_models_serialize_by_alias(file_store: Store) -> None:
    file_store.insert_evidence(
        id="ev_1",
        skill_id="sql",
        type="practice",
        score=0.5,
        confidence=0.4,
        created_at=CREATED_AT,
    )
    dumped = file_store.list_evidence()[0].model_dump(mode="json", by_alias=True)
    assert dumped["skillId"] == "sql"
    assert dumped["createdAt"] == CREATED_AT


def test_opens_a_copy_of_the_real_database(tmp_path: Path, repo_root: Path) -> None:
    real = repo_root / "data" / "interview-os.db"
    if not real.exists():
        pytest.skip("data/interview-os.db does not exist on this host")
    copy = tmp_path / "interview-os.db"
    for suffix in ("", "-wal", "-shm"):
        source = real.with_name(real.name + suffix)
        if source.exists():
            shutil.copy(source, copy.with_name(copy.name + suffix))

    store = open_store(copy)
    try:
        assert set(TABLE_NAMES) <= set(store._table_names())
        candidate = store.get_active_candidate()
        if candidate is not None:
            assert candidate.data.id == candidate.id
        assert store.count_readiness_snapshots() >= 0
    finally:
        store.close()
    assert real.exists()
