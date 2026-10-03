import {
  buildReadinessGraph,
  calculateGaps,
  CandidateProfileSchema,
  getCompanyProfile,
  getMode,
  isModeId,
  InterviewOSStateSchema,
  newId,
  taxonomy,
  TargetRoleSchema,
  type AnswerEvaluation,
  type CandidateProfile,
  type Gap,
  type InterviewOSState,
  type LoopRound,
  type Question,
  type ReadinessGraph,
  type RoundType,
  type SkillId,
  type TargetRole,
} from "@interview-os/core";
import { AppError } from "@interview-os/core";
import type { WorkflowContext } from "./context.js";
import type { SessionRow } from "./store/index.js";
import { rowToAction, rowToQuestion, type PrepActionRowLike } from "./projection.js";

export interface HistoryServiceDeps {
  ctx: WorkflowContext;
  graphForActive(): ReadinessGraph;
  calculateGaps(): Gap[];
}

export class HistoryService {
  /** §9.7: event names the API accepts. Events carry a name + timestamp only —
   * never content (resumes, answers, notes). */
  static readonly USAGE_EVENTS = [
    "history.viewed",
    "target.switched",
    "resume.coach.used",
    "palette.used",
  ] as const;

  constructor(private readonly deps: HistoryServiceDeps) {}

  private get ctx(): WorkflowContext {
    return this.deps.ctx;
  }

  private get store() {
    return this.ctx.store;
  }

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

    const evidence = candidateRow ? this.ctx.evidenceForActive(candidate.id) : [];
    const requirements = targetRow ? this.ctx.allRequirements(target) : [];
    const graph =
      evidence.length || requirements.length
        ? buildReadinessGraph({ evidence, requirements, taxonomy })
        : { dimensions: {}, overall: 0, overallConfidence: 0, lastUpdated: this.ctx.iso() };
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
    const graph = this.deps.graphForActive();
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

  recordUsageEvent(event: string) {
    if (!HistoryService.USAGE_EVENTS.includes(event as never)) {
      throw new AppError("VALIDATION", `unknown usage event "${event}"`);
    }
    this.store.insertUsageEvent({ id: newId("evt"), event, createdAt: this.ctx.iso() });
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
    // evaluations persisted before §9.1 may lack `rubric`/`scores` in stored
    // JSON even though the current schema defaults them — guard both
    const vals =
      (ev.rubric?.length ?? 0) > 0
        ? ev.rubric.map((d) => d.score)
        : (ev.scores ?? []).map((s) => s.score);
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
        // sessions persisted before modes existed may carry a roundType with
        // no registered mode — fall back to mixed instead of crashing history
        modeLabel: getMode(isModeId(s.roundType) ? s.roundType : "mixed").label,
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
        HistoryService.USAGE_EVENTS.map((e) => [
          e,
          this.store.countUsageEvents(e),
        ]),
      ),
    };
  }
}

export type { PrepActionRowLike };
