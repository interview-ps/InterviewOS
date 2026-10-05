"""Bundled `technical-mode` plugin — the Python port (phase 7 §13)."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Protocol, cast

from interview_os.core.plugin_api import ModeMockRequest, ModeMockResponse
from interview_os.plugins import LoadedPlugin, PluginRegistry, load_plugin_dir

REPO_ROOT = Path(__file__).resolve().parents[4]
PLUGIN_DIR = REPO_ROOT / "plugins" / "technical-mode"

#: The same representative prompt/answer the former TS mock produced, reused
#: across every mode plugin's evaluator test (the mocks are format-agnostic).
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


class TechnicalModeHook(Protocol):
    """The middleware surface this plugin contributes."""

    async def mode_mock(self, req: ModeMockRequest) -> ModeMockResponse: ...


def _load() -> LoadedPlugin:
    PluginRegistry.reset()
    return load_plugin_dir(PLUGIN_DIR, install_deps=False)


def _hook(loaded: LoadedPlugin) -> TechnicalModeHook:
    return cast(TechnicalModeHook, loaded.middleware[0].instance)


def test_manifest_declares_a_hook_plugin() -> None:
    loaded = _load()
    manifest = loaded.manifest
    assert manifest.id == "technical-mode"
    assert manifest.version == "1.0.0"
    assert manifest.name == "Technical Mode"
    assert manifest.description == (
        "Deep technical interview round — one question per skill, probing mechanics, "
        "edge cases and trade-offs."
    )
    assert manifest.kind == "hook"
    assert manifest.entry == "main.py"
    assert [mode.id for mode in manifest.modes] == ["technical"]
    assert [dim.id for dim in manifest.modes[0].rubric] == [
        "correctness",
        "technicalDepth",
        "reasoning",
        "communication",
        "roleRelevance",
    ]
    assert [entry.plugin_id for entry in loaded.middleware] == ["technical-mode"]


async def test_mode_mock_interviewer_asks_the_cached_skill_question() -> None:
    hook = _hook(_load())
    response = await hook.mode_mock(
        ModeMockRequest(
            mode_id="technical",
            task="interviewer",
            input={
                "skillId": "distributed-systems.caching",
                "label": "Caching",
                "previousQuestions": [],
                "skillKeywords": ["cache", "ttl"],
            },
        )
    )
    assert isinstance(response, ModeMockResponse)
    output = response.output
    assert output["question"] == (
        "How would you keep cache entries consistent with the database when the underlying "
        "data changes?"
    )
    assert output["topic"] == "Cache consistency"
    assert output["skillId"] == "distributed-systems.caching"
    assert output["subSkills"] == [
        "distributed-systems.caching.cache-strategies",
        "distributed-systems.caching.cache-invalidation",
    ]
    assert [item["concept"] for item in output["expectedConcepts"]] == [
        "cache-aside / read-through",
        "TTL / expiration",
        "explicit invalidation on write",
        "write-through / write-behind trade-offs",
        "stale reads / race conditions",
    ]
    assert output["difficulty"] == "medium"
    assert output["problem"] is None
    assert output["focusDimension"] is None


async def test_mode_mock_interviewer_uses_the_follow_up_phrasing() -> None:
    hook = _hook(_load())
    response = await hook.mode_mock(
        ModeMockRequest(
            mode_id="technical",
            task="interviewer",
            input={
                "skillId": "distributed-systems.caching",
                "label": "Caching",
                "previousQuestions": [],
                "followUp": {"focus": "cache invalidation"},
            },
        )
    )
    assert response.output["question"] == (
        "Let's go deeper on cache invalidation: walk me through the specifics and the trade-offs."
    )
    assert response.output["topic"] == "Follow-up: cache invalidation"


async def test_mode_mock_evaluator_builds_the_five_dimension_rubric() -> None:
    hook = _hook(_load())
    response = await hook.mode_mock(
        ModeMockRequest(
            mode_id="technical",
            task="evaluator",
            input={"roundType": "technical", "answer": ANSWER, "question": QUESTION},
        )
    )
    output = response.output
    assert output["summary"] == "Covered 3 of 3 expected concepts (100%)."
    rubric = output["rubric"]
    assert [entry["id"] for entry in rubric] == [
        "correctness",
        "technicalDepth",
        "reasoning",
        "communication",
        "roleRelevance",
    ]
    assert [entry["label"] for entry in rubric] == [
        "Correctness",
        "Technical depth",
        "Reasoning",
        "Communication",
        "Role relevance",
    ]
    assert [entry["score"] for entry in rubric] == [0.9, 0.9, 0.87, 0.65, 0.8]
    assert output["designUpdates"] is None
    assert output["star"] is None
