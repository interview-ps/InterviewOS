import { z } from "zod";
import { SkillIdSchema } from "../skill-id.js";

export const EvidenceTypeSchema = z.enum([
  "resume_claim",
  "interview_answer",
  "practice",
  "self_report",
  "plugin",
]);
export type EvidenceType = z.infer<typeof EvidenceTypeSchema>;

export const EvidenceSchema = z.object({
  id: z.string(),
  skillId: SkillIdSchema,
  type: EvidenceTypeSchema,
  score: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  observation: z.string(),
  sessionId: z.string().optional(),
  questionId: z.string().optional(),
  /** e.g. "plugin:<id>" — where the evidence came from. */
  source: z.string().optional(),
  createdAt: z.string(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const ReadinessStatusSchema = z.enum([
  "unknown",
  "weak",
  "developing",
  "strong",
]);
export type ReadinessStatus = z.infer<typeof ReadinessStatusSchema>;

export const SkillReadinessSchema = z.object({
  skillId: SkillIdSchema,
  label: z.string(),
  score: z.number().min(0).max(1).nullable(),
  confidence: z.number().min(0).max(1),
  evidenceIds: z.array(z.string()).default([]),
  children: z.array(SkillIdSchema).default([]),
  status: ReadinessStatusSchema,
});
export type SkillReadiness = z.infer<typeof SkillReadinessSchema>;

export const ReadinessGraphSchema = z.object({
  overall: z.number().min(0).max(1),
  overallConfidence: z.number().min(0).max(1),
  dimensions: z.record(z.string(), SkillReadinessSchema).default({}),
  lastUpdated: z.string(),
});
export type ReadinessGraph = z.infer<typeof ReadinessGraphSchema>;
