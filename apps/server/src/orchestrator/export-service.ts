import {
  AppError,
  ExportBundleSchema,
  EXPORT_PARTS,
  EXPORTED_SETTING_KEYS,
  INTERVIEW_OS_VERSION,
  type ExportBundle,
  type ExportPart,
} from "@interview-os/core";
import type { WorkflowContext } from "./context.js";

export type ImportCounts = Record<string, number>;

/**
 * v0.4 export/import. Export is a pure read; import replaces the exported
 * domain in one transaction — validation happens before any write so a bad
 * bundle can never partially apply.
 */
export class ExportService {
  constructor(private readonly ctx: WorkflowContext) {}

  private get store() {
    return this.ctx.store;
  }

  async exportState(): Promise<ExportBundle> {
    const allSettings = await this.store.allSettings();
    const settings = Object.fromEntries(
      EXPORTED_SETTING_KEYS.filter((k) => k in allSettings).map((k) => [
        k,
        allSettings[k]!,
      ]),
    );
    return {
      format: "interview-os.export",
      version: 1,
      appVersion: INTERVIEW_OS_VERSION,
      exportedAt: this.ctx.iso(),
      candidate: { profiles: await this.store.listCandidates() },
      targets: await this.store.listTargets(),
      readiness: { snapshots: await this.store.listAllReadiness() },
      evidence: await this.store.listEvidence(),
      interviews: {
        sessions: await this.store.listSessions(),
        questions: await this.store.listAllQuestions(),
        answers: await this.store.listAllAnswers(),
        evaluations: await this.store.listAllEvaluations(),
        debriefs: await this.store.listAllDebriefs(),
        loops: await this.store.listLoops(),
      },
      preparation: { actions: await this.store.listActions() },
      stories: await this.store.listAllStories(),
      resumeReviews: await this.store.listAllResumeReviews(),
      // user/imported only — bundled packs ship with the repo
      interviewPacks: (await this.store.listInterviewPacks()).filter(
        (p): p is typeof p & { source: "user" | "imported" } =>
          p.source === "user" || p.source === "imported",
      ),
      questionBank: await this.store.listUserQuestions(),
      settings,
      externalContexts: await this.store.listExternalContexts(),
    };
  }

  async exportStatePart(part: ExportPart): Promise<unknown> {
    if (!(EXPORT_PARTS as readonly string[]).includes(part)) {
      throw new AppError("NOT_FOUND", `no export part "${part}"`);
    }
    const bundle = await this.exportState();
    return bundle[part];
  }

  /** Everything that can reject a bundle before a single write happens. */
  private validateBundle(raw: unknown): ExportBundle {
    const parsed = ExportBundleSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new AppError(
        "VALIDATION",
        `invalid export bundle: ${issue?.path.join(".")} ${issue?.message}`,
      );
    }
    const bundle = parsed.data;

    const unique = (rows: { id: unknown }[], table: string) => {
      const seen = new Set<unknown>();
      for (const r of rows) {
        if (seen.has(r.id)) {
          throw new AppError(
            "VALIDATION",
            `duplicate id "${String(r.id)}" in ${table}`,
          );
        }
        seen.add(r.id);
      }
    };
    unique(bundle.candidate.profiles, "candidate.profiles");
    unique(bundle.targets, "targets");
    unique(bundle.evidence, "evidence");
    unique(bundle.interviews.sessions, "interviews.sessions");
    unique(bundle.interviews.questions, "interviews.questions");
    unique(bundle.interviews.answers, "interviews.answers");
    unique(bundle.interviews.evaluations, "interviews.evaluations");
    unique(bundle.interviews.debriefs, "interviews.debriefs");
    unique(bundle.interviews.loops, "interviews.loops");
    unique(bundle.preparation.actions, "preparation.actions");
    unique(bundle.stories, "stories");
    unique(bundle.resumeReviews, "resumeReviews");
    unique(bundle.interviewPacks, "interviewPacks");
    unique(bundle.questionBank, "questionBank");
    unique(bundle.externalContexts, "externalContexts");
    const snapIds = new Set<number>();
    for (const s of bundle.readiness.snapshots) {
      if (snapIds.has(s.id)) {
        throw new AppError("VALIDATION", `duplicate id ${s.id} in readiness.snapshots`);
      }
      snapIds.add(s.id);
    }

