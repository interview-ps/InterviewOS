"""Bundled `behavioral-mode` plugin — the Python port (phase 7 §13)."""

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
PLUGIN_DIR = REPO_ROOT / "plugins" / "behavioral-mode"

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


class BehavioralModeHook(Protocol):
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


def _hook(loaded: LoadedPlugin) -> BehavioralModeHook:
    return cast(BehavioralModeHook, loaded.middleware[0].instance)


def test_manifest_declares_a_hook_plugin() -> None:
    loaded = _load()
    manifest = loaded.manifest
    assert manifest.id == "behavioral-mode"
    assert manifest.version == "1.0.0"
    assert manifest.name == "Behavioral Mode"
    assert manifest.description == (
        "STAR stories from your experience — a specific situation, your actions, measurable "
        "results."
    )
    assert manifest.kind == "hook"
    assert manifest.entry == "main.py"
    assert [mode.id for mode in manifest.modes] == ["behavioral"]
    assert [dim.id for dim in manifest.modes[0].rubric] == [
        "situationClarity",
        "ownership",
        "actions",
        "decisionMaking",
        "impact",
        "results",
        "reflection",
        "communication",
    ]
    assert [entry.plugin_id for entry in loaded.middleware] == ["behavioral-mode"]


async def test_mode_reduce_tracks_stories_and_competencies() -> None:
    hook = _hook(_load())
    response = await hook.mode_reduce(
        ModeReduceRequest(
            mode_id="behavioral",
            state={"storyIdsUsed": ["s0"], "competenciesCovered": ["communication"]},
            evaluation=_evaluation(),
            question=ModeReduceQuestion(
                skill_id="behavioral.conflict",
                topic="Conflict",
                extra={"storyId": "s1"},
            ),
        )
    )
    assert isinstance(response, ModeReduceResponse)
    assert response.state["storyIdsUsed"] == ["s0", "s1"]
    assert response.state["competenciesCovered"] == ["communication", "behavioral.conflict"]


async def test_mode_reduce_does_not_duplicate_a_known_story() -> None:
    hook = _hook(_load())
    response = await hook.mode_reduce(
        ModeReduceRequest(
            mode_id="behavioral",
            state={"storyIdsUsed": ["s1"], "competenciesCovered": ["behavioral.conflict"]},
            evaluation=_evaluation(),
            question=ModeReduceQuestion(
                skill_id="behavioral.conflict",
                topic="Conflict",
                extra={"storyId": "s1"},
            ),
        )
    )
    assert response.state["storyIdsUsed"] == ["s1"]
    assert response.state["competenciesCovered"] == ["behavioral.conflict"]


async def test_mode_mock_interviewer_asks_the_cached_skill_question() -> None:
    hook = _hook(_load())
    response = await hook.mode_mock(
        ModeMockRequest(
            mode_id="behavioral",
            task="interviewer",
            input={
                "skillId": "distributed-systems.caching",
                "label": "Caching",
                "previousQuestions": [],
                "skillKeywords": ["cache", "ttl"],
            },
        )
    )
    output = response.output
    assert output["question"] == (
        "How would you keep cache entries consistent with the database when the underlying "
        "data changes?"
    )
    assert output["topic"] == "Cache consistency"
    assert output["problem"] is None
    assert output["focusDimension"] is None


async def test_mode_mock_interviewer_uses_the_behavioral_follow_up() -> None:
    hook = _hook(_load())
    response = await hook.mode_mock(
        ModeMockRequest(
            mode_id="behavioral",
            task="interviewer",
            input={
                "skillId": "distributed-systems.caching",
                "followUp": {"focus": "cache invalidation"},
            },
        )
    )
    assert response.output["question"] == (
        "Let's stay with that story — cache invalidation: tell me more about that part."
    )


async def test_mode_mock_evaluator_builds_the_star_rubric() -> None:
    hook = _hook(_load())
    response = await hook.mode_mock(
        ModeMockRequest(
            mode_id="behavioral",
            task="evaluator",
            input={"roundType": "behavioral", "answer": ANSWER, "question": QUESTION},
        )
    )
    output = response.output
    assert output["summary"] == "Covered 3 of 3 expected concepts (100%)."
    rubric = output["rubric"]
    assert [entry["id"] for entry in rubric] == [
        "situationClarity",
        "ownership",
        "actions",
        "decisionMaking",
        "impact",
        "results",
        "reflection",
        "communication",
    ]
    assert [entry["label"] for entry in rubric] == [
        "Situation clarity",
        "Ownership",
        "Actions",
        "Decision making",
        "Impact",
        "Results",
        "Reflection",
        "Communication",
    ]
    assert [entry["score"] for entry in rubric] == [0.9, 0.7, 0.85, 0.45, 0.45, 0.85, 0.45, 0.65]
    assert output["rubric"][0]["rationale"] == "Context set."
    # behavioral rounds make genericEvaluationMock compute STAR, so `base.star`
    # wins over the locally derived `starFrom` object.
    assert output["star"] == {
        "situation": True,
        "task": True,
        "action": True,
        "result": True,
        "notes": "All four STAR parts are present.",
    }
    assert output["designUpdates"] is None
