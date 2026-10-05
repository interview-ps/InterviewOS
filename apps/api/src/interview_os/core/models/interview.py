"""Interview models — port of `interview/{index,loop,rounds,voice,modes/types}.ts`."""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, Field, StringConstraints

from ..skill_id import SkillId
from .shared import CamelModel

__all__ = [
    "INTERVIEW_STATES",
    "MODE_ID_REGEX",
    "VOICE_DISCLAIMER",
    "Answer",
    "AnswerFormat",
    "ExpectedConcept",
    "InterviewEvent",
    "InterviewSession",
    "InterviewStateSlice",
    "InterviewStatus",
    "LoopDebrief",
    "LoopMode",
    "LoopRound",
    "LoopRoundSignal",
    "LoopRoundStatus",
    "LoopSignal",
    "ModeId",
    "ModeState",
    "Question",
    "QuestionDifficulty",
    "ReadinessChange",
    "ReadinessSnapshot",
    "RoundHandoff",
    "RoundHandoffStrongSkill",
    "RoundHandoffWeakSkill",
    "RoundType",
    "RubricDimension",
    "SkillDelta",
    "VoiceFeedback",
    "VoiceMetrics",
    "VoiceSignal",
    "VoiceSignalId",
    "VoiceSignalStatus",
]

# ------------------------------------------------------------------ questions


class QuestionDifficulty(StrEnum):
    EASY = "easy"
    MEDIUM = "medium"
    HARD = "hard"


class ExpectedConcept(CamelModel):
    concept: str
    skill_id: SkillId
    keywords: list[str] = Field(default_factory=list)


class Question(CamelModel):
    id: str
    session_id: str | None = None
    skill_id: SkillId
    topic: str
    text: str
    sub_skills: list[SkillId] = Field(default_factory=list)
    expected_concepts: list[ExpectedConcept] = Field(default_factory=list)
    difficulty: QuestionDifficulty
    follow_up_of: str | None = None
    created_at: str | None = None


class Answer(CamelModel):
    id: str
    question_id: str
    session_id: str | None = None
    text: str
    created_at: str | None = None


# ------------------------------------------------------------------- sessions


class InterviewStatus(StrEnum):
    CREATED = "created"
    ANALYZING = "analyzing"
    READY = "ready"
    QUESTION = "question"
    ANSWER = "answer"
    EVALUATING = "evaluating"
    FOLLOW_UP = "follow_up"
    COMPLETE = "complete"
    DEBRIEF = "debrief"


INTERVIEW_STATES: tuple[InterviewStatus, ...] = tuple(InterviewStatus)


class InterviewSession(CamelModel):
    id: str
    status: InterviewStatus = InterviewStatus.CREATED
    current_round: int = Field(default=0, ge=0)
    planned_questions: int = Field(default=4, gt=0)
    question_ids: list[str] = Field(default_factory=list)
    answer_ids: list[str] = Field(default_factory=list)
    runtime_thread_id: str | None = None
    started_at: str | None = None
    completed_at: str | None = None


class InterviewStateSlice(CamelModel):
    session_id: str | None = None
    current_round: int = Field(default=0, ge=0)
    previous_questions: list[Question] = Field(default_factory=list)
    previous_answers: list[Answer] = Field(default_factory=list)
    interviewer_observations: list[str] = Field(default_factory=list)
    active_question: Question | None = None


# --------------------------------------------------------------- state machine


class InterviewEvent(StrEnum):
    ANALYZE = "analyze"
    ANALYSIS_COMPLETE = "analysis_complete"
    ASK = "ask"
    ANSWER = "answer"
    EVALUATE = "evaluate"
    EVALUATION_FAILED = "evaluation_failed"
    FOLLOW_UP = "follow_up"
    NEXT = "next"
    COMPLETE = "complete"
    DEBRIEF = "debrief"


# --------------------------------------------------------------- modes / rounds

MODE_ID_REGEX = r"^[a-z0-9][a-z0-9_-]{0,63}$"

# Underscores are allowed so stored ids like "system_design" keep parsing.
ModeId = Annotated[str, StringConstraints(pattern=MODE_ID_REGEX)]

AnswerFormat = Literal["text", "text+code", "fields"]


