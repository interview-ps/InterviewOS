"""`setup(ctx)` context — the plugin-facing API for registering with the host.

Ports `octop_harness/plugins/context.py`: registration methods are
**kind-checked** (a `tool` plugin cannot register middleware, and so on), and
raise `ValueError` for the wrong kind. Interview OS additions are the read-only
`state` view and the enqueue-only `evidence` sink (§5, §7.5).

`LoadedPlugin` / `ToolRegistration` / `MiddlewareRegistration` live here (the
registry and loader both consume them).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from ..core.models import EvidenceProposal, InterviewOSState
from ..core.models.assessment import AssessmentState
from ..core.models.candidate import CandidateProfile
from ..core.models.interview import InterviewStateSlice
from ..core.models.preparation import PreparationState
from ..core.models.readiness import ReadinessGraph
from ..core.models.target import TargetRole
from .manifest import PluginKind, PluginManifest

if TYPE_CHECKING:
    from ..ai.interface import AIRuntime

__all__ = [
    "LoadedPlugin",
    "MiddlewareRegistration",
    "PluginContext",
    "StateReader",
    "ToolRegistration",
]

#: Default middleware priority; lower runs earlier (§5).
DEFAULT_MIDDLEWARE_PRIORITY = 100


@dataclass(slots=True)
class ToolRegistration:
    """A tool a `tool` plugin contributed via `ctx.tool(...)`."""

    plugin_id: str
    name: str
    fn: Callable[..., object]
    description: str = ""
    config_fields: list[dict[str, Any]] = field(default_factory=list)


@dataclass(slots=True)
class MiddlewareRegistration:
    """A middleware instance a `hook` plugin contributed via `ctx.middleware(...)`."""

    plugin_id: str
    instance: object
    priority: int = DEFAULT_MIDDLEWARE_PRIORITY


@dataclass(slots=True)
class LoadedPlugin:
    """Everything the host knows about one loaded plugin."""

    manifest: PluginManifest
    source_path: Path
    tools: list[ToolRegistration] = field(default_factory=list)
    middleware: list[MiddlewareRegistration] = field(default_factory=list)
    skills_dir: Path | None = None
    diagnostics: list[str] = field(default_factory=list)
    context: PluginContext | None = None


class StateReader:
    """Read-only typed accessors over `InterviewOSState` (§5).

    A convenience, not a boundary (the trust model is §12): the orchestrator
    binds the slices it has, and a plugin reads them without touching the store.
    """

    __slots__ = ("_state",)

    def __init__(self, state: InterviewOSState | None = None) -> None:
        self._state = state

    @property
    def is_empty(self) -> bool:
        return self._state is None

    def snapshot(self) -> InterviewOSState | None:
        return self._state

    @property
    def candidate(self) -> CandidateProfile | None:
        return self._state.candidate if self._state is not None else None

    @property
    def target(self) -> TargetRole | None:
        return self._state.target if self._state is not None else None

    @property
    def assessment(self) -> AssessmentState | None:
        return self._state.assessment if self._state is not None else None

    @property
    def preparation(self) -> PreparationState | None:
        return self._state.preparation if self._state is not None else None

    @property
    def interview(self) -> InterviewStateSlice | None:
        return self._state.interview if self._state is not None else None

    @property
    def readiness(self) -> ReadinessGraph | None:
        return self._state.readiness if self._state is not None else None


class PluginContext:
    """Handed to `setup(ctx)`; collects everything a plugin registers."""

    def __init__(self, manifest: PluginManifest, source_path: Path) -> None:
        self.manifest = manifest
        self.plugin_id: str = manifest.id
        self.source_path: Path = Path(source_path)
        self._kind: PluginKind = manifest.kind
        self._tools: list[ToolRegistration] = []
        self._middleware: list[MiddlewareRegistration] = []
        self._skills_dir: Path | None = None
        self._diagnostics: list[str] = []
        self._runtime: AIRuntime | None = None
        self._state: InterviewOSState | None = None
        self._evidence: list[EvidenceProposal] = []
        self._evidence_sink: Callable[[EvidenceProposal], None] | None = None

    # ---------------------------------------------------------------- kind check

    @property
    def kind(self) -> PluginKind:
        return self._kind

    def _require_kind(self, expected: PluginKind, method: str) -> None:
        if self._kind != expected:
            raise ValueError(
                f'plugin "{self.plugin_id}" has kind "{self._kind}" — '
                f'{method}() is only valid for kind "{expected}"'
            )

    # --------------------------------------------------------------- registrations

    def tool(
        self,
        name: str,
        fn: Callable[..., object],
        *,
        description: str = "",
        config_fields: list[dict[str, Any]] | None = None,
    ) -> None:
        """Register a callable tool (kind `tool`)."""

        self._require_kind("tool", "tool")
        if not name:
            raise ValueError("tool name must not be empty")
        if not callable(fn):
            raise ValueError(f'tool "{name}" must be callable')
        self._tools.append(
            ToolRegistration(
                plugin_id=self.plugin_id,
                name=name,
                fn=fn,
                description=description,
                config_fields=list(config_fields) if config_fields else [],
            )
        )

    def skills(self, relative_path: str) -> None:
        """Register a `skills/` directory relative to the plugin root (kind `skill`)."""

        self._require_kind("skill", "skills")
        from .loader import resolve_within  # local import: avoids an import cycle

        try:
            resolved = resolve_within(self.source_path, relative_path, must_exist=False)
        except Exception as err:  # noqa: BLE001 - reported as a diagnostic, not fatal
            self.add_diagnostic(f'skills("{relative_path}"): {err}')
            return
        self._skills_dir = resolved
        if not resolved.is_dir():
            self.add_diagnostic(f'skills directory "{relative_path}" is missing')

    def middleware(self, instance: object, *, priority: int = DEFAULT_MIDDLEWARE_PRIORITY) -> None:
        """Register a middleware instance (kind `hook`); lower priority runs earlier."""

        self._require_kind("hook", "middleware")
        self._middleware.append(
            MiddlewareRegistration(
                plugin_id=self.plugin_id, instance=instance, priority=priority
            )
        )

    # ------------------------------------------------------------------- runtime

    @property
    def runtime(self) -> AIRuntime | None:
        """The AIRuntime bound after `setup()`; None during setup (§5)."""

        return self._runtime

    def bind_runtime(self, runtime: AIRuntime) -> None:
        self._runtime = runtime

    # --------------------------------------------------------------------- state

    @property
    def state(self) -> StateReader:
        """Read-only view over the workspace state (empty until bound)."""

        return StateReader(self._state)

    def bind_state(self, state: InterviewOSState | None) -> None:
        self._state = state

    # ------------------------------------------------------------------ evidence

    def evidence(self, proposal: EvidenceProposal) -> None:
        """Enqueue an evidence proposal — never writes inline (§7.5)."""

        self._evidence.append(proposal)
        if self._evidence_sink is not None:
            self._evidence_sink(proposal)

    def bind_evidence_sink(self, sink: Callable[[EvidenceProposal], None]) -> None:
        self._evidence_sink = sink

    def drain_evidence(self) -> list[EvidenceProposal]:
        """Take the queued proposals (the orchestrator persists them off-lock)."""

        queued = self._evidence
        self._evidence = []
        return queued

    # ---------------------------------------------------------------- diagnostics

    def add_diagnostic(self, message: str) -> None:
        self._diagnostics.append(message)

    @property
    def diagnostics(self) -> list[str]:
        return list(self._diagnostics)

    # ----------------------------------------------------------------- conversion

    def to_loaded(self) -> LoadedPlugin:
        """Snapshot the registrations into a `LoadedPlugin`."""

        return LoadedPlugin(
            manifest=self.manifest,
            source_path=self.source_path,
            tools=list(self._tools),
            middleware=list(self._middleware),
            skills_dir=self._skills_dir,
            diagnostics=list(self._diagnostics),
            context=self,
        )
