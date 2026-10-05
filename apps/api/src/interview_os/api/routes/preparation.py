"""Preparation routes — port of `http/routes/preparation.ts`."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from ...core.models import CamelModel, PrepActionStatus
from ..deps import StateDep
from ..respond import json_response

__all__ = ["router"]

router = APIRouter(prefix="/api/preparation")


class ActionPatchSchema(CamelModel):
    status: PrepActionStatus


class ActionCompleteSchema(CamelModel):
    checked_criteria: list[str] | None = None


class PluginSuggestionAcceptSchema(CamelModel):
    plugin_id: str
    activity: Any = None


@router.get("")
async def list_preparation(state: StateDep) -> object:
    app_state = await state.orchestrator.get_state()
    return json_response(
        {
            "nextActions": app_state.preparation.next_actions,
            "actions": await state.orchestrator.list_preparation_actions(),
        }
    )


@router.post("/recalculate")
async def recalculate(state: StateDep) -> object:
    return json_response(await state.orchestrator.build_preparation_plan())


# ------------------------------------------------ v1 plugin suggestions --


@router.get("/suggestions")
async def suggestions(state: StateDep) -> object:
    """Plugin-suggested prep activities with attribution (read-only)."""

    return json_response({"suggestions": await state.orchestrator.plugin_prep_suggestions()})


@router.post("/suggestions/accept")
async def accept_suggestion(body: PluginSuggestionAcceptSchema, state: StateDep) -> object:
    """Accept a suggestion → prep action `source: "plugin:<id>"`."""

    return json_response(
        await state.orchestrator.accept_plugin_suggestion(body.plugin_id, body.activity)
    )


@router.patch("/{id}")
async def update_action(id: str, body: ActionPatchSchema, state: StateDep) -> object:
    await state.orchestrator.update_action_status(id, body.status.value)
    return json_response({"ok": True})


@router.post("/{id}/complete")
async def complete_action(
    id: str, state: StateDep, body: ActionCompleteSchema | None = None
) -> object:
    # Optional body (Zod `ActionCompleteSchema` via `parseOptionalBody ?? {}`).
    # The service reads camelCase `checkedCriteria`; omit-unset keeps `{}`.
    opts = {} if body is None else body.model_dump(by_alias=True, exclude_unset=True)
    return json_response(await state.orchestrator.complete_action(id, opts))


# v0.4: pull learning resources for an action from enabled `resources` plugins.
@router.post("/{id}/resources")
async def action_resources(id: str, state: StateDep) -> object:
    return json_response(await state.orchestrator.fetch_plugin_resources(id))
