"""Isolated plugin executor — port of `apps/server/src/plugins/executor.ts`.

Runs a plugin inside a locked-down child process (`--permission`, fs read
limited to the plugin + runner dirs, no env, network globals deleted, dangerous
builtin modules blocked by a resolve hook). All communication is JSON over IPC,
validated here.

Node IPC (`process.send`, which the sandboxed `runner.mjs` relies on) cannot be
driven from a Python parent, so the trusted host bridge
(`plugins/runner/bridge.mjs`) sits in between: it forks `runner.mjs` with the
exact `--permission` sandbox the TS executor used to pass inline and relays
newline-delimited JSON between this executor (stdin/stdout) and the child (IPC).
One bridge+runner spawn serves one `execute`/`describe`, matching the TS
per-call model.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Any, Literal, Protocol

from pydantic import BaseModel, Field, TypeAdapter, ValidationError

from ..ai.interface import AgentResult, AgentTask
from ..ai.logger import Logger
from ..core.models import CamelModel, LooseCamelModel, Permission, SkillManifest
from ..skills.framework import SkillContext
from ..skills.host import (
    PLUGIN_OUTPUT_MAX_BYTES,
    PLUGIN_TIMEOUT_MS,
    PluginError,
)

__all__ = [
    "IsolatedExecutorDeps",
    "IsolatedPluginExecutor",
    "PluginDescription",
    "PluginStorageAdapter",
    "create_isolated_executor",
]


RUNNER_DIR = Path(__file__).resolve().parent / "runner"
BRIDGE_PATH = RUNNER_DIR / "bridge.mjs"

#: describe() mirrors the TS 10 s ceiling; a failed describe degrades to no-op.
DESCRIBE_TIMEOUT_MS = 10_000

#: v1: settings-access hook — resolved lazily on every run when `ctx.settings`
#: is unset (the in-process caller supplies none).
SettingsProvider = Callable[[], Awaitable[dict[str, object]]]


def _resolve_sdk_mock_helpers() -> str | None:
    """Locate the SDK's deterministic mock helpers on disk.

    TS resolves the bare specifier `@interview-os/plugin-sdk/mock-helpers` via
    `createRequire`. Python has no Node resolver, so an explicit
    `INTERVIEW_OS_SDK_MOCK_HELPERS` path wins, then the monorepo's built
    `dist/mock-helpers.js`, then (documented fallback) the source
    `packages/plugin-sdk/src/mock-helpers.ts`. Returns None when nothing exists —
    the runner then leaves the specifier unresolved.
    """

    override = os.environ.get("INTERVIEW_OS_SDK_MOCK_HELPERS")
    candidates: list[Path] = []
    if override:
        candidates.append(Path(override))
    try:
        repo_root = Path(__file__).resolve().parents[5]
    except IndexError:
        repo_root = None
    if repo_root is not None:
        package = repo_root / "packages" / "plugin-sdk"
        candidates.append(package / "dist" / "mock-helpers.js")
        candidates.append(package / "src" / "mock-helpers.ts")
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    return None


SDK_MOCK_HELPERS_PATH = _resolve_sdk_mock_helpers()
#: The URL form the runner maps the bare specifier onto (empty = unresolved).
SDK_MOCK_HELPERS_URL = (
    Path(SDK_MOCK_HELPERS_PATH).as_uri() if SDK_MOCK_HELPERS_PATH else ""
)


def _node_executable() -> str:
    return os.environ.get("INTERVIEW_OS_NODE") or shutil.which("node") or "node"


def _child_env() -> dict[str, str]:
    """The bridge/runner env: `SystemRoot` plus `PATH` (to launch node)."""

    env: dict[str, str] = {}
    system_root = os.environ.get("SystemRoot")
    if system_root:
        env["SystemRoot"] = system_root
    path = os.environ.get("PATH")
    if path:
        env["PATH"] = path
    return env


# --------------------------------------------------------- child message schema


class _ResultMessage(CamelModel):
    type: Literal["result"]
    output: Any


class _ErrorMessage(CamelModel):
    type: Literal["error"]
    message: str = Field(max_length=2000)


class _RunTaskMessage(CamelModel):
    type: Literal["runTask"]
    id: str = Field(max_length=64)
    task: Any


class _LogMessage(CamelModel):
    type: Literal["log"]
    message: str = Field(max_length=1000)


class _StorageMessage(CamelModel):
    type: Literal["storage"]
    op: Literal["get", "set", "delete"]
    id: str = Field(max_length=64)
    key: str = Field(max_length=200)
    value: Any = None


class _DescribedMessage(CamelModel):
    type: Literal["described"]
    id: str | None = Field(default=None, max_length=64)
    handlers: list[str]
    has_execute: bool
    error: str | None = None


class _ExitMessage(CamelModel):
    """Bridge-only: the forked runner terminated (its `close`/`error`)."""

    type: Literal["exit"]
    code: int | None = None
    error: str | None = None


_ChildMessage = Annotated[
    _ResultMessage
    | _ErrorMessage
    | _RunTaskMessage
    | _LogMessage
    | _StorageMessage
    | _DescribedMessage
    | _ExitMessage,
    Field(discriminator="type"),
]
_CHILD_MESSAGE: TypeAdapter[_ChildMessage] = TypeAdapter(_ChildMessage)


# --------------------------------------------------------------------- contracts


class PluginStorageAdapter(Protocol):
    """Parent side of the plugin KV store — backed by plugin_storage rows."""

    async def get(self, key: str) -> object: ...

    async def set(self, key: str, value: object) -> None: ...

    async def delete(self, key: str) -> None: ...


class PluginDescription(LooseCamelModel):
    """What `describe()` reports: the plugin's handlers + legacy execute flag."""

    handlers: list[str]
    has_execute: bool


