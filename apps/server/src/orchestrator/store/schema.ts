import { integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
  mode: text("mode").notNull().default("interview"), // interview | practice
  roundType: text("round_type").notNull().default("mixed"), // §8.4 round type
  focusSkillId: text("focus_skill_id"),
  actionId: text("action_id"),
  /** §9.1: per-mode session state (JSON). */
  modeState: text("mode_state", { mode: "json" }).notNull().default("{}"),
  /** §9.4: owning loop + 1-based round index (null for standalone sessions). */
  loopId: text("loop_id"),
  loopRound: integer("loop_round"),
  /** v0.4: fetched external context this session is grounded on (nullable). */
  contextId: text("context_id"),
  /** v0.4: plugin interview-mode focus skills fed to the planner (JSON SkillId[]). */
  focusSkills: text("focus_skills", { mode: "json" }).notNull().default("[]"),
  /** v1: "<pluginId>:<modeId>" when started from a plugin interview mode. */
  pluginModeId: text("plugin_mode_id"),
  createdAt: text("created_at").notNull(),
  completedAt: text("completed_at"),
});

/** §9.4: a multi-round interview loop; `rounds` holds LoopRound[] JSON. */
export const interviewLoops = sqliteTable("interview_loops", {
  id: text("id").primaryKey(),
  targetId: text("target_id"),
  companyProfileId: text("company_profile_id").notNull().default("generic"),
  rounds: text("rounds", { mode: "json" }).notNull().default("[]"),
  status: text("status").notNull().default("planned"), // planned | in_progress | complete
  /** v0.4: interview pack this loop was started from (null = ad-hoc). */
  packId: text("pack_id"),
  /** v0.4: pack focus skills fed to the interview planner (JSON SkillId[]). */
  focusSkills: text("focus_skills", { mode: "json" }).notNull().default("[]"),
  currentRound: integer("current_round").notNull().default(0),
  abandoned: integer("abandoned").notNull().default(0),
  debrief: text("debrief", { mode: "json" }),
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
  /** §9.2: engine factor breakdown (JSON). */
  selectionFactors: text("selection_factors", { mode: "json" }).notNull().default("{}"),
  /** §9.1: parent question id when this is a follow-up (doesn't count toward plan). */
  followUpOf: text("follow_up_of"),
  followUpFocus: text("follow_up_focus"),
  /** §9.1: mode payload — coding problem object / design problem text / focusDimension. */
  extra: text("extra", { mode: "json" }).notNull().default("{}"),
  position: integer("position").notNull().default(0),
  createdAt: text("created_at").notNull(),
});

export const candidateAnswers = sqliteTable("candidate_answers", {
  id: text("id").primaryKey(),
  questionId: text("question_id").notNull(),
  sessionId: text("session_id").notNull(),
  text: text("text").notNull(),
  /** §9.1: optional submitted code + language (coding rounds; reviewed, not executed). */
  code: text("code"),
  language: text("language"),
  /** v0.4: { metrics, feedback } when the client sent VoiceMetrics (nullable). */
  voice: text("voice", { mode: "json" }),
  /** v1: [{pluginId, pluginName, observations}] from evaluation.review hooks. */
  pluginReviews: text("plugin_reviews", { mode: "json" }),
  status: text("status").notNull().default("evaluated"), // evaluated | failed
  createdAt: text("created_at").notNull(),
});

export const answerEvaluations = sqliteTable("answer_evaluations", {
  id: text("id").primaryKey(),
  answerId: text("answer_id").notNull(),
  questionId: text("question_id").notNull(),
  sessionId: text("session_id").notNull(),
  data: text("data", { mode: "json" }).notNull(),
  /** §9.7: per-skill readiness before→after for this evaluation. */
  readinessDelta: text("readiness_delta", { mode: "json" }).notNull().default("[]"),
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
  /** e.g. "plugin:<id>" — provenance of plugin-written evidence. */
  source: text("source"),
  createdAt: text("created_at").notNull(),
});

