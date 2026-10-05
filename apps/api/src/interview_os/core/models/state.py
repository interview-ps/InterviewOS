"""Whole-workspace state — port of `state.ts`.

`InterviewOSState` references the ported models; it never redefines a shape.
"""

from __future__ import annotations

from .assessment import AssessmentState
from .candidate import CandidateProfile
from .interview import InterviewStateSlice
from .preparation import PreparationState
from .readiness import ReadinessGraph
from .shared import CamelModel
from .target import TargetRole

__all__ = ["InterviewOSState"]


class InterviewOSState(CamelModel):
    candidate: CandidateProfile
    target: TargetRole
    assessment: AssessmentState
    preparation: PreparationState
    interview: InterviewStateSlice
    readiness: ReadinessGraph
