"""Skills routes — port of `http/routes/skills.ts`."""

from __future__ import annotations

from fastapi import APIRouter

from ...core.serialize import dump_json
from ..deps import StateDep
from ..respond import json_response

__all__ = ["router"]

router = APIRouter(prefix="/api/skills")


@router.get("")
async def list_skills(state: StateDep) -> object:
    manifests = state.orchestrator.list_skill_manifests()
    plugins = await state.orchestrator.list_plugins()
    compatible = {p.manifest.id: p.compatible for p in plugins}
    return json_response(
        {
            "skills": [
                {**dump_json(m), "compatible": compatible.get(m.id, True)} for m in manifests
            ],
            "pluginErrors": state.plugin_errors,
        }
    )
