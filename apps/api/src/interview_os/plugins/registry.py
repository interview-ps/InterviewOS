"""Process-wide plugin registry (§6.1).

A single `PluginRegistry` holds every `LoadedPlugin`, in load order per plugin
id. Tool and middleware catalogues are derived views; the middleware chain is
ordered by `(priority, plugin_id)` so a plugin's own order is deterministic.
"""

from __future__ import annotations

from collections.abc import Callable, Collection
from typing import ClassVar

from .context import LoadedPlugin, MiddlewareRegistration, PluginContext, ToolRegistration

__all__ = [
    "EnabledPredicate",
    "GlobalEnabled",
    "PluginRegistry",
    "register_loaded",
]

EnabledPredicate = Callable[[str], bool]
GlobalEnabled = Collection[str] | EnabledPredicate | None


def _always_enabled(_plugin_id: str) -> bool:
    return True


def _enabled_predicate(value: GlobalEnabled) -> EnabledPredicate:
    if value is None:
        return _always_enabled
    if callable(value):
        return value
    allowed = frozenset(value)
    return lambda plugin_id: plugin_id in allowed


class PluginRegistry:
    """A process-wide singleton keyed by plugin id."""

    _instance: ClassVar[PluginRegistry | None] = None

    _plugins: dict[str, LoadedPlugin]

    def __new__(cls) -> PluginRegistry:
        instance = cls._instance
        if instance is None:
            instance = super().__new__(cls)
            instance._plugins = {}
            cls._instance = instance
        return instance

    # ------------------------------------------------------------------ mutations

    def register(self, loaded: LoadedPlugin) -> None:
        self._plugins[loaded.manifest.id] = loaded

    def unregister(self, plugin_id: str) -> LoadedPlugin | None:
        return self._plugins.pop(plugin_id, None)

    def clear(self) -> None:
        """Drop every registration without touching `sys.modules`."""

        self._plugins.clear()

    @classmethod
    def reset(cls) -> None:
        """Drop every registration **and** the singleton instance (test seam)."""

        if cls._instance is not None:
            cls._instance._plugins.clear()
            cls._instance = None

    # -------------------------------------------------------------------- readers

    def get(self, plugin_id: str) -> LoadedPlugin | None:
        return self._plugins.get(plugin_id)

    def list_plugins(self) -> list[LoadedPlugin]:
        return [self._plugins[key] for key in sorted(self._plugins)]

    def all_tools(self) -> list[ToolRegistration]:
        tools: list[ToolRegistration] = []
        for loaded in self.list_plugins():
            tools.extend(loaded.tools)
        return tools

    def all_middleware(self) -> list[MiddlewareRegistration]:
        middleware: list[MiddlewareRegistration] = []
        for loaded in self.list_plugins():
            middleware.extend(loaded.middleware)
        return middleware

    def build_middleware_chain(self, *, global_enabled: GlobalEnabled = None) -> list[object]:
        """Middleware instances of enabled plugins, ordered by (priority, plugin id)."""

        enabled = _enabled_predicate(global_enabled)
        chain: list[MiddlewareRegistration] = []
        for loaded in self.list_plugins():
            if not enabled(loaded.manifest.id):
                continue
            chain.extend(loaded.middleware)
        chain.sort(key=lambda registration: (registration.priority, registration.plugin_id))
        return [registration.instance for registration in chain]


def register_loaded(ctx: PluginContext) -> LoadedPlugin:
    """Register a context's registrations and return the resulting `LoadedPlugin`."""

    loaded = ctx.to_loaded()
    PluginRegistry().register(loaded)
    return loaded
