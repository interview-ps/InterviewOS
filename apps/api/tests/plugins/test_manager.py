"""`PluginManager` — config, seeding, install, market, skills (§8)."""

from __future__ import annotations

import json
import zipfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from interview_os.plugins import (
    PluginInstallError,
    PluginManager,
    PluginPathError,
    PluginRegistry,
    PluginsConfigError,
    PluginToolError,
)
from interview_os.plugins.manager import _github_raw_url

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
    ctx.middleware(Middleware(), priority=1)
"""


def read_config(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def make_zip(path: Path, entries: dict[str, str]) -> Path:
    with zipfile.ZipFile(path, "w") as archive:
        for name, body in entries.items():
            archive.writestr(name, body)
    return path


# -------------------------------------------------------------------- config


def test_missing_entry_defaults_to_enabled(manager: PluginManager) -> None:
    assert manager.is_enabled("anything") is True


def test_set_enabled_persists_and_merges(
    manager: PluginManager, config_path: Path
) -> None:
    config_path.write_text(
        json.dumps({"plugins": {"other": {"enabled": False}}, "keep": 1}),
        encoding="utf-8",
    )
    manager.set_enabled("demo", False)
    saved = read_config(config_path)
    assert saved["keep"] == 1
    assert saved["plugins"]["other"] == {"enabled": False}
    assert saved["plugins"]["demo"] == {"enabled": False}
    assert manager.is_enabled("demo") is False


def test_corrupt_config_raises_and_is_never_overwritten(
    manager: PluginManager, config_path: Path
) -> None:
    config_path.write_text("{ not json", encoding="utf-8")
    with pytest.raises(PluginsConfigError):
        manager.is_enabled("demo")
    with pytest.raises(PluginsConfigError):
        manager.set_enabled("demo", True)
    with pytest.raises(PluginsConfigError):
        manager.seed_bundled()
    assert config_path.read_text(encoding="utf-8") == "{ not json"


def test_plugins_key_must_be_an_object(manager: PluginManager, config_path: Path) -> None:
    config_path.write_text(json.dumps({"plugins": []}), encoding="utf-8")
    with pytest.raises(PluginsConfigError):
        manager._read_config()


# ---------------------------------------------------------------------- seed


def test_seed_installs_missing_bundled_off(
    manager: PluginManager,
    bundled_dir: Path,
    plugins_dir: Path,
    config_path: Path,
    make_plugin: Callable[..., Path],
) -> None:
    make_plugin(bundled_dir, "demo-toolkit", main=TOOL_MAIN)
    actions = manager.seed_bundled()
    assert [(a.plugin_id, a.kind) for a in actions] == [("demo-toolkit", "installed")]
    assert (plugins_dir / "demo-toolkit" / "plugin.yaml").is_file()
    assert manager.is_enabled("demo-toolkit") is False


def test_seed_honours_uninstalled_ids(
    manager: PluginManager,
    bundled_dir: Path,
    plugins_dir: Path,
    config_path: Path,
    make_plugin: Callable[..., Path],
) -> None:
    make_plugin(bundled_dir, "demo-toolkit", main=TOOL_MAIN)
    config_path.write_text(json.dumps({"uninstalled": ["demo-toolkit"]}), encoding="utf-8")
    actions = manager.seed_bundled()
    assert [a.kind for a in actions] == ["skipped"]
    assert not (plugins_dir / "demo-toolkit").exists()


def test_seed_upgrades_when_catalog_is_newer(
    manager: PluginManager,
    bundled_dir: Path,
    plugins_dir: Path,
    make_plugin: Callable[..., Path],
) -> None:
    make_plugin(bundled_dir, "demo-toolkit", main=TOOL_MAIN, version="1.1.0")
    make_plugin(plugins_dir, "demo-toolkit", main=TOOL_MAIN, version="1.0.0")
    actions = manager.seed_bundled()
    assert [a.kind for a in actions] == ["upgraded"]
    assert "1.1.0" in (plugins_dir / "demo-toolkit" / "plugin.yaml").read_text("utf-8")


def test_seed_keeps_up_to_date_plugins(
    manager: PluginManager,
    bundled_dir: Path,
    plugins_dir: Path,
    make_plugin: Callable[..., Path],
) -> None:
    make_plugin(bundled_dir, "demo-toolkit", main=TOOL_MAIN, version="1.0.0")
    make_plugin(plugins_dir, "demo-toolkit", main=TOOL_MAIN, version="1.0.0")
    assert [a.kind for a in manager.seed_bundled()] == ["kept"]


def test_seed_preserves_a_users_enabled_choice(
    manager: PluginManager,
    bundled_dir: Path,
    plugins_dir: Path,
    config_path: Path,
    make_plugin: Callable[..., Path],
) -> None:
    make_plugin(bundled_dir, "demo-toolkit", main=TOOL_MAIN)
    manager.seed_bundled()
    manager.set_enabled("demo-toolkit", True)
    manager.seed_bundled()
    assert manager.is_enabled("demo-toolkit") is True


# ------------------------------------------------------------- list / load


def test_load_installed_loads_enabled_plugins(
    manager: PluginManager,
    bundled_dir: Path,
    make_plugin: Callable[..., Path],
) -> None:
    make_plugin(bundled_dir, "demo-toolkit", main=TOOL_MAIN)
    manager.seed_bundled()
    assert manager.load_installed(install_deps=False) == []
    manager.set_enabled("demo-toolkit", True)
    loaded = manager.load_installed(install_deps=False)
    assert [plugin.manifest.id for plugin in loaded] == ["demo-toolkit"]

    entry = next(e for e in manager.list_installed() if e["id"] == "demo-toolkit")
    assert entry["enabled"] is True
    assert entry["loaded"] is True
    assert entry["kind"] == "tool"
    assert entry["tools"][0]["name"] == "add"
    assert entry["tools"][0]["enabled"] is True


def test_list_installed_keeps_a_tool_catalogue_for_disabled_plugins(
    manager: PluginManager,
    bundled_dir: Path,
    make_plugin: Callable[..., Path],
) -> None:
    make_plugin(bundled_dir, "demo-toolkit", main=TOOL_MAIN)
    manager.seed_bundled()
    manager.set_enabled("demo-toolkit", True)
    manager.set_enabled("demo-toolkit", False)
    entry = next(e for e in manager.list_installed() if e["id"] == "demo-toolkit")
    assert entry["enabled"] is False
    assert entry["loaded"] is False
    assert entry["tools"][0]["name"] == "add"
    assert entry["tools"][0]["enabled"] is False


def test_list_installed_flags_incompatible_dirs(manager: PluginManager, plugins_dir: Path) -> None:
    legacy = plugins_dir / "legacy-ts-plugin"
    legacy.mkdir()
    (legacy / "skill.yaml").write_text("id: legacy\n", encoding="utf-8")
    entry = next(e for e in manager.list_installed() if e["id"] == "legacy-ts-plugin")
    assert entry["compatible"] is False
    assert entry["kind"] is None


def test_load_missing_loads_only_enabled_unregistered(
    manager: PluginManager,
    bundled_dir: Path,
    make_plugin: Callable[..., Path],
) -> None:
    make_plugin(bundled_dir, "demo-toolkit", main=TOOL_MAIN)
    manager.seed_bundled()
    assert manager.load_missing(install_deps=False) == []
    manager.set_enabled("demo-toolkit", True)
    PluginRegistry().clear()
    loaded = manager.load_missing(install_deps=False)
    assert [plugin.manifest.id for plugin in loaded] == ["demo-toolkit"]


# --------------------------------------------------------------- install


def test_install_path_copies_loads_and_requires_force(
    manager: PluginManager, plugins_dir: Path, tmp_path: Path, make_plugin: Callable[..., Path]
) -> None:
    source = make_plugin(tmp_path / "src", "demo-toolkit", main=TOOL_MAIN)
    loaded = manager.install_path(source)
    assert loaded.manifest.id == "demo-toolkit"
    assert (plugins_dir / "demo-toolkit" / "main.py").is_file()

    with pytest.raises(PluginInstallError):
        manager.install_path(source)
    manager.install_path(source, force=True)


def test_uninstall_remembers_the_id(
    manager: PluginManager,
    bundled_dir: Path,
    plugins_dir: Path,
    config_path: Path,
    make_plugin: Callable[..., Path],
) -> None:
    make_plugin(bundled_dir, "demo-toolkit", main=TOOL_MAIN)
    manager.seed_bundled()
    manager.set_enabled("demo-toolkit", True)

    manager.uninstall("demo-toolkit")
    assert not (plugins_dir / "demo-toolkit").exists()
    assert PluginRegistry().get("demo-toolkit") is None
    assert "demo-toolkit" in read_config(config_path)["uninstalled"]

    actions = manager.seed_bundled()
    assert [a.kind for a in actions] == ["skipped"]


# -------------------------------------------------------------- archives


def test_install_archive_installs_a_single_root(
    manager: PluginManager, plugins_dir: Path, tmp_path: Path
) -> None:
    archive = make_zip(
        tmp_path / "demo.zip",
        {
            "demo-toolkit/plugin.yaml": "id: demo-toolkit\nversion: 1.0.0\nkind: tool\n",
            "demo-toolkit/main.py": TOOL_MAIN,
        },
    )
    loaded = manager.install_archive(archive)
    assert loaded.manifest.id == "demo-toolkit"
    assert (plugins_dir / "demo-toolkit" / "main.py").is_file()


def test_install_archive_rejects_non_zip(manager: PluginManager, tmp_path: Path) -> None:
    bogus = tmp_path / "nope.zip"
    bogus.write_bytes(b"definitely not a zip")
    with pytest.raises(PluginInstallError):
        manager.install_archive(bogus)


def test_install_archive_rejects_zip_slip(manager: PluginManager, tmp_path: Path) -> None:
    archive = make_zip(
        tmp_path / "evil.zip",
        {
            "demo-toolkit/plugin.yaml": "id: demo-toolkit\nversion: 1.0.0\n",
            "../escape.txt": "pwned",
        },
    )
    with pytest.raises(PluginPathError):
        manager.install_archive(archive)


def test_install_archive_requires_exactly_one_root(
    manager: PluginManager, tmp_path: Path
) -> None:
    archive = make_zip(
        tmp_path / "two.zip",
        {
            "a/plugin.yaml": "id: a\nversion: 1.0.0\n",
            "b/plugin.yaml": "id: b\nversion: 1.0.0\n",
        },
    )
    with pytest.raises(PluginInstallError):
        manager.install_archive(archive)


# ------------------------------------------------------------------ urls


def test_install_url_rejects_non_http(manager: PluginManager) -> None:
    with pytest.raises(PluginInstallError):
        manager.install_url("file:///tmp/plugin.zip")


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        (
            "https://github.com/o/r/blob/main/demo.zip",
            "https://github.com/o/r/raw/main/demo.zip",
        ),
        (
            "https://example.com/demo.zip",
            "https://example.com/demo.zip",
        ),
    ],
)
def test_github_blob_urls_are_rewritten(url: str, expected: str) -> None:
    assert _github_raw_url(url) == expected


# ------------------------------------------------------------ ui / market


def test_resolve_ui_file_and_traversal_guard(
    manager: PluginManager, plugins_dir: Path
) -> None:
    plugin_dir = plugins_dir / "demo-ui"
    (plugin_dir / "ui" / "dist").mkdir(parents=True)
    (plugin_dir / "ui" / "dist" / "index.js").write_text("x", encoding="utf-8")

    resolved = manager.resolve_ui_file("demo-ui", "ui/dist/index.js")
    assert resolved.name == "index.js"

    with pytest.raises(PluginPathError):
        manager.resolve_ui_file("demo-ui", "../../secret.txt")
    with pytest.raises(PluginPathError):
        manager.resolve_ui_file("missing-plugin", "ui/dist/index.js")


def test_list_market_and_install_from_market(
    manager: PluginManager,
    bundled_dir: Path,
    plugins_dir: Path,
    make_plugin: Callable[..., Path],
) -> None:
    make_plugin(bundled_dir, "demo-toolkit", main=TOOL_MAIN, version="1.0.0")
    (market,) = manager.list_market()
    assert market["id"] == "demo-toolkit"
    assert market["installed"] is False
    assert market["installed_version"] is None

    loaded = manager.install_from_market("demo-toolkit")
    assert loaded.manifest.id == "demo-toolkit"
    assert manager.is_enabled("demo-toolkit") is True

    (installed,) = manager.list_market()
    assert installed["installed"] is True
    assert installed["installed_version"] == "1.0.0"
    assert installed["update_available"] is False

    (bundled_dir / "demo-toolkit" / "plugin.yaml").write_text(
        "id: demo-toolkit\nversion: 1.1.0\nkind: tool\n", encoding="utf-8"
    )
    (updated,) = manager.list_market()
    assert updated["update_available"] is True


def test_install_from_market_unknown_id_raises(manager: PluginManager) -> None:
    with pytest.raises(PluginInstallError):
        manager.install_from_market("nope")


# ------------------------------------------------------------------ skills


def test_sync_skills_to_workspace(
    manager: PluginManager, tmp_path: Path, make_plugin: Callable[..., Path]
) -> None:
    source = make_plugin(tmp_path / "src", "demo-skill", kind="skill", main=SKILL_MAIN)
    greet = source / "skills" / "greet"
    greet.mkdir(parents=True)
    (greet / "SKILL.md").write_text("# Greet\n", encoding="utf-8")

    manager.install_path(source)
    workspace = tmp_path / "claude-workspace"
    copied = manager.sync_skills_to_workspace(workspace)
    assert copied == ["greet"]
    assert (workspace / "skills" / "greet" / "SKILL.md").is_file()

    # a second sync must not overwrite or re-copy
    assert manager.sync_skills_to_workspace(workspace) == []


# ---------------------------------------------------------------- middleware


def test_manager_middleware_chain_follows_enablement(
    manager: PluginManager, tmp_path: Path, make_plugin: Callable[..., Path]
) -> None:
    source = make_plugin(tmp_path / "src", "demo-hook", kind="hook", main=HOOK_MAIN)
    manager.install_path(source)
    assert len(manager.build_middleware_chain()) == 1
    manager.set_enabled("demo-hook", False)
    assert manager.build_middleware_chain() == []


# ------------------------------------------------------------------- tools


async def test_manager_invoke_tool(
    manager: PluginManager, tmp_path: Path, make_plugin: Callable[..., Path]
) -> None:
    source = make_plugin(tmp_path / "src", "demo-toolkit", main=TOOL_MAIN)
    manager.install_path(source)
    manager.set_enabled("demo-toolkit", True)
    assert await manager.invoke_tool("demo-toolkit", "add", {"a": 1, "b": 2}) == 3
    assert manager.get_tool("demo-toolkit", "add") is not None
    assert await manager.invoke_tool("demo-toolkit", "add", {"a": 2, "b": 3}) == 5

    manager.set_enabled("demo-toolkit", False)
    with pytest.raises(PluginToolError):
        await manager.invoke_tool("demo-toolkit", "add", {"a": 1, "b": 2})


async def test_manager_invoke_unknown_tool(
    manager: PluginManager, tmp_path: Path, make_plugin: Callable[..., Path]
) -> None:
    source = make_plugin(tmp_path / "src", "demo-toolkit", main=TOOL_MAIN)
    manager.install_path(source)
    with pytest.raises(PluginToolError):
        await manager.invoke_tool("demo-toolkit", "missing", {})
