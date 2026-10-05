"""Skill host — port of `apps/server/src/skills/host/SkillHost.ts`.

The single gateway for every skill call (§9.6): validates inputs against the
manifest (declared keys + granted permissions), gates `ctx.runtime` behind
`runtime.invoke`, and exposes `assert_can` for write checks before the
orchestrator persists a skill's outputs (invariant #8).
"""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, NoReturn, Protocol, runtime_checkable

from pydantic import ValidationError

from ..ai.interface import AIRuntime
from ..ai.logger import Logger
from ..core.models import (
    INTERVIEW_OS_VERSION,
    PLUGIN_INPUT_KEYS,
    AppError,
    Permission,
    SkillKind,
    SkillManifest,
    is_plugin_writable,
    is_write_permission,
    satisfies,
)
from ..core.models.shared import SLUG_ID_REGEX
from ..core.plugin_api import is_plugin_api_compatible
from .framework import (
    InterviewSkill,
    PluginKvStorage,
    SkillContext,
    SkillSchema,
    validate_schema,
)

__all__ = [
    "PLUGIN_OUTPUT_MAX_BYTES",
    "PLUGIN_TIMEOUT_MS",
    "PermissionError",
    "PluginError",
    "PluginExecutor",
    "PluginStateSlices",
    "SkillHost",
    "is_manifest_compatible",
]

PLUGIN_TIMEOUT_MS = 30_000
PLUGIN_OUTPUT_MAX_BYTES = 100 * 1024


class PermissionError(AppError):
    """§9.6: permission failure code — thrown before a skill ever executes."""

    def __init__(self, message: str) -> None:
        super().__init__("PERMISSION_DENIED", message)
        self.name = "PermissionError"


