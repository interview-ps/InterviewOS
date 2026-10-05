"""Bundled example loader — port of `apps/server/src/adapters/examples.ts`."""

from __future__ import annotations

import json
import re
from pathlib import Path

from ..core.models import CamelModel

__all__ = ["ExampleEntry", "list_examples", "read_example"]

_NAME_PATTERN = re.compile(r"^[a-z0-9-]+$")


class ExampleEntry(CamelModel):
    name: str
    resume_text: str
    job_description: str
    company: str
    role: str
    level: str
    company_notes: str | None = None


def _read_text(path: Path) -> str:
    """Read verbatim: never translate CRLF (the contract snapshots preserve it)."""
    return path.read_bytes().decode("utf-8")


def list_examples(examples_dir: Path) -> list[str]:
    if not examples_dir.is_dir():
        return []
    return sorted(entry.name for entry in examples_dir.iterdir() if entry.is_dir())


def read_example(examples_dir: Path, name: str) -> ExampleEntry | None:
    if not _NAME_PATTERN.match(name):
        return None
    directory = examples_dir / name
    try:
        resume_text = _read_text(directory / "resume.md")
        job_description = _read_text(directory / "job.md")
        meta = json.loads(_read_text(directory / "meta.json"))
        company_file = directory / "company.md"
        company_notes = _read_text(company_file) if company_file.is_file() else ""
    except (OSError, json.JSONDecodeError):
        return None
    return ExampleEntry(
        name=name,
        resume_text=resume_text,
        job_description=job_description,
        company=meta["company"],
        role=meta["role"],
        level=meta["level"],
        company_notes=company_notes or None,
    )
