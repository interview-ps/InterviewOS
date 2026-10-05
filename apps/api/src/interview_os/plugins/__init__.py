"""Plugin system (phase 7) — the in-process Octop-model host.

Public surface:
- `manifest` — `PluginManifest`, `PluginUI`, `PluginManifestError`, version helpers
- `context` — `PluginContext`, `StateReader`, `LoadedPlugin`, registrations
- `registry` — the process-wide `PluginRegistry`, `register_loaded`
- `loader` — `load_plugin_dir`, `load_all`, `unload_plugin`, path-safety helpers
- `tools` — `build_plugin_tools`, `get_tool_config`, enablement
- `manager` — `PluginManager` (install/lifecycle/config), typed errors
- `seed` — bundled-catalog seeding
"""

from .bootstrap import BootstrapResult, bootstrap_plugins
from .context import (
    LoadedPlugin,
    MiddlewareRegistration,
    PluginContext,
    StateReader,
    ToolRegistration,
)
from .dispatch import HOOK_METHODS, PluginDispatcher, current_plugin_settings
from .loader import (
    PIP_INSTALL_TIMEOUT_S,
    PluginLoadError,
    PluginPathError,
    assert_no_zip_slip,
    iter_plugin_dirs,
    load_all,
    load_plugin_dir,
    resolve_within,
    unload_plugin,
)
from .manager import (
    DEFAULT_MARKET_GROUPS,
    PluginInstallError,
    PluginManager,
    PluginsConfigError,
    PluginToolError,
)
from .manifest import (
    PluginKind,
    PluginManifest,
    PluginManifestError,
    PluginUI,
    version_gt,
    version_key,
)
from .registry import (
    EnabledPredicate,
    GlobalEnabled,
    PluginRegistry,
    register_loaded,
)
from .seed import SeedAction, SeedKind, seed_bundled_plugins
from .tools import (
    PluginTool,
    build_args_model,
    build_plugin_tools,
    describe_tools,
    get_tool_config,
    tool_config_for,
)

__all__ = [
    "DEFAULT_MARKET_GROUPS",
    "HOOK_METHODS",
    "PIP_INSTALL_TIMEOUT_S",
    "BootstrapResult",
    "EnabledPredicate",
    "GlobalEnabled",
    "LoadedPlugin",
    "MiddlewareRegistration",
    "PluginContext",
    "PluginDispatcher",
    "PluginInstallError",
    "PluginKind",
    "PluginLoadError",
    "PluginManager",
    "PluginManifest",
    "PluginManifestError",
    "PluginPathError",
    "PluginRegistry",
    "PluginTool",
    "PluginToolError",
    "PluginUI",
    "PluginsConfigError",
    "SeedAction",
    "SeedKind",
    "StateReader",
    "ToolRegistration",
    "assert_no_zip_slip",
    "bootstrap_plugins",
    "build_args_model",
    "build_plugin_tools",
    "current_plugin_settings",
    "describe_tools",
    "get_tool_config",
    "iter_plugin_dirs",
    "load_all",
    "load_plugin_dir",
    "register_loaded",
    "resolve_within",
    "seed_bundled_plugins",
    "tool_config_for",
    "unload_plugin",
    "version_gt",
    "version_key",
]
