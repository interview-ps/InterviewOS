"""Interviewer prompt contract.

Regression: ``InterviewerOutput.difficulty`` is required, and ``run_structured``
turns every field into a required schema key — but no interviewer prompt ever
told the model to emit it, so live mode rounds failed validation after all
retries ("skill \"interviewer.coding\" produced invalid output: difficulty").
"""

from __future__ import annotations

from interview_os.skills.interview.interviewer import InterviewerOutput
from interview_os.skills.interview.plugin_prompt import plugin_interviewer_prompt
from interview_os.skills.interview.prompts import INTERVIEWER_PROMPT

DIFFICULTY_VALUES = ("easy", "medium", "hard")


def _interviewer_prompts() -> tuple[str, ...]:
    return (INTERVIEWER_PROMPT, plugin_interviewer_prompt("Ask a coding question."))


def test_difficulty_is_a_required_output_field() -> None:
    assert "difficulty" in InterviewerOutput.model_fields


def test_every_interviewer_prompt_asks_for_difficulty() -> None:
    for prompt in _interviewer_prompts():
        assert "difficulty" in prompt, "the model is never told to emit `difficulty`"
        missing = [value for value in DIFFICULTY_VALUES if value not in prompt]
        assert not missing, f"the difficulty instruction omits valid values: {missing}"
