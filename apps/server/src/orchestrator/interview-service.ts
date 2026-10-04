import {
  AnswerEvaluationSchema,
  getMode,
  newId,
  QuestionCandidateSchema,
  normalizeEvaluation,
  nextUncoveredDimension,
  taxonomy,
  transition,
  type AnswerEvaluation,
  type ExpectedConcept,
  type InterviewStatus,
  type ModeState,
  type PackItem,
  type PluginInterviewMode,
  type QuestionCandidate,
  type RoundType,
  type SkillId,
  type SystemDesignState,
  type TargetRole,
  voiceFeedback,
  type VoiceFeedback,
  type VoiceMetrics,
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
import type { PluginReview } from "./plugin-service.js";
import { QuestionSourcesSchema, type QuestionSources } from "./settings-service.js";
import {
  rowToQuestion,
  type PrepActionRowLike,
} from "./projection.js";
import type { SessionRow } from "./store/index.js";

/** Question-text comparison for "don't re-ask" — case/whitespace-insensitive. */
function normalizeQuestionText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ").replace(/[?.!]+$/, "");
}

export interface StartInterviewInput {
  plannedQuestions?: number;
  mode?: "interview" | "practice";
  focusSkillId?: SkillId;
  actionId?: string;
  /** §8.4 round type; practice sessions ignore it (focus skill wins). */
  roundType?: RoundType;
  /** v0.4: stored external context (MCP fetch) to ground questions on. */
  contextId?: string;
  /** v0.4: "<pluginId>:<modeId>" — a plugin-declared interview mode. */
  pluginModeId?: string;
}

export interface SubmitAnswerInput {
  text: string;
  /** §9.1 coding rounds: optional submitted code (reviewed, not executed). */
  code?: string;
  language?: string;
  /** v0.4 voice mode: client-measured delivery metrics (feedback only). */
  voice?: VoiceMetrics;
}

export interface SubmitAnswerResult {
  evaluation: AnswerEvaluation;
  skillImpact: Array<{ skillId: SkillId; before: number | null; after: number | null }>;
  newActions: PrepActionRowLike[];
  nextAvailable: "question" | "complete";
  /** v0.4: delivery hints, present only when the client sent voice metrics. */
  voiceFeedback: VoiceFeedback | null;
  /** v1: review observations from `evaluation` plugins (attributed). */
  pluginReviews?: PluginReviewPublic[];
}

/** Plugin review observations surfaced on a submitted answer. */
export interface PluginReviewPublic {
  pluginId: string;
  pluginName: string;
  observations: { text: string; tone: string }[];
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
  loopContextFor(session: SessionRow): Promise<{
    priorWeakSkills: { skillId: SkillId; round: number; mode: RoundType }[];
    priorRoundObservations: string[];
  }>;
  /** v0.4: run a question-source plugin; returns raw output or throws. */
  runQuestionPlugin(id: string, request: unknown): Promise<unknown>;
  /** v0.4: ids of enabled+compatible question_source plugins. */
  enabledQuestionPlugins(): Promise<string[]>;
  /** v0.4: resolve a "<pluginId>:<modeId>" interview mode (enabled+compatible). */
  pluginInterviewMode(
    pluginModeId: string,
  ): Promise<{ pluginId: string; mode: PluginInterviewMode }>;
  /** v1: evaluation.review hooks — optional; absent means no review plugins. */
  evaluationReviews?: (args: {
    question: {
      skillId: string;
      text: string;
      roundType: RoundType;
      expectedConcepts: string[];
    };
    evaluation: AnswerEvaluation;
    answer: { text: string; code?: string; language?: string };
  }) => Promise<PluginReview[]>;
  /** v1: persist gated plugin-event/review evidence under the lock. */
  persistPluginEvidence?: (
    pluginId: string,
    proposals: unknown[],
  ) => Promise<{ written: number; ignored: number }>;
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
    const { candidate, target } = await this.ctx.requireActive();
    const mode = input.mode ?? "interview";
    if (mode === "practice" && !input.focusSkillId) {
      throw new AppError("VALIDATION", "practice sessions require focusSkillId");
    }
    if (input.actionId) {
      const action = await this.store.getAction(input.actionId);
      if (!action) throw new AppError("NOT_FOUND", `no prep action ${input.actionId}`);
    }
    if (input.contextId) {
      const context = await this.store.getExternalContext(input.contextId);
      if (!context) throw new AppError("NOT_FOUND", `no external context ${input.contextId}`);
    }
    // v0.4: a plugin interview mode fixes roundType/plan/focus skills
    let pluginFocusSkills: SkillId[] = [];
    if (input.pluginModeId) {
      const { mode: pMode } = await this.deps.pluginInterviewMode(input.pluginModeId);
      input.roundType = pMode.roundType;
      input.plannedQuestions = pMode.plannedQuestions;
      pluginFocusSkills = pMode.focusSkills;
    }
    // practice sessions are single-question verifications
    const plannedQuestions = mode === "practice" ? 1 : (input.plannedQuestions ?? 4);
    const roundType = input.roundType ?? "mixed";
    const sessionId = newId("int");
    const createdAt = this.ctx.iso();
    await this.store.insertSession({
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
      contextId: input.contextId ?? null,
      focusSkills: pluginFocusSkills,
      pluginModeId: input.pluginModeId ?? null,
      createdAt,
    });
    await this.ctx.transitionSession(sessionId, "analyzing", "analyze");
    await this.ctx.transitionSession(sessionId, "ready", "analysis_complete");

