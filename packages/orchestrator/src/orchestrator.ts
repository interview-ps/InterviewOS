import {
  AnswerEvaluationSchema,
  buildReadinessGraph,
  calculateGaps,
  CandidateProfileSchema,
  InterviewOSStateSchema,
  selectNextSkill,
  inRound,
  taxonomy,
  TargetRoleSchema,
  transition,
  type CompanyProfile,
  type RoundType,
  type AnswerEvaluation,
  type CandidateProfile,
  type Evidence,
  type ExpectedConcept,
  type Gap,
  type InterviewOSState,
  type InterviewStatus,
  type Level,
  type Question,
  type ReadinessGraph,
  type Requirement,
  type SkillId,
  type TargetRole,
} from "@interview-os/core";
import { RuntimeError, type AIRuntime } from "@interview-os/runtime";
import { AppError, newId, type Logger } from "@interview-os/shared";
import {
  answerEvaluator,
  companyProfiler,
  interviewDebrief,
  interviewer,
  jdAnalyzer,
  prepPlanner,
  resumeAnalyzer,
  SkillRuntimeError,
  starCoach,
  taxonomyEntries,
  type JdAnalyzerOutput,
  type PrepPlannerOutput,
  type ProgressUpdate,
  type ResumeAnalyzerOutput,
  type SkillContext,
  type StarCoachReviewOutput,
} from "@interview-os/skills";
import { Store } from "./store/index.js";

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
  model: string | null;
  reasoningEffort: "low" | "medium" | "high" | null;
  taskMode: TaskMode;
}

