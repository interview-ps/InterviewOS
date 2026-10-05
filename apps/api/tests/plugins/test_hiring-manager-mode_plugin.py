"""Bundled `hiring-manager-mode` plugin — the Python port (phase 7 §13)."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Protocol, cast

from interview_os.core.models.assessment import (
    AnswerEvaluation,
    EvaluationDimension,
    EvaluationDimensions,
)
from interview_os.core.plugin_api import (
    ModeMockRequest,
    ModeMockResponse,
    ModeReduceQuestion,
    ModeReduceRequest,
    ModeReduceResponse,
)
from interview_os.plugins import LoadedPlugin, PluginRegistry, load_plugin_dir

REPO_ROOT = Path(__file__).resolve().parents[4]
PLUGIN_DIR = REPO_ROOT / "plugins" / "hiring-manager-mode"

QUESTION: dict[str, Any] = {
    "text": "How would you keep cache entries consistent?",
    "skillId": "distributed-systems.caching",
    "expectedConcepts": [
        {
            "concept": "cache-aside / read-through",
            "skillId": "distributed-systems.caching.cache-strategies",
            "keywords": ["cache-aside", "read-through", "lazy load"],
        },
        {
            "concept": "TTL / expiration",
            "skillId": "distributed-systems.caching.cache-invalidation",
            "keywords": ["ttl", "expir"],
        },
        {
            "concept": "explicit invalidation on write",
            "skillId": "distributed-systems.caching.cache-invalidation",
            "keywords": ["invalidat", "delete the key", "evict"],
        },
    ],
}

ANSWER = (
    "When I led the migration, my task was to reduce latency. I decided to use a cache-aside "
    "strategy with a TTL, and I invalidated keys on write. The result reduced p95 by 40% and "
    "improved the customer experience. I learned a lot."
)


class HiringManagerModeHook(Protocol):
    """The middleware surface this plugin contributes."""

    async def mode_reduce(self, req: ModeReduceRequest) -> ModeReduceResponse: ...

    async def mode_mock(self, req: ModeMockRequest) -> ModeMockResponse: ...


def _evaluation() -> AnswerEvaluation:
    dimension = EvaluationDimension(score=0.5, rationale="mock")
    return AnswerEvaluation(
        summary="mock",
        dimensions=EvaluationDimensions(
            correctness=dimension,
            technical_depth=dimension,
            reasoning=dimension,
            structure=dimension,
            communication=dimension,
            evidence=dimension,
            role_relevance=dimension,
        ),
        strengths=[],
        weaknesses=[],
        scores=[],
        missing_concepts=[],
        better_approach="mock",
        follow_up_topics=[],
    )


def _load() -> LoadedPlugin:
    PluginRegistry.reset()
    return load_plugin_dir(PLUGIN_DIR, install_deps=False)


def _hook(loaded: LoadedPlugin) -> HiringManagerModeHook:
    return cast(HiringManagerModeHook, loaded.middleware[0].instance)


def test_manifest_declares_a_hook_plugin() -> None:
    loaded = _load()
    manifest = loaded.manifest
    assert manifest.id == "hiring-manager-mode"
    assert manifest.version == "1.0.0"
    assert manifest.name == "Hiring Manager Mode"
    assert manifest.description == (
        "Scope, impact, priorities and leadership style — the conversation a hiring manager "
        "would have."
    )
    assert manifest.kind == "hook"
    assert manifest.entry == "main.py"
    assert [mode.id for mode in manifest.modes] == ["hiring_manager"]
    assert [dim.id for dim in manifest.modes[0].rubric] == [
        "roleFit",
        "scopeImpact",
        "prioritization",
        "leadership",
        "collaboration",
        "motivation",
    ]
    assert [entry.plugin_id for entry in loaded.middleware] == ["hiring-manager-mode"]


async def test_mode_reduce_tracks_covered_themes() -> None:
    hook = _hook(_load())
    response = await hook.mode_reduce(
        ModeReduceRequest(
            mode_id="hiring_manager",
            state={"themesCovered": ["Role fit"]},
            evaluation=_evaluation(),
            question=ModeReduceQuestion(
                skill_id="hiring-manager.prioritization",
                topic="Prioritization trade-off",
                extra={},
            ),
        )
    )
    assert isinstance(response, ModeReduceResponse)
    assert response.state["themesCovered"] == ["Role fit", "Prioritization trade-off"]


async def test_mode_mock_interviewer_uses_the_mode_template() -> None:
    hook = _hook(_load())
    response = await hook.mode_mock(
        ModeMockRequest(
            mode_id="hiring_manager",
            task="interviewer",
            input={
                "skillId": "hiring-manager.scope-impact",
                "label": "Scope & impact",
                "previousQuestions": [],
                "skillKeywords": [],
            },
        )
    )
    output = response.output
    assert output["question"] == (
        "Tell me about the most impactful project you've owned end-to-end — what was the "
        "scope and the measurable outcome?"
    )
    assert output["topic"] == "Scope and impact"
    assert output["subSkills"] == ["hiring-manager.scope-impact"]
    assert [item["concept"] for item in output["expectedConcepts"]] == [
        "Scope described",
        "Measurable impact",
    ]
    assert output["difficulty"] == "medium"
    assert output["problem"] is None
    assert output["focusDimension"] is None


async def test_mode_mock_interviewer_uses_the_hiring_manager_follow_up() -> None:
    hook = _hook(_load())
    response = await hook.mode_mock(
        ModeMockRequest(
            mode_id="hiring_manager",
            task="interviewer",
            input={
                "skillId": "hiring-manager.scope-impact",
                "followUp": {"focus": "prioritization"},
            },
        )
    )
    assert response.output["question"] == (
        "Let's go deeper on prioritization: tell me more — what was your specific role and "
        "reasoning?"
    )
    assert response.output["topic"] == "Follow-up: prioritization"


async def test_mode_mock_evaluator_builds_the_six_dimension_rubric() -> None:
    hook = _hook(_load())
    response = await hook.mode_mock(
        ModeMockRequest(
            mode_id="hiring_manager",
            task="evaluator",
            input={"roundType": "behavioral", "answer": ANSWER, "question": QUESTION},
        )
    )
    output = response.output
    assert output["summary"] == "Hiring-manager answer evaluated; 3/3 expected signals covered."
    rubric = output["rubric"]
    assert [entry["id"] for entry in rubric] == [
        "roleFit",
        "scopeImpact",
        "prioritization",
        "leadership",
        "collaboration",
        "motivation",
    ]
    assert [entry["label"] for entry in rubric] == [
        "Role fit",
        "Scope & impact",
        "Prioritization",
        "Leadership",
        "Collaboration",
        "Motivation",
    ]
    assert [entry["score"] for entry in rubric] == [0.2, 0.85, 0.2, 0.7, 0.2, 0.55]
    assert output["scores"] == [
        {"skill": "distributed-systems.caching", "score": 0.95, "confidence": 0.7},
        {"skill": "communication", "score": 0.55, "confidence": 0.7},
    ]
    assert output["followUpTopics"] == ["roleFit", "prioritization", "collaboration"]
    assert output["star"] == {
        "situation": True,
        "task": True,
        "action": True,
        "result": True,
        "notes": "STAR parts detected by deterministic heuristics.",
    }
    assert output["designUpdates"] is None