    // runtime session for the interviewer thread
    const rtSession = await this.ctx.runtime.createSession({
      developerInstructions: INTERVIEWER_SESSION_INSTRUCTIONS,
    });
    await this.store.insertRuntimeSession({
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
    const session = await this.store.getSession(sessionId);
    if (!session) throw new AppError("NOT_FOUND", `no session ${sessionId}`);
    const questions = await this.store.listQuestions(sessionId);
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
    if (pendingFollowUp) await this.store.updateSession(sessionId, { modeState });

    // §9.1: follow-ups don't count toward plannedQuestions — count mains only
    const mainCount = questions.filter((q) => !q.followUpOf).length;
    if (status === "ready") {
      await this.ctx.transitionSession(sessionId, "question", "ask");
    } else if (status === "follow_up") {
      if (!pendingFollowUp && mainCount >= session.plannedQuestions) {
        await this.ctx.transitionSession(sessionId, "complete", "complete");
        return { session: await this.store.getSession(sessionId), question: null };
      }
      await this.ctx.transitionSession(sessionId, "question", "next");
    } else {
      // produces InvalidTransitionError for anything else
      transition(status, "ask");
    }

    const { candidate, target } = await this.ctx.requireActive();
    const graph = await this.deps.readiness.graphForActive();
    const evidence = await this.ctx.evidenceForActive(candidate.id);
    const previousSession = (await this.store.listSessions())
      .find((s) => s.id !== sessionId && s.status !== "created" && s.status !== "analyzing");
    const askedPreviousSession = previousSession
      ? (await this.store.listQuestions(previousSession.id)).map((q) => q.skillId as SkillId)
      : [];
    const allPreviousTexts: string[] = [];
    for (const s of await this.store.listSessions()) {
      for (const q of await this.store.listQuestions(s.id)) allPreviousTexts.push(q.text);
    }

    // §9.4: loop sessions carry prior rounds' weak skills + observations forward
    const { priorWeakSkills, priorRoundObservations } = await this.deps.loopContextFor(session);
    // v0.4: loops feed pack focus skills; standalone sessions feed their own
    // (plugin interview-mode) focus skills.
    const focusSkills: SkillId[] = session.loopId
      ? (((await this.store.getLoop(session.loopId))?.focusSkills as SkillId[] | undefined) ?? [])
      : ((session.focusSkills as SkillId[] | undefined) ?? []);

    let skillId: SkillId;
    let questionReason: string;
    let questionPriority: number | null;
    let questionDifficulty: "easy" | "medium" | "hard" | undefined;
    let selectionFactors: Record<string, number> | null = null;
    let followUpOf: string | null = null;
    let followUpFocus: string | null = null;

    if (pendingFollowUp) {
      const parent = await this.store.getQuestion(pendingFollowUp.parentQuestionId);
      skillId = (parent?.skillId ?? "communication") as SkillId;
      questionReason = `follow-up on "${pendingFollowUp.focus}"`;
      questionPriority = null;
      questionDifficulty = (parent?.difficulty as "easy" | "medium" | "hard" | undefined) ?? "medium";
      followUpOf = pendingFollowUp.parentQuestionId;
      followUpFocus = pendingFollowUp.focus;
    } else {
      opts?.onProgress?.({ stage: "selecting skill" });
      const askCounts: Record<SkillId, number> = {};
      for (const s of await this.store.listSessions()) {
        for (const q of await this.store.listQuestions(s.id)) {
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
                focusSkills,
              },
              await this.ctx.ctx({ sessionId }),
            );
      if (!selection) {
        await this.ctx.transitionSession(sessionId, "complete", "complete");
        return { session: await this.store.getSession(sessionId), question: null };
      }
      skillId = selection.skillId;
      questionReason = selection.reason;
      questionPriority = selection.priority;
      questionDifficulty = selection.difficulty;
      selectionFactors = selection.factors as unknown as Record<string, number>;
    }

    // v0.4: question sources only feed main questions, never follow-ups. The
    // orchestrator picked the skill — a source only suggests the question text.
    let seedQuestion: { text: string; expectedConcepts?: string[]; sourceLabel: string } | null =
      null;
    let questionSource: QuestionCandidate["source"] | null = null;
    if (!pendingFollowUp) {
      const candidate = await this.pickSourcedQuestion(
        target,
        skillId,
        roundType,
        allPreviousTexts,
      );
      if (candidate) {
        seedQuestion = {
          text: candidate.text,
          expectedConcepts: candidate.expectedConcepts,
          sourceLabel:
            candidate.source.kind === "plugin"
              ? `plugin:${candidate.source.id}`
              : candidate.source.kind === "user_bank"
                ? "your question bank"
                : `${candidate.source.kind === "company_pack" ? "company" : "role"} pack "${candidate.source.id}"`,
        };
        questionSource = candidate.source;
      }
    }

    // v0.4: a stored external context grounds the question (untrusted data).
    const externalContext = session.contextId
      ? await (async () => {
          const row = await this.store.getExternalContext(session.contextId!);
          return row ? { title: row.title, text: row.text } : null;
        })()
      : null;

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
      companyGuidance: await this.companyGuidanceFor(
        target,
        roundType,
        session.pluginModeId as string | null,
      ),
      difficulty: questionDifficulty,
      focusDimension:
        roundType === "system_design"
          ? pendingFollowUp
            ? null
            : (nextUncoveredDimension(modeState as SystemDesignState) ?? null)
          : null,
      companyThemes: narrativeRound ? (target.companyProfile?.behavioralThemes ?? []) : [],
      storyTitles: narrativeRound
        ? (await this.store.listStories(candidate.id)).map((s) => s.title).slice(0, 10)
        : [],
      priorRoundObservations,
      seedQuestion,
      roleRubric: await this.roleRubricFor(target, skillId, roundType),
      externalContext,
    };

    const runtimeSessionId = await this.ensureRuntimeSession(sessionId);
    const interviewCtx = await this.ctx.ctx({
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
          await this.ctx.ctx({ sessionId, runtimeSessionId: rid }),
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
    if (questionSource) extra.source = questionSource;
    await this.store.insertQuestion({
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
    await this.store.updateSession(sessionId, { currentRound: questions.length + 1 });
    const row = (await this.store.getQuestion(questionId))!;
    return { session: await this.store.getSession(sessionId), question: rowToQuestion(row) };
  }

  /** §9.3: rendered profile guidance fed to interviewer/evaluator prompts. */
  async companyGuidanceFor(
    target: TargetRole,
    roundType: RoundType,
    pluginModeId?: string | null,
  ): Promise<string> {
    await this.ctx.packs.ready();
    const profile = this.ctx.packs.companyProfile(target.companyProfileId ?? "generic");
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
    // v1: plugin interview-mode guidance is untrusted pack-like text —
    // rendered with provenance so the model weights it accordingly.
    let pluginGuidanceLines = 0;
    if (pluginModeId) {
      const pluginId = pluginModeId.slice(0, pluginModeId.indexOf(":"));
      try {
        const { mode } = await this.deps.pluginInterviewMode(pluginModeId);
        if (mode.guidance) {
          lines.push(
            `Plugin mode guidance (${pluginId}, unverified): ${mode.guidance.slice(0, 1500)}`,
          );
          pluginGuidanceLines = 1;
        }
      } catch {
        /* plugin disabled/removed mid-session — guidance simply omitted */
      }
    }
    // v0.4: pack items render their provenance — sourced lines name the source,
    // community lines are marked unverified.
    const pack = this.ctx.packs.companyPack(profile.id);
    if (pack) {
      const renderItems = (heading: string, items: PackItem[]) => {
        for (const item of items) {
          lines.push(
            item.provenance === "sourced"
              ? `${heading} Sourced (${this.packSourceTitle(pack.sources, item.source)}): ${item.text}`
              : `${heading} Community observation (unverified): ${item.text}`,
          );
        }
      };
      renderItems("Competency:", pack.competencies);
      renderItems("Question style:", pack.questionStyle);
      renderItems("Evaluation guidance:", pack.evaluationGuidance);
      for (const overlay of pack.overlays) {
        if (!this.ctx.packs.overlayApplies(overlay, target.role, roundType)) continue;
        renderItems("Overlay competency:", overlay.competencies);
        renderItems("Overlay question style:", overlay.questionStyle);
        renderItems("Overlay evaluation guidance:", overlay.evaluationGuidance);
      }
      // cap the pack-authored portion of the guidance block
      const head = lines.slice(
        0,
        3 +
          (expectations?.length ? 1 : 0) +
          (roundType !== "mixed" ? 1 : 0) +
          pluginGuidanceLines,
      );
      const tail = lines.slice(head.length);
      const budget = 1500;
      const kept: string[] = [];
      let used = 0;
      for (const line of tail) {
        if (used + line.length > budget) break;
        kept.push(line);
        used += line.length;
      }
      return [...head, ...kept].join("\n");
    }
    return lines.join("\n");
  }

  private packSourceTitle(
    sources: { id: string; title: string }[],
    id: string | undefined,
  ): string {
    return sources.find((s) => s.id === id)?.title ?? id ?? "unknown";
  }

  /** Role-pack rubric lines for the interviewer + evaluator. */
  private async roleRubricFor(
    target: TargetRole,
    skillId: SkillId,
    roundType: RoundType,
  ): Promise<string[]> {
    await this.ctx.packs.ready();
    const criteria = this.ctx.packs.roleRubrics(target.rolePackId, skillId, roundType);
    const pack = target.rolePackId ? this.ctx.packs.rolePack(target.rolePackId) : undefined;
    return criteria.length > 0 && pack
      ? criteria.map((c) => `Role rubric (${pack.name}): ${c}`)
      : criteria;
  }

  /** Settings-backed question-source toggles. */
  private async questionSources(): Promise<QuestionSources> {
    const raw = await this.store.getSetting("questionSources");
    if (!raw) return QuestionSourcesSchema.parse({});
    const parsed = QuestionSourcesSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : QuestionSourcesSchema.parse({});
  }

  /**
   * v0.4 question sources, in priority order: user bank → company pack
   * (overlay questions first) → role pack → plugins. Only eligible candidates
   * (exact/descendant skill, mode-compatible, never asked before) are offered.
   */
  private async pickSourcedQuestion(
    target: TargetRole,
    skillId: SkillId,
    roundType: RoundType,
    allPreviousTexts: string[],
  ): Promise<QuestionCandidate | null> {
    const settings = await this.questionSources();
    await this.ctx.packs.ready();
    const asked = new Set(allPreviousTexts.map(normalizeQuestionText));
    const eligible = (c: QuestionCandidate) => !asked.has(normalizeQuestionText(c.text));

    const candidates: QuestionCandidate[] = [];
    if (settings.userBank) {
      const rows = await this.store.listUserQuestions();
      for (const r of rows) {
        const matches =
          r.skillId === skillId || r.skillId.startsWith(`${skillId}.`);
        const modeOk = !r.mode || r.mode === roundType || roundType === "mixed";
        if (!matches || !modeOk) continue;
        candidates.push({
          skillId: r.skillId as SkillId,
          text: r.text,
          difficulty: (r.difficulty ?? undefined) as QuestionCandidate["difficulty"],
          mode: (r.mode ?? undefined) as QuestionCandidate["mode"],
          source: { kind: "user_bank", id: r.id },
        });
      }
    }
    if (settings.companyPacks) {
      candidates.push(
        ...this.ctx.packs.companyPackQuestions(
          target.companyProfileId ?? "generic",
          skillId,
          roundType,
          target.role,
        ),
      );
    }
    if (settings.rolePacks && target.rolePackId) {
      candidates.push(
        ...this.ctx.packs.rolePackQuestions(target.rolePackId, skillId, roundType),
      );
    }
    if (settings.plugins.length > 0) {
      const enabled = new Set(await this.deps.enabledQuestionPlugins());
      for (const pluginId of settings.plugins) {
        if (!enabled.has(pluginId)) continue;
        try {
          const output = await this.deps.runQuestionPlugin(pluginId, {
            kind: "questions",
            skillId,
            roundType,
            level: target.level,
            count: 5,
          });
          const list = (output as { questions?: unknown[] })?.questions;
          if (!Array.isArray(list)) continue;
          let dropped = 0;
          for (const q of list) {
            const parsed = QuestionCandidateSchema.safeParse({
              ...(q as object),
              source: { kind: "plugin", id: pluginId },
            });
            if (!parsed.success) {
              dropped += 1;
              continue;
            }
            if (
              (parsed.data.skillId === skillId || parsed.data.skillId.startsWith(`${skillId}.`)) &&
              (!parsed.data.mode || parsed.data.mode === roundType || roundType === "mixed")
            ) {
              candidates.push(parsed.data);
            }
          }
          if (dropped > 0) {
            this.ctx.logger.warn("questionsource.invalid", {
              plugin: pluginId,
              dropped,
            });
          }
        } catch (err) {
          // a failing question source never breaks the interview flow
          this.ctx.logger.warn("questionsource.failed", {
            plugin: pluginId,
            error: (err as Error).message.slice(0, 200),
          });
        }
      }
    }
    return candidates.find(eligible) ?? null;
  }

  private async ensureRuntimeSession(sessionId: string): Promise<string | undefined> {
    const row = await this.store.getRuntimeSession(sessionId);
    if (!row) return undefined;
    return row.runtimeSessionId;
  }

  private async resumeRuntimeSession(sessionId: string): Promise<string> {
    const row = await this.store.getRuntimeSession(sessionId);
    if (!row) throw new AppError("NOT_FOUND", `no runtime session for ${sessionId}`);
    const rtSession = await this.ctx.runtime.resumeSession(row.threadId, {
      developerInstructions: INTERVIEWER_SESSION_INSTRUCTIONS,
    });
    await this.store.updateRuntimeSessionStatus(row.id, "resumed");
    await this.store.insertRuntimeSession({
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
    const {
      text: answerText,
      code = null,
      language = null,
      voice = null,
    } = typeof answer === "string" ? { text: answer } : answer;
    // v0.4 voice mode: feedback is computed server-side from the transcript —
    // the client supplies only raw metrics, never counts.
    const feedback = voice ? voiceFeedback(voice, answerText) : null;
    const session = await this.store.getSession(sessionId);
    if (!session) throw new AppError("NOT_FOUND", `no session ${sessionId}`);
    const questions = await this.store.listQuestions(sessionId);
    let active: (typeof questions)[number] | undefined;
    for (const q of [...questions].reverse()) {
      if (!(await this.store.getEvaluatedAnswerForQuestion(q.id))) {
        active = q;
        break;
      }
    }
    if (!active) {
      throw new AppError("NOT_FOUND", "no unanswered question in session");
    }
    const before = await this.deps.readiness.graphForActive();
    await this.ctx.transitionSession(sessionId, "answer", "answer");
    const answerId = newId("ans");
    await this.store.insertAnswer({
      id: answerId,
      questionId: active.id,
      sessionId,
      text: answerText,
      code,
      language,
      voice: voice ? { metrics: voice, feedback } : null,
      createdAt: this.ctx.iso(),
    });
    await this.ctx.transitionSession(sessionId, "evaluating", "evaluate");

    const roundType = (session.roundType ?? "mixed") as RoundType;
    const modeDef = getMode(roundType);
    const preModeState: ModeState =
      typeof session.modeState === "object" && session.modeState !== null
        ? { ...(session.modeState as ModeState) }
        : {};

    const { candidate, target } = await this.ctx.requireActive();
    let evaluation: AnswerEvaluation;
    let skillImpact: SubmitAnswerResult["skillImpact"];
    let followUpPending = false;
    let pluginReviews: PluginReviewPublic[] | undefined;
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
          companyGuidance: await this.companyGuidanceFor(
            target,
            roundType,
            session.pluginModeId as string | null,
          ),
          roleRubric: await this.roleRubricFor(target, active.skillId as SkillId, roundType),
        },
        await this.ctx.ctx({ sessionId, onProgress: opts?.onProgress }),
      );
      // defensive: merge duplicate per-skill entries before persisting
      evaluation = normalizeEvaluation(AnswerEvaluationSchema.parse(evaluation));
      // §9.6: the evaluator's outputs persist evaluation + evidence rows.
      this.ctx.host.assertCan("answer-evaluator", "interview.write");
      this.ctx.host.assertCan("answer-evaluator", "evidence.write");
      const evalId = newId("eval");
      await this.store.insertEvaluation({
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
        await this.store.insertEvidence({
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
        await this.ctx.registerSkillNode(skillId);
      }

      opts?.onProgress?.({ stage: "updating readiness" });
      const after = await this.deps.readiness.recomputeReadinessInternal("answer");
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
      await this.store.updateEvaluationDelta(
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
          await this.ctx.ctx({ sessionId }),
        );
        for (const a of plan.actions) {
          const skillId = a.skillId as SkillId;
          const severity = weakTargets.find((w) => w.skill === skillId)?.severity;
          newActions.push(
            await this.deps.preparation.insertPlannedAction(
              skillId,
              a,
              candidate.id,
              severity ?? "medium",
              target.id,
            ),
          );
        }
        await this.deps.preparation.renumberActionPriorities(
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
          await this.store.updateActionStatus(session.actionId, "done");
        } else {
          const action = await this.store.getAction(session.actionId);
          if (action) {
            const existing = (action.sourceEvidenceIds ?? []) as string[];
            await this.store.updateActionSourceEvidence(session.actionId, [
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
        const maxDepth = this.ctx.packs.companyProfile(
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
      // v1: after the built-in evaluation persists, `evaluation` plugins
      // review the answer (answer text only when granted `answers.read`).
      // Observations attach to the answer row; evidence proposals go through
      // the standard gate. Plugin failures were already logged+skipped.
      if (this.deps.evaluationReviews) {
        const reviews = await this.deps.evaluationReviews({
          question: {
            skillId: active.skillId,
            text: active.text,
            roundType,
            expectedConcepts: (
              (active.expectedConcepts as ExpectedConcept[] | undefined) ?? []
            )
              .map((c) => c.concept)
              .slice(0, 16),
          },
          evaluation,
          answer: {
            text: answerText,
            ...(code ? { code } : {}),
            ...(language ? { language } : {}),
          },
        });
        if (reviews.length > 0) {
          pluginReviews = reviews.map((r) => ({
            pluginId: r.pluginId,
            pluginName: r.pluginName,
            observations: r.observations,
          }));
          await this.store.updateAnswerPluginReviews(answerId, pluginReviews);
          for (const r of reviews) {
            if (r.evidenceProposals.length > 0) {
              await this.deps.persistPluginEvidence?.(
                r.pluginId,
                r.evidenceProposals,
              );
            }
          }
        }
      }

      await this.store.updateSession(sessionId, { modeState });
    } catch (err) {
      // keep the session usable: mark the stored answer failed and roll the
      // session back to QUESTION so the answer can be resubmitted.
      await this.store.updateAnswerStatus(answerId, "failed");
      await this.ctx.transitionSession(sessionId, "question", "evaluation_failed");
      this.ctx.logger.warn("evaluation.failed", {
        sessionId,
        questionId: active.id,
        error: (err as Error).message,
      });
      throw err;
    }

    await this.ctx.transitionSession(sessionId, "follow_up", "follow_up");
    const mainCount = questions.filter((q) => !q.followUpOf).length;
    const remaining = followUpPending || mainCount < session.plannedQuestions;
    return {
      evaluation,
      skillImpact,
      newActions,
      nextAvailable: remaining ? "question" : "complete",
      voiceFeedback: feedback,
      pluginReviews,
    };
  }
}
