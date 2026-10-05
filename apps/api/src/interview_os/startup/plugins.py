"""Plugin loader — scans a plugins directory and registers each `plugin.yaml`.

Phase 7: the bundled/installed catalog is Python (`plugin.yaml` + `main.py`).
Each plugin's `main.py` is imported in-process and its `setup(ctx)` middleware
is wrapped by `PythonPluginExecutor`, so the migrated `PluginService`/`SkillHost`
can drive it through the same hook path it always used. Manifests requesting a
write permission other than `evidence.write` are rejected; plugin-declared
taxonomy nodes register too, and plugin interview modes sync at the end.
"""

from __future__ import annotations

from pathlib import Path

from ..ai.logger import Logger
from ..core import taxonomy
from ..core.models import is_plugin_writable, is_write_permission
from ..core.taxonomy_seed import TaxonomyNodeSeed
from ..orchestrator import InterviewOrchestrator
from ..orchestrator.services import PluginRegistrationMeta, PluginSource
from ..orchestrator.services.plugin import (
    PluginLoadError,
    _load_manifest_file,
    _load_plugin_mode_prompts,
)
from ..plugins.inproc import PythonPluginExecutor, load_python_plugin

__all__ = ["PluginLoadError", "load_plugins"]


def _record(
    errors: list[PluginLoadError],
    logger: Logger,
    plugin: str,
    file: str,
    error: str,
) -> None:
    """Append a load failure and log it (errors are bounded like manifests)."""

    message = error[:300]
    errors.append(PluginLoadError(dir=plugin, file=file, error=message))
    logger.warn("plugin.load_failed", {"plugin": plugin, "file": file, "error": message})


async def load_plugins(
    plugins_dir: str | Path,
    orchestrator: InterviewOrchestrator,
    logger: Logger,
    source: PluginSource = "bundled",
) -> list[PluginLoadError]:
    """Scan a plugins directory, registering every valid plugin.

    Returns the list of failures as `PluginLoadError` records (`dir`, `file`,
    `error`) for the caller to surface via `set_plugin_load_errors`.
    """

    errors: list[PluginLoadError] = []
    base = Path(plugins_dir)
    try:
        entries = sorted(
            (
                entry
                for entry in base.iterdir()
                if entry.is_dir() and not entry.name.startswith(".")
            ),
            key=lambda entry: entry.name,
        )
    except OSError:
        return errors  # no plugins directory — fine

    for entry in entries:
        plugin_dir = base / entry.name

        try:
            manifest = _load_manifest_file(str(plugin_dir))
        except Exception as err:  # noqa: BLE001 - report and skip this plugin
            _record(errors, logger, entry.name, "plugin.yaml", str(err))
            continue

        write_perm = next(
            (
                permission
                for permission in manifest.permissions
                if is_write_permission(permission) and not is_plugin_writable(permission)
            ),
            None,
        )
        if write_perm is not None:
            _record(
                errors,
                logger,
                entry.name,
                "manifest",
                f'requests write permission "{write_perm.value}" — plugins may only write '
                "evidence, skipped",
            )
            continue

        try:
            loaded_modes = _load_plugin_mode_prompts(str(plugin_dir), manifest)
        except Exception as err:  # noqa: BLE001 - report and skip this plugin
            _record(errors, logger, entry.name, "plugin.yaml", str(err))
            continue

        entry_file = "main.py"
        if not (plugin_dir / entry_file).is_file():
            _record(errors, logger, entry.name, entry_file, "missing entry file")
            continue

        try:
            instance, module = load_python_plugin(plugin_dir, entry_file)
            executor = PythonPluginExecutor(instance, module)
            orchestrator.register_plugin(
                manifest,
                executor,
                PluginRegistrationMeta(
                    dir=str(plugin_dir),
                    entry_file=entry_file,
                    source=source,
                    hooks=list(manifest.hooks or ()),
                    loaded_modes=loaded_modes,
                ),
            )
            # v0.4: plugin-declared taxonomy nodes register at load (idempotent).
            if manifest.taxonomy:
                taxonomy.register_nodes(
                    [
                        TaxonomyNodeSeed(
                            id=node.id, label=node.label, keywords=list(node.keywords)
                        )
                        for node in manifest.taxonomy
                    ]
                )
                for node in manifest.taxonomy:
                    await orchestrator.register_skill_node(node.id)
            logger.info(
                "plugin.loaded",
                {
                    "plugin": manifest.id,
                    "version": manifest.version,
                    "inputs": ",".join(item.key for item in manifest.inputs),
                },
            )
        except Exception as err:  # noqa: BLE001 - report and skip this plugin
            _record(errors, logger, entry.name, entry_file, str(err))

    # v1: sync plugin interview modes into the core registry (enabled plugins).
    await orchestrator.sync_plugin_modes()
    return errors
