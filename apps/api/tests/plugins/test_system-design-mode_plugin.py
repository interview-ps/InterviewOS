"""Bundled `system-design-mode` plugin — the Python port (phase 7 §13)."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Protocol, cast

from interview_os.core.models.assessment import (
    AnswerEvaluation,
    DesignUpdate,
    DesignUpdateStatus,
    EvaluationDimension,
    EvaluationDimensions,
)
from interview_os.core.plugin_api import (
    ModeMockRequest,
    ModeMockResponse,
    ModePrepareTurnRequest,
    ModePrepareTurnResponse,
    ModeReduceQuestion,
    ModeReduceRequest,
    ModeReduceResponse,
    UiRenderRequest,
    UiRenderResponse,
)
from interview_os.plugins import LoadedPlugin, PluginRegistry, load_plugin_dir

REPO_ROOT = Path(__file__).resolve().parents[4]
PLUGIN_DIR = REPO_ROOT / "plugins" / "system-design-mode"

DIMENSION_IDS = [
    "requirements",
    "constraints",
    "scaleAssumptions",
    "architecture",
    "dataModel",
    "apis",
    "storage",
    "caching",
    "reliability",
    "scalability",
    "tradeOffs",
]

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


class SystemDesignModeHook(Protocol):
    """The middleware surface this plugin contributes."""

    async def mode_reduce(self, req: ModeReduceRequest) -> ModeReduceResponse: ...

    async def mode_prepare_turn(
        self, req: ModePrepareTurnRequest
    ) -> ModePrepareTurnResponse: ...

    async def mode_mock(self, req: ModeMockRequest) -> ModeMockResponse: ...

    async def ui_render(self, req: UiRenderRequest) -> UiRenderResponse: ...


def _evaluation(
    signals: dict[str, Any] | None = None,
    updates: list[DesignUpdate] | None = None,
) -> AnswerEvaluation:
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
        mode_signals=signals,
        design_updates=updates,
    )


def _load() -> LoadedPlugin:
    PluginRegistry.reset()
    return load_plugin_dir(PLUGIN_DIR, install_deps=False)


def _hook(loaded: LoadedPlugin) -> SystemDesignModeHook:
    return cast(SystemDesignModeHook, loaded.middleware[0].instance)


def test_manifest_declares_a_hook_plugin() -> None:
    loaded = _load()
    manifest = loaded.manifest
    assert manifest.id == "system-design-mode"
    assert manifest.version == "1.0.0"
    assert manifest.name == "System Design Mode"
    assert manifest.description == (
        "Open-ended design of a larger system with concrete scale numbers — requirements → "
        "estimation → design → trade-offs."
    )
    assert manifest.kind == "hook"
    assert manifest.entry == "main.py"
    assert [mode.id for mode in manifest.modes] == ["system_design"]
    assert [dim.id for dim in manifest.modes[0].rubric] == DIMENSION_IDS
    assert [entry.plugin_id for entry in loaded.middleware] == ["system-design-mode"]


async def test_mode_reduce_merges_signaled_dimension_updates() -> None:
    hook = _hook(_load())
    response = await hook.mode_reduce(
        ModeReduceRequest(
            mode_id="system_design",
            state={},
            evaluation=_evaluation(
                signals={
                    "designUpdates": [
                        {"dimension": "requirements", "status": "covered", "notes": "clarified"},
                        {"dimension": "apis", "status": "partial", "notes": "surface sketched"},
                    ]
                }
            ),
            question=ModeReduceQuestion(
                skill_id="system-design",
                topic="Design",
                extra={
                    "problem": "Design a URL shortener service.",
                    "focusDimension": "requirements",
                },
            ),
        )
    )
    assert isinstance(response, ModeReduceResponse)
    state = response.state
    assert state["problem"] == "Design a URL shortener service."
    assert state["focusDimension"] == "requirements"
    dimensions = state["dimensions"]
    assert dimensions["requirements"] == {"status": "covered", "notes": "clarified"}
    assert dimensions["apis"] == {"status": "partial", "notes": "surface sketched"}
    assert dimensions["caching"] == {"status": "not_covered", "notes": ""}


async def test_mode_reduce_never_downgrades_a_covered_dimension() -> None:
    hook = _hook(_load())
    response = await hook.mode_reduce(
        ModeReduceRequest(
            mode_id="system_design",
            state={"dimensions": {"requirements": {"status": "covered", "notes": "kept"}}},
            evaluation=_evaluation(
                signals={
                    "designUpdates": [
                        {"dimension": "requirements", "status": "partial", "notes": "worse"},
                    ]
                }
            ),
            question=ModeReduceQuestion(skill_id="system-design", topic="Design", extra={}),
        )
    )
    assert response.state["dimensions"]["requirements"] == {
        "status": "covered",
        "notes": "kept",
    }


async def test_mode_reduce_falls_back_to_legacy_design_updates() -> None:
    hook = _hook(_load())
    response = await hook.mode_reduce(
        ModeReduceRequest(
            mode_id="system_design",
            state={},
            evaluation=_evaluation(
                updates=[
                    DesignUpdate(
                        dimension="caching",
                        status=DesignUpdateStatus.COVERED,
                        notes="legacy signal",
                    )
                ]
            ),
            question=ModeReduceQuestion(skill_id="system-design", topic="Design", extra={}),
        )
    )
    assert response.state["dimensions"]["caching"] == {
        "status": "covered",
        "notes": "legacy signal",
    }


async def test_mode_prepare_turn_targets_the_first_uncovered_dimension() -> None:
    hook = _hook(_load())
    response = await hook.mode_prepare_turn(
        ModePrepareTurnRequest(mode_id="system_design", state={}, follow_up=False)
    )
    assert isinstance(response, ModePrepareTurnResponse)
    assert response.turn == {
        "focusDimension": "requirements",
        "skillId": "system-design.requirements-analysis",
    }


async def test_mode_prepare_turn_skips_covered_dimensions() -> None:
    hook = _hook(_load())
    response = await hook.mode_prepare_turn(
        ModePrepareTurnRequest(
            mode_id="system_design",
            state={"dimensions": {"requirements": {"status": "covered"}}},
            follow_up=False,
        )
    )
    assert response.turn == {"focusDimension": "constraints", "skillId": "system-design"}


async def test_mode_prepare_turn_has_no_focus_for_a_follow_up() -> None:
    hook = _hook(_load())
    response = await hook.mode_prepare_turn(
        ModePrepareTurnRequest(mode_id="system_design", state={}, follow_up=True)
    )
    assert response.turn == {"focusDimension": None, "skillId": None}


async def test_mode_mock_interviewer_picks_the_design_problem() -> None:
    hook = _hook(_load())
    response = await hook.mode_mock(
        ModeMockRequest(
            mode_id="system_design",
            task="interviewer",
            input={"skillId": "system-design", "previousQuestions": [], "modeState": {}},
        )
    )
    output = response.output
    assert output["question"] == (
        "Design a URL shortener service. Start by clarifying requirements and scale estimates."
    )
    assert output["topic"] == "URL shortener service"
    assert output["problem"] == "Design a URL shortener service."
    assert output["focusDimension"] is None


async def test_mode_mock_interviewer_probes_the_next_uncovered_dimension() -> None:
    hook = _hook(_load())
    response = await hook.mode_mock(
        ModeMockRequest(
            mode_id="system_design",
            task="interviewer",
            input={
                "skillId": "system-design",
                "previousQuestions": [],
                "modeState": {
                    "problem": "Design a URL shortener service.",
                    "dimensions": {"requirements": {"status": "covered"}},
                },
            },
        )
    )
    output = response.output
    assert output["question"] == (
        "What constraints shape this design — latency targets, consistency needs, budget?"
    )
    assert output["topic"] == "Probe: constraints"
    assert output["focusDimension"] == "constraints"
    assert output["problem"] is None


async def test_mode_mock_interviewer_uses_the_dimension_follow_up() -> None:
    hook = _hook(_load())
    response = await hook.mode_mock(
        ModeMockRequest(
            mode_id="system_design",
            task="interviewer",
            input={
                "skillId": "system-design",
                "previousQuestions": [],
                "followUp": {"focus": "caching"},
            },
        )
    )
    output = response.output
    assert output["question"] == (
        "Let's go deeper on caching: Where would you cache, what would you cache, and how do "
        "you invalidate?"
    )
    assert output["focusDimension"] == "caching"


async def test_mode_mock_evaluator_reports_dimension_updates() -> None:
    hook = _hook(_load())
    response = await hook.mode_mock(
        ModeMockRequest(
            mode_id="system_design",
            task="evaluator",
            input={"roundType": "technical", "answer": ANSWER, "question": QUESTION},
        )
    )
    output = response.output
    assert output["summary"] == "Design turn evaluated; 2 dimension(s) updated."
    assert [entry["id"] for entry in output["rubric"]] == DIMENSION_IDS
    assert output["modeSignals"] == {
        "designUpdates": [
            {
                "dimension": "constraints",
                "status": "partial",
                "notes": "1 relevant term(s) detected.",
            },
            {"dimension": "caching", "status": "covered", "notes": "2 relevant term(s) detected."},
        ]
    }
    assert output["designUpdates"] is None
    assert output["star"] is None


async def test_ui_render_draws_the_design_dimensions_panel() -> None:
    hook = _hook(_load())
    response = await hook.ui_render(
        UiRenderRequest(
            component="design-dimensions",
            params={
                "state": {
                    "problem": "Design a URL shortener service.",
                    "dimensions": {
                        "requirements": {"status": "covered"},
                        "apis": {"status": "partial"},
                    },
                },
                "focus": "apis",
            },
        )
    )
    assert isinstance(response, UiRenderResponse)
    assert response.ui.model_dump(by_alias=True) == {
        "type": "card",
        "title": "Design dimensions",
        "subtitle": None,
        "children": [
            {"type": "text", "text": "Design a URL shortener service.", "tone": "muted"},
            {
                "type": "stack",
                "gap": "sm",
                "children": [
                    {
                        "type": "row",
                        "children": [
                            {"type": "text", "text": "Requirements", "tone": None},
                            {"type": "badge", "text": "covered", "tone": "green"},
                        ],
                    },
                    {
                        "type": "row",
                        "children": [
                            {"type": "text", "text": "▸ APIs", "tone": "blue"},
                            {"type": "badge", "text": "partial", "tone": "amber"},
                        ],
                    },
                ],
            },
        ],
    }


async def test_ui_render_unknown_component_is_an_empty_state() -> None:
    hook = _hook(_load())
    response = await hook.ui_render(UiRenderRequest(component="nope", params={}))
    assert response.ui.model_dump(by_alias=True) == {
        "type": "emptyState",
        "title": "Unknown component",
        "description": None,
    }
