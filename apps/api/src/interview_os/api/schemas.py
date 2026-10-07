"""Request-body schemas mirroring `http/schemas.ts` (Pydantic).

These are the bodies the routes validate before calling the orchestrator. They
mirror the Zod shapes; validation errors are surfaced through the central error
handler (see `api/validation.py`).
"""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from ..core.models import CamelModel, Level

__all__ = [
    "JobSchema",
    "ResumeSchema",
    "RuntimeSwitchSchema",
    "SettingsSchema",
    "SetupSchema",
]


class SetupSchema(CamelModel):
    resume_text: str = Field(min_length=1, max_length=190_000)
    job_description: str = Field(min_length=1, max_length=190_000)
    company: str = Field(min_length=1, max_length=200)
    role: str = Field(min_length=1, max_length=200)
    level: Level
    company_notes: str | None = Field(default=None, max_length=20_000)


class ResumeSchema(CamelModel):
    resume_text: str = Field(min_length=1, max_length=190_000)


class JobSchema(CamelModel):
    job_description: str = Field(min_length=1, max_length=190_000)
    company: str = Field(min_length=1, max_length=200)
    role: str = Field(min_length=1, max_length=200)
    level: Level
    company_notes: str | None = Field(default=None, max_length=20_000)


class SettingsSchema(CamelModel):
    model: str | None = None
    reasoning_effort: Literal["low", "medium", "high"] | None = None
    task_mode: Literal["app-server", "exec"] | None = None
    question_sources: dict[str, object] | None = None
    voice: dict[str, object] | None = None
    ai_budget_monthly: float | None = None


class RuntimeSwitchSchema(CamelModel):
    kind: str = Field(min_length=1, max_length=40)
