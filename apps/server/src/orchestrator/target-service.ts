import {
  TargetRoleSchema,
  taxonomy,
  type Requirement,
  type TargetRole,
} from "@interview-os/core";
import { AppError } from "@interview-os/core";
import { jdAnalyzer, taxonomyEntries } from "../skills/index.js";
import type { WorkflowContext, ProgressOptions } from "./context.js";
import type { ReadinessService } from "./readiness-service.js";
import type { PreparationService } from "./preparation-service.js";
import type { WorkspaceService, TargetInput } from "./workspace-service.js";
import { rowToAction, type PrepActionRowLike } from "./projection.js";

export interface TargetServiceDeps {
  ctx: WorkflowContext;
  readiness: ReadinessService;
  preparation: PreparationService;
  workspace: WorkspaceService;
  recordUsageEvent(event: string): Promise<void>;
}

export class TargetService {
  constructor(private readonly deps: TargetServiceDeps) {}

  private get ctx(): WorkflowContext {
    return this.deps.ctx;
  }

  private get store() {
    return this.ctx.store;
  }

  async listTargets() {
    return (await this.store.listTargets()).map((t) => {
      const parsed = TargetRoleSchema.safeParse(t.data);
      const data = parsed.success ? parsed.data : null;
      return {
        id: t.id,
        company: t.company,
        role: t.role,
        level: t.level,
        active: t.active === 1,
        createdAt: t.createdAt,
        companyProfile: data?.companyProfile ?? null,
        companyProfileId: data?.companyProfileId ?? "generic",
        boostedSkillIds: data
          ? [...data.requirements, ...data.preferredSkills]
              .filter((r) => r.boostedBy)
              .map((r) => r.skillId)
          : [],
      };
    });
  }

  /** Add another target role for the active candidate; becomes the active target. */
  async addTarget(input: TargetInput, opts?: ProgressOptions) {
    const { candidate } = await this.ctx.requireActive();
    if (!candidate.id || candidate.id === "none") {
      throw new AppError("NO_ACTIVE_PROFILE", "no active candidate");
    }
    opts?.onProgress?.({ stage: "analyzing job description" });
    const [output, profile] = await Promise.all([
      this.ctx.host.invoke(
        jdAnalyzer,
        {
          jobDescription: input.jobDescription,
          company: input.company,
          role: input.role,
          level: input.level,
          taxonomy: taxonomyEntries(),
        },
        await this.ctx.ctx({ onProgress: opts?.onProgress }),
      ),
      this.deps.workspace.profileCompany(input),
    ]);
    const target = await this.deps.workspace.persistTarget(input, output, profile);
    opts?.onProgress?.({ stage: "calculating gaps" });
    opts?.onProgress?.({ stage: "building prep plan" });
    const { actions } = await this.deps.preparation.buildPreparationPlanInternal();
    this.ctx.logger.info("workflow.completed", { workflow: "addTarget", targetId: target.id });
    return { target, actions };
  }

  async activateTarget(id: string) {
    const row = await this.store.getTarget(id);
    if (!row) throw new AppError("NOT_FOUND", `no target ${id}`);
    await this.store.activateTarget(id);
    this.ctx.bumpUIEpoch();
    await this.deps.recordUsageEvent("target.switched");
    this.ctx.logger.info("state.mutated", { entity: "target", id, active: true });
    const openActions = await this.store.listActions("open", id);
    let actions: PrepActionRowLike[] = openActions.map(rowToAction);
    if (openActions.length === 0) {
      const plan = await this.deps.preparation.buildPreparationPlanInternal();
      actions = plan.actions;
    }
    const target = TargetRoleSchema.parse(row.data);
    return { target, actions };
  }

  /** §9.3/v0.4: built-in + pack-compiled company profiles (with disclaimers). */
  listCompanyProfiles() {
    this.ctx.packs.ensureLoaded();
    return this.ctx.packs.listCompanyProfiles();
  }

