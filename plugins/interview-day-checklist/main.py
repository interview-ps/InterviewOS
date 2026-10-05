"""Interview Day Checklist — Python port of the bundled TS plugin (§9.6).

`preparation.suggest` turns the active target's weakest requirement areas into
prep activities; the legacy `/run` checklist output is preserved for 1:1 parity.
Read-only — no runtime, no writes.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from interview_os.core.plugin_api import (
    PluginPrepActivity,
    PreparationSuggestRequest,
    PreparationSuggestResponse,
)

__all__ = ["InterviewDayChecklist", "setup"]


def _number(value: object) -> float:
    """JS-style numeric coercion for gap fields (booleans/strings -> 0.0)."""

    if isinstance(value, bool) or not isinstance(value, int | float):
        return 0.0
    return float(value)


def _text(value: object) -> str:
    return "" if value is None else str(value)


def _score(gap: Mapping[str, Any]) -> float:
    """`importance * gap` — the TS sort key (higher sorts first)."""

    return _number(gap.get("importance")) * _number(gap.get("gap"))


def _weakest(gaps: Sequence[Mapping[str, Any]], *, limit: int = 3) -> list[Mapping[str, Any]]:
    """The top `limit` gaps by `importance * gap`, stable on ties (like Array.sort)."""

    return sorted(gaps, key=_score, reverse=True)[:limit]


def _activity(gap: Mapping[str, Any]) -> PluginPrepActivity:
    skill_id = _text(gap.get("skillId"))
    label = _text(gap.get("label")) or skill_id
    severity = _text(gap.get("severity"))
    return PluginPrepActivity(
        skill_id=skill_id,
        title=f"Skim {label}",
        action=(
            f"Weak area for this role (severity {severity}) — "
            "10 minutes of review before the interview."
        ),
        success_criteria=["Can explain the core concept unprompted"],
    )


class InterviewDayChecklist:
    """The `hook` plugin's middleware instance (all hooks optional)."""

    async def preparation_suggest(
        self, req: PreparationSuggestRequest
    ) -> PreparationSuggestResponse:
        """`preparation.suggest` — the same weakest-area logic as prep activities."""

        activities = [_activity(gap) for gap in _weakest(req.gaps)]
        return PreparationSuggestResponse(activities=activities)

    def execute(self, input: Mapping[str, Any] | None = None) -> dict[str, object]:
        """Legacy `/run` checklist: the weakest areas, a STAR reminder, logistics."""

        data = input or {}
        target = data.get("target")
        raw_gaps = data.get("gaps")
        gaps: list[Mapping[str, Any]] = (
            [gap for gap in raw_gaps if isinstance(gap, Mapping)]
            if isinstance(raw_gaps, list)
            else []
        )

        items: list[dict[str, str]] = []
        for index, gap in enumerate(_weakest(gaps)):
            label = _text(gap.get("label")) or _text(gap.get("skillId"))
            severity = _text(gap.get("severity"))
            items.append(
                {
                    "title": f"Skim {label}",
                    "detail": (
                        f"Weak area #{index + 1} for this role (severity {severity}) — "
                        "10 minutes of review."
                    ),
                }
            )
        items.append(
            {
                "title": "STAR reminder",
                "detail": (
                    "Every behavioral answer: Situation → Task → Action → Result. "
                    "Land the result with a number."
                ),
            }
        )

        if isinstance(target, Mapping) and target:
            role = _text(target.get("role"))
            company = _text(target.get("company"))
            title = f"Interview day — {role} @ {company}"
            detail = (
                f"{role} at {company} — test your camera/mic, water nearby, "
                "notebook for questions."
            )
        else:
            title = "Interview day checklist"
            detail = "Test your camera/mic, water nearby, notebook for questions."
        items.append({"title": "Logistics", "detail": detail})

        return {"title": title, "items": items}


def setup(ctx: Any) -> None:
    ctx.middleware(InterviewDayChecklist())
