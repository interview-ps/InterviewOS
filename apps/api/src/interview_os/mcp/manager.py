"""Lazy stdio MCP clients — port of `apps/server/src/mcp/McpManager.ts`.

Owns MCP config (local file only — never HTTP) and lazy stdio clients. The
manager never logs args, tool results, or env values — ids and tool names only —
and never exposes child-process details to the API. Child stderr is untrusted
and is discarded, never forwarded.
"""

from __future__ import annotations

import asyncio
import json
import os
from collections.abc import Awaitable, Callable
from contextlib import AsyncExitStack
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, TextIO

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.types import Implementation
from pydantic import ValidationError

from ..ai.logger import Logger
from ..core.models import (
    INTERVIEW_OS_VERSION,
    AppError,
    CamelModel,
    McpConfig,
    McpServerConfig,
)

__all__ = [
    "CALL_TIMEOUT_MS",
    "MAX_ARGS_BYTES",
    "MAX_OUTPUT_CHARS",
    "McpConfigLoad",
    "McpManager",
    "McpManagerLike",
    "McpServerState",
    "McpToolInfo",
    "child_env",
]

MAX_OUTPUT_CHARS = 12_000
CALL_TIMEOUT_MS = 30_000
MAX_ARGS_BYTES = 4096

_CALL_TIMEOUT_S = CALL_TIMEOUT_MS / 1000

#: Minimal child env: OS essentials + explicitly configured passthrough names.
_BASIC_ENV_NAMES = (
    "PATH",
    "SystemRoot",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
)


@dataclass(frozen=True, slots=True)
class McpServerState:
    enabled: bool
    allowed_tools: tuple[str, ...] = ()


class McpToolInfo(CamelModel):
    name: str
    description: str | None = None


@dataclass(frozen=True, slots=True)
class McpConfigLoad:
    config: McpConfig
    load_error: str | None


@dataclass(slots=True)
class _Client:
    session: ClientSession
    stack: AsyncExitStack


def child_env(config: McpServerConfig) -> dict[str, str]:
    env: dict[str, str] = {}
    for name in (*_BASIC_ENV_NAMES, *config.env_passthrough):
        value = os.environ.get(name)
        if value is not None:
            env[name] = value
    return env


class McpManagerLike(Protocol):
    """The manager surface `McpService` needs (a fake stands in for tests)."""

    def load(self) -> McpConfigLoad: ...

    def server_config(self, server_id: str) -> McpServerConfig | None: ...

    async def list_tools(self, server_id: str) -> list[McpToolInfo]: ...

    async def probe_tools(self, server_id: str) -> list[McpToolInfo]: ...

    async def call_tool(self, server_id: str, tool: str, args: dict[str, object]) -> str: ...

    async def disconnect(self, server_id: str) -> None: ...


StateFor = Callable[[str], "McpServerState | Awaitable[McpServerState]"]


async def _resolve_state(value: McpServerState | Awaitable[McpServerState]) -> McpServerState:
    if isinstance(value, Awaitable):
        return await value
    return value


def _consume_result(task: asyncio.Task[ClientSession]) -> None:
    """A connect that nobody awaits (caller cancelled) must not warn."""

    if not task.cancelled():
        task.exception()