@dataclass(slots=True)
class IsolatedExecutorDeps:
    plugin_dir: str
    entry_file: str
    manifest: SkillManifest
    logger: Logger | None = None
    timeout_ms: int | None = None
    #: v1: settings values passed to the plugin on every run.
    get_settings: SettingsProvider | None = None
    #: v1: the plugin's own KV store (plugin-owned rows, no permission).
    storage: PluginStorageAdapter | None = None


# ------------------------------------------------------------------- executor


class _Bridge:
    """A live bridge process plus its stderr byte counter."""

    def __init__(self, proc: asyncio.subprocess.Process) -> None:
        self.proc = proc
        self.stderr_bytes = 0
        self._stderr_task: asyncio.Task[None] | None = None

    @classmethod
    async def spawn(cls, argv: list[str], cwd: str, env: Mapping[str, str]) -> _Bridge:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            cwd=cwd,
            env=dict(env),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        bridge = cls(proc)
        bridge._stderr_task = asyncio.create_task(bridge._drain_stderr())
        return bridge

    async def _drain_stderr(self) -> None:
        stream = self.proc.stderr
        if stream is None:
            return
        while True:
            chunk = await stream.read(4096)
            if not chunk:
                return
            self.stderr_bytes += len(chunk)

    async def send(self, message: Mapping[str, object]) -> None:
        stream = self.proc.stdin
        if stream is None:
            return
        try:
            stream.write((json.dumps(dict(message), default=_json_default) + "\n").encode("utf-8"))
            await stream.drain()
        except (BrokenPipeError, ConnectionResetError, OSError, ValueError):
            # channel may already be gone if the child crashed early — never let
            # a reply throw out of a promise handler.
            return

    async def readline(self) -> bytes:
        stream = self.proc.stdout
        if stream is None:
            return b""
        try:
            return await stream.readline()
        except (ConnectionResetError, OSError):
            return b""

    def parse(self, raw: bytes) -> _ChildMessage | None:
        text = raw.decode("utf-8", "replace").strip()
        if not text:
            return None
        try:
            payload = json.loads(text)
        except ValueError:
            return None
        try:
            return _CHILD_MESSAGE.validate_python(payload)
        except ValidationError:
            return None

    async def close(self) -> None:
        if self.proc.returncode is None:
            try:
                self.proc.kill()
            except ProcessLookupError:
                pass
        try:
            await self.proc.wait()
        except ProcessLookupError:
            pass
        if self._stderr_task is not None:
            self._stderr_task.cancel()
            try:
                await self._stderr_task
            except asyncio.CancelledError:
                pass


