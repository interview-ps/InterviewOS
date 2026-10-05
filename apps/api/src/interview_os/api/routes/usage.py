"""Usage routes — port of `http/routes/usage.ts`.

Mounts at `/api` (the Hono app mounts `usageRoutes` there), so the paths are
`/api/events` and `/api/metrics`.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter
from pydantic import StringConstraints

from ...core.models import CamelModel
from ..deps import StateDep
from ..respond import json_response

__all__ = ["router"]

router = APIRouter(prefix="/api")


class UsageEventSchema(CamelModel):
    event: Annotated[str, StringConstraints(min_length=1, max_length=64)]


@router.post("/events")
async def record_event(body: UsageEventSchema, state: StateDep) -> object:
    await state.orchestrator.record_usage_event(body.event)
    return json_response({"ok": True})


@router.get("/metrics")
async def metrics(state: StateDep) -> object:
    view = await state.orchestrator.get_metrics()
    # `MetricsView` nullables (`improvementAfterPrep`, the `rate`s) stay `null`
    # on the wire, so serialize the full field set rather than omitting unset.
    return json_response(view.model_dump(by_alias=True))
