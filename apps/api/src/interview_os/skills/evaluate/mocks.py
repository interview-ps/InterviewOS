"""Evaluate-skill mock handlers — ports of `skills/evaluate/*/mock.ts`."""

from __future__ import annotations

from ...core import taxonomy
from ...plugins.testing.mock_helpers import generic_evaluation_mock, round2

__all__ = ["answer_evaluator_mock", "interview_debrief_mock", "loop_debrief_mock"]


def _dict(value: object) -> dict[str, object]:
    return dict(value) if isinstance(value, dict) else {}


def _list(value: object) -> list[object]:
    return list(value) if isinstance(value, list | tuple) else []


def answer_evaluator_mock(input: object) -> object:
    """Deterministic mock for the host's `answer-evaluator` task ("mixed" + practice)."""
    return generic_evaluation_mock(input)


def interview_debrief_mock(input: object) -> object:
    data = _dict(input)
    role = str(data.get("role", ""))
    questions = _list(data.get("questions"))
    evaluations = [item for item in _list(data.get("evaluations")) if isinstance(item, dict)]

    strengths: list[str] = []
    weaknesses: dict[str, str] = {}
    for evaluation in evaluations:
        for strength in _list(evaluation.get("strengths")):
            if isinstance(strength, dict):
                entry = f"{strength.get('skill')}: {strength.get('evidence')}"
                if entry not in strengths:
                    strengths.append(entry)
        for weakness in _list(evaluation.get("weaknesses")):
            if not isinstance(weakness, dict):
                continue
            skill = str(weakness.get("skill"))
            if skill not in weaknesses or weakness.get("severity") == "high":
                weaknesses[skill] = f"{skill}: {weakness.get('evidence')}"

    answered = len(evaluations)
    open_actions = [item for item in _list(data.get("openActions")) if isinstance(item, dict)]
    return {
        "summary": (
            f"Mock interview for {role}: {answered} answer(s) across {len(questions)} "
            f"question(s), {len(strengths)} strength area(s), {len(weaknesses)} weak area(s)."
        ),
        "wentWell": strengths[:5],
        "toImprove": list(weaknesses.values())[:5],
        "nextActions": [action.get("action") for action in open_actions[:5]],
    }


def _skill_name(item: dict[str, object]) -> str:
    label = item.get("label")
    if isinstance(label, str) and label:
        return label
    return taxonomy.label_for(str(item.get("skillId", "")))


def loop_debrief_mock(input: object) -> object:
    """Signal from the mean rubric score: ≥0.7 strong, ≥0.45 mixed, else weak."""
    data = _dict(input)
    role = str(data.get("role", ""))
    company = str(data.get("company") or "")
    rounds = [item for item in _list(data.get("rounds")) if isinstance(item, dict)]
    readiness_change = _dict(data.get("readinessChange"))

    out_rounds: list[dict[str, object]] = []
    for round_input in rounds:
        averages = _dict(round_input.get("rubricAverages"))
        values = [float(value) for value in averages.values() if isinstance(value, int | float)]
        mean = sum(values) / len(values) if values else 0.3
        signal = "strong" if mean >= 0.7 else "mixed" if mean >= 0.45 else "weak"
        handoff = _dict(round_input.get("handoff"))
        summaries = _list(round_input.get("summaries"))
        evidence: list[str] = [f"mean rubric {round2(mean)}"]
        for weak in _list(handoff.get("weakSkills")):
            if isinstance(weak, dict):
                evidence.append(f"weak {_skill_name(weak)} ({round2(float(weak.get('score', 0)))})")
        for strong in _list(handoff.get("strongSkills")):
            if isinstance(strong, dict):
                evidence.append(
                    f"strong {_skill_name(strong)} ({round2(float(strong.get('score', 0)))})"
                )
        if summaries and isinstance(summaries[0], str):
            evidence.append(summaries[0][:120])
        out_rounds.append(
            {
                "mode": round_input.get("mode"),
                "label": round_input.get("label"),
                "signal": signal,
                "evidence": evidence[:5],
            }
        )

    weak_count = sum(1 for round_out in out_rounds if round_out["signal"] == "weak")
    strong_count = sum(1 for round_out in out_rounds if round_out["signal"] == "strong")
    top_actions: list[str] = []
    for round_input in rounds:
        handoff = _dict(round_input.get("handoff"))
        for weak in _list(handoff.get("weakSkills")):
            if isinstance(weak, dict) and len(top_actions) < 5:
                top_actions.append(
                    f"Review {_skill_name(weak)} fundamentals and retry a focused question"
                )

    where = f" at {company}" if company else ""
    mixed_count = len(out_rounds) - strong_count - weak_count
    return {
        "summary": (
            f"Mock loop debrief for {role}{where}: {len(rounds)} round(s) — "
            f"{strong_count} strong, {mixed_count} mixed, {weak_count} weak."
        ),
        "rounds": out_rounds,
        "readinessChange": readiness_change,
        "topActions": top_actions,
    }