class McpManager:
    def __init__(self, config_path: str | Path, logger: Logger, state_for: StateFor) -> None:
        self._config_path = Path(config_path)
        self._logger = logger
        self._state_for = state_for
        self._clients: dict[str, _Client] = {}
        self._connecting: dict[str, asyncio.Task[ClientSession]] = {}
        self._devnull: TextIO = open(os.devnull, "w")  # noqa: SIM115 - lives for the process

    # ------------------------------------------------------------- config

    def load(self) -> McpConfigLoad:
        """Config load: missing file → no servers; invalid file → surfaced
        loadError."""

        if not self._config_path.exists():
            return McpConfigLoad(config=McpConfig(servers=[]), load_error=None)
        try:
            raw = self._config_path.read_text(encoding="utf-8")
            parsed = McpConfig.model_validate(json.loads(raw))
            ids: set[str] = set()
            for server in parsed.servers:
                if server.id in ids:
                    return McpConfigLoad(
                        config=McpConfig(servers=[]),
                        load_error=f'invalid MCP config: duplicate server id "{server.id}"',
                    )
                ids.add(server.id)
            return McpConfigLoad(config=parsed, load_error=None)
        except ValidationError as err:
            issue = err.errors()[0]
            location = ".".join(str(bit) for bit in issue["loc"])
            return McpConfigLoad(
                config=McpConfig(servers=[]),
                load_error=f"invalid MCP config: {location} {issue['msg']}",
            )
        except Exception as err:  # noqa: BLE001 - a bad config is data, not a crash
            return McpConfigLoad(
                config=McpConfig(servers=[]), load_error=f"invalid MCP config: {err}"
            )

    def server_config(self, server_id: str) -> McpServerConfig | None:
        return next(
            (server for server in self.load().config.servers if server.id == server_id), None
        )

    async def _state(self, server_id: str) -> tuple[McpServerConfig, McpServerState]:
        config = self.server_config(server_id)
        if config is None:
            raise AppError("NOT_FOUND", f'no MCP server "{server_id}"')
        state = await _resolve_state(self._state_for(server_id))
        if not state.enabled:
            raise AppError("VALIDATION", f'MCP server "{server_id}" is disabled')
        return config, state

    # ------------------------------------------------------------ clients

    async def _client(self, server_id: str) -> ClientSession:
        existing = self._clients.get(server_id)
        if existing is not None:
            return existing.session
        pending = self._connecting.get(server_id)
        if pending is not None:
            return await pending

        async def connect() -> ClientSession:
            config = self.server_config(server_id)
            if config is None:
                raise AppError("NOT_FOUND", f'no MCP server "{server_id}"')
            params = StdioServerParameters(
                command=config.command, args=list(config.args), env=child_env(config)
            )
            stack = AsyncExitStack()
            try:
                read_stream, write_stream = await stack.enter_async_context(
                    stdio_client(params, errlog=self._devnull)
                )
                session = await stack.enter_async_context(
                    ClientSession(
                        read_stream,
                        write_stream,
                        read_timeout_seconds=_CALL_TIMEOUT_S,
                        client_info=Implementation(
                            name="interview-os", version=INTERVIEW_OS_VERSION
                        ),
                    )
                )
                await session.initialize()
            except BaseException as err:
                await stack.aclose()
                raise AppError(
                    "MCP_UNAVAILABLE", f'MCP server "{server_id}" could not be reached'
                ) from err
            self._clients[server_id] = _Client(session=session, stack=stack)
            return session

        task = asyncio.ensure_future(connect())
        task.add_done_callback(_consume_result)
        self._connecting[server_id] = task
        try:
            return await task
        finally:
            self._connecting.pop(server_id, None)

    async def list_tools(self, server_id: str) -> list[McpToolInfo]:
        await self._state(server_id)  # requires enabled
        client = await self._client(server_id)
        result = await client.list_tools()
        return [McpToolInfo(name=tool.name, description=tool.description) for tool in result.tools]

    async def probe_tools(self, server_id: str) -> list[McpToolInfo]:
        """Tool list without the enabled gate — used to validate allowedTools
        updates."""

        client = await self._client(server_id)
        result = await client.list_tools()
        return [McpToolInfo(name=tool.name, description=tool.description) for tool in result.tools]

    async def call_tool(self, server_id: str, tool: str, args: dict[str, object]) -> str:
        """Returns the joined text parts, truncated to MAX_OUTPUT_CHARS."""

        _, state = await self._state(server_id)
        if tool not in state.allowed_tools:
            raise AppError(
                "VALIDATION",
                f'tool "{tool}" is not in allowedTools for MCP server "{server_id}"',
            )
        args_json = json.dumps(args if args is not None else {}, separators=(",", ":"))
        if len(args_json.encode("utf-8")) > MAX_ARGS_BYTES:
            raise AppError("VALIDATION", "tool args exceed 4 KB")
        client = await self._client(server_id)
        self._logger.info("mcp.call", {"server": server_id, "tool": tool})
        result = await client.call_tool(tool, args, read_timeout_seconds=_CALL_TIMEOUT_S)
        content = getattr(result, "content", None)
        if bool(getattr(result, "is_error", False)):
            raise AppError("MCP_UNAVAILABLE", f'tool "{tool}" on "{server_id}" returned an error')
        parts = [
            part.text
            for part in (content if isinstance(content, list) else [])
            if getattr(part, "type", None) == "text"
            and isinstance(getattr(part, "text", None), str)
        ]
        text = "\n".join(parts)
        return text[:MAX_OUTPUT_CHARS] if len(text) > MAX_OUTPUT_CHARS else text

    async def disconnect(self, server_id: str) -> None:
        """Forget a cached client (e.g. after state changes) without failing."""

        client = self._clients.pop(server_id, None)
        if client is not None:
            try:
                await client.stack.aclose()
            except BaseException:  # noqa: BLE001 - closing is best-effort
                pass

    async def close_all(self) -> None:
        for server_id in list(self._clients):
            await self.disconnect(server_id)
        self._devnull.close()
