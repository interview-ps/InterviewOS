"""Resume routes — port of `http/routes/resume.ts`."""

from __future__ import annotations

from fastapi import APIRouter, Request

from ...orchestrator.context import ProgressOptions
from ..deps import StateDep
from ..respond import json_response
from ..streaming import stream_or_json

__all__ = ["router"]

router = APIRouter(prefix="/api/resume")


@router.post("/review")
async def review(request: Request, state: StateDep) -> object:
    return await stream_or_json(
        request,
        lambda on_progress: state.orchestrator.review_resume(ProgressOptions(on_progress)),
    )


@router.get("/reviews/latest")
async def latest_review(state: StateDep) -> object:
    return json_response(await state.orchestrator.latest_resume_review())
