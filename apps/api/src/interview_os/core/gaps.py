"""Gap analysis — port of `gaps/index.ts`."""

from __future__ import annotations

from collections.abc import Mapping, Sequence

from . import taxonomy as default_taxonomy
from .js_compat import number_to_string, to_fixed
from .models.gaps import Gap, GapSeverity
from .models.readiness import SkillReadiness
from .models.target import Level, Requirement
from .readiness import TaxonomyLike
from .skill_id import SkillId

__all__ = ["TARGET_SCORE_BY_LEVEL", "calculate_gaps"]

TARGET_SCORE_BY_LEVEL: dict[Level, float] = {
    Level.JUNIOR: 0.6,
    Level.MID: 0.7,
    Level.SENIOR: 0.8,
    Level.STAFF: 0.85,
}


def _label_for(skill_id: SkillId, taxonomy: TaxonomyLike | None) -> str:
    return (
        taxonomy.label_for(skill_id)
        if taxonomy is not None
        else default_taxonomy.label_for(skill_id)
    )


def calculate_gaps(
    requirements: Sequence[Requirement],
    readiness: Mapping[str, SkillReadiness],
    level: Level,
    taxonomy: TaxonomyLike | None = None,
) -> list[Gap]:
    target_score = TARGET_SCORE_BY_LEVEL[level]

    gaps: list[Gap] = []
    for requirement in requirements:
        dimension = readiness.get(requirement.skill_id)
        current_score = dimension.score if dimension is not None else None
        uncertainty = 1 - (dimension.confidence if dimension is not None else 0)
        gap = max(0.0, target_score - (current_score if current_score is not None else 0.0))
        weighted = requirement.importance * gap
        if weighted >= 0.45:
            severity = GapSeverity.HIGH
        elif weighted >= 0.2:
            severity = GapSeverity.MEDIUM
        else:
            severity = GapSeverity.LOW
        if current_score is None:
            reason = (
                f"no evidence for {requirement.kind} skill; {level} target is "
                f"{number_to_string(target_score)}"
            )
        else:
            importance = number_to_string(requirement.importance)
            reason = (
                f"current {to_fixed(current_score)} vs {level} target "
                f"{number_to_string(target_score)} (importance {importance})"
            )
        gaps.append(
            Gap(
                skill_id=requirement.skill_id,
                label=requirement.label or _label_for(requirement.skill_id, taxonomy),
                importance=requirement.importance,
                target_score=target_score,
                current_score=current_score,
                gap=gap,
                uncertainty=uncertainty,
                severity=severity,
                reason=reason,
            )
        )

    gaps.sort(
        key=lambda g: (-(g.importance * g.gap * (0.5 + g.uncertainty)), g.skill_id),
    )
    return gaps
