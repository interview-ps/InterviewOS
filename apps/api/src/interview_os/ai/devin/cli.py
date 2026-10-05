"""One-shot `devin -p --prompt-file <file>` invocation (port of `devin/cli.ts`).

The prompt travels in a workspace temp file referenced by `--prompt-file` and
is deleted afterwards — never an argv element, a shell string, or stdin (the
CLI panics reading `-p` from a pipe).
"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from ..process import run_cli
from .child_env import build_devin_child_env

__all__ = ["DevinRunResult", "DevinRunner", "run_devin_cli"]


@dataclass(frozen=True, slots=True)
class DevinRunResult:
    stdout: str
    stderr: str
    code: int | None


class DevinRunner(Protocol):
    """Test seam: runs the devin CLI and resolves with its output."""

    def __call__(
        self, args: list[str], *, timeout_ms: int, prompt: str | None = None
    ) -> Awaitable[DevinRunResult]: ...


async def run_devin_cli(
    bin: str,
    args: Sequence[str],
    *,
    env: Mapping[str, str],
    workspace_dir: str,
    prompt: str | None,
    timeout_ms: int,
    runner: DevinRunner | None = None,
) -> DevinRunResult:
    prompt_file: Path | None = None
    effective_args = list(args)
    if prompt is not None:
        Path(workspace_dir).mkdir(parents=True, exist_ok=True)
        prompt_file = Path(workspace_dir) / f".devin-prompt-{uuid.uuid4()}.txt"
        prompt_file.write_text(prompt, encoding="utf-8")
        effective_args = [*effective_args, "--prompt-file", str(prompt_file)]
    try:
        if runner is not None:
            return await runner(effective_args, timeout_ms=timeout_ms, prompt=prompt)
        result = await run_cli(
            bin,
            effective_args,
            cwd=workspace_dir,
            env=build_devin_child_env(env),
            timeout_ms=timeout_ms,
        )
        return DevinRunResult(stdout=result.stdout, stderr=result.stderr, code=result.code)
    finally:
        if prompt_file is not None:
            prompt_file.unlink(missing_ok=True)
