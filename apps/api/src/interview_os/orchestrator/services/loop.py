"""Loop service — port of `apps/server/src/orchestrator/loop-service.ts`.

§9.4 interview loops: start a full loop (rounds from the target's company
profile / role pack or an explicit caller list), carry weak skills and
observations across rounds, finish a round (handoff + readiness delta), open the
next one and run the loop debrief. Never produces a hire/no-hire verdict.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import TYPE_CHECKING

from pydantic import BaseModel, TypeAdapter, ValidationError

from ...ai.interface import ProgressUpdate
from ...core import new_id, taxonomy
from ...core.models import (
    AnswerEvaluation,
    AppError,
    CamelModel,
    InterviewEvent,
    InterviewLoopRow,
    InterviewStatus,
    LoopDebrief,
    LoopRound,
    LoopRoundStatus,
    ReadinessChange,
    ReadinessSnapshot,
    RoundHandoff,
    RoundHandoffStrongSkill,
    RoundHandoffWeakSkill,
    SkillDelta,
)
from ...core.modes import get_mode, is_mode_available
from ...core.prioritize import LoopWeakSkill
from ...core.skill_id import SkillId
from ...skills.evaluate.debriefs import LoopDebriefRoundInput
from ...skills.evaluate.debriefs import loop_debrief as loop_debrief_skill
from ...store import EvaluationRow, SessionRow
from ..context import ProgressOptions, WorkflowContext
from ..projection import OrchestratorQuestion
from .interview import InternalStartInput, InterviewService, NextQuestionResult

if TYPE_CHECKING:
    from ...packs.registry import PackRegistry
    from .readiness import ReadinessService

__all__ = [
    "AdvanceLoopResult",
    "LoopContext",
    "LoopRoundInput",
    "LoopService",
    "LoopView",
    "StartLoopInput",
    "StartLoopResult",
]

_LOOP_ROUNDS = TypeAdapter(list[LoopRound])


class LoopRoundInput(CamelModel):
    """§9.4: one round spec when starting a loop."""

    mode: str
    label: str | None = None
    planned_questions: int | None = None


class StartLoopInput(CamelModel):
    rounds: list[LoopRoundInput] | None = None
    pack_id: str | None = None
    focus_skills: list[SkillId] | None = None


class LoopContext(CamelModel):
    """Prior rounds' weak skills (for the engine) + observations (for prompts)."""

    prior_weak_skills: list[LoopWeakSkill]
    prior_round_observations: list[str]


class LoopView(InterviewLoopRow):
    """§9.4 loop row as the API exposes it: parsed rounds, `abandoned` as a bool."""

    rounds: list[LoopRound]
    abandoned: bool
    debrief: LoopDebrief | None = None


class StartLoopResult(CamelModel):
    loop: LoopView | None
    session: SessionRow | None
    question: OrchestratorQuestion | None


class AdvanceLoopResult(CamelModel):
    loop: LoopView | None
    next_session: SessionRow | None
    next_question: OrchestratorQuestion | None


