import {
  AnswerEvaluationSchema,
  atsCheck,
  buildReadinessGraph,
  calculateGaps,
  CandidateProfileSchema,
  COMPANY_PROFILES,
  getCompanyProfile,
  getMode,
  guardSuggestion,
  InterviewOSStateSchema,
  LoopRoundSchema,
  matchCompanyProfile,
  nextUncoveredDimension,
  normalizeEvaluation,
  ResumeReviewSchema,
  selectWeakestBullets,
  inRound,
  taxonomy,
  TargetRoleSchema,
  transition,
  type CompanyNotesProfile,
  type RoundType,
  type AnswerEvaluation,
  type CandidateProfile,
  type Evidence,
  type ExpectedConcept,
  type Gap,
  type InterviewOSState,
  type InterviewStatus,
  type Level,
  type LoopDebrief,
  type LoopRound,
  type ModeState,
  type Question,
  type ReadinessGraph,
  type ReadinessSnapshot,
  type Requirement,
  type ResumeReview,
  type ResumeSuggestion,
  type RoundHandoff,
  type SkillDelta,
  type SkillId,
  type SystemDesignState,
  type TargetRole,
} from "@interview-os/core";
import { RuntimeError, type AIRuntime } from "@interview-os/runtime";
import { AppError, newId, type Logger } from "@interview-os/shared";
import {
  answerEvaluator,
  companyProfiler,
  interviewDebrief,
  interviewPlanner,
  interviewer,
  jdAnalyzer,
  loopDebrief,
  prepPlanner,
  registerBuiltinSkills,
  resumeAnalyzer,
  resumeCoach,
  SkillHost,
  SkillRuntimeError,
  starCoach,
  taxonomyEntries,
  type JdAnalyzerOutput,
  type PluginExecutor,
  type PluginStateSlices,
  type PrepPlannerOutput,
  type ProgressUpdate,
  type ResumeAnalyzerOutput,
  type ResumeCoachBulletsOutput,
  type SkillContext,
  type StarCoachReviewOutput,
} from "@interview-os/skills";
import type { ResumeTailoring, SkillManifest } from "@interview-os/core";
import { Store } from "./store/index.js";
import type { LoopRow, SessionRow } from "./store/index.js";

const OVERALL_SKILL_ID = "__overall__";

export interface OrchestratorDeps {
  store: Store;
  runtime: AIRuntime;
  logger: Logger;
  now?: () => Date;
}

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

export interface StartInterviewInput {
  plannedQuestions?: number;
  mode?: "interview" | "practice";
  focusSkillId?: SkillId;
  actionId?: string;
  /** §8.4 round type; practice sessions ignore it (focus skill wins). */
  roundType?: RoundType;
}

/** §9.4: one round spec when starting a loop. */
export interface LoopRoundInput {
  mode: string;
  label?: string;
  plannedQuestions?: number;
}

interface InternalStartInput extends StartInterviewInput {
  loopId?: string;
  loopRound?: number;
}

export interface SubmitAnswerInput {
  text: string;
  /** §9.1 coding rounds: optional submitted code (reviewed, not executed). */
  code?: string;
  language?: string;
}

export interface SubmitAnswerResult {
  evaluation: AnswerEvaluation;
  skillImpact: Array<{ skillId: SkillId; before: number | null; after: number | null }>;
  newActions: PrepActionRowLike[];
  nextAvailable: "question" | "complete";
}

interface PrepActionRowLike {
  id: string;
  skillId: string;
  priority: number;
  reason: string;
  action: string;
  successCriteria: string[];
  status: string;
  severity: string;
  createdAt: string;
  sourceEvidenceIds: string[];
}

const INTERVIEWER_SESSION_INSTRUCTIONS = `You are the interviewer thread for Interview OS, a mock-interview tool. Each message asks you to produce ONE interview question as JSON matching the provided schema. Never repeat earlier questions.`;

/** Streaming progress pushed to SSE/API callers during long AI operations. */
export interface ProgressOptions {
  onProgress?: (p: ProgressUpdate) => void;
}

const TASK_MODES = ["app-server", "exec"] as const;
export type TaskMode = (typeof TASK_MODES)[number];

export interface OrchestratorSettings {
  codexModel: string | null;
  reasoningEffort: "low" | "medium" | "high" | null;
  taskMode: TaskMode;
}

