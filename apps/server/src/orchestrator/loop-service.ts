import {
  getCompanyProfile,
  getMode,
  newId,
  LoopRoundSchema,
  taxonomy,
  type AnswerEvaluation,
  type LoopDebrief,
  type LoopRound,
  type ReadinessSnapshot,
  type RoundHandoff,
  type RoundType,
  type SkillDelta,
  type SkillId,
} from "@interview-os/core";
import { AppError } from "@interview-os/core";
import { loopDebrief } from "../skills/index.js";
import type { WorkflowContext, ProgressOptions } from "./context.js";
import type { ReadinessService } from "./readiness-service.js";
import type { InterviewService } from "./interview-service.js";
import type { LoopRow, SessionRow } from "./store/index.js";

/** §9.4: one round spec when starting a loop. */
export interface LoopRoundInput {
  mode: string;
  label?: string;
  plannedQuestions?: number;
}

export interface LoopServiceDeps {
  ctx: WorkflowContext;
  readiness: ReadinessService;
  interview: InterviewService;
}

export class LoopService {
  constructor(private readonly deps: LoopServiceDeps) {}

  private get ctx(): WorkflowContext {
    return this.deps.ctx;
  }

  private get store() {
    return this.ctx.store;
  }

  /**
   * Start a full interview loop. `rounds` defaults to the active target's
   * company-profile `typicalLoop`; custom rounds are validated (2–7 rounds,
   * mode ∈ ModeId, plannedQuestions 1–6). Round 1's session is created and
   * its first question generated.
   */
  async startLoop(input: { rounds?: LoopRoundInput[] } = {}, opts?: ProgressOptions) {
    const { target } = await this.ctx.requireActive();
    const profile = getCompanyProfile(target.companyProfileId ?? "generic");
    const defs: LoopRoundInput[] =
      input.rounds ??
      profile.typicalLoop.map((s) => ({ mode: s.mode, label: s.label }));
    if (!Array.isArray(defs) || defs.length < 2 || defs.length > 7) {
      throw new AppError("VALIDATION", "a loop needs between 2 and 7 rounds");
    }
    const rounds: LoopRound[] = defs.map((d) => {
      const parsed = LoopRoundSchema.safeParse({
        mode: d.mode,
        label: d.label ?? "",
        plannedQuestions: d.plannedQuestions ?? 4,
      });
      if (!parsed.success) {
        throw new AppError(
          "VALIDATION",
          `invalid loop round (mode "${d.mode}", plannedQuestions ${d.plannedQuestions})`,
        );
      }
      const r = parsed.data;
      if (!r.label) r.label = getMode(r.mode).label;
      return r;
    });
    const loopId = newId("loop");
    await this.store.insertLoop({
      id: loopId,
      targetId: target.id,
      companyProfileId: profile.id,
      rounds,
      status: "in_progress",
      currentRound: 1,
      createdAt: this.ctx.iso(),
    });
    this.ctx.logger.info("state.mutated", { entity: "loop", id: loopId, rounds: rounds.length });
    const first = await this.openLoopRound(loopId, 0, opts);
    return { loop: await this.viewLoop(loopId), session: first.session, question: first.question };
  }

  /** Create the session for loop round `idx` and generate its first question. */
  private async openLoopRound(loopId: string, idx: number, opts?: ProgressOptions) {
    const loop = await this.store.getLoop(loopId);
    if (!loop) throw new AppError("NOT_FOUND", `no loop ${loopId}`);
    const rounds = [...(loop.rounds as LoopRound[])];
    const round = rounds[idx];
    if (!round) throw new AppError("INTERNAL", `loop ${loopId} has no round ${idx + 1}`);
    round.status = "in_progress";
    round.readinessBefore = await this.readinessSnapshot();
    const created = await this.deps.interview.startInterviewInternal(
      {
        roundType: round.mode,
        plannedQuestions: round.plannedQuestions,
        loopId,
        loopRound: idx + 1,
      },
      opts,
    );
    if (!created.session) {
      throw new AppError("INTERNAL", `loop ${loopId} round ${idx + 1} produced no session`);
    }
    round.sessionId = created.session.id;
    await this.store.updateLoop(loopId, { rounds, currentRound: idx + 1, status: "in_progress" });
    return created;
  }