export class InterviewOrchestrator {
  private readonly store: Store;
  private readonly runtime: AIRuntime;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: OrchestratorDeps) {
    this.store = deps.store;
    this.runtime = deps.runtime;
    this.logger = deps.logger;
    this.now = deps.now ?? (() => new Date());
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
      model: this.store.getSetting("model") ?? null,
      effort: effort === "low" || effort === "medium" || effort === "high" ? effort : null,
      taskMode: taskMode === "exec" ? "exec" : "app-server",
    };
  }

  getSettings(): OrchestratorSettings {
    const opts = this.runtimeOptions();
    return {
      model: opts?.model ?? null,
      reasoningEffort: opts?.effort ?? null,
      taskMode: opts?.taskMode ?? "app-server",
    };
  }

  /**
   * Resolve a saved model against the live catalog. A model that vanished
   * (provider changed / catalog refreshed) falls back to the entry flagged
   * `isDefault` (or the first entry) and is persisted, so the UI never shows a
   * stale id. Returns the effective model.
   */
  private async resolveModelOrDefault(saved: string | null): Promise<string | null> {
    const models = await this.runtime.listModels();
    if (models.length === 0) return saved;
    if (saved && models.some((m) => m.id === saved)) return saved;
    const fallback = models.find((m) => m.isDefault) ?? models[0];
    const next = fallback?.id ?? null;
    if (next !== saved) this.store.setSetting("model", next);
    return next;
  }

  async updateSettings(patch: Partial<OrchestratorSettings>): Promise<OrchestratorSettings> {
    return this.withLock(async () => {
      if ("model" in patch) {
        const model = patch.model ?? null;
        if (model !== null) {
          this.store.setSetting("model", await this.resolveModelOrDefault(model));
        } else {
          this.store.setSetting("model", null);
        }
      }
      if ("reasoningEffort" in patch) {
        const effort = patch.reasoningEffort ?? null;
        if (effort !== null) {
          const model = patch.model ?? this.store.getSetting("model") ?? null;
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
      // taskMode is a Codex-only execution detail; ignore it for other runtimes.
      if ("taskMode" in patch && patch.taskMode !== undefined && this.runtime.kind === "codex") {
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
            companyProfiler.execute(
              {
                company: input.company,
                companyNotes: input.companyNotes,
                taxonomy: taxonomyEntries(),
              },
              this.ctx({ onProgress }),
            ))
          : Promise.resolve(null);
        const [candidateOut, targetOut, companyProfile] = await Promise.all([
          resumeAnalyzer.execute(
            { resumeText: input.resumeText, taxonomy: taxonomyEntries() },
            this.ctx({ onProgress }),
          ),
          jdAnalyzer.execute(
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
    const output = await resumeAnalyzer.execute(
      { resumeText, taxonomy: taxonomyEntries() },
      this.ctx(),
    );
    return this.persistCandidate(resumeText, output);
  }

  private persistCandidate(
    resumeText: string,
    output: ResumeAnalyzerOutput,
  ): CandidateProfile {
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
  private profileCompany(input: TargetInput): Promise<CompanyProfile | null> {
    if (!input.companyNotes?.trim()) return Promise.resolve(null);
    return companyProfiler.execute(
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
      jdAnalyzer.execute({ ...input, taxonomy: taxonomyEntries() }, this.ctx()),
      this.profileCompany(input),
    ]);
    return this.persistTarget(input, output, profile);
  }

  private persistTarget(
    input: TargetInput,
    output: JdAnalyzerOutput,
    companyProfile: CompanyProfile | null = null,
  ): TargetRole {
    // §8.4: company focus skills boost requirement importance (+0.05, cap 0.95)
    const focus = new Set<string>(companyProfile?.focusSkillIds ?? []);
    const boost = (r: Requirement): Requirement =>
      focus.has(r.skillId)
        ? {
            ...r,
            importance: Math.min(0.95, Math.round((r.importance + 0.05) * 100) / 100),
            boostedBy: "company-profile",
          }
        : r;
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
        jdAnalyzer.execute(
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
      const plan: PrepPlannerOutput = await prepPlanner.execute(
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
    return this.withLock(async () => {
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
      const sessionId = newId("int");
      const createdAt = this.iso();
      this.store.insertSession({
        id: sessionId,
        candidateId: candidate.id,
        targetId: target.id,
        status: "created",
        plannedQuestions,
        mode,
        roundType: input.roundType ?? "mixed",
        focusSkillId: input.focusSkillId ?? null,
        actionId: input.actionId ?? null,
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
    });
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

    if (status === "ready") {
      this.transitionSession(sessionId, "question", "ask");
    } else if (status === "follow_up") {
      if (questions.length >= session.plannedQuestions) {
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

    const roundType = (session.roundType ?? "mixed") as RoundType;
    opts?.onProgress?.({ stage: "selecting skill" });
    const selection =
      session.mode === "practice" && session.focusSkillId
        ? {
            skillId: session.focusSkillId as SkillId,
            reason: `practice: verifying ${taxonomy.labelFor(session.focusSkillId as SkillId)}`,
            priority: 99,
          }
        : selectNextSkill({
            requirements: this.allRequirements(target),
            readiness: graph.dimensions,
            evidence,
            askedThisSession: questions.map((q) => q.skillId as SkillId),
            askedPreviousSession,
            questionIndex: questions.length,
            roundType,
          });
    if (!selection) {
      this.transitionSession(sessionId, "complete", "complete");
      return { session: this.store.getSession(sessionId), question: null };
    }

    // §8.4: behavioral/hr interviewers get company themes + story titles
    const behavioralRound = roundType === "behavioral" || roundType === "hr";
    const interviewerInput = {
      skillId: selection.skillId,
      label: taxonomy.labelFor(selection.skillId),
      role: target.role,
      level: target.level,
      company: target.company,
      reason: selection.reason,
      previousQuestions: [...allPreviousTexts],
      candidateSummary: `${candidate.name ?? "candidate"} — ${candidate.headline ?? ""}`.trim(),
      roundType,
      companyThemes: behavioralRound ? (target.companyProfile?.behavioralThemes ?? []) : [],
      storyTitles: behavioralRound
        ? this.store.listStories(candidate.id).map((s) => s.title).slice(0, 10)
        : [],
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
      produced = await interviewer.execute(interviewerInput, interviewCtx);
    } catch (err) {
      // in-memory runtime session gone (server restart): resume by thread and retry once
      if (
        (err instanceof RuntimeError || err instanceof SkillRuntimeError) &&
        /unknown (mock )?session/.test(err.message)
      ) {
        const rid = await this.resumeRuntimeSession(sessionId);
        produced = await interviewer.execute(
          interviewerInput,
          this.ctx({ sessionId, runtimeSessionId: rid }),
        );
      } else {
        throw err;
      }
    }

    const questionId = newId("q");
    this.store.insertQuestion({
      id: questionId,
      sessionId,
      skillId: produced.skillId,
      topic: produced.topic,
      text: produced.question,
      subSkills: produced.subSkills,
      expectedConcepts: produced.expectedConcepts,
      difficulty: produced.difficulty,
      selectionPriority: selection.priority,
      selectionReason: selection.reason,
      position: questions.length + 1,
      createdAt: this.iso(),
    });
    this.store.updateSession(sessionId, { currentRound: questions.length + 1 });
    const row = this.store.getQuestion(questionId)!;
    return { session: this.store.getSession(sessionId), question: rowToQuestion(row) };
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
    answerText: string,
    opts?: ProgressOptions,
  ): Promise<SubmitAnswerResult> {
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
        createdAt: this.iso(),
      });
      this.transitionSession(sessionId, "evaluating", "evaluate");

      const { candidate, target } = this.requireActive();
      let evaluation: AnswerEvaluation;
      let skillImpact: SubmitAnswerResult["skillImpact"];
      const newActions: PrepActionRowLike[] = [];
      opts?.onProgress?.({ stage: "evaluating answer" });
      try {
        evaluation = await answerEvaluator.execute(
          {
            question: {
              text: active.text,
              topic: active.topic,
              skillId: active.skillId,
              expectedConcepts: active.expectedConcepts as ExpectedConcept[],
              difficulty: active.difficulty as "easy" | "medium" | "hard",
            },
            answer: answerText,
            role: target.role,
            level: target.level,
            roundType: (session.roundType ?? "mixed") as RoundType,
          },
          this.ctx({ sessionId, onProgress: opts?.onProgress }),
        );
        AnswerEvaluationSchema.parse(evaluation);
        this.store.insertEvaluation({
          id: newId("eval"),
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
        skillImpact = evaluation.scores.map((s) => ({
          skillId: s.skill,
          before: before.dimensions[s.skill]?.score ?? null,
          after: after.dimensions[s.skill]?.score ?? null,
        }));

        // plan update for medium+ weaknesses
        const weakTargets = evaluation.weaknesses.filter((w) => w.severity !== "low");
        if (weakTargets.length > 0) {
          opts?.onProgress?.({ stage: "updating prep plan" });
          const plan = await prepPlanner.execute(
            {
              targets: weakTargets.map((w) => ({
                skillId: w.skill,
                label: taxonomy.labelFor(w.skill),
                reason: `weak answer: ${w.evidence}`,
                missingConcepts: evaluation.missingConcepts,
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
      const remaining = questions.length < session.plannedQuestions;
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
      return { session: this.store.getSession(sessionId), debrief };
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
      output = await interviewDebrief.execute(
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
      this.store.insertDebrief({
        id: newId("debrief"),
        sessionId,
        data: output as object,
        createdAt: this.iso(),
      });
    }
    return output;
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
    return {
      session,
      questions: this.store.listQuestions(id).map(rowToQuestion),
      answers: this.store.listAnswers(id),
      evaluations: this.store.listEvaluations(id).map((r) => r.data),
      debrief: this.store.getDebrief(id)?.data ?? null,
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
      const out = (await starCoach.execute(
        {
          mode: "generate",
          experience: candidate.experience,
          achievements: candidate.achievements,
          projects: candidate.projects,
          behavioralSkillIds,
          existingTitles: existing.map((s) => s.title),
        },
        this.ctx({ onProgress: opts?.onProgress }),
      )) as { stories: Array<{ title: string; situation: string; task: string; action: string; result: string; skillIds: SkillId[] }> };
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
      return (await starCoach.execute(
        {
          mode: "review",
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

  updateActionStatus(actionId: string, status: "open" | "in_progress" | "done" | "superseded") {
    return this.withLock(async () => {
      this.store.updateActionStatus(actionId, status);
      this.logger.info("state.mutated", { entity: "prep_action", id: actionId, status });
    });
  }

  getRuntimeSessionRow(sessionId: string) {
    return this.store.getRuntimeSession(sessionId);
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

export type OrchestratorQuestion = Question & {
  selectionReason: string | null;
  selectionPriority: number | null;
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
  createdAt: string;
}): OrchestratorQuestion {
  const parseList = <T>(v: unknown): T[] =>
    Array.isArray(v) ? (v as T[]) : JSON.parse(String(v ?? "[]"));
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
    createdAt: row.createdAt,
  };
}
