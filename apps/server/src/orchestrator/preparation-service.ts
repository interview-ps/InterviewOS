import { newId, taxonomy, type Requirement, type SkillId } from "@interview-os/core";
import { AppError } from "@interview-os/core";
import { prepPlanner, type PrepPlannerOutput } from "../skills/index.js";
import type { WorkflowContext } from "./context.js";
import type { ReadinessService } from "./readiness-service.js";
import { rowToAction, type PrepActionRowLike } from "./projection.js";

export class PreparationService {
  constructor(
    private readonly ctx: WorkflowContext,
    private readonly readiness: ReadinessService,
  ) {}

  private get store() {
    return this.ctx.store;
  }

  async buildPreparationPlanInternal(): Promise<{
    actions: PrepActionRowLike[];
    created: PrepActionRowLike[];
  }> {
    const { target, candidate } = await this.ctx.requireActive();
    const gaps = await this.readiness.calculateGapsInternal();
    const evidence = await this.ctx.evidenceForActive(candidate.id);
    const openSkills = new Set(
      (await this.store.listActions("open", target.id)).map((a) => a.skillId),
    );

    const targets: Array<{
      skillId: SkillId;
      label: string;
      reason: string;
      missingConcepts: string[];
      severity: "low" | "medium" | "high";
    }> = [];
    const seen = new Set<string>();

    for (const gap of gaps.filter((g) => g.severity !== "low").slice(0, 5)) {
      seen.add(gap.skillId);
      targets.push({
        skillId: gap.skillId,
        label: gap.label,
        reason: gap.reason,
        missingConcepts: [],
        severity: gap.severity,
      });
    }

    const weakSkillIds = new Set<SkillId>();
    for (const e of evidence) {
      if (e.type === "interview_answer" && e.score < 0.5) weakSkillIds.add(e.skillId);
    }
    for (const skillId of [...weakSkillIds].sort()) {
      if (seen.has(skillId) || openSkills.has(skillId)) continue;
      const obs = evidence.find(
        (e) => e.skillId === skillId && e.type === "interview_answer" && e.score < 0.5,
      );
      targets.push({
        skillId,
        label: taxonomy.labelFor(skillId),
        reason: `weak interview evidence: ${obs?.observation ?? ""}`.trim(),
        missingConcepts: [],
        severity: "medium",
      });
    }

    const created: PrepActionRowLike[] = [];
    if (targets.length > 0) {
      const plan: PrepPlannerOutput = await this.ctx.host.invoke(
        prepPlanner,
        { targets, role: target.role, level: target.level },
        await this.ctx.ctx(),
      );
      const bySkill = new Map(plan.actions.map((a) => [a.skillId, a]));
      for (const t of targets) {
        const action = bySkill.get(t.skillId) ?? bySkill.get(t.skillId as string);
        if (!action) continue;
        created.push(
          await this.insertPlannedAction(t.skillId, action, candidate.id, t.severity, target.id),
        );
      }
    }

    await this.renumberActionPriorities(this.ctx.allRequirements(target), target.id);

    const actions = (await this.store.listActions(undefined, target.id))
      .filter((a) => a.status === "open" || a.status === "in_progress")
      .map(rowToAction);
    return { actions, created };
  }

  async insertPlannedAction(
    skillId: SkillId,
    action: { action: string; successCriteria: string[]; reason: string },
    candidateId: string,
    severity: "low" | "medium" | "high" = "medium",
    targetId?: string,
  ): Promise<PrepActionRowLike> {
    // §9.6: planned actions persist prep-planner output.
    this.ctx.host.assertCan("prep-planner", "preparation.write");
    // Atomic supersede + insert: a failure must not drop the action entirely.
    return this.store.transaction(async (tx) => {
      const existing = await tx.openActionForSkill(skillId, targetId);
      if (existing) await tx.updateActionStatus(existing.id, "superseded");
      const sourceEvidenceIds = (await tx.evidenceForSkill(skillId, candidateId)).map(
        (e) => e.id,
      );
      const row = {
        id: newId("action"),
        skillId,
        targetId: targetId ?? null,
        priority: 0, // renumbered by renumberActionPriorities
        reason: action.reason,
        action: action.action,
        successCriteria: action.successCriteria,
        status: "open",
        severity,
        createdAt: this.ctx.iso(),
        sourceEvidenceIds,
      };
      await tx.insertAction(row);
      this.ctx.logger.info("state.mutated", { entity: "prep_action", id: row.id, skillId });
      return rowToAction({ ...row, successCriteria: action.successCriteria, sourceEvidenceIds });
    });
  }

