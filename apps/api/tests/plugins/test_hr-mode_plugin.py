"""Bundled `hr-mode` plugin — the Python port (phase 7 §13)."""

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
PLUGIN_DIR = REPO_ROOT / "plugins" / "hr-mode"

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


class HrModeHook(Protocol):
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


def _hook(loaded: LoadedPlugin) -> HrModeHook:
    return cast(HrModeHook, loaded.middleware[0].instance)


def test_manifest_declares_a_hook_plugin() -> None:
    loaded = _load()
    manifest = loaded.manifest
    assert manifest.id == "hr-mode"
    assert manifest.version == "1.0.0"
    assert manifest.name == "HR Mode"
    assert manifest.description == (
        "Motivation, career goals, culture fit and work style — friendly but probing."
    )
    assert manifest.kind == "hook"
    assert manifest.entry == "main.py"
    assert [mode.id for mode in manifest.modes] == ["hr"]
    assert [dim.id for dim in manifest.modes[0].rubric] == [
        "motivation",
        "careerGoals",
        "cultureFit",
        "workStyle",
        "communication",
    ]
    assert [entry.plugin_id for entry in loaded.middleware] == ["hr-mode"]


async def test_mode_reduce_tracks_covered_themes() -> None:
    hook = _hook(_load())
    response = await hook.mode_reduce(
        ModeReduceRequest(
            mode_id="hr",
            state={"themesCovered": ["Motivation"]},
            evaluation=_evaluation(),
            question=ModeReduceQuestion(
                skill_id="hr.motivation", topic="Career goals", extra={}
            ),
        )
    )
    assert isinstance(response, ModeReduceResponse)
    assert response.state["themesCovered"] == ["Motivation", "Career goals"]


async def test_mode_mock_interviewer_asks_the_cached_skill_question() -> None:
    hook = _hook(_load())
    response = await hook.mode_mock(
        ModeMockRequest(
            mode_id="hr",
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


async def test_mode_mock_interviewer_uses_the_hr_follow_up() -> None:
    hook = _hook(_load())
    response = await hook.mode_mock(
        ModeMockRequest(
            mode_id="hr",
            task="interviewer",
            input={
                "skillId": "distributed-systems.caching",
                "followUp": {"focus": "cache invalidation"},
            },
        )
    )
    assert response.output["question"] == (
        "I'd like to dig into cache invalidation a bit more — can you expand?"
    )


async def test_mode_mock_evaluator_builds_the_hr_rubric() -> None:
    hook = _hook(_load())
    response = await hook.mode_mock(
        ModeMockRequest(
            mode_id="hr",
            task="evaluator",
            input={"roundType": "hr", "answer": ANSWER, "question": QUESTION},
        )
    )
    output = response.output
    rubric = output["rubric"]
    assert [entry["id"] for entry in rubric] == [
        "motivation",
        "careerGoals",
        "cultureFit",
        "workStyle",
        "communication",
    ]
    assert [entry["label"] for entry in rubric] == [
        "Motivation",
        "Career goals",
        "Culture fit",
        "Work style",
        "Communication",
    ]
    assert [entry["score"] for entry in rubric] == [0.2, 0.55, 0.2, 0.2, 0.65]
    assert [entry["rationale"] for entry in rubric] == [
        "Not evidenced.",
        "1 relevant term(s).",
        "Not evidenced.",
        "Not evidenced.",
        "Not evidenced.",
    ]
    assert output["designUpdates"] is None
