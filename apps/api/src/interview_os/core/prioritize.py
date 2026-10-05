"""Next-skill selection — port of `interview/prioritize.ts`."""

from __future__ import annotations

from collections.abc import Mapping, Sequence

from pydantic import Field

from .js_compat import to_fixed
from .models.interview import QuestionDifficulty, RoundType
from .models.readiness import Evidence, EvidenceType, SkillReadiness
from .models.shared import CamelModel
from .models.target import Level, Requirement
from .modes import get_mode
from .rounds import in_round, round_fallback_requirements
from .skill_id import SkillId, parent_skill_id
from .taxonomy import label_for, related_to

__all__ = [
    "LoopWeakSkill",
    "SelectNextSkillInput",
    "SelectNextSkillResult",
    "SelectionFactors",
    "SkillCandidate",
    "difficulty_for",
    "select_next_skill",
]

_LOW_CONFIDENCE = 0.5
_CONFIRMATION_CONFIDENCE_CAP = 0.8
_WEAK_INTERVIEW_SCORE = 0.5
_FALLBACK_IMPORTANCE = 0.5
_NOVELTY_ASK_CAP = 3


class LoopWeakSkill(CamelModel):
    """A skill flagged weak in an earlier round of the current interview loop."""

    skill_id: SkillId
    # 1-based loop round the weakness came from.
    round: int
    # The mode of that round (for the human-readable reason).
    mode: RoundType


class SelectionFactors(CamelModel):
    role_importance: float
    readiness_gap: float
    uncertainty: float
    weakness_boost: float
    recency_factor: float
    novelty_factor: float
    # v0.4: +0.15 when the candidate skill equals/descends from a pack focus skill.
    pack_focus: float = 0


class SkillCandidate(CamelModel):
    skill_id: SkillId
    priority: float
    reason: str
    factors: SelectionFactors


class SelectNextSkillResult(CamelModel):
    skill_id: SkillId
    priority: float
    reason: str
    difficulty: QuestionDifficulty
    factors: SelectionFactors
    candidates: list[SkillCandidate]


class SelectNextSkillInput(CamelModel):
    requirements: list[Requirement] = Field(default_factory=list)
    readiness: dict[str, SkillReadiness] = Field(default_factory=dict)
    evidence: list[Evidence] = Field(default_factory=list)
    asked_this_session: list[SkillId] = Field(default_factory=list)
    asked_previous_session: list[SkillId] = Field(default_factory=list)
    # 0-based index of the question about to be asked in this session.
    question_index: int = 0
    # Interview round type/mode; "mixed" (default) keeps the whole pool.
    round_type: RoundType | None = None
    # §9.2: same as roundType — the interview mode selecting within its scope.
    mode: RoundType | None = None
    # Target level — drives question difficulty.
    level: Level = Level.MID
    # Times each skill has been asked across ALL sessions (novelty factor).
    ask_counts: dict[str, int] = Field(default_factory=dict)
    # Weak skills carried over from earlier rounds of a loop (§9.2, W2 feeds).
    loop_weak_skills: list[LoopWeakSkill] = Field(default_factory=list)
    # v0.4: interview-pack focus skills — boost candidates that descend from them.
    focus_skills: list[SkillId] = Field(default_factory=list)


def _nearest_requirement(
    skill_id: SkillId, requirements: Mapping[str, Requirement]
) -> Requirement | None:
    cur: SkillId | None = skill_id
    while cur is not None:
        hit = requirements.get(cur)
        if hit is not None:
            return hit
        cur = parent_skill_id(cur)
    return None


def difficulty_for(level: Level, score: float | None) -> QuestionDifficulty:
    """§9.2 difficulty: base by level, +1 step when strong (≥0.75), −1 when weak (<0.4)."""

    steps = (
        QuestionDifficulty.EASY,
        QuestionDifficulty.MEDIUM,
        QuestionDifficulty.HARD,
    )
    index = 0 if level == Level.JUNIOR else 2 if level == Level.STAFF else 1
    if score is not None and score >= 0.75:
        index += 1
    elif score is not None and score < 0.4:
        index -= 1
    return steps[max(0, min(len(steps) - 1, index))]


class _LoopTrigger(CamelModel):
    weak_skill_id: SkillId
    round: int
    mode: str
    direct: bool


class _FactorResult(CamelModel):
    factors: SelectionFactors
    weak: bool
    loop_trigger: _LoopTrigger | None
    reason_detail: str


