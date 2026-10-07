"""JSON-RPC 2.0 client over an ACP agent's stdio.

The transport is newline-delimited JSON, exactly like the Codex app-server
client (`ai/codex/process.py`), so it is built on the existing `asyncio`
subprocess helpers and the stdlib `json` — no extra dependency.

Security posture (see `docs/design/acp-runtime.md` §5):

- `clientCapabilities` advertise **no** file-system, terminal or elicitation
  access; the agent must not read/write files or run commands for Interview OS.
- Every server→client request is refused. `session/request_permission` is
  answered with a reject option (or `cancelled`); anything else gets a
  JSON-RPC "method not found" error. A permission request can never succeed.
- Untrusted text only ever travels inside request parameters (the prompt);
  it is never placed in argv or a shell string.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass

from ..errors import RuntimeError
from ..process import spawn_command

__all__ = ["AcpClient", "AcpClientOptions", "NotificationHandler"]

#: Method that carries a permission prompt; always refused.
_PERMISSION_METHOD = "session/request_permission"
#: Agent protocol major version Interview OS speaks.
PROTOCOL_VERSION = 1
CLOSE_GRACE_MS = 2_000
_STDERR_CHUNK = 8_192

NotificationHandler = Callable[[str, "Mapping[str, object]"], None]


@dataclass(frozen=True, slots=True)
class AcpClientOptions:
    command: str
    args: Sequence[str]
    cwd: str
    env: Mapping[str, str]
    request_timeout_ms: int = 30_000


@dataclass(slots=True)
class _ClientState:
    malformed_lines: int = 0
    exited: bool = False
    exit_error: RuntimeError | None = None


class AcpClient:
    """One ACP agent subprocess speaking JSON-RPC over stdio."""

    def __init__(self, opts: AcpClientOptions) -> None:
        self._opts = opts
        self._proc: asyncio.subprocess.Process | None = None
        self._tasks: list[asyncio.Task[None]] = []
        self._pending: dict[int, asyncio.Future[object]] = {}
        self._timers: dict[int, asyncio.TimerHandle] = {}
        self._notification_handlers: list[NotificationHandler] = []
        self._next_request_id = 1
        self._state = _ClientState()
        self._initialize_result: Mapping[str, object] | None = None
        self._stderr: list[str] = []

    # ------------------------------------------------------------------ lifecycle

    @property
    def started(self) -> bool:
        return self._proc is not None

    @property
    def stderr_tail(self) -> str:
        """Last drained stderr text — for diagnostics only, never logged verbatim."""

        return "".join(self._stderr)[-2_000:]

    async def start(self) -> None:
        if self._proc is not None:
            return
        try:
            proc = await spawn_command(
                self._opts.command, list(self._opts.args), cwd=self._opts.cwd, env=self._opts.env
            )
        except (OSError, RuntimeError) as err:
            raise RuntimeError("SPAWN_FAILED", f"failed to spawn ACP agent: {err}") from err
        self._proc = proc
        self._state = _ClientState()
        self._tasks = [
            asyncio.ensure_future(self._read_stdout(proc)),
            asyncio.ensure_future(self._drain_stderr(proc)),
            asyncio.ensure_future(self._watch_exit(proc)),
        ]

    async def initialize(self, timeout_ms: int | None = None) -> Mapping[str, object]:
        """Spawn (if needed) and run the ACP `initialize` handshake."""

        if self._initialize_result is not None:
            return self._initialize_result
        await self.start()
        result = await self.request(
            "initialize",
            {
                "protocolVersion": PROTOCOL_VERSION,
                "clientCapabilities": {
                    "fs": {"readTextFile": False, "writeTextFile": False},
                    "terminal": False,
                },
                "clientInfo": {"name": "interview-os", "title": "Interview OS", "version": "0.1.0"},
            },
            timeout_ms,
        )
        self._initialize_result = _as_mapping(result)
        return self._initialize_result

    @property
    def capabilities(self) -> Mapping[str, object]:
        if self._initialize_result is None:
            return {}
        return _as_mapping(self._initialize_result.get("agentCapabilities"))

    @property
    def load_session(self) -> bool:
        return self.capabilities.get("loadSession") is True

    @property
    def session_capabilities(self) -> Mapping[str, object]:
        return _as_mapping(self.capabilities.get("sessionCapabilities"))

    # ------------------------------------------------------------------ json-rpc

    def on_notification(self, handler: NotificationHandler) -> Callable[[], None]:
        self._notification_handlers.append(handler)

        def off() -> None:
            if handler in self._notification_handlers:
                self._notification_handlers.remove(handler)

        return off

    async def request(
        self,
        method: str,
        params: Mapping[str, object] | None = None,
        timeout_ms: int | None = None,
    ) -> object:
        if self._proc is None:
            raise RuntimeError("CRASHED", "ACP agent is not running")
        if self._state.exited:
            raise self._state.exit_error or RuntimeError("CRASHED", "ACP agent has exited")
        request_id = self._next_request_id
        self._next_request_id += 1
        timeout = timeout_ms if timeout_ms is not None else self._opts.request_timeout_ms
        loop = asyncio.get_running_loop()
        future: asyncio.Future[object] = loop.create_future()
        self._pending[request_id] = future
        self._timers[request_id] = loop.call_later(
            timeout / 1000, self._timeout_request, request_id, method
        )
        self._send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": method,
                "params": dict(params or {}),
            }
        )
        try:
            return await future
        except asyncio.CancelledError:
            self._discard(request_id)
            raise

    def notify(self, method: str, params: Mapping[str, object] | None = None) -> None:
        self._send({"jsonrpc": "2.0", "method": method, "params": dict(params or {})})

    def _discard(self, request_id: int) -> None:
        self._pending.pop(request_id, None)
        timer = self._timers.pop(request_id, None)
        if timer is not None:
            timer.cancel()

    def _timeout_request(self, request_id: int, method: str) -> None:
        pending = self._pending.pop(request_id, None)
        self._timers.pop(request_id, None)
        if pending is not None and not pending.done():
            pending.set_exception(RuntimeError("TIMEOUT", f'ACP request "{method}" timed out'))

    def _send(self, msg: Mapping[str, object]) -> None:
        proc = self._proc
        if proc is None or proc.stdin is None or proc.stdin.is_closing():
            return
        proc.stdin.write((json.dumps(msg) + "\n").encode("utf-8"))

    # ------------------------------------------------------------------ reading

    async def _read_stdout(self, proc: asyncio.subprocess.Process) -> None:
        stream = proc.stdout
        if stream is None:  # pragma: no cover - stdout is always piped
            return
        while True:
            line = await stream.readline()
            if not line:
                return
            self._handle_line(line.decode("utf-8", errors="replace").rstrip("\r\n"))

    async def _drain_stderr(self, proc: asyncio.subprocess.Process) -> None:
        stream = proc.stderr
        if stream is None:  # pragma: no cover - stderr is always piped
            return
        while True:
            chunk = await stream.read(_STDERR_CHUNK)
            if not chunk:
                return
            # Bounded tail for diagnostics; never logged with content.
            self._stderr.append(chunk.decode("utf-8", errors="replace"))
            if len(self._stderr) > 32:
                del self._stderr[: len(self._stderr) - 32]

    async def _watch_exit(self, proc: asyncio.subprocess.Process) -> None:
        code = await proc.wait()
        self._fail_pending(
            RuntimeError("CRASHED", f"ACP agent exited (code={code if code is not None else '?'})")
        )

    def _fail_pending(self, error: RuntimeError) -> None:
        if self._state.exited:
            return
        self._state.exited = True
        self._state.exit_error = error
        for request_id, pending in list(self._pending.items()):
            self._discard(request_id)
            if not pending.done():
                pending.set_exception(error)

    def _handle_line(self, line: str) -> None:
        if not line.strip():
            return
        try:
            msg = json.loads(line)
        except ValueError:
            self._state.malformed_lines += 1
            return
        if not isinstance(msg, dict):
            self._state.malformed_lines += 1
            return

        msg_id = msg.get("id")
        method = msg.get("method")

        if msg_id is not None and isinstance(method, str):
            self._handle_server_request(msg_id, method, _as_mapping(msg.get("params")))
            return
        if msg_id is not None and ("result" in msg or "error" in msg):
            self._handle_response(msg_id, msg)
            return
        if isinstance(method, str):
            params = _as_mapping(msg.get("params"))
            for handler in list(self._notification_handlers):
                handler(method, params)

    def _handle_response(self, msg_id: object, msg: Mapping[str, object]) -> None:
        if not isinstance(msg_id, int):
            return
        pending = self._pending.pop(msg_id, None)
        if pending is None:
            return
        timer = self._timers.pop(msg_id, None)
        if timer is not None:
            timer.cancel()
        error = msg.get("error")
        if error is not None:
            code = error.get("code") if isinstance(error, Mapping) else None
            message = error.get("message") if isinstance(error, Mapping) else None
            shown = message if isinstance(message, str) else "unknown ACP error"
            shown_code = code if isinstance(code, int) else "?"
            pending.set_exception(RuntimeError("PROTOCOL", f"ACP error {shown_code}: {shown}"))
        else:
            pending.set_result(msg.get("result"))

    # ----------------------------------------------------- server→client requests

    def _handle_server_request(
        self, msg_id: object, method: str, params: Mapping[str, object]
    ) -> None:
        """Refuse every server→client request (never fulfill fs/terminal)."""

        if method == _PERMISSION_METHOD:
            self._send({"jsonrpc": "2.0", "id": msg_id, "result": _reject_outcome(params)})
            return
        self._send(
            {
                "jsonrpc": "2.0",
                "id": msg_id,
                "error": {
                    "code": -32601,
                    "message": f'"{method}" is not supported by interview-os',
                },
            }
        )

    # ------------------------------------------------------------------ shutdown

    async def close(self) -> None:
        proc = self._proc
        tasks = self._tasks
        self._proc = None
        self._tasks = []
        self._initialize_result = None
        for request_id in list(self._pending):
            self._discard(request_id)
        if proc is None:
            return
        await _terminate_tree(proc)
        for task in tasks:
            if not task.done():
                task.cancel()


async def _terminate_tree(proc: asyncio.subprocess.Process) -> None:
    """Terminate the agent and its whole process tree.

    On Windows a launcher can spawn a detached child (Devin does), so
    `terminate()` alone would orphan it; `taskkill /T` reaps the tree.
    """

    if proc.returncode is not None:
        return
    if os.name == "nt":
        with contextlib.suppress(Exception):
            killer = await asyncio.create_subprocess_exec(
                "taskkill",
                "/PID",
                str(proc.pid),
                "/T",
                "/F",
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await killer.wait()
    else:
        with contextlib.suppress(ProcessLookupError):
            proc.terminate()
    try:
        await asyncio.wait_for(proc.wait(), CLOSE_GRACE_MS / 1000)
    except TimeoutError:
        with contextlib.suppress(ProcessLookupError):
            proc.kill()
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(proc.wait(), CLOSE_GRACE_MS / 1000)


def _reject_outcome(params: Mapping[str, object]) -> dict[str, object]:
    """Always answer a permission request with the reject/cancel outcome."""

    options = params.get("options")
    if isinstance(options, list):
        for option in options:
            if not isinstance(option, Mapping):
                continue
            if option.get("kind") in ("reject_once", "reject_always"):
                option_id = option.get("optionId")
                if isinstance(option_id, str):
                    return {"outcome": {"outcome": "selected", "optionId": option_id}}
    return {"outcome": {"outcome": "cancelled"}}


def _as_mapping(value: object) -> Mapping[str, object]:
    return value if isinstance(value, Mapping) else {}
