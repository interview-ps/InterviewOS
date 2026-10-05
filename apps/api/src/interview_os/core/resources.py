"""Preparation resources — port of `preparation/resources.ts`."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from .models.preparation import PrepResource, PrepResourceKind
from .skill_id import SkillId
from .taxonomy import label_for

__all__ = ["builtin_resources_for", "merge_resources"]


@dataclass(frozen=True, slots=True)
class _CatalogEntry:
    title: str
    kind: PrepResourceKind
    url: str | None = None
    summary: str | None = None


def _docs(title: str, url: str) -> _CatalogEntry:
    return _CatalogEntry(title=title, kind=PrepResourceKind.DOCS, url=url)


def _article(title: str, url: str) -> _CatalogEntry:
    return _CatalogEntry(title=title, kind=PrepResourceKind.ARTICLE, url=url)


def _explanation(title: str, summary: str) -> _CatalogEntry:
    return _CatalogEntry(title=title, kind=PrepResourceKind.EXPLANATION, summary=summary)


# Built-in catalog, keyed by skill-id prefix. Only stable official
# documentation URLs are used; entries without a confident URL carry none.
_CATALOG: dict[str, list[_CatalogEntry]] = {
    "sql.indexing": [
        _docs(
            "PostgreSQL documentation — Indexes",
            "https://www.postgresql.org/docs/current/indexes.html",
        ),
        _article("Use The Index, Luke", "https://use-the-index-luke.com/"),
    ],
    "sql.query-optimization": [
        _docs(
            "PostgreSQL documentation — Using EXPLAIN",
            "https://www.postgresql.org/docs/current/using-explain.html",
        ),
    ],
    "sql.transactions": [
        _docs(
            "PostgreSQL documentation — Transaction Isolation",
            "https://www.postgresql.org/docs/current/transaction-iso.html",
        ),
    ],
    "sql": [
        _docs(
            "PostgreSQL documentation — SQL tutorial",
            "https://www.postgresql.org/docs/current/tutorial-sql.html",
        ),
    ],
    "apis.rest": [
        _docs("MDN — HTTP overview", "https://developer.mozilla.org/en-US/docs/Web/HTTP/Overview"),
    ],
    "apis": [
        _docs("MDN — HTTP", "https://developer.mozilla.org/en-US/docs/Web/HTTP"),
    ],
    "distributed-systems.consistency": [
        _explanation(
            "Interview OS explanation: consistency models",
            "Strong vs eventual consistency, linearizability, and the trade-offs you are "
            "expected to name in a design interview.",
        ),
    ],
    "distributed-systems.caching": [
        _explanation(
            "Interview OS explanation: caching patterns",
            "Cache-aside, read/write-through, TTLs and invalidation — the vocabulary "
            "interviewers probe for.",
        ),
    ],
    "distributed-systems.message-queues": [
        _explanation(
            "Interview OS explanation: delivery semantics",
            "At-least-once vs exactly-once delivery, idempotent consumers, dead-letter queues "
            "and backpressure.",
        ),
    ],
    "system-design": [
        _explanation(
            "Interview OS explanation: the design-interview frame",
            "Clarify requirements, estimate capacity, sketch the high-level design, then drill "
            "into bottlenecks and trade-offs.",
        ),
    ],
    "system-design.scalability": [
        _explanation(
            "Interview OS explanation: scaling reads and writes",
            "Caching, replication, partitioning/sharding and load balancing — and when each "
            "breaks down.",
        ),
    ],
    "coding": [
        _explanation(
            "Interview OS explanation: interview coding technique",
            "Think aloud, state complexity, test edge cases — the habits evaluators score on "
            "top of a correct solution.",
        ),
    ],
    "behavioral": [
        _explanation(
            "Interview OS explanation: STAR structure",
            "Situation, Task, Action, Result — keep the result measurable and your own actions "
            "first-person.",
        ),
    ],
    "python": [
        _docs("Python documentation", "https://docs.python.org/3/"),
    ],
    "infrastructure.kubernetes": [
        _docs("Kubernetes documentation", "https://kubernetes.io/docs/home/"),
    ],
}


def builtin_resources_for(skill_id: SkillId) -> list[PrepResource]:
    """The most-specific catalog prefix match, plus an always-available practice entry."""

    prefix: str | None = skill_id
    entries: list[_CatalogEntry] = []
    while prefix is not None:
        hit = _CATALOG.get(prefix)
        if hit is not None:
            entries = hit
            break
        index = prefix.rfind(".")
        prefix = None if index == -1 else prefix[:index]

    resources = [
        PrepResource(
            skill_id=skill_id,
            title=entry.title,
            url=entry.url,
            summary=entry.summary,
            kind=entry.kind,
            source="builtin",
        )
        for entry in entries
    ]
    resources.append(
        PrepResource(
            skill_id=skill_id,
            title=f"Practice a {label_for(skill_id)} question",
            summary="Start a practice session in Interview OS to verify this skill.",
            kind=PrepResourceKind.PRACTICE,
            source="builtin",
        )
    )
    return resources


def merge_resources(*lists: Sequence[PrepResource]) -> list[PrepResource]:
    """Merge resource lists, deduping by title+url."""

    seen: set[str] = set()
    merged: list[PrepResource] = []
    for list_ in lists:
        for resource in list_:
            key = f"{resource.title}\t{resource.url or ''}"
            if key in seen:
                continue
            seen.add(key)
            merged.append(resource)
    return merged
