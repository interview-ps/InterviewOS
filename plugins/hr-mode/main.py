"""HR mode — port of `plugins/hr-mode/index.ts`.

Scope/rubric/context are declared in `plugin.yaml` `modes`; this entry ships
the `mode.reduce` hook (tracks covered themes) and the deterministic
`mode.mock` — identical to the former built-in mocks.
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
)

__all__ = ["HR_KWS", "HR_LABELS", "HrMode", "setup"]

HR_KWS: dict[str, list[str]] = {
    "motivation": ["excited", "interested", "motivated", "drawn", "passionate", "because"],
    "careerGoals": ["grow", "goal", "learn", "next", "lead", "deepen", "years"],
    "cultureFit": ["culture", "value", "team", "collaboration", "feedback", "autonomy"],
    "workStyle": ["i prefer", "i usually", "async", "feedback", "communicate", "thrive", "i work best"],
}

HR_LABELS: dict[str, str] = {
    "motivation": "Motivation",
    "careerGoals": "Career goals",
    "cultureFit": "Culture fit",
    "workStyle": "Work style",
    "communication": "Communication",
}


def _clamp(value: float) -> float:
    return round2(min(1.0, max(0.0, value)))


def _string_list(value: object) -> list[str]:
    return [str(item) for item in value] if isinstance(value, list) else []


def _reduce(req: ModeReduceRequest) -> dict[str, Any]:
    themes = _string_list(req.state.get("themesCovered"))
    if req.question.topic and req.question.topic not in themes:
        themes.append(req.question.topic)
    return {"themesCovered": themes}


def _interviewer_output(input_: dict[str, Any]) -> dict[str, Any]:
    follow_up = input_.get("followUp")
    if isinstance(follow_up, dict):
        return follow_up_mock_output(
            str(input_.get("skillId", "")), str(follow_up.get("focus", "")), "hr"
        )
    base = cast("dict[str, Any]", generic_interviewer_mock(input_))
    return {**base, "problem": None, "focusDimension": None}


def _evaluator_output(input_: dict[str, Any]) -> dict[str, Any]:
    answer = str(input_.get("answer", ""))
    base = cast("dict[str, Any]", generic_evaluation_mock(input_))
    dimensions: dict[str, Any] = base["dimensions"]
    # iterate the mode rubric (HR_LABELS covers communication too) — HR_KWS has
    # no keyword set for communication; it comes from the base evaluator.
    rubric = []
    for identifier, label in HR_LABELS.items():
        hits = keywords_hit(answer, HR_KWS.get(identifier, []))
        rubric.append(
            {
                "id": identifier,
                "label": label,
                "score": (
                    dimensions["communication"]["score"]
                    if identifier == "communication"
                    else _clamp(0.2 if hits == 0 else 0.4 + 0.15 * hits)
                ),
                "rationale": "Not evidenced." if hits == 0 else f"{hits} relevant term(s).",
            }
        )
    return {**base, "rubric": rubric, "designUpdates": None}


class HrMode:
    """`hook` middleware: `mode.reduce` + `mode.mock` for the HR round."""

    async def mode_reduce(self, req: ModeReduceRequest) -> ModeReduceResponse | None:
        return ModeReduceResponse(state=_reduce(req))

    async def mode_mock(self, req: ModeMockRequest) -> ModeMockResponse | None:
        if req.task == "interviewer":
            return ModeMockResponse(output=_interviewer_output(req.input))
        return ModeMockResponse(output=_evaluator_output(req.input))


def setup(ctx: PluginContext) -> None:
    ctx.middleware(HrMode())
