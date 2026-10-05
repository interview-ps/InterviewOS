"""Skills routes — port of `http/routes/skills.ts`."""

from __future__ import annotations

from fastapi import APIRouter

from ..deps import StateDep

__all__ = ["router"]

router = APIRouter(prefix="/api/skills")


@router.get("")
async def list_skills(state: StateDep) -> dict[str, object]:
    manifests = state.orchestrator.list_skill_manifests()
    plugins = await state.orchestrator.list_plugins()
    compatible = {p.manifest.id: p.compatible for p in plugins}
    return {
        "skills": [
            {**m.model_dump(by_alias=True), "compatible": compatible.get(m.id, True)}
            for m in manifests
        ],
        "pluginErrors": state.plugin_errors,
    }
