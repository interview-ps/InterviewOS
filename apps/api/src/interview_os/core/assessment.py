"""Evaluation normalisation — port of `assessment/index.ts`'s `normalizeEvaluation`.

The models live in `core.models.assessment`; this is the pure function that
merges the duplicate per-skill entries an evaluator (mock or model) may emit.
"""

from __future__ import annotations

from .models.assessment import (
    AnswerEvaluation,
    EvaluationStrength,
    EvaluationWeakness,
    SkillScore,
    WeaknessSeverity,
)

__all__ = ["normalize_evaluation"]

_SEVERITY_RANK: dict[WeaknessSeverity, int] = {
    WeaknessSeverity.LOW: 0,
    WeaknessSeverity.MEDIUM: 1,
    WeaknessSeverity.HIGH: 2,
}


def normalize_evaluation[T: AnswerEvaluation](evaluation: T) -> T:
    """Merge duplicate per-skill entries an evaluator (mock or model) may emit.

    Weaknesses keep the worst severity and join evidence, strengths join
    evidence, scores average with max confidence, missingConcepts are deduped.
    Idempotent — safe to re-apply (the orchestrator applies it again on persist).
    """

    weaknesses: dict[str, EvaluationWeakness] = {}
    for weakness in evaluation.weaknesses:
        current = weaknesses.get(weakness.skill)
        if current is None:
            weaknesses[weakness.skill] = weakness.model_copy()
            continue
        if _SEVERITY_RANK[weakness.severity] > _SEVERITY_RANK[current.severity]:
            current.severity = weakness.severity
        current.evidence = f"{current.evidence}; {weakness.evidence}"

    strengths: dict[str, EvaluationStrength] = {}
    for strength in evaluation.strengths:
        existing = strengths.get(strength.skill)
        if existing is None:
            strengths[strength.skill] = strength.model_copy()
        else:
            existing.evidence = f"{existing.evidence}; {strength.evidence}"

    score_sums: dict[str, float] = {}
    score_counts: dict[str, int] = {}
    score_confidence: dict[str, float] = {}
    for score in evaluation.scores:
        score_sums[score.skill] = score_sums.get(score.skill, 0.0) + score.score
        score_counts[score.skill] = score_counts.get(score.skill, 0) + 1
        score_confidence[score.skill] = max(
            score_confidence.get(score.skill, 0.0), score.confidence
        )

    return evaluation.model_copy(
        update={
            "strengths": list(strengths.values()),
            "weaknesses": list(weaknesses.values()),
            "scores": [
                SkillScore(
                    skill=skill,
                    score=score_sums[skill] / score_counts[skill],
                    confidence=score_confidence[skill],
                )
                for skill in score_sums
            ],
            "missing_concepts": list(dict.fromkeys(evaluation.missing_concepts)),
        }
    )