/** v0.4: per-plugin install state (enablement + granted permissions). */
export const pluginInstalls = sqliteTable("plugin_installs", {
  id: text("id").primaryKey(),
  enabled: integer("enabled").notNull().default(0),
  grantedPermissions: text("granted_permissions", { mode: "json" })
    .notNull()
    .default("[]"),
  source: text("source").notNull(), // bundled | git
  sourceUrl: text("source_url"),
  dirName: text("dir_name"),
  installedAt: text("installed_at"),
  updatedAt: text("updated_at"),
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
  targetId: text("target_id"),
  priority: real("priority").notNull(),
  reason: text("reason").notNull().default(""),
  action: text("action").notNull(),
  successCriteria: text("success_criteria", { mode: "json" }).notNull().default("[]"),
  status: text("status").notNull().default("open"),
  severity: text("severity").notNull().default("medium"), // low | medium | high
  createdAt: text("created_at").notNull(),
  sourceEvidenceIds: text("source_evidence_ids", { mode: "json" }).notNull().default("[]"),
  /** v0.4: PrepResource[] — builtin + role-pack + plugin-fetched resources. */
  resources: text("resources", { mode: "json" }).notNull().default("[]"),
  /** v1: who created the action — "planner" (default) or "plugin:<id>". */
  source: text("source").notNull().default("planner"),
});

/** v1: per-plugin settings values (declared fields in the manifest). */
export const pluginSettings = sqliteTable(
  "plugin_settings",
  {
    pluginId: text("plugin_id").notNull(),
    key: text("key").notNull(),
    value: text("value", { mode: "json" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.pluginId, t.key] })],
);

/** v1: per-plugin KV storage — plugin-owned only, wiped on uninstall. */
export const pluginStorage = sqliteTable(
  "plugin_storage",
  {
    pluginId: text("plugin_id").notNull(),
    key: text("key").notNull(),
    value: text("value", { mode: "json" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.pluginId, t.key] })],
);

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

export const starStories = sqliteTable("star_stories", {
  id: text("id").primaryKey(),
  candidateId: text("candidate_id").notNull(),
  title: text("title").notNull(),
  situation: text("situation").notNull().default(""),
  task: text("task").notNull().default(""),
  action: text("action").notNull().default(""),
  result: text("result").notNull().default(""),
  skillIds: text("skill_ids", { mode: "json" }).notNull().default("[]"),
  source: text("source").notNull().default("user"), // resume | generated | user
  updatedAt: text("updated_at").notNull(),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/** §9.5: resume-coach reviews (ATS result + guarded suggestions + tailoring). */
export const resumeReviews = sqliteTable("resume_reviews", {
  id: text("id").primaryKey(),
  candidateId: text("candidate_id"),
  targetId: text("target_id"),
  ats: text("ats", { mode: "json" }).notNull(),
  suggestions: text("suggestions", { mode: "json" }).notNull().default("[]"),
  tailoring: text("tailoring", { mode: "json" }),
  linkedGapSkillIds: text("linked_gap_skill_ids", { mode: "json" })
    .notNull()
    .default("[]"),
  guard: text("guard", { mode: "json" }).notNull().default("{}"),
  createdAt: text("created_at").notNull(),
});

/** v0.4: user-owned/imported interview packs; `data` holds InterviewPack JSON. */
export const interviewPacks = sqliteTable("interview_packs", {
  id: text("id").primaryKey(),
  data: text("data", { mode: "json" }).notNull(),
  source: text("source").notNull(), // user | imported
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** v0.4: the user's own question bank (a question source). */
export const userQuestions = sqliteTable("user_questions", {
  id: text("id").primaryKey(),
  skillId: text("skill_id").notNull(),
  text: text("text").notNull(),
  difficulty: text("difficulty"),
  mode: text("mode"),
  createdAt: text("created_at").notNull(),
});

/** v0.4: MCP server enablement + per-tool allowlist (config lives on disk). */
export const mcpServers = sqliteTable("mcp_servers", {
  id: text("id").primaryKey(),
  enabled: integer("enabled").notNull().default(0),
  allowedTools: text("allowed_tools", { mode: "json" }).notNull().default("[]"),
  updatedAt: text("updated_at"),
});

/** v0.4: text fetched from an allowed MCP tool, stored as reference material. */
export const externalContexts = sqliteTable("external_contexts", {
  id: text("id").primaryKey(),
  serverId: text("server_id").notNull(),
  tool: text("tool").notNull(),
  title: text("title").notNull().default(""),
  text: text("text").notNull().default(""),
  createdAt: text("created_at").notNull(),
});

/** §9.7: local usage counters — event names only, never content. */
export const usageEvents = sqliteTable("usage_events", {
  id: text("id").primaryKey(),
  event: text("event").notNull(),
  createdAt: text("created_at").notNull(),
});