class IsolatedPluginExecutor:
    """Runs a plugin in a locked-down bridge+runner child; talks JSON over IPC."""

    def __init__(self, deps: IsolatedExecutorDeps) -> None:
        self._deps = deps
        self._plugin_dir = deps.plugin_dir
        self._entry_file = deps.entry_file
        self._manifest = deps.manifest
        self._logger = deps.logger
        self._timeout_ms = deps.timeout_ms if deps.timeout_ms is not None else PLUGIN_TIMEOUT_MS

    # The TS executor returns a plain `{execute, describe}`; the protocol's
    # optional output schema is absent (plugins validate their own output shape).
    @property
    def output_schema(self) -> None:
        return None

    async def _spawn(self) -> _Bridge:
        argv = [
            _node_executable(),
            str(BRIDGE_PATH),
            self._plugin_dir,
            self._entry_file,
            SDK_MOCK_HELPERS_URL,
        ]
        return await _Bridge.spawn(argv, self._plugin_dir, _child_env())

    async def execute(self, input: dict[str, object], ctx: SkillContext) -> object:
        # the effective grant (manifest ∩ user grant) decides what the child may
        # do; manifest permissions fall back for in-process callers that never
        # set a grant.
        granted = (
            ctx.granted_permissions
            if ctx.granted_permissions is not None
            else self._manifest.permissions
        )
        can_invoke_runtime = Permission.RUNTIME_INVOKE in granted

        bridge = await self._spawn()
        try:
            settings: object = ctx.settings
            if settings is None:
                settings = (
                    await self._deps.get_settings() if self._deps.get_settings is not None else {}
                )
            await bridge.send(
                {
                    "type": "run",
                    "input": input,
                    "request": input.get("request"),
                    "hook": ctx.plugin_hook,
                    "hookRequest": ctx.hook_request,
                    "settings": settings,
                    "runtimeInvoke": can_invoke_runtime,
                }
            )
            output = await self._pump(bridge, ctx, can_invoke_runtime)
        finally:
            await self._finish(bridge)

        try:
            serialized = json.dumps(output, ensure_ascii=False)
        except (TypeError, ValueError) as err:
            raise PluginError(
                "PLUGIN_OUTPUT",
                f'plugin "{self._manifest.id}" returned a non-JSON-serializable value',
            ) from err
        if len(serialized.encode("utf-8")) > PLUGIN_OUTPUT_MAX_BYTES:
            raise PluginError(
                "PLUGIN_OUTPUT",
                f'plugin "{self._manifest.id}" output exceeds {PLUGIN_OUTPUT_MAX_BYTES} bytes',
            )
        return output

    async def describe(self) -> PluginDescription:
        """Import the plugin in an isolated child and report its handlers."""

        bridge = await self._spawn()
        try:
            await bridge.send({"type": "describe", "id": "d1"})
            try:
                async with asyncio.timeout(DESCRIBE_TIMEOUT_MS / 1000):
                    while True:
                        raw = await bridge.readline()
                        if not raw:
                            return PluginDescription(handlers=[], has_execute=False)
                        message = bridge.parse(raw)
                        if isinstance(message, _DescribedMessage):
                            return PluginDescription(
                                handlers=message.handlers, has_execute=message.has_execute
                            )
                        if isinstance(message, _ExitMessage):
                            return PluginDescription(handlers=[], has_execute=False)
            except TimeoutError:
                return PluginDescription(handlers=[], has_execute=False)
        finally:
            await self._finish(bridge)

    async def _pump(
        self,
        bridge: _Bridge,
        ctx: SkillContext,
        can_invoke_runtime: bool,
    ) -> object:
        try:
            async with asyncio.timeout(self._timeout_ms / 1000):
                while True:
                    raw = await bridge.readline()
                    if not raw:
                        code = (
                            bridge.proc.returncode
                            if bridge.proc.returncode is not None
                            else "unknown"
                        )
                        raise PluginError(
                            "PLUGIN_OUTPUT",
                            f'plugin "{self._manifest.id}" exited without a result (code {code})',
                        )
                    message = bridge.parse(raw)
                    if message is None:
                        continue
                    if isinstance(message, _ResultMessage):
                        return message.output
                    if isinstance(message, _ErrorMessage):
                        raise PluginError(
                            "PLUGIN_OUTPUT",
                            f'plugin "{self._manifest.id}" failed: {message.message[:300]}',
                        )
                    if isinstance(message, _ExitMessage):
                        code = message.code if message.code is not None else "unknown"
                        raise PluginError(
                            "PLUGIN_OUTPUT",
                            f'plugin "{self._manifest.id}" exited without a result (code {code})',
                        )
                    if isinstance(message, _LogMessage):
                        if self._logger is not None:
                            self._logger.info(
                                "plugin.log",
                                {"plugin": self._manifest.id, "message": message.message[:500]},
                            )
                        continue
                    if isinstance(message, _StorageMessage):
                        await self._handle_storage(bridge, ctx, message)
                        continue
                    if isinstance(message, _RunTaskMessage):
                        await self._handle_run_task(bridge, ctx, message, can_invoke_runtime)
                        continue
                    # `described` is only meaningful for describe().
        except TimeoutError as err:
            raise PluginError(
                "PLUGIN_TIMEOUT",
                f'plugin "{self._manifest.id}" exceeded {round(self._timeout_ms / 1000)}s',
            ) from err

    async def _finish(self, bridge: _Bridge) -> None:
        await bridge.close()
        if bridge.stderr_bytes > 0 and self._logger is not None:
            self._logger.warn(
                "plugin.stderr",
                {"plugin": self._manifest.id, "bytes": bridge.stderr_bytes},
            )

    async def _handle_storage(
        self, bridge: _Bridge, ctx: SkillContext, message: _StorageMessage
    ) -> None:
        storage = ctx.storage if ctx.storage is not None else self._deps.storage
        if storage is None:
            await bridge.send(
                {
                    "type": "storageResult",
                    "id": message.id,
                    "ok": False,
                    "error": "storage unavailable",
                }
            )
            return
        reply: dict[str, object]
        try:
            if message.op == "get":
                value = await storage.get(message.key)
                reply = {
                    "type": "storageResult",
                    "id": message.id,
                    "ok": True,
                    "value": _jsonable(value),
                }
            elif message.op == "set":
                await storage.set(message.key, message.value)
                reply = {"type": "storageResult", "id": message.id, "ok": True}
            else:
                await storage.delete(message.key)
                reply = {"type": "storageResult", "id": message.id, "ok": True}
        except Exception as err:  # noqa: BLE001 - every failure is a reply, never a crash
            reply = {
                "type": "storageResult",
                "id": message.id,
                "ok": False,
                "error": str(err)[:300],
            }
        await bridge.send(reply)

    async def _handle_run_task(
        self,
        bridge: _Bridge,
        ctx: SkillContext,
        message: _RunTaskMessage,
        can_invoke_runtime: bool,
    ) -> None:
        if not can_invoke_runtime:
            await bridge.send(
                {
                    "type": "runTaskError",
                    "id": message.id,
                    "message": "runtime.invoke is not granted to this plugin",
                }
            )
            return
        # the host's denying-proxy getter can throw synchronously on access —
        # keep every failure as a runTaskError reply, never an uncaught throw.
        try:
            result = await ctx.runtime.run_task(_agent_task(message.task))
        except Exception as err:  # noqa: BLE001 - surface as a reply
            await bridge.send(
                {"type": "runTaskError", "id": message.id, "message": str(err)[:300]}
            )
            return
        if result.ok:
            await bridge.send(
                {
                    "type": "runTaskResult",
                    "id": message.id,
                    "result": _agent_result_payload(result),
                }
            )
        else:
            error = result.error
            text = error.message if error is not None else "runTask failed"
            await bridge.send(
                {"type": "runTaskError", "id": message.id, "message": text[:300]}
            )