class RubricDimension(CamelModel):
    """§9.1: one independent rubric dimension the evaluator must score."""

    id: str = Field(min_length=1, max_length=60)
    label: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=300)


def _reject_mixed(value: str) -> str:
    if value == "mixed":
        raise ValueError("mixed is not a loop round mode")
    return value


LoopMode = Annotated[ModeId, AfterValidator(_reject_mixed)]

# "mixed" + any well-formed mode id, so stored plugin-mode ids still parse.
RoundType = Literal["mixed"] | ModeId

# Opaque per-mode session state, persisted as JSON on interview_sessions.
ModeState = dict[str, Any]


# ----------------------------------------------------------------- loop (§9.4)


class ReadinessSnapshot(CamelModel):
    """Snapshot of readiness at a loop round boundary: overall + per-requirement."""

    overall: float | None
    requirements: dict[str, float | None]


class RoundHandoffWeakSkill(CamelModel):
    skill_id: SkillId
    label: str = ""
    score: float
    observation: str


class RoundHandoffStrongSkill(CamelModel):
    skill_id: SkillId
    label: str = ""
    score: float


class RoundHandoff(CamelModel):
    """§9.4: deterministic cross-round handoff computed from a round's evaluations."""

    weak_skills: list[RoundHandoffWeakSkill]
    strong_skills: list[RoundHandoffStrongSkill]
    observations: list[str]


class SkillDelta(CamelModel):
    """§9.4: per-skill readiness movement evidenced by a round's evaluations."""

    skill_id: SkillId
    label: str = ""
    before: float | None
    after: float | None


class LoopRoundStatus(StrEnum):
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETE = "complete"


class LoopRound(CamelModel):
    mode: LoopMode
    label: str = ""
    planned_questions: int = Field(ge=1, le=6)
    session_id: str | None = Field(default=None, json_schema_extra={"emit_null": True})
    status: LoopRoundStatus = LoopRoundStatus.PENDING
    readiness_before: ReadinessSnapshot | None = Field(
        default=None, json_schema_extra={"emit_null": True}
    )
    readiness_after: ReadinessSnapshot | None = Field(
        default=None, json_schema_extra={"emit_null": True}
    )
    handoff: RoundHandoff | None = Field(default=None, json_schema_extra={"emit_null": True})
    skill_deltas: list[SkillDelta] = Field(default_factory=list)


class LoopSignal(StrEnum):
    STRONG = "strong"
    MIXED = "mixed"
    WEAK = "weak"


class LoopRoundSignal(CamelModel):
    """Per-round signal in the loop debrief — evidence-backed, never hire/no-hire."""

    mode: str
    label: str = ""
    signal: LoopSignal
    evidence: list[str] = Field(default_factory=list)


class ReadinessChange(CamelModel):
    before: float | None
    after: float | None


class LoopDebrief(CamelModel):
    summary: str
    rounds: list[LoopRoundSignal]
    readiness_change: ReadinessChange
    top_actions: list[str] = Field(default_factory=list)


# ------------------------------------------------------------------ voice mode

VOICE_DISCLAIMER = (
    "Delivery hints only. Interview OS does not assess accent, pronunciation or "
    "voice characteristics, and these signals do not predict job performance."
)


class VoiceMetrics(CamelModel):
    duration_sec: float = Field(ge=0, le=3600)
    long_pause_count: int = Field(ge=0)
    longest_pause_sec: float = Field(ge=0, le=3600)


class VoiceSignalId(StrEnum):
    STRUCTURE = "structure"
    FILLER = "filler"
    PAUSES = "pauses"
    LENGTH = "length"
    CONCLUSION = "conclusion"
    CLARITY = "clarity"


class VoiceSignalStatus(StrEnum):
    OK = "ok"
    WATCH = "watch"


class VoiceSignal(CamelModel):
    id: VoiceSignalId
    status: VoiceSignalStatus
    message: str = Field(min_length=1, max_length=300)


class VoiceFeedback(CamelModel):
    signals: list[VoiceSignal] = Field(min_length=6, max_length=6)
    word_count: int = Field(ge=0)
    filler_count: int = Field(ge=0)
    # null when duration is too short to be meaningful (< 10 s).
    words_per_minute: float | None
    disclaimer: str
