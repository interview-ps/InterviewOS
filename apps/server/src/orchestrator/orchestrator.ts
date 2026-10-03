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
  WorkspaceService,
  type SetupWorkspaceInput,
  type TargetInput,
} from "./workspace-service.js";
import { TargetService } from "./target-service.js";
import {
  InterviewService,
  type StartInterviewInput,
  type SubmitAnswerInput,
  type SubmitAnswerResult,
} from "./interview-service.js";
import { LoopService, type LoopRoundInput } from "./loop-service.js";
import {
  rowToAction,
  rowToQuestion,
  type OrchestratorQuestion,
  type PrepActionRowLike,
} from "./projection.js";

export type { OrchestratorQuestion, PrepActionRowLike } from "./projection.js";
export type { SetupWorkspaceInput, TargetInput } from "./workspace-service.js";
export type {
  StartInterviewInput,
  SubmitAnswerInput,
  SubmitAnswerResult,
} from "./interview-service.js";
export type { LoopRoundInput } from "./loop-service.js";

const OVERALL_SKILL_ID = "__overall__";

export interface OrchestratorDeps {
  store: Store;
  runtime: AIRuntime;
  logger: Logger;
  now?: () => Date;
}

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
  private readonly workspace: WorkspaceService;
  private readonly targets: TargetService;
  private readonly interview: InterviewService;
  private readonly loop: LoopService;
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
    this.workspace = new WorkspaceService({
      ctx: this.workflow,
      readiness: this.readiness,
      preparation: this.preparation,
    });
    this.targets = new TargetService({
      ctx: this.workflow,
      readiness: this.readiness,
      preparation: this.preparation,
      workspace: this.workspace,
      recordUsageEvent: (event) => this.recordUsageEvent(event),
    });
    this.interview = new InterviewService({
      ctx: this.workflow,
      readiness: this.readiness,
      preparation: this.preparation,
      loopContextFor: (session) => this.loop.loopContextFor(session),
    });
    this.loop = new LoopService({
      ctx: this.workflow,
      readiness: this.readiness,
      interview: this.interview,
    });
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

  private registerSkillNode(skillId: SkillId): void {
    this.workflow.registerSkillNode(skillId);
  }

  private transitionSession(
    sessionId: string,
    next: InterviewStatus,
    event: Parameters<typeof transition>[1],
  ): void {
    this.workflow.transitionSession(sessionId, next, event);
  }

  // ---------------------------------------------------------------- pipeline

  async setupWorkspace(input: SetupWorkspaceInput, opts?: ProgressOptions) {
    return this.withLock(async () => this.workspace.setupWorkspace(input, opts));
  }

  async analyzeCandidate(resumeText: string): Promise<CandidateProfile> {
    return this.withLock(() => this.workspace.analyzeCandidateInternal(resumeText));
  }

  async analyzeTarget(input: TargetInput): Promise<TargetRole> {
    return this.withLock(() => this.workspace.analyzeTargetInternal(input));
  }

  // ---------------------------------------------------------------- targets

  listTargets() {
    return this.targets.listTargets();
  }

  /** Add another target role for the active candidate; becomes the active target. */
  async addTarget(input: TargetInput, opts?: ProgressOptions) {
    return this.withLock(async () => this.targets.addTarget(input, opts));
  }

  async activateTarget(id: string) {
    return this.withLock(async () => this.targets.activateTarget(id));
  }

  /** Â§9.3: all built-in company profiles (each carries the disclaimer). */
  listCompanyProfiles() {
    return this.targets.listCompanyProfiles();
  }

  /**
   * §9.3: change a target's company profile. Importances are recomputed from
   * the JD-analyzer `baseImportance` so boosts never compound; the notes
   * overlay (§8.4) re-applies on top. Then readiness + plan rebuild.
   */
  async updateTargetCompanyProfile(targetId: string, companyProfileId: string) {
    return this.withLock(async () =>
      this.targets.updateTargetCompanyProfile(targetId, companyProfileId),
    );
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
    return this.withLock(() => this.interview.startInterviewInternal(input, opts));
  }

  async nextQuestion(sessionId: string, opts?: ProgressOptions) {
    return this.withLock(() => this.interview.nextQuestionInternal(sessionId, opts));
  }

  async submitAnswer(
    sessionId: string,
    answer: string | SubmitAnswerInput,
    opts?: ProgressOptions,
  ): Promise<SubmitAnswerResult> {
    return this.withLock(() => this.interview.submitAnswer(sessionId, answer, opts));
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
    return this.withLock(async () => this.loop.startLoop(input, opts));
  }

  private advanceLoopInternal(sessionId: string, opts?: ProgressOptions) {
    return this.loop.advanceLoopInternal(sessionId, opts);
  }

  getLoop(id: string) {
    return this.loop.getLoop(id);
  }

  listLoops() {
    return this.loop.listLoops();
  }

  /** Abandon an in-progress loop: current session completed, loop closed. */
  async abandonLoop(id: string) {
    return this.withLock(async () => this.loop.abandonLoop(id));
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
