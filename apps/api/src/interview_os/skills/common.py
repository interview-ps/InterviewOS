"""Skill framework helpers — port of `apps/server/src/skills/framework/common.ts`."""

from __future__ import annotations

from ..core import taxonomy
from ..core.models import CamelModel
from ..core.skill_id import SkillId

__all__ = [
    "TaxonomyEntry",
    "normalize_skill_id_value",
    "normalize_skill_ids",
    "taxonomy_entries",
]


class TaxonomyEntry(CamelModel):
    id: str
    label: str


def taxonomy_entries() -> list[TaxonomyEntry]:
    return [TaxonomyEntry(id=node.id, label=node.label) for node in taxonomy.all_nodes()]


def normalize_skill_ids(raw: list[str]) -> list[SkillId]:
    """Map raw AI-produced ids through normalizeSkillId, dropping invalid ones."""
    out: list[SkillId] = []
    for item in raw:
        skill_id = taxonomy.normalize_skill_id(item)
        if skill_id is not None:
            out.append(skill_id)
    return out


def normalize_skill_id_value(raw: str) -> SkillId | None:
    return taxonomy.normalize_skill_id(raw)
