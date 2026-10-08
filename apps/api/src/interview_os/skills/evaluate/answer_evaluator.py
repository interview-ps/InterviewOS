"""answer-evaluator — port of `apps/server/src/skills/evaluate/answer-evaluator/`."""

from __future__ import annotations

from typing import Any

from pydantic import Field, model_validator

from ...core.assessment import normalize_evaluation
from ...core.models import (
    AnswerEvaluation,
    CamelModel,
    DesignUpdate,
    EvaluationDimensions,
    EvaluationStrength,
    EvaluationWeakness,
    Level,
    Permission,
    QuestionDifficulty,
    RoundType,
    RubricScore,
    SkillKind,
    SkillManifest,
    SkillManifestInput,
    SkillScore,
    StarAssessment,
    WeaknessSeverity,
)
from ...core.modes import get_mode, is_mode_id
from ...core.skill_id import SkillId
from ..common import normalize_skill_id_value
from ..framework import InterviewSkill, SkillContext, SkillInput, SkillTask, run_structured
from ..interview.plugin_prompt import plugin_evaluator_prompt
from .prompts import ANSWER_EVALUATOR_PROMPT

__all__ = [
    "AnswerEvaluationAi",
    "AnswerEvaluator",
    "AnswerEvaluatorInput",
    "ModeSignalsAi",
    "answer_evaluator",
    "rubric_schema_for",
]


class EvaluatorQuestion(CamelModel):
    text: str
    topic: str
    skill_id: str
    expected_concepts: list[Any] = Field(default_factory=list)
    difficulty: QuestionDifficulty


class AnswerEvaluatorInput(SkillInput):
    question: EvaluatorQuestion
    answer: str
    role: str
    level: Level
    #: §8.4: behavioral/hr rounds require a STAR assessment.
    round_type: RoundType = "mixed"
    #: §9.1 interview mode (defaults to roundType).
    mode: RoundType | None = None
    #: §9.1: optional submitted code + language (coding rounds).
    code: str | None = None
    language: str | None = None
    #: v1.1: structured values for modes declaring answerFields.
    fields: dict[str, str | float] | None = None
    #: Per-mode state blob (system-design dimension status etc.).
    mode_state: dict[str, object] = Field(default_factory=dict)
    #: §9.3/v0.4: company profile guidance (sourced vs community marked).
    company_guidance: str = ""
    #: v0.4: role-pack rubric criteria for this skill/mode.
    role_rubric: list[str] = Field(default_factory=list)

    # `mode` is `.optional()`: absent from the JSON the model sees when unset.
    js_undefined = frozenset({"mode"})


class _AiStrength(CamelModel):
    skill: str
    evidence: str


class _AiWeakness(CamelModel):
    skill: str
    severity: WeaknessSeverity
    evidence: str


class _AiScore(CamelModel):
    skill: str
    score: float = Field(ge=0, le=1)
    confidence: float = Field(ge=0, le=1)


class ModeSignalsAi(CamelModel):
    """v1.1 mode signals as the model must emit them.

    `AnswerEvaluation.mode_signals` stays an open record on the wire, but a
    provider's strict structured-output schema cannot contain a free-form
    object (every object needs `properties`/`additionalProperties: false`), so
    the AI-facing shape is closed to the signal keys the built-in modes use.
    A new per-mode signal means adding it here.
    """

    design_updates: list[DesignUpdate] | None = None


class AnswerEvaluationAi(CamelModel):
    """AI output keeps skill ids loose; they are normalized post-hoc."""

    summary: str
    dimensions: EvaluationDimensions
    strengths: list[_AiStrength]
    weaknesses: list[_AiWeakness]
    scores: list[_AiScore]
    missing_concepts: list[str]
    better_approach: str
    follow_up_topics: list[str]
    star: StarAssessment | None = None
    rubric: list[RubricScore] = Field(default_factory=list)
    design_updates: list[DesignUpdate] | None = None
    mode_signals: ModeSignalsAi | None = None


def rubric_schema_for(mode: str) -> type[AnswerEvaluationAi]:
    """§9.2: a mode's evaluation must carry exactly its rubric ids."""

    if not is_mode_id(mode):
        return AnswerEvaluationAi
    expected = sorted(dimension.id for dimension in get_mode(mode).rubric)

    class _ModeRubric(AnswerEvaluationAi):
        @model_validator(mode="after")
        def _rubric_matches(self) -> _ModeRubric:
            actual = sorted(dimension.id for dimension in self.rubric)
            if actual != expected:
                raise ValueError(
                    f"rubric must contain exactly [{', '.join(expected)}], "
                    f"got [{', '.join(actual)}]"
                )
            return self

    return _ModeRubric


