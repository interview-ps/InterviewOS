import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, desc, eq, sql } from "drizzle-orm";
import * as schema from "./schema.js";
import {
  answerEvaluations,
  candidateAnswers,
  candidateProfiles,
  interviewDebriefs,
  interviewQuestions,
  interviewSessions,
  preparationActions,
  readinessScores,
  runtimeSessions,
  settings,
  starStories,
  skillEvidence,
  skillNodes,
  targetRoles,
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
  created_at TEXT NOT NULL, completed_at TEXT
);
CREATE TABLE IF NOT EXISTS interview_questions (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, skill_id TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '', text TEXT NOT NULL,
  sub_skills TEXT NOT NULL DEFAULT '[]', expected_concepts TEXT NOT NULL DEFAULT '[]',
  difficulty TEXT NOT NULL DEFAULT 'medium',
  selection_priority REAL, selection_reason TEXT,
  position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS candidate_answers (
  id TEXT PRIMARY KEY, question_id TEXT NOT NULL, session_id TEXT NOT NULL,
  text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'evaluated',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS answer_evaluations (
  id TEXT PRIMARY KEY, answer_id TEXT NOT NULL, question_id TEXT NOT NULL,
  session_id TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL
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

type Db = BetterSQLite3Database<typeof schema>;

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

export class Store {
  readonly db: Db;
  private readonly client: Database.Database;

  constructor(pathOrMemory: string) {
    this.client = new Database(pathOrMemory);
    this.client.pragma("journal_mode = WAL");
    this.client.exec(DDL);
    this.migrate();
    this.db = drizzle(this.client, { schema });
  }

  close(): void {
    this.client.close();
  }

  /** Idempotent column additions for databases created by older versions. */
  private migrate(): void {
    const addColumn = (table: string, column: string, ddl: string) => {
      const cols = this.client.pragma(`table_info(${table})`) as { name: string }[];
      if (!cols.some((c) => c.name === column)) this.client.exec(ddl);
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
    // backfill: existing actions belong to whichever target was active at upgrade time
    this.client.exec(
      `UPDATE preparation_actions SET target_id = (
         SELECT id FROM target_roles WHERE active = 1 LIMIT 1
       ) WHERE target_id IS NULL`,
    );
  }

  // --- candidates / targets -------------------------------------------------
  insertCandidate(row: typeof candidateProfiles.$inferInsert): void {
    this.db.insert(candidateProfiles).values(row).run();
  }
  deactivateCandidates(): void {
    this.db.update(candidateProfiles).set({ active: 0 }).run();
  }
  getActiveCandidate(): CandidateRow | undefined {
    return this.db
      .select()
      .from(candidateProfiles)
      .where(eq(candidateProfiles.active, 1))
      .get();
  }
  insertTarget(row: typeof targetRoles.$inferInsert): void {
    this.db.insert(targetRoles).values(row).run();
  }
  deactivateTargets(): void {
    this.db.update(targetRoles).set({ active: 0 }).run();
  }
  getActiveTarget(): TargetRow | undefined {
    return this.db.select().from(targetRoles).where(eq(targetRoles.active, 1)).get();
  }
  listTargets(): TargetRow[] {
    return this.db
      .select()
      .from(targetRoles)
      .orderBy(desc(targetRoles.createdAt))
      .all();
  }
  getTarget(id: string): TargetRow | undefined {
    return this.db.select().from(targetRoles).where(eq(targetRoles.id, id)).get();
  }
  activateTarget(id: string): void {
    this.db.update(targetRoles).set({ active: 0 }).run();
    this.db.update(targetRoles).set({ active: 1 }).where(eq(targetRoles.id, id)).run();
  }

  // --- sessions ---------------------------------------------------------------
  insertSession(row: typeof interviewSessions.$inferInsert): void {
    this.db.insert(interviewSessions).values(row).run();
  }
  getSession(id: string): SessionRow | undefined {
    return this.db
      .select()
      .from(interviewSessions)
      .where(eq(interviewSessions.id, id))
      .get();
  }
  updateSession(id: string, patch: Partial<typeof interviewSessions.$inferInsert>): void {
    this.db.update(interviewSessions).set(patch).where(eq(interviewSessions.id, id)).run();
  }
  listSessions(): SessionRow[] {
    return this.db
      .select()
      .from(interviewSessions)
      .orderBy(desc(interviewSessions.createdAt))
      .all();
  }

  // --- questions / answers / evaluations --------------------------------------
  insertQuestion(row: typeof interviewQuestions.$inferInsert): void {
    this.db.insert(interviewQuestions).values(row).run();
  }
  listQuestions(sessionId: string): QuestionRow[] {
    return this.db
      .select()
      .from(interviewQuestions)
      .where(eq(interviewQuestions.sessionId, sessionId))
      .orderBy(interviewQuestions.position)
      .all();
  }
  getQuestion(id: string): QuestionRow | undefined {
    return this.db
      .select()
      .from(interviewQuestions)
      .where(eq(interviewQuestions.id, id))
      .get();
  }
  insertAnswer(row: typeof candidateAnswers.$inferInsert): void {
    this.db.insert(candidateAnswers).values(row).run();
  }
  listAnswers(sessionId: string): AnswerRow[] {
    return this.db
      .select()
      .from(candidateAnswers)
      .where(eq(candidateAnswers.sessionId, sessionId))
      .all();
  }
  getAnswerForQuestion(questionId: string): AnswerRow | undefined {
    return this.db
      .select()
      .from(candidateAnswers)
      .where(eq(candidateAnswers.questionId, questionId))
      .get();
  }
  getEvaluatedAnswerForQuestion(questionId: string): AnswerRow | undefined {
    return this.db
      .select()
      .from(candidateAnswers)
      .where(and(eq(candidateAnswers.questionId, questionId), eq(candidateAnswers.status, "evaluated")))
      .get();
  }
  updateAnswerStatus(id: string, status: "evaluated" | "failed"): void {
    this.db.update(candidateAnswers).set({ status }).where(eq(candidateAnswers.id, id)).run();
  }
  insertEvaluation(row: typeof answerEvaluations.$inferInsert): void {
    this.db.insert(answerEvaluations).values(row).run();
  }
  listEvaluations(sessionId: string): EvaluationRow[] {
    return this.db
      .select()
      .from(answerEvaluations)
      .where(eq(answerEvaluations.sessionId, sessionId))
      .all();
  }
  listAllEvaluations(): EvaluationRow[] {
    return this.db.select().from(answerEvaluations).all();
  }

  // --- evidence -----------------------------------------------------------------
  insertEvidence(row: typeof skillEvidence.$inferInsert): void {
    this.db.insert(skillEvidence).values(row).run();
  }
  listEvidence(candidateId?: string): EvidenceRow[] {
    if (candidateId) {
      return this.db
        .select()
        .from(skillEvidence)
        .where(eq(skillEvidence.candidateId, candidateId))
        .all();
    }
    return this.db.select().from(skillEvidence).all();
  }
  evidenceForSkill(skillId: string, candidateId?: string): EvidenceRow[] {
    const clauses = [eq(skillEvidence.skillId, skillId)];
    if (candidateId) clauses.push(eq(skillEvidence.candidateId, candidateId));
    return this.db
      .select()
      .from(skillEvidence)
      .where(and(...clauses))
      .all();
  }

  // --- readiness snapshots -------------------------------------------------------
  appendReadinessSnapshot(row: typeof readinessScores.$inferInsert): void {
    this.db.insert(readinessScores).values(row).run();
  }
  latestReadinessBySkill(): Map<string, ReadinessRow> {
    const rows = this.db
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
  readinessHistory(skillId: string): ReadinessRow[] {
    return this.db
      .select()
      .from(readinessScores)
      .where(eq(readinessScores.skillId, skillId))
      .orderBy(desc(readinessScores.id))
      .all();
  }
  countReadinessSnapshots(): number {
    const row = this.db
      .select({ n: sql<number>`count(*)` })
      .from(readinessScores)
      .get();
    return row?.n ?? 0;
  }

  // --- prep actions ----------------------------------------------------------------
  insertAction(row: typeof preparationActions.$inferInsert): void {
    this.db.insert(preparationActions).values(row).run();
  }
  updateActionStatus(id: string, status: string): void {
    this.db
      .update(preparationActions)
      .set({ status })
      .where(eq(preparationActions.id, id))
      .run();
  }
  getAction(id: string): PrepActionRow | undefined {
    return this.db
      .select()
      .from(preparationActions)
      .where(eq(preparationActions.id, id))
      .get();
  }
  updateActionPriority(id: string, priority: number): void {
    this.db
      .update(preparationActions)
      .set({ priority })
      .where(eq(preparationActions.id, id))
      .run();
  }
  updateActionSourceEvidence(id: string, sourceEvidenceIds: string[]): void {
    this.db
      .update(preparationActions)
      .set({ sourceEvidenceIds })
      .where(eq(preparationActions.id, id))
      .run();
  }
  listActions(status?: string, targetId?: string): PrepActionRow[] {
    const clauses = [];
    if (status) clauses.push(eq(preparationActions.status, status));
    if (targetId) clauses.push(eq(preparationActions.targetId, targetId));
    const q = this.db.select().from(preparationActions);
    const rows = clauses.length > 0 ? q.where(and(...clauses)).all() : q.all();
    return rows.sort((a, b) => a.priority - b.priority);
  }
  openActionForSkill(skillId: string, targetId?: string): PrepActionRow | undefined {
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
  actionsForSkill(skillId: string, targetId?: string): PrepActionRow[] {
    const clauses = [eq(preparationActions.skillId, skillId)];
    if (targetId) clauses.push(eq(preparationActions.targetId, targetId));
    return this.db
      .select()
      .from(preparationActions)
      .where(and(...clauses))
      .all();
  }

  // --- skill nodes ------------------------------------------------------------------
  upsertSkillNode(id: string, label: string, parentId: string | null): void {
    this.db
      .insert(skillNodes)
      .values({ id, label, parentId })
      .onConflictDoUpdate({ target: skillNodes.id, set: { label, parentId } })
      .run();
  }

  // --- runtime sessions ----------------------------------------------------------------
  insertRuntimeSession(row: typeof runtimeSessions.$inferInsert): void {
    this.db.insert(runtimeSessions).values(row).run();
  }
  getRuntimeSession(sessionId: string): RuntimeSessionRow | undefined {
    return this.db
      .select()
      .from(runtimeSessions)
      .where(eq(runtimeSessions.sessionId, sessionId))
      .orderBy(desc(runtimeSessions.createdAt))
      .get();
  }
  updateRuntimeSessionStatus(id: string, status: string): void {
    this.db
      .update(runtimeSessions)
      .set({ status })
      .where(eq(runtimeSessions.id, id))
      .run();
  }

  // --- debriefs --------------------------------------------------------------------------
  insertDebrief(row: typeof interviewDebriefs.$inferInsert): void {
    this.db.insert(interviewDebriefs).values(row).run();
  }
  getDebrief(sessionId: string): DebriefRow | undefined {
    return this.db
      .select()
      .from(interviewDebriefs)
      .where(eq(interviewDebriefs.sessionId, sessionId))
      .orderBy(desc(interviewDebriefs.createdAt))
      .get();
  }

  // --- star stories (§8.4) ----------------------------------------------------
  insertStory(row: typeof starStories.$inferInsert): void {
    this.db.insert(starStories).values(row).run();
  }
  listStories(candidateId: string): StarStoryRow[] {
    return this.db
      .select()
      .from(starStories)
      .where(eq(starStories.candidateId, candidateId))
      .orderBy(desc(starStories.updatedAt))
      .all();
  }
  getStory(id: string): StarStoryRow | undefined {
    return this.db.select().from(starStories).where(eq(starStories.id, id)).get();
  }
  updateStory(id: string, patch: Partial<typeof starStories.$inferInsert>): void {
    this.db.update(starStories).set(patch).where(eq(starStories.id, id)).run();
  }

  // --- settings (key/value) --------------------------------------------------
  getSetting(key: string): string | undefined {
    return this.db.select().from(settings).where(eq(settings.key, key)).get()?.value;
  }
  setSetting(key: string, value: string | null): void {
    if (value === null) {
      this.db.delete(settings).where(eq(settings.key, key)).run();
      return;
    }
    this.db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } })
      .run();
  }
  allSettings(): Record<string, string> {
    return Object.fromEntries(
      this.db.select().from(settings).all().map((r) => [r.key, r.value]),
    );
  }
}

export function openStore(pathOrMemory: string): Store {
  return new Store(pathOrMemory);
}
