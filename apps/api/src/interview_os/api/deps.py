"""Per-request dependency container — port of `http/context.ts`."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Annotated, Any

from fastapi import Depends, Request

from ..ai.interface import AIRuntime
from ..ai.logger import Logger
from ..ai.manager import RuntimeManager
from ..orchestrator import InterviewOrchestrator
from ..store.store import Store

__all__ = ["AppState", "StateDep", "get_state"]


@dataclass
class AppState:
    orchestrator: InterviewOrchestrator
    runtime: AIRuntime
    runtimes: RuntimeManager | None
    store: Store
    logger: Logger
    examples_dir: Path
    ui_runtime_dir: Path
    plugin_errors: list[Any] = field(default_factory=list)
    web_dir: Path | None = None


def get_state(request: Request) -> AppState:
    state: AppState = request.app.state.app_state
    return state


StateDep = Annotated[AppState, Depends(get_state)]