def _has_pack_focus(skill_id: str, focus_skills: Sequence[SkillId]) -> bool:
    return bool(focus_skills) and any(
        skill_id == focus or skill_id.startswith(f"{focus}.") for focus in focus_skills
    )


def _compute_factors(
    skill_id: SkillId,
    dim: SkillReadiness | None,
    requirement: Requirement | None,
    evidence_by_skill: Mapping[str, list[Evidence]],
    asked_here: set[SkillId],
    asked_before: set[SkillId],
    ask_counts: Mapping[str, int],
    loop_weak_skills: Sequence[LoopWeakSkill],
    focus_skills: Sequence[SkillId],
) -> _FactorResult:
    role_importance = requirement.importance if requirement is not None else _FALLBACK_IMPORTANCE
    readiness_gap = 1 - (dim.score if dim is not None and dim.score is not None else 0)
    uncertainty = 1 - (dim.confidence if dim is not None else 0)

    weak = any(
        item.type == EvidenceType.INTERVIEW_ANSWER and item.score < _WEAK_INTERVIEW_SCORE
        for item in evidence_by_skill.get(skill_id, [])
    )
    direct = next((s for s in loop_weak_skills if s.skill_id == skill_id), None)
    via_related = next((s for s in loop_weak_skills if skill_id in related_to(s.skill_id)), None)
    if direct is not None:
        loop_trigger = _LoopTrigger(
            weak_skill_id=skill_id, round=direct.round, mode=direct.mode, direct=True
        )
    elif via_related is not None:
        loop_trigger = _LoopTrigger(
            weak_skill_id=via_related.skill_id,
            round=via_related.round,
            mode=via_related.mode,
            direct=False,
        )
    else:
        loop_trigger = None

    recency_factor = 1.0
    weakness_boost = 1.0
    reason_detail = "not previously asked"
    if skill_id in asked_here:
        # asked this session: recency dominates and cancels the weakness boost
        recency_factor = 0.15
        reason_detail = "already asked this session"
    else:
        if weak:
            weakness_boost = 1.6
            reason_detail = "weak interview evidence; retesting"
        elif loop_trigger is not None:
            weakness_boost = 1.4
            reason_detail = "weak in an earlier loop round"
        if skill_id in asked_before and not weak:
            recency_factor = 0.6
            reason_detail = "asked in a previous session"
    asked_all = ask_counts.get(skill_id, 0)
    novelty_factor = 0.85 if asked_all >= _NOVELTY_ASK_CAP and not weak else 1.0
    pack_focus = 0.15 if _has_pack_focus(skill_id, focus_skills) else 0

    return _FactorResult(
        factors=SelectionFactors(
            role_importance=role_importance,
            readiness_gap=readiness_gap,
            uncertainty=uncertainty,
            weakness_boost=weakness_boost,
            recency_factor=recency_factor,
            novelty_factor=novelty_factor,
            pack_focus=pack_focus,
        ),
        weak=weak,
        loop_trigger=loop_trigger,
        reason_detail=reason_detail,
    )


def _priority_of(factors: SelectionFactors) -> float:
    return (
        factors.role_importance
        * max(factors.readiness_gap, 0.1)
        * (0.5 + factors.uncertainty)
        * factors.weakness_boost
        * factors.recency_factor
        * factors.novelty_factor
        * (1 + factors.pack_focus)
    )


def _result_for(
    skill_id: SkillId,
    dim: SkillReadiness | None,
    priority: float,
    reason: str,
    factors: SelectionFactors,
    candidates: list[SkillCandidate],
    level: Level,
) -> SelectNextSkillResult:
    return SelectNextSkillResult(
        skill_id=skill_id,
        priority=priority,
        reason=reason,
        difficulty=difficulty_for(level, dim.score if dim is not None else None),
        factors=factors,
        candidates=candidates,
    )


