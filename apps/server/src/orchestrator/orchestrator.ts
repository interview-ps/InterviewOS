import {
  AnswerEvaluationSchema,
  atsCheck,
  buildReadinessGraph,
  calculateGaps,
  CandidateProfileSchema,
  COMPANY_PROFILES,
  getCompanyProfile,
  getMode,
  isModeId,
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
import { AppError, newId, type Logger } from "@interview-os/core";
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
} from "../skills/index.js";
import type { ResumeTailoring, SkillManifest } from "@interview-os/core";
import { Store } from "./store/index.js";
import type { LoopRow, SessionRow } from "./store/index.js";
import { WorkflowContext, type ProgressOptions } from "./context.js";
import {
  SettingsService,
  type OrchestratorSettings,
} from "./settings-service.js";
import { ResumeService } from "./resume-service.js";
import { StoryService } from "./story-service.js";
import { PluginService } from "./plugin-service.js";
import { DebriefService } from "./debrief-service.js";
import { HistoryService } from "./history-service.js";
import { ReadinessService } from "./readiness-service.js";
import { PreparationService } from "./preparation-service.js";
import {
  rowToAction,
  rowToQuestion,
  type OrchestratorQuestion,
  type PrepActionRowLike,
} from "./projection.js";

export type { OrchestratorQuestion, PrepActionRowLike } from "./projection.js";

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

const INTERVIEWER_SESSION_INSTRUCTIONS = `You are the interviewer thread for Interview OS, a mock-interview tool. Each message asks you to produce ONE interview question as JSON matching the provided schema. Never repeat earlier questions.`;

export type { ProgressOptions } from "./context.js";
export type { OrchestratorSettings, TaskMode } from "./settings-service.js";

export class InterviewOrchestrator {
  static readonly USAGE_EVENTS = HistoryService.USAGE_EVENTS;

