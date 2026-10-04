import { z } from "zod";

/**
 * v0.4 export/import bundle. Row schemas mirror the server store rows
 * (drizzle $inferSelect): JSON columns stay `unknown` here — their contents
 * were validated when they entered the store, and the bundle-level
 * referential checks catch structural corruption.
 *
 * Deliberately absent: runtime_sessions, plugin_installs, mcp_servers,
 * usage_events — machine-local or security-sensitive state never exports.
 */

const Json = z.unknown();
const Stamp = z.string();

export const CandidateProfileRowSchema = z.object({
  id: z.string().min(1),
  active: z.number().int(),
  name: z.string().nullable(),
  headline: z.string().nullable(),
  resumeText: z.string(),
  data: Json,
  createdAt: Stamp,
});

export const TargetRoleRowSchema = z.object({
  id: z.string().min(1),
  active: z.number().int(),
  company: z.string(),
  role: z.string(),
  level: z.string(),
  jobDescription: z.string(),
  data: Json,
  createdAt: Stamp,
});

export const InterviewSessionRowSchema = z.object({
  id: z.string().min(1),
  candidateId: z.string().nullable(),
  targetId: z.string().nullable(),
  status: z.string(),
  currentRound: z.number().int(),
  plannedQuestions: z.number().int(),
  mode: z.string(),
  roundType: z.string(),
  focusSkillId: z.string().nullable(),
  actionId: z.string().nullable(),
  modeState: Json,
  loopId: z.string().nullable(),
  loopRound: z.number().int().nullable(),
  contextId: z.string().nullable(),
  createdAt: Stamp,
  completedAt: Stamp.nullable(),
});

export const InterviewLoopRowSchema = z.object({
  id: z.string().min(1),
  targetId: z.string().nullable(),
  companyProfileId: z.string(),
  rounds: Json,
  status: z.string(),
  packId: z.string().nullable(),
  focusSkills: Json,
  currentRound: z.number().int(),
  abandoned: z.number().int(),
  debrief: Json,
  createdAt: Stamp,
  completedAt: Stamp.nullable(),
});

export const InterviewQuestionRowSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  skillId: z.string(),
  topic: z.string(),
  text: z.string(),
  subSkills: Json,
  expectedConcepts: Json,
  difficulty: z.string(),
  selectionPriority: z.number().nullable(),
  selectionReason: z.string().nullable(),
  selectionFactors: Json,
  followUpOf: z.string().nullable(),
  followUpFocus: z.string().nullable(),
  extra: Json,
  position: z.number().int(),
  createdAt: Stamp,
});

export const CandidateAnswerRowSchema = z.object({
  id: z.string().min(1),
  questionId: z.string().min(1),
  sessionId: z.string().min(1),
  text: z.string(),
  code: z.string().nullable(),
  language: z.string().nullable(),
  voice: Json,
  status: z.string(),
  createdAt: Stamp,
});

export const AnswerEvaluationRowSchema = z.object({
  id: z.string().min(1),
  answerId: z.string().min(1),
  questionId: z.string().min(1),
  sessionId: z.string().min(1),
  data: Json,
  readinessDelta: Json,
  createdAt: Stamp,
});

export const InterviewDebriefRowSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  data: Json,
  createdAt: Stamp,
});

export const SkillEvidenceRowSchema = z.object({
  id: z.string().min(1),
  candidateId: z.string().nullable(),
  skillId: z.string(),
  type: z.string(),
  score: z.number(),
  confidence: z.number(),
  observation: z.string(),
  sessionId: z.string().nullable(),
  questionId: z.string().nullable(),
  source: z.string().nullable(),
  createdAt: Stamp,
});

export const ReadinessScoreRowSchema = z.object({
  id: z.number().int(),
  skillId: z.string(),
  score: z.number().nullable(),
  confidence: z.number(),
  evidenceIds: Json,
  reason: z.string(),
  computedAt: Stamp,
});

export const PreparationActionRowSchema = z.object({
  id: z.string().min(1),
  skillId: z.string(),
  targetId: z.string().nullable(),
  priority: z.number(),
  reason: z.string(),
  action: z.string(),
  successCriteria: Json,
  status: z.string(),
  severity: z.string(),
  createdAt: Stamp,
  sourceEvidenceIds: Json,
  resources: Json,
});

export const StarStoryRowSchema = z.object({
  id: z.string().min(1),
  candidateId: z.string().min(1),
  title: z.string(),
  situation: z.string(),
  task: z.string(),
  action: z.string(),
  result: z.string(),
  skillIds: Json,
  source: z.string(),
  updatedAt: Stamp,
});

export const ResumeReviewRowSchema = z.object({
  id: z.string().min(1),
  candidateId: z.string().nullable(),
  targetId: z.string().nullable(),
  ats: Json,
  suggestions: Json,
  tailoring: Json,
  linkedGapSkillIds: Json,
  guard: Json,
  createdAt: Stamp,
});

export const InterviewPackRowSchema = z.object({
  id: z.string().min(1),
  data: Json,
  source: z.enum(["user", "imported"]),
  createdAt: Stamp,
  updatedAt: Stamp,
});

export const UserQuestionRowSchema = z.object({
  id: z.string().min(1),
  skillId: z.string(),
  text: z.string(),
  difficulty: z.string().nullable(),
  mode: z.string().nullable(),
  createdAt: Stamp,
});

export const ExternalContextRowSchema = z.object({
  id: z.string().min(1),
  serverId: z.string(),
  tool: z.string(),
  title: z.string(),
  text: z.string(),
  createdAt: Stamp,
});

/** Setting keys that may round-trip — user preferences, never runtime/machine state. */
export const EXPORTED_SETTING_KEYS = [
  "questionSources",
  "voice",
  "model",
  "reasoningEffort",
] as const;

export const ExportBundleSchema = z.object({
  format: z.literal("interview-os.export"),
  version: z.literal(1),
  appVersion: z.string().min(1),
  exportedAt: Stamp,
  candidate: z.object({ profiles: z.array(CandidateProfileRowSchema) }),
  targets: z.array(TargetRoleRowSchema),
  readiness: z.object({ snapshots: z.array(ReadinessScoreRowSchema) }),
  evidence: z.array(SkillEvidenceRowSchema),
  interviews: z.object({
    sessions: z.array(InterviewSessionRowSchema),
    questions: z.array(InterviewQuestionRowSchema),
    answers: z.array(CandidateAnswerRowSchema),
    evaluations: z.array(AnswerEvaluationRowSchema),
    debriefs: z.array(InterviewDebriefRowSchema),
    loops: z.array(InterviewLoopRowSchema),
  }),
  preparation: z.object({ actions: z.array(PreparationActionRowSchema) }),
  stories: z.array(StarStoryRowSchema),
  resumeReviews: z.array(ResumeReviewRowSchema),
  interviewPacks: z.array(InterviewPackRowSchema),
  questionBank: z.array(UserQuestionRowSchema),
  settings: z.record(z.string(), z.string()),
  externalContexts: z.array(ExternalContextRowSchema),
});
export type ExportBundle = z.infer<typeof ExportBundleSchema>;

export const EXPORT_PARTS = [
  "candidate",
  "targets",
  "readiness",
  "evidence",
  "interviews",
  "preparation",
] as const;
export type ExportPart = (typeof EXPORT_PARTS)[number];
