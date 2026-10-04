import {
  calculateGaps,
  type Gap,
  type ReadinessGraph,
} from "@interview-os/core";
import type { WorkflowContext } from "./context.js";

const OVERALL_SKILL_ID = "__overall__";

export class ReadinessService {
  constructor(
    private readonly ctx: WorkflowContext,
    private readonly deps?: {
      /** v1: fired (inside the lock; expected to enqueue) when a recompute
       *  appends snapshots whose scores differ from the previous ones. */
      onReadinessChanged?: (changedSkillIds: string[], reason: string) => void;
    },
  ) {}

  private get store() {
    return this.ctx.store;
  }

  graphForActive(): Promise<ReadinessGraph> {
    return this.ctx.graphForActive();
  }

  async calculateGapsInternal(): Promise<Gap[]> {
    const { target } = await this.ctx.requireActive();
    const graph = await this.graphForActive();
    return calculateGaps({
      requirements: this.ctx.allRequirements(target),
      readiness: graph.dimensions,
      level: target.level,
    });
  }

  async recomputeReadinessInternal(reason: string): Promise<ReadinessGraph> {
    const graph = await this.graphForActive();
    const latest = await this.store.latestReadinessBySkill();
    const computedAt = this.ctx.iso();
    const changed = (
      skillId: string,
      score: number | null,
      confidence: number,
    ): boolean => {
      const prev = latest.get(skillId);
      if (!prev) return true;
      const prevScore = prev.score;
      return prevScore !== score || Math.abs(prev.confidence - confidence) > 1e-9;
    };
    let appended = 0;
    const changedSkillIds: string[] = [];
    for (const dim of Object.values(graph.dimensions)) {
      if (!changed(dim.skillId, dim.score, dim.confidence)) continue;
      if (latest.get(dim.skillId)?.score !== dim.score) {
        changedSkillIds.push(dim.skillId);
      }
      await this.store.appendReadinessSnapshot({
        skillId: dim.skillId,
        score: dim.score,
        confidence: dim.confidence,
        evidenceIds: dim.evidenceIds as unknown,
        reason,
        computedAt,
      });
      appended += 1;
    }
    if (changed(OVERALL_SKILL_ID, graph.overall, graph.overallConfidence)) {
      await this.store.appendReadinessSnapshot({
        skillId: OVERALL_SKILL_ID,
        score: graph.overall,
        confidence: graph.overallConfidence,
        evidenceIds: [],
        reason,
        computedAt,
      });
      appended += 1;
    }
    this.ctx.logger.info("readiness.updated", { reason, nodesChanged: appended });
    if (appended > 0) this.ctx.bumpUIEpoch();
    if (changedSkillIds.length > 0) {
      this.deps?.onReadinessChanged?.(changedSkillIds, reason);
    }
    return graph;
  }
}
