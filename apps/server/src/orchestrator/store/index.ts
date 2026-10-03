import { DatabaseSync } from "node:sqlite";
import {
  drizzle,
  type RemoteCallback,
  type SqliteRemoteDatabase,
} from "drizzle-orm/sqlite-proxy";
import { and, desc, eq, sql } from "drizzle-orm";
import * as schema from "./schema.js";
import {
  answerEvaluations,
  candidateAnswers,
  candidateProfiles,
  interviewDebriefs,
  interviewLoops,
  interviewQuestions,
  interviewSessions,
  preparationActions,
  readinessScores,
  runtimeSessions,
  settings,
  resumeReviews,
  starStories,
  skillEvidence,
  skillNodes,
  targetRoles,
  usageEvents,
} from "./schema.js";

const DDL = `
CREATE TABLE IF NOT EXISTS candidate_profiles (
  id TEXT PRIMARY KEY, active INTEGER NOT NULL DEFAULT 0,
  name TEXT, headline TEXT,
  resume_text TEXT NOT NULL DEFAULT '', data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS target_roles (
  id TEXT PRIMARY KEY, active INTEGER NOT NULL DEFAULT 0,
  company TEXT NOT NULL, role TEXT NOT NULL, level TEXT NOT NULL,
  job_description TEXT NOT NULL DEFAULT '', data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS interview_sessions (
  id TEXT PRIMARY KEY, candidate_id TEXT, target_id TEXT,
  status TEXT NOT NULL DEFAULT 'created',
  current_round INTEGER NOT NULL DEFAULT 0,
  planned_questions INTEGER NOT NULL DEFAULT 4,
  mode TEXT NOT NULL DEFAULT 'interview',
  round_type TEXT NOT NULL DEFAULT 'mixed',
  focus_skill_id TEXT, action_id TEXT,
  mode_state TEXT NOT NULL DEFAULT '{}',
  loop_id TEXT, loop_round INTEGER,
  created_at TEXT NOT NULL, completed_at TEXT
);
CREATE TABLE IF NOT EXISTS interview_loops (
  id TEXT PRIMARY KEY, target_id TEXT,
  company_profile_id TEXT NOT NULL DEFAULT 'generic',
  rounds TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'planned',
  current_round INTEGER NOT NULL DEFAULT 0,
  abandoned INTEGER NOT NULL DEFAULT 0,
  debrief TEXT,
  created_at TEXT NOT NULL, completed_at TEXT
);
CREATE TABLE IF NOT EXISTS resume_reviews (
  id TEXT PRIMARY KEY, candidate_id TEXT, target_id TEXT,
  ats TEXT NOT NULL, suggestions TEXT NOT NULL DEFAULT '[]',
  tailoring TEXT, linked_gap_skill_ids TEXT NOT NULL DEFAULT '[]',
  guard TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY, event TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS interview_questions (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, skill_id TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '', text TEXT NOT NULL,
  sub_skills TEXT NOT NULL DEFAULT '[]', expected_concepts TEXT NOT NULL DEFAULT '[]',
  difficulty TEXT NOT NULL DEFAULT 'medium',
  selection_priority REAL, selection_reason TEXT,
  selection_factors TEXT NOT NULL DEFAULT '{}',
  follow_up_of TEXT, follow_up_focus TEXT,
  extra TEXT NOT NULL DEFAULT '{}',
  position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS candidate_answers (
  id TEXT PRIMARY KEY, question_id TEXT NOT NULL, session_id TEXT NOT NULL,
  text TEXT NOT NULL, code TEXT, language TEXT,
  status TEXT NOT NULL DEFAULT 'evaluated',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS answer_evaluations (
  id TEXT PRIMARY KEY, answer_id TEXT NOT NULL, question_id TEXT NOT NULL,
  session_id TEXT NOT NULL, data TEXT NOT NULL,
  readiness_delta TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS skill_nodes (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, parent_id TEXT
);
CREATE TABLE IF NOT EXISTS skill_evidence (
  id TEXT PRIMARY KEY, candidate_id TEXT, skill_id TEXT NOT NULL,
  type TEXT NOT NULL, score REAL NOT NULL, confidence REAL NOT NULL,
  observation TEXT NOT NULL DEFAULT '', session_id TEXT, question_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS readiness_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT, skill_id TEXT NOT NULL,
  score REAL, confidence REAL NOT NULL,
  evidence_ids TEXT NOT NULL DEFAULT '[]', reason TEXT NOT NULL DEFAULT '',
  computed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS preparation_actions (
  id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, target_id TEXT, priority REAL NOT NULL,
  reason TEXT NOT NULL DEFAULT '', action TEXT NOT NULL,
  success_criteria TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'open',
  severity TEXT NOT NULL DEFAULT 'medium',
  created_at TEXT NOT NULL, source_evidence_ids TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS runtime_sessions (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, runtime TEXT NOT NULL,
  runtime_session_id TEXT NOT NULL, thread_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS interview_debriefs (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS star_stories (
  id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL,
  title TEXT NOT NULL,
  situation TEXT NOT NULL DEFAULT '', task TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT '',
  skill_ids TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'user', updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);
`;

