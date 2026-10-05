"""Long-lived `codex app-server` child (port of `codex/CodexProcess.ts`).

Owns one process speaking newline-delimited JSON-RPC (no `jsonrpc` field),
auto-restarts on crash, and always declines server→client requests such as
approval prompts.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass

from ..errors import RuntimeError
from ..process import exit_status, spawn_command
from .child_env import build_child_env

__all__ = [
    "CLIENT_INFO",
    "PROCESS_REQUEST_TIMEOUT_MS",
    "CodexProcess",
    "CodexProcessOptions",
    "ExitHandler",
    "NotificationHandler",
]

PROCESS_REQUEST_TIMEOUT_MS = 30_000
CLOSE_GRACE_MS = 2_000

CLIENT_INFO: dict[str, object] = {
    "name": "interview-os",
    "title": "Interview OS",
    "version": "0.1.0",
}

NotificationHandler = Callable[[str, object], None]
ExitHandler = Callable[[int | None, str | None], None]


@dataclass(frozen=True, slots=True)
class CodexProcessOptions:
    bin: str
    workspace_dir: str
    env: Mapping[str, str]
    request_timeout_ms: int | None = None
    extra_child_env: Mapping[str, Sequence[str]] | None = None


class CodexProcess:
    def __init__(self, opts: CodexProcessOptions) -> None:
        self._opts = opts
        self._proc: asyncio.subprocess.Process | None = None
        self._tasks: list[asyncio.Task[None]] = []
        self._pending: dict[int, asyncio.Future[object]] = {}
        self._timers: dict[int, asyncio.TimerHandle] = {}
        self._notification_handlers: list[NotificationHandler] = []
        self._exit_handlers: list[ExitHandler] = []
        self._next_request_id = 1
        self._ready = False
        self._initializing: asyncio.Task[None] | None = None
        #: Increments every time the underlying child process exits.
        self.generation = 0

    @property
    def is_ready(self) -> bool:
        return self._ready

    def on_notification(self, handler: NotificationHandler) -> Callable[[], None]:
        self._notification_handlers.append(handler)

        def off() -> None:
            # `Set.delete` is idempotent; callers unsubscribe from several paths.
            if handler in self._notification_handlers:
                self._notification_handlers.remove(handler)

        return off

    def on_exit(self, handler: ExitHandler) -> Callable[[], None]:
        self._exit_handlers.append(handler)

        def off() -> None:
            if handler in self._exit_handlers:
                self._exit_handlers.remove(handler)

        return off

    async def ensure_ready(self) -> None:
        if self._ready:
            return
        if self._initializing is None:
            self._initializing = asyncio.ensure_future(self._start())
        try:
            await self._initializing
        finally:
            self._initializing = None

    async def _start(self) -> None:
        await self._spawn_child()
        await self.request(
            "initialize",
            {"clientInfo": CLIENT_INFO, "capabilities": None},
            PROCESS_REQUEST_TIMEOUT_MS,
        )
        self.notify("initialized", {})
        self._ready = True

    async def _spawn_child(self) -> None:
        try:
            proc = await spawn_command(
                self._opts.bin,
                ["app-server", "--listen", "stdio://"],
                cwd=self._opts.workspace_dir,
                env=build_child_env(self._opts.env, self._opts.extra_child_env),
            )
        except (OSError, RuntimeError) as err:
            raise RuntimeError("SPAWN_FAILED", f"failed to spawn codex app-server: {err}") from err
        self._proc = proc
        self._tasks = [
            asyncio.ensure_future(self._read_stdout(proc)),
            asyncio.ensure_future(self._drain_stderr(proc)),
            asyncio.ensure_future(self._watch_exit(proc)),
        ]

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
        # drain; never logged (may contain paths)
        stream = proc.stderr
        if stream is None:  # pragma: no cover - stderr is always piped
            return
        while await stream.read(8_192):
            pass

    async def _watch_exit(self, proc: asyncio.subprocess.Process) -> None:
        returncode = await proc.wait()
        code, signal_name = exit_status(returncode)
        self._handle_exit(code, signal_name)

    def _handle_line(self, line: str) -> None:
        try:
            msg = json.loads(line)
        except ValueError:
            return  # non-JSON line on stdout: ignore
        if not isinstance(msg, dict):
            return

        msg_id = msg.get("id")
        method = msg.get("method")

        if msg_id is not None and isinstance(method, str):
            # server→client request (approvals etc.): decline, never approve
            self._send(
                {"id": msg_id, "error": {"code": -32601, "message": "declined by interview-os"}}
            )
            return

        if msg_id is not None and ("result" in msg or "error" in msg):
            pending = self._pending.pop(msg_id, None)
            if pending is None:
                return
            timer = self._timers.pop(msg_id, None)
            if timer is not None:
                timer.cancel()
            error = msg.get("error")
            if error is not None:
                code = error.get("code") if isinstance(error, dict) else None
                message = error.get("message") if isinstance(error, dict) else None
                shown_code = code if code is not None else "?"
                shown_message = message if message is not None else "unknown"
                pending.set_exception(
                    RuntimeError(
                        "PROTOCOL", f"codex app-server error {shown_code}: {shown_message}"
                    )
                )
            else:
                pending.set_result(msg.get("result"))
            return

        if isinstance(method, str):
            for handler in list(self._notification_handlers):
                handler(method, msg.get("params"))

    def _send(self, msg: Mapping[str, object]) -> None:
        proc = self._proc
        if proc is None or proc.stdin is None or proc.stdin.is_closing():
            return
        proc.stdin.write((json.dumps(msg) + "\n").encode("utf-8"))

    async def request(
        self,
        method: str,
        params: object | None = None,
        timeout_ms: int | None = None,
    ) -> object:
        if self._proc is None:
            raise RuntimeError("CRASHED", "codex app-server is not running")
        request_id = self._next_request_id
        self._next_request_id += 1
        timeout = (
            timeout_ms
            if timeout_ms is not None
            else (self._opts.request_timeout_ms or PROCESS_REQUEST_TIMEOUT_MS)
        )
        loop = asyncio.get_running_loop()
        future: asyncio.Future[object] = loop.create_future()
        self._pending[request_id] = future
        self._timers[request_id] = loop.call_later(
            timeout / 1000, self._timeout_request, request_id, method
        )
        self._send(_request_message(request_id, method, params))
        try:
            return await future
        except asyncio.CancelledError:
            self._pending.pop(request_id, None)
            timer = self._timers.pop(request_id, None)
            if timer is not None:
                timer.cancel()
            raise

    def _timeout_request(self, request_id: int, method: str) -> None:
        pending = self._pending.pop(request_id, None)
        self._timers.pop(request_id, None)
        if pending is not None and not pending.done():
            pending.set_exception(
                RuntimeError("TIMEOUT", f"codex app-server request {method} timed out")
            )

    def notify(self, method: str, params: object | None = None) -> None:
        self._send(_request_message(None, method, params))

    def _handle_exit(self, code: int | None, signal_name: str | None) -> None:
        if self._proc is None and not self._tasks:
            return  # error+exit double-fire
        self._proc = None
        self._tasks = []
        self._ready = False
        self.generation += 1
        err = RuntimeError(
            "CRASHED",
            f"codex app-server exited (code={code if code is not None else '?'}, "
            f"signal={signal_name if signal_name is not None else '?'})",
        )
        for request_id, pending in list(self._pending.items()):
            timer = self._timers.pop(request_id, None)
            if timer is not None:
                timer.cancel()
            if not pending.done():
                pending.set_exception(err)
            del self._pending[request_id]
        for handler in list(self._exit_handlers):
            handler(code, signal_name)

    async def close(self) -> None:
        proc = self._proc
        tasks = self._tasks
        self._proc = None
        self._tasks = []
        self._ready = False
        for request_id, pending in list(self._pending.items()):
            timer = self._timers.pop(request_id, None)
            if timer is not None:
                timer.cancel()
            if not pending.done():
                pending.set_exception(RuntimeError("CRASHED", "codex app-server closed"))
            del self._pending[request_id]
        if proc is None:
            return
        # Wait for the OS to reap the child: an exited-but-unreaped process
        # keeps its workspace cwd locked on Windows, so callers that delete the
        # workspace right after dispose() would race with it.
        if proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:  # pragma: no cover - already gone
                pass
            try:
                await asyncio.wait_for(proc.wait(), CLOSE_GRACE_MS / 1000)
            except TimeoutError:  # pragma: no cover - the OS will reap it
                pass
        for task in tasks:
            if not task.done():
                task.cancel()


def _request_message(
    request_id: int | None, method: str, params: object | None
) -> dict[str, object]:
    """`JSON.stringify` drops undefined values, so absent params are omitted."""

    msg: dict[str, object] = {"method": method}
    if request_id is not None:
        msg = {"id": request_id, **msg}
    if params is not None:
        msg["params"] = params
    return msg
