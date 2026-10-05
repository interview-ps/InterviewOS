"""Seeding the bundled plugin catalog into the install dir (§8.2).

Bundled plugins ship with the repo; seeding copies the missing ones into
`data/plugins/` (globally off — `enabled: false`), upgrades an installed copy
when the catalog version is newer, and never re-copies a plugin the user
uninstalled.
"""

from __future__ import annotations

import shutil
from collections.abc import Collection, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from .loader import iter_plugin_dirs
from .manifest import PluginManifest, PluginManifestError, version_gt

__all__ = [
    "SeedAction",
    "SeedKind",
    "seed_bundled_plugins",
]

SeedKind = Literal["installed", "upgraded", "kept", "skipped"]


@dataclass(frozen=True, slots=True)
class SeedAction:
    """What seeding did (or refused to do) for one bundled plugin."""

    plugin_id: str
    kind: SeedKind
    version: str


def _copy(source: Path, dest: Path) -> None:
    if dest.exists():
        shutil.rmtree(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, dest)


def seed_bundled_plugins(
    *,
    bundled_dir: Path,
    install_dir: Path,
    uninstalled: Collection[str] = (),
    installed_versions: Mapping[str, str] | None = None,
    force: bool = False,
) -> list[SeedAction]:
    """Copy/upgrade bundled plugins; return one `SeedAction` per catalog plugin."""

    versions = installed_versions or {}
    uninstalled_ids = set(uninstalled)
    actions: list[SeedAction] = []
    for source in iter_plugin_dirs(Path(bundled_dir), max_depth=2):
        try:
            manifest = PluginManifest.load(source / "plugin.yaml")
        except PluginManifestError:
            continue
        plugin_id = manifest.id
        if plugin_id in uninstalled_ids:
            actions.append(SeedAction(plugin_id, "skipped", manifest.version))
            continue
        dest = Path(install_dir) / plugin_id
        if not dest.exists():
            _copy(source, dest)
            actions.append(SeedAction(plugin_id, "installed", manifest.version))
            continue
        if force or version_gt(manifest.version, versions.get(plugin_id)):
            _copy(source, dest)
            actions.append(SeedAction(plugin_id, "upgraded", manifest.version))
        else:
            actions.append(SeedAction(plugin_id, "kept", manifest.version))
    actions.sort(key=lambda action: action.plugin_id)
    return actions
