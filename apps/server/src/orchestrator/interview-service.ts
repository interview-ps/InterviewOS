import {
  AnswerEvaluationSchema,
  getCompanyProfile,
  getMode,
  newId,
  normalizeEvaluation,
  nextUncoveredDimension,
  taxonomy,
  transition,
  type AnswerEvaluation,
  type ExpectedConcept,
  type InterviewStatus,
  type ModeState,
  type RoundType,
  type SkillId,
  type SystemDesignState,
  type TargetRole,
} from "@interview-os/core";
import { AppError } from "@interview-os/core";
import { RuntimeError } from "@interview-os/runtime";
import {
  answerEvaluator,
  interviewer,
  interviewPlanner,
  prepPlanner,
  SkillRuntimeError,
} from "../skills/index.js";
import type { WorkflowContext, ProgressOptions } from "./context.js";
import type { ReadinessService } from "./readiness-service.js";
import type { PreparationService } from "./preparation-service.js";
import {
  rowToQuestion,
  type PrepActionRowLike,
} from "./projection.js";
import type { SessionRow } from "./store/index.js";

export interface StartInterviewInput {
  plannedQuestions?: number;
  mode?: "interview" | "practice";
  focusSkillId?: SkillId;
  actionId?: string;
  /** §8.4 round type; practice sessions ignore it (focus skill wins). */
  roundType?: RoundType;
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

export interface InternalStartInput extends StartInterviewInput {
  loopId?: string;
  loopRound?: number;
}

export const INTERVIEWER_SESSION_INSTRUCTIONS = `You are the interviewer thread for Interview OS, a mock-interview tool. Each message asks you to produce ONE interview question as JSON matching the provided schema. Never repeat earlier questions.`;

export interface InterviewServiceDeps {
  ctx: WorkflowContext;
  readiness: ReadinessService;
  preparation: PreparationService;
  /** §9.4: prior-round weak skills/observations, provided by the loop service. */
  loopContextFor(session: SessionRow): {
    priorWeakSkills: { skillId: SkillId; round: number; mode: RoundType }[];
    priorRoundObservations: string[];
  };
}

export class InterviewService {
  constructor(private readonly deps: InterviewServiceDeps) {}

  private get ctx(): WorkflowContext {
    return this.deps.ctx;
  }

  private get store() {
    return this.ctx.store;
  }

  async startInterviewInternal(input: InternalStartInput, opts?: ProgressOptions) {
    const { candidate, target } = this.ctx.requireActive();
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
    const createdAt = this.ctx.iso();
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
    this.ctx.transitionSession(sessionId, "analyzing", "analyze");
    this.ctx.transitionSession(sessionId, "ready", "analysis_complete");

    // runtime session for the interviewer thread
    const rtSession = await this.ctx.runtime.createSession({
      developerInstructions: INTERVIEWER_SESSION_INSTRUCTIONS,
    });
    this.store.insertRuntimeSession({
      id: newId("rts"),
      sessionId,
      runtime: this.ctx.runtime.kind,
      runtimeSessionId: rtSession.id,
      threadId: rtSession.threadId,
      status: "open",
      createdAt: this.ctx.iso(),
    });
    this.ctx.logger.info("workflow.completed", { workflow: "startInterview", sessionId });
    return this.nextQuestionInternal(sessionId, opts);
  }

  async nextQuestionInternal(sessionId: string, opts?: ProgressOptions) {
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
      this.ctx.transitionSession(sessionId, "question", "ask");
    } else if (status === "follow_up") {
      if (!pendingFollowUp && mainCount >= session.plannedQuestions) {
        this.ctx.transitionSession(sessionId, "complete", "complete");
        return { session: this.store.getSession(sessionId), question: null };
      }
      this.ctx.transitionSession(sessionId, "question", "next");
    } else {
      // produces InvalidTransitionError for anything else
      transition(status, "ask");
    }

    const { candidate, target } = this.ctx.requireActive();
    const graph = this.deps.readiness.graphForActive();
    const evidence = this.ctx.evidenceForActive(candidate.id);
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
    const { priorWeakSkills, priorRoundObservations } = this.deps.loopContextFor(session);

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
          : await this.ctx.host.invoke(
              interviewPlanner,
              {
                requirements: this.ctx.allRequirements(target),
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
              this.ctx.ctx({ sessionId }),
            );
      if (!selection) {
        this.ctx.transitionSession(sessionId, "complete", "complete");
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
    const interviewCtx = this.ctx.ctx({
      sessionId,
      runtimeSessionId,
      onProgress: opts?.onProgress,
    });
    opts?.onProgress?.({ stage: "writing question" });
    let produced;
    try {
      produced = await this.ctx.host.invoke(interviewer, interviewerInput, interviewCtx);
    } catch (err) {
      // in-memory runtime session gone (server restart): resume by thread and retry once
      if (
        (err instanceof RuntimeError || err instanceof SkillRuntimeError) &&
        /unknown (mock )?session/.test(err.message)
      ) {
        const rid = await this.resumeRuntimeSession(sessionId);
        produced = await this.ctx.host.invoke(
          interviewer,
          interviewerInput,
          this.ctx.ctx({ sessionId, runtimeSessionId: rid }),
        );
      } else {
        throw err;
      }
    }

    // §9.6: the interviewer skill writes question rows.
    this.ctx.host.assertCan("interviewer", "interview.write");
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
      createdAt: this.ctx.iso(),
    });
    this.store.updateSession(sessionId, { currentRound: questions.length + 1 });
    const row = this.store.getQuestion(questionId)!;
    return { session: this.store.getSession(sessionId), question: rowToQuestion(row) };
  }

