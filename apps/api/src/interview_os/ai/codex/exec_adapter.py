"""One-shot `codex exec --json` adapter (port of `codex/CodexExecAdapter.ts`).

The prompt goes on stdin, the output schema into a workspace temp file; the
result is the JSON parse of the last `item.completed` agent_message.
"""

from __future__ import annotations

import asyncio
import json
import shutil
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from ...core.models import new_id
from ..clock import now_ms
from ..errors import RuntimeError, RuntimeErrorCode
from ..interface import AgentResult, AgentTask, AIUsageEvent, AIUsageSink
from ..json_compat import js_dumps
from ..process import exit_status, spawn_command
from .child_env import build_child_env
from .event_parser import CodexExecEventParser, usage_tokens

__all__ = ["DEFAULT_TASK_TIMEOUT_MS", "CodexExecAdapter", "CodexExecOptions"]

DEFAULT_TASK_TIMEOUT_MS = 120_000
SIGKILL_GRACE_MS = 2_000
STDERR_TAIL_BYTES = 2_048
_READ_CHUNK = 8_192


@dataclass(frozen=True, slots=True)
class CodexExecOptions:
    bin: str
    workspace_dir: str
    env: Mapping[str, str]
    default_timeout_ms: int | None = None
    #: Test-only escape hatch: additional env keys/prefixes forwarded to the child.
    extra_child_env: Mapping[str, Sequence[str]] | None = None
    #: AI usage telemetry sink (best-effort; may be None).
    usage_sink: AIUsageSink | None = None


def compose_prompt(task: AgentTask) -> str:
    return f"{task.instructions}\n\nInput (JSON):\n{js_dumps(task.input, indent=2)}\n"


async def _read_all(stream: asyncio.StreamReader) -> bytes:
    return await stream.read()


async def _read_tail(stream: asyncio.StreamReader, limit: int) -> bytes:
    """Read to EOF, keeping at most `limit` bytes of the tail (bounded memory)."""

    buf = bytearray()
    while True:
        chunk = await stream.read(_READ_CHUNK)
        if not chunk:
            return bytes(buf)
        buf.extend(chunk)
        if len(buf) > limit * 2:
            del buf[: len(buf) - limit]


async def _terminate(proc: asyncio.subprocess.Process) -> None:
    """SIGTERM, then SIGKILL after the grace period."""

    try:
        proc.terminate()
    except ProcessLookupError:
        return
    try:
        await asyncio.wait_for(proc.wait(), SIGKILL_GRACE_MS / 1000)
    except TimeoutError:
        try:
            proc.kill()
        except ProcessLookupError:
            return
        await proc.wait()


def _stream(stream: asyncio.StreamReader | None) -> asyncio.StreamReader:
    if stream is None:  # pragma: no cover - stdio is always piped here
        raise RuntimeError("SPAWN_FAILED", "child process stdio was not piped")
    return stream


