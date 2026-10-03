import {
  getCompanyProfile,
  matchCompanyProfile,
  newId,
  type CandidateProfile,
  type CompanyNotesProfile,
  type Level,
  type Requirement,
  type TargetRole,
  type SkillId,
} from "@interview-os/core";
import {
  companyProfiler,
  jdAnalyzer,
  resumeAnalyzer,
  SkillRuntimeError,
  taxonomyEntries,
  type ResumeAnalyzerOutput,
  type JdAnalyzerOutput,
} from "../skills/index.js";
import type { WorkflowContext, ProgressOptions } from "./context.js";
import type { ReadinessService } from "./readiness-service.js";
import type { PreparationService } from "./preparation-service.js";

export interface SetupWorkspaceInput {
  resumeText: string;
  jobDescription: string;
  company: string;
  role: string;
  level: Level;
  /** §8.4: untrusted careers-page notes → company profiler. */
  companyNotes?: string;
}

export interface TargetInput {
  jobDescription: string;
  company: string;
  role: string;
  level: Level;
  companyNotes?: string;
}

export interface WorkspaceServiceDeps {
  ctx: WorkflowContext;
  readiness: ReadinessService;
  preparation: PreparationService;
}

export class WorkspaceService {
  constructor(private readonly deps: WorkspaceServiceDeps) {}

  private get ctx(): WorkflowContext {
    return this.deps.ctx;
  }

  private get store() {
    return this.ctx.store;
  }

  private registerSkillNode(skillId: SkillId): void {
    this.ctx.registerSkillNode(skillId);
  }

  async setupWorkspace(input: SetupWorkspaceInput, opts?: ProgressOptions) {
    this.ctx.logger.info("workflow.started", { workflow: "setupWorkspace" });
    const onProgress = opts?.onProgress;
    try {
      // resume and JD analysis are independent — run them concurrently;
      // persistence stays sequential.
      onProgress?.({ stage: "analyzing resume" });
      onProgress?.({ stage: "analyzing job description" });
      const profileCompany = input.companyNotes?.trim()
        ? (onProgress?.({ stage: "profiling company" }),
          this.ctx.host.invoke(
            companyProfiler,
            {
              company: input.company,
              companyNotes: input.companyNotes,
              taxonomy: taxonomyEntries(),
            },
            this.ctx.ctx({ onProgress }),
          ))
        : Promise.resolve(null);
      const [candidateOut, targetOut, companyProfile] = await Promise.all([
        this.ctx.host.invoke(
          resumeAnalyzer,
          { resumeText: input.resumeText, taxonomy: taxonomyEntries() },
          this.ctx.ctx({ onProgress }),
        ),
        this.ctx.host.invoke(
          jdAnalyzer,
          {
            jobDescription: input.jobDescription,
            company: input.company,
            role: input.role,
            level: input.level,
            taxonomy: taxonomyEntries(),
          },
          this.ctx.ctx({ onProgress }),
        ),
        profileCompany,
      ]);
      const candidate = this.persistCandidate(input.resumeText, candidateOut);
      const target = this.persistTarget(input, targetOut, companyProfile);
      this.deps.readiness.recomputeReadinessInternal("setup");
      onProgress?.({ stage: "calculating gaps" });
      const gaps = this.deps.readiness.calculateGapsInternal();
      onProgress?.({ stage: "building prep plan" });
      const { actions } = await this.deps.preparation.buildPreparationPlanInternal();
      this.ctx.logger.info("workflow.completed", { workflow: "setupWorkspace" });
      return { candidate, target, gaps, actions };
    } catch (err) {
      const detail: Record<string, unknown> = {
        workflow: "setupWorkspace",
        error: (err as Error).message,
      };
      if (err instanceof SkillRuntimeError) {
        detail.skill = err.taskId;
        detail.runtimeCode = err.runtimeCode;
      }
      this.ctx.logger.warn("workflow.failed", detail);
      throw err;
    }
  }

  async analyzeCandidateInternal(resumeText: string): Promise<CandidateProfile> {
    const output = await this.ctx.host.invoke(
      resumeAnalyzer,
      { resumeText, taxonomy: taxonomyEntries() },
      this.ctx.ctx(),
    );
    return this.persistCandidate(resumeText, output);
  }

