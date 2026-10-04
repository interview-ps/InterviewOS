import {
  transition,
  type CandidateProfile,
  type Gap,
  type Permission,
  type NormalizedPluginCapability,
  type PluginHookName,
  type InterviewOSState,
  type InterviewStatus,
  type ReadinessGraph,
  type ResumeReview,
  type SkillId,
  type SkillManifest,
  type TargetRole,
  type UINode,
} from "@interview-os/core";
import { AppError, type Logger } from "@interview-os/core";
import type { AIRuntime } from "@interview-os/runtime";
import {
  registerBuiltinSkills,
  SkillHost,
  type PluginExecutor,
  type StarCoachReviewOutput,
} from "../skills/index.js";
import { Store } from "./store/index.js";
import { WorkflowContext, type ProgressOptions } from "./context.js";
import {
  SettingsService,
  type OrchestratorSettings,
} from "./settings-service.js";
import { ResumeService } from "./resume-service.js";
import { StoryService } from "./story-service.js";
import {
  PluginService,
  type PluginPrepSuggestionGroup,
  type PluginRegistrationMeta,
  type PluginRunResult,
  type PluginUIContributionView,
  type PluginUIRenderRequest,
  type PluginView,
} from "./plugin-service.js";
import type { PluginLoadError } from "../startup/plugins.js";
import { PackRegistry } from "../packs/registry.js";
import {
  PackService,
  type InterviewPackView,
  type PackListView,
  type QuestionBankItem,
} from "./pack-service.js";
import type { InstallablePackKind } from "../packs/registry.js";
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
import { McpService, type McpServerView } from "./mcp-service.js";
import { ExportService, type ImportCounts } from "./export-service.js";
import type { McpManager } from "../mcp/McpManager.js";
import type {
  OrchestratorQuestion,
  PrepActionRowLike,
} from "./projection.js";

export type { OrchestratorQuestion, PrepActionRowLike } from "./projection.js";
export type { SetupWorkspaceInput, TargetInput } from "./workspace-service.js";
export type {
  StartInterviewInput,
  SubmitAnswerInput,
  SubmitAnswerResult,
} from "./interview-service.js";
export type { LoopRoundInput } from "./loop-service.js";