type Db = SqliteRemoteDatabase<typeof schema>;

export type CandidateRow = typeof candidateProfiles.$inferSelect;
export type TargetRow = typeof targetRoles.$inferSelect;
export type SessionRow = typeof interviewSessions.$inferSelect;
export type QuestionRow = typeof interviewQuestions.$inferSelect;
export type AnswerRow = typeof candidateAnswers.$inferSelect;
export type EvaluationRow = typeof answerEvaluations.$inferSelect;
export type EvidenceRow = typeof skillEvidence.$inferSelect;
export type ReadinessRow = typeof readinessScores.$inferSelect;
export type PrepActionRow = typeof preparationActions.$inferSelect;
export type RuntimeSessionRow = typeof runtimeSessions.$inferSelect;
export type DebriefRow = typeof interviewDebriefs.$inferSelect;
export type StarStoryRow = typeof starStories.$inferSelect;
export type LoopRow = typeof interviewLoops.$inferSelect;
export type UsageEventRow = typeof usageEvents.$inferSelect;
export type ResumeReviewRow = typeof resumeReviews.$inferSelect;

function makeSqliteProxy(client: DatabaseSync): RemoteCallback {
  return async (sqlText, params, method) => {
    const stmt = client.prepare(sqlText);
    if (method === "run") {
      stmt.run(...params);
      return { rows: [] };
    }
    stmt.setReturnArrays(true);
    if (method === "get") {
      return { rows: stmt.get(...params) as unknown as any[] };
    }
    return { rows: stmt.all(...params) as any[] };
  };
}

export class Store {
  readonly db: Db;
  private readonly client: DatabaseSync | null;

  constructor(pathOrMemory: string);
  constructor(db: Db);
  constructor(source: string | Db) {
    if (typeof source === "string") {
      const client = new DatabaseSync(source);
      client.exec("PRAGMA journal_mode = WAL");
      client.exec(DDL);
      this.client = client;
      this.db = drizzle(makeSqliteProxy(client), { schema });
      this.migrate(client);
    } else {
      this.client = null;
      this.db = source;
    }
  }

  close(): void {
    this.client?.close();
  }

  /**
   * Run `fn` in a single SQLite transaction. The callback receives a store bound
   * to the transaction connection so every write it makes commits or rolls back
   * together. Nested calls use savepoints (sqlite-proxy). Reads taken through the
   * transaction store see that connection's snapshot.
   */
  async transaction<T>(fn: (tx: Store) => Promise<T>): Promise<T> {
    return this.db.transaction(async (txDb) => fn(new Store(txDb as unknown as Db)));
  }