  persistCandidate(
    resumeText: string,
    output: ResumeAnalyzerOutput,
  ): CandidateProfile {
    // §9.6: the skill's outputs persist candidate profile + evidence + stories.
    this.ctx.host.assertCan("resume-analyzer", "candidate.write");
    this.ctx.host.assertCan("resume-analyzer", "evidence.write");
    this.ctx.host.assertCan("resume-analyzer", "stories.write");
    const candidate: CandidateProfile = {
      id: newId("cand"),
      name: output.name ?? undefined,
      headline: output.headline ?? undefined,
      experience: output.experience,
      skills: output.skills,
      projects: output.projects,
      achievements: output.achievements,
      education: output.education,
      starStories: output.starStories,
    };
    this.store.deactivateCandidates();
    this.store.insertCandidate({
      id: candidate.id,
      active: 1,
      name: candidate.name ?? null,
      headline: candidate.headline ?? null,
      resumeText,
      data: candidate as unknown as object,
      createdAt: this.ctx.iso(),
    });
    // STAR stories extracted from the resume seed the story bank (§8.4)
    for (const story of candidate.starStories) {
      this.store.insertStory({
        id: newId("story"),
        candidateId: candidate.id,
        title: story.title,
        situation: story.situation,
        task: story.task,
        action: story.action,
        result: story.result,
        skillIds: story.skillIds,
        source: "resume",
        updatedAt: this.ctx.iso(),
      });
    }
    const createdAt = this.ctx.iso();
    for (const skill of candidate.skills) {
      this.registerSkillNode(skill.skillId);
      this.store.insertEvidence({
        id: newId("ev"),
        candidateId: candidate.id,
        skillId: skill.skillId,
        type: "resume_claim",
        score: skill.level,
        confidence: 0.5,
        observation: skill.evidence,
        createdAt,
      });
    }
    this.ctx.logger.info("state.mutated", { entity: "candidate", id: candidate.id });
    return candidate;
  }

  /** §8.4: profile the company when untrusted notes were supplied. */
  profileCompany(input: TargetInput): Promise<CompanyNotesProfile | null> {
    if (!input.companyNotes?.trim()) return Promise.resolve(null);
    return this.ctx.host.invoke(
      companyProfiler,
      {
        company: input.company,
        companyNotes: input.companyNotes,
        taxonomy: taxonomyEntries(),
      },
      this.ctx.ctx(),
    );
  }

  async analyzeTargetInternal(input: TargetInput): Promise<TargetRole> {
    const [output, profile] = await Promise.all([
      this.ctx.host.invoke(
        jdAnalyzer,
        { ...input, taxonomy: taxonomyEntries() },
        this.ctx.ctx(),
      ),
      this.profileCompany(input),
    ]);
    return this.persistTarget(input, output, profile);
  }

  /**
   * §9.3 importance: recompute from `baseImportance` (the JD-analyzer value)
   * so boosts never compound. Built-in profile emphasis applies
   * `boostedBy: "company-profile:<id>"`; the pasted-notes overlay keeps the
   * v0.2 `+0.05` / `"company-profile"` semantics.
   */
  applyRequirementBoosts(
    req: Requirement,
    companyProfileId: string | undefined,
    notesFocus: Set<string>,
  ): Requirement {
    const base = req.baseImportance ?? req.importance;
    const profile = companyProfileId ? getCompanyProfile(companyProfileId) : null;
    let importance = base;
    let boostedBy: string | undefined;
    const emphasis = profile?.emphasis.find((e) => e.skillId === req.skillId);
    if (emphasis && profile && profile.id !== "generic") {
      importance = Math.min(0.95, importance + emphasis.weight);
      boostedBy = `company-profile:${profile.id}`;
    }
    if (notesFocus.has(req.skillId)) {
      importance = Math.min(0.95, importance + 0.05);
      boostedBy = boostedBy ?? "company-profile";
    }
    return {
      ...req,
      baseImportance: base,
      importance: Math.round(importance * 100) / 100,
      boostedBy,
    };
  }

  persistTarget(
    input: TargetInput,
    output: JdAnalyzerOutput,
    companyProfile: CompanyNotesProfile | null = null,
  ): TargetRole {
    // §9.6: skill outputs persist the target row (+ its notes-derived profile).
    this.ctx.host.assertCan("jd-analyzer", "target.write");
    if (companyProfile) this.ctx.host.assertCan("company-profiler", "target.write");
    // §9.3: auto-match a built-in profile; §8.4 notes profile stays an overlay
    const profileId = matchCompanyProfile(input.company).id;
    const notesFocus = new Set<string>(companyProfile?.focusSkillIds ?? []);
    const boost = (r: Requirement): Requirement =>
      this.applyRequirementBoosts(r, profileId, notesFocus);
    const target: TargetRole = {
      id: newId("target"),
      company: input.company,
      role: input.role,
      level: input.level,
      jobDescription: input.jobDescription,
      companyNotes: input.companyNotes,
      requirements: output.requirements.map(boost),
      preferredSkills: output.preferredSkills.map(boost),
      companyProfile: companyProfile ?? undefined,
      companyProfileId: profileId,
    };
    this.store.deactivateTargets();
    this.store.insertTarget({
      id: target.id,
      active: 1,
      company: target.company,
      role: target.role,
      level: target.level,
      jobDescription: target.jobDescription,
      data: target as unknown as object,
      createdAt: this.ctx.iso(),
    });
    for (const req of [...target.requirements, ...target.preferredSkills]) {
      this.registerSkillNode(req.skillId);
    }
    this.ctx.logger.info("state.mutated", { entity: "target", id: target.id });
    return target;
  }
}
