"""Learning Resources — Python port of the bundled TS plugin (phase 7 §13).

`resources.suggest` — a small deterministic catalog of learning resources keyed
by the leading segment of a skill id. Read-only: no runtime, no writes.

The TS plugin's `execute` entry point is preserved for 1:1 parity; the hook
returns the Plugin API v1 `ResourcesSuggestResponse` model.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from interview_os.core.plugin_api import (
    ResourceLite,
    ResourcesSuggestRequest,
    ResourcesSuggestResponse,
)

__all__ = ["CATALOG", "CatalogEntry", "LearningResources", "setup", "suggest"]


@dataclass(frozen=True, slots=True)
class CatalogEntry:
    """One catalog row; `skill_prefix` is the taxonomy segment it answers for."""

    skill_prefix: str
    title: str
    kind: str
    url: str | None = None
    summary: str | None = None


CATALOG: tuple[CatalogEntry, ...] = (
    CatalogEntry(
        skill_prefix="sql",
        title="PostgreSQL tutorial",
        url="https://www.postgresql.org/docs/current/tutorial.html",
        kind="docs",
    ),
    CatalogEntry(
        skill_prefix="system-design",
        title="Design interview checklist",
        summary="Requirements → capacity → high-level design → deep dive → trade-offs.",
        kind="explanation",
    ),
    CatalogEntry(
        skill_prefix="distributed-systems",
        title="Distributed systems primer",
        summary="Replication, partitioning, consistency — the core vocabulary.",
        kind="article",
    ),
    CatalogEntry(
        skill_prefix="behavioral",
        title="STAR practice",
        summary="Rehearse three stories aloud; time each at ~2 minutes.",
        kind="practice",
    ),
    CatalogEntry(
        skill_prefix="coding",
        title="Deliberate practice loop",
        summary="Solve one problem timed, then write up the complexity analysis.",
        kind="practice",
    ),
)


def _matches(skill_id: str, entry: CatalogEntry) -> bool:
    """`s === prefix || s.startsWith(prefix + ".")` — a segment-boundary match."""

    return skill_id == entry.skill_prefix or skill_id.startswith(f"{entry.skill_prefix}.")


def suggest(skill_ids: Sequence[str]) -> ResourcesSuggestResponse:
    """Catalog rows whose skill prefix is requested, in catalog order."""

    resources = [
        ResourceLite(title=entry.title, url=entry.url, summary=entry.summary, kind=entry.kind)
        for entry in CATALOG
        if any(_matches(skill_id, entry) for skill_id in skill_ids)
    ]
    return ResourcesSuggestResponse(resources=resources)


class LearningResources:
    """The `hook` plugin's middleware instance (all hooks optional)."""

    async def resources_suggest(self, req: ResourcesSuggestRequest) -> ResourcesSuggestResponse:
        """`resources.suggest` — Plugin API v1 contract."""

        return suggest(req.skill_ids)

    def execute(self, input: Mapping[str, Any] | None = None) -> ResourcesSuggestResponse:
        """Legacy `/run` entry: read `request.skillIds` and behave identically."""

        request = input.get("request") if input else None
        raw = request.get("skillIds") if isinstance(request, Mapping) else None
        skill_ids = [str(item) for item in raw] if isinstance(raw, list) else []
        return suggest(skill_ids)


def setup(ctx: Any) -> None:
    ctx.middleware(LearningResources())
