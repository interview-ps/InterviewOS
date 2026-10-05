"""In-process executor — backs the legacy `SkillHost` with phase-7 Python plugins.

The migrated `PluginService` still talks to an executor via
`SkillHost.invoke_plugin(..., hook=..., hook_request=..., settings=...)`, which
calls `executor.execute(input, ctx)`. This adapter runs the ported plugin's
`main.py` in-process and routes that call onto the middleware hook method
(phase-7 §7.3), so every existing plugin feature (modes, questions, resources,
ui, evaluation reviews, evidence) keeps working without a route rewrite.
"""

from __future__ import annotations

import importlib.util
import inspect
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from ..core.plugin_api import PLUGIN_HOOKS
from .dispatch import HOOK_METHODS, use_plugin_settings

__all__ = ["PythonPluginExecutor", "load_python_plugin"]


class _SetupShim:
    """Minimal `setup(ctx)` context that captures middleware registrations."""

    __slots__ = ("instances",)

    def __init__(self) -> None:
        self.instances: list[object] = []

    def middleware(self, instance: object, *, priority: int = 100) -> None:
        self.instances.append(instance)

    def tool(self, *_args: object, **_kwargs: object) -> None:
        raise ValueError("tool plugins are not supported on the legacy host path")

    def skills(self, *_args: object, **_kwargs: object) -> None:
        raise ValueError("skill plugins are not supported on the legacy host path")

    def evidence(self, _proposal: object) -> None:
        return None

    def add_diagnostic(self, _message: str) -> None:
        return None


def load_python_plugin(plugin_dir: Path, entry: str) -> tuple[object | None, Any]:
    """Import `<plugin_dir>/<entry>` and run `setup(ctx)`; return (instance, module)."""

    from ..skills.host import PluginError

    path = Path(plugin_dir) / entry
    module_name = f"ios_plugin_{Path(plugin_dir).name}"
    spec = importlib.util.spec_from_file_location(
        module_name, path, submodule_search_locations=[str(plugin_dir)]
    )
    if spec is None or spec.loader is None:
        raise PluginError("PLUGIN_INVALID", f'cannot import plugin entry "{entry}"')
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    try:
        spec.loader.exec_module(module)
        setup = getattr(module, "setup", None)
        shim = _SetupShim()
        if callable(setup):
            setup(shim)
    except Exception:
        sys.modules.pop(module_name, None)
        raise
    return (shim.instances[0] if shim.instances else None), module


class PythonPluginExecutor:
    """An executor the legacy `SkillHost` can call in-process."""

    #: Mirrors the isolated executor's attribute (the host reads it if present).
    output_schema: Any = None

    def __init__(self, instance: object | None, module: Any) -> None:
        self._instance = instance
        self._module = module

    async def execute(self, input: object, ctx: object) -> object:
        hook = getattr(ctx, "plugin_hook", None)
        if isinstance(hook, str) and hook:
            return await self._invoke_hook(hook, ctx)
        legacy = getattr(self._module, "execute", None)
        if not callable(legacy):
            legacy = getattr(self._instance, "execute", None)
        if not callable(legacy):
            return {}
        input_map = input if isinstance(input, Mapping) else {}
        request = input_map.get("request")
        result = legacy(input_map, request) if _accepts_request(legacy) else legacy(input_map)
        if inspect.isawaitable(result):
            result = await result
        return _as_json(result)

    async def _invoke_hook(self, hook: str, ctx: object) -> object:
        method = HOOK_METHODS.get(hook)
        handler = getattr(self._instance, method, None) if method else None
        if not callable(handler):
            from ..skills.host import PluginError

            raise PluginError(
                "PLUGIN_OUTPUT", f'hook "{hook}" is not implemented by this plugin'
            )
        spec = PLUGIN_HOOKS[hook]
        request = spec.request.model_validate(getattr(ctx, "hook_request", None) or {})
        settings = getattr(ctx, "settings", None) or {}
        with use_plugin_settings(dict(settings)):
            result = await handler(request)
        if result is None:
            return {}
        return _as_json(result)


def _as_json(value: object) -> object:
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        return dump(by_alias=True, mode="json")
    return value


def _accepts_request(fn: Any) -> bool:
    """True when `fn(input, request)` takes a second positional parameter."""

    try:
        params = inspect.signature(fn).parameters.values()
    except (TypeError, ValueError):
        return False
    positional = [
        param
        for param in params
        if param.kind in (param.POSITIONAL_ONLY, param.POSITIONAL_OR_KEYWORD)
    ]
    return len(positional) >= 2
