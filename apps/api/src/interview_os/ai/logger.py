"""Structured logging seam for the AI layer.

Port of the `Logger` interface in `packages/core/src/shared/logger.ts`. The
redacting JSON implementation belongs to `interview_os.core` and lands with the
rest of the core logic (phase 5); the runtime only needs the structural
contract, so `ai/` declares it as a `Protocol` plus a silent default.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Literal, Protocol

__all__ = [
    "Logger",
    "LogLevel",
    "NullLogger",
]

LogLevel = Literal["debug", "info", "warn", "error"]

Fields = Mapping[str, object]


class Logger(Protocol):
    """Structural `Logger` contract; any core logger satisfies it."""

    @property
    def level(self) -> LogLevel: ...

    def debug(self, event: str, fields: Fields | None = None) -> None: ...

    def info(self, event: str, fields: Fields | None = None) -> None: ...

    def warn(self, event: str, fields: Fields | None = None) -> None: ...

    def error(self, event: str, fields: Fields | None = None) -> None: ...

    def child(self, fields: Fields) -> Logger: ...


class NullLogger:
    """A logger that writes nothing, used when the caller passes none."""

    level: LogLevel = "error"

    def debug(self, event: str, fields: Fields | None = None) -> None:
        pass

    def info(self, event: str, fields: Fields | None = None) -> None:
        pass

    def warn(self, event: str, fields: Fields | None = None) -> None:
        pass

    def error(self, event: str, fields: Fields | None = None) -> None:
        pass

    def child(self, fields: Fields) -> Logger:
        return self
