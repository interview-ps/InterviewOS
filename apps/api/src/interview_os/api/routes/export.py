"""Export/import routes — port of `http/routes/export.ts`.

Thin attachments over the orchestrator: a full bundle, per-part slices, and a
replace-mode import that requires an explicit `confirm: "replace"`.

Two wire-shape repairs live here because the bundle rows keep some sections as
opaque `Json` (the central `dump_json` optional-null omission cannot reach
inside them) and because the Hono export returns the raw store rows:

- the candidate/target `data` blocks are re-serialized through their domain
  models so Zod `.optional()` keys are omitted rather than emitted as `null`;
- preparation actions regain the `source` column the bundle schema drops.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import APIRouter
from pydantic import ValidationError

from ...core.models import CamelModel, CandidateProfile, PrepResource, TargetRole
from ...core.serialize import dump_json
from ...store.store import Store
from ..deps import StateDep
from ..respond import json_response

__all__ = ["router"]

router = APIRouter(prefix="/api")


class ImportSchema(CamelModel):
    bundle: Any
    #: Destructive replace requires an explicit confirmation.
    confirm: Literal["replace"]


def _revalidate(model: type[CamelModel], raw: Any) -> Any:
    """Re-serialize an opaque `Json` section through its domain model.

    On failure the raw value is kept — a raw bundle must still export.
    """

    try:
        return dump_json(model.model_validate(raw))
    except ValidationError:
        return raw


def _revalidate_resources(raw: Any) -> Any:
    try:
        return [dump_json(PrepResource.model_validate(item)) for item in raw]
    except (ValidationError, TypeError):
        return raw


def _wire_section(name: str, section: Any, store: Store) -> Any:
    """Restore the Zod wire shape for the bundle sections that need it."""

    if name == "candidate":
        for profile in section["profiles"]:
            profile["data"] = _revalidate(CandidateProfile, profile["data"])
    elif name == "targets":
        for target in section:
            target["data"] = _revalidate(TargetRole, target["data"])
    elif name == "preparation":
        sources = {row.id: row.source for row in store.list_actions()}
        for action in section["actions"]:
            action["resources"] = _revalidate_resources(action["resources"])
            source = sources.get(action.get("id"))
            if source is not None:
                action["source"] = source
    return section


def _dated_filename(prefix: str) -> str:
    date = datetime.now(UTC).strftime("%Y-%m-%d")
    return f"{prefix}-{date}.json"


@router.get("/export")
async def export_state(state: StateDep) -> object:
    bundle = await state.orchestrator.export_state()
    payload = dump_json(bundle)
    _wire_section("candidate", payload["candidate"], state.store)
    _wire_section("targets", payload["targets"], state.store)
    _wire_section("preparation", payload["preparation"], state.store)
    response = json_response(payload)
    response.headers["content-disposition"] = (
        f'attachment; filename="{_dated_filename("interview-os-export")}"'
    )
    return response


@router.get("/export/{part}")
async def export_state_part(part: str, state: StateDep) -> object:
    slice_ = await state.orchestrator.export_state_part(part)
    payload = _wire_section(part, dump_json(slice_), state.store)
    response = json_response(payload)
    response.headers["content-disposition"] = f'attachment; filename="{part}.json"'
    return response


@router.post("/import")
async def import_state(body: ImportSchema, state: StateDep) -> object:
    counts = await state.orchestrator.import_state(body.bundle, {"mode": body.confirm})
    return json_response({"ok": True, "counts": counts})
