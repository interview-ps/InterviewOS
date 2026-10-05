"""Typed runtime failures.

Port of `RuntimeError` / `RuntimeErrorCode` in
`packages/runtime/src/interface/index.ts`. The class deliberately shadows the
builtin `RuntimeError`, exactly as the TypeScript class shadows `Error`; import
it from `interview_os.ai` and never rely on the builtin in `ai/` modules.
"""

from __future__ import annotations

from typing import Literal

__all__ = [
    "RuntimeError",
    "RuntimeErrorCode",
]

RuntimeErrorCode = Literal[
    "UNAVAILABLE",
    "SPAWN_FAILED",
    "CRASHED",
    "TIMEOUT",
    "MALFORMED_EVENT",
    "MALFORMED_OUTPUT",
    "PROTOCOL",
]


class RuntimeError(Exception):
    """An `AIRuntime` failure carrying a machine-readable `code`."""

    code: RuntimeErrorCode
    message: str
    name: str

    def __init__(self, code: RuntimeErrorCode, message: str) -> None:
        super().__init__(message)
        self.name = "RuntimeError"
        self.code = code
        self.message = message
