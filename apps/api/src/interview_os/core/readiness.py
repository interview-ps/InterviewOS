"""Readiness graph — port of `readiness/index.ts`.

Scores are evidence-backed: every score is derived from `skill_evidence`, decay
is by evidence type half-life, and the graph is a pure function of
`(evidence, requirements, taxonomy, now)`.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Protocol

from pydantic import Field

from . import taxonomy as default_taxonomy
from .js_compat import parse_iso_datetime, to_iso_string
from .models.readiness import (
    Evidence,
    EvidenceType,
    ReadinessGraph,
    ReadinessStatus,
    SkillReadiness,
)
from .models.shared import CamelModel
from .models.target import Requirement
from .skill_id import SkillId, parent_skill_id

__all__ = [
    "CONFIDENCE_CAP",
    "EVIDENCE_HALF_LIFE_DAYS",
    "EVIDENCE_TYPE_WEIGHT",
    "RECENCY_DECAY",
    "UNKNOWN_PRIOR",
    "DirectReadiness",
    "TaxonomyLike",
    "build_readiness_graph",
    "compute_skill_readiness",
    "confidence_for_weight",
    "status_for_score",
]

EVIDENCE_TYPE_WEIGHT: dict[EvidenceType, float] = {
    EvidenceType.INTERVIEW_ANSWER: 1.0,
    EvidenceType.PRACTICE: 0.7,
    EvidenceType.PLUGIN: 0.5,
    EvidenceType.RESUME_CLAIM: 0.4,
    EvidenceType.SELF_REPORT: 0.3,
}

# Half-life in days per evidence type (§8.1 time decay).
EVIDENCE_HALF_LIFE_DAYS: dict[EvidenceType, float] = {
    EvidenceType.INTERVIEW_ANSWER: 60,
    EvidenceType.PRACTICE: 45,
    EvidenceType.PLUGIN: 45,
    EvidenceType.SELF_REPORT: 30,
    EvidenceType.RESUME_CLAIM: 180,
}

RECENCY_DECAY = 0.85
CONFIDENCE_CAP = 0.95
UNKNOWN_PRIOR = 0.25
_CONFIDENCE_SATURATION = 1.5
_DAY_SECONDS = 86_400


class TaxonomyLike(Protocol):
    def parent_of(self, skill_id: str) -> SkillId | None: ...

    def label_for(self, skill_id: str) -> str: ...

    def children_of(self, skill_id: str) -> list[SkillId]: ...


class _DefaultTaxonomy:
    """The bundled taxonomy exposed as a `TaxonomyLike`."""

    def parent_of(self, skill_id: str) -> SkillId | None:
        return default_taxonomy.parent_of(skill_id)

    def label_for(self, skill_id: str) -> str:
        return default_taxonomy.label_for(skill_id)

    def children_of(self, skill_id: str) -> list[SkillId]:
        return default_taxonomy.children_of(skill_id)


_DEFAULT_TAXONOMY: TaxonomyLike = _DefaultTaxonomy()


class DirectReadiness(CamelModel):
    score: float | None
    confidence: float
    weight: float
    evidence_ids: list[str] = Field(default_factory=list)
    status: ReadinessStatus


def status_for_score(score: float | None) -> ReadinessStatus:
    if score is None:
        return ReadinessStatus.UNKNOWN
    if score < 0.5:
        return ReadinessStatus.WEAK
    if score < 0.75:
        return ReadinessStatus.DEVELOPING
    return ReadinessStatus.STRONG


def _sort_newest_first(evidence: Sequence[Evidence]) -> list[Evidence]:
    by_id = sorted(evidence, key=lambda e: e.id)
    return sorted(by_id, key=lambda e: e.created_at, reverse=True)


def _evidence_weight(evidence: Evidence, rank: int, now: datetime) -> float:
    age_days = max(
        0.0, (now - parse_iso_datetime(evidence.created_at)).total_seconds() / _DAY_SECONDS
    )
    age_decay = math.pow(0.5, age_days / EVIDENCE_HALF_LIFE_DAYS[evidence.type])
    return (
        evidence.confidence * EVIDENCE_TYPE_WEIGHT[evidence.type] * RECENCY_DECAY**rank * age_decay
    )


def confidence_for_weight(total_weight: float) -> float:
    return min(CONFIDENCE_CAP, 1 - math.exp(-total_weight / _CONFIDENCE_SATURATION))


def compute_skill_readiness(
    evidence: Sequence[Evidence], now: datetime | None = None
) -> DirectReadiness:
    moment = now if now is not None else datetime.now(UTC)
    sorted_evidence = _sort_newest_first(evidence)
    weight = 0.0
    weighted_score = 0.0
    for rank, item in enumerate(sorted_evidence):
        item_weight = _evidence_weight(item, rank, moment)
        weight += item_weight
        weighted_score += item_weight * item.score
    score = None if weight == 0 else weighted_score / weight
    return DirectReadiness(
        score=score,
        confidence=0.0 if weight == 0 else confidence_for_weight(weight),
        weight=weight,
        evidence_ids=[e.id for e in sorted_evidence],
        status=status_for_score(score),
    )


def build_readiness_graph(
    evidence: Sequence[Evidence],
    requirements: Sequence[Requirement],
    taxonomy: TaxonomyLike | None = None,
    now: datetime | None = None,
) -> ReadinessGraph:
    nodes = taxonomy if taxonomy is not None else _DEFAULT_TAXONOMY
    moment = now if now is not None else datetime.now(UTC)

    evidence_by_skill: dict[SkillId, list[Evidence]] = {}
    for item in evidence:
        evidence_by_skill.setdefault(item.skill_id, []).append(item)

    node_ids: list[SkillId] = []

    def add_with_ancestors(skill_id: SkillId) -> None:
        cur: SkillId | None = skill_id
        while cur is not None and cur not in node_ids:
            node_ids.append(cur)
            cur = parent_skill_id(cur)

    for requirement in requirements:
        add_with_ancestors(requirement.skill_id)
    for item in evidence:
        add_with_ancestors(item.skill_id)

    node_set = set(node_ids)
    children_of_node: dict[SkillId, list[SkillId]] = {}
    for skill_id in node_ids:
        parent = parent_skill_id(skill_id)
        if parent is not None and parent in node_set:
            children_of_node.setdefault(parent, []).append(skill_id)
    for children in children_of_node.values():
        children.sort()

    def depth(skill_id: SkillId) -> int:
        return skill_id.count(".")

    ordered = sorted(node_ids, key=lambda skill_id: (-depth(skill_id), skill_id))

    dimensions: dict[SkillId, SkillReadiness] = {}
    for skill_id in ordered:
        direct = compute_skill_readiness(evidence_by_skill.get(skill_id, []), moment)
        children = children_of_node.get(skill_id, [])
        scored_children = [
            dimensions[child]
            for child in children
            if child in dimensions and dimensions[child].score is not None
        ]

        score = direct.score
        confidence = direct.confidence
        if scored_children:
            child_conf_sum = sum(child.confidence for child in scored_children)
            child_score = (
                sum(
                    (child.score if child.score is not None else 0.0) * child.confidence
                    for child in scored_children
                )
                / child_conf_sum
            )
            child_weight = child_conf_sum / len(scored_children)
            total_weight = direct.weight + child_weight
            score = (
                direct.weight * (direct.score if direct.score is not None else 0.0)
                + child_score * child_weight
            ) / total_weight
            confidence = confidence_for_weight(total_weight)

        dimensions[skill_id] = SkillReadiness(
            skill_id=skill_id,
            label=nodes.label_for(skill_id),
            score=score,
            confidence=confidence,
            evidence_ids=direct.evidence_ids,
            children=children,
            status=status_for_score(score),
        )

    importance_sum = 0.0
    overall_num = 0.0
    overall_conf_num = 0.0
    for requirement in requirements:
        dimension = dimensions.get(requirement.skill_id)
        importance_sum += requirement.importance
        overall_num += requirement.importance * (
            dimension.score
            if dimension is not None and dimension.score is not None
            else UNKNOWN_PRIOR
        )
        overall_conf_num += requirement.importance * (
            dimension.confidence if dimension is not None else 0.0
        )

    return ReadinessGraph(
        dimensions=dimensions,
        overall=0.0 if importance_sum == 0 else overall_num / importance_sum,
        overall_confidence=0.0 if importance_sum == 0 else overall_conf_num / importance_sum,
        last_updated=to_iso_string(moment),
    )
