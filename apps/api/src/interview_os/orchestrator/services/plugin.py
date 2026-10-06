"""Plugin service — port of `apps/server/src/orchestrator/plugin-service.ts`.

The v1 plugin API surface: registration + the registry, install/uninstall,
enable/disable + grants, typed hook invocation (validated before send, validated
after receipt), the v0.4 declarative/frame UI paths, plugin interview modes,
plugin-shipped packs, settings + KV storage, evaluation reviews, preparation
suggestions and lifecycle events.

Local, faithful ports of core helpers that this repo has not ported yet —
`describePermissions`, `pluginApiFeatureWarnings` (+ `rangeLowerBound`) and the
plugin-SDK loader helpers (`loadManifestFile`/`findEntryFile`/
`loadPluginModePrompts`) — live at the bottom of this module. They are behaviour
copies of `packages/core/src/skills/permissions.ts`,
`packages/core/src/platform/{plugin-api,semver}.ts` and
`packages/plugin-sdk/src/manifest.ts` + `apps/server/src/startup/plugins.ts`.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, cast

import yaml
from pydantic import ValidationError

from ...adapters.git import clone_shallow, validate_git_source
from ...core import ModePrompts, new_id, taxonomy
from ...core.models import (
    ANSWER_FIELD_TYPES,
    PLUGIN_EVIDENCE_CONFIDENCE_CAP,
    PLUGIN_INPUT_KEYS,
    PLUGIN_UI_SLOTS,
    SLUG_ID_REGEX,
    AnswerEvaluation,
    AppError,
    CamelModel,
    CandidateProfile,
    Gap,
    JsonScalar,
    Permission,
    PluginCapability,
    PluginInterviewMode,
    PluginSettingField,
    PluginSettingFieldType,
    ReadinessGraph,
    Semver,
    SkillKind,
    SkillManifest,
    TargetRole,
    UINode,
    compare_semver,
    format_semver,
    is_valid_version,
    parse_version,
    plugin_evidence_proposals,
    validate_ui_tree,
)
from ...core.plugin_api import (
    LEGACY_HOOK_KIND,
    MANIFEST_FEATURE_SINCE,
    PLUGIN_API_VERSION,
    PLUGIN_EVENT_NAMES,
    PLUGIN_HOOK_NAMES,
    PLUGIN_HOOKS,
    EvaluationReviewQuestion,
    PluginPrepActivity,
    is_plugin_hook_name,
)
from ...core.serialize import dump_json
from ...skills.framework import PluginKvStorage
from ...skills.host import (
    PluginError,
    PluginExecutor,
    PluginStateSlices,
    is_manifest_compatible,
)
from ..context import WorkflowContext

__all__ = [
    "AcceptPluginSuggestionResult",
    "EvaluationReviewAnswerInput",
    "EvaluationReviewsArgs",
    "PermissionAccess",
    "PermissionViewEntry",
    "PluginDirs",
    "PluginEvidenceWriteResult",
    "PluginInterviewModeRef",
    "PluginLoadError",
    "PluginPrepSuggestionGroup",
    "PluginRegistrationMeta",
    "PluginReview",
    "PluginRunResult",
    "PluginService",
    "PluginSource",
    "PluginUIContributionView",
    "PluginUIRenderRequest",
    "PluginUIRunResult",
    "ResolvedUIFrame",
    "UIFrameRunSelector",
    "UIFrameSelector",
    "describe_permissions",
    "plugin_api_feature_warnings",
]

PluginSource = Literal["bundled", "git", "memory"]
PermissionAccess = Literal["READ", "WRITE", "INVOKE", "DENIED", "UI"]

#: describePermissions categories (fixed view, mirrors `permissions.ts`).
_CATEGORIES: tuple[
    tuple[str, tuple[Permission, ...], tuple[Permission, ...], tuple[Permission, ...]], ...
] = (
    ("Candidate Profile", (Permission.CANDIDATE_READ,), (Permission.CANDIDATE_WRITE,), ()),
    ("Resume", (Permission.RESUME_READ,), (Permission.RESUME_WRITE,), ()),
    ("Target", (Permission.TARGET_READ,), (Permission.TARGET_WRITE,), ()),
    (
        "Readiness",
        (Permission.READINESS_READ, Permission.TAXONOMY_READ),
        (),
        (),
    ),
    ("Interview History", (Permission.INTERVIEW_READ,), (Permission.INTERVIEW_WRITE,), ()),
    ("Interview Answers", (Permission.ANSWERS_READ,), (), ()),
    ("STAR Stories", (Permission.STORIES_READ,), (Permission.STORIES_WRITE,), ()),
    ("Evidence (write)", (), (Permission.EVIDENCE_WRITE,), ()),
    ("AI Runtime", (), (), (Permission.RUNTIME_INVOKE,)),
)

_ISOLATION_DENIED: tuple[str, ...] = (
    "Local Files",
    "Network",
    "Environment/Secrets",
    "Commands",
)

#: The `interview.question` slot value used by the 1.1 feature-warning check.
_INTERVIEW_QUESTION_SLOT = "interview.question"

_UI_CACHE_TTL_MS = 60_000


# ------------------------------------------------------------------- views


class PermissionViewEntry(CamelModel):
    category: str
    access: PermissionAccess
    requested: bool
    granted: bool
    detail: str | None = None


class PluginLoadError(CamelModel):
    dir: str
    file: str
    error: str


class PluginView(CamelModel):
    manifest: SkillManifest
    enabled: bool
    granted_permissions: list[Permission]
    source: PluginSource
    compatible: bool
    permissions: list[PermissionViewEntry]
    load_error: str | None = None


class PluginRunResult(CamelModel):
    output: Any = None
    evidence_written: int = 0
    evidence_ignored: int = 0
    evidence_rejected: str | None = None


class PluginEvidenceWriteResult(CamelModel):
    written: int
    ignored: int


class AcceptPluginSuggestionResult(CamelModel):
    id: str


class PluginUIRenderRequest(CamelModel):
    """v0.4: request for a declarative UI render (slot contribution or page)."""

    slot: str | None = None
    component: str
    page: str | None = None
    params: Any = None


class UIFrameSelector(CamelModel):
    component: str | None = None
    page: str | None = None


class UIFrameRunSelector(CamelModel):
    component: str | None = None
    page: str | None = None
    request: Any = None


class ResolvedUIFrame(CamelModel):
    dir: str
    entry: str
    component: str
    page: str | None = None
    title: str | None = None


class PluginUIRunResult(CamelModel):
    output: Any = None
    ui: Any = None


class PluginUIContributionView(CamelModel):
    """v0.4: what an enabled plugin contributes to the host UI."""

    plugin_id: str
    plugin_name: str
    navigation: list[Any]
    commands: list[Any]
    slots: dict[str, Any]
    pages: list[Any]
    interview_modes: list[PluginInterviewMode]
    modes: list[str]


class PluginInterviewModeRef(CamelModel):
    plugin_id: str
    mode: PluginInterviewMode


class PluginReview(CamelModel):
    plugin_id: str
    plugin_name: str
    observations: list[Any]
    evidence_proposals: list[Any]
    evidence_granted: bool


class PluginPrepSuggestionGroup(CamelModel):
    plugin_id: str
    plugin_name: str
    activities: list[Any]


class EvaluationReviewAnswerInput(CamelModel):
    text: str
    code: str | None = None
    language: str | None = None
    fields: dict[str, JsonScalar] | None = None


class EvaluationReviewsArgs(CamelModel):
    question: EvaluationReviewQuestion
    evaluation: AnswerEvaluation
    answer: EvaluationReviewAnswerInput


@dataclass(slots=True)
class PluginRegistrationMeta:
    dir: str | None = None
    entry_file: str | None = None
    source: PluginSource | None = None
    #: Hook names the plugin implements (manifest `hooks` ∪ runner describe).
    hooks: list[str] | None = None
    #: Declared `modes` + prompt bodies loaded at plugin load time.
    loaded_modes: list[Any] | None = None


@dataclass(slots=True)
class PluginDirs:
    bundled: str
    installed: str


@dataclass(slots=True)
class _RegistryEntry:
    manifest: SkillManifest
    dir: str | None
    source: PluginSource
    hooks: list[str]
    loaded_modes: list[Any]


@dataclass(slots=True)
class _UICacheEntry:
    tree: UINode
    epoch: int
    at: float


#: The auto-grant set: reads + runtime.invoke are grantable; evidence.write never is.
def _auto_grantable(manifest: SkillManifest) -> list[Permission]:
    return [
        permission
        for permission in manifest.permissions
        if permission.value.endswith(".read") or permission == Permission.RUNTIME_INVOKE
    ]


def _setting_value_error(field_: PluginSettingField, value: object) -> str | None:
    if field_.type == PluginSettingFieldType.STRING:
        if isinstance(value, str) and len(value) <= 1000:
            return None
        return "must be a string (≤ 1000 chars)"
    if field_.type == PluginSettingFieldType.NUMBER:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return "must be a finite number"
        if value != value or value in (float("inf"), float("-inf")):
            return "must be a finite number"
        return None
    if field_.type == PluginSettingFieldType.BOOLEAN:
        return None if isinstance(value, bool) else "must be a boolean"
    if field_.type == PluginSettingFieldType.ENUM:
        options = field_.options or []
        return (
            None
            if isinstance(value, str) and value in options
            else f"must be one of {', '.join(options)}"
        )
    return "unknown setting type"


class _PluginKv:
    """Plugin-owned KV storage adapter handed to runs (and via IPC to runners)."""

    KEY_MAX = 128
    VALUE_MAX = 32 * 1024
    TOTAL_MAX = 256 * 1024

    def __init__(self, ctx: WorkflowContext, plugin_id: str) -> None:
        self._ctx = ctx
        self._id = plugin_id

    def _check_key(self, key: object) -> str:
        if not isinstance(key, str) or not key or len(key) > self.KEY_MAX:
            raise AppError("VALIDATION", f"storage keys must be 1–{self.KEY_MAX} chars")
        return key

    async def get(self, key: str) -> object:
        return self._ctx.store.get_plugin_storage_value(self._id, self._check_key(key))

    async def set(self, key: str, value: object) -> None:
        self._check_key(key)
        try:
            size = len(json.dumps(value, separators=(",", ":"), ensure_ascii=False))
        except (TypeError, ValueError) as err:
            raise AppError("VALIDATION", "storage values must be JSON-serializable") from err
        if size > self.VALUE_MAX:
            cap_kb = self.VALUE_MAX // 1024
            raise AppError("VALIDATION", f"storage values are capped at {cap_kb} KB")
        used = self._ctx.store.plugin_storage_bytes(self._id)
        existing = self._ctx.store.get_plugin_storage_value(self._id, key)
        existing_size = (
            0
            if existing is None
            else len(json.dumps(existing, separators=(",", ":"), ensure_ascii=False))
        )
        if used - existing_size + size > self.TOTAL_MAX:
            raise AppError(
                "VALIDATION", f"plugin storage is capped at {self.TOTAL_MAX // 1024} KB"
            )
        self._ctx.store.set_plugin_storage_value(self._id, key, value)

    async def delete(self, key: str) -> None:
        self._ctx.store.delete_plugin_storage_value(self._id, self._check_key(key))


class PluginService:
    def __init__(
        self,
        ctx: WorkflowContext,
        *,
        graph_for_active: Callable[[], Awaitable[ReadinessGraph]],
        calculate_gaps: Callable[[], Awaitable[list[Gap]]],
        recompute_readiness: Callable[[str], Awaitable[ReadinessGraph]],
        plugin_dirs: PluginDirs | None = None,
    ) -> None:
        self._ctx = ctx
        self._deps_graph_for_active = graph_for_active
        self._deps_calculate_gaps = calculate_gaps
        self._deps_recompute_readiness = recompute_readiness
        self._deps_plugin_dirs = plugin_dirs
        self._registry: dict[str, _RegistryEntry] = {}
        self._load_errors: list[PluginLoadError] = []
        self._ui_render_cache: dict[str, _UICacheEntry] = {}

    # ----------------------------------------------------------- registration

    def set_plugin_load_errors(self, errors: list[PluginLoadError]) -> None:
        self._load_errors = errors

    def register_plugin(
        self,
        manifest: SkillManifest,
        executor: PluginExecutor,
        meta: PluginRegistrationMeta | None = None,
    ) -> None:
        meta = meta if meta is not None else PluginRegistrationMeta()
        hooks = list(dict.fromkeys([*(manifest.hooks or []), *(meta.hooks or [])]))
        self._check_capability_hooks(manifest, meta.dir, hooks)
        self._check_mode_ids(manifest)
        # v1.1: warn (never block) when a plugin uses hooks/features that
        # post-date its declared engines["plugin-api"] floor.
        for detail in plugin_api_feature_warnings(manifest, hooks):
            self._ctx.logger.warn("plugin.api_feature", {"plugin": manifest.id, "detail": detail})
        self._ctx.host.register_plugin(manifest, executor)
        parsed = manifest.model_copy(update={"kind": SkillKind.PLUGIN})
        self._registry[manifest.id] = _RegistryEntry(
            manifest=parsed,
            dir=meta.dir,
            source=meta.source if meta.source is not None else "memory",
            hooks=hooks,
            loaded_modes=list(meta.loaded_modes or []),
        )

    def _check_mode_ids(self, manifest: SkillManifest) -> None:
        """v1: declared mode ids must be unique across "mixed" and every plugin."""

        for mode in manifest.modes or []:
            if mode.id == "mixed":
                raise AppError(
                    "PLUGIN_INSTALL",
                    f'plugin "{manifest.id}" mode "{mode.id}" collides with the reserved '
                    '"mixed" round',
                )
            for entry in self._registry.values():
                if entry.manifest.id == manifest.id:
                    continue
                if any(m.id == mode.id for m in entry.manifest.modes or []):
                    raise AppError(
                        "PLUGIN_INSTALL",
                        f'plugin "{manifest.id}" mode "{mode.id}" collides with plugin '
                        f'"{entry.manifest.id}"',
                    )

    async def sync_plugin_modes(self) -> None:
        """v1: keep the core mode registry in sync with plugin load state."""

        from ...core.modes import register_plugin_modes, reset_plugin_modes  # noqa: PLC0415

        reset_plugin_modes()
        for entry in self._registry.values():
            if not entry.loaded_modes:
                continue
            if not is_manifest_compatible(entry.manifest):
                continue
            row = await self._ensure_install_row(entry)
            if row.enabled != 1:
                continue
            try:
                register_plugin_modes(entry.manifest.id, entry.loaded_modes)
            except Exception as err:  # noqa: BLE001 - one bad plugin must not stop the sync
                self._ctx.logger.warn(
                    "plugin.modes_failed",
                    {"plugin": entry.manifest.id, "error": str(err)[:200]},
                )

    async def mode_hook(
        self,
        mode_id: str,
        hook: str,
        req: object,
    ) -> object | None:
        """v1: invoke a `mode.*` hook for the plugin that owns `mode_id`."""

        from ...core.modes import mode_plugin_id  # noqa: PLC0415

        plugin_id = mode_plugin_id(mode_id)
        if not plugin_id:
            return None
        entry = self._registry.get(plugin_id)
        if entry is None or hook not in entry.hooks:
            return None
        output, _granted = await self.invoke_hook(plugin_id, hook, req)
        return output

    async def mode_mock_fallback(self, task_id: str, input: object) -> object | None:
        """v1: MockRuntime fallback — `mode.mock` for plugin interview modes."""

        from ...core.modes import is_mode_id, mode_plugin_id  # noqa: PLC0415

        match = re.fullmatch(r"(interviewer|answer-evaluator)\.(.+)", task_id)
        if match is None:
            return None
        kind, mode_id = match[1], match[2]
        if not is_mode_id(mode_id):
            return None
        plugin_id = mode_plugin_id(mode_id)
        if not plugin_id:
            return None
        entry = self._registry.get(plugin_id)
        if entry is None or "mode.mock" not in entry.hooks:
            return None
        row = await self._ensure_install_row(entry)
        granted = [p for p in row.granted_permissions if p in entry.manifest.permissions]
        # Hook requests never carry answer text/code/fields unless answers.read granted.
        safe_input: dict[str, Any] = dict(input) if isinstance(input, Mapping) else {}
        if Permission.ANSWERS_READ not in granted:
            safe_input.pop("answer", None)
            safe_input.pop("code", None)
            safe_input.pop("fields", None)
        # Generic interviewer mocks need the selected skill's taxonomy keywords.
        if kind == "interviewer" and isinstance(safe_input.get("skillId"), str):
            node = taxonomy.get_node(safe_input["skillId"])
            safe_input["skillKeywords"] = list(node.keywords) if node is not None else []
        try:
            output, _granted = await self.invoke_hook(
                plugin_id,
                "mode.mock",
                {
                    "modeId": mode_id,
                    "task": "interviewer" if kind == "interviewer" else "evaluator",
                    "input": safe_input,
                },
            )
        except Exception as err:  # noqa: BLE001 - fallback keeps MockRuntime's own error
            self._ctx.logger.warn(
                "plugin.mode_mock_failed",
                {"plugin": plugin_id, "taskId": task_id, "error": str(err)[:200]},
            )
            return None
        return output.get("output") if isinstance(output, Mapping) else None

    def _check_capability_hooks(
        self, manifest: SkillManifest, directory: str | None, hooks: list[str]
    ) -> None:
        """Plugin API v1: every declared capability must be backed by a hook."""

        caps = manifest.capabilities or []
        declared = manifest.hooks is not None or len(hooks) > 0
        for hook in manifest.hooks or []:
            if not is_plugin_hook_name(hook):
                raise AppError(
                    "PLUGIN_INSTALL", f'plugin "{manifest.id}" declares unknown hook "{hook}"'
                )
        if not caps:
            return

        def ship(sub: str) -> bool:
            return directory is not None and (Path(directory) / "packs" / sub).exists()

        ships_company = ship("companies")
        ships_roles = ship("roles")
        if ships_company and PluginCapability.COMPANY_PACK not in caps:
            raise AppError(
                "PLUGIN_INSTALL",
                f'plugin "{manifest.id}" ships packs/companies but lacks the company_pack '
                "capability",
            )
        if ships_roles and PluginCapability.ROLE_PACK not in caps:
            raise AppError(
                "PLUGIN_INSTALL",
                f'plugin "{manifest.id}" ships packs/roles but lacks the role_pack capability',
            )

        def backs(cap: PluginCapability) -> bool:
            if not declared:
                return True  # legacy execute is the catch-all
            if cap == PluginCapability.INTERVIEW:
                return len(manifest.interview_modes or []) > 0 or "questions.suggest" in hooks
            if cap == PluginCapability.INTERVIEW_MODE:
                return len(manifest.modes or []) > 0 or any(
                    h in hooks for h in _capability_hooks(cap)
                )
            if cap == PluginCapability.COMPANY_PACK:
                return ships_company
            if cap == PluginCapability.ROLE_PACK:
                return ships_roles
            if cap == PluginCapability.UI:
                # A `ui` section (declarative blocks or a frame) backs the
                # capability on its own; a ui.render/ui.frameRun hook is optional.
                return manifest.ui is not None or any(h in hooks for h in _capability_hooks(cap))
            return any(h in hooks for h in _capability_hooks(cap))

        for cap in caps:
            if backs(cap):
                continue
            if cap == PluginCapability.INTERVIEW:
                expected = "interviewModes or questions.suggest"
            elif cap == PluginCapability.INTERVIEW_MODE:
                expected = "modes or mode.* hooks"
            elif cap == PluginCapability.COMPANY_PACK:
                expected = "packs/companies/"
            elif cap == PluginCapability.ROLE_PACK:
                expected = "packs/roles/"
            elif cap == PluginCapability.UI:
                expected = 'a "ui" section or ui.render / ui.frameRun'
            else:
                expected = ", ".join(_capability_hooks(cap))
            raise AppError(
                "PLUGIN_INSTALL",
                f'plugin "{manifest.id}" declares capability "{cap.value}" with no hook backing '
                f"it (need one of: {expected})",
            )

        if not declared:
            self._ctx.logger.warn(
                "plugin.hooks_undeclared",
                {
                    "plugin": manifest.id,
                    "detail": "legacy execute assumed to cover declared capabilities; declare "
                    "`hooks` in skill.yaml",
                },
            )

    def list_skill_manifests(self) -> list[SkillManifest]:
        return self._ctx.host.manifests()

    def platform_info(self) -> dict[str, Any]:
        """v1.1: the plugin-api surface (GET /api/platform)."""

        hooks = []
        for name in PLUGIN_HOOK_NAMES:
            spec = PLUGIN_HOOKS[name]
            hooks.append(
                {
                    "name": name,
                    "capability": spec.capability.value if spec.capability is not None else None,
                    "since": spec.since,
                    "description": spec.description,
                }
            )
        return {
            "apiVersion": PLUGIN_API_VERSION,
            "hooks": hooks,
            "events": list(PLUGIN_EVENT_NAMES),
            "capabilities": [cap.value for cap in PluginCapability],
            "permissions": [permission.value for permission in Permission],
            "uiSlots": list(PLUGIN_UI_SLOTS),
            "answerFieldTypes": list(ANSWER_FIELD_TYPES),
            "manifestFeatures": [
                {"feature": feature, "since": since}
                for feature, since in MANIFEST_FEATURE_SINCE.items()
            ],
        }

    # ------------------------------------------------------------ install rows

    async def _ensure_install_row(self, entry: _RegistryEntry) -> Any:
        existing = self._ctx.store.get_plugin_install(entry.manifest.id)
        if existing is not None:
            return existing
        row = _install_row(
            plugin_id=entry.manifest.id,
            enabled=0 if entry.source == "git" else 1,
            granted_permissions=[] if entry.source == "git" else _auto_grantable(entry.manifest),
            source="bundled" if entry.source == "memory" else entry.source,
            dir_name=Path(entry.dir).name if entry.dir else None,
            installed_at=self._ctx.iso(),
            updated_at=self._ctx.iso(),
        )
        self._ctx.store.upsert_plugin_install(row)
        return row

    async def list_plugins(self) -> list[PluginView]:
        views: list[PluginView] = []
        for entry in self._registry.values():
            row = await self._ensure_install_row(entry)
            granted = [p for p in row.granted_permissions if p in entry.manifest.permissions]
            dir_name = Path(entry.dir).name if entry.dir else None
            views.append(
                PluginView(
                    manifest=entry.manifest,
                    enabled=row.enabled == 1,
                    granted_permissions=granted,
                    source=entry.source,
                    compatible=is_manifest_compatible(entry.manifest),
                    permissions=describe_permissions(
                        entry.manifest, granted, enabled=row.enabled == 1
                    ),
                    load_error=next(
                        (e.error for e in self._load_errors if e.dir == dir_name), None
                    ),
                )
            )
        return views

    async def set_plugin_enabled(
        self,
        id: str,
        enabled: bool,
        granted_permissions: list[Permission] | None = None,
    ) -> PluginView:
        entry = self._registry.get(id)
        if entry is None:
            raise AppError("NOT_FOUND", f'unknown plugin "{id}"')
        row = await self._ensure_install_row(entry)
        if granted_permissions is not None:
            allowed = set(entry.manifest.permissions)
            bad = next((p for p in granted_permissions if p not in allowed), None)
            if bad is not None:
                raise AppError(
                    "VALIDATION", f'grant "{bad.value}" is not requested by plugin "{id}"'
                )
        granted = (
            granted_permissions
            if granted_permissions is not None
            else (_auto_grantable(entry.manifest) if enabled else list(row.granted_permissions))
        )
        self._ctx.store.upsert_plugin_install(
            _install_row(
                plugin_id=id,
                enabled=1 if enabled else 0,
                granted_permissions=granted,
                source=row.source,
                dir_name=row.dir_name,
                installed_at=row.installed_at,
                updated_at=self._ctx.iso(),
                source_url=row.source_url,
            )
        )
        self._ctx.bump_ui_epoch()
        await self.sync_plugin_modes()
        await self.sync_plugin_packs()
        view = next((v for v in await self.list_plugins() if v.manifest.id == id), None)
        if view is None:
            raise AppError("INTERNAL", f'plugin "{id}" view missing')
        return view

    # --------------------------------------------------------- invocation

    async def _invoke_plugin_internal(
        self,
        id: str,
        request: object,
        *,
        hook: str | None = None,
        hook_request: object | None = None,
    ) -> tuple[object, list[Permission], str | None]:
        slices, granted, candidate_id, entry = await self._assemble_slices(id, request)
        output = await self._ctx.host.invoke_plugin(
            id,
            slices,
            await self._ctx.ctx(),
            granted=tuple(granted),
            hook=hook,
            hook_request=hook_request,
            settings=await self.get_plugin_settings(entry.manifest.id),
            storage=_PluginKv(self._ctx, entry.manifest.id),
        )
        return output, granted, candidate_id

    async def invoke_hook(
        self, id: str, hook: str, req: object
    ) -> tuple[object, list[Permission]]:
        """Plugin API v1: invoke a typed hook (request + response validated)."""

        spec = PLUGIN_HOOKS.get(hook)
        if spec is None:
            raise PluginError("PLUGIN_OUTPUT", f'plugin "{id}" hook "{hook}" is unknown')
        try:
            validated = spec.request.model_validate(req)
        except ValidationError as err:
            raise PluginError(
                "PLUGIN_OUTPUT", f'plugin "{id}" hook "{hook}" request failed validation'
            ) from err
        request_obj = validated.model_dump(by_alias=True, mode="json")
        legacy_request = {**request_obj, "kind": LEGACY_HOOK_KIND[hook]}
        entry = self._registry.get(id)
        declared = entry is not None and hook in entry.hooks
        output, granted, _candidate = await self._invoke_plugin_internal(
            id, legacy_request, hook=hook, hook_request=request_obj
        )
        if declared:
            try:
                parsed = spec.response.model_validate(output)
            except ValidationError as err:
                raise PluginError(
                    "PLUGIN_OUTPUT", f'plugin "{id}" hook "{hook}" returned an invalid response'
                ) from err
            return parsed.model_dump(by_alias=True, mode="json"), granted
        return output, granted

    async def _enabled_with_capability(self, cap: PluginCapability) -> list[_RegistryEntry]:
        found: list[_RegistryEntry] = []
        for entry in self._registry.values():
            if cap not in (entry.manifest.capabilities or []):
                continue
            if not is_manifest_compatible(entry.manifest):
                continue
            row = await self._ensure_install_row(entry)
            if row.enabled == 1:
                found.append(entry)
        return found

    @staticmethod
    def _matches_skill_prefix(manifest: SkillManifest, skill_id: str) -> bool:
        prefixes = manifest.applies_to.skill_prefixes if manifest.applies_to is not None else None
        if not prefixes:
            return True
        return any(
            skill_id == prefix or skill_id.startswith(f"{prefix}.") or skill_id.startswith(prefix)
            for prefix in prefixes
        )

    async def _assemble_slices(
        self, id: str, request: object
    ) -> tuple[PluginStateSlices, list[Permission], str | None, _RegistryEntry]:
        entry = self._registry.get(id)
        if entry is None:
            raise AppError("NOT_FOUND", f'unknown plugin "{id}"')
        row = await self._ensure_install_row(entry)
        if row.enabled != 1:
            raise PluginError("PLUGIN_DISABLED", f'plugin "{id}" is disabled')
        granted = [p for p in row.granted_permissions if p in entry.manifest.permissions]

        candidate_row = self._ctx.store.get_active_candidate()
        target_row = self._ctx.store.get_active_target()
        slices: dict[str, object] = {}
        if candidate_row is not None:
            try:
                slices["candidate"] = CandidateProfile.model_validate(candidate_row.data)
            except ValidationError:
                pass
            slices["stories"] = self._ctx.store.list_stories(candidate_row.id)
            slices["resume"] = candidate_row.resume_text
        if target_row is not None:
            try:
                slices["target"] = TargetRole.model_validate(target_row.data)
            except ValidationError:
                pass
        if candidate_row is not None and target_row is not None:
            graph = await self._deps_graph_for_active()
            slices["readiness"] = graph.dimensions
            slices["gaps"] = await self._deps_calculate_gaps()
        evaluations = self._ctx.store.list_all_evaluations()
        slices["recentEvaluations"] = [e.data for e in evaluations][-20:]
        slices["request"] = request
        return slices, granted, candidate_row.id if candidate_row is not None else None, entry

    async def run_plugin_output(self, id: str, request: object | None = None) -> object:
        """v0.4: run a plugin for its output only (evidence is ignored)."""

        output, _granted, _candidate = await self._invoke_plugin_internal(id, request)
        return output

    async def run_plugin(self, id: str, request: object | None = None) -> PluginRunResult:
        """§9.6: run a plugin against its effective (manifest ∩ granted) slices."""

        output, granted, candidate_id = await self._invoke_plugin_internal(id, request)
        proposals = plugin_evidence_proposals(output)
        result = PluginRunResult(output=output)
        if proposals is None:
            result.evidence_rejected = "evidenceProposals failed schema validation"
            return result
        if not proposals:
            return result
        if Permission.EVIDENCE_WRITE not in granted:
            result.evidence_ignored = len(proposals)
            return result
        self._ctx.host.assert_can(id, Permission.EVIDENCE_WRITE, tuple(granted))
        created_at = self._ctx.iso()
        for proposal in proposals:
            self._ctx.register_skill_node(proposal.skill_id)
            self._ctx.store.insert_evidence(
                id=new_id("ev"),
                candidate_id=candidate_id,
                skill_id=proposal.skill_id,
                type="plugin",
                score=proposal.score,
                confidence=min(proposal.confidence, PLUGIN_EVIDENCE_CONFIDENCE_CAP),
                observation=f"[plugin:{id}] {proposal.observation}"[:600],
                session_id=None,
                question_id=None,
                source=f"plugin:{id}",
                created_at=created_at,
            )
            result.evidence_written += 1
        self._ctx.bump_ui_epoch()
        await self._deps_recompute_readiness(f"plugin:{id}")
        return result

    # ------------------------------------------------------------- v0.4 UI

    def invalidate_ui_cache(self) -> None:
        self._ui_render_cache.clear()

    async def render_plugin_ui(self, id: str, req: PluginUIRenderRequest) -> UINode:
        entry = self._registry.get(id)
        if entry is None:
            raise AppError("NOT_FOUND", f'unknown plugin "{id}"')
        if not is_manifest_compatible(entry.manifest):
            engines = entry.manifest.engines
            required = engines.interview_os if engines is not None else None
            raise PluginError(
                "PLUGIN_INCOMPATIBLE",
                f'plugin "{id}" requires interview-os {required}',
            )
        ui = entry.manifest.ui
        if ui is None:
            raise AppError("VALIDATION", f'plugin "{id}" declares no ui contributions')
        kind: str | None = None
        if req.page is not None:
            page = next(
                (p for p in ui.pages if p.path == req.page and p.component == req.component), None
            )
            kind = page.kind if page is not None else None
        elif req.slot:
            contributions = next((v for k, v in ui.slots.items() if str(k) == req.slot), None)
            if contributions is not None:
                kind = next(
                    (c.kind for c in contributions if c.component == req.component), None
                )
        if kind is None:
            where = f'slot "{req.slot}"' if req.slot else f'page "{req.page or ""}"'
            raise AppError(
                "VALIDATION",
                f'plugin "{id}" does not declare component "{req.component}" for {where}',
            )
        if kind != "declarative":
            raise AppError(
                "VALIDATION",
                f'component "{req.component}" is kind "{kind}" — only declarative contributions '
                "render via this endpoint",
            )
        params = req.params
        if params is None:
            # Declarative contributions get the slices they declared (and the user
            # granted) from the host — unlike frames they have no bridge to ask.
            params = await self._declared_slices(
                id,
                {"kind": "ui", "slot": req.slot, "component": req.component, "page": req.page},
            )
        params_dump = json.dumps(params, default=str)
        key = "|".join([id, req.slot or "", req.page or "", req.component, params_dump])
        hit = self._ui_render_cache.get(key)
        if hit is not None and hit.epoch == self._ctx.ui_epoch and (
            time.time() * 1000 - hit.at < _UI_CACHE_TTL_MS
        ):
            return hit.tree
        output, _granted = await self.invoke_hook(
            id,
            "ui.render",
            {
                "slot": req.slot,
                "component": req.component,
                "page": req.page,
                "params": params,
            },
        )
        raw_tree = output.get("ui") if isinstance(output, Mapping) else None
        try:
            tree = cast("UINode", validate_ui_tree(raw_tree, plugin_id=id))
        except ValueError as err:
            raise PluginError(
                "PLUGIN_OUTPUT",
                f'plugin "{id}" returned an invalid ui tree: {str(err)[:300]}',
            ) from err
        self._ui_render_cache[key] = _UICacheEntry(
            tree=tree, epoch=self._ctx.ui_epoch, at=time.time() * 1000
        )
        return tree

    async def list_ui_contributions(self) -> list[PluginUIContributionView]:
        views: list[PluginUIContributionView] = []
        for entry in self._registry.values():
            if not is_manifest_compatible(entry.manifest):
                continue
            row = await self._ensure_install_row(entry)
            if row.enabled != 1:
                continue
            manifest = entry.manifest
            if (
                manifest.ui is None
                and not (manifest.interview_modes or [])
                and not (manifest.modes or [])
            ):
                continue
            ui = manifest.ui
            views.append(
                PluginUIContributionView(
                    plugin_id=manifest.id,
                    plugin_name=manifest.name or manifest.id,
                    navigation=list(ui.navigation) if ui is not None else [],
                    commands=list(ui.commands) if ui is not None else [],
                    slots={str(k): list(v) for k, v in ui.slots.items()} if ui is not None else {},
                    pages=list(ui.pages) if ui is not None else [],
                    interview_modes=list(manifest.interview_modes or []),
                    modes=[m.id for m in manifest.modes or []],
                )
            )
        return views

    async def resolve_ui_frame(self, id: str, sel: UIFrameSelector) -> ResolvedUIFrame:
        entry = self._registry.get(id)
        if entry is None:
            raise AppError("NOT_FOUND", f'unknown plugin "{id}"')
        row = await self._ensure_install_row(entry)
        if row.enabled != 1:
            raise PluginError("PLUGIN_DISABLED", f'plugin "{id}" is disabled')
        if not is_manifest_compatible(entry.manifest):
            engines = entry.manifest.engines
            required = engines.interview_os if engines is not None else None
            raise PluginError(
                "PLUGIN_INCOMPATIBLE", f'plugin "{id}" requires interview-os {required}'
            )
        ui = entry.manifest.ui
        found: Any = None
        if sel.page is not None:
            found = next(
                (
                    p
                    for p in (ui.pages if ui is not None else [])
                    if p.path == sel.page
                    and (sel.component is None or p.component == sel.component)
                ),
                None,
            )
        elif sel.component is not None:
            for contributions in (ui.slots.values() if ui is not None else []):
                found = next((x for x in contributions if x.component == sel.component), None)
                if found is not None:
                    break
        if found is None or found.kind != "frame" or not found.entry or not entry.dir:
            if sel.page is not None:
                where = f'page "{sel.page}"'
            else:
                where = f'component "{sel.component or ""}"'
            raise AppError(
                "NOT_FOUND", f'plugin "{id}" declares no frame contribution for {where}'
            )
        return ResolvedUIFrame(
            dir=entry.dir,
            entry=found.entry,
            component=found.component,
            page=sel.page,
            title=found.title,
        )

    async def resolve_ui_asset_dir(self, id: str) -> str:
        entry = self._registry.get(id)
        if entry is None or not entry.dir:
            raise AppError("NOT_FOUND", f'unknown plugin "{id}"')
        row = await self._ensure_install_row(entry)
        if row.enabled != 1:
            raise PluginError("PLUGIN_DISABLED", f'plugin "{id}" is disabled')
        if not is_manifest_compatible(entry.manifest):
            engines = entry.manifest.engines
            required = engines.interview_os if engines is not None else None
            raise PluginError(
                "PLUGIN_INCOMPATIBLE", f'plugin "{id}" requires interview-os {required}'
            )
        return str(Path(entry.dir) / "ui")

    async def plugin_ui_data(self, id: str, sel: UIFrameSelector) -> dict[str, object]:
        await self.resolve_ui_frame(id, sel)
        return await self._declared_slices(
            id, {"kind": "ui-frame", "component": sel.component, "page": sel.page}
        )

    async def _declared_slices(self, id: str, request: object) -> dict[str, object]:
        """The manifest's declared inputs ∩ the user's grants, as plain JSON data.

        Frames pull these through their own `getData()` bridge; declarative
        contributions have no bridge, so the host hands them over directly.
        """

        slices, granted, _candidate, entry = await self._assemble_slices(id, request)
        granted_set = set(granted)
        out: dict[str, object] = {}
        for declared in entry.manifest.inputs:
            if declared.permission in granted_set:
                out[declared.key] = dump_json(slices.get(declared.key))
        out["settings"] = await self.get_plugin_settings(id)
        return out

    async def plugin_ui_run(self, id: str, sel: UIFrameRunSelector) -> PluginUIRunResult:
        frame = await self.resolve_ui_frame(
            id, UIFrameSelector(component=sel.component, page=sel.page)
        )
        output, _granted = await self.invoke_hook(
            id,
            "ui.frameRun",
            {"component": frame.component, "page": frame.page, "request": sel.request},
        )
        obj = output if isinstance(output, Mapping) else None
        is_envelope = obj is not None and "output" in obj
        result = PluginUIRunResult(output=obj["output"] if is_envelope and obj else output)
        ui_source = (obj if is_envelope else output) if isinstance(obj, Mapping) else None
        ui = ui_source.get("ui") if isinstance(ui_source, Mapping) else None
        if ui is not None:
            try:
                result.ui = validate_ui_tree(ui, plugin_id=id)
            except ValueError:
                pass  # invalid ui trees are simply not forwarded to the frame
        return result

    async def plugin_interview_mode(self, plugin_mode_id: str) -> PluginInterviewModeRef:
        idx = plugin_mode_id.find(":")
        if idx <= 0:
            raise AppError(
                "VALIDATION",
                f'pluginModeId must be "<pluginId>:<modeId>" (got "{plugin_mode_id}")',
            )
        plugin_id = plugin_mode_id[:idx]
        mode_id = plugin_mode_id[idx + 1 :]
        entry = self._registry.get(plugin_id)
        if entry is None:
            raise AppError("NOT_FOUND", f'unknown plugin "{plugin_id}"')
        mode = next((m for m in entry.manifest.interview_modes or [] if m.id == mode_id), None)
        if mode is None:
            raise AppError(
                "VALIDATION",
                f'plugin "{plugin_id}" declares no interview mode "{mode_id}"',
            )
        row = await self._ensure_install_row(entry)
        if row.enabled != 1:
            raise PluginError("PLUGIN_DISABLED", f'plugin "{plugin_id}" is disabled')
        if not is_manifest_compatible(entry.manifest):
            engines = entry.manifest.engines
            required = engines.interview_os if engines is not None else None
            raise PluginError(
                "PLUGIN_INCOMPATIBLE", f'plugin "{plugin_id}" requires interview-os {required}'
            )
        return PluginInterviewModeRef(plugin_id=plugin_id, mode=mode)

    # ----------------------------------------------------------------- packs

    async def sync_plugin_packs(self) -> None:
        """§4: sync plugin-shipped packs into the PackRegistry."""

        dirs: list[tuple[str, Path]] = []
        for entry in self._registry.values():
            if not entry.dir:
                continue
            caps = entry.manifest.capabilities or []
            if (
                PluginCapability.COMPANY_PACK not in caps
                and PluginCapability.ROLE_PACK not in caps
            ):
                continue
            if not is_manifest_compatible(entry.manifest):
                continue
            row = await self._ensure_install_row(entry)
            if row.enabled == 1:
                dirs.append((entry.manifest.id, Path(entry.dir)))
        packs = self._ctx.packs
        if packs is None:
            return
        packs.set_plugin_dirs(dirs)
        packs.reload()

    async def find_plugins_by_capability(self, cap: PluginCapability) -> list[SkillManifest]:
        found: list[SkillManifest] = []
        for entry in self._registry.values():
            if cap not in (entry.manifest.capabilities or []):
                continue
            if not is_manifest_compatible(entry.manifest):
                continue
            row = await self._ensure_install_row(entry)
            if row.enabled == 1:
                found.append(entry.manifest)
        return found

    async def enabled_capability_ids(self, cap: PluginCapability) -> list[str]:
        return [manifest.id for manifest in await self.find_plugins_by_capability(cap)]

    # ------------------------------------------------------- install/uninstall

    def _require_dirs(self) -> PluginDirs:
        if self._deps_plugin_dirs is None:
            raise AppError(
                "PLUGIN_INSTALL",
                "plugin install/uninstall requires configured plugin directories",
            )
        return self._deps_plugin_dirs

    async def install_plugin_from_git(self, url: str) -> PluginView:
        """Install a plugin from a git remote (https) or a local git checkout path."""

        dirs = self._require_dirs()
        validate_git_source(url)
        is_local = os.path.isabs(url)

        installed = Path(dirs.installed)
        installed.mkdir(parents=True, exist_ok=True)
        tmp = Path(dirs.installed) / f".tmp-{int(time.time() * 1000)}-{os.urandom(3).hex()}"
        try:
            await clone_shallow(url, tmp)
        except BaseException:
            shutil.rmtree(tmp, ignore_errors=True)
            raise

        try:
            manifest = _load_manifest_file(str(tmp))
            if manifest.id in self._registry or any(
                m.id == manifest.id for m in self._ctx.host.manifests()
            ):
                raise AppError(
                    "PLUGIN_INSTALL", f'a skill or plugin with id "{manifest.id}" already exists'
                )
            entry_file = _find_entry_file(str(tmp))
            if entry_file is None:
                raise AppError(
                    "PLUGIN_INSTALL", f'plugin "{manifest.id}" has no main.py entry'
                )
            loaded_modes = _load_plugin_mode_prompts(str(tmp), manifest)
            dest = Path(dirs.installed) / manifest.id
            shutil.rmtree(tmp / ".git", ignore_errors=True)
            shutil.rmtree(dest, ignore_errors=True)
            tmp.rename(dest)

            from ...plugins.inproc import PythonPluginExecutor, load_python_plugin

            instance, module = load_python_plugin(dest, entry_file)

            self._ctx.store.upsert_plugin_install(
                _install_row(
                    plugin_id=manifest.id,
                    enabled=0,
                    granted_permissions=[],
                    source="git",
                    dir_name=manifest.id,
                    installed_at=self._ctx.iso(),
                    updated_at=self._ctx.iso(),
                    source_url=None if is_local else url,
                )
            )
            self.register_plugin(
                manifest,
                PythonPluginExecutor(instance, module),
                PluginRegistrationMeta(
                    dir=str(dest),
                    entry_file=entry_file,
                    source="git",
                    hooks=list(manifest.hooks or ()),
                    loaded_modes=loaded_modes,
                ),
            )
            if manifest.taxonomy:
                taxonomy.register_nodes(
                    [
                        _taxonomy_seed(node.id, node.label, node.keywords)
                        for node in manifest.taxonomy
                    ]
                )
                for node in manifest.taxonomy:
                    self._ctx.register_skill_node(node.id)
            self._ctx.logger.info("plugin.installed", {"plugin": manifest.id})
            self._ctx.bump_ui_epoch()
            await self.sync_plugin_modes()
            await self.sync_plugin_packs()
            view = next(
                (v for v in await self.list_plugins() if v.manifest.id == manifest.id), None
            )
            if view is None:
                raise AppError("INTERNAL", "installed plugin missing")
            return view
        except BaseException as err:
            shutil.rmtree(tmp, ignore_errors=True)
            if isinstance(err, AppError):
                raise
            raise AppError("PLUGIN_INSTALL", f"invalid plugin: {str(err)[:200]}") from err

    async def uninstall_plugin(self, id: str) -> None:
        """Remove a git-installed plugin; bundled plugins cannot be uninstalled."""

        self._require_dirs()
        entry = self._registry.get(id)
        if entry is None:
            raise AppError("NOT_FOUND", f'unknown plugin "{id}"')
        row = self._ctx.store.get_plugin_install(id)
        source = row.source if row is not None else entry.source
        if source != "git":
            raise AppError("VALIDATION", f'plugin "{id}" is bundled and cannot be uninstalled')
        if entry.dir:
            shutil.rmtree(entry.dir, ignore_errors=True)
        self._ctx.store.delete_plugin_install(id)
        self._ctx.host.unregister(id)
        self._registry.pop(id, None)
        from ...core.modes import unregister_plugin_modes  # noqa: PLC0415

        unregister_plugin_modes(id)
        self._ctx.logger.info("plugin.uninstalled", {"plugin": id})
        self._ctx.bump_ui_epoch()
        await self.sync_plugin_modes()
        await self.sync_plugin_packs()

    # ------------------------------------------ §3 plugin settings + storage

    def _entry_for(self, id: str) -> _RegistryEntry:
        entry = self._registry.get(id)
        if entry is None:
            raise AppError("NOT_FOUND", f'unknown plugin "{id}"')
        return entry

    def plugin_settings_spec(self, id: str) -> list[PluginSettingField]:
        return list(self._entry_for(id).manifest.settings or [])

    async def get_plugin_settings(self, id: str) -> dict[str, object]:
        fields = self.plugin_settings_spec(id)
        stored = self._ctx.store.get_plugin_settings(id)
        out: dict[str, object] = {}
        for field_ in fields:
            value = stored.get(field_.key)
            out[field_.key] = value if value is not None else field_.default
        return out

    async def set_plugin_settings(
        self, id: str, values: Mapping[str, object]
    ) -> dict[str, object]:
        fields = self.plugin_settings_spec(id)
        by_key = {field_.key: field_ for field_ in fields}
        for key, value in values.items():
            field_ = by_key.get(key)
            if field_ is None:
                raise AppError("VALIDATION", f'plugin "{id}" declares no setting "{key}"')
            error = _setting_value_error(field_, value)
            if error is not None:
                raise AppError("VALIDATION", f'setting "{key}": {error}')
            self._ctx.store.set_plugin_setting(id, key, value)
        return await self.get_plugin_settings(id)

    def _storage_for(self, id: str) -> PluginKvStorage:
        return _PluginKv(self._ctx, id)

    # ------------------------------------------ §2 evaluation.review

    async def evaluation_reviews(self, args: EvaluationReviewsArgs) -> list[PluginReview]:
        """Ask enabled `evaluation` plugins for review observations (10 s each)."""

        plugins = await self._enabled_with_capability(PluginCapability.EVALUATION)
        candidates = [
            e for e in plugins if self._matches_skill_prefix(e.manifest, args.question.skill_id)
        ]
        if not candidates:
            return []
        results = await asyncio.gather(*(self._review_one(entry, args) for entry in candidates))
        return [review for review in results if review is not None]

    async def _review_one(
        self, entry: _RegistryEntry, args: EvaluationReviewsArgs
    ) -> PluginReview | None:
        id = entry.manifest.id
        row = await self._ensure_install_row(entry)
        granted = [p for p in row.granted_permissions if p in entry.manifest.permissions]
        if (
            Permission.ANSWERS_READ in granted
            and Permission.ANSWERS_READ in entry.manifest.permissions
        ):
            answer: object = {
                "text": args.answer.text[:50_000],
                "code": args.answer.code[:100_000] if args.answer.code else None,
                "language": args.answer.language,
                "fields": args.answer.fields,
            }
        else:
            answer = None
        req = {
            "question": args.question.model_dump(by_alias=True, mode="json"),
            "evaluation": args.evaluation.model_dump(by_alias=True, mode="json"),
            "answer": answer,
        }
        try:
            output, _granted = await asyncio.wait_for(
                self.invoke_hook(id, "evaluation.review", req),
                timeout=10.0,
            )
        except Exception as err:  # noqa: BLE001 - one plugin must not break the review
            self._ctx.logger.warn(
                "plugin.review_failed", {"plugin": id, "error": str(err)[:200]}
            )
            return None
        response = output if isinstance(output, Mapping) else {}
        return PluginReview(
            plugin_id=id,
            plugin_name=entry.manifest.name or id,
            observations=list(response.get("observations") or []),
            evidence_proposals=list(response.get("evidenceProposals") or []),
            evidence_granted=Permission.EVIDENCE_WRITE in granted,
        )

    # ------------------------------------------ §2 preparation.suggest

    async def plugin_prep_suggestions(self) -> list[PluginPrepSuggestionGroup]:
        plugins = await self._enabled_with_capability(PluginCapability.PREPARATION)
        if not plugins:
            return []
        gaps: list[Gap] = []
        skill_ids: list[str] = []
        try:
            gaps = await self._deps_calculate_gaps()
            skill_ids = [gap.skill_id for gap in gaps]
        except Exception:  # noqa: BLE001 - no active candidate/target: empty context
            gaps = []
            skill_ids = []
        results = await asyncio.gather(
            *(self._prep_suggestion_one(entry, gaps, skill_ids) for entry in plugins)
        )
        return [group for group in results if group is not None]

    async def _prep_suggestion_one(
        self, entry: _RegistryEntry, gaps: list[Gap], skill_ids: list[str]
    ) -> PluginPrepSuggestionGroup | None:
        id = entry.manifest.id
        req = {
            "gaps": [gap.model_dump(by_alias=True, mode="json") for gap in gaps[:10]],
            "skillIds": skill_ids,
        }
        try:
            output, _granted = await asyncio.wait_for(
                self.invoke_hook(id, "preparation.suggest", req),
                timeout=10.0,
            )
        except Exception as err:  # noqa: BLE001 - one plugin must not break the list
            self._ctx.logger.warn(
                "plugin.prep_suggest_failed", {"plugin": id, "error": str(err)[:200]}
            )
            return None
        response = output if isinstance(output, Mapping) else {}
        return PluginPrepSuggestionGroup(
            plugin_id=id,
            plugin_name=entry.manifest.name or id,
            activities=list(response.get("activities") or []),
        )

    async def accept_plugin_suggestion(
        self, plugin_id: str, activity: object
    ) -> AcceptPluginSuggestionResult:
        """Persist an accepted suggestion as a prep action (`source: "plugin:<id>"`)."""

        self._entry_for(plugin_id)  # 404 unknown
        try:
            parsed = PluginPrepActivity.model_validate(activity)
        except ValidationError as err:
            raise AppError(
                "VALIDATION", "activity does not match the preparation.suggest contract"
            ) from err
        candidate = self._ctx.store.get_active_candidate()
        target = self._ctx.store.get_active_target()
        if candidate is None or target is None:
            raise AppError("VALIDATION", "no active candidate/target")
        row_id = new_id("action")
        self._ctx.store.insert_action(
            id=row_id,
            skill_id=parsed.skill_id,
            target_id=target.id,
            priority=0,
            reason=f"Suggested by plugin {plugin_id}",
            action=f"{parsed.title} — {parsed.action}"[:1000],
            success_criteria=list(parsed.success_criteria or []),
            status="open",
            severity="medium",
            source_evidence_ids=[],
            resources=[],
            source=f"plugin:{plugin_id}",
            created_at=self._ctx.iso(),
        )
        self._ctx.logger.info(
            "state.mutated",
            {"entity": "prep_action", "id": row_id, "source": f"plugin:{plugin_id}"},
        )
        return AcceptPluginSuggestionResult(id=row_id)

    # ------------------------------------------ §2 lifecycle events

    async def fire_plugin_event(
        self, name: str, payload: object
    ) -> list[dict[str, object]]:
        """Fire a lifecycle event hook at subscribed plugins (sequential)."""

        results: list[dict[str, object]] = []
        short = re.sub(r"^events\.", "", name)
        for entry in self._registry.values():
            if short not in (entry.manifest.events or []):
                continue
            if not is_manifest_compatible(entry.manifest):
                continue
            row = await self._ensure_install_row(entry)
            if row.enabled != 1:
                continue
            id = entry.manifest.id
            try:
                output, _granted = await asyncio.wait_for(
                    self.invoke_hook(id, name, payload),
                    timeout=10.0,
                )
            except Exception as err:  # noqa: BLE001 - events are fire-and-forget
                self._ctx.logger.warn(
                    "plugin.event_failed", {"plugin": id, "event": name, "error": str(err)[:200]}
                )
                continue
            proposals = output.get("evidenceProposals") if isinstance(output, Mapping) else None
            if isinstance(proposals, list) and proposals:
                results.append({"pluginId": id, "proposals": proposals})
        return results

    async def persist_plugin_evidence(
        self, id: str, proposals: list[object]
    ) -> PluginEvidenceWriteResult:
        """Persist event/review evidence through the standard gate."""

        parsed = plugin_evidence_proposals({"evidenceProposals": proposals})
        if parsed is None or not parsed:
            return PluginEvidenceWriteResult(written=0, ignored=len(proposals))
        entry = self._entry_for(id)
        row = await self._ensure_install_row(entry)
        granted = [p for p in row.granted_permissions if p in entry.manifest.permissions]
        if Permission.EVIDENCE_WRITE not in granted:
            return PluginEvidenceWriteResult(written=0, ignored=len(parsed))
        self._ctx.host.assert_can(id, Permission.EVIDENCE_WRITE, tuple(granted))
        candidate = self._ctx.store.get_active_candidate()
        created_at = self._ctx.iso()
        written = 0
        for proposal in parsed:
            self._ctx.register_skill_node(proposal.skill_id)
            self._ctx.store.insert_evidence(
                id=new_id("ev"),
                candidate_id=candidate.id if candidate is not None else None,
                skill_id=proposal.skill_id,
                type="plugin",
                score=proposal.score,
                confidence=min(proposal.confidence, PLUGIN_EVIDENCE_CONFIDENCE_CAP),
                observation=f"[plugin:{id}] {proposal.observation}"[:600],
                session_id=None,
                question_id=None,
                source=f"plugin:{id}",
                created_at=created_at,
            )
            written += 1
        if written > 0:
            self._ctx.bump_ui_epoch()
        return PluginEvidenceWriteResult(written=written, ignored=0)


# -------------------------------------------------------- local helper ports


def _capability_hooks(cap: PluginCapability) -> list[str]:
    from ...core.plugin_api import capability_hooks  # noqa: PLC0415

    return capability_hooks(cap)


def _install_row(
    *,
    plugin_id: str,
    enabled: int,
    granted_permissions: list[Permission],
    source: str,
    dir_name: str | None,
    installed_at: str | None,
    updated_at: str | None,
    source_url: str | None = None,
) -> Any:
    from ...store.store import PluginInstallRow  # noqa: PLC0415

    return PluginInstallRow(
        id=plugin_id,
        enabled=enabled,
        granted_permissions=granted_permissions,
        source=source,
        source_url=source_url,
        dir_name=dir_name,
        installed_at=installed_at,
        updated_at=updated_at,
    )


def _taxonomy_seed(node_id: str, label: str, keywords: list[str]) -> Any:
    from ...core.taxonomy_seed import TaxonomyNodeSeed  # noqa: PLC0415

    return TaxonomyNodeSeed(id=node_id, label=label, keywords=keywords)


_COMPARATOR_RE = re.compile(r"^(>=|<=|>|<)?\s*(\d+)\.(\d+)\.(\d+)$")


def _range_lower_bound(range_spec: str | None) -> Semver:
    """Port of `rangeLowerBound`: the lowest version an engines range admits."""

    fallback = Semver(1, 0, 0)
    if range_spec is None:
        return fallback
    minimum = Semver(0, 0, 0)
    for token in re.split(r"\s+", range_spec.strip()):
        if token in ("", "*"):
            continue
        if token.startswith("^") or token.startswith("~"):
            op = token[0]
            version_text = token[1:]
        else:
            match = _COMPARATOR_RE.match(token)
            op = (match[1] if match is not None and match[1] else "") if match else ""
            version_text = f"{match[2]}.{match[3]}.{match[4]}" if match is not None else ""
        if op in ("<", "<="):
            continue
        parsed = parse_version(version_text)
        if parsed is not None and compare_semver(parsed, minimum) > 0:
            minimum = parsed
    if compare_semver(minimum, fallback) < 0 and range_spec.strip() == "":
        return fallback
    return minimum


def plugin_api_feature_warnings(
    manifest: SkillManifest, implemented_hooks: Sequence[str] = ()
) -> list[str]:
    """Port of `pluginApiFeatureWarnings` — purely advisory feature warnings."""

    floor = _range_lower_bound(
        manifest.engines.plugin_api if manifest.engines is not None else None
    )
    features: dict[str, str] = {}

    def mark(name: str, since: str | None) -> None:
        if since is None:
            return
        since_version = parse_version(since)
        if since_version is None:
            return
        current = features.get(name)
        current_version = parse_version(current) if current is not None else None
        if current_version is None or compare_semver(since_version, current_version) > 0:
            features[name] = since

    if manifest.modes:
        mark("modes", "1.1.0")
    for mode in manifest.modes or []:
        if mode.answer_fields:
            mark("modes.answerFields", "1.1.0")
    if manifest.ui is not None:
        question_slot = next(
            (v for k, v in manifest.ui.slots.items() if str(k) == _INTERVIEW_QUESTION_SLOT), None
        )
        if question_slot:
            mark("ui.slots.interview.question", "1.1.0")
    for event in manifest.events or []:
        mark(f"events.{event}", MANIFEST_FEATURE_SINCE.get(f"events.{event}"))
    for hook in dict.fromkeys([*(manifest.hooks or []), *implemented_hooks]):
        if is_plugin_hook_name(hook):
            mark(hook, PLUGIN_HOOKS[hook].since)

    warnings: list[str] = []
    for name in sorted(features):
        since = features[name]
        since_version = parse_version(since)
        if since_version is not None and compare_semver(since_version, floor) > 0:
            warnings.append(
                f'uses "{name}" (requires plugin-api ≥ {since}) but engines["plugin-api"] allows '
                f"≥ {format_semver(floor)} — declare \"plugin-api\": \">={since}\""
            )
    return warnings


def describe_permissions(
    manifest: SkillManifest,
    granted: Sequence[Permission] | None = None,
    *,
    enabled: bool = False,
) -> list[PermissionViewEntry]:
    """Port of `describePermissions`: the fixed permission view for UI inspection."""

    requested = set(manifest.permissions)
    granted_set = set(granted if granted is not None else manifest.permissions)
    view: list[PermissionViewEntry] = []
    for category, reads, writes, invokes in _CATEGORIES:
        wanted = [p for p in (*reads, *writes, *invokes) if p in requested]
        is_granted = len(wanted) > 0 and all(p in granted_set for p in wanted)
        if not is_granted:
            access: PermissionAccess = "DENIED"
        elif invokes:
            access = "INVOKE"
        elif any(p in granted_set for p in writes):
            access = "WRITE"
        else:
            access = "READ"
        view.append(
            PermissionViewEntry(
                category=category,
                access=access,
                requested=len(wanted) > 0,
                granted=is_granted,
            )
        )
    for category in _ISOLATION_DENIED:
        view.append(
            PermissionViewEntry(category=category, access="DENIED", requested=False, granted=False)
        )
    ui = manifest.ui
    if ui is not None or manifest.interview_modes or manifest.modes:
        parts: list[str] = []
        slots = [str(k) for k in ui.slots] if ui is not None else []
        if slots:
            parts.append(f"slots: {', '.join(slots)}")
        if ui is not None and ui.pages:
            parts.append(f"pages: {', '.join(p.path for p in ui.pages)}")
        if ui is not None and ui.commands:
            parts.append(f"commands: {'; '.join(c.label for c in ui.commands)}")
        if ui is not None and ui.navigation:
            parts.append(f"nav: {', '.join(n.label for n in ui.navigation)}")
        if manifest.interview_modes:
            parts.append(
                f"interview modes: {'; '.join(m.label for m in manifest.interview_modes)}"
            )
        if manifest.modes:
            labels = "; ".join(m.label for m in manifest.modes)
            parts.append(f"plugin modes: {labels} (answer scores feed readiness)")
        view.append(
            PermissionViewEntry(
                category="UI Contributions",
                access="UI",
                requested=True,
                granted=enabled,
                detail=" · ".join(parts) or "declared UI contributions",
            )
        )
    return view


# ----------------------------------------- local ports of plugin-SDK loaders

_MANIFEST_YAML = "plugin.yaml"
_MANIFEST_JSON = "manifest.json"
#: dist/index.js (from `interview-os build`) wins over source entries.
PLUGIN_ENTRY_FILES: tuple[str, ...] = (
    "main.py",
    "dist/index.js",
    "index.ts",
    "index.js",
    "index.mjs",
)

_FRAME_ENTRY_RE = re.compile(r"^ui/[a-zA-Z0-9][a-zA-Z0-9._/-]*\.js$")
_PROMPT_MAX_BYTES = 16 * 1024


def _normalize_inputs(raw: object) -> object:
    if not isinstance(raw, list):
        return raw
    out: list[object] = []
    for entry in raw:
        if not isinstance(entry, str):
            out.append(entry)
            continue
        permission = PLUGIN_INPUT_KEYS.get(entry)
        if permission is None:
            raise ValueError(f'unknown plugin input key "{entry}"')
        out.append({"key": entry, "permission": permission.value})
    return out


def _validate_ui_contributions(manifest: SkillManifest) -> None:
    ui = manifest.ui
    if ui is None:
        return
    if PluginCapability.UI not in (manifest.capabilities or []):
        raise ValueError(
            f'plugin "{manifest.id}" declares a "ui" section without the "ui" capability'
        )

    def check_frame(component: str, kind: str, entry: str | None) -> None:
        if kind != "frame":
            return
        if not entry or _FRAME_ENTRY_RE.match(entry) is None or ".." in entry:
            raise ValueError(
                f'plugin "{manifest.id}" frame "{component}" needs a safe entry path '
                f'under ui/ (got "{entry or ""}")'
            )

    for contributions in ui.slots.values():
        for contribution in contributions:
            check_frame(contribution.component, contribution.kind, contribution.entry)
    for page in ui.pages:
        check_frame(page.component, page.kind, page.entry)


def _load_manifest_file(directory: str) -> SkillManifest:
    """Port of `loadManifestFile`: skill.yaml (preferred) or manifest.json."""

    yaml_path = Path(directory) / _MANIFEST_YAML
    text: str | None = None
    try:
        text = yaml_path.read_text(encoding="utf-8")
    except OSError:
        text = None
    if text is not None:
        try:
            raw = yaml.safe_load(text)
        except yaml.YAMLError as err:
            raise ValueError(f"invalid {_MANIFEST_YAML}: {str(err)[:300]}") from err
    else:
        try:
            raw = json.loads((Path(directory) / _MANIFEST_JSON).read_text(encoding="utf-8"))
        except (OSError, ValueError) as err:
            raise ValueError(
                f"missing or invalid {_MANIFEST_YAML}/{_MANIFEST_JSON}: {str(err)[:200]}"
            ) from err
    if not isinstance(raw, dict):
        raise ValueError("plugin manifest must be an object")
    obj: dict[str, object] = {**raw, "kind": "plugin"}
    obj["inputs"] = _normalize_inputs(obj.get("inputs"))
    try:
        manifest = SkillManifest.model_validate(obj)
    except ValidationError as err:
        raise ValueError(f"invalid plugin manifest: {str(err)[:300]}") from err
    if re.fullmatch(SLUG_ID_REGEX, manifest.id) is None:
        raise ValueError(f'plugin id "{manifest.id}" must match {SLUG_ID_REGEX}')
    if manifest.name is None:
        manifest.name = manifest.id
    if not is_valid_version(manifest.version):
        raise ValueError(
            f'plugin "{manifest.id}" version "{manifest.version}" is not valid semver x.y.z'
        )
    _validate_ui_contributions(manifest)
    return manifest


def _find_entry_file(directory: str) -> str | None:
    for name in PLUGIN_ENTRY_FILES:
        if (Path(directory) / name).exists():
            return name
    return None


def _load_plugin_mode_prompts(directory: str, manifest: SkillManifest) -> list[Any]:
    """Port of `loadPluginModePrompts`: read each declared mode's prompt files."""

    from ...core.modes import LoadedPluginMode  # noqa: PLC0415

    base = Path(directory).resolve()
    out: list[Any] = []
    for mode in manifest.modes or []:
        prompts: dict[str, str | None] = {"interviewer": None, "evaluator": None}
        for rel, slot in (
            (mode.interviewer_prompt, "interviewer"),
            (mode.evaluator_prompt, "evaluator"),
        ):
            if not rel:
                continue
            resolved = (Path(directory) / rel).resolve()
            if not str(resolved).startswith(f"{base}{os.sep}"):
                raise ValueError(
                    f'mode "{mode.id}" prompt path "{rel}" escapes the plugin directory'
                )
            if not resolved.is_file() or resolved.stat().st_size > _PROMPT_MAX_BYTES:
                raise ValueError(
                    f'mode "{mode.id}" prompt "{rel}" is missing or exceeds '
                    f"{_PROMPT_MAX_BYTES // 1024}KB"
                )
            prompts[slot] = resolved.read_text(encoding="utf-8")
        out.append(
            LoadedPluginMode(
                definition=mode,
                prompts=ModePrompts(
                    interviewer=prompts["interviewer"], evaluator=prompts["evaluator"]
                ),
            )
        )
    return out