  /** Overall + per-requirement readiness snapshot at a round boundary. */
  private async readinessSnapshot(): Promise<ReadinessSnapshot> {
    const { target } = await this.ctx.requireActive();
    const graph = await this.deps.readiness.graphForActive();
    const requirements: Record<string, number | null> = {};
    for (const req of this.ctx.allRequirements(target)) {
      requirements[req.skillId] = graph.dimensions[req.skillId]?.score ?? null;
    }
    return { overall: graph.overall, requirements };
  }

  /** Prior rounds' weak skills (for the engine) + observations (for prompts). */
  async loopContextFor(session: SessionRow): Promise<{
    priorWeakSkills: { skillId: SkillId; round: number; mode: RoundType }[];
    priorRoundObservations: string[];
  }> {
    const empty = { priorWeakSkills: [], priorRoundObservations: [] };
    if (!session.loopId || !session.loopRound) return empty;
    const loop = await this.store.getLoop(session.loopId);
    if (!loop) return empty;
    const earlier = (loop.rounds as LoopRound[]).slice(0, session.loopRound - 1);
    const priorWeakSkills = earlier.flatMap((r, i) =>
      (r.handoff?.weakSkills ?? []).map((w) => ({
        skillId: w.skillId,
        round: i + 1,
        mode: r.mode as RoundType,
      })),
    );
    const priorRoundObservations = earlier
      .flatMap((r) => [
        ...(r.handoff?.observations ?? []),
        ...(r.handoff?.weakSkills ?? []).map(
          (w) => `weak: ${taxonomy.labelFor(w.skillId)}`,
        ),
      ])
      .slice(0, 12);
    return { priorWeakSkills, priorRoundObservations };
  }

  /** Deterministic cross-round handoff from a round's evaluations (§9.4). */
  private computeHandoff(evaluations: AnswerEvaluation[]): RoundHandoff {
    const weak = new Map<
      string,
      { skillId: SkillId; label: string; score: number; observation: string }
    >();
    const strong = new Map<
      string,
      { skillId: SkillId; label: string; score: number }
    >();
    for (const e of evaluations) {
      for (const s of e.scores) {
        if (s.score < 0.5 && !weak.has(s.skill)) {
          weak.set(s.skill, {
            skillId: s.skill,
            label: taxonomy.labelFor(s.skill),
            score: s.score,
            observation: (
              e.weaknesses.find((w) => w.skill === s.skill)?.evidence ?? e.summary
            ).slice(0, 200),
          });
        } else if (s.score >= 0.75 && !strong.has(s.skill)) {
          strong.set(s.skill, {
            skillId: s.skill,
            label: taxonomy.labelFor(s.skill),
            score: s.score,
          });
        }
      }
    }
    return {
      weakSkills: [...weak.values()],
      strongSkills: [...strong.values()],
      observations: evaluations.slice(0, 3).map((e) => e.summary.slice(0, 200)),
    };
  }

  /**
   * §9.4: per-skill readiness movement evidenced by a round — for each skill in
   * the round's evaluations' readinessDelta, first `before` → last `after`.
   */
  private computeSkillDeltas(
    evaluationRows: { readinessDelta: unknown }[],
  ): SkillDelta[] {
    const first = new Map<string, number | null>();
    const last = new Map<string, number | null>();
    for (const row of evaluationRows) {
      for (const d of (row.readinessDelta ?? []) as {
        skillId: string;
        before: number | null;
        after: number | null;
      }[]) {
        if (!first.has(d.skillId)) first.set(d.skillId, d.before);
        last.set(d.skillId, d.after);
      }
    }
    return [...last.keys()].map((skillId) => ({
      skillId: skillId as SkillId,
      label: taxonomy.labelFor(skillId as SkillId),
      before: first.get(skillId) ?? null,
      after: last.get(skillId) ?? null,
    }));
  }