class LoopService:
    def __init__(
        self,
        ctx: WorkflowContext,
        readiness: ReadinessService,
        interview: InterviewService,
    ) -> None:
        self._ctx = ctx
        self._readiness = readiness
        self._interview = interview

    # ------------------------------------------------------------ public API

    async def start_loop(
        self,
        input: StartLoopInput | Mapping[str, object] | None = None,
        opts: ProgressOptions | None = None,
    ) -> StartLoopResult:
        """Start a full interview loop. `rounds` defaults to the active target's
        company-profile `typicalLoop`; custom rounds are validated (2–7 rounds,
        mode ∈ ModeId, plannedQuestions 1–6). Round 1's session is created and
        its first question generated.
        """

        store = self._ctx.store
        parsed = _as_start_loop(input)
        _candidate, target = await self._ctx.require_active()
        packs = self._packs()
        await packs.ready()
        profile = packs.company_profile(target.company_profile_id or "generic")
        # v0.4: a target with a role pack but no company match takes its default
        # loop shape from the pack's question categories.
        role_pack = packs.role_pack(target.role_pack_id) if target.role_pack_id else None
        if parsed.rounds is not None:
            defs = list(parsed.rounds)
        elif profile.id == "generic" and role_pack is not None:
            defs = [LoopRoundInput(mode=mode) for mode in role_pack.default_question_categories]
        else:
            defs = [
                LoopRoundInput(mode=stage.mode, label=stage.label)
                for stage in profile.typical_loop
            ]
        if parsed.rounds is not None:
            # Explicit rounds: an unavailable mode is a caller error.
            bad = next((entry for entry in defs if not is_mode_available(entry.mode)), None)
            if bad is not None:
                raise AppError(
                    "VALIDATION",
                    f'interview mode "{bad.mode}" is unavailable — its plugin is not installed '
                    "or not enabled",
                )
        else:
            # Profile/pack-derived loops skip rounds whose mode is unavailable
            # (e.g. the coding plugin is disabled).
            for entry in defs:
                if not is_mode_available(entry.mode):
                    self._ctx.logger.warn("loop.mode_unavailable", {"mode": entry.mode})
            defs = [entry for entry in defs if is_mode_available(entry.mode)]
        if len(defs) < 2 or len(defs) > 7:
            raise AppError("VALIDATION", "a loop needs between 2 and 7 rounds")
        rounds: list[LoopRound] = []
        for entry in defs:
            planned = entry.planned_questions if entry.planned_questions is not None else 4
            try:
                round_ = LoopRound(
                    mode=entry.mode,
                    label=entry.label if entry.label is not None else "",
                    planned_questions=planned,
                )
            except ValidationError as err:
                shown = (
                    entry.planned_questions
                    if entry.planned_questions is not None
                    else "undefined"
                )
                raise AppError(
                    "VALIDATION",
                    f'invalid loop round (mode "{entry.mode}", plannedQuestions {shown})',
                ) from err
            if not round_.label:
                round_.label = get_mode(round_.mode).label
            rounds.append(round_)
        loop_id = new_id("loop")
        store.insert_loop(
            id=loop_id,
            target_id=target.id,
            company_profile_id=profile.id,
            rounds=rounds,
            pack_id=parsed.pack_id,
            focus_skills=parsed.focus_skills or [],
            status="in_progress",
            current_round=1,
            created_at=self._ctx.iso(),
        )
        self._ctx.logger.info(
            "state.mutated", {"entity": "loop", "id": loop_id, "rounds": len(rounds)}
        )
        first = await self._open_loop_round(loop_id, 0, opts)
        return StartLoopResult(
            loop=await self._view_loop(loop_id),
            session=first.session,
            question=first.question,
        )

    async def loop_context_for(self, session: SessionRow) -> LoopContext:
        """Prior rounds' weak skills (for the engine) + observations (for prompts)."""

        empty = LoopContext(prior_weak_skills=[], prior_round_observations=[])
        if not session.loop_id or not session.loop_round:
            return empty
        loop = self._ctx.store.get_loop(session.loop_id)
        if loop is None:
            return empty
        earlier = _LOOP_ROUNDS.validate_python(loop.rounds)[: session.loop_round - 1]
        prior_weak_skills: list[LoopWeakSkill] = []
        observations: list[str] = []
        for index, round_ in enumerate(earlier):
            handoff = round_.handoff
            if handoff is None:
                continue
            for weak in handoff.weak_skills:
                prior_weak_skills.append(
                    LoopWeakSkill(skill_id=weak.skill_id, round=index + 1, mode=round_.mode)
                )
            observations.extend(handoff.observations)
            observations.extend(
                f"weak: {taxonomy.label_for(weak.skill_id)}" for weak in handoff.weak_skills
            )
        return LoopContext(
            prior_weak_skills=prior_weak_skills,
            prior_round_observations=observations[:12],
        )

    async def advance_loop_internal(
        self, session_id: str, opts: ProgressOptions | None = None
    ) -> AdvanceLoopResult:
        """Finish the loop round a session belongs to: store its handoff +
        readinessAfter, then open the next round or run the loop debrief.
        """

        store = self._ctx.store
        session = store.get_session(session_id)
        loop = (
            store.get_loop(session.loop_id)
            if session is not None and session.loop_id
            else None
        )
        if session is None or loop is None:
            return AdvanceLoopResult(loop=None, next_session=None, next_question=None)
        rounds = _LOOP_ROUNDS.validate_python(loop.rounds)
        idx = (session.loop_round or 1) - 1
        round_ = rounds[idx] if 0 <= idx < len(rounds) else None
        if round_ is None or round_.status == LoopRoundStatus.COMPLETE:
            return AdvanceLoopResult(
                loop=self.view_loop_row(loop), next_session=None, next_question=None
            )
        evaluation_rows = store.list_evaluations(session_id)
        evaluations = [row.data for row in evaluation_rows]
        round_.handoff = _compute_handoff(evaluations)
        round_.skill_deltas = _compute_skill_deltas(evaluation_rows)
        round_.readiness_after = await self._readiness_snapshot()
        round_.status = LoopRoundStatus.COMPLETE
        store.update_loop(loop.id, {"rounds": _dump(rounds)})

        # Skip upcoming rounds whose mode became unavailable (plugin disabled
        # mid-loop) — mark them complete instead of failing the loop.
        next_idx = idx + 1
        while next_idx < len(rounds) and not is_mode_available(rounds[next_idx].mode):
            self._ctx.logger.warn(
                "loop.mode_unavailable", {"loop": loop.id, "mode": rounds[next_idx].mode}
            )
            rounds[next_idx].status = LoopRoundStatus.COMPLETE
            next_idx += 1
        if next_idx > idx + 1:
            store.update_loop(loop.id, {"rounds": _dump(rounds)})

        if next_idx < len(rounds):
            following = await self._open_loop_round(loop.id, next_idx, opts)
            return AdvanceLoopResult(
                loop=await self._view_loop(loop.id),
                next_session=following.session,
                next_question=following.question,
            )

        _progress(opts, "writing loop debrief")
        debrief = await self._create_loop_debrief(rounds, opts)
        self._ctx.host.assert_can("loop-debrief", "interview.write")
        store.update_loop(
            loop.id,
            {
                "rounds": _dump(rounds),
                "status": "complete",
                "completed_at": self._ctx.iso(),
                "debrief": _dump(debrief),
            },
        )
        return AdvanceLoopResult(
            loop=await self._view_loop(loop.id), next_session=None, next_question=None
        )

    def view_loop_row(self, loop: InterviewLoopRow) -> LoopView:
        """`{...loop, rounds, abandoned: bool, debrief: LoopDebrief | null}`."""

        debrief_raw = loop.debrief
        return LoopView(
            **{
                **loop.model_dump(),
                "rounds": _LOOP_ROUNDS.validate_python(loop.rounds),
                "abandoned": loop.abandoned == 1,
                "debrief": (
                    LoopDebrief.model_validate(debrief_raw)
                    if isinstance(debrief_raw, dict)
                    else None
                ),
            }
        )

    async def get_loop(self, id: str) -> LoopView:
        loop = await self._view_loop(id)
        if loop is None:
            raise AppError("NOT_FOUND", f"no loop {id}")
        return loop

    async def list_loops(self) -> list[LoopView]:
        return [self.view_loop_row(loop) for loop in self._ctx.store.list_loops()]

    async def abandon_loop(self, id: str) -> LoopView | None:
        """Abandon an in-progress loop: current session completed, loop closed."""

        store = self._ctx.store
        loop = store.get_loop(id)
        if loop is None:
            raise AppError("NOT_FOUND", f"no loop {id}")
        if loop.status == "complete":
            return self.view_loop_row(loop)
        rounds = _LOOP_ROUNDS.validate_python(loop.rounds)
        index = loop.current_round - 1
        current = rounds[index] if 0 <= index < len(rounds) else None
        if current is not None and current.session_id:
            session = store.get_session(current.session_id)
            if session is not None and session.status == InterviewStatus.READY:
                self._ctx.transition_session(
                    session.id, InterviewStatus.QUESTION, InterviewEvent.ASK
                )
            updated = store.get_session(current.session_id)
            if updated is not None and updated.status in (
                InterviewStatus.QUESTION,
                InterviewStatus.FOLLOW_UP,
            ):
                self._ctx.transition_session(
                    updated.id, InterviewStatus.COMPLETE, InterviewEvent.COMPLETE
                )
                store.update_session(updated.id, {"completed_at": self._ctx.iso()})
        store.update_loop(
            id,
            {
                "rounds": _dump(rounds),
                "status": "complete",
                "abandoned": 1,
                "completed_at": self._ctx.iso(),
            },
        )
        self._ctx.logger.info("state.mutated", {"entity": "loop", "id": id, "abandoned": True})
        return await self._view_loop(id)

    # -------------------------------------------------------------- internals

    def _packs(self) -> PackRegistry:
        packs = self._ctx.packs
        if packs is None:
            raise AppError("VALIDATION", "no pack registry configured")
        return packs

    async def _open_loop_round(
        self, loop_id: str, idx: int, opts: ProgressOptions | None = None
    ) -> NextQuestionResult:
        """Create the session for loop round `idx` and generate its first question."""

        store = self._ctx.store
        loop = store.get_loop(loop_id)
        if loop is None:
            raise AppError("NOT_FOUND", f"no loop {loop_id}")
        rounds = _LOOP_ROUNDS.validate_python(loop.rounds)
        round_ = rounds[idx] if 0 <= idx < len(rounds) else None
        if round_ is None:
            raise AppError("INTERNAL", f"loop {loop_id} has no round {idx + 1}")
        round_.status = LoopRoundStatus.IN_PROGRESS
        round_.readiness_before = await self._readiness_snapshot()
        created = await self._interview.start_interview_internal(
            InternalStartInput(
                round_type=round_.mode,
                planned_questions=round_.planned_questions,
                loop_id=loop_id,
                loop_round=idx + 1,
            ),
            opts,
        )
        if created.session is None:
            raise AppError("INTERNAL", f"loop {loop_id} round {idx + 1} produced no session")
        round_.session_id = created.session.id
        store.update_loop(
            loop_id,
            {"rounds": _dump(rounds), "current_round": idx + 1, "status": "in_progress"},
        )
        return created

    async def _readiness_snapshot(self) -> ReadinessSnapshot:
        """Overall + per-requirement readiness snapshot at a round boundary."""

        _candidate, target = await self._ctx.require_active()
        graph = self._readiness.graph_for_active()
        requirements: dict[str, float | None] = {}
        for requirement in self._ctx.all_requirements(target):
            dimension = graph.dimensions.get(requirement.skill_id)
            requirements[requirement.skill_id] = None if dimension is None else dimension.score
        return ReadinessSnapshot(overall=graph.overall, requirements=requirements)

    async def _create_loop_debrief(
        self, rounds: list[LoopRound], opts: ProgressOptions | None = None
    ) -> LoopDebrief:
        """The loop-debrief skill call (§9.4) — never produces a hire/no-hire verdict."""

        store = self._ctx.store
        _candidate, target = await self._ctx.require_active()
        round_summaries: list[LoopDebriefRoundInput] = []
        for round_ in rounds:
            evaluations = (
                [row.data for row in store.list_evaluations(round_.session_id)]
                if round_.session_id
                else []
            )
            totals: dict[str, list[float]] = {}
            for evaluation in evaluations:
                for dimension in evaluation.rubric or []:
                    totals.setdefault(dimension.id, []).append(dimension.score)
            round_summaries.append(
                LoopDebriefRoundInput(
                    mode=round_.mode,
                    label=round_.label,
                    summaries=[evaluation.summary for evaluation in evaluations],
                    rubric_averages={
                        key: sum(values) / len(values) for key, values in totals.items()
                    },
                    handoff=round_.handoff,
                )
            )
        first = rounds[0] if rounds else None
        last = rounds[-1] if rounds else None
        debrief: LoopDebrief = await self._ctx.host.invoke(
            loop_debrief_skill,
            {
                "role": target.role,
                "company": target.company,
                "rounds": round_summaries,
                "readinessChange": ReadinessChange(
                    before=(
                        first.readiness_before.overall
                        if first is not None and first.readiness_before is not None
                        else None
                    ),
                    after=(
                        last.readiness_after.overall
                        if last is not None and last.readiness_after is not None
                        else None
                    ),
                ),
            },
            await self._ctx.ctx(on_progress=opts.on_progress if opts is not None else None),
        )
        return debrief

    async def _view_loop(self, id: str) -> LoopView | None:
        loop = self._ctx.store.get_loop(id)
        return None if loop is None else self.view_loop_row(loop)


