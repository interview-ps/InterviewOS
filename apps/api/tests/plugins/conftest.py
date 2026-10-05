"""Fixtures for the plugin-host suites (phase 7)."""

from __future__ import annotations

import textwrap
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest

from interview_os.plugins import PluginManager, PluginRegistry


@pytest.fixture(autouse=True)
def clean_registry() -> Iterator[None]:
    """Keep the process-wide registry isolated between tests."""

    PluginRegistry.reset()
    yield
    PluginRegistry.reset()


def _write_plugin(
    root: Path,
    plugin_id: str,
    *,
    main: str,
    kind: str = "tool",
    version: str = "1.0.0",
    extra_yaml: str = "",
    ui_entry: str | None = None,
    entry: str = "main.py",
) -> Path:
    plugin_dir = root / plugin_id
    plugin_dir.mkdir(parents=True, exist_ok=True)
    ui_block = f"ui:\n  entry: {ui_entry}\n" if ui_entry else ""
    (plugin_dir / "plugin.yaml").write_text(
        f"id: {plugin_id}\nversion: {version}\nkind: {kind}\n{ui_block}{extra_yaml}",
        encoding="utf-8",
    )
    entry_path = plugin_dir / entry
    entry_path.parent.mkdir(parents=True, exist_ok=True)
    entry_path.write_text(textwrap.dedent(main), encoding="utf-8")
    return plugin_dir


TOOL_MAIN = """
    def add(a: int, b: int) -> int:
        return a + b

    def setup(ctx):
        ctx.tool("add", add, description="Add two ints")
"""

SKILL_MAIN = """
    def setup(ctx):
        ctx.skills("skills")
"""

HOOK_MAIN = """
    class Middleware:
        async def before_model(self, call):
            return call

    def setup(ctx):
        ctx.middleware(Middleware(), priority=10)
"""


@pytest.fixture
def make_plugin() -> Callable[..., Path]:
    return _write_plugin


@pytest.fixture
def plugins_dir(tmp_path: Path) -> Path:
    directory = tmp_path / "plugins"
    directory.mkdir()
    return directory


@pytest.fixture
def bundled_dir(tmp_path: Path) -> Path:
    directory = tmp_path / "bundled"
    directory.mkdir()
    return directory


@pytest.fixture
def config_path(tmp_path: Path) -> Path:
    return tmp_path / "config.json"


@pytest.fixture
def manager(plugins_dir: Path, config_path: Path, bundled_dir: Path) -> PluginManager:
    return PluginManager(plugins_dir, config_path, bundled_dir=bundled_dir)
