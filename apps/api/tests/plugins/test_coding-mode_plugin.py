"""Bundled `coding-mode` plugin — the Python port (phase 7 §13)."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Protocol, cast

from interview_os.core.plugin_api import (
    ModeMockRequest,
    ModeMockResponse,
    UiRenderRequest,
    UiRenderResponse,
)
from interview_os.plugins import LoadedPlugin, PluginRegistry, load_plugin_dir

REPO_ROOT = Path(__file__).resolve().parents[4]
PLUGIN_DIR = REPO_ROOT / "plugins" / "coding-mode"

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


class CodingModeHook(Protocol):
    """The middleware surface this plugin contributes."""

    async def mode_mock(self, req: ModeMockRequest) -> ModeMockResponse: ...

    async def ui_render(self, req: UiRenderRequest) -> UiRenderResponse: ...


def _load() -> LoadedPlugin:
    PluginRegistry.reset()
    return load_plugin_dir(PLUGIN_DIR, install_deps=False)


def _hook(loaded: LoadedPlugin) -> CodingModeHook:
    return cast(CodingModeHook, loaded.middleware[0].instance)


def test_manifest_declares_a_hook_plugin() -> None:
    loaded = _load()
    manifest = loaded.manifest
    assert manifest.id == "coding-mode"
    assert manifest.version == "1.0.0"
    assert manifest.name == "Coding Mode"
    assert manifest.description == (
        "Live-coding interview round — solve a small algorithmic problem, explain your "
        "approach, then write code (reviewed, not executed)."
    )
    assert manifest.kind == "hook"
    assert manifest.entry == "main.py"
    assert [mode.id for mode in manifest.modes] == ["coding"]
    assert [dim.id for dim in manifest.modes[0].rubric] == [
        "problemUnderstanding",
        "approach",
        "correctness",
        "complexity",
        "edgeCases",
        "codeQuality",
        "communication",
    ]
    assert [entry.plugin_id for entry in loaded.middleware] == ["coding-mode"]


async def test_mode_mock_interviewer_attaches_a_coding_problem() -> None:
    hook = _hook(_load())
    response = await hook.mode_mock(
        ModeMockRequest(
            mode_id="coding",
            task="interviewer",
            input={
                "skillId": "coding.algorithms",
                "label": "Algorithms",
                "previousQuestions": [],
            },
        )
    )
    output = response.output
    assert output["question"] == (
        "Solve this problem: first explain your approach, then write the code."
    )
    assert output["topic"] == "Top-K recent items"
    assert output["subSkills"] == ["coding.data-structures"]
    assert output["difficulty"] == "medium"
    assert output["problem"]["title"] == "Top-K recent items"
    assert output["problem"]["constraints"] == [
        "1 ≤ k ≤ items.length",
        "items may contain duplicates",
        "aim for O(n) time",
    ]
    assert output["focusDimension"] is None


async def test_mode_mock_interviewer_uses_the_coding_follow_up() -> None:
    hook = _hook(_load())
    response = await hook.mode_mock(
        ModeMockRequest(
            mode_id="coding",
            task="interviewer",
            input={"skillId": "coding.algorithms", "followUp": {"focus": "complexity"}},
        )
    )
    assert response.output["question"] == (
        "Let's go deeper on complexity: for the same problem, walk me through it — what are the "
        "exact considerations and how does your solution handle them?"
    )
    assert response.output["problem"] is None


async def test_mode_mock_evaluator_scores_without_code() -> None:
    hook = _hook(_load())
    response = await hook.mode_mock(
        ModeMockRequest(
            mode_id="coding",
            task="evaluator",
            input={"roundType": "coding", "answer": ANSWER, "question": QUESTION},
        )
    )
    output = response.output
    assert output["summary"] == "Covered 3 of 3 expected concepts (100%)."
    rubric = output["rubric"]
    assert [entry["id"] for entry in rubric] == [
        "problemUnderstanding",
        "approach",
        "correctness",
        "complexity",
        "edgeCases",
        "codeQuality",
        "communication",
    ]
    assert [entry["score"] for entry in rubric] == [0.85, 0.7, 0.8, 0.2, 0.2, 0.3, 0.65]
    assert rubric[5]["rationale"] == "No code submitted (language n/a)."
    assert output["missingConcepts"] == ["Complexity analysis", "Edge cases"]
    assert output["weaknesses"] == [
        {
            "skill": "coding.complexity",
            "severity": "medium",
            "evidence": "No clear time/space complexity analysis",
        },
        {
            "skill": "coding.edge-cases",
            "severity": "medium",
            "evidence": "Edge cases not discussed",
        },
    ]
    assert output["designUpdates"] is None
    assert output["star"] is None


async def test_mode_mock_evaluator_scores_a_submitted_solution() -> None:
    hook = _hook(_load())
    code = "x" * 100
    response = await hook.mode_mock(
        ModeMockRequest(
            mode_id="coding",
            task="evaluator",
            input={
                "roundType": "coding",
                "answer": ANSWER,
                "code": code,
                "language": "python",
                "question": QUESTION,
            },
        )
    )
    output = response.output
    assert output["summary"] == (
        "Covered 3 of 3 expected concepts (100%); submitted 100 chars of python."
    )
    rubric = output["rubric"]
    # code_len > 40 nudges correctness; codeQuality = 0.45 + min(0.3, 100 / 400)
    assert [entry["score"] for entry in rubric] == [0.85, 0.7, 0.9, 0.2, 0.2, 0.7, 0.65]
    assert rubric[5]["rationale"] == "Code submitted (python, 100 chars)."
    assert output["scores"] == [
        {
            "skill": "distributed-systems.caching.cache-strategies",
            "score": 0.95,
            "confidence": 0.68,
        },
        {
            "skill": "distributed-systems.caching.cache-invalidation",
            "score": 0.95,
            "confidence": 0.68,
        },
        {"skill": "distributed-systems.caching", "score": 0.95, "confidence": 0.68},
        {"skill": "coding.complexity", "score": 0.2, "confidence": 0.68},
        {"skill": "coding.edge-cases", "score": 0.2, "confidence": 0.68},
    ]


async def test_ui_render_draws_the_problem_panel() -> None:
    hook = _hook(_load())
    response = await hook.ui_render(
        UiRenderRequest(
            component="coding-problem",
            params={
                "extra": {
                    "problem": {
                        "title": "Merge intervals",
                        "statement": "Merge them.",
                        "constraints": ["a", "b"],
                        "examples": [{"input": "[[1,3]]", "output": "[[1,3]]"}],
                    }
                }
            },
        )
    )
    assert isinstance(response, UiRenderResponse)
    assert response.ui.model_dump(by_alias=True) == {
        "type": "card",
        "title": "Merge intervals",
        "subtitle": "Coding problem",
        "children": [
            {"type": "text", "text": "Merge them.", "tone": None},
            {
                "type": "list",
                "items": [{"text": "a", "tone": None}, {"text": "b", "tone": None}],
            },
            {"type": "text", "text": "Input: [[1,3]] → Output: [[1,3]]", "tone": None},
        ],
    }


async def test_ui_render_accepts_a_plain_problem_string() -> None:
    hook = _hook(_load())
    response = await hook.ui_render(
        UiRenderRequest(
            component="coding-problem",
            params={"extra": {"problem": "Write fizzbuzz."}},
        )
    )
    assert response.ui.model_dump(by_alias=True) == {
        "type": "card",
        "title": "Problem",
        "subtitle": None,
        "children": [{"type": "text", "text": "Write fizzbuzz.", "tone": None}],
    }


async def test_ui_render_without_a_problem_is_an_empty_state() -> None:
    hook = _hook(_load())
    response = await hook.ui_render(UiRenderRequest(component="coding-problem", params={}))
    assert response.ui.model_dump(by_alias=True) == {
        "type": "emptyState",
        "title": "Problem",
        "description": "The problem will appear here.",
    }


async def test_ui_render_unknown_component_is_an_empty_state() -> None:
    hook = _hook(_load())
    response = await hook.ui_render(UiRenderRequest(component="nope", params={}))
    assert response.ui.model_dump(by_alias=True) == {
        "type": "emptyState",
        "title": "Unknown component",
        "description": None,
    }
