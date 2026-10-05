"""Plugin loader and path safety helpers (§6.2).

Import is in-process (decision D1): `importlib` loads the plugin's entry module
under `ios_plugin_<id>` with the plugin directory on its package search path, so
the plugin's own submodules import relative to it. A failed import (or a
`setup()` that raises) is fully rolled back — nothing is left in `sys.modules`.
"""

from __future__ import annotations

import importlib.util
import logging
import re
import subprocess
import sys
from pathlib import Path

from .context import LoadedPlugin, PluginContext
from .manifest import PluginManifest, PluginManifestError
from .registry import PluginRegistry, register_loaded

__all__ = [
    "PIP_INSTALL_TIMEOUT_S",
    "PluginLoadError",
    "PluginPathError",
    "assert_no_zip_slip",
    "iter_plugin_dirs",
    "load_all",
    "load_plugin_dir",
    "resolve_within",
    "unload_plugin",
]

_log = logging.getLogger(__name__)

#: Upper bound on a `pip install` triggered by a plugin's `requires`.
PIP_INSTALL_TIMEOUT_S = 600

_MODULE_PREFIX = "ios_plugin_"
_DRIVE_RE = re.compile(r"^[a-zA-Z]:")


class PluginLoadError(Exception):
    """A plugin that could not be imported or whose `setup()` raised."""


class PluginPathError(ValueError):
    """A path that escapes its plugin/archive root (zip-slip / traversal)."""


# ------------------------------------------------------------------- path safety


def _unsafe_name(name: str) -> bool:
    if not name or "\x00" in name:
        return True
    cleaned = name.replace("\\", "/")
    if cleaned.startswith("/") or _DRIVE_RE.match(cleaned):
        return True
    return ".." in cleaned.split("/")


def _is_within(base: Path, target: Path) -> bool:
    return target == base or target.is_relative_to(base)


def assert_no_zip_slip(name: str, *, root: Path | None = None) -> None:
    """Reject an archive member that is absolute, drive-qualified or `..`-escaping."""

    if _unsafe_name(name):
        raise PluginPathError(f'archive member "{name[:120]}" escapes the extraction root')
    if root is not None:
        base = Path(root).resolve()
        candidate = (base / name).resolve()
        if not _is_within(base, candidate):
            raise PluginPathError(f'archive member "{name[:120]}" escapes the extraction root')


def resolve_within(base: Path, relative: str, *, must_exist: bool = False) -> Path:
    """Resolve `relative` under `base`, refusing anything that escapes it."""

    if _unsafe_name(relative):
        raise PluginPathError(f'path "{relative[:120]}" escapes the plugin directory')
    resolved_base = Path(base).resolve()
    candidate = (resolved_base / relative).resolve()
    if not _is_within(resolved_base, candidate):
        raise PluginPathError(f'path "{relative[:120]}" escapes the plugin directory')
    if must_exist and not candidate.is_file():
        raise PluginPathError(f'file "{relative[:120]}" does not exist')
    return candidate


# ------------------------------------------------------------------- dir walking


def iter_plugin_dirs(root: Path, *, max_depth: int = 1) -> list[Path]:
    """Directories under `root` (up to `max_depth`) that contain a `plugin.yaml`."""

    base = Path(root)
    if not base.is_dir():
        return []
    found: list[Path] = []

    def walk(directory: Path, depth: int) -> None:
        if depth > max_depth:
            return
        try:
            children = sorted(directory.iterdir(), key=lambda child: child.name)
        except OSError:
            return
        for child in children:
            if not child.is_dir() or child.name.startswith("."):
                continue
            if (child / "plugin.yaml").is_file():
                found.append(child)
            else:
                walk(child, depth + 1)

    walk(base, 1)
    return found


# --------------------------------------------------------------------- loading