  private readonly store: Store;
  private readonly runtime: AIRuntime;
  private readonly logger: Logger;
  private readonly now: () => Date;
  /** §9.6: every skill call goes through this host. */
  readonly host: SkillHost;
  private readonly workflow: WorkflowContext;
  private readonly settings: SettingsService;
  private readonly resume: ResumeService;
  private readonly stories: StoryService;
  private readonly plugins: PluginService;
  private readonly debrief: DebriefService;
  private readonly history: HistoryService;
  private readonly readiness: ReadinessService;
  private readonly preparation: PreparationService;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: OrchestratorDeps) {
    this.store = deps.store;
    this.runtime = deps.runtime;
    this.logger = deps.logger;
    this.now = deps.now ?? (() => new Date());
    this.host = new SkillHost({ logger: deps.logger });
    registerBuiltinSkills(this.host);
    this.workflow = new WorkflowContext(
      this.store,
      this.host,
      this.runtime,
      this.logger,
      this.now,
    );
    this.settings = new SettingsService(this.workflow, this.runtime);
    this.resume = new ResumeService({
      ctx: this.workflow,
      calculateGaps: () => this.calculateGapsInternal(),
      recordUsageEvent: (event) => this.recordUsageEvent(event),
    });
    this.stories = new StoryService(this.workflow);
    this.plugins = new PluginService({
      ctx: this.workflow,
      graphForActive: () => this.graphForActive(),
      calculateGaps: () => this.calculateGapsInternal(),
    });
    this.debrief = new DebriefService(this.workflow);
    this.history = new HistoryService({
      ctx: this.workflow,
      graphForActive: () => this.graphForActive(),
      calculateGaps: () => this.calculateGapsInternal(),
    });
    this.readiness = new ReadinessService(this.workflow);
    this.preparation = new PreparationService(this.workflow, this.readiness);
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  /** Settings-backed runtime overrides, read at call time (§8.3). */
  private runtimeOptions(): SkillContext["runtimeOptions"] {
    return this.workflow.runtimeOptions();
  }

  getSettings(): OrchestratorSettings {
    return this.settings.getSettings();
  }

  async updateSettings(patch: Partial<OrchestratorSettings>): Promise<OrchestratorSettings> {
    return this.withLock(async () => this.settings.updateSettings(patch));
  }

  private ctx(extra?: Partial<SkillContext>): SkillContext {
    return this.workflow.ctx(extra);
  }

  private iso(): string {
    return this.workflow.iso();
  }

  private requireActive(): { candidate: CandidateProfile; target: TargetRole } {
    return this.workflow.requireActive();
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
        const detail: Record<string, unknown> = {
          workflow: "setupWorkspace",
          error: (err as Error).message,
        };
        if (err instanceof SkillRuntimeError) {
          detail.skill = err.taskId;
          detail.runtimeCode = err.runtimeCode;
        }
        this.logger.warn("workflow.failed", detail);
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
    this.workflow.registerSkillNode(skillId);
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
    return this.workflow.allRequirements(target);
  }

  private evidenceForActive(candidateId: string): Evidence[] {
    return this.workflow.evidenceForActive(candidateId);
  }

  private graphForActive(): ReadinessGraph {
    return this.readiness.graphForActive();
  }

  recomputeReadiness(reason: string): Promise<ReadinessGraph> {
    return this.withLock(async () => this.recomputeReadinessInternal(reason));
  }

  private recomputeReadinessInternal(reason: string): ReadinessGraph {
    return this.readiness.recomputeReadinessInternal(reason);
  }

  // ---------------------------------------------------------------- gaps + plan

  async calculateGaps(): Promise<Gap[]> {
    return this.withLock(async () => this.calculateGapsInternal());
  }

  private calculateGapsInternal(): Gap[] {
    return this.readiness.calculateGapsInternal();
  }

  async buildPreparationPlan(): Promise<PrepActionRowLike[]> {
    const { actions } = await this.withLock(() => this.buildPreparationPlanInternal());
    return actions;
  }

  private buildPreparationPlanInternal() {
    return this.preparation.buildPreparationPlanInternal();
  }

  private insertPlannedAction(
    skillId: SkillId,
    action: { action: string; successCriteria: string[]; reason: string },
    candidateId: string,
    severity: "low" | "medium" | "high" = "medium",
    targetId?: string,
  ): PrepActionRowLike {
    return this.preparation.insertPlannedAction(skillId, action, candidateId, severity, targetId);
  }

  private renumberActionPriorities(requirements: Requirement[], targetId?: string): void {
    this.preparation.renumberActionPriorities(requirements, targetId);
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
    this.workflow.transitionSession(sessionId, next, event);
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
    return this.withLock(() => this.debrief.createDebriefInternal(sessionId, opts));
  }

  private createDebriefInternal(sessionId: string, opts?: ProgressOptions) {
    return this.debrief.createDebriefInternal(sessionId, opts);
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
    return this.history.getState();
  }

  async getSkillDetail(skillId: string) {
    return this.history.getSkillDetail(skillId);
  }

  listInterviews() {
    return this.history.listInterviews();
  }

  getInterview(id: string) {
    return this.history.getInterview(id);
  }

  // ------------------------------------------------- §9.7 history / metrics

  recordUsageEvent(event: string) {
    return this.history.recordUsageEvent(event);
  }

  getHistory(filters: {
    mode?: string;
    targetId?: string;
    loopId?: string;
    weakOnly?: boolean;
  } = {}) {
    return this.history.getHistory(filters);
  }

  getSessionHistory(id: string) {
    return this.history.getSessionHistory(id);
  }

  getMetrics() {
    return this.history.getMetrics();
  }

  listPreparationActions(): PrepActionRowLike[] {
    return this.preparation.listPreparationActions();
  }

  /**
   * Self-check completion (§8.1): marks the action done and, when checked
   * criteria are supplied, records one `self_report` evidence row, then
   * recomputes readiness and rebuilds the plan.
   */
  async completeAction(actionId: string, opts: { checkedCriteria?: string[] } = {}) {
    return this.withLock(async () => this.preparation.completeAction(actionId, opts));
  }

  // ---------------------------------------------------------------- STAR stories (§8.4)

  listStories() {
    return this.stories.listStories();
  }

  /** Generate resume-grounded STAR stories via star-coach; dedupe by title. */
  async generateStories(opts?: ProgressOptions) {
    return this.withLock(async () => this.stories.generateStories(opts));
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
    return this.withLock(async () => this.stories.updateStory(id, patch));
  }

  /** Coach review of one story (star-coach.review); streams `feedback`. */
  async coachStory(id: string, opts?: ProgressOptions): Promise<StarCoachReviewOutput> {
    return this.withLock(async () => this.stories.coachStory(id, opts));
  }

  // ------------------------------------------------------------- §9.5 resume coach

  async reviewResume(opts?: ProgressOptions): Promise<ResumeReview> {
    return this.withLock(async () => this.resume.reviewResume(opts));
  }

  latestResumeReview(): ResumeReview | null {
    return this.resume.latestResumeReview();
  }

  // ------------------------------------------------------------- §9.6 plugins

  /** Register a plugin skill on the host (the server-side loader validates first). */
  registerPlugin(manifest: SkillManifest, executor: PluginExecutor): void {
    this.plugins.registerPlugin(manifest, executor);
  }

  /** All registered manifests — built-ins and loaded plugins. */
  listSkillManifests(): SkillManifest[] {
    return this.plugins.listSkillManifests();
  }

  /**
   * §9.6: run a registered plugin. Input is assembled from state, only for
   * the slices its manifest declares.
   */
  async runPlugin(id: string): Promise<unknown> {
    return this.withLock(async () => this.plugins.runPlugin(id));
  }

  updateActionStatus(actionId: string, status: "open" | "in_progress" | "done" | "superseded") {
    return this.withLock(async () => this.preparation.updateActionStatus(actionId, status));
  }

  getRuntimeSessionRow(sessionId: string) {
    return this.store.getRuntimeSession(sessionId);
  }

  /** Test-mode only: wipe all persisted state (server gates the route). */
  resetAll(): void {
    this.store.resetAll();
  }
}
