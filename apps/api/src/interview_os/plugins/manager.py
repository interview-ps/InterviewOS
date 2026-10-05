"""`PluginManager` — install/lifecycle/enablement over the plugin registry (§8).

Config lives in `data/config.json` as `{"plugins": {"<id>": {"enabled": bool,
"tools": {...}}}}`. A missing entry means **enabled** (Octop semantics); bundled
plugins are seeded `enabled: false`. Writes merge into the existing JSON
atomically, and a corrupt config raises a typed error instead of being
overwritten (Octop issue #730 fix).
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import tempfile
import zipfile
from collections.abc import Mapping
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit
from urllib.request import urlopen

from ..paths import DEFAULT_PLUGINS_DIR
from .context import LoadedPlugin
from .loader import (
    PluginLoadError,
    PluginPathError,
    assert_no_zip_slip,
    iter_plugin_dirs,
    load_plugin_dir,
    resolve_within,
    unload_plugin,
)
from .manifest import PluginManifest, PluginManifestError, version_gt
from .registry import PluginRegistry
from .seed import SeedAction, seed_bundled_plugins
from .tools import (
    PluginTool,
    _tool_enabled,
    build_plugin_tools,
    describe_tools,
    tool_config_for,
)

__all__ = [
    "DEFAULT_MARKET_GROUPS",
    "PluginInstallError",
    "PluginManager",
    "PluginToolError",
    "PluginsConfigError",
]

_log = logging.getLogger(__name__)

#: Interview OS catalog group slugs; unknown values pass through (§8.3).
DEFAULT_MARKET_GROUPS: tuple[str, ...] = (
    "modes",
    "practice",
    "resources",
    "analytics",
    "tools",
    "ops",
)

_URL_TIMEOUT_S = 60
_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
_ZIP_MAGICS = (b"PK\x03\x04", b"PK\x05\x06")


class PluginsConfigError(Exception):
    """`data/config.json` is unreadable or malformed — it is never overwritten."""


class PluginInstallError(Exception):
    """An install/uninstall request that cannot be honoured."""


class PluginToolError(Exception):
    """A plugin tool that is unknown, disabled, or missing its plugin."""


def _github_raw_url(url: str) -> str:
    """Rewrite a GitHub `…/blob/…` URL to its raw download URL; else pass through."""

    parts = urlsplit(url)
    host = parts.netloc.lower()
    if host in ("github.com", "www.github.com") and "/blob/" in parts.path:
        path = parts.path.replace("/blob/", "/raw/", 1)
        return urlunsplit((parts.scheme, parts.netloc, path, parts.query, parts.fragment))
    return url


def _as_mapping(value: object) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


class PluginManager:
    """Owns `data/plugins/` on disk, the plugin registry, and the config file."""

    def __init__(
        self,
        plugins_dir: Path,
        config_path: Path,
        *,
        bundled_dir: Path | None = None,
    ) -> None:
        self._plugins_dir = Path(plugins_dir)
        self._config_path = Path(config_path)
        self._bundled_dir = Path(bundled_dir) if bundled_dir is not None else DEFAULT_PLUGINS_DIR
        self._tool_catalog: dict[str, list[dict[str, Any]]] = {}

    # ------------------------------------------------------------------- config

    def _read_config(self) -> dict[str, Any]:
        path = self._config_path
        if not path.exists():
            return {}
        try:
            raw = json.loads(path.read_text(encoding="utf-8") or "{}")
        except (OSError, ValueError) as err:
            raise PluginsConfigError(f'plugin config "{path.name}" is not valid JSON') from err
        if not isinstance(raw, dict):
            raise PluginsConfigError(f'plugin config "{path.name}" must be a JSON object')
        plugins = raw.get("plugins")
        if plugins is not None and not isinstance(plugins, dict):
            raise PluginsConfigError(f'plugin config "{path.name}": "plugins" must be an object')
        return raw

    def _write_config(self, config: dict[str, Any]) -> None:
        path = self._config_path
        path.parent.mkdir(parents=True, exist_ok=True)
        handle_fd, tmp_name = tempfile.mkstemp(
            prefix=f"{path.name}.", suffix=".tmp", dir=str(path.parent)
        )
        try:
            with os.fdopen(handle_fd, "w", encoding="utf-8") as handle:
                json.dump(config, handle, ensure_ascii=False, indent=2, sort_keys=True)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp_name, path)
        except BaseException:
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
            raise

    @staticmethod
    def _plugin_enabled(config: Mapping[str, Any], plugin_id: str) -> bool:
        entry = _as_mapping(_as_mapping(config.get("plugins")).get(plugin_id))
        if not entry:
            return True
        return entry.get("enabled") is not False

    @staticmethod
    def _tools_config(config: Mapping[str, Any], plugin_id: str) -> Mapping[str, Any]:
        plugins = _as_mapping(config.get("plugins"))
        entry = _as_mapping(plugins.get(plugin_id))
        return _as_mapping(entry.get("tools"))

    @staticmethod
    def _uninstalled_ids(config: Mapping[str, Any]) -> list[str]:
        raw = config.get("uninstalled")
        if not isinstance(raw, list):
            return []
        return [str(item) for item in raw]

    def is_enabled(self, plugin_id: str) -> bool:
        return self._plugin_enabled(self._read_config(), plugin_id)

    def set_enabled(self, plugin_id: str, enabled: bool) -> None:
        """Persist the flag, then load or unload the plugin."""

        config = self._read_config()
        plugins = dict(_as_mapping(config.get("plugins")))
        entry = dict(_as_mapping(plugins.get(plugin_id)))
        entry["enabled"] = bool(enabled)
        plugins[plugin_id] = entry
        config["plugins"] = plugins
        if enabled:
            remaining = [pid for pid in self._uninstalled_ids(config) if pid != plugin_id]
            config["uninstalled"] = remaining
        self._write_config(config)
        if enabled:
            self._load_and_cache(self._plugins_dir / plugin_id)
        else:
            unload_plugin(plugin_id)

    def _clear_uninstalled(self, plugin_id: str) -> None:
        config = self._read_config()
        current = self._uninstalled_ids(config)
        if plugin_id not in current:
            return
        config["uninstalled"] = [pid for pid in current if pid != plugin_id]
        self._write_config(config)

    # ------------------------------------------------------------------ loading

    def _cache_tools(self, loaded: LoadedPlugin) -> None:
        self._tool_catalog[loaded.manifest.id] = [
            {
                "name": registration.name,
                "description": registration.description,
                "configFields": list(registration.config_fields),
            }
            for registration in loaded.tools
        ]

    def _load_and_cache(self, plugin_dir: Path, *, install_deps: bool = True) -> LoadedPlugin:
        loaded = load_plugin_dir(plugin_dir, install_deps=install_deps)
        self._cache_tools(loaded)
        return loaded

    def load_installed(self, *, install_deps: bool = True) -> list[LoadedPlugin]:
        """Clear the registry, then load enabled plugins and skip disabled ones."""

        registry = PluginRegistry()
        for loaded in registry.list_plugins():
            unload_plugin(loaded.manifest.id)
        registry.clear()

        config = self._read_config()
        loaded_plugins: list[LoadedPlugin] = []
        for plugin_dir in iter_plugin_dirs(self._plugins_dir, max_depth=1):
            manifest = self._safe_manifest(plugin_dir)
            if manifest is None or not self._plugin_enabled(config, manifest.id):
                continue
            try:
                loaded_plugins.append(self._load_and_cache(plugin_dir, install_deps=install_deps))
            except PluginLoadError as err:
                _log.warning("plugin.load_failed dir=%s error=%s", plugin_dir.name, str(err)[:300])
        return loaded_plugins

    def load_missing(self, *, install_deps: bool = True) -> list[LoadedPlugin]:
        """Load on-disk, enabled plugins that are not yet registered."""

        registry = PluginRegistry()
        registered = {loaded.manifest.id for loaded in registry.list_plugins()}
        config = self._read_config()
        loaded_plugins: list[LoadedPlugin] = []
        for plugin_dir in iter_plugin_dirs(self._plugins_dir, max_depth=1):
            manifest = self._safe_manifest(plugin_dir)
            if manifest is None or manifest.id in registered:
                continue
            if not self._plugin_enabled(config, manifest.id):
                continue
            try:
                loaded_plugins.append(self._load_and_cache(plugin_dir, install_deps=install_deps))
            except PluginLoadError as err:
                _log.warning("plugin.load_failed dir=%s error=%s", plugin_dir.name, str(err)[:300])
        return loaded_plugins

    # -------------------------------------------------------------------- lists

    def _installed_versions(self) -> dict[str, str]:
        versions: dict[str, str] = {}
        for plugin_dir in iter_plugin_dirs(self._plugins_dir, max_depth=1):
            manifest = self._safe_manifest(plugin_dir)
            if manifest is not None:
                versions[manifest.id] = manifest.version
        return versions

    def _safe_manifest(self, plugin_dir: Path) -> PluginManifest | None:
        try:
            return PluginManifest.load(plugin_dir / "plugin.yaml")
        except PluginManifestError:
            return None

    def _iter_installed_dirs(self) -> list[Path]:
        if not self._plugins_dir.is_dir():
            return []
        try:
            return sorted(
                (
                    child
                    for child in self._plugins_dir.iterdir()
                    if child.is_dir() and not child.name.startswith(".")
                ),
                key=lambda child: child.name,
            )
        except OSError:
            return []

    def _catalogue_from_cache(
        self, plugin_id: str, *, enabled: bool, tools_config: Mapping[str, Any]
    ) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        for cached in self._tool_catalog.get(plugin_id, []):
            name = str(cached.get("name", ""))
            items.append(
                {
                    "name": name,
                    "description": str(cached.get("description", "")),
                    "enabled": _tool_enabled(
                        plugin_id, name, global_enabled=enabled, config=tools_config
                    ),
                    "configFields": list(cached.get("configFields", [])),
                    "config": tool_config_for(tools_config, name),
                }
            )
        return items

    def _describe_installed(
        self,
        manifest: PluginManifest,
        plugin_dir: Path,
        config: Mapping[str, Any],
        registry: PluginRegistry,
    ) -> dict[str, Any]:
        enabled = self._plugin_enabled(config, manifest.id)
        tools_config = self._tools_config(config, manifest.id)
        loaded = registry.get(manifest.id)
        tools = (
            describe_tools(loaded, global_enabled=enabled, config=tools_config)
            if loaded is not None
            else self._catalogue_from_cache(manifest.id, enabled=enabled, tools_config=tools_config)
        )
        return {
            "id": manifest.id,
            "version": manifest.version,
            "name": manifest.name,
            "kind": manifest.kind,
            "description": manifest.description,
            "icon": manifest.icon,
            "group": manifest.group,
            "requires": list(manifest.requires),
            "path": str(plugin_dir),
            "loaded": loaded is not None,
            "enabled": enabled,
            "compatible": True,
            "ui": manifest.ui.model_dump() if manifest.ui is not None else None,
            "tools": tools,
        }

    @staticmethod
    def _incompatible_entry(plugin_dir: Path, reason: str) -> dict[str, Any]:
        return {
            "id": plugin_dir.name,
            "version": None,
            "name": plugin_dir.name,
            "kind": None,
            "description": "",
            "icon": None,
            "group": None,
            "requires": [],
            "path": str(plugin_dir),
            "loaded": False,
            "enabled": False,
            "compatible": False,
            "ui": None,
            "tools": [],
            "reason": reason,
        }

    def list_installed(self) -> list[dict[str, Any]]:
        config = self._read_config()
        registry = PluginRegistry()
        entries: list[dict[str, Any]] = []
        for plugin_dir in self._iter_installed_dirs():
            if not (plugin_dir / "plugin.yaml").is_file():
                entries.append(
                    self._incompatible_entry(
                        plugin_dir, "missing plugin.yaml — see the migration guide"
                    )
                )
                continue
            manifest = self._safe_manifest(plugin_dir)
            if manifest is None:
                entries.append(
                    self._incompatible_entry(plugin_dir, "plugin.yaml is invalid")
                )
                continue
            entries.append(self._describe_installed(manifest, plugin_dir, config, registry))
        entries.sort(key=lambda entry: str(entry["id"]))
        return entries

    def list_market(self) -> list[dict[str, Any]]:
        installed = {entry["id"]: entry for entry in self.list_installed()}
        entries: list[dict[str, Any]] = []
        for plugin_dir in iter_plugin_dirs(self._bundled_dir, max_depth=2):
            manifest = self._safe_manifest(plugin_dir)
            if manifest is None:
                continue
            info = installed.get(manifest.id)
            is_installed = info is not None and bool(info.get("compatible", True))
            installed_version = info.get("version") if info is not None else None
            entries.append(
                {
                    "id": manifest.id,
                    "version": manifest.version,
                    "name": manifest.name,
                    "kind": manifest.kind,
                    "description": manifest.description,
                    "icon": manifest.icon,
                    "group": manifest.group,
                    "requires": list(manifest.requires),
                    "path": str(plugin_dir),
                    "installed": is_installed,
                    "installed_version": (
                        installed_version if isinstance(installed_version, str) else None
                    ),
                    "update_available": bool(
                        is_installed
                        and version_gt(
                            manifest.version,
                            installed_version if isinstance(installed_version, str) else None,
                        )
                    ),
                    "ui": manifest.ui.model_dump() if manifest.ui is not None else None,
                }
            )
        entries.sort(key=lambda entry: str(entry["id"]))
        return entries

    # ------------------------------------------------------------------- market

    def _market_dir(self, plugin_id: str) -> Path | None:
        for plugin_dir in iter_plugin_dirs(self._bundled_dir, max_depth=2):
            manifest = self._safe_manifest(plugin_dir)
            if manifest is not None and manifest.id == plugin_id:
                return plugin_dir
        return None

    def install_from_market(self, plugin_id: str, *, force: bool = False) -> LoadedPlugin:
        source = self._market_dir(plugin_id)
        if source is None:
            raise PluginInstallError(f'plugin "{plugin_id}" is not in the bundled catalog')
        loaded = self.install_path(source, force=force)
        self.set_enabled(plugin_id, True)
        return loaded

    # ------------------------------------------------------------------ install

    def install_path(self, source: Path, *, force: bool = False) -> LoadedPlugin:
        """Validate and copy a plugin directory into `data/plugins/<id>`, then load it."""

        src = Path(source).resolve()
        try:
            manifest = PluginManifest.load(src / "plugin.yaml")
        except PluginManifestError as err:
            raise PluginInstallError(str(err)) from err
        dest = self._plugins_dir / manifest.id
        if dest.exists():
            if not force:
                raise PluginInstallError(
                    f'plugin "{manifest.id}" is already installed (pass force to replace)'
                )
            shutil.rmtree(dest)
        self._plugins_dir.mkdir(parents=True, exist_ok=True)
        shutil.copytree(src, dest)
        self._clear_uninstalled(manifest.id)
        return self._load_and_cache(dest, install_deps=True)

    def _single_plugin_root(self, root: Path) -> Path:
        candidates = sorted({path.parent for path in root.rglob("plugin.yaml")})
        if len(candidates) != 1:
            raise PluginInstallError(
                "archive must contain exactly one plugin "
                f"(found {len(candidates)} plugin.yaml files)"
            )
        return candidates[0]

    def install_archive(self, archive: Path, *, force: bool = False) -> LoadedPlugin:
        """Install a plugin from a ZIP: magic check, zip-slip check, one plugin root."""

        archive_path = Path(archive)
        try:
            with archive_path.open("rb") as handle:
                magic = handle.read(4)
        except OSError as err:
            raise PluginInstallError(f'cannot read archive "{archive_path.name}"') from err
        if not any(magic.startswith(prefix) for prefix in _ZIP_MAGICS):
            raise PluginInstallError("not a ZIP archive")
        with tempfile.TemporaryDirectory(prefix="ios-plugin-") as tmp:
            try:
                with zipfile.ZipFile(archive_path) as zf:
                    for info in zf.infolist():
                        if info.is_dir():
                            continue
                        assert_no_zip_slip(info.filename)
                    zf.extractall(tmp)
            except zipfile.BadZipFile as err:
                raise PluginInstallError("archive is not a readable ZIP file") from err
            root = self._single_plugin_root(Path(tmp))
            return self.install_path(root, force=force)

    def install_url(self, url: str, *, force: bool = False) -> LoadedPlugin:
        """Download an http(s) ZIP (GitHub `blob`->`raw`) and install it."""

        target = _github_raw_url(url)
        if urlsplit(target).scheme not in ("http", "https"):
            raise PluginInstallError("only http(s) URLs are supported")
        handle_fd, tmp_name = tempfile.mkstemp(suffix=".zip")
        try:
            with os.fdopen(handle_fd, "wb") as handle:
                with urlopen(target, timeout=_URL_TIMEOUT_S) as response:  # noqa: S310 - http(s) only
                    total = 0
                    while True:
                        chunk = response.read(65536)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > _MAX_ARCHIVE_BYTES:
                            raise PluginInstallError("archive exceeds the size limit")
                        handle.write(chunk)
            return self.install_archive(Path(tmp_name), force=force)
        except OSError as err:
            raise PluginInstallError(f"download failed ({type(err).__name__})") from err
        finally:
            try:
                os.unlink(tmp_name)
            except OSError:
                pass

    def uninstall(self, plugin_id: str) -> None:
        """Unload, drop the catalogue, delete the directory, remember the id."""

        unload_plugin(plugin_id)
        dest = self._plugins_dir / plugin_id
        if dest.is_dir():
            shutil.rmtree(dest)
        self._tool_catalog.pop(plugin_id, None)
        config = self._read_config()
        plugins = dict(_as_mapping(config.get("plugins")))
        plugins.pop(plugin_id, None)
        config["plugins"] = plugins
        uninstalled = self._uninstalled_ids(config)
        if plugin_id not in uninstalled:
            uninstalled.append(plugin_id)
        config["uninstalled"] = uninstalled
        self._write_config(config)

    # --------------------------------------------------------------------- seed

    def seed_bundled(self, *, force: bool = False) -> list[SeedAction]:
        """Copy missing bundled plugins (off by default) and upgrade stale ones."""

        config = self._read_config()
        actions = seed_bundled_plugins(
            bundled_dir=self._bundled_dir,
            install_dir=self._plugins_dir,
            uninstalled=self._uninstalled_ids(config),
            installed_versions=self._installed_versions(),
            force=force,
        )
        plugins = dict(_as_mapping(config.get("plugins")))
        changed = False
        for action in actions:
            if action.kind in ("installed", "upgraded"):
                entry = dict(_as_mapping(plugins.get(action.plugin_id)))
                if action.kind == "installed":
                    entry.setdefault("enabled", False)
                plugins[action.plugin_id] = entry
                changed = True
        if changed:
            config["plugins"] = plugins
            self._write_config(config)
        return actions

    # ---------------------------------------------------------------- ui / skills

    def resolve_ui_file(self, plugin_id: str, relative: str) -> Path:
        """Resolve a UI asset under an installed plugin directory (traversal-checked)."""

        plugin_dir = resolve_within(self._plugins_dir, plugin_id, must_exist=False)
        if not plugin_dir.is_dir():
            raise PluginPathError(f'plugin "{plugin_id}" is not installed')
        return resolve_within(plugin_dir, relative, must_exist=True)

    def resolve_market_ui_file(self, plugin_id: str, relative: str) -> Path:
        """Resolve a market (bundled) UI asset — used for catalog icons only."""

        source = self._market_dir(plugin_id)
        if source is None:
            raise PluginPathError(f'plugin "{plugin_id}" is not in the bundled catalog')
        return resolve_within(source, relative, must_exist=True)

    def sync_skills_to_workspace(self, workspace: Path) -> list[str]:
        """Copy each loaded plugin's skills into `<workspace>/skills/`, skipping existing."""

        dest_root = Path(workspace) / "skills"
        copied: list[str] = []
        for loaded in PluginRegistry().list_plugins():
            skills_dir = loaded.skills_dir
            if skills_dir is None or not skills_dir.is_dir():
                continue
            for skill_dir in sorted(skills_dir.iterdir(), key=lambda path: path.name):
                if not skill_dir.is_dir():
                    continue
                dest = dest_root / skill_dir.name
                if dest.exists():
                    continue
                dest_root.mkdir(parents=True, exist_ok=True)
                shutil.copytree(skill_dir, dest)
                copied.append(skill_dir.name)
        return copied

    # -------------------------------------------------------------------- tools

    def tools(self, plugin_id: str) -> list[PluginTool]:
        """The enabled, `validate_call`-wrapped tools of a loaded plugin."""

        loaded = PluginRegistry().get(plugin_id)
        if loaded is None:
            return []
        config = self._read_config()
        enabled = self._plugin_enabled(config, plugin_id)
        return build_plugin_tools(
            loaded, global_enabled=enabled, config=self._tools_config(config, plugin_id)
        )

    def get_tool(self, plugin_id: str, name: str) -> PluginTool | None:
        return next((tool for tool in self.tools(plugin_id) if tool.name == name), None)

    async def invoke_tool(
        self, plugin_id: str, name: str, args: Mapping[str, Any] | None = None
    ) -> object:
        """Invoke an enabled plugin tool by id/name (orchestrator/UI entry point, §7.1)."""

        if PluginRegistry().get(plugin_id) is None:
            raise PluginToolError(f'plugin "{plugin_id}" is not loaded')
        tool = self.get_tool(plugin_id, name)
        if tool is None:
            raise PluginToolError(f'tool "{name}" is not enabled for plugin "{plugin_id}"')
        return await tool.invoke(args)

    def build_middleware_chain(self) -> list[object]:
        """The ordered middleware chain of every enabled plugin (§7.3)."""

        config = self._read_config()
        return PluginRegistry().build_middleware_chain(
            global_enabled=lambda plugin_id: self._plugin_enabled(config, plugin_id)
        )
