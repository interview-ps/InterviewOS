"""Round scoping — port of `interview/rounds.ts`."""

from __future__ import annotations

from .models.target import Requirement, RequirementKind
from .modes import get_mode
from .skill_id import SkillId
from .taxonomy import get_node

__all__ = ["in_round", "round_fallback_requirements"]


def in_round(skill_id: SkillId, round_type: str) -> bool:
    """§8.4/§9.1: which skills a round may ask about.

    "mixed" keeps the whole pool; every other value delegates to its mode
    definition.
    """

    return get_mode(round_type).in_scope(skill_id)


def round_fallback_requirements(round_type: str) -> list[Requirement]:
    """The mode's fallback taxonomy nodes, joining an empty pool at 0.6."""

    requirements: list[Requirement] = []
    for skill_id in get_mode(round_type).fallback_skills:
        node = get_node(skill_id)
        requirements.append(
            Requirement(
                skill_id=skill_id,
                label=node.label if node is not None else skill_id,
                importance=0.6,
                kind=RequirementKind.REQUIRED,
                evidence="round coverage",
            )
        )
    return requirements