export interface OrchestratorDeps {
  store: Store;
  runtime: AIRuntime;
  logger: Logger;
  now?: () => Date;
  /** v0.4: plugin dirs for install/uninstall; omit to disable those paths. */
  pluginDirs?: { bundled: string; installed: string };
  /** v0.4: pack dirs; omit → only built-in profiles exist. */
  packDirs?: { bundled: string; installed: string };
  /** v0.4: MCP manager; omit → MCP surfaces empty/disabled. */
  mcp?: McpManager;
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
  private readonly packs: PackService;
  private readonly mcp: McpService;
  private readonly exporter: ExportService;
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
      new PackRegistry(deps.packDirs ?? {}, deps.logger),
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
      recomputeReadiness: (reason) => this.recomputeReadinessInternal(reason),
      pluginDirs: deps.pluginDirs,
    });
    this.debrief = new DebriefService(this.workflow);
    this.history = new HistoryService({
      ctx: this.workflow,
      graphForActive: () => this.graphForActive(),
      calculateGaps: () => this.calculateGapsInternal(),
    });
    this.readiness = new ReadinessService(this.workflow, {
      onReadinessChanged: (changedSkillIds, reason) => {
        // Loop guard: plugin-caused recomputes (tagged "plugin*") never
        // re-fire events back into the plugins that wrote the evidence.
        if (reason.startsWith("plugin")) return;
        this.enqueuePluginEvent("events.readinessUpdated", { changedSkillIds });
      },
    });
    this.preparation = new PreparationService(this.workflow, this.readiness, {
      runResourcePlugin: (id, request) =>
        this.plugins
          .invokeHook(id, "resources.suggest", request)
          .then((r) => r.output),
      enabledResourcePlugins: () => this.plugins.enabledCapabilityIds("resources"),
    });
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
      runQuestionPlugin: (id, request) =>
        this.plugins
          .invokeHook(id, "questions.suggest", request)
          .then((r) => r.output),
      enabledQuestionPlugins: () => this.plugins.enabledCapabilityIds("question_source"),
      pluginInterviewMode: (pluginModeId) =>
        this.plugins.pluginInterviewMode(pluginModeId),
      evaluationReviews: (args) => this.plugins.evaluationReviews(args),
      persistPluginEvidence: (id, proposals) =>
        this.plugins.persistPluginEvidence(id, proposals),
    });
    this.loop = new LoopService({
      ctx: this.workflow,
      readiness: this.readiness,
      interview: this.interview,
    });
    this.packs = new PackService({
      ctx: this.workflow,
      startLoop: (input, opts) => this.loop.startLoop(input, opts),
    });
    this.mcp = new McpService(this.workflow, deps.mcp);
    this.exporter = new ExportService(this.workflow);
    this.exporter.recomputeAfterImport = () =>
      this.readiness.recomputeReadinessInternal("import");
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  getSettings(): Promise<OrchestratorSettings> {
    return this.settings.getSettings();
  }

  async updateSettings(
    patch: Parameters<SettingsService["updateSettings"]>[0],
  ): Promise<OrchestratorSettings> {
    return this.withLock(async () => this.settings.updateSettings(patch));
  }

  private iso(): string {
    return this.workflow.iso();
  }

  private async transitionSession(
    sessionId: string,
    next: InterviewStatus,
    event: Parameters<typeof transition>[1],
  ): Promise<void> {
    await this.workflow.transitionSession(sessionId, next, event);
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

  /** §9.3: all built-in company profiles (each carries the disclaimer). */
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

  private graphForActive(): Promise<ReadinessGraph> {
    return this.readiness.graphForActive();
  }

  async recomputeReadiness(reason: string): Promise<ReadinessGraph> {
    // events.readinessUpdated detection lives in the readiness service (it
    // fires via onReadinessChanged → enqueuePluginEvent for every recompute
    // that appends a snapshot with different scores, wherever it runs).
    return this.withLock(() => this.recomputeReadinessInternal(reason));
  }

  private recomputeReadinessInternal(reason: string): Promise<ReadinessGraph> {
    return this.readiness.recomputeReadinessInternal(reason);
  }

  // ---------------------------------------------------------------- gaps + plan

  async calculateGaps(): Promise<Gap[]> {
    return this.withLock(async () => this.calculateGapsInternal());
  }

  private calculateGapsInternal(): Promise<Gap[]> {
    return this.readiness.calculateGapsInternal();
  }

  async buildPreparationPlan(): Promise<PrepActionRowLike[]> {
    const { actions } = await this.withLock(() => this.buildPreparationPlanInternal());
    return actions;
  }

  private buildPreparationPlanInternal() {
    return this.preparation.buildPreparationPlanInternal();
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
    const result = await this.withLock(async () => {
      const session = await this.store.getSession(sessionId);
      if (!session) throw new AppError("NOT_FOUND", `no session ${sessionId}`);
      const status = session.status as InterviewStatus;
      if (status === "follow_up" || status === "question") {
        await this.transitionSession(sessionId, "complete", "complete");
        await this.store.updateSession(sessionId, { completedAt: this.iso() });
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
        session: await this.store.getSession(sessionId),
        debrief,
        loop,
        nextSession,
        nextQuestion,
      };
    });
    // v1: lifecycle events are fire-and-forget — a slow plugin must not
    // delay the user-facing completion response. The queue is serialized;
    // proposals are written back under the lock when the task runs.
    this.enqueuePluginEvent("events.sessionCompleted", {
      sessionId,
      roundType: result.session?.roundType ?? "mixed",
      scores: await this.sessionScoreSummary(sessionId),
    });
    return result;
  }

  /**
   * Per-skill summary of a session's evaluations for the
   * events.sessionCompleted payload — scores only, never answer text.
   */
  private async sessionScoreSummary(
    sessionId: string,
  ): Promise<Record<string, { meanScore: number; answers: number }>> {
    const evaluations = await this.store.listEvaluations(sessionId);
    const acc = new Map<string, { total: number; answers: number }>();
    for (const row of evaluations) {
      const data = row.data as {
        scores?: { skill: string; score: number }[];
      };
      for (const s of data?.scores ?? []) {
        const e = acc.get(s.skill) ?? { total: 0, answers: 0 };
        e.total += s.score;
        e.answers += 1;
        acc.set(s.skill, e);
      }
    }
    return Object.fromEntries(
      [...acc].map(([skill, e]) => [
        skill,
        { meanScore: e.total / e.answers, answers: e.answers },
      ]),
    );
  }

  /**
   * Serialized plugin-event queue. Event tasks never block the user-facing
   * call that enqueued them, run in order, and must never reject the chain —
   * dispatchPluginEvent swallows and logs all failures itself.
   */
  private eventQueue: Promise<void> = Promise.resolve();

  private enqueuePluginEvent(
    name: "events.sessionCompleted" | "events.readinessUpdated",
    payload: unknown,
  ): void {
    this.eventQueue = this.eventQueue.then(() =>
      this.dispatchPluginEvent(name, payload),
    );
  }

  /**
   * Awaits every queued plugin event. For tests and graceful shutdown —
   * callers should bound it with their own timeout (index.ts uses 5 s).
   */
  async flushPluginEvents(): Promise<void> {
    await this.eventQueue;
  }

  /**
   * v1: fire a plugin event hook outside the lock, then persist any returned
   * evidence proposals under the lock through the standard gate. Fire-and-
   * forget safe: failures are logged inside the service, never thrown here.
   */
  private async dispatchPluginEvent(
    name: "events.sessionCompleted" | "events.readinessUpdated",
    payload: unknown,
  ): Promise<void> {
    try {
      const fired = await this.plugins.firePluginEvent(name, payload);
      for (const { pluginId, proposals } of fired) {
        await this.withLock(async () => {
          const { written } = await this.plugins.persistPluginEvidence(
            pluginId,
            proposals,
          );
          if (written > 0) {
            // tagged "plugin-event" so the readinessUpdated dispatcher does
            // not re-fire events for plugin-caused readiness changes.
            await this.recomputeReadinessInternal(`plugin-event:${pluginId}`);
          }
        });
      }
    } catch (err) {
      this.logger.warn("plugin.events_failed", {
        event: name,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
      });
    }
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

  // ------------------------------------------------------------- v0.4 packs

  /** Company + role packs visible to the registry, plus load errors. */
  listPacks(): Promise<PackListView> {
    return this.packs.listPacks();
  }

  async installPackFromGit(kind: InstallablePackKind, url: string) {
    return this.withLock(() => this.packs.installPackFromGit(kind, url));
  }

  async uninstallPack(kind: InstallablePackKind, id: string) {
    return this.withLock(() => this.packs.uninstallPack(kind, id));
  }

  /** v0.4: assign/clear a role pack on a target (adds requirements + rubrics). */
  async setTargetRolePack(targetId: string, rolePackId: string | null) {
    return this.withLock(() => this.targets.setTargetRolePack(targetId, rolePackId));
  }

  listInterviewPacks(): Promise<InterviewPackView[]> {
    return this.packs.listInterviewPacks();
  }

  getInterviewPack(id: string): Promise<InterviewPackView> {
    return this.packs.getInterviewPack(id);
  }

  async createInterviewPack(input: Parameters<PackService["createInterviewPack"]>[0]) {
    return this.withLock(() => this.packs.createInterviewPack(input));
  }

  async deleteInterviewPack(id: string) {
    return this.withLock(() => this.packs.deleteInterviewPack(id));
  }

  exportInterviewPack(id: string): Promise<{ filename: string; content: string }> {
    return this.packs.exportInterviewPack(id);
  }

  async importInterviewPack(content: string) {
    return this.withLock(() => this.packs.importInterviewPack(content));
  }

  /** Start a loop whose rounds/focus skills come from an interview pack. */
  async startLoopFromPack(id: string, opts?: ProgressOptions) {
    return this.withLock(() => this.packs.startLoopFromPack(id, opts));
  }

  // -------------------------------------------------------- v0.4 question bank

  listQuestionBank() {
    return this.packs.listQuestionBank();
  }

  async addUserQuestion(item: QuestionBankItem) {
    return this.withLock(() => this.packs.addUserQuestion(item));
  }

  async deleteUserQuestion(id: string) {
    return this.withLock(() => this.packs.deleteUserQuestion(id));
  }

  async importQuestionBank(content: string) {
    return this.withLock(() => this.packs.importQuestionBank(content));
  }

  /** v0.4: fetch learning resources from enabled `resources` plugins. */
  async fetchPluginResources(actionId: string): Promise<PrepActionRowLike> {
    return this.withLock(() => this.preparation.fetchPluginResources(actionId));
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

  listPreparationActions(): Promise<PrepActionRowLike[]> {
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

  latestResumeReview() {
    return this.resume.latestResumeReview();
  }

  // ------------------------------------------------------------- §9.6 plugins

  /** Register a plugin skill on the host (the server-side loader validates first). */
  registerPlugin(
    manifest: SkillManifest,
    executor: PluginExecutor,
    meta?: PluginRegistrationMeta,
  ): void {
    this.plugins.registerPlugin(manifest, executor, meta);
  }

  setPluginLoadErrors(errors: PluginLoadError[]): void {
    this.plugins.setPluginLoadErrors(errors);
  }

  /** v0.4: persist a plugin-declared taxonomy node (+ ancestors). */
  async registerSkillNode(skillId: SkillId): Promise<void> {
    return this.withLock(() => this.workflow.registerSkillNode(skillId));
  }

  /** All registered manifests — built-ins and loaded plugins. */
  listSkillManifests(): SkillManifest[] {
    return this.plugins.listSkillManifests();
  }

  /** v0.4: plugin manifests + install state + permission view for the UI. */
  listPlugins(): Promise<PluginView[]> {
    return this.plugins.listPlugins();
  }

  async setPluginEnabled(
    id: string,
    enabled: boolean,
    grantedPermissions?: Permission[],
  ): Promise<PluginView> {
    return this.withLock(async () =>
      this.plugins.setPluginEnabled(id, enabled, grantedPermissions),
    );
  }

  async installPluginFromGit(url: string): Promise<PluginView> {
    return this.withLock(async () => this.plugins.installPluginFromGit(url));
  }

  async uninstallPlugin(id: string): Promise<void> {
    return this.withLock(async () => this.plugins.uninstallPlugin(id));
  }

  /* ------------------------------------------------- v1 plugin API surface */

  /** Plugin API v1: invoke a typed hook (validated request + response). */
  invokePluginHook(id: string, hook: PluginHookName, req: unknown) {
    return this.plugins.invokeHook(id, hook, req);
  }

  /** v1: declared settings fields for a plugin. */
  pluginSettingsSpec(id: string) {
    return this.plugins.pluginSettingsSpec(id);
  }

  /** v1: effective settings (declared defaults + stored values). */
  getPluginSettings(id: string): Promise<Record<string, unknown>> {
    return this.plugins.getPluginSettings(id);
  }

  /** v1: validate + store settings values (unknown keys rejected). */
  setPluginSettings(
    id: string,
    values: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.withLock(() => this.plugins.setPluginSettings(id, values));
  }

  /** v1: plugin-suggested prep activities (read-only). */
  pluginPrepSuggestions(): Promise<PluginPrepSuggestionGroup[]> {
    return this.plugins.pluginPrepSuggestions();
  }

  /** v1: accept a plugin suggestion → prep action `source: "plugin:<id>"`. */
  acceptPluginSuggestion(
    pluginId: string,
    activity: unknown,
  ): Promise<{ id: string }> {
    return this.withLock(() =>
      this.plugins.acceptPluginSuggestion(pluginId, activity),
    );
  }

  /** v1: sync enabled plugins' shipped packs into the PackRegistry. */
  syncPluginPacks(): Promise<void> {
    return this.plugins.syncPluginPacks();
  }

  findPluginsByCapability(cap: NormalizedPluginCapability): Promise<SkillManifest[]> {
    return this.plugins.findPluginsByCapability(cap);
  }

  /**
   * §9.6: run a registered plugin. Input is assembled from state, only for
   * the slices its manifest declares and its grants allow.
   */
  async runPlugin(id: string, request?: unknown): Promise<PluginRunResult> {
    return this.withLock(async () => this.plugins.runPlugin(id, request));
  }

  // -------------------------------------------------------- v0.4 plugin UI

  /**
   * Render a declared declarative contribution. Read-only (the plugin runs in
   * its isolated child and evidence proposals are ignored), so intentionally
   * not wrapped in the orchestrator lock.
   */
  renderPluginUI(id: string, req: PluginUIRenderRequest): Promise<UINode> {
    return this.plugins.renderPluginUI(id, req);
  }

  /** UI contributions of enabled + compatible plugins. */
  listUIContributions(): Promise<PluginUIContributionView[]> {
    return this.plugins.listUIContributions();
  }

  /** v0.4: resolve a declared frame contribution to its entry file. */
  resolveUIFrame(
    id: string,
    sel: { component?: string; page?: string },
  ): Promise<{ dir: string; entry: string; component: string; page?: string; title?: string }> {
    return this.plugins.resolveUIFrame(id, sel);
  }

  /** v0.4: the ui/ dir of an enabled + compatible plugin (for assets). */
  resolveUIAssetDir(id: string): Promise<string> {
    return this.plugins.resolveUIAssetDir(id);
  }

  /** v0.4: a frame's declared + granted data slices (read-only). */
  pluginUIData(
    id: string,
    sel: { component?: string; page?: string },
  ): Promise<Record<string, unknown>> {
    return this.plugins.pluginUIData(id, sel);
  }

  /** v0.4: stateless plugin invocation from a frame (read-only). */
  pluginUIRun(
    id: string,
    sel: { component?: string; page?: string; request?: unknown },
  ): Promise<{ output: unknown; ui?: UINode }> {
    return this.plugins.pluginUIRun(id, sel);
  }

  updateActionStatus(actionId: string, status: "open" | "in_progress" | "done" | "superseded") {
    return this.withLock(async () => this.preparation.updateActionStatus(actionId, status));
  }

  getRuntimeSessionRow(sessionId: string) {
    return this.store.getRuntimeSession(sessionId);
  }

  /** Test-mode only: wipe all persisted state (server gates the route). */
  async resetAll(): Promise<void> {
    await this.store.resetAll();
  }

  // ------------------------------------------------------------- v0.4 MCP

  /** Config servers + persisted enablement/tool allowlists + config load error. */
  listMcpServers(): Promise<{ servers: McpServerView[]; loadError: string | null }> {
    return this.mcp.listMcpServers();
  }

  async updateMcpServer(
    id: string,
    patch: { enabled?: boolean; allowedTools?: string[] },
  ): Promise<McpServerView> {
    return this.withLock(() => this.mcp.updateMcpServer(id, patch));
  }

  /** Tool list for an enabled server (lazy stdio connection). */
  listMcpTools(id: string) {
    return this.mcp.listMcpTools(id);
  }

  /** Call an allowed tool and persist its (truncated) text as a context. */
  async fetchExternalContext(input: {
    serverId: string;
    tool: string;
    args?: Record<string, unknown>;
    title?: string;
  }) {
    return this.withLock(() => this.mcp.fetchExternalContext(input));
  }

  listExternalContexts() {
    return this.mcp.listExternalContexts();
  }

  async deleteExternalContext(id: string) {
    return this.withLock(() => this.mcp.deleteExternalContext(id));
  }

  // ------------------------------------------------------- v0.4 export/import

  /** Full state bundle (excludes runtime/plugin/MCP/usage tables). */
  exportState() {
    return this.exporter.exportState();
  }

  /** One of the per-file parts: candidate|targets|readiness|evidence|interviews|preparation. */
  exportStatePart(part: Parameters<ExportService["exportStatePart"]>[0]) {
    return this.exporter.exportStatePart(part);
  }

  /**
   * Replace-mode import: the whole bundle is validated first, then wiped and
   * re-inserted in one transaction. Returns per-table insert counts.
   */
  async importState(
    bundle: unknown,
    opts: { mode: "replace" } = { mode: "replace" },
  ): Promise<ImportCounts> {
    return this.withLock(() => this.exporter.importState(bundle, opts));
  }
}