class PluginError(AppError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(code, message)
        self.name = "PluginError"


@runtime_checkable
class PluginExecutor(Protocol):
    """What a plugin's entry module must provide."""

    async def execute(self, input: dict[str, object], ctx: SkillContext) -> object: ...

    @property
    def output_schema(self) -> SkillSchema | None: ...


#: Slices a plugin may receive; the host fills only declared + granted keys.
PluginStateSlices = Mapping[str, object]


@dataclass(slots=True)
class _HostEntry:
    manifest: SkillManifest
    execute: Any
    input_schema: SkillSchema | None
    output_schema: SkillSchema | None
    plugin: bool


def _denied_runtime(skill_id: str) -> AIRuntime:
    class _DeniedRuntime:
        def __getattr__(self, name: str) -> NoReturn:
            raise PermissionError(
                f'skill "{skill_id}" cannot use the runtime — its manifest lacks runtime.invoke'
            )

    return _DeniedRuntime()


def _proxy_runtime(
    skill_id: str,
    permissions: tuple[Permission, ...],
    runtime: AIRuntime,
) -> AIRuntime:
    if Permission.RUNTIME_INVOKE in permissions:
        return runtime
    return _denied_runtime(skill_id)


def effective_permissions(
    manifest: SkillManifest, granted: tuple[Permission, ...] | None
) -> list[Permission]:
    """v0.4: effective permissions = manifest ∩ granted (granted omitted → all requested)."""
    if granted is None:
        return list(manifest.permissions)
    allowed = set(granted)
    return [p for p in manifest.permissions if p in allowed]


def is_manifest_compatible(manifest: SkillManifest) -> bool:
    """v0.4: engines["interview-os"] and engines["plugin-api"] (missing = ^1) must hold."""
    engines = manifest.engines
    if engines is None:
        return True
    return satisfies(INTERVIEW_OS_VERSION, engines.interview_os) and is_plugin_api_compatible(
        engines.plugin_api
    )


def _format_issues(error: ValidationError) -> str:
    parts: list[str] = []
    for issue in error.errors():
        location = ".".join(str(bit) for bit in issue["loc"]) or "input"
        parts.append(f"{location}: {issue['msg']}")
    return "; ".join(parts)


class SkillHost:
    def __init__(self, logger: Logger | None = None) -> None:
        self._entries: dict[str, _HostEntry] = {}
        self._logger = logger

    def register(self, skill: InterviewSkill[Any, Any]) -> None:
        """Register a built-in skill with its manifest."""
        manifest = SkillManifest.model_validate(skill.manifest.model_dump(by_alias=True))
        if manifest.id != skill.id:
            raise AppError(
                "VALIDATION",
                f'manifest id "{manifest.id}" does not match skill id "{skill.id}"',
            )
        self._entries[skill.id] = _HostEntry(
            manifest=manifest,
            execute=skill.execute,
            input_schema=getattr(skill, "input_schema", None),
            output_schema=getattr(skill, "output_schema", None),
            plugin=False,
        )

    def register_plugin(
        self,
        manifest: SkillManifest,
        executor: PluginExecutor,
        *,
        skill_id: str | None = None,
    ) -> None:
        """Register a plugin.

        The loader has already validated the manifest and rejected write
        permissions; the host double-checks both plus the input slices, since
        this is the security boundary.
        """
        parsed = SkillManifest.model_validate(
            {**manifest.model_dump(by_alias=True), "kind": SkillKind.PLUGIN.value}
        )
        if re.fullmatch(SLUG_ID_REGEX, parsed.id) is None:
            raise PluginError(
                "PLUGIN_INVALID",
                f'plugin id "{parsed.id}" is not a valid slug ({SLUG_ID_REGEX})',
            )
        if parsed.name is None:
            parsed.name = parsed.id
        for permission in parsed.permissions:
            if is_write_permission(permission) and not is_plugin_writable(permission):
                raise PermissionError(
                    f'plugin "{parsed.id}" requests write permission "{permission}" — '
                    "plugins may only write evidence"
                )
        for declared in parsed.inputs:
            expected = PLUGIN_INPUT_KEYS.get(declared.key)
            if expected is None:
                raise PluginError(
                    "PLUGIN_INVALID",
                    f'plugin "{parsed.id}" declares unsupported input "{declared.key}"',
                )
            if declared.permission != expected:
                raise PluginError(
                    "PLUGIN_INVALID",
                    f'plugin "{parsed.id}" input "{declared.key}" must require "{expected}"',
                )
        self._entries[parsed.id] = _HostEntry(
            manifest=parsed,
            execute=executor.execute,
            input_schema=None,
            output_schema=getattr(executor, "output_schema", None),
            plugin=True,
        )

    def _entry(self, skill_id: str) -> _HostEntry:
        entry = self._entries.get(skill_id)
        if entry is None:
            raise AppError("NOT_FOUND", f'unknown skill "{skill_id}"')
        return entry

    def manifests(self) -> list[SkillManifest]:
        return [entry.manifest for entry in self._entries.values()]

    def manifest_for(self, skill_id: str) -> SkillManifest:
        return self._entry(skill_id).manifest

    def assert_can(
        self,
        skill_id: str,
        permission: Permission,
        granted: tuple[Permission, ...] | None = None,
    ) -> None:
        """§9.6 write gate — the orchestrator calls this before persisting output."""
        manifest = self._entry(skill_id).manifest
        effective = effective_permissions(manifest, granted)
        if permission not in effective:
            names = ", ".join(p.value for p in effective) or "none"
            raise PermissionError(
                f'skill "{skill_id}" is not allowed {permission.value} (granted: {names})'
            )

    def unregister(self, skill_id: str) -> None:
        """Remove a registered plugin (v0.4 uninstall); built-ins cannot be removed."""
        entry = self._entries.get(skill_id)
        if entry is None:
            return
        if not entry.plugin:
            raise AppError("VALIDATION", f'skill "{skill_id}" is not a plugin')
        del self._entries[skill_id]

    def _check_input_keys(self, manifest: SkillManifest, input: object) -> None:
        """Reject top-level input keys the manifest doesn't declare or permit."""
        if isinstance(input, Mapping):
            keys = [str(key) for key in input]
        elif hasattr(input, "model_fields") and hasattr(input, "model_fields_set"):
            fields = type(input).model_fields
            keys = [fields[name].alias or name for name in input.model_fields_set if name in fields]
        else:
            return
        declared = {item.key: item.permission for item in manifest.inputs}
        for key in keys:
            permission = declared.get(key)
            if permission is None:
                raise PermissionError(
                    f'skill "{manifest.id}" manifest does not declare input "{key}"'
                )
            if permission not in manifest.permissions:
                raise PermissionError(
                    f'skill "{manifest.id}" lacks {permission.value} for input "{key}"'
                )

    async def invoke(
        self,
        skill_or_id: str | InterviewSkill[Any, Any],
        input: object,
        ctx: SkillContext,
    ) -> Any:
        skill_id = skill_or_id if isinstance(skill_or_id, str) else skill_or_id.id
        entry = self._entry(skill_id)
        self._check_input_keys(entry.manifest, input)

        parsed_input = input
        if entry.input_schema is not None:
            try:
                parsed_input = validate_schema(entry.input_schema, input)
            except ValidationError as err:
                raise AppError(
                    "VALIDATION",
                    f'invalid input for skill "{skill_id}": {_format_issues(err)}',
                ) from err

        guarded_ctx = ctx.clone(
            runtime=_proxy_runtime(skill_id, tuple(entry.manifest.permissions), ctx.runtime)
        )
        output = await entry.execute(parsed_input, guarded_ctx)
        if entry.output_schema is not None:
            try:
                validate_schema(entry.output_schema, output)
            except ValidationError as err:
                raise AppError(
                    "VALIDATION",
                    f'skill "{skill_id}" produced invalid output: {_format_issues(err)}',
                ) from err
        return output

    async def invoke_plugin(
        self,
        skill_id: str,
        slices: PluginStateSlices,
        ctx: SkillContext,
        *,
        granted: tuple[Permission, ...] | None = None,
        hook: str | None = None,
        hook_request: object | None = None,
        settings: Mapping[str, object] | None = None,
        storage: PluginKvStorage | None = None,
    ) -> object:
        """§9.6 plugin execution: declared slices only, 30s timeout, capped output."""
        entry = self._entry(skill_id)
        if not entry.plugin:
            raise AppError("VALIDATION", f'skill "{skill_id}" is not a plugin')
        if not is_manifest_compatible(entry.manifest):
            engines = entry.manifest.engines
            required = engines.interview_os if engines is not None else None
            raise PluginError(
                "PLUGIN_INCOMPATIBLE",
                f'plugin "{skill_id}" requires interview-os {required} '
                f"(running {INTERVIEW_OS_VERSION})",
            )
        effective = tuple(effective_permissions(entry.manifest, granted))
        input: dict[str, object] = {}
        for declared in entry.manifest.inputs:
            if declared.permission not in effective:
                continue
            input[declared.key] = slices.get(declared.key)

        guarded_ctx = ctx.clone(
            runtime=_proxy_runtime(skill_id, tuple(effective), ctx.runtime),
            granted_permissions=effective,
            plugin_hook=hook,
            hook_request=hook_request,
            settings=settings,
            storage=storage,
        )
        try:
            output = await asyncio.wait_for(
                entry.execute(input, guarded_ctx), timeout=PLUGIN_TIMEOUT_MS / 1000
            )
        except TimeoutError as err:
            raise PluginError(
                "PLUGIN_TIMEOUT", f'plugin "{skill_id}" exceeded {PLUGIN_TIMEOUT_MS // 1000}s'
            ) from err

        if entry.output_schema is not None:
            try:
                output = validate_schema(entry.output_schema, output)
            except ValidationError as err:
                raise PluginError(
                    "PLUGIN_OUTPUT", f'plugin "{skill_id}" output failed schema validation'
                ) from err

        try:
            serialized = json.dumps(output, ensure_ascii=False)
        except (TypeError, ValueError) as err:
            raise PluginError(
                "PLUGIN_OUTPUT", f'plugin "{skill_id}" returned a non-JSON-serializable value'
            ) from err
        if len(serialized) > PLUGIN_OUTPUT_MAX_BYTES:
            raise PluginError(
                "PLUGIN_OUTPUT",
                f'plugin "{skill_id}" output exceeds {PLUGIN_OUTPUT_MAX_BYTES} bytes',
            )
        if self._logger is not None:
            self._logger.info("plugin.ran", {"plugin": skill_id})
        return output
