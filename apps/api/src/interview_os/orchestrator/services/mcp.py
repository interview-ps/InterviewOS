"""MCP service — port of `apps/server/src/orchestrator/mcp-service.ts`."""

from __future__ import annotations

from typing import Any

from ...core import new_id
from ...core.models import AppError, CamelModel, ExternalContext, ExternalContextRow
from ...mcp.manager import McpManagerLike, McpToolInfo
from ..context import WorkflowContext

__all__ = ["McpServerPatch", "McpServerView", "McpServersView", "McpService"]


class McpServerView(CamelModel):
    id: str
    name: str
    description: str | None = None
    command: str
    args: list[str]
    #: Env var NAMES only — values never leave the process.
    env_passthrough: list[str]
    enabled: bool
    allowed_tools: list[str]


class McpServersView(CamelModel):
    servers: list[McpServerView]
    load_error: str | None = None


class McpServerPatch(CamelModel):
    enabled: bool | None = None
    allowed_tools: list[str] | None = None


class McpService:
    def __init__(self, ctx: WorkflowContext, manager: McpManagerLike | None) -> None:
        self._ctx = ctx
        self._manager = manager

    def _require_manager(self) -> McpManagerLike:
        if self._manager is None:
            raise AppError("VALIDATION", "MCP is not configured on this orchestrator")
        return self._manager

    async def list_mcp_servers(self) -> McpServersView:
        manager = self._manager
        if manager is None:
            return McpServersView(servers=[], load_error=None)
        loaded = manager.load()
        states = {row.id: row for row in self._ctx.store.list_mcp_servers()}
        return McpServersView(
            load_error=loaded.load_error,
            servers=[
                McpServerView(
                    id=server.id,
                    name=server.name,
                    description=server.description,
                    command=server.command,
                    args=list(server.args),
                    env_passthrough=list(server.env_passthrough),
                    enabled=(states[server.id].enabled if server.id in states else 0) == 1,
                    allowed_tools=(
                        list(states[server.id].allowed_tools) if server.id in states else []
                    ),
                )
                for server in loaded.config.servers
            ],
        )

    async def update_mcp_server(self, id: str, patch: McpServerPatch) -> McpServerView:
        manager = self._require_manager()
        config = manager.server_config(id)
        if config is None:
            raise AppError("NOT_FOUND", f'no MCP server "{id}"')
        row = self._ctx.store.get_mcp_server(id)
        enabled = (
            patch.enabled if patch.enabled is not None else (row is not None and row.enabled == 1)
        )
        allowed_tools = (
            list(patch.allowed_tools)
            if patch.allowed_tools is not None
            else (list(row.allowed_tools) if row is not None else [])
        )
        for tool in allowed_tools:
            if not isinstance(tool, str) or len(tool) == 0 or len(tool) > 64:
                raise AppError("VALIDATION", "allowedTools entries must be 1–64 chars")
        # When the (new) state is enabled, validate tool names against a live
        # listTools; an unreachable server still accepts the names.
        if enabled and patch.allowed_tools is not None:
            try:
                live = {tool.name for tool in await manager.probe_tools(id)}
                for tool in allowed_tools:
                    if tool not in live:
                        raise AppError(
                            "VALIDATION", f'tool "{tool}" is not exposed by MCP server "{id}"'
                        )
            except AppError as err:
                if err.code == "VALIDATION":
                    raise
                self._ctx.logger.warn("mcp.probe_failed", {"server": id})
            except Exception:  # noqa: BLE001 - an unreachable server is not a failure
                self._ctx.logger.warn("mcp.probe_failed", {"server": id})
        self._ctx.store.upsert_mcp_server(
            id=id,
            enabled=1 if enabled else 0,
            allowed_tools=allowed_tools,
            updated_at=self._ctx.iso(),
        )
        if not enabled:
            await manager.disconnect(id)
        self._ctx.logger.info("mcp.updated", {"server": id, "enabled": enabled})
        return McpServerView(
            id=id,
            name=config.name,
            description=config.description,
            command=config.command,
            args=list(config.args),
            env_passthrough=list(config.env_passthrough),
            enabled=enabled,
            allowed_tools=allowed_tools,
        )

    async def list_mcp_tools(self, id: str) -> list[McpToolInfo]:
        return await self._require_manager().list_tools(id)

    async def fetch_external_context(
        self,
        *,
        server_id: str,
        tool: str,
        args: dict[str, Any] | None = None,
        title: str | None = None,
    ) -> ExternalContext:
        manager = self._require_manager()
        text = await manager.call_tool(server_id, tool, args if args is not None else {})
        config = manager.server_config(server_id)
        context = ExternalContext(
            id=new_id("ctx"),
            server_id=server_id,
            tool=tool,
            title=title if title is not None else f"{config.name if config else server_id}: {tool}",
            text=text,
            created_at=self._ctx.iso(),
        )
        self._ctx.store.insert_external_context(_as_row(context))
        return context

    async def list_external_contexts(self) -> list[ExternalContext]:
        return [_from_row(row) for row in self._ctx.store.list_external_contexts()]

    async def delete_external_context(self, id: str) -> None:
        row = self._ctx.store.get_external_context(id)
        if row is None:
            raise AppError("NOT_FOUND", f"no external context {id}")
        self._ctx.store.delete_external_context(id)


def _as_row(context: ExternalContext) -> ExternalContextRow:
    return ExternalContextRow.model_validate(context.model_dump())


def _from_row(row: ExternalContextRow) -> ExternalContext:
    return ExternalContext.model_validate(row.model_dump())
