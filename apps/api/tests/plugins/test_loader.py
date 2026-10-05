"""Loader + path safety (§6.2)."""

from __future__ import annotations

import sys
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest

from interview_os.plugins import (
    PluginLoadError,
    PluginPathError,
    PluginRegistry,
    assert_no_zip_slip,
    iter_plugin_dirs,
    load_all,
    load_plugin_dir,
    resolve_within,
    unload_plugin,
)

TOOL_MAIN = """
def add(a: int, b: int) -> int:
    return a + b


def setup(ctx):
    ctx.tool("add", add, description="Add two ints")
"""

BAD_SETUP_MAIN = """
def setup(ctx):
    raise RuntimeError("boom")
"""

NO_SETUP_MAIN = "VALUE = 1\n"


@pytest.fixture(autouse=True)
def clean_modules() -> Iterator[None]:
    yield
    for name in [key for key in sys.modules if key.startswith("ios_plugin_")]:
        sys.modules.pop(name, None)


def test_load_tool_plugin_registers_and_imports(
    tmp_path: Path, make_plugin: Callable[..., Path]
) -> None:
    plugin_dir = make_plugin(tmp_path, "demo-toolkit", main=TOOL_MAIN)
    loaded = load_plugin_dir(plugin_dir, install_deps=False)

    assert loaded.manifest.id == "demo-toolkit"
    assert [tool.name for tool in loaded.tools] == ["add"]
    assert PluginRegistry().get("demo-toolkit") is loaded
    assert "ios_plugin_demo-toolkit" in sys.modules
    assert loaded.tools[0].fn(1, 2) == 3


def test_unload_drops_registry_and_module(
    tmp_path: Path, make_plugin: Callable[..., Path]
) -> None:
    plugin_dir = make_plugin(tmp_path, "demo-toolkit", main=TOOL_MAIN)
    load_plugin_dir(plugin_dir, install_deps=False)

    unloaded = unload_plugin("demo-toolkit")
    assert unloaded is not None
    assert PluginRegistry().get("demo-toolkit") is None
    assert "ios_plugin_demo-toolkit" not in sys.modules
    assert unload_plugin("demo-toolkit") is None


def test_setup_raising_is_cleaned_up(
    tmp_path: Path, make_plugin: Callable[..., Path]
) -> None:
    plugin_dir = make_plugin(tmp_path, "broken", main=BAD_SETUP_MAIN)
    with pytest.raises(PluginLoadError):
        load_plugin_dir(plugin_dir, install_deps=False)
    assert PluginRegistry().get("broken") is None
    assert "ios_plugin_broken" not in sys.modules


def test_missing_entry_is_rejected(tmp_path: Path, make_plugin: Callable[..., Path]) -> None:
    plugin_dir = make_plugin(tmp_path, "demo", main=TOOL_MAIN, entry="other.py")
    with pytest.raises(PluginLoadError):
        load_plugin_dir(plugin_dir, install_deps=False)


def test_entry_without_setup_is_rejected(
    tmp_path: Path, make_plugin: Callable[..., Path]
) -> None:
    plugin_dir = make_plugin(tmp_path, "demo", main=NO_SETUP_MAIN)
    with pytest.raises(PluginLoadError):
        load_plugin_dir(plugin_dir, install_deps=False)
    assert "ios_plugin_demo" not in sys.modules


def test_missing_manifest_is_rejected(tmp_path: Path) -> None:
    directory = tmp_path / "no-manifest"
    directory.mkdir()
    with pytest.raises(PluginLoadError):
        load_plugin_dir(directory, install_deps=False)


def test_load_all_skips_failures(tmp_path: Path, make_plugin: Callable[..., Path]) -> None:
    root = tmp_path / "root"
    make_plugin(root, "good", main=TOOL_MAIN)
    make_plugin(root, "bad", main=BAD_SETUP_MAIN)

    loaded = load_all(root, install_deps=False)
    assert [plugin.manifest.id for plugin in loaded] == ["good"]


def test_iter_plugin_dirs_respects_depth(tmp_path: Path) -> None:
    top = tmp_path / "top"
    nested = tmp_path / "demos" / "demo"
    top.mkdir()
    nested.mkdir(parents=True)
    (top / "plugin.yaml").write_text("id: top\nversion: 1.0.0\n", encoding="utf-8")
    (nested / "plugin.yaml").write_text("id: demo\nversion: 1.0.0\n", encoding="utf-8")

    assert iter_plugin_dirs(tmp_path, max_depth=1) == [top]
    assert iter_plugin_dirs(tmp_path, max_depth=2) == [nested, top]
    assert iter_plugin_dirs(tmp_path / "missing") == []


@pytest.mark.parametrize("name", ["../evil.py", "/etc/passwd", "C:/windows", "a/../../b"])
def test_assert_no_zip_slip_rejects_escapes(name: str) -> None:
    with pytest.raises(PluginPathError):
        assert_no_zip_slip(name)


def test_assert_no_zip_slip_allows_relative_members() -> None:
    assert_no_zip_slip("demo-toolkit/plugin.yaml")
    assert_no_zip_slip("demo-toolkit/ui/dist/index.js")


def test_assert_no_zip_slip_checks_the_root(tmp_path: Path) -> None:
    with pytest.raises(PluginPathError):
        assert_no_zip_slip("../escape.txt", root=tmp_path)


def test_resolve_within_stays_inside(tmp_path: Path) -> None:
    (tmp_path / "ui").mkdir()
    (tmp_path / "ui" / "index.js").write_text("x", encoding="utf-8")
    resolved = resolve_within(tmp_path, "ui/index.js", must_exist=True)
    assert resolved == (tmp_path / "ui" / "index.js").resolve()


@pytest.mark.parametrize("relative", ["../secret", "a/../../secret", "/etc/passwd"])
def test_resolve_within_rejects_escapes(tmp_path: Path, relative: str) -> None:
    with pytest.raises(PluginPathError):
        resolve_within(tmp_path, relative)


def test_resolve_within_must_exist(tmp_path: Path) -> None:
    with pytest.raises(PluginPathError):
        resolve_within(tmp_path, "nope.txt", must_exist=True)
    assert resolve_within(tmp_path, "nope.txt") == (tmp_path / "nope.txt").resolve()