  /**
   * §9.3: change a target's company profile. Importances are recomputed from
   * the JD-analyzer `baseImportance` so boosts never compound; the notes
   * overlay (§8.4) re-applies on top. Then readiness + plan rebuild.
   */
  async updateTargetCompanyProfile(targetId: string, companyProfileId: string) {
    const row = await this.store.getTarget(targetId);
    if (!row) throw new AppError("NOT_FOUND", `no target ${targetId}`);
    await this.ctx.packs.ready();
    if (!this.ctx.packs.listCompanyProfiles().some((p) => p.id === companyProfileId)) {
      throw new AppError("VALIDATION", `unknown company profile "${companyProfileId}"`);
    }
    const target = TargetRoleSchema.parse(row.data);
    target.companyProfileId = companyProfileId;
    const notesFocus = new Set<string>(target.companyProfile?.focusSkillIds ?? []);
    target.requirements = target.requirements.map((r) =>
      this.deps.workspace.applyRequirementBoosts(r, companyProfileId, notesFocus),
    );
    target.preferredSkills = target.preferredSkills.map((r) =>
      this.deps.workspace.applyRequirementBoosts(r, companyProfileId, notesFocus),
    );
    await this.store.updateTargetData(targetId, target as unknown as object);
    this.ctx.logger.info("state.mutated", {
      entity: "target",
      id: targetId,
      companyProfileId,
    });
    await this.deps.readiness.recomputeReadinessInternal("company-profile");
    const { actions } = await this.deps.preparation.buildPreparationPlanInternal();
    return { target, actions };
  }

  /**
   * v0.4: assign/clear a role pack. Pack dimensions join the requirements as
   * `origin: "role_pack"` entries (importance = weight, never compounded);
   * re-applying replaces prior role-pack requirements rather than stacking.
   */
  async setTargetRolePack(targetId: string, rolePackId: string | null) {
    const row = await this.store.getTarget(targetId);
    if (!row) throw new AppError("NOT_FOUND", `no target ${targetId}`);
    await this.ctx.packs.ready();
    const pack = rolePackId ? this.ctx.packs.rolePack(rolePackId) : undefined;
    if (rolePackId && !pack) {
      throw new AppError("VALIDATION", `unknown role pack "${rolePackId}"`);
    }
    const target = TargetRoleSchema.parse(row.data);
    target.rolePackId = rolePackId ?? undefined;
    if (pack && pack.taxonomy.length > 0) {
      taxonomy.registerNodes(pack.taxonomy);
      for (const n of pack.taxonomy) await this.ctx.registerSkillNode(n.id);
    }
    // drop previous role-pack requirements, then re-add the new pack's dims
    target.requirements = target.requirements.filter((r) => r.origin !== "role_pack");
    if (pack) {
      const have = new Set(
        this.ctx.allRequirements(target).map((r) => r.skillId),
      );
      for (const dim of pack.dimensions) {
        if (have.has(dim.skillId)) continue;
        target.requirements.push({
          skillId: dim.skillId,
          label: taxonomy.labelFor(dim.skillId),
          importance: dim.weight,
          baseImportance: dim.weight,
          kind: "required",
          evidence: `role pack "${pack.name}"`,
          boostedBy: `role-pack:${pack.id}`,
          origin: "role_pack",
        });
        await this.ctx.registerSkillNode(dim.skillId);
      }
    }
    // re-apply company emphasis + notes overlay on top (non-compounding)
    const notesFocus = new Set<string>(target.companyProfile?.focusSkillIds ?? []);
    const boost = (r: Requirement): Requirement =>
      this.deps.workspace.applyRequirementBoosts(r, target.companyProfileId, notesFocus);
    target.requirements = target.requirements.map(boost);
    target.preferredSkills = target.preferredSkills.map(boost);
    await this.store.updateTargetData(targetId, target as unknown as object);
    this.ctx.logger.info("state.mutated", {
      entity: "target",
      id: targetId,
      rolePackId,
    });
    await this.deps.readiness.recomputeReadinessInternal("role-pack");
    const { actions } = await this.deps.preparation.buildPreparationPlanInternal();
    return { target, actions };
  }
}
