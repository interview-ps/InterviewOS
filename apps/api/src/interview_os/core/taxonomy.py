"""Taxonomy registry — port of `taxonomy/index.ts`.

Module-level state, like the TS original: `get_node` creates an on-demand node
for valid-but-unknown ids (and its ancestors), which the golden fixtures
capture.
"""

from __future__ import annotations

import re
from collections.abc import Sequence

from pydantic import Field

from .models.shared import CamelModel
from .skill_id import SkillId, humanize_skill_segment, is_skill_id, parent_skill_id
from .taxonomy_seed import TAXONOMY_SEED, TaxonomyNodeSeed

__all__ = [
    "EXTRA_ALIASES",
    "RELATED_EDGES",
    "TAXONOMY_SEED",
    "SkillMatch",
    "TaxonomyNode",
    "all_nodes",
    "ancestors",
    "children_of",
    "get_node",
    "has_node",
    "label_for",
    "match_skills",
    "normalize_skill_id",
    "parent_of",
    "register_nodes",
    "related_to",
]


class TaxonomyNode(CamelModel):
    id: SkillId
    label: str
    keywords: list[str] = Field(default_factory=list)


class SkillMatch(CamelModel):
    skill_id: SkillId
    mentions: int


_nodes: dict[str, TaxonomyNode] = {}
_children_index: dict[str, set[str]] = {}


def _register(node: TaxonomyNode) -> None:
    _nodes[node.id] = node
    parent = parent_skill_id(node.id)
    if parent is not None:
        _children_index.setdefault(parent, set()).add(node.id)
        if parent not in _nodes:
            _ensure_node(parent)


def _ensure_node(skill_id: str) -> TaxonomyNode:
    existing = _nodes.get(skill_id)
    if existing is not None:
        return existing
    created = TaxonomyNode(
        id=skill_id,
        label=humanize_skill_segment(skill_id.split(".")[-1]),
        keywords=[],
    )
    _register(created)
    return created


_seeded_ids: set[str] = set()
for _seed in TAXONOMY_SEED:
    _register(TaxonomyNode(id=_seed.id, label=_seed.label, keywords=list(_seed.keywords)))
    _seeded_ids.add(_seed.id)

EXTRA_ALIASES: dict[str, SkillId] = {
    "rest-api": "apis.rest",
    "restapi": "apis.rest",
    "message-queue": "distributed-systems.message-queues",
    "message-queues": "distributed-systems.message-queues",
    "mq": "distributed-systems.message-queues",
    "cache-invalidation": "distributed-systems.caching.cache-invalidation",
    "cache-strategy": "distributed-systems.caching.cache-strategies",
    "system-design.requirements": "system-design.requirements-analysis",
    "cap-theorem": "distributed-systems.consistency",
}

_alias_index: dict[str, str] | None = None


def _normalize_raw(raw: str) -> str:
    return re.sub(r"-+", "-", re.sub(r"[\s_]+", "-", raw.strip().lower()))


def _get_alias_index() -> dict[str, str]:
    global _alias_index
    if _alias_index is not None:
        return _alias_index
    index: dict[str, str] = {}
    for node in _nodes.values():
        for key in (node.id, node.label, *node.keywords):
            normalized = _normalize_raw(key)
            if is_skill_id(normalized) and normalized not in index:
                index[normalized] = node.id
    index.update(EXTRA_ALIASES)
    _alias_index = index
    return index


def get_node(skill_id: str) -> TaxonomyNode | None:
    """The node for `id`, creating an on-demand node for valid unknown ids."""

    if not is_skill_id(skill_id):
        return None
    return _ensure_node(skill_id)


def has_node(skill_id: str) -> bool:
    return skill_id in _nodes


def parent_of(skill_id: str) -> SkillId | None:
    return parent_skill_id(skill_id)


def ancestors(skill_id: str) -> list[SkillId]:
    """Ancestors of `id` from immediate parent up to the root."""

    out: list[SkillId] = []
    cur = parent_skill_id(skill_id)
    while cur is not None:
        out.append(cur)
        cur = parent_skill_id(cur)
    return out


def children_of(skill_id: str) -> list[SkillId]:
    return sorted(_children_index.get(skill_id, set()))


RELATED_EDGES: tuple[tuple[SkillId, SkillId], ...] = (
    ("sql.transactions", "distributed-systems.consistency"),
    ("sql.transactions", "system-design.data-modeling"),
    ("distributed-systems.caching.cache-invalidation", "distributed-systems.consistency"),
    ("distributed-systems.message-queues", "system-design.async-processing"),
    ("coding.complexity", "system-design.scalability"),
)

_related_index: dict[str, set[str]] = {}
for _a, _b in RELATED_EDGES:
    for _x, _y in ((_a, _b), (_b, _a)):
        _related_index.setdefault(_x, set()).add(_y)


def related_to(skill_id: str) -> list[SkillId]:
    """Skills related to `id` via §9.1 cross-branch edges (both directions)."""

    return sorted(_related_index.get(skill_id, set()))


def label_for(skill_id: str) -> str:
    node = _nodes.get(skill_id)
    if node is not None:
        return node.label
    return humanize_skill_segment(skill_id.split(".")[-1])


def all_nodes() -> list[TaxonomyNode]:
    return list(_nodes.values())


def register_nodes(list_: Sequence[TaxonomyNodeSeed]) -> None:
    """v0.4 packs: register extra nodes (idempotent) and invalidate the alias index."""

    global _alias_index
    for node in list_:
        _register(TaxonomyNode(id=node.id, label=node.label, keywords=list(node.keywords)))
    _alias_index = None


_JS_ESCAPE_RE = re.compile(r"[.*+?^${}()|\[\]\\]")


def _count_keyword_mentions(text: str, keyword: str) -> int:
    escaped = _JS_ESCAPE_RE.sub(lambda m: "\\" + m.group(0), keyword)
    pattern = re.compile(f"(^|[^a-z0-9]){escaped}([^a-z0-9]|$)", re.IGNORECASE)
    return len(pattern.findall(text))


def match_skills(text: str) -> list[SkillMatch]:
    """Case-insensitive, word-boundary keyword matching over the taxonomy."""

    results: list[SkillMatch] = []
    for node in _nodes.values():
        mentions = 0
        for keyword in node.keywords:
            mentions += _count_keyword_mentions(text, keyword)
        if mentions > 0:
            results.append(SkillMatch(skill_id=node.id, mentions=mentions))
    return sorted(results, key=lambda match: (-match.mentions, match.skill_id))


def normalize_skill_id(raw: str) -> SkillId | None:
    """Lowercase, spaces/underscores → '-', collapse dashes, map known aliases."""

    normalized = _normalize_raw(raw)
    alias = _get_alias_index().get(normalized)
    if alias is not None:
        return alias
    if not is_skill_id(normalized):
        return None
    if normalized in _seeded_ids:
        return normalized
    # models sometimes guess a branch prefix ("coding.complexity-analysis");
    # snap the last segment to a canonical node when it is a known alias
    last = normalized.split(".")[-1]
    if last != normalized:
        last_alias = _get_alias_index().get(last)
        if last_alias is not None:
            return last_alias
    return normalized