def _install_requirements(plugin_dir: Path, manifest: PluginManifest) -> None:
    """`pip install` the plugin's `requires`/`requirements.txt` (argv, no shell)."""

    requirements_file = plugin_dir / "requirements.txt"
    argv = [sys.executable, "-m", "pip", "install", *manifest.requires]
    if requirements_file.is_file():
        argv += ["-r", str(requirements_file)]
    try:
        completed = subprocess.run(
            argv,
            cwd=str(plugin_dir),
            capture_output=True,
            check=False,
            timeout=PIP_INSTALL_TIMEOUT_S,
        )
    except (OSError, subprocess.SubprocessError) as err:
        raise PluginLoadError(
            f'plugin "{manifest.id}": pip install could not run ({type(err).__name__})'
        ) from err
    _log.info(
        "plugin.deps_install plugin=%s exit=%s stdout_bytes=%s stderr_bytes=%s",
        manifest.id,
        completed.returncode,
        len(completed.stdout),
        len(completed.stderr),
    )
    if completed.returncode != 0:
        raise PluginLoadError(
            f'plugin "{manifest.id}": pip install failed '
            f"(exit {completed.returncode}, stderr {len(completed.stderr)} bytes)"
        )


def load_plugin_dir(plugin_dir: Path, *, install_deps: bool = True) -> LoadedPlugin:
    """Load one plugin directory: manifest -> entry -> setup(ctx) -> registry."""

    directory = Path(plugin_dir).resolve()
    try:
        manifest = PluginManifest.load(directory / "plugin.yaml")
    except PluginManifestError as err:
        raise PluginLoadError(str(err)) from err

    entry_path = directory / manifest.entry
    if not entry_path.is_file():
        raise PluginLoadError(f'plugin "{manifest.id}": entry "{manifest.entry}" does not exist')

    if install_deps and (manifest.requires or (directory / "requirements.txt").is_file()):
        _install_requirements(directory, manifest)

    module_name = f"{_MODULE_PREFIX}{manifest.id}"
    spec = importlib.util.spec_from_file_location(
        module_name, entry_path, submodule_search_locations=[str(directory)]
    )
    if spec is None or spec.loader is None:
        raise PluginLoadError(f'plugin "{manifest.id}": could not create an import spec')
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    try:
        spec.loader.exec_module(module)
    except Exception as err:  # noqa: BLE001 - roll the partial import back
        sys.modules.pop(module_name, None)
        raise PluginLoadError(
            f'plugin "{manifest.id}": import failed ({type(err).__name__}: {str(err)[:200]})'
        ) from err

    setup = getattr(module, "setup", None)
    if not callable(setup):
        sys.modules.pop(module_name, None)
        raise PluginLoadError(f'plugin "{manifest.id}": entry must define a callable setup(ctx)')

    ctx = PluginContext(manifest, directory)
    if manifest.ui is not None and not (directory / manifest.ui.entry).is_file():
        ctx.add_diagnostic(
            f'ui entry "{manifest.ui.entry}" is missing — plugin is backend-only'
        )
    try:
        setup(ctx)
    except Exception as err:  # noqa: BLE001 - roll the partial import back
        sys.modules.pop(module_name, None)
        raise PluginLoadError(
            f'plugin "{manifest.id}": setup() raised ({type(err).__name__}: {str(err)[:200]})'
        ) from err

    return register_loaded(ctx)


def load_all(root: Path, *, install_deps: bool = True) -> list[LoadedPlugin]:
    """Load every `*/plugin.yaml` under `root`; log and skip failures (§6.2)."""

    loaded: list[LoadedPlugin] = []
    for plugin_dir in iter_plugin_dirs(root, max_depth=1):
        try:
            loaded.append(load_plugin_dir(plugin_dir, install_deps=install_deps))
        except Exception as err:  # noqa: BLE001 - one bad plugin must not stop the rest
            _log.warning(
                "plugin.load_failed dir=%s error=%s", plugin_dir.name, str(err)[:300]
            )
    return loaded


def unload_plugin(plugin_id: str) -> LoadedPlugin | None:
    """Unregister a plugin and drop its module plus submodules from `sys.modules`."""

    loaded = PluginRegistry().unregister(plugin_id)
    prefix = f"{_MODULE_PREFIX}{plugin_id}"
    for name in [key for key in sys.modules if key == prefix or key.startswith(f"{prefix}.")]:
        sys.modules.pop(name, None)
    return loaded
