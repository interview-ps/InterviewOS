"""Skill framework — port of `apps/server/src/skills/framework/skill.ts`.

A skill is a small single-purpose unit with a manifest, boundary schemas and an
`execute(input, ctx)`. Everything a skill needs from the outside world travels
in `SkillContext`; the `SkillHost` is the only caller (invariant #8).
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import Any, ClassVar, Protocol

from pydantic import BaseModel, TypeAdapter

from ..ai.interface import (
    AIRuntime,
    ProgressCallback,
    ProgressUpdate,
    ReasoningEffort,
    TaskMode,
)
from ..ai.logger import Logger, NullLogger
from ..ai.structured import (
    SessionRef,
    StructuredOutputError,
    StructuredRuntimeError,
    StructuredTask,
)
from ..ai.structured import (
    run_structured as _run_structured,
)
from ..core.models import CamelModel, Permission, SkillManifest

__all__ = [
    "InterviewSkill",
    "PluginKvStorage",
    "ProgressUpdate",
    "RuntimeOptions",
    "SessionRef",
    "SkillContext",
    "SkillInput",
    "SkillOutputError",
    "SkillRuntimeError",
    "SkillSchema",
    "SkillTask",
    "StructuredTask",
    "json_input",
    "run_structured",
    "validate_schema",
]

#: `runStructured.ts` raises `SkillRuntimeError`/`SkillOutputError`; `ai.structured`
#: already raises them (same code, message and fields) under its own names, so the
#: skill layer re-exports the same classes — `except SkillOutputError` and
#: `except StructuredOutputError` are one catch, and no detail is lost.
SkillRuntimeError = StructuredRuntimeError
SkillOutputError = StructuredOutputError


@dataclass(frozen=True, slots=True)
class RuntimeOptions:
    """Per-call runtime overrides, resolved by the orchestrator from settings."""

    model: str | None = None
    effort: ReasoningEffort | None = None
    task_mode: TaskMode | None = None


class PluginKvStorage(Protocol):
    """Plugin-owned key/value storage: get/set/delete, backed by the host."""

    async def get(self, key: str) -> object: ...

    async def set(self, key: str, value: object) -> None: ...

    async def delete(self, key: str) -> None: ...


def _utcnow() -> datetime:
    return datetime.now(UTC)


@dataclass(slots=True)
class SkillContext:
    """Everything a skill may use: the runtime, a logger, and per-call overrides."""

    runtime: AIRuntime
    logger: Logger = field(default_factory=NullLogger)
    #: Interview OS session id (orchestrator scope).
    session_id: str | None = None
    #: Runtime session id for skills that talk on an existing thread.
    runtime_session_id: str | None = None
    #: Streamed progress: stage changes and partial field text.
    on_progress: ProgressCallback | None = None
    runtime_options: RuntimeOptions | None = None
    #: v0.4 plugins: effective permission grant set (manifest ∩ granted).
    granted_permissions: tuple[Permission, ...] | None = None
    #: v1 plugins: which Plugin API hook this run dispatches to (if any).
    plugin_hook: str | None = None
    #: v1 plugins: the hook's raw request payload (for handlers dispatch).
    hook_request: object | None = None
    #: v1 plugins: declared settings values (defaults applied).
    settings: Mapping[str, object] | None = None
    #: v1 plugins: plugin-owned KV storage (isolated per plugin, never shared).
    storage: PluginKvStorage | None = None
    now: Callable[[], datetime] = _utcnow

    def clone(self, **overrides: object) -> SkillContext:
        """A copy with per-call overrides (the host's guarded context)."""
        return replace(self, **overrides)  # type: ignore[arg-type]


#: A skill's boundary schema: a model class, or a `TypeAdapter` for unions.
SkillSchema = type[BaseModel] | TypeAdapter[Any]


def validate_schema(schema: SkillSchema, value: object) -> object:
    """Validate `value` against a skill schema; raises `ValidationError`."""

    if isinstance(schema, TypeAdapter):
        return schema.validate_python(value)
    return schema.model_validate(value)


def json_input(value: object) -> object:
    """The JSON shape the TS prompt templates interpolate (`JSON.stringify`)."""

    if isinstance(value, SkillInput):
        return value.to_js_input()
    if isinstance(value, BaseModel):
        return value.model_dump(by_alias=True, mode="json")
    if isinstance(value, Mapping):
        return {str(key): json_input(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_input(item) for item in value]
    return value


class SkillInput(CamelModel):
    """Base for skill inputs, so their JSON form matches the TS parsed input.

    Zod fills defaults but omits fields declared `.optional()`: the JSON the
    runtime receives has no key for them, where Pydantic would emit `null`.
    Models name those fields in `js_undefined` to keep the prompt text identical.
    """

    js_undefined: ClassVar[frozenset[str]] = frozenset()

    def to_js_input(self) -> dict[str, object]:
        data: dict[str, object] = {}
        for name, model_field in type(self).model_fields.items():
            value = getattr(self, name)
            if value is None and name in self.js_undefined:
                continue
            data[model_field.alias or name] = json_input(value)
        return data


@dataclass(frozen=True, slots=True)
class SkillTask[M: BaseModel]:
    """One structured skill call — the skill-layer `StructuredTaskOptions`."""

    task_id: str
    instructions: str
    input: object
    schema: type[M]
    #: Route through `ctx.runtime_session_id` instead of a one-shot task.
    session: bool = False
    #: Stream partial values of this JSON field via `ctx.on_progress` (§8.3).
    stream_field: str | None = None


async def run_structured[M: BaseModel](ctx: SkillContext, task: SkillTask[M]) -> M:
    """Run a structured task through the context's runtime (validate → retry)."""

    options = ctx.runtime_options
    runtime_session_id = (
        ctx.runtime_session_id if (task.session or ctx.runtime_session_id) else None
    )
    return await _run_structured(
        ctx.runtime,
        StructuredTask(
            task_id=task.task_id,
            instructions=task.instructions,
            input=task.input,
            schema=task.schema,
            session=SessionRef(runtime_session_id) if runtime_session_id else None,
            stream_field=task.stream_field,
            model=options.model if options is not None else None,
            effort=options.effort if options is not None else None,
            task_mode=options.task_mode if options is not None else None,
            on_progress=ctx.on_progress,
            logger=ctx.logger,
        ),
    )


class InterviewSkill[I, O](Protocol):
    """A registered skill: id, manifest, boundary schemas, one execute."""

    id: str
    manifest: SkillManifest
    input_schema: SkillSchema
    output_schema: SkillSchema | None

    async def execute(self, input: I, ctx: SkillContext) -> O: ...


# Re-exported so skills import `ProgressUpdate` from one place (§8.3).
ProgressUpdate = ProgressUpdate
