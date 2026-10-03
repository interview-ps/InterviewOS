import { z } from "zod";
import { AtsResultSchema } from "./ats.js";

export {
  atsCheck,
  AtsCheckSchema,
  AtsCheckStatusSchema,
  AtsKeywordCoverageSchema,
  AtsResultSchema,
} from "./ats.js";
export type {
  AtsCheck,
  AtsCheckStatus,
  AtsKeywordCoverage,
  AtsResult,
} from "./ats.js";
export { guardSuggestion } from "./guard.js";
export type { GuardResult } from "./guard.js";
export { bulletLines, selectWeakestBullets } from "./bullets.js";

/** §9.5: one guarded bullet-rewrite suggestion persisted in a review. */
export const ResumeSuggestionSchema = z.object({
  original: z.string(),
  improved: z.string(),
  rationale: z.string().default(""),
  skillIds: z.array(z.string()).default([]),
  /** Set when the no-invented-facts guard dropped this suggestion. */
  dropped: z.string().optional(),
});
export type ResumeSuggestion = z.infer<typeof ResumeSuggestionSchema>;

export const ResumeAlignmentSchema = z.object({
  requirement: z.string(),
  /** Verbatim substring of the resume, or null when none exists. */
  resumeEvidence: z.string().nullable(),
  suggestion: z.string().default(""),
});
export type ResumeAlignment = z.infer<typeof ResumeAlignmentSchema>;

export const ResumeTailoringSchema = z.object({
  summary: z.string(),
  emphasize: z.array(z.string()).default([]),
  deEmphasize: z.array(z.string()).default([]),
  alignment: z.array(ResumeAlignmentSchema).default([]),
  prepGaps: z.array(z.string()).default([]),
});
export type ResumeTailoring = z.infer<typeof ResumeTailoringSchema>;

/** §9.5: persisted `resume_reviews` row payload. */
export const ResumeReviewSchema = z.object({
  id: z.string(),
  candidateId: z.string(),
  targetId: z.string().nullable(),
  ats: AtsResultSchema,
  suggestions: z.array(ResumeSuggestionSchema),
  tailoring: ResumeTailoringSchema.nullable(),
  /** Requirement gap skill ids the tailoring prepGaps link to. */
  linkedGapSkillIds: z.array(z.string()).default([]),
  guard: z
    .object({
      substitutions: z.number().int().min(0),
      dropped: z.number().int().min(0),
    })
    .default({ substitutions: 0, dropped: 0 }),
  createdAt: z.string(),
});
export type ResumeReview = z.infer<typeof ResumeReviewSchema>;
