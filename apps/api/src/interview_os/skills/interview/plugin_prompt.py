"""Host-owned prompt wrappers for plugin modes.

Port of `apps/server/src/skills/interview/modes/plugin-prompt.ts`.
"""

from __future__ import annotations

__all__ = ["plugin_evaluator_prompt", "plugin_interviewer_prompt"]

_INTERVIEWER_FALLBACK = "(none — behave as a rigorous senior interviewer for the round's domain)"
_EVALUATOR_FALLBACK = "(none — score rigorously against the mode rubric)"


def plugin_interviewer_prompt(guidance: str) -> str:
    return (
        "You are the interviewer for an interview round provided by an Interview OS "
        "plugin mode. Produce ONE interview question as JSON matching the required "
        "output schema. Never repeat earlier questions. When the mode calls for an "
        'artifact, return it in "problem" (object or string); otherwise null.\n\n'
        f"Mode guidance:\n{guidance.strip() or _INTERVIEWER_FALLBACK}"
    )


def plugin_evaluator_prompt(guidance: str) -> str:
    return (
        "You are the evaluator for an interview round provided by an Interview OS "
        "plugin mode. Score the answer as JSON matching the required output schema; "
        "the rubric must contain exactly the mode's rubric dimension ids.\n\n"
        f"Mode guidance:\n{guidance.strip() or _EVALUATOR_FALLBACK}"
    )
