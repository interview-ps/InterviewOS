"""Workspace + analysis + state + test-reset routes — port of `http/routes/workspace.ts`."""

from __future__ import annotations

import os

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ...orchestrator.context import ProgressOptions
from ...orchestrator.services import SetupWorkspaceInput, TargetInput
from ..deps import StateDep
from ..respond import json_response
from ..schemas import JobSchema, ResumeSchema, SetupSchema
from ..streaming import stream_or_json

__all__ = ["router"]

router = APIRouter(prefix="/api")


@router.post("/workspace/setup")
async def setup(request: Request, state: StateDep) -> object:
    body = SetupSchema.model_validate_json(await request.body())
    parsed = SetupWorkspaceInput.model_validate(body.model_dump(by_alias=True))
    return await stream_or_json(
        request,
        lambda on_progress: state.orchestrator.setup_workspace(
            parsed, ProgressOptions(on_progress)
        ),
    )


@router.post("/analysis/resume")
async def analysis_resume(request: Request, state: StateDep) -> object:
    body = ResumeSchema.model_validate_json(await request.body())
    return json_response(await state.orchestrator.analyze_candidate(body.resume_text))


@router.post("/analysis/job")
async def analysis_job(request: Request, state: StateDep) -> object:
    body = JobSchema.model_validate_json(await request.body())
    return json_response(await state.orchestrator.analyze_target(_target_input(body)))


@router.post("/analysis/gaps")
async def analysis_gaps(state: StateDep) -> object:
    return json_response(await state.orchestrator.calculate_gaps())


@router.get("/state")
async def state_route(state: StateDep) -> object:
    return json_response(await state.orchestrator.get_state())


@router.get("/workspace/sources")
async def workspace_sources(state: StateDep) -> object:
    """Persisted resume + active target sources — used to prefill the setup form."""
    return json_response(await state.orchestrator.get_workspace_sources())


@router.post("/test/reset")
async def test_reset(state: StateDep) -> object:
    if os.environ.get("INTERVIEW_OS_TEST_MODE") != "1":
        return JSONResponse(
            status_code=404, content={"error": {"code": "NOT_FOUND", "message": "not found"}}
        )
    await state.orchestrator.reset_all()
    return json_response({"ok": True})


def _target_input(body: JobSchema) -> TargetInput:
    return TargetInput(
        job_description=body.job_description,
        company=body.company,
        role=body.role,
        level=body.level,
        company_notes=body.company_notes,
    )