    // referential integrity (the checks the spec requires)
    const sessionIds = new Set(bundle.interviews.sessions.map((s) => s.id));
    const questionIds = new Set(bundle.interviews.questions.map((q) => q.id));
    const answerIds = new Set(bundle.interviews.answers.map((a) => a.id));
    const profileIds = new Set(bundle.candidate.profiles.map((p) => p.id));
    for (const q of bundle.interviews.questions) {
      if (!sessionIds.has(q.sessionId)) {
        throw new AppError(
          "VALIDATION",
          `question ${q.id} references missing session ${q.sessionId}`,
        );
      }
    }
    for (const a of bundle.interviews.answers) {
      if (!questionIds.has(a.questionId)) {
        throw new AppError(
          "VALIDATION",
          `answer ${a.id} references missing question ${a.questionId}`,
        );
      }
    }
    for (const e of bundle.interviews.evaluations) {
      if (!answerIds.has(e.answerId)) {
        throw new AppError(
          "VALIDATION",
          `evaluation ${e.id} references missing answer ${e.answerId}`,
        );
      }
    }
    for (const ev of bundle.evidence) {
      if (ev.candidateId !== null && !profileIds.has(ev.candidateId)) {
        throw new AppError(
          "VALIDATION",
          `evidence ${ev.id} references missing candidate ${ev.candidateId}`,
        );
      }
    }
    return bundle;
  }

  async importState(raw: unknown, opts: { mode: "replace" }): Promise<ImportCounts> {
    if (opts.mode !== "replace") {
      throw new AppError("VALIDATION", `unsupported import mode "${opts.mode}"`);
    }
    const bundle = this.validateBundle(raw);
    const store = this.store;

    const counts = await store.transaction(async (tx) => {
      await tx.wipeExportTables();
      const c: ImportCounts = {};

      for (const r of bundle.candidate.profiles) await tx.insertCandidate(r);
      c["candidate.profiles"] = bundle.candidate.profiles.length;
      for (const r of bundle.targets) await tx.insertTarget(r);
      c["targets"] = bundle.targets.length;
      for (const r of bundle.interviews.loops) await tx.insertLoop(r);
      c["interviews.loops"] = bundle.interviews.loops.length;
      for (const r of bundle.interviews.sessions) await tx.insertSession(r);
      c["interviews.sessions"] = bundle.interviews.sessions.length;
      for (const r of bundle.interviews.questions) await tx.insertQuestion(r);
      c["interviews.questions"] = bundle.interviews.questions.length;
      for (const r of bundle.interviews.answers) await tx.insertAnswer(r);
      c["interviews.answers"] = bundle.interviews.answers.length;
      for (const r of bundle.interviews.evaluations) await tx.insertEvaluation(r);
      c["interviews.evaluations"] = bundle.interviews.evaluations.length;
      for (const r of bundle.interviews.debriefs) await tx.insertDebrief(r);
      c["interviews.debriefs"] = bundle.interviews.debriefs.length;
      for (const r of bundle.evidence) await tx.insertEvidence(r);
      c["evidence"] = bundle.evidence.length;
      for (const r of bundle.readiness.snapshots) {
        await tx.appendReadinessSnapshot(r);
      }
      c["readiness.snapshots"] = bundle.readiness.snapshots.length;
      for (const r of bundle.preparation.actions) await tx.insertAction(r);
      c["preparation.actions"] = bundle.preparation.actions.length;
      for (const r of bundle.stories) await tx.insertStory(r);
      c["stories"] = bundle.stories.length;
      for (const r of bundle.resumeReviews) await tx.insertResumeReview(r);
      c["resumeReviews"] = bundle.resumeReviews.length;
      for (const r of bundle.interviewPacks) await tx.insertInterviewPack(r);
      c["interviewPacks"] = bundle.interviewPacks.length;
      for (const r of bundle.questionBank) await tx.insertUserQuestion(r);
      c["questionBank"] = bundle.questionBank.length;
      for (const r of bundle.externalContexts) await tx.insertExternalContext(r);
      c["externalContexts"] = bundle.externalContexts.length;

      // allowlisted settings are replaced, others left untouched
      for (const key of EXPORTED_SETTING_KEYS) {
        await tx.setSetting(key, bundle.settings[key] ?? null);
      }
      c["settings"] = Object.keys(bundle.settings).filter((k) =>
        (EXPORTED_SETTING_KEYS as readonly string[]).includes(k),
      ).length;
      return c;
    });

    // post-import: one readiness snapshot per recomputed skill, reason "import"
    await this.recomputeAfterImport();
    this.ctx.logger.info("import.completed", { tables: Object.keys(counts).length });
    return counts;
  }

  /** Wired by the orchestrator — recomputes readiness with reason "import". */
  recomputeAfterImport: () => Promise<unknown> = async () => {};
}
