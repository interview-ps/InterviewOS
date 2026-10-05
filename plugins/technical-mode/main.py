"""Technical mode — port of `plugins/technical-mode/index.ts`.

The mode (rubric, scope exclusion of non-technical subtrees, generic follow-up
policy) is declared in `plugin.yaml` `modes`; this entry ships the `mode.mock`
hook — deterministic MockRuntime output identical to the former built-in
technical mocks.
"""

from __future__ import annotations

from typing import Any, cast

from interview_os.core.plugin_api import ModeMockRequest, ModeMockResponse
from interview_os.plugins.context import PluginContext
from interview_os.plugins.testing.mock_helpers import (
    follow_up_mock_output,
    generic_evaluation_mock,
    generic_interviewer_mock,
)

__all__ = ["RUBRIC_LABELS", "TechnicalMode", "setup"]

RUBRIC_LABELS: dict[str, str] = {
    "correctness": "Correctness",
    "technicalDepth": "Technical depth",
    "reasoning": "Reasoning",
    "communication": "Communication",
    "roleRelevance": "Role relevance",
}


def _interviewer_output(input_: dict[str, Any]) -> dict[str, Any]:
    follow_up = input_.get("followUp")
    if isinstance(follow_up, dict):
        return follow_up_mock_output(
            str(input_.get("skillId", "")), str(follow_up.get("focus", "")), "technical"
        )
    base = cast("dict[str, Any]", generic_interviewer_mock(input_))
    return {**base, "problem": None, "focusDimension": None}


def _evaluator_output(input_: dict[str, Any]) -> dict[str, Any]:
    base = cast("dict[str, Any]", generic_evaluation_mock(input_))
    dimensions: dict[str, Any] = base["dimensions"]
    rubric = [
        {
            "id": identifier,
            "label": label,
            "score": dimensions[identifier]["score"],
            "rationale": dimensions[identifier]["rationale"],
        }
        for identifier, label in RUBRIC_LABELS.items()
    ]
    return {**base, "rubric": rubric, "designUpdates": None}


class TechnicalMode:
    """`hook` middleware implementing `mode.mock` for the technical round."""

    async def mode_mock(self, req: ModeMockRequest) -> ModeMockResponse | None:
        if req.task == "interviewer":
            return ModeMockResponse(output=_interviewer_output(req.input))
        return ModeMockResponse(output=_evaluator_output(req.input))


def setup(ctx: PluginContext) -> None:
    ctx.middleware(TechnicalMode())