  /**
   * Renumber all open/in_progress actions 1..n. Interview-evidenced actions
   * outrank generic gap actions: severityWeight × 1.5(if interview evidence)
   * × nearest requirement importance; ties by createdAt desc then skillId.
   */
  async renumberActionPriorities(requirements: Requirement[], targetId?: string): Promise<void> {
    const reqMap = new Map(requirements.map((r) => [r.skillId, r]));
    const nearestReq = (skillId: string): Requirement | undefined => {
      let cur: string | null = skillId;
      while (cur !== null) {
        const hit = reqMap.get(cur);
        if (hit) return hit;
        cur = taxonomy.parentOf(cur as SkillId);
      }
      return undefined;
    };
    const sevW = { high: 3, medium: 2, low: 1 } as Record<string, number>;
    // Atomic renumber: priorities are a unique 1..n invariant, so never leave a
    // half-renumbered plan visible.
    await this.store.transaction(async (tx) => {
      const interviewEvidenceIds = new Set(
        (await tx.listEvidence())
          .filter((e) => e.type === "interview_answer")
          .map((e) => e.id),
      );
      const open = (await tx.listActions(undefined, targetId))
        .filter((a) => a.status === "open" || a.status === "in_progress");
      const scored = open.map((a) => {
        const sourceIds = (a.sourceEvidenceIds ?? []) as string[];
        const hasInterviewEvidence = sourceIds.some((id) =>
          interviewEvidenceIds.has(id),
        );
        const score =
          (sevW[a.severity] ?? 2) *
          (hasInterviewEvidence ? 1.5 : 1) *
          (nearestReq(a.skillId)?.importance ?? 0.5);
        return { action: a, score };
      });
      scored.sort(
        (x, y) =>
          y.score - x.score ||
          y.action.createdAt.localeCompare(x.action.createdAt) ||
          x.action.skillId.localeCompare(y.action.skillId),
      );
      for (const [i, { action }] of scored.entries()) {
        await tx.updateActionPriority(action.id, i + 1);
      }
    });
  }

  async listPreparationActions(): Promise<PrepActionRowLike[]> {
    return (await this.store.listActions()).map(rowToAction);
  }

  /**
   * Self-check completion (§8.1): marks the action done and, when checked
   * criteria are supplied, records one `self_report` evidence row, then
   * recomputes readiness and rebuilds the plan.
   */
  async completeAction(actionId: string, opts: { checkedCriteria?: string[] } = {}) {
    const action = await this.store.getAction(actionId);
    if (!action) throw new AppError("NOT_FOUND", `no prep action ${actionId}`);
    const { candidate } = await this.ctx.requireActive();
    const criteria =
      (Array.isArray(action.successCriteria)
        ? action.successCriteria
        : JSON.parse(String(action.successCriteria ?? "[]"))) as string[];

    let evidenceId: string | null = null;
    if (opts.checkedCriteria !== undefined) {
      const bad = opts.checkedCriteria.filter((cc) => !criteria.includes(cc));
      if (bad.length > 0) {
        throw new AppError("VALIDATION", `unknown success criteria: ${bad.join("; ")}`);
      }
      const checked = opts.checkedCriteria;
      evidenceId = newId("ev");
      await this.store.insertEvidence({
        id: evidenceId,
        candidateId: candidate.id,
        skillId: action.skillId,
        type: "self_report",
        score: criteria.length === 0 ? 0 : checked.length / criteria.length,
        confidence: 0.5,
        observation: `Self-check: met ${checked.length}/${criteria.length} criteria — ${checked.join("; ")}`,
        createdAt: this.ctx.iso(),
      });
    }

    await this.store.updateActionStatus(actionId, "done");
    this.ctx.logger.info("state.mutated", { entity: "prep_action", id: actionId, status: "done" });
    await this.readiness.recomputeReadinessInternal("practice");
    const { actions } = await this.buildPreparationPlanInternal();
    return { ok: true, evidenceId, actions };
  }

  async updateActionStatus(
    actionId: string,
    status: "open" | "in_progress" | "done" | "superseded",
  ): Promise<void> {
    await this.store.updateActionStatus(actionId, status);
    this.ctx.logger.info("state.mutated", { entity: "prep_action", id: actionId, status });
  }
}
