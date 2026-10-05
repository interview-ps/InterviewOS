"""One-shot `opencode <args>` invocation (port of `opencode/cli.ts`).

Untrusted prompt text is written to the child's stdin — never an argv element
or a shell string — and the child environment is an allowlist.
"""

from __future__ import annotations

from collections.abc import Awaitable, Mapping, Sequence
from dataclasses import dataclass
from typing import Protocol

from ..process import run_cli
from .child_env import build_opencode_child_env

__all__ = ["OpencodeRunResult", "OpencodeRunner", "run_opencode_cli"]


@dataclass(frozen=True, slots=True)
class OpencodeRunResult:
    stdout: str
    stderr: str
    code: int | None


class OpencodeRunner(Protocol):
    """Test seam: runs the opencode CLI and resolves with its output."""

    def __call__(
        self, args: list[str], *, timeout_ms: int, stdin: str | None = None
    ) -> Awaitable[OpencodeRunResult]: ...


async def run_opencode_cli(
    bin: str,
    args: Sequence[str],
    *,
    env: Mapping[str, str],
    workspace_dir: str,
    stdin: str | None,
    timeout_ms: int,
    runner: OpencodeRunner | None = None,
) -> OpencodeRunResult:
    if runner is not None:
        return await runner(list(args), timeout_ms=timeout_ms, stdin=stdin)
    result = await run_cli(
        bin,
        args,
        cwd=workspace_dir,
        env=build_opencode_child_env(env),
        stdin=stdin,
        timeout_ms=timeout_ms,
    )
    return OpencodeRunResult(stdout=result.stdout, stderr=result.stderr, code=result.code)
