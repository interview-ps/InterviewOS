"""Port of `tests/integration/feedback-loop.test.ts` — the product contract.

Runs the full readiness → gap → prep → interview → retest loop through the
`InterviewOrchestrator` facade on the deterministic MockRuntime.
"""

from __future__ import annotations

from typing import Any

from interview_os.orchestrator.services import SetupWorkspaceInput

from .conftest import App, load_example

DEEP_GAP_PREFIX = "distributed-systems"


def _field(obj: Any, name: str) -> Any:
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


def _session(result: Any) -> Any:
    assert result.session is not None
    return result.session


def _status(session: Any) -> str:
    return str(_field(session, "status"))


async def test_full_readiness_gap_prep_interview_retest_loop(app: App) -> None:
    orch, store = app.orchestrator, app.store

    # --- 1. Setup ---
    ex = load_example("backend-engineer")
    setup = await orch.setup_workspace(SetupWorkspaceInput.model_validate(ex))
    assert len(setup.gaps) > 0
    assert len(setup.actions) > 0
    state = await orch.get_state()

    r = state.readiness.dimensions
    assert r["python"].score >= 0.75
    assert r["apis"].score >= 0.75
    sql = r["sql"]
    assert sql.score >= 0.3
    assert sql.score < 0.7

    deep_gaps = [
        g for g in state.assessment.gaps if g.severity in ("high", "medium")
    ]
    assert any(
        g.skill_id.startswith(DEEP_GAP_PREFIX) or g.skill_id == "system-design"
        for g in deep_gaps
    )
    python_gap = next((g for g in state.assessment.gaps if g.skill_id == "python"), None)
    assert python_gap is None or python_gap.severity in ("none", "low")

    assert any(
        a.skill_id.startswith(DEEP_GAP_PREFIX) for a in state.preparation.next_actions
    )

    snapshots_after_setup = store.count_readiness_snapshots()
    assert snapshots_after_setup > 0

    # --- 2. First interview ---
    start1 = await orch.start_interview({"planned_questions": 1})
    session1 = _session(start1)
    q1 = start1.question
    assert q1 is not None
    assert q1.skill_id == "distributed-systems.caching"
    assert "cache entries consistent" in q1.text

    # --- 3. Poor answer ---
    result = await orch.submit_answer(
        session1.id,
        "I would put Redis in front of the database using cache-aside so reads are fast.",
    )

    evaln = result.evaluation
    inv_skill = "distributed-systems.caching.cache-invalidation"
    inv_weakness = next((w for w in evaln.weaknesses if w.skill == inv_skill), None)
    assert inv_weakness is not None
    assert inv_weakness.severity in ("medium", "high")

    inv_evidence = [
        e
        for e in store.list_evidence()
        if e.skill_id == "distributed-systems.caching.cache-invalidation"
        and e.type == "interview_answer"
    ]
    assert len(inv_evidence) == 1
    assert inv_evidence[0].session_id == session1.id
    assert inv_evidence[0].question_id == q1.id
    inv_evidence_id = inv_evidence[0].id

    inv_readiness = await orch.get_skill_detail(
        "distributed-systems.caching.cache-invalidation"
    )
    assert inv_readiness.readiness.status == "weak"
    assert inv_evidence_id in inv_readiness.readiness.evidence_ids

    assert store.count_readiness_snapshots() > snapshots_after_setup

    inv_action = next(
        (
            a
            for a in result.new_actions
            if a.skill_id == "distributed-systems.caching.cache-invalidation"
        ),
        None,
    )
    assert inv_action is not None
    assert "invalidat" in inv_action.action.lower()
    assert len(inv_action.success_criteria) >= 2

    # --- 4. Complete interview 1 ---
    for _guard in range(10):
        current = await orch.get_interview(session1.id)
        status = _status(current.session)
        if status in ("complete", "debrief"):
            break
        if status == "follow_up":
            nq = await orch.next_question(session1.id)
            if nq.question is None:
                break
        elif status == "question":
            q = current.questions[-1]
            await orch.submit_answer(
                session1.id,
                f"For {q.topic}: I would define clear ownership, name the trade-offs, and "
                "describe validation criteria; in practice I combine a ttl with explicit "
                "invalidation on writes.",
            )
    await orch.complete_interview(session1.id)
    done1 = await orch.get_interview(session1.id)
    assert _status(done1.session) == "debrief"
    assert done1.debrief is not None
    assert len(str(_field(done1.debrief, "summary"))) > 0

    # --- 5. Second interview retests the weakness ---
    asked_texts = [q.text for q in done1.questions]
    start2 = await orch.start_interview({"planned_questions": 2})
    q2 = start2.question
    assert q2 is not None
    assert q2.skill_id.startswith("distributed-systems.caching")
    assert q2.text not in asked_texts
    assert "weak" in (q2.selection_reason or "").lower()
    await orch.complete_interview(_session(start2).id)


