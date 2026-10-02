import { z } from "zod";
import { SkillIdSchema } from "../skill-id.js";
import { GapSchema } from "../gaps/schema.js";
import { SkillReadinessSchema } from "../readiness/schema.js";

export const EvaluationDimensionSchema = z.object({
  score: z.number().min(0).max(1),
  rationale: z.string(),
});
export type EvaluationDimension = z.infer<typeof EvaluationDimensionSchema>;

export const AnswerEvaluationSchema = z.object({
  summary: z.string(),
  dimensions: z.object({
    correctness: EvaluationDimensionSchema,
    technicalDepth: EvaluationDimensionSchema,
    reasoning: EvaluationDimensionSchema,
    structure: EvaluationDimensionSchema,
    communication: EvaluationDimensionSchema,
    evidence: EvaluationDimensionSchema,
    roleRelevance: EvaluationDimensionSchema,
  }),
  strengths: z.array(z.object({ skill: SkillIdSchema, evidence: z.string() })),
  weaknesses: z.array(
    z.object({
      skill: SkillIdSchema,
      severity: z.enum(["low", "medium", "high"]),
      evidence: z.string(),
    }),
  ),
  scores: z.array(
    z.object({
      skill: SkillIdSchema,
      score: z.number().min(0).max(1),
      confidence: z.number().min(0).max(1),
    }),
  ),
  missingConcepts: z.array(z.string()),
  betterApproach: z.string(),
  followUpTopics: z.array(z.string()),
});
export type AnswerEvaluation = z.infer<typeof AnswerEvaluationSchema>;

export const AssessedItemSchema = z.object({
  skillId: SkillIdSchema,
  note: z.string(),
  evidenceIds: z.array(z.string()).default([]),
});
export type AssessedItem = z.infer<typeof AssessedItemSchema>;

export const AssessmentStateSchema = z.object({
  strengths: z.array(AssessedItemSchema).default([]),
  gaps: z.array(GapSchema).default([]),
  weakAnswers: z.array(AssessedItemSchema).default([]),
  strongAnswers: z.array(AssessedItemSchema).default([]),
  observations: z.array(z.string()).default([]),
  skillAssessments: z.record(z.string(), SkillReadinessSchema).default({}),
});
export type AssessmentState = z.infer<typeof AssessmentStateSchema>;
