import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const candidateProfiles = sqliteTable("candidate_profiles", {
  id: text("id").primaryKey(),
  active: integer("active").notNull().default(0),
  name: text("name"),
  headline: text("headline"),
  resumeText: text("resume_text").notNull().default(""),
  data: text("data", { mode: "json" }).notNull().default("{}"),
  createdAt: text("created_at").notNull(),
});

export const targetRoles = sqliteTable("target_roles", {
  id: text("id").primaryKey(),
  active: integer("active").notNull().default(0),
  company: text("company").notNull(),
  role: text("role").notNull(),
  level: text("level").notNull(),
  jobDescription: text("job_description").notNull().default(""),
  data: text("data", { mode: "json" }).notNull().default("{}"),
  createdAt: text("created_at").notNull(),
});

export const interviewSessions = sqliteTable("interview_sessions", {
  id: text("id").primaryKey(),
  candidateId: text("candidate_id"),
  targetId: text("target_id"),
  status: text("status").notNull().default("created"),
  currentRound: integer("current_round").notNull().default(0),
  plannedQuestions: integer("planned_questions").notNull().default(4),
  createdAt: text("created_at").notNull(),
  completedAt: text("completed_at"),
});

export const interviewQuestions = sqliteTable("interview_questions", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  skillId: text("skill_id").notNull(),
  topic: text("topic").notNull().default(""),
  text: text("text").notNull(),
  subSkills: text("sub_skills", { mode: "json" }).notNull().default("[]"),
  expectedConcepts: text("expected_concepts", { mode: "json" }).notNull().default("[]"),
  difficulty: text("difficulty").notNull().default("medium"),
  selectionPriority: real("selection_priority"),
  selectionReason: text("selection_reason"),
  position: integer("position").notNull().default(0),
  createdAt: text("created_at").notNull(),
});

export const candidateAnswers = sqliteTable("candidate_answers", {
  id: text("id").primaryKey(),
  questionId: text("question_id").notNull(),
  sessionId: text("session_id").notNull(),
  text: text("text").notNull(),
  status: text("status").notNull().default("evaluated"), // evaluated | failed
  createdAt: text("created_at").notNull(),
});

export const answerEvaluations = sqliteTable("answer_evaluations", {
  id: text("id").primaryKey(),
  answerId: text("answer_id").notNull(),
  questionId: text("question_id").notNull(),
  sessionId: text("session_id").notNull(),
  data: text("data", { mode: "json" }).notNull(),
  createdAt: text("created_at").notNull(),
});

export const skillNodes = sqliteTable("skill_nodes", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  parentId: text("parent_id"),
});

export const skillEvidence = sqliteTable("skill_evidence", {
  id: text("id").primaryKey(),
  candidateId: text("candidate_id"),
  skillId: text("skill_id").notNull(),
  type: text("type").notNull(),
  score: real("score").notNull(),
  confidence: real("confidence").notNull(),
  observation: text("observation").notNull().default(""),
  sessionId: text("session_id"),
  questionId: text("question_id"),
  createdAt: text("created_at").notNull(),
});

export const readinessScores = sqliteTable("readiness_scores", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  skillId: text("skill_id").notNull(),
  score: real("score"),
  confidence: real("confidence").notNull(),
  evidenceIds: text("evidence_ids", { mode: "json" }).notNull().default("[]"),
  reason: text("reason").notNull().default(""),
  computedAt: text("computed_at").notNull(),
});

export const preparationActions = sqliteTable("preparation_actions", {
  id: text("id").primaryKey(),
  skillId: text("skill_id").notNull(),
  priority: real("priority").notNull(),
  reason: text("reason").notNull().default(""),
  action: text("action").notNull(),
  successCriteria: text("success_criteria", { mode: "json" }).notNull().default("[]"),
  status: text("status").notNull().default("open"),
  severity: text("severity").notNull().default("medium"), // low | medium | high
  createdAt: text("created_at").notNull(),
  sourceEvidenceIds: text("source_evidence_ids", { mode: "json" }).notNull().default("[]"),
});

export const runtimeSessions = sqliteTable("runtime_sessions", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  runtime: text("runtime").notNull(),
  runtimeSessionId: text("runtime_session_id").notNull(),
  threadId: text("thread_id").notNull(),
  status: text("status").notNull().default("open"),
  createdAt: text("created_at").notNull(),
});

export const interviewDebriefs = sqliteTable("interview_debriefs", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  data: text("data", { mode: "json" }).notNull(),
  createdAt: text("created_at").notNull(),
});
