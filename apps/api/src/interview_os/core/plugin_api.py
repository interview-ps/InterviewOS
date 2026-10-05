"""Plugin API — the typed, versioned host↔plugin contract.

Port of `packages/core/src/platform/plugin-api.ts`. Every platform extension
point is a named hook with a request/response schema; the host validates the
request before sending and the response after receiving. Additive changes bump
the minor version, breaking changes the major; the host supports the current
major.

1.1.0 adds: plugin interview `modes`, `mode.*` hooks, the
`interview.question` UI slot, `answerFields`/`modeSignals`, and the
answerEvaluated/loopCompleted/targetChanged events.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, StringConstraints, model_validator

from .models.assessment import AnswerEvaluation
from .models.interview import ModeId, QuestionDifficulty, RoundType
from .models.platform import (
    PLUGIN_EVENT_NAMES,
    PluginAppliesTo,
    PluginEventName,
    PluginSettingField,
    PluginSettingFieldType,
    PluginSettingValue,
    UINode,
    UITone,
)
from .models.shared import CamelModel, JsonScalar, LooseCamelModel
from .models.skills import EvidenceProposal, PluginCapability
from .skill_id import SkillId

__all__ = [
    "CAPABILITY_HOOKS",
    "LEGACY_HOOK_KIND",
    "MANIFEST_FEATURE_SINCE",
    "PLUGIN_API_VERSION",
    "PLUGIN_EVENT_HOOKS",
    "PLUGIN_EVENT_NAMES",
    "PLUGIN_HOOK_NAMES",
    "PLUGIN_HOOKS",
    "AnswerEvaluatedEventRequest",
    "CandidateLite",
    "EvaluationReviewAnswer",
    "EvaluationReviewQuestion",
    "EvaluationReviewRequest",
    "EvaluationReviewResponse",
    "EventHookResponse",
    "HookSpec",
    "LoopCompletedEventRequest",
    "ModeFollowUpRequest",
    "ModeFollowUpResponse",
    "ModeMockRequest",
    "ModeMockResponse",
    "ModePrepareTurnRequest",
    "ModePrepareTurnResponse",
    "ModeReduceRequest",
    "ModeReduceResponse",
    "PluginApiSince",
    "PluginAppliesTo",
    "PluginEventName",
    "PluginPrepActivity",
    "PluginReviewObservation",
    "PluginSettingField",
    "PluginSettingFieldType",
    "PluginSettingValue",
    "PreparationSuggestRequest",
    "PreparationSuggestResponse",
    "QuestionsSuggestRequest",
    "QuestionsSuggestResponse",
    "ReadinessUpdatedEventRequest",
    "ResourceLite",
    "ResourcesSuggestRequest",
    "ResourcesSuggestResponse",
    "SessionCompletedEventRequest",
    "TargetChangedEventRequest",
    "UiFrameRunRequest",
    "UiFrameRunResponse",
    "UiRenderRequest",
    "UiRenderResponse",
    "capability_hooks",
    "hook_capability",
    "is_plugin_hook_name",
]

PLUGIN_API_VERSION = "1.1.0"

PluginApiSince = Literal["1.0.0", "1.1.0"]


@dataclass(frozen=True)
class HookSpec:
    """One named extension point: who owns it, since when, and its schemas."""

    capability: PluginCapability | None
    since: PluginApiSince
    description: str
    request: type[BaseModel]
    response: type[BaseModel]


# ------------------------------------------------------------- shared payloads


class CandidateLite(CamelModel):
    """A question candidate without its source attribution."""

    skill_id: SkillId
    text: str = Field(min_length=10, max_length=1200)
    difficulty: QuestionDifficulty | None = None
    expected_concepts: (
        list[Annotated[str, StringConstraints(min_length=1, max_length=200)]] | None
    ) = Field(default=None, max_length=8)
    mode: ModeId | None = None


class ResourceLite(CamelModel):
    """A prep resource without its host-stamped skill id and source."""

    title: str = Field(min_length=1, max_length=200)
    url: str | None = Field(default=None, max_length=2000)
    summary: str | None = Field(default=None, max_length=600)
    kind: str
    # Host fills from the request context when the plugin omits it.
    skill_id: SkillId | None = None
    # Host stamps "plugin:<id>"; plugin-provided values are advisory.
    source: str | None = Field(default=None, min_length=1, max_length=120)

    @model_validator(mode="after")
    def _https_url(self) -> ResourceLite:
        if self.url is not None and not self.url.startswith("https://"):
            raise ValueError("resource URLs must be https")
        return self

    @model_validator(mode="after")
    def _known_kind(self) -> ResourceLite:
        allowed = ("docs", "explanation", "practice", "article", "video")
        if self.kind not in allowed:
            raise ValueError(f"resource kind must be one of {allowed}")
        return self


class PluginReviewObservation(CamelModel):
    text: str = Field(min_length=1, max_length=400)
    tone: UITone = UITone.MUTED


class PluginPrepActivity(CamelModel):
    skill_id: SkillId
    title: str = Field(min_length=1, max_length=120)
    action: str = Field(min_length=1, max_length=500)
    success_criteria: (
        list[Annotated[str, StringConstraints(min_length=1, max_length=200)]] | None
    ) = Field(default=None, max_length=5)


class EventHookResponse(LooseCamelModel):
    """Every `events.*` hook answers with (optional) evidence proposals."""

    evidence_proposals: list[EvidenceProposal] | None = Field(default=None, max_length=20)


# ------------------------------------------------------------------- questions


class QuestionsSuggestRequest(CamelModel):
    skill_id: SkillId
    round_type: RoundType
    level: str | None = Field(default=None, max_length=40)
    count: int = Field(default=5, ge=1, le=20)


class QuestionsSuggestResponse(LooseCamelModel):
    questions: list[CandidateLite] = Field(max_length=50)


# ------------------------------------------------------------------- resources


class ResourcesSuggestRequest(CamelModel):
    skill_ids: list[SkillId] = Field(min_length=1, max_length=20)


class ResourcesSuggestResponse(LooseCamelModel):
    resources: list[ResourceLite] = Field(max_length=50)


# -------------------------------------------------------------------------- ui


class UiRenderRequest(CamelModel):
    slot: str | None = Field(default=None, min_length=1, max_length=60)
    component: str = Field(min_length=1, max_length=80)
    page: str | None = Field(default=None, min_length=1, max_length=120)
    params: Any = None


class UiRenderResponse(LooseCamelModel):
    ui: UINode


class UiFrameRunRequest(CamelModel):
    component: str | None = Field(default=None, min_length=1, max_length=80)
    page: str | None = Field(default=None, min_length=1, max_length=120)
    request: dict[str, Any] | None = None


class UiFrameRunResponse(LooseCamelModel):
    output: Any
    ui: UINode | None = None


# ------------------------------------------------------------------ evaluation


class EvaluationReviewQuestion(CamelModel):
    skill_id: SkillId
    text: str = Field(max_length=2000)
    round_type: RoundType
    expected_concepts: list[Annotated[str, StringConstraints(max_length=200)]] = Field(
        default_factory=list, max_length=16
    )


class EvaluationReviewAnswer(CamelModel):
    text: str = Field(max_length=50_000)
    code: str | None = Field(default=None, max_length=100_000)
    language: str | None = Field(default=None, max_length=40)
    # v1.1: structured answerFields values for "fields" modes.
    fields: dict[str, JsonScalar] | None = None


class EvaluationReviewRequest(CamelModel):
    question: EvaluationReviewQuestion
    # null unless the plugin was granted answers.read
    answer: EvaluationReviewAnswer | None
    evaluation: AnswerEvaluation


class EvaluationReviewResponse(LooseCamelModel):
    observations: list[PluginReviewObservation] = Field(max_length=5)
    evidence_proposals: list[EvidenceProposal] | None = Field(default=None, max_length=20)


# ---------------------------------------------------------------- preparation


class PreparationSuggestRequest(CamelModel):
    gaps: list[dict[str, Any]] = Field(max_length=10)
    skill_ids: list[SkillId] = Field(max_length=20)


class PreparationSuggestResponse(LooseCamelModel):
    activities: list[PluginPrepActivity] = Field(max_length=10)


# ------------------------------------------------------------------ mode hooks


class ModeReduceQuestion(CamelModel):
    skill_id: SkillId
    topic: str = Field(max_length=200)
    extra: dict[str, Any] = Field(default_factory=dict)


class ModeReduceRequest(CamelModel):
    mode_id: ModeId
    state: dict[str, Any]
    evaluation: AnswerEvaluation
    question: ModeReduceQuestion


class ModeReduceResponse(LooseCamelModel):
    state: dict[str, Any]


class ModeFollowUpRequest(CamelModel):
    mode_id: ModeId
    evaluation: AnswerEvaluation
    state: dict[str, Any]
    depth: int = Field(ge=0)
    max_depth: int = Field(ge=0)


class ModeFollowUpResponse(LooseCamelModel):
    ask: bool
    focus: str | None = Field(default=None, max_length=200)
    reason: str = Field(default="", max_length=400)


class ModeMockRequest(CamelModel):
    mode_id: ModeId
    task: Literal["interviewer", "evaluator"]
    # Task input; answer text/code included only with answers.read.
    input: dict[str, Any]


class ModeMockResponse(LooseCamelModel):
    output: Any


class ModePrepareTurnRequest(CamelModel):
    mode_id: ModeId
    state: dict[str, Any]
    # True when the pending question is a follow-up, not a new main one.
    follow_up: bool


class ModePrepareTurnResponse(LooseCamelModel):
    turn: dict[str, Any]

    @model_validator(mode="after")
    def _turn_is_bounded(self) -> ModePrepareTurnResponse:
        if len(json.dumps(self.turn)) > 4096:
            raise ValueError("turn must serialize to ≤ 4KB JSON")
        return self


# ---------------------------------------------------------------- event hooks


class SessionCompletedEventRequest(CamelModel):
    session_id: str = Field(min_length=1, max_length=80)
    round_type: str = Field(max_length=40)
    # Per-skill summary of the session's evaluations (no answer text).
    scores: dict[str, SessionCompletedScore] = Field(default_factory=dict)


class SessionCompletedScore(CamelModel):
    mean_score: float = Field(ge=0, le=1)
    answers: int = Field(ge=0)


class ReadinessUpdatedEventRequest(CamelModel):
    changed_skill_ids: list[SkillId] = Field(max_length=100)


class AnswerEvaluatedEventRequest(CamelModel):
    session_id: str = Field(min_length=1, max_length=80)
    question_id: str = Field(min_length=1, max_length=80)
    skill_id: SkillId
    round_type: str = Field(min_length=1, max_length=64)
    rubric: list[AnswerEvaluatedRubricScore] = Field(default_factory=list, max_length=12)
    scores: list[AnswerEvaluatedSkillScore] = Field(default_factory=list, max_length=50)


class AnswerEvaluatedRubricScore(CamelModel):
    id: str = Field(min_length=1, max_length=60)
    score: float = Field(ge=0, le=1)


class AnswerEvaluatedSkillScore(CamelModel):
    skill: SkillId
    score: float = Field(ge=0, le=1)


class LoopCompletedEventRequest(CamelModel):
    loop_id: str = Field(min_length=1, max_length=80)
    rounds: list[LoopCompletedRound] = Field(default_factory=list, max_length=10)


class LoopCompletedRound(CamelModel):
    mode: str = Field(min_length=1, max_length=64)
    session_id: str | None = Field(default=None, min_length=1, max_length=80)


class TargetChangedEventRequest(CamelModel):
    target_id: str = Field(min_length=1, max_length=80)
    role: str = Field(max_length=120)
    company: str | None = Field(default=None, max_length=160)


for _model in (
    SessionCompletedEventRequest,
    AnswerEvaluatedEventRequest,
    LoopCompletedEventRequest,
):
    _model.model_rebuild()


# ------------------------------------------------------------------ registry

PLUGIN_HOOKS: dict[str, HookSpec] = {
    "questions.suggest": HookSpec(
        capability=PluginCapability.QUESTION_SOURCE,
        since="1.0.0",
        description="Suggest interview questions for a skill/round.",
        request=QuestionsSuggestRequest,
        response=QuestionsSuggestResponse,
    ),
    "resources.suggest": HookSpec(
        capability=PluginCapability.RESOURCES,
        since="1.0.0",
        description="Suggest prep resources for skills.",
        request=ResourcesSuggestRequest,
        response=ResourcesSuggestResponse,
    ),
    "ui.render": HookSpec(
        capability=PluginCapability.UI,
        since="1.0.0",
        description="Render a declared declarative contribution.",
        request=UiRenderRequest,
        response=UiRenderResponse,
    ),
    "ui.frameRun": HookSpec(
        capability=PluginCapability.UI,
        since="1.0.0",
        description="Stateless invocation from a sandboxed frame.",
        request=UiFrameRunRequest,
        response=UiFrameRunResponse,
    ),
    "evaluation.review": HookSpec(
        capability=PluginCapability.EVALUATION,
        since="1.0.0",
        description="Review a persisted answer evaluation; observations shown to the user.",
        request=EvaluationReviewRequest,
        response=EvaluationReviewResponse,
    ),
    "preparation.suggest": HookSpec(
        capability=PluginCapability.PREPARATION,
        since="1.0.0",
        description="Suggest preparation activities for current gaps.",
        request=PreparationSuggestRequest,
        response=PreparationSuggestResponse,
    ),
    "mode.reduce": HookSpec(
        capability=PluginCapability.INTERVIEW_MODE,
        since="1.1.0",
        description="Reduce a plugin interview mode's session state after an evaluation.",
        request=ModeReduceRequest,
        response=ModeReduceResponse,
    ),
    "mode.followUp": HookSpec(
        capability=PluginCapability.INTERVIEW_MODE,
        since="1.1.0",
        description=(
            "Decide whether to dig deeper after an evaluation (declarative rules are the fallback)."
        ),
        request=ModeFollowUpRequest,
        response=ModeFollowUpResponse,
    ),
    "mode.mock": HookSpec(
        capability=PluginCapability.INTERVIEW_MODE,
        since="1.1.0",
        description="Deterministic mock-runtime output for a plugin interview mode (test/dev).",
        request=ModeMockRequest,
        response=ModeMockResponse,
    ),
    "mode.prepareTurn": HookSpec(
        capability=PluginCapability.INTERVIEW_MODE,
        since="1.1.0",
        description=(
            "Prepare per-turn input for the interviewer skill (e.g. a focus dimension). "
            "Failure falls back to an empty turn."
        ),
        request=ModePrepareTurnRequest,
        response=ModePrepareTurnResponse,
    ),
    "events.sessionCompleted": HookSpec(
        capability=None,
        since="1.0.0",
        description="Fired (outside the lock) when an interview session completes.",
        request=SessionCompletedEventRequest,
        response=EventHookResponse,
    ),
    "events.readinessUpdated": HookSpec(
        capability=None,
        since="1.0.0",
        description="Fired (outside the lock) after a readiness recompute that changed scores.",
        request=ReadinessUpdatedEventRequest,
        response=EventHookResponse,
    ),
    "events.answerEvaluated": HookSpec(
        capability=None,
        since="1.1.0",
        description=(
            "Fired (outside the lock) after an answer evaluation is persisted — rubric/skill "
            "scores only, never answer text."
        ),
        request=AnswerEvaluatedEventRequest,
        response=EventHookResponse,
    ),
    "events.loopCompleted": HookSpec(
        capability=None,
        since="1.1.0",
        description="Fired (outside the lock) when an interview loop finishes its rounds.",
        request=LoopCompletedEventRequest,
        response=EventHookResponse,
    ),
    "events.targetChanged": HookSpec(
        capability=None,
        since="1.1.0",
        description=(
            "Fired (outside the lock) when the active target is created, added, or switched."
        ),
        request=TargetChangedEventRequest,
        response=EventHookResponse,
    ),
}

PLUGIN_HOOK_NAMES: tuple[str, ...] = tuple(PLUGIN_HOOKS)


def is_plugin_hook_name(name: str) -> bool:
    return name in PLUGIN_HOOKS


# Event hook names a manifest may subscribe to via `events: [...]`.
PLUGIN_EVENT_HOOKS: tuple[str, ...] = (
    "events.sessionCompleted",
    "events.readinessUpdated",
    "events.answerEvaluated",
    "events.loopCompleted",
    "events.targetChanged",
)

# The `request.kind` value legacy plugins see for each hook. Hooks whose names
# predate v1 keep their old kind strings so `request.kind` checks keep working.
LEGACY_HOOK_KIND: dict[str, str] = {
    "questions.suggest": "questions",
    "resources.suggest": "resources",
    "ui.render": "ui",
    "ui.frameRun": "ui-frame",
    "evaluation.review": "evaluation.review",
    "preparation.suggest": "preparation.suggest",
    "mode.reduce": "mode.reduce",
    "mode.followUp": "mode.followUp",
    "mode.mock": "mode.mock",
    "mode.prepareTurn": "mode.prepareTurn",
    "events.sessionCompleted": "events.sessionCompleted",
    "events.readinessUpdated": "events.readinessUpdated",
    "events.answerEvaluated": "events.answerEvaluated",
    "events.loopCompleted": "events.loopCompleted",
    "events.targetChanged": "events.targetChanged",
}

# Capabilities (beyond `ui`, which needs a ui section) and the hooks that back them.
CAPABILITY_HOOKS: dict[PluginCapability, list[str]] = {
    PluginCapability.QUESTION_SOURCE: ["questions.suggest"],
    PluginCapability.RESOURCES: ["resources.suggest"],
    PluginCapability.UI: ["ui.render", "ui.frameRun"],
    PluginCapability.EVALUATION: ["evaluation.review"],
    PluginCapability.PREPARATION: ["preparation.suggest"],
    PluginCapability.INTERVIEW_MODE: [
        "mode.reduce",
        "mode.followUp",
        "mode.mock",
        "mode.prepareTurn",
    ],
}

# Manifest-level features and the plugin-api minor that introduced them.
# `events.<name>` entries cover manifest `events` subscriptions; hooks are
# versioned individually on PLUGIN_HOOKS — this map is for manifest syntax.
MANIFEST_FEATURE_SINCE: dict[str, PluginApiSince] = {
    "inputs": "1.0.0",
    "outputs": "1.0.0",
    "permissions": "1.0.0",
    "capabilities": "1.0.0",
    "hooks": "1.0.0",
    "events": "1.0.0",
    "appliesTo": "1.0.0",
    "settings": "1.0.0",
    "ui": "1.0.0",
    "interviewModes": "1.0.0",
    "taxonomy": "1.0.0",
    "modes": "1.1.0",
    "modes.answerFields": "1.1.0",
    "ui.slots.interview.question": "1.1.0",
    "events.answerEvaluated": "1.1.0",
    "events.loopCompleted": "1.1.0",
    "events.targetChanged": "1.1.0",
}


def hook_capability(hook: str) -> PluginCapability | None:
    """The declared capability a hook backs (None = events)."""

    spec = PLUGIN_HOOKS.get(hook)
    return spec.capability if spec else None


def capability_hooks(capability: PluginCapability) -> list[str]:
    """Hooks that can back a capability (empty for pack/event-driven caps)."""

    return CAPABILITY_HOOKS.get(capability, [])
