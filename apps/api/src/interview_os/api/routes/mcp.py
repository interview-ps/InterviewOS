"""MCP routes — port of `http/routes/mcp.ts`.

v0.4 MCP. Server commands come only from the local interview-os.mcp.json file —
this API can enable/disable servers, allow individual tools and fetch contexts,
but can NEVER configure a command.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter
from pydantic import StrictBool, StringConstraints

from ...core.models import CamelModel, SlugId
from ..deps import StateDep
from ..respond import json_response

__all__ = ["router"]

router = APIRouter(prefix="/api/mcp")


ToolName = Annotated[str, StringConstraints(min_length=1, max_length=64)]


class McpServerPatchSchema(CamelModel):
    enabled: StrictBool | None = None
    allowed_tools: list[ToolName] | None = None


class McpContextFetchSchema(CamelModel):
    server_id: SlugId
    tool: ToolName
    args: dict[str, Any] | None = None
    title: Annotated[str, StringConstraints(min_length=1, max_length=200)] | None = None


@router.get("/servers")
async def list_servers(state: StateDep) -> object:
    view = await state.orchestrator.list_mcp_servers()
    # `description` is an optional server field (omitted when absent) while
    # `loadError` is a nullable view field (always present, `null` when clean).
    data: dict[str, Any] = view.model_dump(by_alias=True, exclude_none=True)
    data["loadError"] = view.load_error
    return json_response(data)


@router.put("/servers/{id}")
async def update_server(id: str, body: McpServerPatchSchema, state: StateDep) -> object:
    patch = body.model_dump(by_alias=True, exclude_unset=True)
    return json_response(await state.orchestrator.update_mcp_server(id, patch))


@router.get("/servers/{id}/tools")
async def list_tools(id: str, state: StateDep) -> object:
    return json_response({"tools": await state.orchestrator.list_mcp_tools(id)})


@router.get("/contexts")
async def list_contexts(state: StateDep) -> object:
    return json_response(await state.orchestrator.list_external_contexts())


@router.post("/contexts")
async def fetch_context(body: McpContextFetchSchema, state: StateDep) -> object:
    context = await state.orchestrator.fetch_external_context(
        {
            "serverId": body.server_id,
            "tool": body.tool,
            "args": body.args,
            "title": body.title,
        }
    )
    return json_response(context, status_code=201)


@router.delete("/contexts/{id}")
async def delete_context(id: str, state: StateDep) -> object:
    await state.orchestrator.delete_external_context(id)
    return json_response({"ok": True})