  /** Idempotent column additions for databases created by older versions. */
  private migrate(client: DatabaseSync): void {
    const addColumn = (table: string, column: string, ddl: string) => {
      const cols = client.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string;
      }[];
      if (!cols.some((c) => c.name === column)) client.exec(ddl);
    };
    addColumn(
      "candidate_answers",
      "status",
      "ALTER TABLE candidate_answers ADD COLUMN status TEXT NOT NULL DEFAULT 'evaluated'",
    );
    addColumn(
      "preparation_actions",
      "severity",
      "ALTER TABLE preparation_actions ADD COLUMN severity TEXT NOT NULL DEFAULT 'medium'",
    );
    addColumn(
      "interview_sessions",
      "mode",
      "ALTER TABLE interview_sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'interview'",
    );
    addColumn(
      "interview_sessions",
      "focus_skill_id",
      "ALTER TABLE interview_sessions ADD COLUMN focus_skill_id TEXT",
    );
    addColumn(
      "interview_sessions",
      "action_id",
      "ALTER TABLE interview_sessions ADD COLUMN action_id TEXT",
    );
    addColumn(
      "preparation_actions",
      "target_id",
      "ALTER TABLE preparation_actions ADD COLUMN target_id TEXT",
    );
    addColumn(
      "interview_sessions",
      "round_type",
      "ALTER TABLE interview_sessions ADD COLUMN round_type TEXT NOT NULL DEFAULT 'mixed'",
    );
    addColumn(
      "interview_sessions",
      "mode_state",
      "ALTER TABLE interview_sessions ADD COLUMN mode_state TEXT NOT NULL DEFAULT '{}'",
    );
    addColumn(
      "interview_questions",
      "selection_factors",
      "ALTER TABLE interview_questions ADD COLUMN selection_factors TEXT NOT NULL DEFAULT '{}'",
    );
    addColumn(
      "interview_questions",
      "follow_up_of",
      "ALTER TABLE interview_questions ADD COLUMN follow_up_of TEXT",
    );
    addColumn(
      "interview_questions",
      "follow_up_focus",
      "ALTER TABLE interview_questions ADD COLUMN follow_up_focus TEXT",
    );
    addColumn(
      "interview_questions",
      "extra",
      "ALTER TABLE interview_questions ADD COLUMN extra TEXT NOT NULL DEFAULT '{}'",
    );
    addColumn(
      "candidate_answers",
      "code",
      "ALTER TABLE candidate_answers ADD COLUMN code TEXT",
    );
    addColumn(
      "candidate_answers",
      "language",
      "ALTER TABLE candidate_answers ADD COLUMN language TEXT",
    );
    addColumn(
      "interview_sessions",
      "loop_id",
      "ALTER TABLE interview_sessions ADD COLUMN loop_id TEXT",
    );
    addColumn(
      "interview_sessions",
      "loop_round",
      "ALTER TABLE interview_sessions ADD COLUMN loop_round INTEGER",
    );
    addColumn(
      "answer_evaluations",
      "readiness_delta",
      "ALTER TABLE answer_evaluations ADD COLUMN readiness_delta TEXT NOT NULL DEFAULT '[]'",
    );
    // backfill: existing actions belong to whichever target was active at upgrade time
    client.exec(
      `UPDATE preparation_actions SET target_id = (
         SELECT id FROM target_roles WHERE active = 1 LIMIT 1
       ) WHERE target_id IS NULL`,
    );
    // settings: copy legacy codexModel → model when model is absent (leave the
    // old key so the migration is idempotent and reversible; both can coexist
    // because `settings.key` is the PK, so never blind-INSERT the old key).
    client.exec(
      `INSERT INTO settings (key, value)
         SELECT 'model', value FROM settings
         WHERE key = 'codexModel'
           AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'model')`,
    );
  }

  // --- candidates / targets -------------------------------------------------
  async insertCandidate(row: typeof candidateProfiles.$inferInsert): Promise<void> {
    await this.db.insert(candidateProfiles).values(row).run();
  }
  async deactivateCandidates(): Promise<void> {
    await this.db.update(candidateProfiles).set({ active: 0 }).run();
  }
  async getActiveCandidate(): Promise<CandidateRow | undefined> {
    return this.db
      .select()
      .from(candidateProfiles)
      .where(eq(candidateProfiles.active, 1))
      .get();
  }
  async insertTarget(row: typeof targetRoles.$inferInsert): Promise<void> {
    await this.db.insert(targetRoles).values(row).run();
  }
  async deactivateTargets(): Promise<void> {
    await this.db.update(targetRoles).set({ active: 0 }).run();
  }
  async getActiveTarget(): Promise<TargetRow | undefined> {
    return this.db.select().from(targetRoles).where(eq(targetRoles.active, 1)).get();
  }
  async listTargets(): Promise<TargetRow[]> {
    return this.db
      .select()
      .from(targetRoles)
      .orderBy(desc(targetRoles.createdAt))
      .all();
  }
  async getTarget(id: string): Promise<TargetRow | undefined> {
    return this.db.select().from(targetRoles).where(eq(targetRoles.id, id)).get();
  }
  async activateTarget(id: string): Promise<void> {
    // Atomic deactivate-all + activate-one: a mid-sequence failure must never
    // leave the workspace with no active target.
    await this.transaction(async (tx) => {
      await tx.db.update(targetRoles).set({ active: 0 }).run();
      await tx.db.update(targetRoles).set({ active: 1 }).where(eq(targetRoles.id, id)).run();
    });
  }
  async updateTargetData(id: string, data: object): Promise<void> {
    await this.db.update(targetRoles).set({ data }).where(eq(targetRoles.id, id)).run();
  }

  // --- sessions ---------------------------------------------------------------
  async insertSession(row: typeof interviewSessions.$inferInsert): Promise<void> {
    await this.db.insert(interviewSessions).values(row).run();
  }
  async getSession(id: string): Promise<SessionRow | undefined> {
    return this.db
      .select()
      .from(interviewSessions)
      .where(eq(interviewSessions.id, id))
      .get();
  }
  async updateSession(
    id: string,
    patch: Partial<typeof interviewSessions.$inferInsert>,
  ): Promise<void> {
    await this.db.update(interviewSessions).set(patch).where(eq(interviewSessions.id, id)).run();
  }
  async listSessions(): Promise<SessionRow[]> {
    return this.db
      .select()
      .from(interviewSessions)
      .orderBy(desc(interviewSessions.createdAt))
      .all();
  }

  // --- questions / answers / evaluations --------------------------------------
  async insertQuestion(row: typeof interviewQuestions.$inferInsert): Promise<void> {
    await this.db.insert(interviewQuestions).values(row).run();
  }
  async listQuestions(sessionId: string): Promise<QuestionRow[]> {
    return this.db
      .select()
      .from(interviewQuestions)
      .where(eq(interviewQuestions.sessionId, sessionId))
      .orderBy(interviewQuestions.position)
      .all();
  }
  async getQuestion(id: string): Promise<QuestionRow | undefined> {
    return this.db
      .select()
      .from(interviewQuestions)
      .where(eq(interviewQuestions.id, id))
      .get();
  }
  async insertAnswer(row: typeof candidateAnswers.$inferInsert): Promise<void> {
    await this.db.insert(candidateAnswers).values(row).run();
  }
  async listAnswers(sessionId: string): Promise<AnswerRow[]> {
    return this.db
      .select()
      .from(candidateAnswers)
      .where(eq(candidateAnswers.sessionId, sessionId))
      .all();
  }
  async getAnswerForQuestion(questionId: string): Promise<AnswerRow | undefined> {
    return this.db
      .select()
      .from(candidateAnswers)
      .where(eq(candidateAnswers.questionId, questionId))
      .get();
  }
  async getEvaluatedAnswerForQuestion(questionId: string): Promise<AnswerRow | undefined> {
    return this.db
      .select()
      .from(candidateAnswers)
      .where(
        and(
          eq(candidateAnswers.questionId, questionId),
          eq(candidateAnswers.status, "evaluated"),
        ),
      )
      .get();
  }
  async updateAnswerStatus(id: string, status: "evaluated" | "failed"): Promise<void> {
    await this.db.update(candidateAnswers).set({ status }).where(eq(candidateAnswers.id, id)).run();
  }
  async insertEvaluation(row: typeof answerEvaluations.$inferInsert): Promise<void> {
    await this.db.insert(answerEvaluations).values(row).run();
  }
  async updateEvaluationDelta(
    id: string,
    delta: { skillId: string; before: number | null; after: number | null }[],
  ): Promise<void> {
    await this.db
      .update(answerEvaluations)
      .set({ readinessDelta: delta })
      .where(eq(answerEvaluations.id, id))
      .run();
  }
  async listEvaluations(sessionId: string): Promise<EvaluationRow[]> {
    return this.db
      .select()
      .from(answerEvaluations)
      .where(eq(answerEvaluations.sessionId, sessionId))
      .all();
  }
  async listAllEvaluations(): Promise<EvaluationRow[]> {
    return this.db.select().from(answerEvaluations).all();
  }

  // --- evidence -----------------------------------------------------------------
  async insertEvidence(row: typeof skillEvidence.$inferInsert): Promise<void> {
    await this.db.insert(skillEvidence).values(row).run();
  }
  async listEvidence(candidateId?: string): Promise<EvidenceRow[]> {
    if (candidateId) {
      return this.db
        .select()
        .from(skillEvidence)
        .where(eq(skillEvidence.candidateId, candidateId))
        .all();
    }
    return this.db.select().from(skillEvidence).all();
  }
  async evidenceForSkill(skillId: string, candidateId?: string): Promise<EvidenceRow[]> {
    const clauses = [eq(skillEvidence.skillId, skillId)];
    if (candidateId) clauses.push(eq(skillEvidence.candidateId, candidateId));
    return this.db
      .select()
      .from(skillEvidence)
      .where(and(...clauses))
      .all();
  }

  // --- readiness snapshots -------------------------------------------------------
  async appendReadinessSnapshot(row: typeof readinessScores.$inferInsert): Promise<void> {
    await this.db.insert(readinessScores).values(row).run();
  }
  async latestReadinessBySkill(): Promise<Map<string, ReadinessRow>> {
    const rows = await this.db
      .select()
      .from(readinessScores)
      .orderBy(desc(readinessScores.id))
      .all();
    const map = new Map<string, ReadinessRow>();
    for (const row of rows) {
      if (!map.has(row.skillId)) map.set(row.skillId, row);
    }
    return map;
  }
  async readinessHistory(skillId: string): Promise<ReadinessRow[]> {
    return this.db
      .select()
      .from(readinessScores)
      .where(eq(readinessScores.skillId, skillId))
      .orderBy(desc(readinessScores.id))
      .all();
  }
  async countReadinessSnapshots(): Promise<number> {
    const row = await this.db
      .select({ n: sql<number>`count(*)` })
      .from(readinessScores)
      .get();
    return row?.n ?? 0;
  }

  // --- prep actions ----------------------------------------------------------------
  async insertAction(row: typeof preparationActions.$inferInsert): Promise<void> {
    await this.db.insert(preparationActions).values(row).run();
  }
  async updateActionStatus(id: string, status: string): Promise<void> {
    await this.db
      .update(preparationActions)
      .set({ status })
      .where(eq(preparationActions.id, id))
      .run();
  }
  async getAction(id: string): Promise<PrepActionRow | undefined> {
    return this.db
      .select()
      .from(preparationActions)
      .where(eq(preparationActions.id, id))
      .get();
  }
  async updateActionPriority(id: string, priority: number): Promise<void> {
    await this.db
      .update(preparationActions)
      .set({ priority })
      .where(eq(preparationActions.id, id))
      .run();
  }
  async updateActionSourceEvidence(id: string, sourceEvidenceIds: string[]): Promise<void> {
    await this.db
      .update(preparationActions)
      .set({ sourceEvidenceIds })
      .where(eq(preparationActions.id, id))
      .run();
  }
  async listActions(status?: string, targetId?: string): Promise<PrepActionRow[]> {
    const clauses = [];
    if (status) clauses.push(eq(preparationActions.status, status));
    if (targetId) clauses.push(eq(preparationActions.targetId, targetId));
    const q = this.db.select().from(preparationActions);
    const rows = clauses.length > 0 ? await q.where(and(...clauses)).all() : await q.all();
    return rows.sort((a, b) => a.priority - b.priority);
  }
  async openActionForSkill(skillId: string, targetId?: string): Promise<PrepActionRow | undefined> {
    const clauses = [
      eq(preparationActions.skillId, skillId),
      eq(preparationActions.status, "open"),
    ];
    if (targetId) clauses.push(eq(preparationActions.targetId, targetId));
    return this.db
      .select()
      .from(preparationActions)
      .where(and(...clauses))
      .get();
  }
  async actionsForSkill(skillId: string, targetId?: string): Promise<PrepActionRow[]> {
    const clauses = [eq(preparationActions.skillId, skillId)];
    if (targetId) clauses.push(eq(preparationActions.targetId, targetId));
    return this.db
      .select()
      .from(preparationActions)
      .where(and(...clauses))
      .all();
  }

  // --- skill nodes ------------------------------------------------------------------
  async upsertSkillNode(id: string, label: string, parentId: string | null): Promise<void> {
    await this.db
      .insert(skillNodes)
      .values({ id, label, parentId })
      .onConflictDoUpdate({ target: skillNodes.id, set: { label, parentId } })
      .run();
  }

  // --- runtime sessions ----------------------------------------------------------------
  async insertRuntimeSession(row: typeof runtimeSessions.$inferInsert): Promise<void> {
    await this.db.insert(runtimeSessions).values(row).run();
  }
  async getRuntimeSession(sessionId: string): Promise<RuntimeSessionRow | undefined> {
    return this.db
      .select()
      .from(runtimeSessions)
      .where(eq(runtimeSessions.sessionId, sessionId))
      .orderBy(desc(runtimeSessions.createdAt))
      .get();
  }
  async updateRuntimeSessionStatus(id: string, status: string): Promise<void> {
    await this.db
      .update(runtimeSessions)
      .set({ status })
      .where(eq(runtimeSessions.id, id))
      .run();
  }

  // --- debriefs --------------------------------------------------------------------------
  async insertDebrief(row: typeof interviewDebriefs.$inferInsert): Promise<void> {
    await this.db.insert(interviewDebriefs).values(row).run();
  }
  async getDebrief(sessionId: string): Promise<DebriefRow | undefined> {
    return this.db
      .select()
      .from(interviewDebriefs)
      .where(eq(interviewDebriefs.sessionId, sessionId))
      .orderBy(desc(interviewDebriefs.createdAt))
      .get();
  }

  // --- star stories (§8.4) ----------------------------------------------------
  async insertStory(row: typeof starStories.$inferInsert): Promise<void> {
    await this.db.insert(starStories).values(row).run();
  }
  async listStories(candidateId: string): Promise<StarStoryRow[]> {
    return this.db
      .select()
      .from(starStories)
      .where(eq(starStories.candidateId, candidateId))
      .orderBy(desc(starStories.updatedAt))
      .all();
  }
  async getStory(id: string): Promise<StarStoryRow | undefined> {
    return this.db.select().from(starStories).where(eq(starStories.id, id)).get();
  }
  async updateStory(
    id: string,
    patch: Partial<typeof starStories.$inferInsert>,
  ): Promise<void> {
    await this.db.update(starStories).set(patch).where(eq(starStories.id, id)).run();
  }

  // --- settings (key/value) --------------------------------------------------
  async getSetting(key: string): Promise<string | undefined> {
    const row = await this.db.select().from(settings).where(eq(settings.key, key)).get();
    return row?.value;
  }
  async setSetting(key: string, value: string | null): Promise<void> {
    if (value === null) {
      await this.db.delete(settings).where(eq(settings.key, key)).run();
      return;
    }
    await this.db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } })
      .run();
  }
  async allSettings(): Promise<Record<string, string>> {
    const rows = await this.db.select().from(settings).all();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  /** Test-mode only (server gates on INTERVIEW_OS_TEST_MODE): wipe all state. */
  async resetAll(): Promise<void> {
    for (const t of [
      candidateProfiles,
      targetRoles,
      interviewSessions,
      interviewLoops,
      interviewQuestions,
      candidateAnswers,
      answerEvaluations,
      skillNodes,
      skillEvidence,
      readinessScores,
      preparationActions,
      runtimeSessions,
      interviewDebriefs,
      starStories,
      settings,
      resumeReviews,
      usageEvents,
    ]) {
      await this.db.delete(t).run();
    }
  }

  // --- loops (§9.4) ----------------------------------------------------------
  async insertLoop(row: typeof interviewLoops.$inferInsert): Promise<void> {
    await this.db.insert(interviewLoops).values(row).run();
  }
  async getLoop(id: string): Promise<LoopRow | undefined> {
    return this.db.select().from(interviewLoops).where(eq(interviewLoops.id, id)).get();
  }
  async listLoops(): Promise<LoopRow[]> {
    return this.db
      .select()
      .from(interviewLoops)
      .orderBy(desc(interviewLoops.createdAt))
      .all();
  }
  async updateLoop(
    id: string,
    patch: Partial<typeof interviewLoops.$inferInsert>,
  ): Promise<void> {
    await this.db.update(interviewLoops).set(patch).where(eq(interviewLoops.id, id)).run();
  }
  async loopForSession(sessionId: string): Promise<LoopRow | undefined> {
    const s = await this.getSession(sessionId);
    return s?.loopId ? await this.getLoop(s.loopId) : undefined;
  }

  // --- usage events (§9.7: names only, no content) ---------------------------
  async insertUsageEvent(row: { id: string; event: string; createdAt: string }): Promise<void> {
    await this.db.insert(usageEvents).values(row).run();
  }
  async countUsageEvents(event?: string): Promise<number> {
    const q = this.db.select({ n: sql<number>`count(*)` }).from(usageEvents);
    const row = await (event ? q.where(eq(usageEvents.event, event)) : q).get();
    return row?.n ?? 0;
  }

  // --- resume reviews (§9.5) -------------------------------------------------
  async insertResumeReview(row: typeof resumeReviews.$inferInsert): Promise<void> {
    await this.db.insert(resumeReviews).values(row).run();
  }
  async latestResumeReview(candidateId?: string): Promise<ResumeReviewRow | undefined> {
    const rows = await this.db
      .select()
      .from(resumeReviews)
      .orderBy(desc(resumeReviews.createdAt))
      .all();
    return candidateId
      ? rows.find((r) => r.candidateId === candidateId) ?? rows[0]
      : rows[0];
  }
}

export function openStore(pathOrMemory: string): Store {
  return new Store(pathOrMemory);
}
