import { z } from "zod";
import { SkillIdSchema } from "../skill-id.js";

export const GapSeveritySchema = z.enum(["low", "medium", "high"]);
export type GapSeverity = z.infer<typeof GapSeveritySchema>;

export const GapSchema = z.object({
  skillId: SkillIdSchema,
  label: z.string(),
  importance: z.number().min(0).max(1),
  targetScore: z.number().min(0).max(1),
  currentScore: z.number().min(0).max(1).nullable(),
  gap: z.number().min(0),
  uncertainty: z.number().min(0).max(1),
  severity: GapSeveritySchema,
  reason: z.string(),
});
export type Gap = z.infer<typeof GapSchema>;