export class InterviewOrchestrator {
  private readonly store: Store;
  private readonly runtime: AIRuntime;
  private readonly logger: Logger;
  private readonly now: () => Date;
  /** §9.6: every skill call goes through this host. */
  readonly host: SkillHost;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: OrchestratorDeps) {
    this.store = deps.store;
    this.runtime = deps.runtime;
    this.logger = deps.logger;
    this.now = deps.now ?? (() => new Date());
    this.host = new SkillHost({ logger: deps.logger });
    registerBuiltinSkills(this.host);
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  /** Settings-backed runtime overrides, read at call time (§8.3). */
  private runtimeOptions(): SkillContext["runtimeOptions"] {
    const effort = this.store.getSetting("reasoningEffort");
    const taskMode = this.store.getSetting("taskMode");
    return {
      model: this.store.getSetting("codexModel") ?? null,
      effort: effort === "low" || effort === "medium" || effort === "high" ? effort : null,
      taskMode: taskMode === "exec" ? "exec" : "app-server",
    };
  }

  getSettings(): OrchestratorSettings {
    const opts = this.runtimeOptions();
    return {
      codexModel: opts?.model ?? null,
      reasoningEffort: opts?.effort ?? null,
      taskMode: opts?.taskMode ?? "app-server",
    };
  }

  async updateSettings(patch: Partial<OrchestratorSettings>): Promise<OrchestratorSettings> {
    return this.withLock(async () => {
      if ("codexModel" in patch) {
        const model = patch.codexModel ?? null;
        if (model !== null) {
          const models = await this.runtime.listModels();
          if (!models.some((m) => m.id === model)) {
            throw new AppError("VALIDATION", `unknown model "${model}"`);
          }
        }
        this.store.setSetting("codexModel", model);
      }
      if ("reasoningEffort" in patch) {
        const effort = patch.reasoningEffort ?? null;
        if (effort !== null) {
          const model = patch.codexModel ?? this.store.getSetting("codexModel") ?? null;
          if (model !== null) {
            const models = await this.runtime.listModels();
            const m = models.find((x) => x.id === model);
            if (m && m.supportedReasoningEfforts.length > 0 &&
                !m.supportedReasoningEfforts.includes(effort)) {
              throw new AppError(
                "VALIDATION",
                `model "${model}" does not support effort "${effort}"`,
              );
            }
          }
        }
        this.store.setSetting("reasoningEffort", effort);
      }
      if ("taskMode" in patch && patch.taskMode !== undefined) {
        if (!TASK_MODES.includes(patch.taskMode)) {
          throw new AppError("VALIDATION", `invalid taskMode "${patch.taskMode}"`);
        }
        this.store.setSetting("taskMode", patch.taskMode);
      }
      return this.getSettings();
    });
  }

  private ctx(extra?: Partial<SkillContext>): SkillContext {
    return {
      runtime: this.runtime,
      logger: this.logger,
      now: this.now,
      runtimeOptions: this.runtimeOptions(),
      ...extra,
    };
  }

  private iso(): string {
    return this.now().toISOString();
  }

  private requireActive(): { candidate: CandidateProfile; target: TargetRole } {
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

  // ---------------------------------------------------------------- pipeline

  async setupWorkspace(input: SetupWorkspaceInput, opts?: ProgressOptions) {
    return this.withLock(async () => {
      this.logger.info("workflow.started", { workflow: "setupWorkspace" });
      const onProgress = opts?.onProgress;
      try {
        // resume and JD analysis are independent — run them concurrently;
        // persistence stays sequential.
        onProgress?.({ stage: "analyzing resume" });
        onProgress?.({ stage: "analyzing job description" });
        const profileCompany = input.companyNotes?.trim()
          ? (onProgress?.({ stage: "profiling company" }),
            this.host.invoke(
              companyProfiler,
              {
                company: input.company,
                companyNotes: input.companyNotes,
                taxonomy: taxonomyEntries(),
              },
              this.ctx({ onProgress }),
            ))
          : Promise.resolve(null);
        const [candidateOut, targetOut, companyProfile] = await Promise.all([
          this.host.invoke(
            resumeAnalyzer,
            { resumeText: input.resumeText, taxonomy: taxonomyEntries() },
            this.ctx({ onProgress }),
          ),
          this.host.invoke(
            jdAnalyzer,
            {
              jobDescription: input.jobDescription,
              company: input.company,
              role: input.role,
              level: input.level,
              taxonomy: taxonomyEntries(),
            },
            this.ctx({ onProgress }),
          ),
          profileCompany,
        ]);
        const candidate = this.persistCandidate(input.resumeText, candidateOut);
        const target = this.persistTarget(input, targetOut, companyProfile);
        this.recomputeReadinessInternal("setup");
        onProgress?.({ stage: "calculating gaps" });
        const gaps = this.calculateGapsInternal();
        onProgress?.({ stage: "building prep plan" });
        const { actions } = await this.buildPreparationPlanInternal();
        this.logger.info("workflow.completed", { workflow: "setupWorkspace" });
        return { candidate, target, gaps, actions };
      } catch (err) {
        this.logger.warn("workflow.failed", {
          workflow: "setupWorkspace",
          error: (err as Error).message,
        });
        throw err;
      }
    });
  }

  async analyzeCandidate(resumeText: string): Promise<CandidateProfile> {
    return this.withLock(() => this.analyzeCandidateInternal(resumeText));
  }

  private async analyzeCandidateInternal(resumeText: string): Promise<CandidateProfile> {
    const output = await this.host.invoke(
      resumeAnalyzer,
      { resumeText, taxonomy: taxonomyEntries() },
      this.ctx(),
    );
    return this.persistCandidate(resumeText, output);
  }

  private persistCandidate(
    resumeText: string,
    output: ResumeAnalyzerOutput,
  ): CandidateProfile {
    // §9.6: the skill's outputs persist candidate profile + evidence + stories.
    this.host.assertCan("resume-analyzer", "candidate.write");
    this.host.assertCan("resume-analyzer", "evidence.write");
    this.host.assertCan("resume-analyzer", "stories.write");
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
      createdAt: this.iso(),
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
        updatedAt: this.iso(),
      });
    }
    const createdAt = this.iso();
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
    this.logger.info("state.mutated", { entity: "candidate", id: candidate.id });
    return candidate;
  }

  async analyzeTarget(input: TargetInput): Promise<TargetRole> {
    return this.withLock(() => this.analyzeTargetInternal(input));
  }

  /** §8.4: profile the company when untrusted notes were supplied. */
  private profileCompany(input: TargetInput): Promise<CompanyNotesProfile | null> {
    if (!input.companyNotes?.trim()) return Promise.resolve(null);
    return this.host.invoke(
      companyProfiler,
      {
        company: input.company,
        companyNotes: input.companyNotes,
        taxonomy: taxonomyEntries(),
      },
      this.ctx(),
    );
  }

  private async analyzeTargetInternal(input: TargetInput): Promise<TargetRole> {
    const [output, profile] = await Promise.all([
      this.host.invoke(
        jdAnalyzer,
        { ...input, taxonomy: taxonomyEntries() },
        this.ctx(),
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
  private applyRequirementBoosts(
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

  private persistTarget(
    input: TargetInput,
    output: JdAnalyzerOutput,
    companyProfile: CompanyNotesProfile | null = null,
  ): TargetRole {
    // §9.6: skill outputs persist the target row (+ its notes-derived profile).
    this.host.assertCan("jd-analyzer", "target.write");
    if (companyProfile) this.host.assertCan("company-profiler", "target.write");
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
      createdAt: this.iso(),
    });
    for (const req of [...target.requirements, ...target.preferredSkills]) {
      this.registerSkillNode(req.skillId);
    }
    this.logger.info("state.mutated", { entity: "target", id: target.id });
    return target;
  }

  private registerSkillNode(skillId: SkillId): void {
    for (const id of [skillId, ...taxonomy.ancestors(skillId)]) {
      const node = taxonomy.getNode(id);
      this.store.upsertSkillNode(id, node?.label ?? taxonomy.labelFor(id), taxonomy.parentOf(id));
    }
  }

  // ---------------------------------------------------------------- targets

  listTargets() {
    return this.store.listTargets().map((t) => {
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
    return this.withLock(async () => {
      const { candidate } = this.requireActive();
      if (!candidate.id || candidate.id === "none") {
        throw new AppError("NO_ACTIVE_PROFILE", "no active candidate");
      }
      opts?.onProgress?.({ stage: "analyzing job description" });
      const [output, profile] = await Promise.all([
        this.host.invoke(
          jdAnalyzer,
          { ...input, taxonomy: taxonomyEntries() },
          this.ctx({ onProgress: opts?.onProgress }),
        ),
        this.profileCompany(input),
      ]);
      const target = this.persistTarget(input, output, profile);
      opts?.onProgress?.({ stage: "calculating gaps" });
      opts?.onProgress?.({ stage: "building prep plan" });
      const { actions } = await this.buildPreparationPlanInternal();
      this.logger.info("workflow.completed", { workflow: "addTarget", targetId: target.id });
      return { target, actions };
    });
  }

  async activateTarget(id: string) {
    return this.withLock(async () => {
      const row = this.store.getTarget(id);
      if (!row) throw new AppError("NOT_FOUND", `no target ${id}`);
      this.store.activateTarget(id);
      this.recordUsageEvent("target.switched");
      this.logger.info("state.mutated", { entity: "target", id, active: true });
      const openActions = this.store.listActions("open", id);
      let actions: PrepActionRowLike[] = openActions.map(rowToAction);
      if (openActions.length === 0) {
        const plan = await this.buildPreparationPlanInternal();
        actions = plan.actions;
      }
      const target = TargetRoleSchema.parse(row.data);
      return { target, actions };
    });
  }

  /** §9.3: all built-in company profiles (each carries the disclaimer). */
  listCompanyProfiles() {
    return COMPANY_PROFILES;
  }

  /**
   * §9.3: change a target's company profile. Importances are recomputed from
   * the JD-analyzer `baseImportance` so boosts never compound; the notes
   * overlay (§8.4) re-applies on top. Then readiness + plan rebuild.
   */
  async updateTargetCompanyProfile(targetId: string, companyProfileId: string) {
    return this.withLock(async () => {
      const row = this.store.getTarget(targetId);
      if (!row) throw new AppError("NOT_FOUND", `no target ${targetId}`);
      if (!COMPANY_PROFILES.some((p) => p.id === companyProfileId)) {
        throw new AppError("VALIDATION", `unknown company profile "${companyProfileId}"`);
      }
      const target = TargetRoleSchema.parse(row.data);
      target.companyProfileId = companyProfileId;
      const notesFocus = new Set<string>(target.companyProfile?.focusSkillIds ?? []);
      target.requirements = target.requirements.map((r) =>
        this.applyRequirementBoosts(r, companyProfileId, notesFocus),
      );
      target.preferredSkills = target.preferredSkills.map((r) =>
        this.applyRequirementBoosts(r, companyProfileId, notesFocus),
      );
      this.store.updateTargetData(targetId, target as unknown as object);
      this.logger.info("state.mutated", {
        entity: "target",
        id: targetId,
        companyProfileId,
      });
      this.recomputeReadinessInternal("company-profile");
      const { actions } = await this.buildPreparationPlanInternal();
      return { target, actions };
    });
  }

  // ---------------------------------------------------------------- readiness

  private allRequirements(target: TargetRole): Requirement[] {
    return [...target.requirements, ...target.preferredSkills];
  }

  private evidenceForActive(candidateId: string): Evidence[] {
    return this.store
      .listEvidence(candidateId)
      .map((r) => ({
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

  private graphForActive(): ReadinessGraph {
    const { candidate, target } = this.requireActive();
    return buildReadinessGraph({
      evidence: this.evidenceForActive(candidate.id),
      requirements: this.allRequirements(target),
      taxonomy,
      now: this.now(),
    });
  }

  recomputeReadiness(reason: string): Promise<ReadinessGraph> {
    return this.withLock(async () => this.recomputeReadinessInternal(reason));
  }

  private recomputeReadinessInternal(reason: string): ReadinessGraph {
    const graph = this.graphForActive();
    const latest = this.store.latestReadinessBySkill();
    const computedAt = this.iso();
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
    this.logger.info("readiness.updated", { reason, nodesChanged: appended });
    return graph;
  }

  // ---------------------------------------------------------------- gaps + plan

  async calculateGaps(): Promise<Gap[]> {
    return this.withLock(async () => this.calculateGapsInternal());
  }

  private calculateGapsInternal(): Gap[] {
    const { target } = this.requireActive();
    const graph = this.graphForActive();
    return calculateGaps({
      requirements: this.allRequirements(target),
      readiness: graph.dimensions,
      level: target.level,
    });
  }

  async buildPreparationPlan(): Promise<PrepActionRowLike[]> {
    const { actions } = await this.withLock(() => this.buildPreparationPlanInternal());
    return actions;
  }

  private async buildPreparationPlanInternal(): Promise<{
    actions: PrepActionRowLike[];
    created: PrepActionRowLike[];
  }> {
    const { target, candidate } = this.requireActive();
    const gaps = this.calculateGapsInternal();
    const evidence = this.evidenceForActive(candidate.id);
    const openSkills = new Set(
      this.store.listActions("open", target.id).map((a) => a.skillId),
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
      const plan: PrepPlannerOutput = await this.host.invoke(
        prepPlanner,
        { targets, role: target.role, level: target.level },
        this.ctx(),
      );
      const bySkill = new Map(plan.actions.map((a) => [a.skillId, a]));
      targets.forEach((t) => {
        const action = bySkill.get(t.skillId) ?? bySkill.get(t.skillId as string);
        if (!action) return;
        created.push(
          this.insertPlannedAction(t.skillId, action, candidate.id, t.severity, target.id),
        );
      });
    }

    this.renumberActionPriorities(this.allRequirements(target), target.id);

    const actions = this.store
      .listActions(undefined, target.id)
      .filter((a) => a.status === "open" || a.status === "in_progress")
      .map(rowToAction);
    return { actions, created };
  }

  private insertPlannedAction(
    skillId: SkillId,
    action: { action: string; successCriteria: string[]; reason: string },
    candidateId: string,
    severity: "low" | "medium" | "high" = "medium",
    targetId?: string,
  ): PrepActionRowLike {
    // §9.6: planned actions persist prep-planner output.
    this.host.assertCan("prep-planner", "preparation.write");
    const existing = this.store.openActionForSkill(skillId, targetId);
    if (existing) this.store.updateActionStatus(existing.id, "superseded");
    const sourceEvidenceIds = this.store
      .evidenceForSkill(skillId, candidateId)
      .map((e) => e.id);
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
      createdAt: this.iso(),
      sourceEvidenceIds,
    };
    this.store.insertAction(row);
    this.logger.info("state.mutated", { entity: "prep_action", id: row.id, skillId });
    return rowToAction({ ...row, successCriteria: action.successCriteria, sourceEvidenceIds });
  }

  /**
   * Renumber all open/in_progress actions 1..n. Interview-evidenced actions
   * outrank generic gap actions: severityWeight × 1.5(if interview evidence)
   * × nearest requirement importance; ties by createdAt desc then skillId.
   */
  private renumberActionPriorities(requirements: Requirement[], targetId?: string): void {
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
    const interviewEvidenceIds = new Set(
      this.store
        .listEvidence()
        .filter((e) => e.type === "interview_answer")
        .map((e) => e.id),
    );
    const sevW = { high: 3, medium: 2, low: 1 } as Record<string, number>;
    const open = this.store
      .listActions(undefined, targetId)
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
    scored.forEach(({ action }, i) =>
      this.store.updateActionPriority(action.id, i + 1),
    );
  }

  // ---------------------------------------------------------------- interviews

  async startInterview(input: StartInterviewInput = {}, opts?: ProgressOptions) {
    return this.withLock(() => this.startInterviewInternal(input, opts));
  }

  private async startInterviewInternal(input: InternalStartInput, opts?: ProgressOptions) {
      const { candidate, target } = this.requireActive();
      const mode = input.mode ?? "interview";
      if (mode === "practice" && !input.focusSkillId) {
        throw new AppError("VALIDATION", "practice sessions require focusSkillId");
      }
      if (input.actionId) {
        const action = this.store.getAction(input.actionId);
        if (!action) throw new AppError("NOT_FOUND", `no prep action ${input.actionId}`);
      }
      // practice sessions are single-question verifications
      const plannedQuestions = mode === "practice" ? 1 : (input.plannedQuestions ?? 4);
      const roundType = input.roundType ?? "mixed";
      const sessionId = newId("int");
      const createdAt = this.iso();
      this.store.insertSession({
        id: sessionId,
        candidateId: candidate.id,
        targetId: target.id,
        status: "created",
        plannedQuestions,
        mode,
        roundType,
        focusSkillId: input.focusSkillId ?? null,
        actionId: input.actionId ?? null,
        modeState: getMode(roundType).initialState(),
        loopId: input.loopId ?? null,
        loopRound: input.loopRound ?? null,
        createdAt,
      });
      this.transitionSession(sessionId, "analyzing", "analyze");
      this.transitionSession(sessionId, "ready", "analysis_complete");

      // runtime session for the interviewer thread
      const rtSession = await this.runtime.createSession({
        developerInstructions: INTERVIEWER_SESSION_INSTRUCTIONS,
      });
      this.store.insertRuntimeSession({
        id: newId("rts"),
        sessionId,
        runtime: this.runtime.kind,
        runtimeSessionId: rtSession.id,
        threadId: rtSession.threadId,
        status: "open",
        createdAt: this.iso(),
      });
      this.logger.info("workflow.completed", { workflow: "startInterview", sessionId });
      return this.nextQuestionInternal(sessionId, opts);
  }

  private transitionSession(
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

  async nextQuestion(sessionId: string, opts?: ProgressOptions) {
    return this.withLock(() => this.nextQuestionInternal(sessionId, opts));
  }

  private async nextQuestionInternal(sessionId: string, opts?: ProgressOptions) {
    const session = this.store.getSession(sessionId);
    if (!session) throw new AppError("NOT_FOUND", `no session ${sessionId}`);
    const questions = this.store.listQuestions(sessionId);
    const status = session.status as InterviewStatus;

    const roundType = (session.roundType ?? "mixed") as RoundType;
    const modeState: ModeState =
      typeof session.modeState === "object" && session.modeState !== null
        ? { ...(session.modeState as ModeState) }
        : {};
    // §9.1: a decided follow-up is asked next (same skill, not counted).
    const pendingFollowUp = modeState.__pendingFollowUp as
      | { parentQuestionId: string; parentText: string; focus: string }
      | undefined;
    delete modeState.__pendingFollowUp;
    if (pendingFollowUp) this.store.updateSession(sessionId, { modeState });

    // §9.1: follow-ups don't count toward plannedQuestions — count mains only
    const mainCount = questions.filter((q) => !q.followUpOf).length;
    if (status === "ready") {
      this.transitionSession(sessionId, "question", "ask");
    } else if (status === "follow_up") {
      if (!pendingFollowUp && mainCount >= session.plannedQuestions) {
        this.transitionSession(sessionId, "complete", "complete");
        return { session: this.store.getSession(sessionId), question: null };
      }
      this.transitionSession(sessionId, "question", "next");
    } else {
      // produces InvalidTransitionError for anything else
      transition(status, "ask");
    }

    const { candidate, target } = this.requireActive();
    const graph = this.graphForActive();
    const evidence = this.evidenceForActive(candidate.id);
    const previousSession = this.store
      .listSessions()
      .find((s) => s.id !== sessionId && s.status !== "created" && s.status !== "analyzing");
    const askedPreviousSession = previousSession
      ? this.store.listQuestions(previousSession.id).map((q) => q.skillId as SkillId)
      : [];
    const allPreviousTexts = this.store
      .listSessions()
      .flatMap((s) => this.store.listQuestions(s.id).map((q) => q.text));

    // §9.4: loop sessions carry prior rounds' weak skills + observations forward
    const { priorWeakSkills, priorRoundObservations } = this.loopContextFor(session);

    let skillId: SkillId;
    let questionReason: string;
    let questionPriority: number | null;
    let questionDifficulty: "easy" | "medium" | "hard" | undefined;
    let selectionFactors: Record<string, number> | null = null;
    let followUpOf: string | null = null;
    let followUpFocus: string | null = null;

    if (pendingFollowUp) {
      const parent = this.store.getQuestion(pendingFollowUp.parentQuestionId);
      skillId = (parent?.skillId ?? "communication") as SkillId;
      questionReason = `follow-up on "${pendingFollowUp.focus}"`;
      questionPriority = null;
      questionDifficulty = (parent?.difficulty as "easy" | "medium" | "hard" | undefined) ?? "medium";
      followUpOf = pendingFollowUp.parentQuestionId;
      followUpFocus = pendingFollowUp.focus;
    } else {
      opts?.onProgress?.({ stage: "selecting skill" });
      const askCounts: Record<SkillId, number> = {};
      for (const s of this.store.listSessions()) {
        for (const q of this.store.listQuestions(s.id)) {
          const id = q.skillId as SkillId;
          askCounts[id] = (askCounts[id] ?? 0) + 1;
        }
      }
      const selection =
        session.mode === "practice" && session.focusSkillId
          ? {
              skillId: session.focusSkillId as SkillId,
              reason: `practice: verifying ${taxonomy.labelFor(session.focusSkillId as SkillId)}`,
              priority: 99,
              difficulty: "medium" as const,
              factors: null as Record<string, number> | null,
            }
          : await this.host.invoke(
              interviewPlanner,
              {
                requirements: this.allRequirements(target),
                readiness: graph.dimensions,
                evidence,
                askedThisSession: questions.map((q) => q.skillId as SkillId),
                askedPreviousSession,
                questionIndex: mainCount,
                roundType,
                mode: roundType,
                level: target.level,
                askCounts,
                loopWeakSkills: priorWeakSkills,
              },
              this.ctx({ sessionId }),
            );
      if (!selection) {
        this.transitionSession(sessionId, "complete", "complete");
        return { session: this.store.getSession(sessionId), question: null };
      }
      skillId = selection.skillId;
      questionReason = selection.reason;
      questionPriority = selection.priority;
      questionDifficulty = selection.difficulty;
      selectionFactors = selection.factors as unknown as Record<string, number>;
    }

    // §8.4: behavioral/hr (+§9.1 hiring manager) get company themes + story titles
    const narrativeRound =
      roundType === "behavioral" || roundType === "hr" || roundType === "hiring_manager";
    const interviewerInput = {
      skillId,
      label: taxonomy.labelFor(skillId),
      role: target.role,
      level: target.level,
      company: target.company,
      reason: questionReason,
      previousQuestions: [...allPreviousTexts],
      candidateSummary: `${candidate.name ?? "candidate"} — ${candidate.headline ?? ""}`.trim(),
      roundType,
      mode: roundType,
      modeState,
      followUp: pendingFollowUp
        ? { parentQuestion: pendingFollowUp.parentText, focus: pendingFollowUp.focus }
        : null,
      companyGuidance: this.companyGuidanceFor(target, roundType),
      difficulty: questionDifficulty,
      focusDimension:
        roundType === "system_design"
          ? pendingFollowUp
            ? null
            : (nextUncoveredDimension(modeState as SystemDesignState) ?? null)
          : null,
      companyThemes: narrativeRound ? (target.companyProfile?.behavioralThemes ?? []) : [],
      storyTitles: narrativeRound
        ? this.store.listStories(candidate.id).map((s) => s.title).slice(0, 10)
        : [],
      priorRoundObservations,
    };

    const runtimeSessionId = await this.ensureRuntimeSession(sessionId);
    const interviewCtx = this.ctx({
      sessionId,
      runtimeSessionId,
      onProgress: opts?.onProgress,
    });
    opts?.onProgress?.({ stage: "writing question" });
    let produced;
    try {
      produced = await this.host.invoke(interviewer, interviewerInput, interviewCtx);
    } catch (err) {
      // in-memory runtime session gone (server restart): resume by thread and retry once
      if (
        (err instanceof RuntimeError || err instanceof SkillRuntimeError) &&
        /unknown (mock )?session/.test(err.message)
      ) {
        const rid = await this.resumeRuntimeSession(sessionId);
        produced = await this.host.invoke(
          interviewer,
          interviewerInput,
          this.ctx({ sessionId, runtimeSessionId: rid }),
        );
      } else {
        throw err;
      }
    }

    // §9.6: the interviewer skill writes question rows.
    this.host.assertCan("interviewer", "interview.write");
    const questionId = newId("q");
    const extra: Record<string, unknown> = {};
    if (produced.problem !== null && produced.problem !== undefined)
      extra.problem = produced.problem;
    if (produced.focusDimension) extra.focusDimension = produced.focusDimension;
    this.store.insertQuestion({
      id: questionId,
      sessionId,
      skillId: produced.skillId,
      topic: produced.topic,
      text: produced.question,
      subSkills: produced.subSkills,
      expectedConcepts: produced.expectedConcepts,
      difficulty: produced.difficulty,
      selectionPriority: questionPriority,
      selectionReason: questionReason,
      selectionFactors: selectionFactors ?? {},
      followUpOf,
      followUpFocus,
      extra,
      position: questions.length + 1,
      createdAt: this.iso(),
    });
    this.store.updateSession(sessionId, { currentRound: questions.length + 1 });
    const row = this.store.getQuestion(questionId)!;
    return { session: this.store.getSession(sessionId), question: rowToQuestion(row) };
  }

  /** §9.3: rendered profile guidance fed to interviewer/evaluator prompts. */
  private companyGuidanceFor(target: TargetRole, roundType: RoundType): string {
    const profile = getCompanyProfile(target.companyProfileId ?? "generic");
    const lines = [
      `Interview profile: ${profile.name} (${profile.id}). Typical loop: ${profile.typicalLoop
        .map((l) => l.label)
        .join(" → ")}.`,
      `Behavioral framework: ${profile.behavioralFramework.name} — ${profile.behavioralFramework.guidance}`,
      `Follow-up depth: ${profile.followUpDepth}. ${profile.disclaimer}`,
    ];
    const expectations = profile.roleExpectations[target.level];
    if (expectations?.length) {
      lines.push(`Level expectations (${target.level}): ${expectations.join("; ")}.`);
    }
    if (roundType !== "mixed") {
      const loopStage = profile.typicalLoop.find((l) => l.mode === roundType);
      if (loopStage) lines.push(`This round plays the "${loopStage.label}" part of the loop.`);
    }
    return lines.join("\n");
  }

  private async ensureRuntimeSession(sessionId: string): Promise<string | undefined> {
    const row = this.store.getRuntimeSession(sessionId);
    if (!row) return undefined;
    return row.runtimeSessionId;
  }

  private async resumeRuntimeSession(sessionId: string): Promise<string> {
    const row = this.store.getRuntimeSession(sessionId);
    if (!row) throw new AppError("NOT_FOUND", `no runtime session for ${sessionId}`);
    const rtSession = await this.runtime.resumeSession(row.threadId, {
      developerInstructions: INTERVIEWER_SESSION_INSTRUCTIONS,
    });
    this.store.updateRuntimeSessionStatus(row.id, "resumed");
    this.store.insertRuntimeSession({
      id: newId("rts"),
      sessionId,
      runtime: this.runtime.kind,
      runtimeSessionId: rtSession.id,
      threadId: rtSession.threadId,
      status: "open",
      createdAt: this.iso(),
    });
    return rtSession.id;
  }

  async submitAnswer(
    sessionId: string,
    answer: string | SubmitAnswerInput,
    opts?: ProgressOptions,
  ): Promise<SubmitAnswerResult> {
    const { text: answerText, code = null, language = null } =
      typeof answer === "string" ? { text: answer } : answer;
    return this.withLock(async () => {
      const session = this.store.getSession(sessionId);
      if (!session) throw new AppError("NOT_FOUND", `no session ${sessionId}`);
      const questions = this.store.listQuestions(sessionId);
      const active = [...questions]
        .reverse()
        .find((q) => !this.store.getEvaluatedAnswerForQuestion(q.id));
      if (!active) {
        throw new AppError("NOT_FOUND", "no unanswered question in session");
      }
      const before = this.graphForActive();
      this.transitionSession(sessionId, "answer", "answer");
      const answerId = newId("ans");
      this.store.insertAnswer({
        id: answerId,
        questionId: active.id,
        sessionId,
        text: answerText,
        code,
        language,
        createdAt: this.iso(),
      });
      this.transitionSession(sessionId, "evaluating", "evaluate");

      const roundType = (session.roundType ?? "mixed") as RoundType;
      const modeDef = getMode(roundType);
      const preModeState: ModeState =
        typeof session.modeState === "object" && session.modeState !== null
          ? { ...(session.modeState as ModeState) }
          : {};

      const { candidate, target } = this.requireActive();
      let evaluation: AnswerEvaluation;
      let skillImpact: SubmitAnswerResult["skillImpact"];
      let followUpPending = false;
      const newActions: PrepActionRowLike[] = [];
      opts?.onProgress?.({ stage: "evaluating answer" });
      try {
        evaluation = await this.host.invoke(
          answerEvaluator,
          {
            question: {
              text: active.text,
              topic: active.topic,
              skillId: active.skillId,
              expectedConcepts: active.expectedConcepts as ExpectedConcept[],
              difficulty: active.difficulty as "easy" | "medium" | "hard",
            },
            answer: answerText,
            code,
            language,
            role: target.role,
            level: target.level,
            roundType,
            mode: roundType,
            modeState: preModeState,
          },
          this.ctx({ sessionId, onProgress: opts?.onProgress }),
        );
        // defensive: merge duplicate per-skill entries before persisting
        evaluation = normalizeEvaluation(AnswerEvaluationSchema.parse(evaluation));
        // §9.6: the evaluator's outputs persist evaluation + evidence rows.
        this.host.assertCan("answer-evaluator", "interview.write");
        this.host.assertCan("answer-evaluator", "evidence.write");
        const evalId = newId("eval");
        this.store.insertEvaluation({
          id: evalId,
          answerId,
          questionId: active.id,
          sessionId,
          data: evaluation as unknown as object,
          createdAt: this.iso(),
        });
        this.logger.info("evaluation.recorded", {
          sessionId,
          questionId: active.id,
          skillId: active.skillId,
        });

        const evidenceType = session.mode === "practice" ? "practice" : "interview_answer";
        const createdEvidenceIds: string[] = [];
        const evidenceCreatedAt = this.iso();
        for (const s of evaluation.scores) {
          const skillId = s.skill;
          const match =
            evaluation.weaknesses.find((w) => w.skill === skillId)?.evidence ??
            evaluation.strengths.find((st) => st.skill === skillId)?.evidence ??
            evaluation.summary;
          const evidenceId = newId("ev");
          this.store.insertEvidence({
            id: evidenceId,
            candidateId: candidate.id,
            skillId,
            type: evidenceType,
            score: s.score,
            confidence: s.confidence,
            observation: match,
            sessionId,
            questionId: active.id,
            createdAt: evidenceCreatedAt,
          });
          createdEvidenceIds.push(evidenceId);
          this.registerSkillNode(skillId);
        }

        opts?.onProgress?.({ stage: "updating readiness" });
        const after = this.recomputeReadinessInternal("answer");
        skillImpact = [...new Map(
          evaluation.scores.map((s) => [
            s.skill,
            {
              skillId: s.skill,
              before: before.dimensions[s.skill]?.score ?? null,
              after: after.dimensions[s.skill]?.score ?? null,
            },
          ]),
        ).values()];
        // §9.7: the skillImpact list is persisted on the evaluation as its
        // readiness delta for the History view.
        this.store.updateEvaluationDelta(
          evalId,
          skillImpact.map((i) => ({ skillId: i.skillId, before: i.before, after: i.after })),
        );

        // plan update for medium+ weaknesses, one target per skill
        const weakTargets = [...new Map(
          evaluation.weaknesses
            .filter((w) => w.severity !== "low")
            .map((w) => [w.skill, w]),
        ).values()];
        if (weakTargets.length > 0) {
          opts?.onProgress?.({ stage: "updating prep plan" });
          const concepts = active.expectedConcepts as ExpectedConcept[];
          const plan = await this.host.invoke(
            prepPlanner,
            {
              targets: weakTargets.map((w) => ({
                skillId: w.skill,
                label: taxonomy.labelFor(w.skill),
                reason: `weak answer: ${w.evidence}`,
                // only the missed concepts the question mapped to this skill
                missingConcepts: concepts
                  .filter((c) => c.skillId === w.skill)
                  .map((c) => c.concept)
                  .filter((c) => evaluation.missingConcepts.includes(c)),
                severity: w.severity,
              })),
              role: target.role,
              level: target.level,
            },
            this.ctx({ sessionId }),
          );
          plan.actions.forEach((a) => {
            const skillId = a.skillId as SkillId;
            const severity = weakTargets.find((w) => w.skill === skillId)?.severity;
            newActions.push(
              this.insertPlannedAction(
                skillId,
                a,
                candidate.id,
                severity ?? "medium",
                target.id,
              ),
            );
          });
          this.renumberActionPriorities(this.allRequirements(target), target.id);
        }

        // practice session linked to a prep action: a demonstrated focus-skill
        // score ≥ 0.7 closes the action; otherwise attach the new evidence ids
        if (session.actionId) {
          const focusSkillId = session.focusSkillId;
          const demonstrated = focusSkillId
            ? evaluation.scores.find((s) => s.skill === focusSkillId)?.score
            : undefined;
          if (demonstrated !== undefined && demonstrated >= 0.7) {
            this.store.updateActionStatus(session.actionId, "done");
          } else {
            const action = this.store.getAction(session.actionId);
            if (action) {
              const existing = (action.sourceEvidenceIds ?? []) as string[];
              this.store.updateActionSourceEvidence(session.actionId, [
                ...existing,
                ...createdEvidenceIds,
              ]);
            }
          }
        }

        // §9.1: reduce mode state, then decide whether to dig deeper.
        let modeState = modeDef.reduce(preModeState, evaluation, {
          skillId: active.skillId as SkillId,
          topic: active.topic,
          extra:
            typeof active.extra === "object" && active.extra !== null
              ? (active.extra as Record<string, unknown>)
              : {},
        });
        if (session.mode !== "practice" && roundType !== "mixed") {
          const mainId = active.followUpOf ?? active.id;
          const chainDepth = questions.filter((q) => q.followUpOf === mainId).length;
          const maxDepth = getCompanyProfile(
            target.companyProfileId ?? "generic",
          ).followUpDepth;
          const decision = modeDef.followUp(evaluation, modeState, chainDepth, maxDepth);
          if (decision.ask) {
            followUpPending = true;
            modeState = {
              ...modeState,
              __pendingFollowUp: {
                parentQuestionId: mainId,
                parentText: active.text,
                focus: decision.focus ?? "the weakest dimension",
              },
            };
            this.logger.info("interview.follow_up", {
              sessionId,
              questionId: mainId,
              depth: chainDepth + 1,
            });
          }
        }
        this.store.updateSession(sessionId, { modeState });
      } catch (err) {
        // keep the session usable: mark the stored answer failed and roll the
        // session back to QUESTION so the answer can be resubmitted.
        this.store.updateAnswerStatus(answerId, "failed");
        this.transitionSession(sessionId, "question", "evaluation_failed");
        this.logger.warn("evaluation.failed", {
          sessionId,
          questionId: active.id,
          error: (err as Error).message,
        });
        throw err;
      }

      this.transitionSession(sessionId, "follow_up", "follow_up");
      const mainCount = questions.filter((q) => !q.followUpOf).length;
      const remaining = followUpPending || mainCount < session.plannedQuestions;
      return {
        evaluation,
        skillImpact,
        newActions,
        nextAvailable: remaining ? "question" : "complete",
      };
    });
  }

  async completeInterview(sessionId: string, opts?: ProgressOptions) {
    return this.withLock(async () => {
      const session = this.store.getSession(sessionId);
      if (!session) throw new AppError("NOT_FOUND", `no session ${sessionId}`);
      const status = session.status as InterviewStatus;
      if (status === "follow_up" || status === "question") {
        this.transitionSession(sessionId, "complete", "complete");
        this.store.updateSession(sessionId, { completedAt: this.iso() });
      }
      const debrief = await this.createDebriefInternal(sessionId, opts);
      // §9.4: completing a loop session writes its handoff and either opens
      // the next round's session or finishes the loop with a loop debrief.
      let loop = null;
      let nextSession = null;
      let nextQuestion = null;
      if (session.loopId) {
        const adv = await this.advanceLoopInternal(sessionId, opts);
        loop = adv.loop;
        nextSession = adv.nextSession ?? null;
        nextQuestion = adv.nextQuestion ?? null;
      }
      return {
        session: this.store.getSession(sessionId),
        debrief,
        loop,
        nextSession,
        nextQuestion,
      };
    });
  }

  async createDebrief(sessionId: string, opts?: ProgressOptions) {
    return this.withLock(() => this.createDebriefInternal(sessionId, opts));
  }

  private async createDebriefInternal(sessionId: string, opts?: ProgressOptions) {
    const session = this.store.getSession(sessionId);
    if (!session) throw new AppError("NOT_FOUND", `no session ${sessionId}`);
    const existing = this.store.getDebrief(sessionId);
    const status = session.status as InterviewStatus;
    if (status === "complete") {
      this.transitionSession(sessionId, "debrief", "debrief");
    } else if (status !== "debrief") {
      transition(status, "debrief"); // throws
    }

    const { target } = this.requireActive();
    const questions = this.store.listQuestions(sessionId);
    const evaluations = this.store
      .listEvaluations(sessionId)
      .map((r) => r.data as unknown as AnswerEvaluation);
    const latest = this.store.latestReadinessBySkill();
    const afterMap: Record<string, number | null> = {};
    const beforeMap: Record<string, number | null> = {};
    for (const [skillId, row] of latest) {
      if (skillId === OVERALL_SKILL_ID) continue;
      afterMap[skillId] = row.score;
    }
    // readiness "before" = latest snapshot at or before session creation
    for (const skillId of Object.keys(afterMap)) {
      const history = this.store.readinessHistory(skillId);
      const beforeRow = history.find((r) => r.computedAt <= session.createdAt);
      beforeMap[skillId] = beforeRow ? beforeRow.score : null;
    }

    let output;
    if (existing) {
      output = existing.data;
    } else {
      opts?.onProgress?.({ stage: "writing debrief" });
      output = await this.host.invoke(
        interviewDebrief,
        {
          role: target.role,
          questions: questions.map((q) => ({
            text: q.text,
            skillId: q.skillId,
            topic: q.topic,
          })),
          evaluations: evaluations as unknown[],
          readinessBefore: beforeMap,
          readinessAfter: afterMap,
          openActions: this.store
            .listActions("open")
            .map((a) => ({ skillId: a.skillId, action: a.action })),
        },
        this.ctx({ sessionId, onProgress: opts?.onProgress }),
      );
      this.host.assertCan("interview-debrief", "interview.write");
      this.store.insertDebrief({
        id: newId("debrief"),
        sessionId,
        data: output as object,
        createdAt: this.iso(),
      });
    }
    return output;
  }

  // --------------------------------------------------------- §9.4 loops

  /**
   * Start a full interview loop. `rounds` defaults to the active target's
   * company-profile `typicalLoop`; custom rounds are validated (2–7 rounds,
   * mode ∈ ModeId, plannedQuestions 1–6). Round 1's session is created and
   * its first question generated.
   */
  async startLoop(input: { rounds?: LoopRoundInput[] } = {}, opts?: ProgressOptions) {
    return this.withLock(async () => {
      const { target } = this.requireActive();
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
      this.store.insertLoop({
        id: loopId,
        targetId: target.id,
        companyProfileId: profile.id,
        rounds,
        status: "in_progress",
        currentRound: 1,
        createdAt: this.iso(),
      });
      this.logger.info("state.mutated", { entity: "loop", id: loopId, rounds: rounds.length });
      const first = await this.openLoopRound(loopId, 0, opts);
      return { loop: this.viewLoop(loopId), session: first.session, question: first.question };
    });
  }

  /** Create the session for loop round `idx` and generate its first question. */
  private async openLoopRound(loopId: string, idx: number, opts?: ProgressOptions) {
    const loop = this.store.getLoop(loopId);
    if (!loop) throw new AppError("NOT_FOUND", `no loop ${loopId}`);
    const rounds = [...(loop.rounds as LoopRound[])];
    const round = rounds[idx];
    if (!round) throw new AppError("INTERNAL", `loop ${loopId} has no round ${idx + 1}`);
    round.status = "in_progress";
    round.readinessBefore = this.readinessSnapshot();
    const created = await this.startInterviewInternal(
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
    this.store.updateLoop(loopId, { rounds, currentRound: idx + 1, status: "in_progress" });
    return created;
  }

  /** Overall + per-requirement readiness snapshot at a round boundary. */
  private readinessSnapshot(): ReadinessSnapshot {
    const { target } = this.requireActive();
    const graph = this.graphForActive();
    const requirements: Record<string, number | null> = {};
    for (const req of this.allRequirements(target)) {
      requirements[req.skillId] = graph.dimensions[req.skillId]?.score ?? null;
    }
    return { overall: graph.overall, requirements };
  }

  /** Prior rounds' weak skills (for the engine) + observations (for prompts). */
  private loopContextFor(session: SessionRow): {
    priorWeakSkills: { skillId: SkillId; round: number; mode: RoundType }[];
    priorRoundObservations: string[];
  } {
    const empty = { priorWeakSkills: [], priorRoundObservations: [] };
    if (!session.loopId || !session.loopRound) return empty;
    const loop = this.store.getLoop(session.loopId);
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
  private async advanceLoopInternal(sessionId: string, opts?: ProgressOptions) {
    const session = this.store.getSession(sessionId);
    const loop = session?.loopId ? this.store.getLoop(session.loopId) : undefined;
    if (!session || !loop) return { loop: null, nextSession: null, nextQuestion: null };
    const rounds = [...(loop.rounds as LoopRound[])];
    const idx = (session.loopRound ?? 1) - 1;
    const round = rounds[idx];
    if (!round || round.status === "complete") {
      return { loop: this.viewLoopRow(loop), nextSession: null, nextQuestion: null };
    }
    const evaluationRows = this.store.listEvaluations(sessionId);
    const evaluations = evaluationRows.map(
      (r) => r.data as unknown as AnswerEvaluation,
    );
    round.handoff = this.computeHandoff(evaluations);
    round.skillDeltas = this.computeSkillDeltas(evaluationRows);
    round.readinessAfter = this.readinessSnapshot();
    round.status = "complete";
    this.store.updateLoop(loop.id, { rounds });

    if (idx + 1 < rounds.length) {
      const next = await this.openLoopRound(loop.id, idx + 1, opts);
      return {
        loop: this.viewLoop(loop.id),
        nextSession: next.session,
        nextQuestion: next.question,
      };
    }

    opts?.onProgress?.({ stage: "writing loop debrief" });
    const debrief = await this.createLoopDebrief(rounds, opts);
    this.host.assertCan("loop-debrief", "interview.write");
    this.store.updateLoop(loop.id, {
      rounds,
      status: "complete",
      completedAt: this.iso(),
      debrief: debrief as unknown as object,
    });
    return { loop: this.viewLoop(loop.id), nextSession: null, nextQuestion: null };
  }

  /** The loop-debrief skill call (§9.4) — never produces a hire/no-hire verdict. */
  private async createLoopDebrief(
    rounds: LoopRound[],
    opts?: ProgressOptions,
  ): Promise<LoopDebrief> {
    const { target } = this.requireActive();
    return this.host.invoke(
      loopDebrief,
      {
        role: target.role,
        company: target.company,
        rounds: rounds.map((r) => {
          const evals = r.sessionId
            ? this.store
                .listEvaluations(r.sessionId)
                .map((e) => e.data as unknown as AnswerEvaluation)
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
          return {
            mode: r.mode,
            label: r.label,
            summaries: evals.map((e) => e.summary),
            rubricAverages: Object.fromEntries(
              [...acc].map(([k, v]) => [k, v.sum / v.n]),
            ),
            handoff: r.handoff,
          };
        }),
        readinessChange: {
          before: rounds[0]?.readinessBefore?.overall ?? null,
          after: rounds[rounds.length - 1]?.readinessAfter?.overall ?? null,
        },
      },
      this.ctx({ onProgress: opts?.onProgress }),
    );
  }

  private viewLoop(id: string) {
    const loop = this.store.getLoop(id);
    return loop ? this.viewLoopRow(loop) : null;
  }

  private viewLoopRow(loop: LoopRow) {
    return {
      ...loop,
      rounds: loop.rounds as LoopRound[],
      abandoned: loop.abandoned === 1,
      debrief: (loop.debrief as LoopDebrief | null) ?? null,
    };
  }

  getLoop(id: string) {
    const loop = this.viewLoop(id);
    if (!loop) throw new AppError("NOT_FOUND", `no loop ${id}`);
    return loop;
  }

  listLoops() {
    return this.store.listLoops().map((l) => this.viewLoopRow(l));
  }

  /** Abandon an in-progress loop: current session completed, loop closed. */
  async abandonLoop(id: string) {
    return this.withLock(async () => {
      const loop = this.store.getLoop(id);
      if (!loop) throw new AppError("NOT_FOUND", `no loop ${id}`);
      if (loop.status === "complete") return this.viewLoopRow(loop);
      const rounds = [...(loop.rounds as LoopRound[])];
      const current = rounds[loop.currentRound - 1];
      if (current?.sessionId) {
        const s = this.store.getSession(current.sessionId);
        if (s?.status === "ready") this.transitionSession(s.id, "question", "ask");
        const s2 = this.store.getSession(current.sessionId);
        if (s2 && (s2.status === "question" || s2.status === "follow_up")) {
          this.transitionSession(s2.id, "complete", "complete");
          this.store.updateSession(s2.id, { completedAt: this.iso() });
        }
      }
      this.store.updateLoop(id, {
        rounds,
        status: "complete",
        abandoned: 1,
        completedAt: this.iso(),
      });
      this.logger.info("state.mutated", { entity: "loop", id, abandoned: true });
      return this.viewLoop(id);
    });
  }

  // ---------------------------------------------------------------- queries

  async getState(): Promise<InterviewOSState> {
    const candidateRow = this.store.getActiveCandidate();
    const targetRow = this.store.getActiveTarget();
    const candidate: CandidateProfile = candidateRow
      ? CandidateProfileSchema.parse(candidateRow.data)
      : CandidateProfileSchema.parse({ id: "none" });
    const target: TargetRole = targetRow
      ? TargetRoleSchema.parse(targetRow.data)
      : TargetRoleSchema.parse({
          id: "none",
          company: "",
          role: "",
          level: "mid",
          jobDescription: "",
        });

    const evidence = candidateRow ? this.evidenceForActive(candidate.id) : [];
    const requirements = targetRow ? this.allRequirements(target) : [];
    const graph =
      evidence.length || requirements.length
        ? buildReadinessGraph({ evidence, requirements, taxonomy })
        : { dimensions: {}, overall: 0, overallConfidence: 0, lastUpdated: this.iso() };
    const latest = this.store.latestReadinessBySkill();
    const lastUpdated =
      [...latest.values()].sort((a, b) => b.computedAt.localeCompare(a.computedAt))[0]
        ?.computedAt ?? graph.lastUpdated;

    const gaps =
      requirements.length > 0
        ? calculateGaps({
            requirements,
            readiness: graph.dimensions,
            level: target.level,
          })
        : [];

    const openActions = this.store.listActions("open", target.id).map(rowToAction);
    const inProgress = this.store.listActions("in_progress", target.id).map(rowToAction);
    const doneActions = this.store.listActions("done");

    const sessions = this.store.listSessions();
    const activeSession = sessions[0];
    const sessionQuestions = activeSession
      ? this.store.listQuestions(activeSession.id).map(rowToQuestion)
      : [];
    const sessionAnswers = activeSession
      ? this.store
          .listAnswers(activeSession.id)
          .map((a) => ({ id: a.id, questionId: a.questionId, sessionId: a.sessionId, text: a.text, createdAt: a.createdAt }))
      : [];
    const answeredIds = new Set(
      this.store
        .listAnswers(activeSession?.id ?? "")
        .filter((a) => a.status !== "failed")
        .map((a) => a.questionId),
    );
    const activeQuestion =
      activeSession && activeSession.status === "question"
        ? [...sessionQuestions].reverse().find((q) => !answeredIds.has(q.id))
        : undefined;

    const weakEvid = evidence.filter((e) => e.type === "interview_answer" && e.score < 0.5);
    const strongEvid = evidence.filter((e) => e.type === "interview_answer" && e.score >= 0.75);
    const sessionEvaluations = activeSession
      ? this.store.listEvaluations(activeSession.id)
      : [];

    const state = {
      candidate,
      target,
      assessment: {
        strengths: strongEvid.map((e) => ({
          skillId: e.skillId,
          note: e.observation,
          evidenceIds: [e.id],
        })),
        gaps,
        weakAnswers: weakEvid.map((e) => ({
          skillId: e.skillId,
          note: e.observation,
          evidenceIds: [e.id],
        })),
        strongAnswers: strongEvid.map((e) => ({
          skillId: e.skillId,
          note: e.observation,
          evidenceIds: [e.id],
        })),
        observations: sessionEvaluations.map(
          (r) => (r.data as { summary?: string }).summary ?? "",
        ),
        skillAssessments: graph.dimensions,
      },
      preparation: {
        priorities: openActions.map((a) => a.skillId as SkillId),
        completedTopics: doneActions.map((a) => a.skillId),
        nextActions: [...openActions, ...inProgress],
        practiceHistory: [],
      },
      interview: {
        sessionId: activeSession?.id,
        currentRound: activeSession?.currentRound ?? 0,
        previousQuestions: sessionQuestions,
        previousAnswers: sessionAnswers,
        interviewerObservations: [],
        activeQuestion,
      },
      readiness: {
        overall: graph.overall,
        overallConfidence: graph.overallConfidence,
        dimensions: graph.dimensions,
        lastUpdated,
      },
    };
    return InterviewOSStateSchema.parse(state);
  }

  async getSkillDetail(skillId: string) {
    const graph = this.graphForActive();
    const candidate = this.store.getActiveCandidate()!;
    const target = this.store.getActiveTarget();
    const evidence = this.store.evidenceForSkill(skillId, candidate.id);
    const history = this.store.readinessHistory(skillId);
    const actions = this.store.actionsForSkill(skillId, target?.id).map(rowToAction);
    const openAction = this.store.openActionForSkill(skillId, target?.id);
    return {
      skillId,
      readiness: graph.dimensions[skillId] ?? null,
      evidence,
      history,
      actions,
      recommendedAction: openAction ? rowToAction(openAction) : null,
    };
  }

  listInterviews() {
    return this.store.listSessions().map((s) => {
      const target = s.targetId ? this.store.getTarget(s.targetId) : undefined;
      return {
        ...s,
        target: target ? { id: target.id, role: target.role, company: target.company } : null,
        questions: this.store.listQuestions(s.id).length,
        debrief: this.store.getDebrief(s.id)?.data ?? null,
      };
    });
  }

  getInterview(id: string) {
    const session = this.store.getSession(id);
    if (!session) throw new AppError("NOT_FOUND", `no session ${id}`);
    const target = session.targetId ? this.store.getTarget(session.targetId) : undefined;
    const targetData = target?.data ? TargetRoleSchema.safeParse(target.data) : null;
    const companyProfile = getCompanyProfile(
      targetData?.success ? (targetData.data.companyProfileId ?? "generic") : "generic",
    );
    return {
      session: { ...session, modeLabel: getMode(session.roundType as RoundType).label },
      questions: this.store.listQuestions(id).map(rowToQuestion),
      answers: this.store.listAnswers(id),
      evaluations: this.store.listEvaluations(id).map((r) => r.data),
      debrief: this.store.getDebrief(id)?.data ?? null,
      companyProfile: { id: companyProfile.id, name: companyProfile.name, disclaimer: companyProfile.disclaimer },
    };
  }

  // ------------------------------------------------- §9.7 history / metrics

  /**
   * §9.7: event names the API accepts. Events carry a name + timestamp only —
   * never content (resumes, answers, notes).
   */
  static readonly USAGE_EVENTS = [
    "history.viewed",
    "target.switched",
    "resume.coach.used",
    "palette.used",
  ] as const;

  recordUsageEvent(event: string) {
    if (!InterviewOrchestrator.USAGE_EVENTS.includes(event as never)) {
      throw new AppError("VALIDATION", `unknown usage event "${event}"`);
    }
    this.store.insertUsageEvent({ id: newId("evt"), event, createdAt: this.iso() });
  }

  /**
   * §9.7: session list for the History view. `weakOnly` keeps sessions that
   * contain at least one answer whose mean rubric (or primary score) < 0.5.
   */
  getHistory(filters: {
    mode?: string;
    targetId?: string;
    loopId?: string;
    weakOnly?: boolean;
  } = {}) {
    return this.store
      .listSessions()
      .filter((s) => !filters.mode || s.roundType === filters.mode)
      .filter((s) => !filters.targetId || s.targetId === filters.targetId)
      .filter((s) => !filters.loopId || s.loopId === filters.loopId)
      .map((s) => this.sessionHistoryEntry(s))
      .filter((e) => !filters.weakOnly || e.hasWeakAnswer);
  }

  getSessionHistory(id: string) {
    const s = this.store.getSession(id);
    if (!s) throw new AppError("NOT_FOUND", `no session ${id}`);
    return this.sessionHistoryEntry(s);
  }

  /** Mean of rubric scores when present, else mean of per-skill scores. */
  private answerMeanScore(ev: AnswerEvaluation): number {
    const vals =
      ev.rubric.length > 0
        ? ev.rubric.map((d) => d.score)
        : ev.scores.map((s) => s.score);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  }

  private sessionHistoryEntry(s: SessionRow) {
    const target = s.targetId ? this.store.getTarget(s.targetId) : undefined;
    const targetData = target?.data ? TargetRoleSchema.safeParse(target.data) : null;
    const loop = s.loopId ? this.store.getLoop(s.loopId) : undefined;
    const loopRounds = loop ? (loop.rounds as LoopRound[]) : [];
    const questions = this.store.listQuestions(s.id).map(rowToQuestion);
    const answers = this.store.listAnswers(s.id);
    const evals = this.store.listEvaluations(s.id);
    const sessionEvidenceIds = new Set(
      this.store
        .listEvidence(s.candidateId ?? undefined)
        .filter((e) => e.sessionId === s.id)
        .map((e) => e.id),
    );
    const actionsCreated = this.store
      .listActions()
      .filter((a) =>
        ((a.sourceEvidenceIds as string[]) ?? []).some((id) =>
          sessionEvidenceIds.has(id),
        ),
      )
      .map(rowToAction);

    const node = (q: Question) => {
      const answer =
        answers.find((a) => a.questionId === q.id && a.status === "evaluated") ??
        answers.find((a) => a.questionId === q.id) ??
        null;
      const evRow = evals.find((e) => e.questionId === q.id) ?? null;
      const ev = (evRow?.data ?? null) as AnswerEvaluation | null;
      const mean = ev ? this.answerMeanScore(ev) : null;
      return {
        question: q,
        answer: answer
          ? {
              id: answer.id,
              text: answer.text,
              code: answer.code,
              language: answer.language,
              createdAt: answer.createdAt,
            }
          : null,
        evaluation: ev,
        readinessDelta: (evRow?.readinessDelta as unknown[]) ?? [],
        weak: mean !== null && mean < 0.5,
      };
    };
    const mains = questions
      .filter((q) => !q.followUpOf)
      .map((q) => ({
        ...node(q),
        followUps: questions.filter((f) => f.followUpOf === q.id).map(node),
      }));
    const hasWeakAnswer = mains.some(
      (m) => m.weak || m.followUps.some((f) => f.weak),
    );
    return {
      session: {
        ...s,
        modeLabel: getMode(s.roundType as RoundType).label,
      },
      target: target
        ? {
            id: target.id,
            role: target.role,
            company: target.company,
            companyProfileId: targetData?.success
              ? (targetData.data.companyProfileId ?? "generic")
              : "generic",
          }
        : null,
      loop: loop
        ? {
            id: loop.id,
            round: s.loopRound,
            totalRounds: loopRounds.length,
            label: loopRounds[(s.loopRound ?? 1) - 1]?.label ?? null,
          }
        : null,
      questions: mains,
      actionsCreated,
      debrief: this.store.getDebrief(s.id)?.data ?? null,
      hasWeakAnswer,
    };
  }

  /**
   * §9.7 metrics. Definitions:
   * - loopsStarted / loopsCompleted: loops created / status 'complete' and not
   *   abandoned.
   * - sessionsPerMode: interview sessions grouped by roundType.
   * - weaknessRetestRate: a weak skill is one with interview evidence < 0.5;
   *   it is "retested" when a later question (later createdAt) targets the
   *   same skill or a `relatedTo` skill. rate = retested / weak skills
   *   (null when there are no weak skills yet).
   * - improvementAfterPrep: for each done action, first non-self_report
   *   evidence score for its skill after the action was created minus the
   *   latest score at/before creation; the metric is the mean delta
   *   (null when no action has both sides).
   * - prepCompletionRate: done ÷ non-superseded actions.
   * - readinessCoverage: requirements whose latest readiness snapshot has
   *   confidence ≥ 0.4 ÷ total requirements of the active target.
   * - usage counters: counts of the allowed usage events by name.
   */
  getMetrics() {
    const sessions = this.store.listSessions();
    const loops = this.store.listLoops();
    const actions = this.store.listActions();
    const evidence = this.store.listEvidence();
    const allQuestions = sessions.flatMap((s) => this.store.listQuestions(s.id));

    const sessionsPerMode: Record<string, number> = {};
    for (const s of sessions) {
      const m = s.roundType ?? "mixed";
      sessionsPerMode[m] = (sessionsPerMode[m] ?? 0) + 1;
    }

    const weakSkills = new Set(
      evidence
        .filter((e) => e.type === "interview_answer" && e.score < 0.5)
        .map((e) => e.skillId),
    );
    let retested = 0;
    for (const skillId of weakSkills) {
      const firstWeak = evidence
        .filter(
          (e) =>
            e.skillId === skillId && e.type === "interview_answer" && e.score < 0.5,
        )
        .map((e) => e.createdAt)
        .sort()[0];
      if (!firstWeak) continue;
      const rel = new Set<string>([skillId, ...taxonomy.relatedTo(skillId as SkillId)]);
      if (allQuestions.some((q) => rel.has(q.skillId) && q.createdAt > firstWeak)) {
        retested += 1;
      }
    }

    const deltas: number[] = [];
    for (const a of actions.filter((x) => x.status === "done")) {
      const evs = this.store
        .evidenceForSkill(a.skillId)
        .filter((e) => e.type !== "self_report")
        .sort((x, y) => x.createdAt.localeCompare(y.createdAt));
      const before = [...evs].reverse().find((e) => e.createdAt <= a.createdAt);
      const after = evs.find((e) => e.createdAt > a.createdAt);
      if (before && after) deltas.push(after.score - before.score);
    }

    const activeTarget = this.store.getActiveTarget();
    const targetData = activeTarget?.data
      ? TargetRoleSchema.safeParse(activeTarget.data)
      : null;
    const requirements = targetData?.success ? targetData.data.requirements : [];
    const latest = this.store.latestReadinessBySkill();
    const covered = requirements.filter(
      (r) => (latest.get(r.skillId)?.confidence ?? 0) >= 0.4,
    ).length;

    return {
      loopsStarted: loops.length,
      loopsCompleted: loops.filter((l) => l.status === "complete" && !l.abandoned)
        .length,
      sessionsPerMode,
      weaknessRetestRate: {
        weakSkills: weakSkills.size,
        retested,
        rate: weakSkills.size ? retested / weakSkills.size : null,
      },
      improvementAfterPrep:
        deltas.length > 0
          ? deltas.reduce((a, b) => a + b, 0) / deltas.length
          : null,
      prepCompletionRate: {
        done: actions.filter((a) => a.status === "done").length,
        total: actions.filter((a) => a.status !== "superseded").length,
        rate:
          actions.filter((a) => a.status !== "superseded").length > 0
            ? actions.filter((a) => a.status === "done").length /
              actions.filter((a) => a.status !== "superseded").length
            : null,
      },
      readinessCoverage: {
        covered,
        total: requirements.length,
        rate: requirements.length ? covered / requirements.length : null,
      },
      usage: Object.fromEntries(
        InterviewOrchestrator.USAGE_EVENTS.map((e) => [
          e,
          this.store.countUsageEvents(e),
        ]),
      ),
    };
  }

  listPreparationActions(): PrepActionRowLike[] {
    return this.store.listActions().map(rowToAction);
  }

  /**
   * Self-check completion (§8.1): marks the action done and, when checked
   * criteria are supplied, records one `self_report` evidence row, then
   * recomputes readiness and rebuilds the plan.
   */
  async completeAction(actionId: string, opts: { checkedCriteria?: string[] } = {}) {
    return this.withLock(async () => {
      const action = this.store.getAction(actionId);
      if (!action) throw new AppError("NOT_FOUND", `no prep action ${actionId}`);
      const { candidate } = this.requireActive();
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
        this.store.insertEvidence({
          id: evidenceId,
          candidateId: candidate.id,
          skillId: action.skillId,
          type: "self_report",
          score: criteria.length === 0 ? 0 : checked.length / criteria.length,
          confidence: 0.5,
          observation: `Self-check: met ${checked.length}/${criteria.length} criteria — ${checked.join("; ")}`,
          createdAt: this.iso(),
        });
      }

      this.store.updateActionStatus(actionId, "done");
      this.logger.info("state.mutated", { entity: "prep_action", id: actionId, status: "done" });
      this.recomputeReadinessInternal("practice");
      const { actions } = await this.buildPreparationPlanInternal();
      return { ok: true, evidenceId, actions };
    });
  }

  // ---------------------------------------------------------------- STAR stories (§8.4)

  listStories() {
    const { candidate } = this.requireActive();
    return this.store.listStories(candidate.id);
  }

  /** Generate resume-grounded STAR stories via star-coach; dedupe by title. */
  async generateStories(opts?: ProgressOptions) {
    return this.withLock(async () => {
      const { candidate, target } = this.requireActive();
      opts?.onProgress?.({ stage: "drafting stories" });
      const behavioralSkillIds = [
        ...target.requirements,
        ...target.preferredSkills,
      ]
        .map((r) => r.skillId)
        .filter((id) => inRound(id, "behavioral") || inRound(id, "hr"));
      const existing = this.store.listStories(candidate.id);
      const out = (await this.host.invoke(
        starCoach,
        {
          mode: "generate" as const,
          experience: candidate.experience,
          achievements: candidate.achievements,
          projects: candidate.projects,
          behavioralSkillIds,
          existingTitles: existing.map((s) => s.title),
        },
        this.ctx({ onProgress: opts?.onProgress }),
      )) as { stories: Array<{ title: string; situation: string; task: string; action: string; result: string; skillIds: SkillId[] }> };
      // §9.6: star-coach output persists generated stories.
      this.host.assertCan("star-coach", "stories.write");
      const taken = new Set(existing.map((s) => s.title.toLowerCase()));
      const created = [];
      for (const s of out.stories) {
        if (taken.has(s.title.toLowerCase())) continue;
        taken.add(s.title.toLowerCase());
        const id = newId("story");
        this.store.insertStory({
          id,
          candidateId: candidate.id,
          title: s.title,
          situation: s.situation,
          task: s.task,
          action: s.action,
          result: s.result,
          skillIds: s.skillIds,
          source: "generated",
          updatedAt: this.iso(),
        });
        created.push(this.store.getStory(id)!);
      }
      this.logger.info("state.mutated", {
        entity: "star_story",
        id: `${created.length} generated`,
      });
      return { stories: this.store.listStories(candidate.id), created: created.length };
    });
  }

  /** User edits mark the story as theirs (source 'user'). */
  async updateStory(
    id: string,
    patch: {
      title?: string;
      situation?: string;
      task?: string;
      action?: string;
      result?: string;
      skillIds?: SkillId[];
    },
  ) {
    return this.withLock(async () => {
      const row = this.store.getStory(id);
      if (!row) throw new AppError("NOT_FOUND", `no story ${id}`);
      this.store.updateStory(id, {
        ...(patch.title !== undefined && { title: patch.title }),
        ...(patch.situation !== undefined && { situation: patch.situation }),
        ...(patch.task !== undefined && { task: patch.task }),
        ...(patch.action !== undefined && { action: patch.action }),
        ...(patch.result !== undefined && { result: patch.result }),
        ...(patch.skillIds !== undefined && { skillIds: patch.skillIds }),
        source: "user",
        updatedAt: this.iso(),
      });
      this.logger.info("state.mutated", { entity: "star_story", id });
      return this.store.getStory(id);
    });
  }

  /** Coach review of one story (star-coach.review); streams `feedback`. */
  async coachStory(id: string, opts?: ProgressOptions): Promise<StarCoachReviewOutput> {
    return this.withLock(async () => {
      const { target } = this.requireActive();
      const row = this.store.getStory(id);
      if (!row) throw new AppError("NOT_FOUND", `no story ${id}`);
      opts?.onProgress?.({ stage: "coaching story" });
      return (await this.host.invoke(
        starCoach,
        {
          mode: "review" as const,
          story: {
            title: row.title,
            situation: row.situation,
            task: row.task,
            action: row.action,
            result: row.result,
            skillIds: (row.skillIds as string[]) ?? [],
          },
          role: target.role,
          level: target.level,
        },
        this.ctx({ onProgress: opts?.onProgress }),
      )) as StarCoachReviewOutput;
    });
  }

  // ------------------------------------------------------------- §9.5 resume coach

  /**
   * Deterministic ATS check + resume-coach bullets/tailor (run concurrently).
   * Every suggestion passes guardSuggestion before persisting — the coach
   * never creates evidence and never changes readiness.
   */
  async reviewResume(opts?: ProgressOptions): Promise<ResumeReview> {
    return this.withLock(async () => {
      const { candidate, target } = this.requireActive();
      const candidateRow = this.store.getActiveCandidate()!;
      const resumeText = candidateRow.resumeText;
      if (!resumeText.trim()) {
        throw new AppError(
          "VALIDATION",
          "no resume on file — set up the workspace first",
        );
      }

      opts?.onProgress?.({ stage: "checking ATS" });
      const requirements = this.allRequirements(target);
      const ats = atsCheck(resumeText, requirements);
      const weakBullets = selectWeakestBullets(resumeText, 8);

      opts?.onProgress?.({ stage: "improving bullets" });
      opts?.onProgress?.({ stage: "tailoring to role" });
      const [bulletsOut, tailorOut] = await Promise.all([
        weakBullets.length > 0
          ? this.host.invoke(
              resumeCoach,
              { mode: "bullets", resumeText, bullets: weakBullets },
              this.ctx({ onProgress: opts?.onProgress }),
            )
          : Promise.resolve({ suggestions: [] }),
        this.host.invoke(
          resumeCoach,
          {
            mode: "tailor",
            resumeText,
            requirements,
            role: target.role,
            level: target.level,
          },
          this.ctx({ onProgress: opts?.onProgress }),
        ),
      ]);
      const bulletSuggestions =
        (bulletsOut as ResumeCoachBulletsOutput).suggestions ?? [];
      const tailoring = (tailorOut as ResumeTailoring) ?? null;

      // §9.5 guard: substitute invented numbers, drop invented entities.
      const substitutions: string[] = [];
      let dropped = 0;
      const suggestions: ResumeSuggestion[] = bulletSuggestions.map((s) => {
        const g = guardSuggestion(s.original, s.improved, resumeText);
        substitutions.push(...g.substitutions);
        if (!g.ok) {
          dropped += 1;
          return { ...s, improved: g.improved, dropped: g.dropped };
        }
        return { ...s, improved: g.improved };
      });
      this.logger.info("resume.guard", {
        substitutions: substitutions.length,
        dropped,
      });

      // §9.5: link prepGaps to real requirement gaps — no evidence, no
      // readiness change.
      const gaps = this.calculateGapsInternal();
      const linkedGapSkillIds = [...new Set(
        (tailoring?.prepGaps ?? [])
          .map((pg) => {
            const normalized = taxonomy.normalizeSkillId(pg);
            const hit = gaps.find(
              (g) =>
                g.skillId === normalized ||
                g.label.toLowerCase() === pg.toLowerCase(),
            );
            return hit?.skillId ?? null;
          })
          .filter((id): id is SkillId => id !== null),
      )];

      const review: ResumeReview = {
        id: newId("rev"),
        candidateId: candidate.id,
        targetId: target.id,
        ats,
        suggestions,
        tailoring,
        linkedGapSkillIds,
        guard: { substitutions: substitutions.length, dropped },
        createdAt: this.iso(),
      };
      this.host.assertCan("resume-coach", "resume.write");
      this.store.insertResumeReview(ResumeReviewSchema.parse(review));
      this.recordUsageEvent("resume.coach.used");
      this.logger.info("state.mutated", { entity: "resume_review", id: review.id });
      return review;
    });
  }

  /** Most recent persisted resume review, or null. */
  latestResumeReview(): ResumeReview | null {
    const row = this.store.latestResumeReview();
    if (!row) return null;
    const parsed = ResumeReviewSchema.safeParse({
      id: row.id,
      candidateId: row.candidateId,
      targetId: row.targetId,
      ats: row.ats,
      suggestions: row.suggestions,
      tailoring: row.tailoring,
      linkedGapSkillIds: row.linkedGapSkillIds,
      guard: row.guard,
      createdAt: row.createdAt,
    });
    return parsed.success ? parsed.data : null;
  }

  // ------------------------------------------------------------- §9.6 plugins

  /** Register a plugin skill on the host (the server-side loader validates first). */
  registerPlugin(manifest: SkillManifest, executor: PluginExecutor): void {
    this.host.registerPlugin(manifest, executor);
  }

  /** All registered manifests — built-ins and loaded plugins. */
  listSkillManifests(): SkillManifest[] {
    return this.host.manifests();
  }

  /**
   * §9.6: run a registered plugin. Input is assembled from state, only for
   * the slices its manifest declares.
   */
  async runPlugin(id: string): Promise<unknown> {
    return this.withLock(async () => {
      const candidateRow = this.store.getActiveCandidate();
      const targetRow = this.store.getActiveTarget();
      const slices: PluginStateSlices = {};
      if (candidateRow) {
        const parsed = CandidateProfileSchema.safeParse(candidateRow.data);
        if (parsed.success) slices.candidate = parsed.data;
        slices.stories = this.store.listStories(candidateRow.id);
      }
      if (targetRow) {
        const parsed = TargetRoleSchema.safeParse(targetRow.data);
        if (parsed.success) slices.target = parsed.data;
      }
      if (candidateRow && targetRow) {
        slices.readiness = this.graphForActive().dimensions;
        slices.gaps = this.calculateGapsInternal();
      }
      slices.recentEvaluations = this.store
        .listAllEvaluations()
        .slice(-20)
        .map((e) => e.data);
      return this.host.invokePlugin(id, slices, this.ctx());
    });
  }

  updateActionStatus(actionId: string, status: "open" | "in_progress" | "done" | "superseded") {
    return this.withLock(async () => {
      this.store.updateActionStatus(actionId, status);
      this.logger.info("state.mutated", { entity: "prep_action", id: actionId, status });
    });
  }

  getRuntimeSessionRow(sessionId: string) {
    return this.store.getRuntimeSession(sessionId);
  }

  /** Test-mode only: wipe all persisted state (server gates the route). */
  resetAll(): void {
    this.store.resetAll();
  }
}

function rowToAction(row: {
  id: string;
  skillId: string;
  priority: number;
  reason: string;
  action: string;
  successCriteria: unknown;
  status: string;
  severity?: string;
  createdAt: string;
  sourceEvidenceIds: unknown;
}): PrepActionRowLike {
  const parseList = (v: unknown): string[] =>
    Array.isArray(v) ? (v as string[]) : JSON.parse(String(v ?? "[]"));
  return {
    id: row.id,
    skillId: row.skillId,
    priority: row.priority,
    reason: row.reason,
    action: row.action,
    successCriteria: parseList(row.successCriteria),
    status: row.status,
    severity: row.severity ?? "medium",
    createdAt: row.createdAt,
    sourceEvidenceIds: parseList(row.sourceEvidenceIds),
  };
}

export type OrchestratorQuestion = Omit<Question, "followUpOf"> & {
  selectionReason: string | null;
  selectionPriority: number | null;
  /** §9.2 engine factor breakdown (null for practice/follow-up questions). */
  selectionFactors: Record<string, number> | null;
  /** §9.1 follow-up linkage. */
  followUpOf: string | null;
  followUpFocus: string | null;
  /** §9.1 mode payload (coding problem, design focus dimension). */
  extra: Record<string, unknown>;
};

function rowToQuestion(row: {
  id: string;
  sessionId: string;
  skillId: string;
  topic: string;
  text: string;
  subSkills: unknown;
  expectedConcepts: unknown;
  difficulty: string;
  selectionReason?: string | null;
  selectionPriority?: number | null;
  selectionFactors?: unknown;
  followUpOf?: string | null;
  followUpFocus?: string | null;
  extra?: unknown;
  createdAt: string;
}): OrchestratorQuestion {
  const parseList = <T>(v: unknown): T[] =>
    Array.isArray(v) ? (v as T[]) : JSON.parse(String(v ?? "[]"));
  const parseObj = (v: unknown): Record<string, unknown> | null => {
    if (v === null || v === undefined) return null;
    if (typeof v === "object") return v as Record<string, unknown>;
    const s = String(v);
    return s === "" ? null : (JSON.parse(s) as Record<string, unknown>);
  };
  const factors = parseObj(row.selectionFactors);
  return {
    id: row.id,
    sessionId: row.sessionId,
    skillId: row.skillId as SkillId,
    topic: row.topic,
    text: row.text,
    subSkills: parseList<string>(row.subSkills) as SkillId[],
    expectedConcepts: parseList(row.expectedConcepts),
    difficulty: row.difficulty as Question["difficulty"],
    selectionReason: row.selectionReason ?? null,
    selectionPriority: row.selectionPriority ?? null,
    selectionFactors: factors && Object.keys(factors).length > 0 ? (factors as Record<string, number>) : null,
    followUpOf: row.followUpOf ?? null,
    followUpFocus: row.followUpFocus ?? null,
    extra: parseObj(row.extra) ?? {},
    createdAt: row.createdAt,
  };
}
