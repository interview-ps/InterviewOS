import {
  CandidateProfileSchema,
  TargetRoleSchema,
  type Gap,
  type ReadinessGraph,
  type SkillManifest,
} from "@interview-os/core";
import type { PluginExecutor, PluginStateSlices } from "../skills/index.js";
import type { WorkflowContext } from "./context.js";

export interface PluginServiceDeps {
  ctx: WorkflowContext;
  graphForActive(): Promise<ReadinessGraph>;
  calculateGaps(): Promise<Gap[]>;
}

export class PluginService {
  constructor(private readonly deps: PluginServiceDeps) {}

  private get ctx(): WorkflowContext {
    return this.deps.ctx;
  }

  /** Register a plugin skill on the host (the server-side loader validates first). */
  registerPlugin(manifest: SkillManifest, executor: PluginExecutor): void {
    this.ctx.host.registerPlugin(manifest, executor);
  }

  /** All registered manifests — built-ins and loaded plugins. */
  listSkillManifests(): SkillManifest[] {
    return this.ctx.host.manifests();
  }

  /**
   * §9.6: run a registered plugin. Input is assembled from state, only for
   * the slices its manifest declares.
   */
  async runPlugin(id: string): Promise<unknown> {
    const candidateRow = await this.ctx.store.getActiveCandidate();
    const targetRow = await this.ctx.store.getActiveTarget();
    const slices: PluginStateSlices = {};
    if (candidateRow) {
      const parsed = CandidateProfileSchema.safeParse(candidateRow.data);
      if (parsed.success) slices.candidate = parsed.data;
      slices.stories = await this.ctx.store.listStories(candidateRow.id);
    }
    if (targetRow) {
      const parsed = TargetRoleSchema.safeParse(targetRow.data);
      if (parsed.success) slices.target = parsed.data;
    }
    if (candidateRow && targetRow) {
      slices.readiness = (await this.deps.graphForActive()).dimensions;
      slices.gaps = await this.deps.calculateGaps();
    }
    slices.recentEvaluations = (await this.ctx.store.listAllEvaluations())
      .slice(-20)
      .map((e) => e.data);
    return this.ctx.host.invokePlugin(id, slices, await this.ctx.ctx());
  }
}
