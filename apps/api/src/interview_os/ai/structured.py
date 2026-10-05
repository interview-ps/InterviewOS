"""`run_structured`: Pydantic model → JSON Schema → runtime → validate → retry.

Port of `apps/server/src/skills/framework/runStructured.ts` (invariant #2: an
AI-generated state mutation must pass schema validation before anything is
persisted). The parts that need skill manifests and `SkillHost` belong to the
skill layer (phase 4): this module stays runtime-facing — prompt, model,
runtime, progress — and raises typed `AppError`s the host can map.

`to_strict_json_schema` normalises a Pydantic JSON Schema the way the TypeScript
port normalises a Zod one: every object gets `additionalProperties: false` and
every property is `required`. Pydantic emits `$defs`/`$ref` for nested models
where Zod inlines them; the walker visits `$defs` too, so both shapes are
normalised.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass

from pydantic import BaseModel, ValidationError

from ..core.models import AppError
from .clock import now_ms
from .errors import RuntimeError
from .interface import (
    AgentTask,
    AIRuntime,
    EventCallback,
    JSONSchema,
    ProgressCallback,
    ProgressUpdate,
    ReasoningEffort,
    RuntimeEvent,
    RuntimeMessage,
    TaskMode,
)
from .json_compat import js_dumps
from .logger import Logger
from .partial_json import extract_partial_string_field

__all__ = [
    "MAX_ATTEMPTS",
    "RETRYABLE_CODES",
    "SessionRef",
    "StructuredOutputError",
    "StructuredRuntimeError",
    "StructuredTask",
    "run_structured",
    "to_strict_json_schema",
]

RETRYABLE_CODES = ("MALFORMED_OUTPUT", "MALFORMED_EVENT")
MAX_ATTEMPTS = 3  # initial + 2 retries

_OBJECT_CHILD_KEYS = (
    "items",
    "contains",
    "not",
    "if",
    "then",
    "else",
    "additionalProperties",
    "unevaluatedProperties",
    "propertyNames",
    "prefixItems",
)
_OBJECT_LIST_KEYS = ("anyOf", "oneOf", "allOf")


class StructuredRuntimeError(AppError):
    """Port of `SkillRuntimeError`: a non-retryable runtime failure."""

    task_id: str
    runtime_code: str

    def __init__(self, task_id: str, cause: RuntimeError) -> None:
        super().__init__(
            "SKILL_RUNTIME",
            f'skill "{task_id}" runtime failure ({cause.code}): {cause.message}',
        )
        self.name = "StructuredRuntimeError"
        self.task_id = task_id
        self.runtime_code = cause.code


class StructuredOutputError(AppError):
    """Port of `SkillOutputError`: the model never produced schema-valid output."""

    task_id: str

    def __init__(self, task_id: str, detail: str) -> None:
        super().__init__("SKILL_OUTPUT", f'skill "{task_id}" produced invalid output: {detail}')
        self.name = "StructuredOutputError"
        self.task_id = task_id


def to_strict_json_schema(schema: type[BaseModel]) -> JSONSchema:
    """Strict schemas for provider structured outputs (all keys required, closed)."""

    json_schema = schema.model_json_schema()
    _visit(json_schema)
    return json_schema


def _visit(node: object) -> None:
    if not isinstance(node, dict):
        return
    if node.get("type") == "object" or "properties" in node:
        properties = node.get("properties")
        if isinstance(properties, dict):
            node["required"] = list(properties)
            for prop in properties.values():
                _visit(prop)
        node["additionalProperties"] = False
    for key in _OBJECT_CHILD_KEYS:
        child = node.get(key)
        if isinstance(child, list):
            for item in child:
                _visit(item)
        else:
            _visit(child)
    for key in _OBJECT_LIST_KEYS:
        children = node.get(key)
        if isinstance(children, list):
            for item in children:
                _visit(item)
    definitions = node.get("$defs")
    if isinstance(definitions, dict):
        for definition in definitions.values():
            _visit(definition)


@dataclass(frozen=True, slots=True)
class SessionRef:
    """Route the task through an existing runtime session instead of one-shot."""

    runtime_session_id: str


@dataclass(frozen=True, slots=True)
class StructuredTask[M: BaseModel]:
    task_id: str
    instructions: str
    input: object
    schema: type[M]
    session: SessionRef | None = None
    #: Stream partial values of this JSON field via `on_progress` (§8.3).
    stream_field: str | None = None
    model: str | None = None
    effort: ReasoningEffort | None = None
    task_mode: TaskMode | None = None
    on_progress: ProgressCallback | None = None
    logger: Logger | None = None


@dataclass
class _StreamState:
    buf: str = ""
    last_sent: str = ""


async def run_structured[M: BaseModel](runtime: AIRuntime, task: StructuredTask[M]) -> M:
    output_schema = to_strict_json_schema(task.schema)
    instructions = task.instructions
    last_error = ""
    logger = task.logger

    if logger is not None:
        logger.info(
            "skill.invoked",
            {
                "taskId": task.task_id,
                "runtimeSessionId": task.session.runtime_session_id if task.session else None,
            },
        )

    for attempt in range(1, MAX_ATTEMPTS + 1):
        on_delta = _delta_callback(task)
        try:
            output, _raw = await _run_once(runtime, task, instructions, output_schema, on_delta)
            try:
                parsed = task.schema.model_validate(output)
            except ValidationError as err:
                last_error = _validation_error_text(err)
                if logger is not None:
                    logger.warn("output.invalid", {"taskId": task.task_id, "attempt": attempt})
            else:
                if logger is not None:
                    logger.info("output.validated", {"taskId": task.task_id, "attempt": attempt})
                return parsed
        except RuntimeError as err:
            if err.code not in RETRYABLE_CODES:
                if logger is not None:
                    logger.warn(
                        "skill.failed",
                        {
                            "taskId": task.task_id,
                            "runtimeCode": err.code,
                            "message": err.message,
                        },
                    )
                raise StructuredRuntimeError(task.task_id, err) from err
            last_error = f"{err.code}: {err.message}"
            if logger is not None:
                logger.warn(
                    "output.invalid",
                    {"taskId": task.task_id, "attempt": attempt, "code": err.code},
                )
        instructions = (
            f"{task.instructions}\n\nYour previous response was invalid: {last_error}\n"
            "Fix the output to satisfy the schema exactly."
        )
        if attempt < MAX_ATTEMPTS and task.on_progress is not None:
            task.on_progress(ProgressUpdate(stage="retrying"))

    if logger is not None:
        logger.warn(
            "skill.failed",
            {
                "taskId": task.task_id,
                "runtimeCode": "MALFORMED_OUTPUT",
                "message": last_error,
            },
        )
    raise StructuredOutputError(task.task_id, last_error)


def _delta_callback[M: BaseModel](task: StructuredTask[M]) -> Callable[[str], None] | None:
    field = task.stream_field
    progress = task.on_progress
    if field is None or progress is None:
        return None
    state = _StreamState()

    def on_delta(text: str) -> None:
        state.buf += text
        partial = extract_partial_string_field(state.buf, field)
        if partial is not None and len(partial) > len(state.last_sent):
            state.last_sent = partial
            progress(ProgressUpdate(field=field, text=partial))

    return on_delta


async def _run_once[M: BaseModel](
    runtime: AIRuntime,
    task: StructuredTask[M],
    instructions: str,
    output_schema: JSONSchema,
    on_delta: Callable[[str], None] | None,
) -> tuple[object, str]:
    session_id = task.session.runtime_session_id if task.session is not None else None
    if session_id:
        started = now_ms()
        completed: RuntimeEvent | None = None
        message = RuntimeMessage(
            text=f"{instructions}\n\nInput (JSON):\n{js_dumps(task.input)}",
            task_id=task.task_id,
            input=task.input,
            output_schema=output_schema,
            model=task.model,
            effort=task.effort,
        )
        async for event in runtime.send_message(session_id, message):
            event_type = event["type"]
            if event_type == "error":
                error = event.get("error")
                if isinstance(error, RuntimeError):
                    raise error
                raise RuntimeError("PROTOCOL", "session turn failed")
            if event_type == "delta" and on_delta is not None:
                text = event.get("text")
                if isinstance(text, str):
                    on_delta(text)
            if event_type == "completed":
                completed = event
        if task.logger is not None:
            task.logger.info(
                "runtime.invoked",
                {
                    "taskId": task.task_id,
                    "latencyMs": now_ms() - started,
                    "ok": completed is not None,
                    "session": True,
                },
            )
        if completed is None:
            raise RuntimeError("MALFORMED_EVENT", "session turn ended without a completed event")
        raw = completed.get("raw")
        raw_text = raw if isinstance(raw, str) else ""
        if "output" in completed:
            return completed["output"], raw_text
        try:
            return json.loads(raw_text), raw_text
        except ValueError as err:
            raise RuntimeError("MALFORMED_OUTPUT", "session output was not valid JSON") from err

    on_event: EventCallback | None = None
    if on_delta is not None:

        def on_event(event: RuntimeEvent) -> None:
            if event["type"] == "delta":
                text = event.get("text")
                if isinstance(text, str):
                    on_delta(text)

    result = await runtime.run_task(
        AgentTask(
            task_id=task.task_id,
            instructions=instructions,
            input=task.input,
            output_schema=output_schema,
            model=task.model,
            effort=task.effort,
            task_mode=task.task_mode,
            on_event=on_event,
        )
    )
    if task.logger is not None:
        task.logger.info(
            "runtime.invoked",
            {
                "taskId": task.task_id,
                "latencyMs": result.duration_ms,
                "ok": result.ok,
            },
        )
    if not result.ok:
        assert result.error is not None
        raise result.error
    return result.output, result.raw or ""


def _validation_error_text(err: ValidationError) -> str:
    return json.dumps(err.errors(include_url=False), default=str)[:2000]
