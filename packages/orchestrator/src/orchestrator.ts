import {
  AnswerEvaluationSchema,
  buildReadinessGraph,
  calculateGaps,
  CandidateProfileSchema,
  InterviewOSStateSchema,
  selectNextSkill,
  taxonomy,
  TargetRoleSchema,
  transition,
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
  interviewDebrief,
  interviewer,
  jdAnalyzer,
  prepPlanner,
  resumeAnalyzer,
  SkillRuntimeError,
  taxonomyEntries,
  type JdAnalyzerOutput,
  type PrepPlannerOutput,
  type ResumeAnalyzerOutput,
  type SkillContext,
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

  private ctx(extra?: Partial<SkillContext>): SkillContext {
    return {
      runtime: this.runtime,
      logger: this.logger,
      now: this.now,
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

  async setupWorkspace(input: SetupWorkspaceInput) {
    return this.withLock(async () => {
      this.logger.info("workflow.started", { workflow: "setupWorkspace" });
      try {
        // resume and JD analysis are independent — run them concurrently;
        // persistence stays sequential.
        const [candidateOut, targetOut] = await Promise.all([
          resumeAnalyzer.execute(
            { resumeText: input.resumeText, taxonomy: taxonomyEntries() },
            this.ctx(),
          ),
          jdAnalyzer.execute(
            {
              jobDescription: input.jobDescription,
              company: input.company,
              role: input.role,
              level: input.level,
              taxonomy: taxonomyEntries(),
            },
            this.ctx(),
          ),
        ]);
        const candidate = this.persistCandidate(input.resumeText, candidateOut);
        const target = this.persistTarget(input, targetOut);
        this.recomputeReadinessInternal("setup");
        const gaps = this.calculateGapsInternal();
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

  async analyzeTarget(input: {
    jobDescription: string;
    company: string;
    role: string;
    level: Level;
  }): Promise<TargetRole> {
    return this.withLock(() => this.analyzeTargetInternal(input));
  }

  private async analyzeTargetInternal(input: {
    jobDescription: string;
    company: string;
    role: string;
    level: Level;
  }): Promise<TargetRole> {
    const output = await jdAnalyzer.execute(
      { ...input, taxonomy: taxonomyEntries() },
      this.ctx(),
    );
    return this.persistTarget(input, output);
  }

  private persistTarget(
    input: { jobDescription: string; company: string; role: string; level: Level },
    output: JdAnalyzerOutput,
  ): TargetRole {
    const target: TargetRole = {
      id: newId("target"),
      company: input.company,
      role: input.role,
      level: input.level,
      jobDescription: input.jobDescription,
      requirements: output.requirements,
      preferredSkills: output.preferredSkills,
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
      this.store.listActions("open").map((a) => a.skillId),
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
        created.push(this.insertPlannedAction(t.skillId, action, candidate.id, t.severity));
      });
    }

    this.renumberActionPriorities(this.allRequirements(target));

    const actions = this.store
      .listActions()
      .filter((a) => a.status === "open" || a.status === "in_progress")
      .map(rowToAction);
    return { actions, created };
  }

  private insertPlannedAction(
    skillId: SkillId,
    action: { action: string; successCriteria: string[]; reason: string },
    candidateId: string,
    severity: "low" | "medium" | "high" = "medium",
  ): PrepActionRowLike {
    const existing = this.store.openActionForSkill(skillId);
    if (existing) this.store.updateActionStatus(existing.id, "superseded");
    const sourceEvidenceIds = this.store
      .evidenceForSkill(skillId, candidateId)
      .map((e) => e.id);
    const row = {
      id: newId("action"),
      skillId,
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
  private renumberActionPriorities(requirements: Requirement[]): void {
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
      .listActions()
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

  async startInterview(input: { plannedQuestions?: number } = {}) {
    return this.withLock(async () => {
      const { candidate, target } = this.requireActive();
      const plannedQuestions = input.plannedQuestions ?? 4;
      const sessionId = newId("int");
      const createdAt = this.iso();
      this.store.insertSession({
        id: sessionId,
        candidateId: candidate.id,
        targetId: target.id,
        status: "created",
        plannedQuestions,
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
      return this.nextQuestionInternal(sessionId);
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

  async nextQuestion(sessionId: string) {
    return this.withLock(() => this.nextQuestionInternal(sessionId));
  }

  private async nextQuestionInternal(sessionId: string) {
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

    const selection = selectNextSkill({
      requirements: this.allRequirements(target),
      readiness: graph.dimensions,
      evidence,
      askedThisSession: questions.map((q) => q.skillId as SkillId),
      askedPreviousSession,
      questionIndex: questions.length,
    });
    if (!selection) {
      this.transitionSession(sessionId, "complete", "complete");
      return { session: this.store.getSession(sessionId), question: null };
    }

    const runtimeSessionId = await this.ensureRuntimeSession(sessionId);
    const interviewCtx = this.ctx({ sessionId, runtimeSessionId });
    let produced;
    try {
      produced = await interviewer.execute(
        {
          skillId: selection.skillId,
          label: taxonomy.labelFor(selection.skillId),
          role: target.role,
          level: target.level,
          company: target.company,
          reason: selection.reason,
          previousQuestions: [...allPreviousTexts],
          candidateSummary: `${candidate.name ?? "candidate"} — ${candidate.headline ?? ""}`.trim(),
        },
        interviewCtx,
      );
    } catch (err) {
      // in-memory runtime session gone (server restart): resume by thread and retry once
      if (
        (err instanceof RuntimeError || err instanceof SkillRuntimeError) &&
        /unknown (mock )?session/.test(err.message)
      ) {
        const rid = await this.resumeRuntimeSession(sessionId);
        produced = await interviewer.execute(
          {
            skillId: selection.skillId,
            label: taxonomy.labelFor(selection.skillId),
            role: target.role,
            level: target.level,
            company: target.company,
            reason: selection.reason,
            previousQuestions: [...allPreviousTexts],
            candidateSummary: `${candidate.name ?? "candidate"} — ${candidate.headline ?? ""}`.trim(),
          },
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

  async submitAnswer(sessionId: string, answerText: string): Promise<SubmitAnswerResult> {
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
          },
          this.ctx({ sessionId }),
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

        const evidenceCreatedAt = this.iso();
        for (const s of evaluation.scores) {
          const skillId = s.skill;
          const match =
            evaluation.weaknesses.find((w) => w.skill === skillId)?.evidence ??
            evaluation.strengths.find((st) => st.skill === skillId)?.evidence ??
            evaluation.summary;
          this.store.insertEvidence({
            id: newId("ev"),
            candidateId: candidate.id,
            skillId,
            type: "interview_answer",
            score: s.score,
            confidence: s.confidence,
            observation: match,
            sessionId,
            questionId: active.id,
            createdAt: evidenceCreatedAt,
          });
          this.registerSkillNode(skillId);
        }

        const after = this.recomputeReadinessInternal("answer");
        skillImpact = evaluation.scores.map((s) => ({
          skillId: s.skill,
          before: before.dimensions[s.skill]?.score ?? null,
          after: after.dimensions[s.skill]?.score ?? null,
        }));

        // plan update for medium+ weaknesses
        const weakTargets = evaluation.weaknesses.filter((w) => w.severity !== "low");
        if (weakTargets.length > 0) {
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
              this.insertPlannedAction(skillId, a, candidate.id, severity ?? "medium"),
            );
          });
          this.renumberActionPriorities(this.allRequirements(target));
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

  async completeInterview(sessionId: string) {
    return this.withLock(async () => {
      const session = this.store.getSession(sessionId);
      if (!session) throw new AppError("NOT_FOUND", `no session ${sessionId}`);
      const status = session.status as InterviewStatus;
      if (status === "follow_up" || status === "question") {
        this.transitionSession(sessionId, "complete", "complete");
        this.store.updateSession(sessionId, { completedAt: this.iso() });
      }
      const debrief = await this.createDebriefInternal(sessionId);
      return { session: this.store.getSession(sessionId), debrief };
    });
  }

  async createDebrief(sessionId: string) {
    return this.withLock(() => this.createDebriefInternal(sessionId));
  }

  private async createDebriefInternal(sessionId: string) {
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
        this.ctx({ sessionId }),
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

    const openActions = this.store.listActions("open").map(rowToAction);
    const inProgress = this.store.listActions("in_progress").map(rowToAction);
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
    const evidence = this.store.evidenceForSkill(skillId, candidate.id);
    const history = this.store.readinessHistory(skillId);
    const actions = this.store.actionsForSkill(skillId).map(rowToAction);
    const openAction = this.store.openActionForSkill(skillId);
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
    return this.store.listSessions().map((s) => ({
      ...s,
      questions: this.store.listQuestions(s.id).length,
      debrief: this.store.getDebrief(s.id)?.data ?? null,
    }));
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