def _dump(value: object) -> str:
    """Encode a JSON column the way the store's own writers do."""

    return json.dumps(value, separators=(",", ":"), ensure_ascii=False, default=_dump_default)


def _dump_default(value: object) -> object:
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json", by_alias=True)
    raise TypeError(f"{type(value).__name__} is not JSON serializable")


def _progress(opts: ProgressOptions | None, stage: str) -> None:
    if opts is not None and opts.on_progress is not None:
        opts.on_progress(ProgressUpdate(stage=stage))


def _as_start_loop(input: StartLoopInput | Mapping[str, object] | None) -> StartLoopInput:
    if input is None:
        return StartLoopInput()
    if isinstance(input, StartLoopInput):
        return input
    return StartLoopInput.model_validate(input)


def _compute_handoff(evaluations: list[AnswerEvaluation]) -> RoundHandoff:
    """Deterministic cross-round handoff from a round's evaluations (§9.4)."""

    weak: dict[str, RoundHandoffWeakSkill] = {}
    strong: dict[str, RoundHandoffStrongSkill] = {}
    for evaluation in evaluations:
        for score in evaluation.scores:
            if score.score < 0.5 and score.skill not in weak:
                evidence = next(
                    (
                        weakness.evidence
                        for weakness in evaluation.weaknesses
                        if weakness.skill == score.skill
                    ),
                    None,
                )
                weak[score.skill] = RoundHandoffWeakSkill(
                    skill_id=score.skill,
                    label=taxonomy.label_for(score.skill),
                    score=score.score,
                    observation=(evidence if evidence is not None else evaluation.summary)[:200],
                )
            elif score.score >= 0.75 and score.skill not in strong:
                strong[score.skill] = RoundHandoffStrongSkill(
                    skill_id=score.skill,
                    label=taxonomy.label_for(score.skill),
                    score=score.score,
                )
    return RoundHandoff(
        weak_skills=list(weak.values()),
        strong_skills=list(strong.values()),
        observations=[evaluation.summary[:200] for evaluation in evaluations[:3]],
    )


def _compute_skill_deltas(evaluation_rows: list[EvaluationRow]) -> list[SkillDelta]:
    """§9.4 per-skill readiness movement evidenced by a round — for each skill in
    the round's evaluations' readinessDelta, first `before` → last `after`.
    """

    first: dict[str, float | None] = {}
    last: dict[str, float | None] = {}
    for row in evaluation_rows:
        for delta in row.readiness_delta or []:
            if delta.skill_id not in first:
                first[delta.skill_id] = delta.before
            last[delta.skill_id] = delta.after
    return [
        SkillDelta(
            skill_id=skill_id,
            label=taxonomy.label_for(skill_id),
            before=first[skill_id],
            after=last[skill_id],
        )
        for skill_id in last
    ]
