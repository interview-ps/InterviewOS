"""Interview state machine — port of `interview/state-machine.ts`."""

from __future__ import annotations

from .models.interview import INTERVIEW_STATES, InterviewEvent, InterviewStatus
from .models.shared import AppError

__all__ = [
    "INTERVIEW_STATES",
    "InvalidTransitionError",
    "TRANSITIONS",
    "can_transition",
    "next_events",
    "transition",
]

TRANSITIONS: dict[InterviewStatus, dict[InterviewEvent, InterviewStatus]] = {
    InterviewStatus.CREATED: {InterviewEvent.ANALYZE: InterviewStatus.ANALYZING},
    InterviewStatus.ANALYZING: {InterviewEvent.ANALYSIS_COMPLETE: InterviewStatus.READY},
    InterviewStatus.READY: {InterviewEvent.ASK: InterviewStatus.QUESTION},
    InterviewStatus.QUESTION: {
        InterviewEvent.ANSWER: InterviewStatus.ANSWER,
        InterviewEvent.COMPLETE: InterviewStatus.COMPLETE,
    },
    InterviewStatus.ANSWER: {InterviewEvent.EVALUATE: InterviewStatus.EVALUATING},
    InterviewStatus.EVALUATING: {
        InterviewEvent.FOLLOW_UP: InterviewStatus.FOLLOW_UP,
        InterviewEvent.EVALUATION_FAILED: InterviewStatus.QUESTION,
    },
    InterviewStatus.FOLLOW_UP: {
        InterviewEvent.NEXT: InterviewStatus.QUESTION,
        InterviewEvent.COMPLETE: InterviewStatus.COMPLETE,
    },
    InterviewStatus.COMPLETE: {InterviewEvent.DEBRIEF: InterviewStatus.DEBRIEF},
    InterviewStatus.DEBRIEF: {},
}


class InvalidTransitionError(AppError):
    def __init__(self, from_status: InterviewStatus, event: str) -> None:
        super().__init__(
            "INVALID_TRANSITION",
            f'invalid interview transition: state "{from_status}" has no event "{event}"',
        )
        self.name = "InvalidTransitionError"


def transition(status: InterviewStatus, event: InterviewEvent) -> InterviewStatus:
    next_status = TRANSITIONS[status].get(event)
    if next_status is None:
        raise InvalidTransitionError(status, event)
    return next_status


def can_transition(status: InterviewStatus, event: InterviewEvent) -> bool:
    return TRANSITIONS[status].get(event) is not None


def next_events(status: InterviewStatus) -> list[InterviewEvent]:
    return list(TRANSITIONS[status])