  /**
   * Finish the loop round a session belongs to: store its handoff +
   * readinessAfter, then open the next round or run the loop debrief.
   */
  async advanceLoopInternal(sessionId: string, opts?: ProgressOptions) {
    const session = await this.store.getSession(sessionId);
    const loop = session?.loopId ? await this.store.getLoop(session.loopId) : undefined;
    if (!session || !loop) return { loop: null, nextSession: null, nextQuestion: null };
    const rounds = [...(loop.rounds as LoopRound[])];
    const idx = (session.loopRound ?? 1) - 1;
    const round = rounds[idx];
    if (!round || round.status === "complete") {
      return { loop: this.viewLoopRow(loop), nextSession: null, nextQuestion: null };
    }
    const evaluationRows = await this.store.listEvaluations(sessionId);
    const evaluations = evaluationRows.map(
      (r) => r.data as unknown as AnswerEvaluation,
    );
    round.handoff = this.computeHandoff(evaluations);
    round.skillDeltas = this.computeSkillDeltas(evaluationRows);
    round.readinessAfter = await this.readinessSnapshot();
    round.status = "complete";
    await this.store.updateLoop(loop.id, { rounds });

    if (idx + 1 < rounds.length) {
      const next = await this.openLoopRound(loop.id, idx + 1, opts);
      return {
        loop: await this.viewLoop(loop.id),
        nextSession: next.session,
        nextQuestion: next.question,
      };
    }

    opts?.onProgress?.({ stage: "writing loop debrief" });
    const debrief = await this.createLoopDebrief(rounds, opts);
    this.ctx.host.assertCan("loop-debrief", "interview.write");
    await this.store.updateLoop(loop.id, {
      rounds,
      status: "complete",
      completedAt: this.ctx.iso(),
      debrief: debrief as unknown as object,
    });
    return { loop: await this.viewLoop(loop.id), nextSession: null, nextQuestion: null };
  }

  /** The loop-debrief skill call (§9.4) — never produces a hire/no-hire verdict. */
  private async createLoopDebrief(
    rounds: LoopRound[],
    opts?: ProgressOptions,
  ): Promise<LoopDebrief> {
    const { target } = await this.ctx.requireActive();
    const roundSummaries = [];
    for (const r of rounds) {
      const evals = r.sessionId
        ? (await this.store.listEvaluations(r.sessionId)).map(
            (e) => e.data as unknown as AnswerEvaluation,
          )
        : [];
      const acc = new Map<string, { sum: number; n: number }>();
      for (const e of evals) {
        for (const d of e.rubric ?? []) {
          const a = acc.get(d.id) ?? { sum: 0, n: 0 };
          a.sum += d.score;
          a.n += 1;
          acc.set(d.id, a);
        }
      }
      roundSummaries.push({
        mode: r.mode,
        label: r.label,
        summaries: evals.map((e) => e.summary),
        rubricAverages: Object.fromEntries(
          [...acc].map(([k, v]) => [k, v.sum / v.n]),
        ),
        handoff: r.handoff,
      });
    }
    return this.ctx.host.invoke(
      loopDebrief,
      {
        role: target.role,
        company: target.company,
        rounds: roundSummaries,
        readinessChange: {
          before: rounds[0]?.readinessBefore?.overall ?? null,
          after: rounds[rounds.length - 1]?.readinessAfter?.overall ?? null,
        },
      },
      await this.ctx.ctx({ onProgress: opts?.onProgress }),
    );
  }

  private async viewLoop(id: string) {
    const loop = await this.store.getLoop(id);
    return loop ? this.viewLoopRow(loop) : null;
  }

  viewLoopRow(loop: LoopRow) {
    return {
      ...loop,
      rounds: loop.rounds as LoopRound[],
      abandoned: loop.abandoned === 1,
      debrief: (loop.debrief as LoopDebrief | null) ?? null,
    };
  }

  async getLoop(id: string) {
    const loop = await this.viewLoop(id);
    if (!loop) throw new AppError("NOT_FOUND", `no loop ${id}`);
    return loop;
  }

  async listLoops() {
    return (await this.store.listLoops()).map((l) => this.viewLoopRow(l));
  }

  /** Abandon an in-progress loop: current session completed, loop closed. */
  async abandonLoop(id: string) {
    const loop = await this.store.getLoop(id);
    if (!loop) throw new AppError("NOT_FOUND", `no loop ${id}`);
    if (loop.status === "complete") return this.viewLoopRow(loop);
    const rounds = [...(loop.rounds as LoopRound[])];
    const current = rounds[loop.currentRound - 1];
    if (current?.sessionId) {
      const s = await this.store.getSession(current.sessionId);
      if (s?.status === "ready") await this.ctx.transitionSession(s.id, "question", "ask");
      const s2 = await this.store.getSession(current.sessionId);
      if (s2 && (s2.status === "question" || s2.status === "follow_up")) {
        await this.ctx.transitionSession(s2.id, "complete", "complete");
        await this.store.updateSession(s2.id, { completedAt: this.ctx.iso() });
      }
    }
    await this.store.updateLoop(id, {
      rounds,
      status: "complete",
      abandoned: 1,
      completedAt: this.ctx.iso(),
    });
    this.ctx.logger.info("state.mutated", { entity: "loop", id, abandoned: true });
    return this.viewLoop(id);
  }
}