async def test_multi_question_session_retests_weakness(app: App) -> None:
    orch, store = app.orchestrator, app.store
    ex = load_example("backend-engineer")
    await orch.setup_workspace(SetupWorkspaceInput.model_validate(ex))

    start1 = await orch.start_interview({"planned_questions": 4})
    s1 = _session(start1).id
    q1 = start1.question
    assert q1 is not None
    assert q1.skill_id == "distributed-systems.caching"

    await orch.submit_answer(
        s1, "I would put Redis in front of the database using cache-aside so reads are fast."
    )

    def good_answer(q: Any) -> str:
        concepts = q.expected_concepts or []
        body = "".join(
            f"I would use {_field(c, 'concept')} ({', '.join(_field(c, 'keywords') or [])}), "
            for c in concepts
        )
        return (
            f"For {q.topic}: {body}explaining the trade-offs and how I validated the approach."
        )

    def partial_answer(q: Any) -> str:
        concepts = q.expected_concepts or []
        first = _field(concepts[0], "concept") if concepts else "this"
        return (
            f"For {q.topic}: honestly I have limited hands-on experience with {first} — "
            "I would start there and look up the rest."
        )

    def answer_for(q: Any) -> str:
        return partial_answer(q) if "retesting" in (q.selection_reason or "") else good_answer(q)

    s1_questions: list[str] = [q1.skill_id]
    for _guard in range(10):
        cur = await orch.get_interview(s1)
        status = _status(cur.session)
        if status in ("complete", "debrief"):
            break
        if status == "follow_up":
            nq = await orch.next_question(s1)
            if nq.question is None:
                break
            s1_questions.append(nq.question.skill_id)
        elif status == "question":
            q = cur.questions[-1]
            await orch.submit_answer(s1, answer_for(q))
    await orch.complete_interview(s1)

    retest_in_session = [
        s
        for s in s1_questions[1:]
        if s.startswith("distributed-systems.caching.") or s == "distributed-systems.consistency"
    ]
    assert len(retest_in_session) > 0
    retest_q = next(
        q for q in (await orch.get_interview(s1)).questions if q.skill_id == retest_in_session[0]
    )
    assert "retest" in (retest_q.selection_reason or "").lower()

    weak_at_end = {
        e.skill_id
        for e in store.list_evidence()
        if e.type == "interview_answer" and e.score < 0.5
    }
    assert len(weak_at_end) > 0

    start2 = await orch.start_interview({"planned_questions": 4})
    s2 = _session(start2).id
    s2_questions = [start2.question] if start2.question is not None else []
    for _guard in range(10):
        if len(s2_questions) >= 4:
            break
        cur = await orch.get_interview(s2)
        status = _status(cur.session)
        if status == "question":
            await orch.submit_answer(s2, good_answer(cur.questions[-1]))
        elif status == "follow_up":
            nq = await orch.next_question(s2)
            if nq.question is None:
                break
            s2_questions.append(nq.question)
        else:
            break

    retest = next(
        (
            q
            for q in s2_questions
            if q is not None
            and q.skill_id in weak_at_end
            and "retest" in (q.selection_reason or "").lower()
        ),
        None,
    )
    assert retest is not None, [q.skill_id for q in s2_questions if q is not None]
    await orch.complete_interview(s2)


async def test_next_is_idempotent_while_a_question_is_pending(app: App) -> None:
    """A retried POST /next must not re-ask from `question`.

    A dropped stream (or a double click) that makes the client retry `/next`
    while a question is already pending used to raise
    `invalid interview transition: state "question" has no event "ask"`. The
    retry now returns the pending question without creating another one.
    """

    orch, store = app.orchestrator, app.store
    await orch.setup_workspace(SetupWorkspaceInput.model_validate(load_example("backend-engineer")))

    start = await orch.start_interview({"planned_questions": 4})
    session_id = _session(start).id
    assert start.question is not None

    retry = await orch.next_question(session_id)

    assert retry.question is not None
    assert retry.question.id == start.question.id
    assert retry.question.text == start.question.text
    assert len(store.list_questions(session_id)) == 1

