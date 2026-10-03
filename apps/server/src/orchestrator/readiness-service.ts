import {
  calculateGaps,
  type Gap,
  type ReadinessGraph,
} from "@interview-os/core";
import type { WorkflowContext } from "./context.js";

const OVERALL_SKILL_ID = "__overall__";

export class ReadinessService {
  constructor(private readonly ctx: WorkflowContext) {}

  private get store() {
    return this.ctx.store;
  }

  graphForActive(): ReadinessGraph {
    return this.ctx.graphForActive();
  }

  calculateGapsInternal(): Gap[] {
    const { target } = this.ctx.requireActive();
    const graph = this.graphForActive();
    return calculateGaps({
      requirements: this.ctx.allRequirements(target),
      readiness: graph.dimensions,
      level: target.level,
    });
  }

  recomputeReadinessInternal(reason: string): ReadinessGraph {
    const graph = this.graphForActive();
    const latest = this.store.latestReadinessBySkill();
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
    for (const dim of Object.values(graph.dimensions)) {
      if (!changed(dim.skillId, dim.score, dim.confidence)) continue;
      this.store.appendReadinessSnapshot({
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
      this.store.appendReadinessSnapshot({
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
    return graph;
  }
}
