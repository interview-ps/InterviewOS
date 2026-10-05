"""Bootstrap tests (§8): seed the bundled catalog, then load the enabled set."""

from __future__ import annotations

from pathlib import Path

from interview_os.plugins import PluginManager, PluginRegistry, bootstrap_plugins

_MAIN = '''
class Middleware:
    async def resources_suggest(self, req):
        return {"ok": True}


def setup(ctx):
    ctx.middleware(Middleware())
'''


def _bundled(root: Path, plugin_id: str) -> None:
    directory = root / plugin_id
    directory.mkdir(parents=True)
    (directory / "plugin.yaml").write_text(
        f"id: {plugin_id}\nversion: 1.0.0\nkind: hook\nentry: main.py\n", encoding="utf-8"
    )
    (directory / "main.py").write_text(_MAIN, encoding="utf-8")


def test_bootstrap_seeds_and_loads_only_enabled(tmp_path: Path) -> None:
    PluginRegistry.reset()
    bundled = tmp_path / "bundled"
    install = tmp_path / "installed"
    config = tmp_path / "config.json"
    _bundled(bundled, "demo-hook")

    result = bootstrap_plugins(
        plugins_dir=install, config_path=config, bundled_dir=bundled, load=True
    )
    assert (install / "demo-hook" / "plugin.yaml").is_file()
    assert result.loaded == []  # bundled are seeded disabled by default

    manager = PluginManager(install, config, bundled_dir=bundled)
    manager.set_enabled("demo-hook", True)
    reloaded = bootstrap_plugins(
        plugins_dir=install, config_path=config, bundled_dir=bundled, load=True
    )
    assert [loaded.manifest.id for loaded in reloaded.loaded] == ["demo-hook"]
    assert PluginRegistry().get("demo-hook") is not None
