"""`AIRuntime` contract and the value objects it exchanges.

Port of `packages/runtime/src/interface/index.ts`. Python spells the members
snake_case (`run_task`, `send_message`, …) while the JSON payloads that cross a
process boundary keep the provider's camelCase keys (`threadId`,
`outputSchema`, …).
"""

from __future__ import annotations

import re
from collections.abc import AsyncIterator, Callable, Mapping
from dataclasses import dataclass
from typing import Literal, NotRequired, Protocol, TypedDict

from .errors import RuntimeError

__all__ = [
    "AIRuntime",
    "MODEL_ID_REGEX",
    "REASONING_EFFORTS",
    "AgentEvent",
    "AgentResult",
    "AgentTask",
    "JSONSchema",
    "ModelInfo",
    "ProgressCallback",
    "ProgressUpdate",
    "ReasoningEffort",
    "RuntimeEvent",
    "RuntimeKind",
    "RuntimeMessage",
    "RuntimeSession",
    "RuntimeState",
    "RuntimeStatus",
    "SessionInput",
    "TaskMode",
    "validate_model_and_effort",
]

JSONSchema = dict[str, object]

#: Provider kinds: the built-ins live in `ai.providers.RUNTIME_KINDS`; trusted
#: local providers registered from `interview-os.runtimes.json` add more.
RuntimeKind = str

ReasoningEffort = Literal["low", "medium", "high"]
TaskMode = Literal["app-server", "exec"]
RuntimeState = Literal["ready", "unavailable", "error"]

#: A runtime event as it travels over the wire (JSON-shaped, hence a TypedDict).
AgentEvent = Mapping[str, object]

#: Model id: 1–128 chars, optionally one `/` separating provider and model.
MODEL_ID_REGEX = re.compile(r"^(?=.{1,128}$)[A-Za-z0-9._:-]+(?:/[A-Za-z0-9._:-]+)?$")
REASONING_EFFORTS: tuple[ReasoningEffort, ...] = ("low", "medium", "high")


@dataclass(frozen=True, slots=True)
class RuntimeStatus:
    runtime: RuntimeKind
    available: bool
    status: RuntimeState
    version: str | None = None
    executable: str | None = None
    workspace: str | None = None
    #: True for providers loaded from `interview-os.runtimes.json` (trusted local code).
    trusted_local: bool | None = None
    message: str | None = None


@dataclass(frozen=True, slots=True)
class ModelInfo:
    id: str
    display_name: str
    supported_reasoning_efforts: list[str]
    default_reasoning_effort: str | None
    #: Marks the provider's default model; used when a saved model disappears.
    is_default: bool | None = None


class RuntimeEvent(TypedDict):
    """A streamed event; the same object lands in `AgentResult.events`."""

    type: Literal["started", "delta", "message", "completed", "error"]
    text: NotRequired[str]
    output: NotRequired[object]
    raw: NotRequired[str]
    error: NotRequired[RuntimeError]


@dataclass(frozen=True, slots=True)
class ProgressUpdate:
    """Progress pushed by skills during long-running AI calls (§8.3).

    Exactly one shape is used per update: `stage` for a stage change, or
    `field` + `text` for streamed partial text of a JSON field.
    """

    stage: str | None = None
    field: str | None = None
    text: str | None = None


ProgressCallback = Callable[[ProgressUpdate], None]
EventCallback = Callable[[RuntimeEvent], None]


@dataclass(frozen=True, slots=True)
class AgentTask:
    task_id: str
    instructions: str
    input: object
    output_schema: JSONSchema
    timeout_ms: int | None = None
    #: Streaming callback — receives the same events collected on the result.
    on_event: EventCallback | None = None
    #: Model override (validated by `MODEL_ID_REGEX`; provider-qualified ids allowed).
    model: str | None = None
    effort: ReasoningEffort | None = None
    #: Codex-only: warm app-server turn (default) or `codex exec`.
    task_mode: TaskMode | None = None


@dataclass(frozen=True, slots=True)
class AgentResult:
    ok: bool
    duration_ms: int
    events: list[AgentEvent]
    output: object | None = None
    raw: str | None = None
    error: RuntimeError | None = None

    @classmethod
    def success(
        cls,
        *,
        output: object | None,
        raw: str | None,
        duration_ms: int,
        events: list[AgentEvent],
    ) -> AgentResult:
        return cls(ok=True, duration_ms=duration_ms, events=events, output=output, raw=raw)

    @classmethod
    def failure(
        cls,
        *,
        error: RuntimeError,
        duration_ms: int,
        events: list[AgentEvent],
        raw: str | None = None,
    ) -> AgentResult:
        return cls(ok=False, duration_ms=duration_ms, events=events, raw=raw, error=error)


@dataclass(frozen=True, slots=True)
class RuntimeMessage:
    text: str
    task_id: str | None = None
    input: object | None = None
    output_schema: JSONSchema | None = None
    model: str | None = None
    effort: ReasoningEffort | None = None


@dataclass(frozen=True, slots=True)
class SessionInput:
    instructions: str | None = None
    developer_instructions: str | None = None
    metadata: dict[str, object] | None = None


@dataclass(frozen=True, slots=True)
class RuntimeSession:
    id: str
    thread_id: str


class AIRuntime(Protocol):
    """A switchable AI provider: one-shot tasks plus session turns."""

    @property
    def kind(self) -> RuntimeKind: ...

    async def health_check(self) -> RuntimeStatus: ...

    async def run_task(self, task: AgentTask) -> AgentResult: ...

    async def create_session(self, input: SessionInput) -> RuntimeSession: ...

    async def resume_session(self, thread_id: str, input: SessionInput) -> RuntimeSession: ...

    def send_message(self, session_id: str, msg: RuntimeMessage) -> AsyncIterator[RuntimeEvent]: ...

    async def close_session(self, session_id: str) -> None: ...

    async def list_models(self) -> list[ModelInfo]: ...

    async def dispose(self) -> None: ...


def validate_model_and_effort(
    model: str | None = None,
    effort: str | None = None,
) -> RuntimeError | None:
    """Defence-in-depth validation before a model/effort reaches a child process."""

    if model is not None and MODEL_ID_REGEX.match(model) is None:
        return RuntimeError("PROTOCOL", f'invalid model id "{model[:40]}…"')
    if effort is not None and effort not in REASONING_EFFORTS:
        return RuntimeError("PROTOCOL", f'invalid reasoning effort "{effort}"')
    return None
