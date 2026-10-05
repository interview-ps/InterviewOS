"""Plugin loader — port of `apps/server/src/startup/plugins.ts`.

Scans a plugins directory at server start. Each subdirectory needs a
`skill.yaml` (preferred) or `manifest.json` plus an `index.ts`/`index.js`/
`index.mjs` entry; plugins execute in an isolated child process
(`interview_os.plugins.executor`). Manifests requesting a write permission other
than `evidence.write` are rejected. Every plugin is registered with the
orchestrator; plugin-declared taxonomy nodes register too, and the plugin
interview modes are synced into the core registry at the end.

The manifest reader / entry finder / mode-prompt loader live with the plugin
service (`orchestrator.services.plugin`), which is the one place the Python core
already ports the plugin-SDK loaders; this module reuses them.
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
    _find_entry_file,
    _load_manifest_file,
    _load_plugin_mode_prompts,
)
from ..plugins.executor import (
    IsolatedExecutorDeps,
    IsolatedPluginExecutor,
    PluginDescription,
    create_isolated_executor,
)

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


async def _describe(executor: IsolatedPluginExecutor) -> PluginDescription | None:
    """Best-effort `describe()` — a failure just leaves hooks manifest-declared."""

    try:
        return await executor.describe()
    except Exception:  # noqa: BLE001 - a failed describe degrades, never blocks load
        return None


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
            _record(errors, logger, entry.name, "skill.yaml", str(err))
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
            _record(errors, logger, entry.name, "skill.yaml", str(err))
            continue

        entry_file = _find_entry_file(str(plugin_dir))
        if entry_file is None:
            _record(errors, logger, entry.name, "index.{ts,js,mjs}", "missing entry file")
            continue

        try:
            executor = create_isolated_executor(
                IsolatedExecutorDeps(
                    plugin_dir=str(plugin_dir),
                    entry_file=entry_file,
                    manifest=manifest,
                    logger=logger,
                )
            )
            described = await _describe(executor)
            orchestrator.register_plugin(
                manifest,
                executor,
                PluginRegistrationMeta(
                    dir=str(plugin_dir),
                    entry_file=entry_file,
                    source=source,
                    hooks=described.handlers if described is not None else None,
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
