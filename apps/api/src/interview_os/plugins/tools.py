"""Plugin tools: enablement, argument schemas, config, and invocation (§7.1).

Enablement copies Octop's `_tool_enabled`: a tool is off when its plugin is
globally disabled, otherwise **on by default**, with a per-scope opt-out at
`plugins.<id>.tools.<name>.enabled: false`.

Per-tool config lives at `plugins.<id>.tools.<name>.config` and is read inside a
tool with `get_tool_config(name)` — a contextvar set for the duration of the
call, replacing Octop's `RunnableConfig.configurable`.

Argument validation uses Pydantic `validate_call` on the tool callable; the
schema is built from the same signature, because `validate_call` in Pydantic
2.13 returns a plain function with no public schema object.
"""

from __future__ import annotations

import inspect
from collections.abc import Callable, Mapping
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any, get_type_hints

from pydantic import BaseModel, ConfigDict, create_model, validate_call

from .context import LoadedPlugin

__all__ = [
    "PluginTool",
    "build_args_model",
    "build_plugin_tools",
    "describe_tools",
    "get_tool_config",
    "tool_config_for",
]

_tool_config_var: ContextVar[Mapping[str, Mapping[str, Any]] | None] = ContextVar(
    "ios_plugin_tool_config", default=None
)


def get_tool_config(name: str) -> dict[str, Any]:
    """The calling tool's `config` block, or `{}` outside a tool invocation."""

    current = _tool_config_var.get()
    if not current:
        return {}
    value = current.get(name)
    return dict(value) if isinstance(value, Mapping) else {}


def _tool_enabled(
    plugin_id: str,
    name: str,
    *,
    global_enabled: bool,
    config: Mapping[str, Any],
) -> bool:
    """Off when the plugin is disabled, else on unless explicitly opted out.

    `config` is the plugin's `tools` mapping (`data/config.json` ->
    `plugins.<id>.tools`).
    """

    if not global_enabled:
        return False
    entry = config.get(name)
    if not isinstance(entry, Mapping):
        return True
    return entry.get("enabled") is not False


def build_args_model(fn: Callable[..., object]) -> type[BaseModel]:
    """A Pydantic model for `fn`'s keyword arguments (minus `*args`/`**kwargs`)."""

    try:
        signature = inspect.signature(fn)
    except (TypeError, ValueError):
        return create_model("ToolArgs")
    try:
        hints = get_type_hints(fn)
    except Exception:  # noqa: BLE001 - unresolvable hints fall back to raw/Any
        hints = {}
    fields: dict[str, Any] = {}
    for name, parameter in signature.parameters.items():
        if parameter.kind in (
            inspect.Parameter.VAR_POSITIONAL,
            inspect.Parameter.VAR_KEYWORD,
        ):
            continue
        annotation = hints.get(name, parameter.annotation)
        if annotation is inspect.Parameter.empty:
            annotation = Any
        default = (
            parameter.default
            if parameter.default is not inspect.Parameter.empty
            else ...
        )
        fields[name] = (annotation, default)
    model_name = f"{getattr(fn, '__name__', 'tool')}_args"
    return create_model(model_name, __config__=ConfigDict(extra="forbid"), **fields)


def _tool_config_from(entry: object) -> dict[str, Any]:
    if isinstance(entry, Mapping):
        raw = entry.get("config")
        if isinstance(raw, Mapping):
            return {str(key): value for key, value in raw.items()}
    return {}


def tool_config_for(config: Mapping[str, Any], name: str) -> dict[str, Any]:
    """The stored `config` block for one tool from a plugin's `tools` mapping."""

    return _tool_config_from(config.get(name))


@dataclass(slots=True)
class PluginTool:
    """A callable tool with its validated signature and resolved config."""

    plugin_id: str
    name: str
    description: str
    raw: Callable[..., object]
    fn: Callable[..., object]
    config_fields: list[dict[str, Any]] = field(default_factory=list)
    config: dict[str, Any] = field(default_factory=dict)
    schema: dict[str, Any] = field(default_factory=dict)

    async def invoke(self, args: Mapping[str, Any] | None = None) -> object:
        """Validate `args` and call the tool; awaits an async tool's result."""

        token = _tool_config_var.set({self.name: self.config})
        try:
            result = self.fn(**dict(args or {}))
            if inspect.isawaitable(result):
                return await result
            return result
        finally:
            _tool_config_var.reset(token)


def build_plugin_tools(
    loaded: LoadedPlugin, *, global_enabled: bool, config: Mapping[str, Any]
) -> list[PluginTool]:
    """Enabled tools of `loaded`, each wrapped with `validate_call`."""

    plugin_id = loaded.manifest.id
    tools: list[PluginTool] = []
    for registration in loaded.tools:
        if not _tool_enabled(
            plugin_id, registration.name, global_enabled=global_enabled, config=config
        ):
            continue
        tools.append(
            PluginTool(
                plugin_id=plugin_id,
                name=registration.name,
                description=registration.description,
                raw=registration.fn,
                fn=validate_call(registration.fn),
                config_fields=list(registration.config_fields),
                config=_tool_config_from(config.get(registration.name)),
                schema=build_args_model(registration.fn).model_json_schema(),
            )
        )
    return tools


def describe_tools(
    loaded: LoadedPlugin, *, global_enabled: bool, config: Mapping[str, Any]
) -> list[dict[str, Any]]:
    """The tool catalogue for listing: name/description/enabled/config (no calls)."""

    plugin_id = loaded.manifest.id
    catalogue: list[dict[str, Any]] = []
    for registration in loaded.tools:
        catalogue.append(
            {
                "name": registration.name,
                "description": registration.description,
                "enabled": _tool_enabled(
                    plugin_id, registration.name, global_enabled=global_enabled, config=config
                ),
                "configFields": list(registration.config_fields),
                "config": _tool_config_from(config.get(registration.name)),
            }
        )
    return catalogue