_MANIFEST = SkillManifest(
    id="answer-evaluator",
    version="1.0.0",
    kind=SkillKind.BUILTIN,
    description=(
        "Scores an interview answer against the mode rubric; produces evidence for "
        "the readiness graph."
    ),
    inputs=[
        SkillManifestInput(key="question", permission=Permission.INTERVIEW_READ),
        SkillManifestInput(key="answer", permission=Permission.INTERVIEW_READ),
        SkillManifestInput(key="role", permission=Permission.TARGET_READ),
        SkillManifestInput(key="level", permission=Permission.TARGET_READ),
        SkillManifestInput(key="roundType", permission=Permission.INTERVIEW_READ),
        SkillManifestInput(key="mode", permission=Permission.INTERVIEW_READ),
        SkillManifestInput(key="code", permission=Permission.INTERVIEW_READ),
        SkillManifestInput(key="language", permission=Permission.INTERVIEW_READ),
        SkillManifestInput(key="fields", permission=Permission.INTERVIEW_READ),
        SkillManifestInput(key="modeState", permission=Permission.INTERVIEW_READ),
        SkillManifestInput(key="companyGuidance", permission=Permission.TARGET_READ),
        SkillManifestInput(key="roleRubric", permission=Permission.TARGET_READ),
    ],
    outputs=["evaluation", "evidence"],
    permissions=[
        Permission.INTERVIEW_READ,
        Permission.TARGET_READ,
        Permission.RUNTIME_INVOKE,
        Permission.EVIDENCE_WRITE,
        Permission.INTERVIEW_WRITE,
    ],
)


class AnswerEvaluator(InterviewSkill[AnswerEvaluatorInput, AnswerEvaluation]):
    id = "answer-evaluator"
    manifest = _MANIFEST
    input_schema = AnswerEvaluatorInput
    output_schema = AnswerEvaluation

    async def execute(self, input: AnswerEvaluatorInput, ctx: SkillContext) -> AnswerEvaluation:
        mode = str(input.mode or input.round_type)
        plugin_mode = mode != "mixed" and is_mode_id(mode)
        if plugin_mode:
            definition = get_mode(mode)
            prompts = definition.prompts
            guidance = (prompts.evaluator if prompts is not None else None) or ""
            instructions = plugin_evaluator_prompt(guidance)
            task_id = f"answer-evaluator.{mode}"
        else:
            instructions = ANSWER_EVALUATOR_PROMPT
            task_id = "answer-evaluator"

        output = await run_structured(
            ctx,
            SkillTask(
                task_id=task_id,
                instructions=instructions,
                input=input,
                schema=rubric_schema_for(mode),
                stream_field="summary",
            ),
        )

        def fix(raw: str) -> SkillId | None:
            return normalize_skill_id_value(raw)

        strengths: list[EvaluationStrength] = []
        for strength in output.strengths:
            skill_id = fix(strength.skill)
            if skill_id is not None:
                strengths.append(EvaluationStrength(skill=skill_id, evidence=strength.evidence))
        weaknesses: list[EvaluationWeakness] = []
        for weakness in output.weaknesses:
            skill_id = fix(weakness.skill)
            if skill_id is not None:
                weaknesses.append(
                    EvaluationWeakness(
                        skill=skill_id,
                        severity=weakness.severity,
                        evidence=weakness.evidence,
                    )
                )
        scores: list[SkillScore] = []
        for score in output.scores:
            skill_id = fix(score.skill)
            if skill_id is not None:
                scores.append(
                    SkillScore(skill=skill_id, score=score.score, confidence=score.confidence)
                )

        # The model emits a closed `ModeSignalsAi`; the persisted evaluation keeps
        # an open record (see docs/plugins.md §modeSignals).
        mode_signals = (
            output.mode_signals.model_dump(mode="json", by_alias=True, exclude_none=True)
            or None
            if output.mode_signals is not None
            else None
        )

        # merge duplicate per-skill entries (mock can emit one per concept)
        return normalize_evaluation(
            AnswerEvaluation(
                summary=output.summary,
                dimensions=output.dimensions,
                strengths=strengths,
                weaknesses=weaknesses,
                scores=scores,
                missing_concepts=output.missing_concepts,
                better_approach=output.better_approach,
                follow_up_topics=output.follow_up_topics,
                star=output.star,
                rubric=output.rubric,
                design_updates=output.design_updates,
                mode_signals=mode_signals,
            )
        )


answer_evaluator = AnswerEvaluator()
