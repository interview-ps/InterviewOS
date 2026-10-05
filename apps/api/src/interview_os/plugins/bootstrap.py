"""Plugin bootstrap — seed bundled plugins, then load the enabled set (§8).

Called once at app startup (and by tests): reseed the install dir from the
bundled catalog, then load every enabled plugin into the registry.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .context import LoadedPlugin
from .manager import PluginManager
from .registry import PluginRegistry

__all__ = ["BootstrapResult", "bootstrap_plugins"]


@dataclass(frozen=True, slots=True)
class BootstrapResult:
    """The manager plus the plugins that were loaded at startup."""

    manager: PluginManager
    loaded: list[LoadedPlugin]


def bootstrap_plugins(
    *,
    plugins_dir: Path,
    config_path: Path,
    bundled_dir: Path | None = None,
    load: bool = True,
    install_deps: bool = False,
) -> BootstrapResult:
    """Reset the registry, seed the bundled catalog, and load enabled plugins."""

    PluginRegistry.reset()
    manager = PluginManager(plugins_dir, config_path, bundled_dir=bundled_dir)
    manager.seed_bundled()
    loaded: list[LoadedPlugin] = []
    if load:
        loaded = manager.load_installed(install_deps=install_deps)
    return BootstrapResult(manager=manager, loaded=loaded)
