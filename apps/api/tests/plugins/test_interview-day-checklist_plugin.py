"""Bundled `interview-day-checklist` plugin — the Python port (§9.6, §13)."""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Any, Protocol, cast

from interview_os.core.plugin_api import (
    PreparationSuggestRequest,
    PreparationSuggestResponse,
)
from interview_os.plugins import LoadedPlugin, PluginRegistry, load_plugin_dir

REPO_ROOT = Path(__file__).resolve().parents[4]
PLUGIN_DIR = REPO_ROOT / "plugins" / "interview-day-checklist"

GAPS: list[dict[str, Any]] = [
    {"skillId": "sql", "label": "SQL", "importance": 5, "gap": 0.8, "severity": "high"},
    {"skillId": "system-design", "label": "", "importance": 3, "gap": 0.5, "severity": "medium"},
    {"skillId": "coding", "label": "Coding", "importance": 2, "gap": 0.9, "severity": "low"},
    {
        "skillId": "behavioral",
        "label": "Behavioral",
        "importance": 1,
        "gap": 1.0,
        "severity": "low",
    },
]


class ChecklistHook(Protocol):
    """The middleware surface this plugin contributes (hook + legacy execute)."""

    async def preparation_suggest(
        self, req: PreparationSuggestRequest
    ) -> PreparationSuggestResponse: ...

    def execute(self, input: Mapping[str, Any] | None = None) -> dict[str, object]: ...


def _load() -> LoadedPlugin:
    PluginRegistry.reset()
    return load_plugin_dir(PLUGIN_DIR, install_deps=False)


def _hook(loaded: LoadedPlugin) -> ChecklistHook:
    return cast(ChecklistHook, loaded.middleware[0].instance)


def test_manifest_declares_a_hook_plugin() -> None:
    loaded = _load()
    manifest = loaded.manifest
    assert manifest.id == "interview-day-checklist"
    assert manifest.version == "1.1.0"
    assert manifest.name == "Interview Day Checklist"
    assert manifest.description == (
        "A short checklist for interview day: the weakest requirement areas to "
        "skim, a STAR reminder, and logistics."
    )
    assert manifest.kind == "hook"
    assert manifest.entry == "main.py"
    assert [entry.plugin_id for entry in loaded.middleware] == ["interview-day-checklist"]


async def test_preparation_suggest_returns_the_three_weakest_areas() -> None:
    hook = _hook(_load())
    response = await hook.preparation_suggest(
        PreparationSuggestRequest(gaps=GAPS, skill_ids=["sql", "coding", "behavioral"])
    )
    assert isinstance(response, PreparationSuggestResponse)
    assert [activity.skill_id for activity in response.activities] == [
        "sql",
        "coding",
        "system-design",
    ]
    assert [activity.title for activity in response.activities] == [
        "Skim SQL",
        "Skim Coding",
        "Skim system-design",
    ]
    first = response.activities[0]
    assert first.action == (
        "Weak area for this role (severity high) — 10 minutes of review before the interview."
    )
    assert first.success_criteria == ["Can explain the core concept unprompted"]


async def test_preparation_suggest_handles_no_gaps() -> None:
    hook = _hook(_load())
    response = await hook.preparation_suggest(
        PreparationSuggestRequest(gaps=[], skill_ids=["sql"])
    )
    assert response.activities == []


def test_execute_builds_the_legacy_checklist() -> None:
    hook = _hook(_load())
    output = hook.execute(
        {
            "target": {"company": "Acme", "role": "Backend Engineer", "level": "senior"},
            "gaps": GAPS,
        }
    )
    assert output["title"] == "Interview day — Backend Engineer @ Acme"
    items = cast(list[dict[str, str]], output["items"])
    assert [item["title"] for item in items] == [
        "Skim SQL",
        "Skim Coding",
        "Skim system-design",
        "STAR reminder",
        "Logistics",
    ]
    assert items[0]["detail"] == (
        "Weak area #1 for this role (severity high) — 10 minutes of review."
    )
    assert items[3]["detail"] == (
        "Every behavioral answer: Situation → Task → Action → Result. "
        "Land the result with a number."
    )
    assert items[4]["detail"] == (
        "Backend Engineer at Acme — test your camera/mic, water nearby, notebook for questions."
    )


def test_execute_without_a_target_uses_the_generic_title() -> None:
    hook = _hook(_load())
    output = hook.execute({"gaps": []})
    assert output["title"] == "Interview day checklist"
    items = cast(list[dict[str, str]], output["items"])
    assert [item["title"] for item in items] == ["STAR reminder", "Logistics"]
    assert items[1]["detail"] == (
        "Test your camera/mic, water nearby, notebook for questions."
    )
