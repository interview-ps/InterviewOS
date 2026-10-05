"""`PluginRegistry` — singleton, ordering, and the middleware chain (§6.1)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from interview_os.plugins import (
    LoadedPlugin,
    MiddlewareRegistration,
    PluginContext,
    PluginManifest,
    PluginRegistry,
    ToolRegistration,
    register_loaded,
)


def make_loaded(
    plugin_id: str,
    *,
    tools: tuple[str, ...] = (),
    middleware: tuple[tuple[object, int], ...] = (),
) -> LoadedPlugin:
    manifest = PluginManifest.model_validate({"id": plugin_id, "version": "1.0.0"})
    return LoadedPlugin(
        manifest=manifest,
        source_path=Path("/plugins") / plugin_id,
        tools=[
            ToolRegistration(plugin_id=plugin_id, name=name, fn=lambda: None)
            for name in tools
        ],
        middleware=[
            MiddlewareRegistration(plugin_id=plugin_id, instance=instance, priority=priority)
            for instance, priority in middleware
        ],
    )


def test_register_get_and_list_order() -> None:
    registry = PluginRegistry()
    registry.register(make_loaded("zulu"))
    registry.register(make_loaded("alpha"))
    assert [plugin.manifest.id for plugin in registry.list_plugins()] == ["alpha", "zulu"]
    assert registry.get("alpha") is not None
    assert registry.get("missing") is None


def test_unregister_and_clear() -> None:
    registry = PluginRegistry()
    loaded = make_loaded("alpha")
    registry.register(loaded)
    assert registry.unregister("alpha") is loaded
    assert registry.unregister("alpha") is None
    registry.register(make_loaded("beta"))
    registry.clear()
    assert registry.list_plugins() == []


def test_singleton_identity_and_reset() -> None:
    first = PluginRegistry()
    first.register(make_loaded("alpha"))
    assert PluginRegistry() is first
    PluginRegistry.reset()
    assert PluginRegistry().list_plugins() == []


def test_all_tools_across_plugins() -> None:
    registry = PluginRegistry()
    registry.register(make_loaded("beta", tools=("b1", "b2")))
    registry.register(make_loaded("alpha", tools=("a1",)))
    names = [tool.name for tool in registry.all_tools()]
    assert names == ["a1", "b1", "b2"]


def test_middleware_chain_orders_by_priority_then_plugin_id() -> None:
    registry = PluginRegistry()
    beta = object()
    alpha = object()
    registry.register(make_loaded("beta", middleware=((beta, 10),)))
    registry.register(make_loaded("alpha", middleware=((alpha, 10),)))
    assert registry.build_middleware_chain() == [alpha, beta]


def test_middleware_chain_priority_beats_plugin_id() -> None:
    registry = PluginRegistry()
    high = object()
    low = object()
    registry.register(make_loaded("alpha", middleware=((high, 100),)))
    registry.register(make_loaded("beta", middleware=((low, 1),)))
    assert registry.build_middleware_chain() == [low, high]


def test_middleware_chain_skips_disabled_plugins() -> None:
    registry = PluginRegistry()
    enabled = object()
    disabled = object()
    registry.register(make_loaded("on", middleware=((enabled, 1),)))
    registry.register(make_loaded("off", middleware=((disabled, 1),)))
    assert registry.build_middleware_chain(global_enabled={"on"}) == [enabled]


def test_middleware_chain_accepts_a_predicate() -> None:
    registry = PluginRegistry()
    enabled = object()
    disabled = object()
    registry.register(make_loaded("on", middleware=((enabled, 1),)))
    registry.register(make_loaded("off", middleware=((disabled, 1),)))
    chain = registry.build_middleware_chain(global_enabled=lambda plugin_id: plugin_id == "on")
    assert chain == [enabled]


def test_register_loaded_uses_the_context() -> None:
    manifest = PluginManifest.model_validate({"id": "demo", "version": "1.0.0"})
    ctx = PluginContext(manifest, Path("/plugins/demo"))
    ctx.tool("ping", lambda: "pong")
    loaded = register_loaded(ctx)
    assert loaded.manifest.id == "demo"
    assert PluginRegistry().get("demo") is loaded
    assert [tool.name for tool in PluginRegistry().all_tools()] == ["ping"]


def test_all_middleware_returns_registrations() -> None:
    registry = PluginRegistry()
    instance: Any = object()
    registry.register(make_loaded("alpha", middleware=((instance, 3),)))
    registrations = registry.all_middleware()
    assert len(registrations) == 1
    assert registrations[0].instance is instance
    assert registrations[0].priority == 3