  /** §9.3: rendered profile guidance fed to interviewer/evaluator prompts. */
  companyGuidanceFor(target: TargetRole, roundType: RoundType): string {
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
    const rtSession = await this.ctx.runtime.resumeSession(row.threadId, {
      developerInstructions: INTERVIEWER_SESSION_INSTRUCTIONS,
    });
    this.store.updateRuntimeSessionStatus(row.id, "resumed");
    this.store.insertRuntimeSession({
      id: newId("rts"),
      sessionId,
      runtime: this.ctx.runtime.kind,
      runtimeSessionId: rtSession.id,
      threadId: rtSession.threadId,
      status: "open",
      createdAt: this.ctx.iso(),
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
    const session = this.store.getSession(sessionId);
    if (!session) throw new AppError("NOT_FOUND", `no session ${sessionId}`);
    const questions = this.store.listQuestions(sessionId);
    const active = [...questions]
      .reverse()
      .find((q) => !this.store.getEvaluatedAnswerForQuestion(q.id));
    if (!active) {
      throw new AppError("NOT_FOUND", "no unanswered question in session");
    }
    const before = this.deps.readiness.graphForActive();
    this.ctx.transitionSession(sessionId, "answer", "answer");
    const answerId = newId("ans");
    this.store.insertAnswer({
      id: answerId,
      questionId: active.id,
      sessionId,
      text: answerText,
      code,
      language,
      createdAt: this.ctx.iso(),
    });
    this.ctx.transitionSession(sessionId, "evaluating", "evaluate");

    const roundType = (session.roundType ?? "mixed") as RoundType;
    const modeDef = getMode(roundType);
    const preModeState: ModeState =
      typeof session.modeState === "object" && session.modeState !== null
        ? { ...(session.modeState as ModeState) }
        : {};

    const { candidate, target } = this.ctx.requireActive();
    let evaluation: AnswerEvaluation;
    let skillImpact: SubmitAnswerResult["skillImpact"];
    let followUpPending = false;
    const newActions: PrepActionRowLike[] = [];
    opts?.onProgress?.({ stage: "evaluating answer" });
    try {
      evaluation = await this.ctx.host.invoke(
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
        this.ctx.ctx({ sessionId, onProgress: opts?.onProgress }),
      );
      // defensive: merge duplicate per-skill entries before persisting
      evaluation = normalizeEvaluation(AnswerEvaluationSchema.parse(evaluation));
      // §9.6: the evaluator's outputs persist evaluation + evidence rows.
      this.ctx.host.assertCan("answer-evaluator", "interview.write");
      this.ctx.host.assertCan("answer-evaluator", "evidence.write");
      const evalId = newId("eval");
      this.store.insertEvaluation({
        id: evalId,
        answerId,
        questionId: active.id,
        sessionId,
        data: evaluation as unknown as object,
        createdAt: this.ctx.iso(),
      });
      this.ctx.logger.info("evaluation.recorded", {
        sessionId,
        questionId: active.id,
        skillId: active.skillId,
      });

      const evidenceType = session.mode === "practice" ? "practice" : "interview_answer";
      const createdEvidenceIds: string[] = [];
      const evidenceCreatedAt = this.ctx.iso();
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
        this.ctx.registerSkillNode(skillId);
      }

      opts?.onProgress?.({ stage: "updating readiness" });
      const after = this.deps.readiness.recomputeReadinessInternal("answer");
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
        const plan = await this.ctx.host.invoke(
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
          this.ctx.ctx({ sessionId }),
        );
        plan.actions.forEach((a) => {
          const skillId = a.skillId as SkillId;
          const severity = weakTargets.find((w) => w.skill === skillId)?.severity;
          newActions.push(
            this.deps.preparation.insertPlannedAction(
              skillId,
              a,
              candidate.id,
              severity ?? "medium",
              target.id,
            ),
          );
        });
        this.deps.preparation.renumberActionPriorities(
          this.ctx.allRequirements(target),
          target.id,
        );
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
          this.ctx.logger.info("interview.follow_up", {
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
      this.ctx.transitionSession(sessionId, "question", "evaluation_failed");
      this.ctx.logger.warn("evaluation.failed", {
        sessionId,
        questionId: active.id,
        error: (err as Error).message,
      });
      throw err;
    }

    this.ctx.transitionSession(sessionId, "follow_up", "follow_up");
    const mainCount = questions.filter((q) => !q.followUpOf).length;
    const remaining = followUpPending || mainCount < session.plannedQuestions;
    return {
      evaluation,
      skillImpact,
      newActions,
      nextAvailable: remaining ? "question" : "complete",
    };
  }
}
