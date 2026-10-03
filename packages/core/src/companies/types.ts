import { z } from "zod";
import { SkillIdSchema } from "../skill-id.js";

export const MODE_ID_LIST = [
  "technical",
  "coding",
  "system_design",
  "behavioral",
  "hiring_manager",
  "hr",
] as const;
export const ModeIdSchema = z.enum(MODE_ID_LIST);

export const COMPANY_DISCLAIMER =
  "Based on commonly reported public interview patterns; real loops vary by team, role and level.";

/** §9.3 built-in company interview profile — originally-written public patterns. */
export const CompanyProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  aliases: z.array(z.string()).default([]),
  disclaimer: z.string(),
  typicalLoop: z.array(
    z.object({
      mode: ModeIdSchema,
      label: z.string(),
      plannedQuestions: z.number().int().positive(),
    }),
  ),
  /** Requirement importance boost (≤ 0.1 each) applied at persist time. */
  emphasis: z.array(
    z.object({
      skillId: SkillIdSchema,
      weight: z.number().min(0).max(0.1),
    }),
  ),
  behavioralFramework: z.object({
    name: z.string(),
    themes: z.array(z.string()),
    guidance: z.string(),
  }),
  /** Max follow-up chain depth under one main question. */
  followUpDepth: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  rubricEmphasis: z.record(z.string(), z.number()).default({}),
  roleExpectations: z.record(z.string(), z.array(z.string())).default({}),
});
export type CompanyProfile = z.infer<typeof CompanyProfileSchema>;
