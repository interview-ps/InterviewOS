"""Behavioral mode — port of `plugins/behavioral-mode/index.ts`.

The mode (scope, rubric, context flags, generic follow-up policy) is declared
in `plugin.yaml` `modes`; this entry ships the `mode.reduce` hook (tracks used
story ids / covered competencies) and the deterministic `mode.mock` — identical
to the former built-in behavioral mocks.
"""

from __future__ import annotations

from typing import Any, cast

from interview_os.core.plugin_api import (
    ModeMockRequest,
    ModeMockResponse,
    ModeReduceRequest,
    ModeReduceResponse,
)
from interview_os.plugins.context import PluginContext
from interview_os.plugins.testing.mock_helpers import (
    follow_up_mock_output,
    generic_evaluation_mock,
    generic_interviewer_mock,
    keywords_hit,
    round2,
    star_from,
)

__all__ = ["BEH_LABELS", "BehavioralMode", "setup"]

BEH_LABELS: dict[str, str] = {
    "situationClarity": "Situation clarity",
    "ownership": "Ownership",
    "actions": "Actions",
    "decisionMaking": "Decision making",
    "impact": "Impact",
    "results": "Results",
    "reflection": "Reflection",
    "communication": "Communication",
}

_OWNERSHIP_KEYWORDS = [
    "i led",
    "i decided",
    "i owned",
    "i drove",
    "my responsibility",
    "i was responsible",
]
_ACTION_KEYWORDS = ["i did", "i made", "i wrote"]
_DECISION_KEYWORDS = ["because", "decided", "chose", "trade-off", "rationale", "considered"]
_IMPACT_KEYWORDS = ["impact", "mattered", "business", "customer", "team", "importance"]
_REFLECTION_KEYWORDS = ["learned", "would do", "in hindsight", "next time", "retrospective"]


def _clamp(value: float) -> float:
    return round2(min(1.0, max(0.0, value)))


def _string_list(value: object) -> list[str]:
    return [str(item) for item in value] if isinstance(value, list) else []


def _reduce(req: ModeReduceRequest) -> dict[str, Any]:
    story_ids = _string_list(req.state.get("storyIdsUsed"))
    competencies = _string_list(req.state.get("competenciesCovered"))
    story_id = req.question.extra.get("storyId")
    if isinstance(story_id, str) and story_id and story_id not in story_ids:
        story_ids.append(story_id)
    if req.question.skill_id not in competencies:
        competencies.append(req.question.skill_id)
    return {"storyIdsUsed": story_ids, "competenciesCovered": competencies}


def _interviewer_output(input_: dict[str, Any]) -> dict[str, Any]:
    follow_up = input_.get("followUp")
    if isinstance(follow_up, dict):
        return follow_up_mock_output(
            str(input_.get("skillId", "")), str(follow_up.get("focus", "")), "behavioral"
        )
    base = cast("dict[str, Any]", generic_interviewer_mock(input_))
    return {**base, "problem": None, "focusDimension": None}


def _evaluator_output(input_: dict[str, Any]) -> dict[str, Any]:
    answer = str(input_.get("answer", ""))
    base = cast("dict[str, Any]", generic_evaluation_mock(input_))
    dimensions: dict[str, Any] = base["dimensions"]
    star = star_from(answer)
    situation = bool(star["situation"])
    task = bool(star["task"])
    action = bool(star["action"])
    result = bool(star["result"])

    def kw(keywords: list[str]) -> int:
        return keywords_hit(answer, keywords)

    rubric = [
        {
            "id": "situationClarity",
            "score": 0.9 if (situation and task) else (0.7 if situation else 0.3),
            "rationale": "Context set." if situation else "No clear situation set.",
        },
        {
            "id": "ownership",
            "score": _clamp(0.3 + 0.2 * kw(_OWNERSHIP_KEYWORDS)),
            "rationale": "First-person ownership signals.",
        },
        {
            "id": "actions",
            "score": 0.85 if action else _clamp(0.2 + 0.15 * kw(_ACTION_KEYWORDS)),
            "rationale": "Concrete first-person actions." if action else "Few concrete actions.",
        },
        {
            "id": "decisionMaking",
            "score": _clamp(0.25 + 0.2 * kw(_DECISION_KEYWORDS)),
            "rationale": "Reasoning behind choices.",
        },
        {
            "id": "impact",
            "score": _clamp(0.25 + 0.2 * kw(_IMPACT_KEYWORDS)),
            "rationale": "Why the outcome mattered.",
        },
        {
            "id": "results",
            "score": 0.85 if result else 0.2,
            "rationale": "Result given." if result else "No measurable result.",
        },
        {
            "id": "reflection",
            "score": _clamp(0.2 + 0.25 * kw(_REFLECTION_KEYWORDS)),
            "rationale": "Reflection signals.",
        },
        {
            "id": "communication",
            "score": dimensions["communication"]["score"],
            "rationale": dimensions["communication"]["rationale"],
        },
    ]
    for entry in rubric:
        entry["label"] = BEH_LABELS[entry["id"]]

    base_star = base.get("star")
    return {
        **base,
        "star": base_star if base_star is not None else star,
        "rubric": rubric,
        "designUpdates": None,
    }


class BehavioralMode:
    """`hook` middleware: `mode.reduce` + `mode.mock` for the behavioral round."""

    async def mode_reduce(self, req: ModeReduceRequest) -> ModeReduceResponse | None:
        return ModeReduceResponse(state=_reduce(req))

    async def mode_mock(self, req: ModeMockRequest) -> ModeMockResponse | None:
        if req.task == "interviewer":
            return ModeMockResponse(output=_interviewer_output(req.input))
        return ModeMockResponse(output=_evaluator_output(req.input))


def setup(ctx: PluginContext) -> None:
    ctx.middleware(BehavioralMode())
