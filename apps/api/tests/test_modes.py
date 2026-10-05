"""Mode registry: the plugin-registration path the golden fixtures exclude.

`tests/golden/README.md` records the no-plugins behaviour for `getMode`; the
plugin-declared modes (scope, fallback skills, follow-up rules, reduce) are
covered here so the registry phase 7 builds on is tested.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest

from interview_os.core.models.assessment import AnswerEvaluation
from interview_os.core.models.skills import PluginModeDefinition
from interview_os.core.modes import (
    LoadedPluginMode,
    ModePrompts,
    ModeQuestionContext,
    all_modes,
    get_mode,
    is_mode_available,
    is_mode_id,
    mode_plugin_id,
    register_plugin_modes,
    reset_plugin_modes,
    unregister_plugin_modes,
)
from interview_os.core.rounds import in_round, round_fallback_requirements

DIMENSION: dict[str, Any] = {"score": 0.8, "rationale": ""}


def _evaluation(rubric_score: float = 0.5) -> AnswerEvaluation:
    return AnswerEvaluation.model_validate(
        {
            "summary": "s",
            "dimensions": {
                "correctness": DIMENSION,
                "technicalDepth": DIMENSION,
                "reasoning": DIMENSION,
                "structure": DIMENSION,
                "communication": DIMENSION,
                "evidence": DIMENSION,
                "roleRelevance": DIMENSION,
            },
            "strengths": [],
            "weaknesses": [],
            "scores": [],
            "missingConcepts": ["idempotency"],
            "betterApproach": "b",
            "followUpTopics": [],
            "rubric": [{"id": "clarity", "label": "Clarity", "score": rubric_score}],
        }
    )


def _mode(**overrides: Any) -> LoadedPluginMode:
    payload: dict[str, Any] = {
        "id": "technical",
        "label": "Technical",
        "description": "d",
        "scope": {"include": ["sql"], "exclude": ["sql.transactions"]},
        "rubric": [{"id": "clarity", "label": "Clarity", "description": "d"}],
        "answerFormat": "text",
    }
    payload.update(overrides)
    return LoadedPluginMode(
        definition=PluginModeDefinition.model_validate(payload),
        prompts=ModePrompts(interviewer="i", evaluator="e"),
    )


@pytest.fixture(autouse=True)
def _clean_registry() -> Iterator[None]:
    reset_plugin_modes()
    yield
    reset_plugin_modes()


def test_mixed_round_is_always_available() -> None:
    mixed = get_mode("mixed")
    assert mixed.available is True
    assert mixed.in_scope("sql") is True
    assert mixed.fallback_skills == ()
    assert mixed.label == "Mixed"
    assert is_mode_available("mixed") is True
    assert is_mode_id("mixed") is False
    assert all_modes() == []


def test_unknown_mode_is_the_unavailable_placeholder() -> None:
    placeholder = get_mode("system_design")
    assert placeholder.available is False
    assert placeholder.in_scope("sql") is False
    assert placeholder.fallback_skills == ()
    assert placeholder.label == "System Design"
    assert get_mode("system_design") is placeholder
    assert is_mode_available("system_design") is False
    assert mode_plugin_id("system_design") is None
    assert in_round("sql", "system_design") is False
    assert round_fallback_requirements("system_design") == []


def test_registered_mode_scopes_include_minus_exclude() -> None:
    register_plugin_modes("technical-mode", [_mode()])
    definition = get_mode("technical")
    assert definition.available is True
    assert definition.in_scope("sql") is True
    assert definition.in_scope("sql.indexing") is True
    assert definition.in_scope("sql.transactions") is False
    assert definition.in_scope("python") is False
    assert in_round("sql.indexing", "technical") is True
    assert is_mode_id("technical") is True
    assert is_mode_available("technical") is True
    assert mode_plugin_id("technical") == "technical-mode"
    assert [mode.id for mode in all_modes()] == ["technical"]
    assert definition.prompts == ModePrompts(interviewer="i", evaluator="e")


def test_fallback_skills_default_to_include_roots_plus_children() -> None:
    register_plugin_modes("technical-mode", [_mode()])
    requirements = round_fallback_requirements("technical")
    assert [r.skill_id for r in requirements] == [
        "sql",
        "sql.indexing",
        "sql.query-optimization",
        "sql.transactions",
    ]
    assert {r.label for r in requirements} == {
        "SQL",
        "SQL Indexing",
        "SQL Query Optimization",
        "SQL Transactions",
    }
    assert all(r.importance == 0.6 for r in requirements)
    assert all(r.kind == "required" for r in requirements)
    assert all(r.evidence == "round coverage" for r in requirements)


def test_explicit_fallback_skills_win() -> None:
    register_plugin_modes("technical-mode", [_mode(fallbackSkills=["sql.indexing"])])
    assert [r.skill_id for r in round_fallback_requirements("technical")] == ["sql.indexing"]


def test_collisions_are_rejected() -> None:
    register_plugin_modes("technical-mode", [_mode()])
    with pytest.raises(ValueError, match='collides with the reserved "mixed" round'):
        register_plugin_modes("other", [_mode(id="mixed")])
    with pytest.raises(ValueError, match='collides with plugin "technical-mode"'):
        register_plugin_modes("other", [_mode()])


def test_unregister_and_reset() -> None:
    register_plugin_modes("technical-mode", [_mode()])
    unregister_plugin_modes("technical-mode")
    assert get_mode("technical").available is False
    register_plugin_modes("technical-mode", [_mode()])
    reset_plugin_modes()
    assert all_modes() == []


def test_follow_up_rules_and_never_policy() -> None:
    register_plugin_modes(
        "technical-mode",
        [
            _mode(
                followUpRules=[{"rubricId": "clarity", "below": 0.6, "focus": "structure"}],
            )
        ],
    )
    definition = get_mode("technical")
    weak = definition.follow_up(_evaluation(0.5), {}, 0, 1)
    assert weak.ask is True
    assert weak.focus == "structure"
    assert weak.reason == "clarity scored 0.50 — probe structure"
    strong = definition.follow_up(_evaluation(0.7), {}, 0, 1)
    assert strong.ask is False
    assert strong.reason == "no follow-up rule matched"
    depth_reached = definition.follow_up(_evaluation(0.5), {}, 1, 1)
    assert depth_reached.ask is False
    assert depth_reached.reason == "follow-up depth reached"

    reset_plugin_modes()
    register_plugin_modes("technical-mode", [_mode(followUp="never")])
    never = get_mode("technical").follow_up(_evaluation(0.5), {}, 0, 1)
    assert never.ask is False
    assert never.reason == 'mode "technical" does not chain follow-ups'

    reset_plugin_modes()
    register_plugin_modes("technical-mode", [_mode(followUp="never", followUpReason="no probes")])
    assert get_mode("technical").follow_up(_evaluation(0.5), {}, 0, 1).reason == "no probes"


def test_generic_follow_up_probes_the_first_missing_concept() -> None:
    register_plugin_modes("technical-mode", [_mode(followUp="generic")])
    decision = get_mode("technical").follow_up(_evaluation(0.5), {}, 0, 1)
    assert decision.ask is True
    assert decision.focus == "idempotency"
    assert decision.reason == 'probing "idempotency" — Clarity scored 0.50'


def test_reduce_sets_constants_and_copies_extra() -> None:
    register_plugin_modes(
        "technical-mode",
        [_mode(reduce={"set": {"phase": "coding"}, "copyExtra": ["problemId"]})],
    )
    definition = get_mode("technical")
    context = ModeQuestionContext(skill_id="sql.indexing", topic="t", extra={"problemId": "p1"})
    assert definition.reduce({"seen": True}, _evaluation(), context) == {
        "seen": True,
        "phase": "coding",
        "problemId": "p1",
    }
    without_extra = ModeQuestionContext(skill_id="sql.indexing", topic="t")
    assert definition.reduce({}, _evaluation(), without_extra) == {"phase": "coding"}
    assert definition.initial_state() == {}
