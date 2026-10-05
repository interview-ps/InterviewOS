"""Built-in skill registration — port of `apps/server/src/skills/host/builtins.ts`."""

from __future__ import annotations

from typing import Any

from .analyze import company_profiler, gap_analyzer, jd_analyzer, resume_analyzer
from .evaluate import answer_evaluator, interview_debrief, loop_debrief
from .host import SkillHost
from .interview import interview_planner, interviewer

__all__ = ["BUILTIN_SKILLS", "register_builtin_skills"]

#: Every built-in skill, in pipeline order.
BUILTIN_SKILLS: list[Any] = [
    resume_analyzer,
    jd_analyzer,
    gap_analyzer,
    company_profiler,
    interview_planner,
    interviewer,
    answer_evaluator,
    interview_debrief,
    loop_debrief,
]


def register_builtin_skills(host: SkillHost) -> None:
    """§9.6: register all built-ins on a host."""
    for skill in BUILTIN_SKILLS:
        host.register(skill)