def create_isolated_executor(deps: IsolatedExecutorDeps) -> IsolatedPluginExecutor:
    return IsolatedPluginExecutor(deps)


def _agent_task(raw: object) -> AgentTask:
    data: Mapping[str, object] = raw if isinstance(raw, Mapping) else {}

    def pick(*names: str) -> object:
        for name in names:
            if name in data:
                return data[name]
        return None

    effort = pick("effort")
    task_mode = pick("taskMode", "task_mode")
    timeout = pick("timeoutMs", "timeout_ms")
    schema = pick("outputSchema", "output_schema")
    model = pick("model")
    return AgentTask(
        task_id=str(pick("taskId", "task_id") or ""),
        instructions=str(pick("instructions") or ""),
        input=pick("input"),
        output_schema=dict(schema) if isinstance(schema, Mapping) else {},
        timeout_ms=timeout if isinstance(timeout, int) else None,
        model=str(model) if model is not None else None,
        effort=effort if effort in ("low", "medium", "high") else None,
        task_mode=task_mode if task_mode in ("app-server", "exec") else None,
    )


def _agent_result_payload(result: AgentResult) -> dict[str, object]:
    error = result.error
    return {
        "ok": result.ok,
        "durationMs": result.duration_ms,
        "events": [_jsonable(event) for event in result.events],
        "output": _jsonable(result.output),
        "raw": result.raw,
        "error": (
            {"code": error.code, "message": error.message} if error is not None else None
        ),
    }


def _json_default(value: object) -> object:
    """JSON fallback for IPC: Pydantic models map to their camelCase JSON form."""

    if isinstance(value, BaseModel):
        return value.model_dump(by_alias=True, mode="json")
    return str(value)


def _jsonable(value: object) -> object:
    if isinstance(value, BaseModel):
        return value.model_dump(by_alias=True, mode="json")
    if isinstance(value, Mapping):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    return value
