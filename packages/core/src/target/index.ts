import { z } from "zod";
import { SkillIdSchema } from "../skill-id.js";

export const LevelSchema = z.enum(["junior", "mid", "senior", "staff"]);
export type Level = z.infer<typeof LevelSchema>;

export const RequirementSchema = z.object({
  skillId: SkillIdSchema,
  label: z.string(),
  importance: z.number().min(0).max(1),
  kind: z.enum(["required", "preferred"]),
  evidence: z.string(),
});
export type Requirement = z.infer<typeof RequirementSchema>;

export const TargetRoleSchema = z.object({
  id: z.string(),
  company: z.string(),
  role: z.string(),
  level: LevelSchema,
  jobDescription: z.string(),
  requirements: z.array(RequirementSchema).default([]),
  preferredSkills: z.array(RequirementSchema).default([]),
});
export type TargetRole = z.infer<typeof TargetRoleSchema>;
