"""Lifecycle dispatcher tests (§7.3)."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

from interview_os.plugins import (
    PluginDispatcher,
    PluginRegistry,
    current_plugin_settings,
    load_plugin_dir,
)


def _rows(responses: list[object]) -> list[dict[str, Any]]:
    return [cast("dict[str, Any]", item) for item in responses]

_MW = '''
class Middleware:
    def __init__(self, tag):
        self.tag = tag

    async def resources_suggest(self, req):
        from interview_os.plugins import current_plugin_settings

        return {"tag": self.tag, "settings": dict(current_plugin_settings())}


def setup(ctx):
    ctx.middleware(Middleware("__TAG__"), priority=__PRIORITY__)
'''


def _mw(tag: str, priority: int) -> str:
    return _MW.replace("__TAG__", tag).replace("__PRIORITY__", str(priority))

_RAISER = '''
class Middleware:
    async def resources_suggest(self, req):
        raise RuntimeError("boom")


def setup(ctx):
    ctx.middleware(Middleware())
'''


def _plugin(root: Path, plugin_id: str, body: str, *, applies_to: str | None = None) -> Path:
    directory = root / plugin_id
    directory.mkdir()
    manifest = f"id: {plugin_id}\nversion: 1.0.0\nkind: hook\nentry: main.py\n"
    if applies_to is not None:
        manifest += f"appliesTo:\n  skillPrefixes: [{applies_to}]\n"
    (directory / "plugin.yaml").write_text(manifest, encoding="utf-8")
    (directory / "main.py").write_text(body, encoding="utf-8")
    return directory


def _reset() -> None:
    PluginRegistry.reset()


def test_dispatch_orders_by_priority_then_id(tmp_path: Path) -> None:
    _reset()
    load_plugin_dir(_plugin(tmp_path, "b-plugin", _mw("b", 100)))
    load_plugin_dir(_plugin(tmp_path, "a-plugin", _mw("a", 100)))
    load_plugin_dir(_plugin(tmp_path, "early", _mw("e", 1)))

    import asyncio

    out = asyncio.run(PluginDispatcher().dispatch("resources.suggest", object()))
    assert [item["tag"] for item in _rows(out)] == ["e", "a", "b"]


def test_dispatch_applies_to_skill_filter(tmp_path: Path) -> None:
    _reset()
    load_plugin_dir(
        _plugin(tmp_path, "sql-only", _mw("sql", 1), applies_to="sql")
    )
    load_plugin_dir(_plugin(tmp_path, "any-skill", _mw("any", 2)))

    import asyncio

    request = SimpleNamespace(skill_ids=["python"])
    out = asyncio.run(PluginDispatcher().resources_suggest(request))
    assert [item["tag"] for item in _rows(out)] == ["any"]

    matched = SimpleNamespace(skill_ids=["sql.indexing"])
    out2 = asyncio.run(PluginDispatcher().resources_suggest(matched))
    assert [item["tag"] for item in _rows(out2)] == ["sql", "any"]


def test_dispatch_exposes_plugin_settings(tmp_path: Path) -> None:
    _reset()
    load_plugin_dir(_plugin(tmp_path, "with-settings", _mw("s", 1)))

    import asyncio

    dispatcher = PluginDispatcher(settings_for=lambda _pid: {"difficulty-bias": "hard"})
    out = asyncio.run(dispatcher.dispatch("resources.suggest", object()))
    assert _rows(out)[0]["settings"] == {"difficulty-bias": "hard"}
    assert current_plugin_settings() == {}


def test_dispatch_isolates_failures(tmp_path: Path) -> None:
    _reset()
    load_plugin_dir(_plugin(tmp_path, "ok-a", _mw("a", 1)))
    load_plugin_dir(_plugin(tmp_path, "raises", _RAISER))
    load_plugin_dir(_plugin(tmp_path, "ok-b", _mw("b", 3)))

    import asyncio

    out = asyncio.run(PluginDispatcher().dispatch("resources.suggest", object()))
    assert [item["tag"] for item in _rows(out)] == ["a", "b"]


def test_dispatch_respects_enabled_predicate(tmp_path: Path) -> None:
    _reset()
    load_plugin_dir(_plugin(tmp_path, "on-plugin", _mw("on", 1)))
    load_plugin_dir(_plugin(tmp_path, "off-plugin", _mw("off", 2)))

    import asyncio

    dispatcher = PluginDispatcher(enabled=lambda pid: pid != "off-plugin")
    out = asyncio.run(dispatcher.dispatch("resources.suggest", object()))
    assert [item["tag"] for item in _rows(out)] == ["on"]


def test_unknown_hook_rejected() -> None:
    _reset()
    import asyncio

    import pytest

    with pytest.raises(ValueError):
        asyncio.run(PluginDispatcher().dispatch("nope.nope", object()))
