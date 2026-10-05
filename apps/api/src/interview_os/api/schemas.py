"""Request-body schemas mirroring `http/schemas.ts` (Pydantic).

These are the bodies the routes validate before calling the orchestrator. They
mirror the Zod shapes; validation errors are surfaced through the central error
handler (see `api/errors.py`).
"""

from __future__ import annotations

from ..core.models import CamelModel

__all__ = [
    "JobSchema",
    "ResumeSchema",
    "SettingsSchema",
    "SetupSchema",
]


class SetupSchema(CamelModel):
    resume_text: str
    job_description: str
    company: str
    role: str
    level: str
    company_notes: str | None = None


class ResumeSchema(CamelModel):
    resume_text: str


class JobSchema(CamelModel):
    job_description: str
    company: str
    role: str
    level: str
    company_notes: str | None = None


class SettingsSchema(CamelModel):
    model: str | None = None
    reasoning_effort: str | None = None
    task_mode: str | None = None
    question_sources: dict[str, object] | None = None
    voice: dict[str, object] | None = None
