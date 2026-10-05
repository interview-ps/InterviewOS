"""Child-process helpers: argv arrays, allowlisted env, explicit timeouts.

Port of `packages/runtime/src/process/launch.ts` plus the `spawn` + timeout
pattern that `opencode/cli.ts` and `devin/cli.ts` each implemented by hand.

Two platform differences from Node are deliberate:

- Node scripts (`.mjs`/`.cjs`/`.js`) run through the current Node binary
  (`process.execPath`); Python has no such handle, so `node_executable()` looks
  for `INTERVIEW_OS_NODE_BIN`, then `node` on `PATH`.
- `child.kill("SIGTERM")` then `SIGKILL` after a grace period becomes
  `Process.terminate()` then `Process.kill()`, which is the same pair on POSIX
  and the closest equivalent on Windows.

No helper here ever builds a shell string: untrusted text goes to stdin or a
temp file, never into argv.
"""

from __future__ import annotations

import asyncio
import os
import re
import shutil
import signal
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from .errors import RuntimeError

__all__ = [
    "KILL_GRACE_MS",
    "CliRunResult",
    "ExecResult",
    "LaunchSpec",
    "ensure_dir",
    "env_number",
    "exec_file_safe",
    "exit_status",
    "launch_spec",
    "node_executable",
    "quote_windows_arg",
    "run_cli",
    "spawn_command",
    "timeout_from_env",
]

WINDOWS_SHIM = re.compile(r"\.(cmd|bat)$", re.IGNORECASE)
NODE_SCRIPT = re.compile(r"\.(mjs|cjs|js)$", re.IGNORECASE)

#: `required_env` in libuv's `win/process.c`: Node merges these into every
#: child environment on Windows, and without them a child cannot start at all
#: (Node aborts in its CSPRNG init when `SystemRoot` is missing). Python's
#: `subprocess` passes the environment block through verbatim, so the merge is
#: repeated here.
WINDOWS_REQUIRED_ENV = (
    "HOMEDRIVE",
    "HOMEPATH",
    "LOGONSERVER",
    "PATH",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "USERDOMAIN",
    "USERNAME",
    "USERPROFILE",
    "WINDIR",
)

#: Grace period between SIGTERM and SIGKILL (`SIGKILL_GRACE_MS` in the TS port).
KILL_GRACE_MS = 2000

_READ_CHUNK = 8192


@dataclass(frozen=True, slots=True)
class LaunchSpec:
    command: str
    args: list[str]


@dataclass(frozen=True, slots=True)
class CliRunResult:
    stdout: str
    stderr: str
    #: `None` when the process failed to spawn or was killed by a timeout.
    code: int | None


@dataclass(frozen=True, slots=True)
class ExecResult:
    stdout: str
    stderr: str
    code: int | None


def quote_windows_arg(arg: str) -> str:
    """Quote one argument for `cmd.exe /d /s /c` without a shell string."""

    if arg == "":
        return '""'
    if not re.search(r'[ \t"&|<>^()%!]', arg):
        return arg
    return '"' + arg.replace('"', '""') + '"'


def node_executable() -> str:
    """The Node binary used to run `.mjs`/`.cjs`/`.js` executables."""

    override = os.environ.get("INTERVIEW_OS_NODE_BIN")
    if override:
        return override
    found = shutil.which("node")
    if found is None:
        raise RuntimeError(
            "SPAWN_FAILED",
            "cannot run a Node script: `node` is not on PATH (set INTERVIEW_OS_NODE_BIN)",
        )
    return found


def launch_spec(bin: str, args: Sequence[str]) -> LaunchSpec:
    """Resolve `bin` + `args` into something the OS can exec directly.

    Windows cannot spawn `.cmd`/`.bat` shims with `shell=False`, and cannot
    execute a Node script (`.mjs`/`.cjs`/`.js`) as a binary at all. Shims run
    through `cmd.exe /d /s /c` with every argument quoted individually; Node
    scripts run through the Node binary. `.exe` files and all non-Windows
    binaries are launched directly.
    """

    if NODE_SCRIPT.search(bin):
        return LaunchSpec(command=node_executable(), args=[bin, *args])
    if os.name == "nt" and WINDOWS_SHIM.search(bin):
        comspec = os.environ.get("ComSpec", "cmd.exe")
        line = " ".join(quote_windows_arg(arg) for arg in [bin, *args])
        return LaunchSpec(command=comspec, args=["/d", "/s", "/c", line])
    return LaunchSpec(command=bin, args=list(args))