def select_next_skill(input: SelectNextSkillInput) -> SelectNextSkillResult | None:
    mode = input.mode if input.mode is not None else input.round_type
    if mode is None:
        mode = "mixed"

    def in_scope(skill_id: SkillId) -> bool:
        return in_round(skill_id, mode)

    requirements = [r for r in input.requirements if in_scope(r.skill_id)]
    scoped_readiness = {
        skill_id: dim for skill_id, dim in input.readiness.items() if in_scope(skill_id)
    }
    req_map: dict[SkillId, Requirement] = {r.skill_id: r for r in requirements}
    asked_here = set(input.asked_this_session)
    asked_before = set(input.asked_previous_session)
    evidence_by_skill: dict[SkillId, list[Evidence]] = {}
    for item in input.evidence:
        evidence_by_skill.setdefault(item.skill_id, []).append(item)

    # Every 4th question of a session confirms a strong area (highest score,
    # confidence < 0.8).
    if (input.question_index + 1) % 4 == 0:
        confirmable = [
            dim
            for dim in scoped_readiness.values()
            if dim.score is not None and dim.confidence < _CONFIRMATION_CONFIDENCE_CAP
        ]
        confirmable.sort(
            key=lambda dim: (-(dim.score if dim.score is not None else 0.0), dim.skill_id)
        )
        top = confirmable[0] if confirmable else None
        if top is not None:
            top_score = top.score if top.score is not None else 0.0
            top_requirement = _nearest_requirement(top.skill_id, req_map)
            factors = SelectionFactors(
                role_importance=(
                    top_requirement.importance
                    if top_requirement is not None
                    else _FALLBACK_IMPORTANCE
                ),
                readiness_gap=1 - top_score,
                uncertainty=1 - top.confidence,
                weakness_boost=1,
                recency_factor=1,
                novelty_factor=1,
                pack_focus=0.15 if _has_pack_focus(top.skill_id, input.focus_skills) else 0,
            )
            return _result_for(
                top.skill_id,
                top,
                top_score,
                "every-4th-question strong-area confirmation",
                factors,
                [
                    SkillCandidate(
                        skill_id=dim.skill_id,
                        priority=dim.score if dim.score is not None else 0.0,
                        reason="confirmation candidate",
                        factors=factors.model_copy(
                            update={
                                "readiness_gap": 1 - (dim.score if dim.score is not None else 0.0),
                                "uncertainty": 1 - dim.confidence,
                            }
                        ),
                    )
                    for dim in confirmable
                ],
                input.level,
            )

    pool: dict[SkillId, None] = {}
    for requirement in requirements:
        pool[requirement.skill_id] = None
    for skill_id, dim in scoped_readiness.items():
        has_evidence = bool(dim.evidence_ids) or dim.score is not None
        nearest_requirement = _nearest_requirement(skill_id, req_map)
        if (
            has_evidence
            and nearest_requirement is not None
            and nearest_requirement.skill_id != skill_id
        ):
            # taxonomy descendant of a requirement, with evidence
            pool[skill_id] = None
        if dim.status != "unknown" and dim.confidence < _LOW_CONFIDENCE:
            # low-confidence skill
            pool[skill_id] = None

    # §9.2: in-scope loop-weak skills and their in-scope related skills join the pool
    for weak_skill in input.loop_weak_skills:
        if in_scope(weak_skill.skill_id):
            pool[weak_skill.skill_id] = None
        for related in related_to(weak_skill.skill_id):
            if in_scope(related):
                pool[related] = None

    # Empty pool in a focused mode → the mode's fallback taxonomy nodes join at 0.6.
    if not pool and mode != "mixed":
        for fallback in round_fallback_requirements(mode):
            req_map[fallback.skill_id] = fallback
            pool[fallback.skill_id] = None

    candidates: list[SkillCandidate] = []
    for skill_id in pool:
        candidate_dim = input.readiness.get(skill_id)
        candidate_requirement = _nearest_requirement(skill_id, req_map)
        factor_result = _compute_factors(
            skill_id,
            candidate_dim,
            candidate_requirement,
            evidence_by_skill,
            asked_here,
            asked_before,
            input.ask_counts,
            input.loop_weak_skills,
            input.focus_skills,
        )
        priority = _priority_of(factor_result.factors)
        base = (
            "no evidence yet"
            if candidate_dim is None or candidate_dim.score is None
            else f"readiness {to_fixed(candidate_dim.score)}"
        )
        trigger = factor_result.loop_trigger
        if trigger is None:
            reason = f"{base}; {factor_result.reason_detail}"
        else:
            tail = "retesting it" if trigger.direct else f"testing {label_for(skill_id)}"
            reason = (
                f"Round {trigger.round} ({get_mode(trigger.mode).label}) showed weak "
                f"{label_for(trigger.weak_skill_id)} → {tail}"
            )
        candidates.append(
            SkillCandidate(
                skill_id=skill_id,
                priority=priority,
                reason=reason,
                factors=factor_result.factors,
            )
        )

    candidates.sort(key=lambda candidate: (-candidate.priority, candidate.skill_id))
    if not candidates:
        return None
    top_candidate = candidates[0]
    return _result_for(
        top_candidate.skill_id,
        input.readiness.get(top_candidate.skill_id),
        top_candidate.priority,
        top_candidate.reason,
        top_candidate.factors,
        candidates,
        input.level,
    )
