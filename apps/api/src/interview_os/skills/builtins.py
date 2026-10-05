"""Built-in skill registration — port of `apps/server/src/skills/host/builtins.ts`."""

from __future__ import annotations

from typing import Any

from .analyze import company_profiler, gap_analyzer, jd_analyzer, resume_analyzer
from .host import SkillHost

__all__ = ["BUILTIN_SKILLS", "register_builtin_skills"]

#: Every built-in skill, in pipeline order.
BUILTIN_SKILLS: list[Any] = [
    resume_analyzer,
    jd_analyzer,
    gap_analyzer,
    company_profiler,
]


def register_builtin_skills(host: SkillHost) -> None:
    """§9.6: register all built-ins on a host."""
    for skill in BUILTIN_SKILLS:
        host.register(skill)