async def spawn_command(
    bin: str,
    args: Sequence[str],
    *,
    cwd: str | os.PathLike[str] | None = None,
    env: Mapping[str, str] | None = None,
) -> asyncio.subprocess.Process:
    """Spawn `bin` with piped stdio; raises `OSError`/`RuntimeError` on failure."""

    spec = launch_spec(bin, args)
    child_env = _complete_child_env(env)
    return await asyncio.create_subprocess_exec(
        spec.command,
        *spec.args,
        cwd=cwd,
        env=child_env,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )


def _complete_child_env(env: Mapping[str, str] | None) -> dict[str, str] | None:
    """Merge libuv's required Windows variables into an explicit child env."""

    if env is None or os.name != "nt":
        return None if env is None else dict(env)
    merged = dict(env)
    for key in WINDOWS_REQUIRED_ENV:
        if key not in merged:
            value = os.environ.get(key)
            if value is not None:
                merged[key] = value
    return merged


def exit_status(returncode: int | None) -> tuple[int | None, str | None]:
    """Split a POSIX return code into `(code, signal)` like Node's `close` event."""

    if returncode is None or returncode >= 0:
        return returncode, None
    try:
        return None, signal.Signals(-returncode).name
    except ValueError:  # pragma: no cover - exotic signal number
        return None, str(-returncode)


def env_number(env: Mapping[str, str], key: str) -> float | None:
    """`Number(env[key])` — `None` when the value is absent or not a number."""

    raw = env.get(key)
    if raw is None:
        return None
    try:
        return float(raw)
    except ValueError:
        return None


def timeout_from_env(env: Mapping[str, str], key: str, default_ms: int) -> int:
    """`Number(env[key]) > 0 ? Number(env[key]) : default`."""

    value = env_number(env, key)
    if value is None or not value > 0:
        return default_ms
    return int(value)


async def ensure_dir(path: str | os.PathLike[str]) -> None:
    """`fs.mkdir(dir, { recursive: true })` without blocking the event loop."""

    await asyncio.to_thread(lambda: os.makedirs(path, exist_ok=True))


async def _read_all(stream: asyncio.StreamReader) -> bytes:
    return await stream.read()


async def _read_tail(stream: asyncio.StreamReader, limit: int) -> bytes:
    """Read to EOF, keeping at most `limit` bytes of the tail."""

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
        await asyncio.wait_for(proc.wait(), KILL_GRACE_MS / 1000)
    except TimeoutError:
        try:
            proc.kill()
        except ProcessLookupError:
            return
        await proc.wait()


async def run_cli(
    bin: str,
    args: Sequence[str],
    *,
    cwd: str | os.PathLike[str] | None = None,
    env: Mapping[str, str] | None = None,
    stdin: str | None = None,
    timeout_ms: int,
) -> CliRunResult:
    """Run `bin` once and collect stdout/stderr; a timeout yields `code=None`."""

    try:
        proc = await spawn_command(bin, args, cwd=cwd, env=env)
    except (OSError, RuntimeError) as err:
        return CliRunResult(stdout="", stderr=str(err), code=None)

    stdout_task = asyncio.ensure_future(_read_all(_reader(proc.stdout)))
    stderr_task = asyncio.ensure_future(_read_all(_reader(proc.stderr)))

    if stdin is not None:
        assert proc.stdin is not None
        try:
            proc.stdin.write(stdin.encode("utf-8"))
            await proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            pass
    if proc.stdin is not None:
        proc.stdin.close()

    timed_out = False
    try:
        code: int | None = await asyncio.wait_for(proc.wait(), timeout_ms / 1000)
    except TimeoutError:
        timed_out = True
        await _terminate(proc)
        code = None

    stdout = (await stdout_task).decode("utf-8", errors="replace")
    stderr = (await stderr_task).decode("utf-8", errors="replace")
    return CliRunResult(stdout=stdout, stderr=stderr, code=None if timed_out else code)


async def exec_file_safe(
    bin: str,
    args: Sequence[str],
    *,
    cwd: str | os.PathLike[str] | None = None,
    env: Mapping[str, str] | None = None,
    timeout_ms: int,
) -> ExecResult:
    """`execFileSafe`: a detection probe must degrade, never raise."""

    result = await run_cli(bin, args, cwd=cwd, env=env, timeout_ms=timeout_ms)
    return ExecResult(stdout=result.stdout, stderr=result.stderr, code=result.code)


def _reader(stream: asyncio.StreamReader | None) -> asyncio.StreamReader:
    if stream is None:  # pragma: no cover - stdio is always piped here
        raise RuntimeError("SPAWN_FAILED", "child process stdio was not piped")
    return stream
