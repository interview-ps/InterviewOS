"""Bundled `learning-resources` plugin — the Python port (phase 7 §13)."""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Any, Protocol, cast

from interview_os.core.plugin_api import (
    ResourceLite,
    ResourcesSuggestRequest,
    ResourcesSuggestResponse,
)
from interview_os.plugins import LoadedPlugin, PluginRegistry, load_plugin_dir

REPO_ROOT = Path(__file__).resolve().parents[4]
PLUGIN_DIR = REPO_ROOT / "plugins" / "learning-resources"


class LearningResourcesHook(Protocol):
    """The middleware surface this plugin contributes (hook + legacy execute)."""

    async def resources_suggest(
        self, req: ResourcesSuggestRequest
    ) -> ResourcesSuggestResponse: ...

    def execute(self, input: Mapping[str, Any] | None = None) -> ResourcesSuggestResponse: ...


def _load() -> LoadedPlugin:
    PluginRegistry.reset()
    return load_plugin_dir(PLUGIN_DIR, install_deps=False)


def _hook(loaded: LoadedPlugin) -> LearningResourcesHook:
    return cast(LearningResourcesHook, loaded.middleware[0].instance)


def test_manifest_declares_a_hook_plugin() -> None:
    loaded = _load()
    manifest = loaded.manifest
    assert manifest.id == "learning-resources"
    assert manifest.version == "1.0.0"
    assert manifest.name == "Learning Resources"
    assert manifest.description == (
        "A small deterministic catalog of learning resources keyed by skill."
    )
    assert manifest.kind == "hook"
    assert manifest.entry == "main.py"
    assert [entry.plugin_id for entry in loaded.middleware] == ["learning-resources"]


async def test_resources_suggest_matches_prefixes_in_catalog_order() -> None:
    hook = _hook(_load())
    response = await hook.resources_suggest(
        ResourcesSuggestRequest(
            skill_ids=["coding", "sql.indexing", "behavioral", "unknown"]
        )
    )
    assert isinstance(response, ResourcesSuggestResponse)
    assert [resource.title for resource in response.resources] == [
        "PostgreSQL tutorial",
        "STAR practice",
        "Deliberate practice loop",
    ]


async def test_resources_suggest_returns_the_catalog_fields() -> None:
    hook = _hook(_load())
    response = await hook.resources_suggest(ResourcesSuggestRequest(skill_ids=["sql"]))
    assert response.resources == [
        ResourceLite(
            title="PostgreSQL tutorial",
            url="https://www.postgresql.org/docs/current/tutorial.html",
            kind="docs",
        )
    ]
    # the host stamps the skill id and source, so the plugin leaves them out
    assert response.resources[0].skill_id is None
    assert response.resources[0].source is None


async def test_resources_suggest_requires_a_segment_boundary() -> None:
    hook = _hook(_load())
    response = await hook.resources_suggest(ResourcesSuggestRequest(skill_ids=["sqlx"]))
    assert response.resources == []


def test_execute_reads_request_skill_ids() -> None:
    hook = _hook(_load())
    response = hook.execute({"request": {"skillIds": ["sql", "coding"]}})
    assert [resource.title for resource in response.resources] == [
        "PostgreSQL tutorial",
        "Deliberate practice loop",
    ]
    assert hook.execute({}).resources == []
