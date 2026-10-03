import {
  CandidateProfileSchema,
  buildReadinessGraph,
  taxonomy,
  TargetRoleSchema,
  transition,
  type CandidateProfile,
  type Evidence,
  type InterviewStatus,
  type ReadinessGraph,
  type Requirement,
  type SkillId,
  type TargetRole,
} from "@interview-os/core";
import { AppError, type Logger } from "@interview-os/core";
import type { AIRuntime } from "@interview-os/runtime";
import type { ProgressUpdate, SkillContext, SkillHost } from "../skills/index.js";
import type { Store, SessionRow } from "./store/index.js";

/** Streaming progress pushed to SSE/API callers during long AI operations. */
export interface ProgressOptions {
  onProgress?: (p: ProgressUpdate) => void;
}

/**
 * Shared workflow state + helpers used by every orchestrator service. Owns the
 * primitives that were previously private methods on InterviewOrchestrator so
 * the domain services can stay behaviour-identical without re-deriving them.
 */
export class WorkflowContext {
  constructor(
    readonly store: Store,
    readonly host: SkillHost,
    readonly runtime: AIRuntime,
    readonly logger: Logger,
    readonly now: () => Date,
  ) {}

  /** Skill invocation context, with settings-backed runtime overrides (§8.3). */
  ctx(extra?: Partial<SkillContext>): SkillContext {
    return {
      runtime: this.runtime,
      logger: this.logger,
      now: this.now,
      runtimeOptions: this.runtimeOptions(),
      ...extra,
    };
  }

  iso(): string {
    return this.now().toISOString();
  }

  requireActive(): { candidate: CandidateProfile; target: TargetRole } {
    const candidateRow = this.store.getActiveCandidate();
    const targetRow = this.store.getActiveTarget();
    if (!candidateRow || !targetRow) {
      throw new AppError(
        "NO_ACTIVE_PROFILE",
        "no active candidate/target — call /api/workspace/setup first",
      );
    }
    return {
      candidate: CandidateProfileSchema.parse(candidateRow.data),
      target: TargetRoleSchema.parse(targetRow.data),
    };
  }

  allRequirements(target: TargetRole): Requirement[] {
    return [...target.requirements, ...target.preferredSkills];
  }

  evidenceForActive(candidateId: string): Evidence[] {
    return this.store.listEvidence(candidateId).map((r) => ({
      id: r.id,
      skillId: r.skillId as SkillId,
      type: r.type as Evidence["type"],
      score: r.score,
      confidence: r.confidence,
      observation: r.observation,
      sessionId: r.sessionId ?? undefined,
      questionId: r.questionId ?? undefined,
      createdAt: r.createdAt,
    }));
  }

  graphForActive(): ReadinessGraph {
    const { candidate, target } = this.requireActive();
    return buildReadinessGraph({
      evidence: this.evidenceForActive(candidate.id),
      requirements: this.allRequirements(target),
      taxonomy,
      now: this.now(),
    });
  }

  registerSkillNode(skillId: SkillId): void {
    for (const id of [skillId, ...taxonomy.ancestors(skillId)]) {
      const node = taxonomy.getNode(id);
      this.store.upsertSkillNode(
        id,
        node?.label ?? taxonomy.labelFor(id),
        taxonomy.parentOf(id),
      );
    }
  }

  transitionSession(
    sessionId: string,
    next: InterviewStatus,
    event: Parameters<typeof transition>[1],
  ): void {
    const row = this.store.getSession(sessionId);
    if (!row) throw new AppError("NOT_FOUND", `no session ${sessionId}`);
    const from = row.status as InterviewStatus;
    const to = transition(from, event); // throws InvalidTransitionError
    if (to !== next) {
      throw new AppError("INTERNAL", `unexpected transition ${event}: ${from}→${to}`);
    }
    this.store.updateSession(sessionId, { status: to });
  }

  /** Settings-backed runtime overrides, read at call time (§8.3). */
  runtimeOptions(): SkillContext["runtimeOptions"] {
    const effort = this.store.getSetting("reasoningEffort");
    const taskMode = this.store.getSetting("taskMode");
    return {
      model: this.store.getSetting("model") ?? null,
      effort: effort === "low" || effort === "medium" || effort === "high" ? effort : null,
      taskMode: taskMode === "exec" ? "exec" : "app-server",
    };
  }
}

export type { SessionRow };