class CodexExecAdapter:
    """`codex exec` one-shot task, isolated in the runtime workspace."""

    def __init__(self, opts: CodexExecOptions) -> None:
        self._opts = opts

    async def run_task(self, task: AgentTask) -> AgentResult:
        started = now_ms()
        parser = CodexExecEventParser()
        timeout_ms = (
            task.timeout_ms
            if task.timeout_ms is not None
            else (self._opts.default_timeout_ms or DEFAULT_TASK_TIMEOUT_MS)
        )

        tmp_dir = Path(self._opts.workspace_dir) / ".tmp" / f"task-{new_id('schema')}"
        schema_file = tmp_dir / "output-schema.json"
        tmp_dir.mkdir(parents=True, exist_ok=True)
        schema_file.write_text(js_dumps(task.output_schema), encoding="utf-8")

        def emit_usage(*, ok: bool, error_code: str | None, duration_ms: int) -> None:
            # Record only when codex actually reported usage (a spawn failure has none).
            sink = self._opts.usage_sink
            if sink is None or parser.usage is None:
                return
            tokens = usage_tokens(parser.usage)
            try:
                sink.record(
                    AIUsageEvent(
                        runtime_kind="codex",
                        task_id=task.task_id,
                        model=task.model,
                        attempt=task.attempt,
                        ok=ok,
                        error_code=error_code,
                        input_tokens=tokens.get("input"),
                        output_tokens=tokens.get("output"),
                        thought_tokens=tokens.get("thought"),
                        cached_read_tokens=tokens.get("cached_read"),
                        total_tokens=tokens.get("total"),
                        stop_reason="end_turn" if ok else None,
                        duration_ms=duration_ms,
                    )
                )
            except Exception:  # telemetry must never break a task
                pass

        def failure(code: RuntimeErrorCode, message: str, *, raw: str | None = None) -> AgentResult:
            emit_usage(ok=False, error_code=code, duration_ms=now_ms() - started)
            return self._finish(
                tmp_dir,
                AgentResult.failure(
                    error=RuntimeError(code, message),
                    duration_ms=now_ms() - started,
                    events=parser.events,
                    raw=raw,
                ),
            )

        args = [
            "exec",
            "--json",
            "--skip-git-repo-check",
            "--ephemeral",
            "-s",
            "read-only",
            "-C",
            self._opts.workspace_dir,
            "--output-schema",
            str(schema_file),
        ]
        if task.model:
            args += ["-m", task.model]
        if task.effort:
            args += ["-c", f'model_reasoning_effort="{task.effort}"']
        args.append("-")

        try:
            proc = await spawn_command(
                self._opts.bin,
                args,
                cwd=self._opts.workspace_dir,
                env=build_child_env(self._opts.env, self._opts.extra_child_env),
            )
        except (OSError, RuntimeError) as err:
            return failure("SPAWN_FAILED", f"failed to spawn codex: {err}")

        stdout_task = asyncio.ensure_future(_read_all(_stream(proc.stdout)))
        stderr_task = asyncio.ensure_future(_read_tail(_stream(proc.stderr), STDERR_TAIL_BYTES))
        write_error = await _write_prompt(proc, compose_prompt(task))

        timed_out = False
        try:
            returncode: int | None = await asyncio.wait_for(proc.wait(), timeout_ms / 1000)
        except TimeoutError:
            timed_out = True
            await _terminate(proc)
            returncode = None

        stdout_text = (await stdout_task).decode("utf-8", errors="replace")
        stderr = (await stderr_task).decode("utf-8", errors="replace").strip()
        duration_ms = now_ms() - started

        lines = stdout_text.split("\n")
        for line in lines[:-1]:
            parser.feed(line)
        if lines[-1].strip() != "":
            parser.feed(lines[-1])

        if timed_out:
            return failure("TIMEOUT", f"codex exec timed out after {timeout_ms}ms")

        last_message = parser.last_agent_message
        if last_message is not None:
            try:
                output = json.loads(last_message)
            except ValueError as err:
                return failure(
                    "MALFORMED_OUTPUT",
                    f"agent_message was not valid JSON: {err}",
                    raw=last_message,
                )
            emit_usage(ok=True, error_code=None, duration_ms=duration_ms)
            return self._finish(
                tmp_dir,
                AgentResult.success(
                    output=output,
                    raw=last_message,
                    duration_ms=duration_ms,
                    events=parser.events,
                ),
            )

        if parser.malformed_event_count > 0:
            return failure(
                "MALFORMED_EVENT",
                f"codex emitted {parser.malformed_event_count} non-JSON stdout line(s) "
                "and no agent_message",
            )

        code, signal_name = exit_status(returncode)
        if code != 0 or signal_name is not None or parser.failed_message is not None:
            if parser.failed_message is not None:
                why = f"turn failed: {parser.failed_message}"
            elif signal_name is not None:
                why = f"codex killed by signal {signal_name}"
            else:
                why = f"codex exited with code {code}"
            return failure("CRASHED", f"{why} — stderr: {stderr}" if stderr else why)

        if write_error is not None:
            return failure("CRASHED", f"failed to write prompt: {write_error}")

        return failure(
            "MALFORMED_EVENT",
            "codex exited cleanly but emitted no agent_message event",
        )

    @staticmethod
    def _finish(tmp_dir: Path, result: AgentResult) -> AgentResult:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return result


async def _write_prompt(proc: asyncio.subprocess.Process, prompt: str) -> str | None:
    """Write the untrusted prompt to stdin; returns an error message on failure."""

    if proc.stdin is None:  # pragma: no cover - stdin is always piped here
        return None
    error: str | None = None
    try:
        proc.stdin.write(prompt.encode("utf-8"))
        await proc.stdin.drain()
    except (BrokenPipeError, ConnectionResetError, OSError) as err:
        error = str(err)
    finally:
        try:
            proc.stdin.close()
        except OSError:  # pragma: no cover - already closed by the child
            pass
    return error
