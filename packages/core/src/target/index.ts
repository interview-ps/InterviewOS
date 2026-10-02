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
  /** e.g. "company-profile" — why this importance was raised (§8.4). */
  boostedBy: z.string().optional(),
});
export type Requirement = z.infer<typeof RequirementSchema>;

export const CompanyProfileSchema = z.object({
  values: z.array(z.string()).default([]),
  interviewStyle: z.string().default(""),
  focusSkillIds: z.array(SkillIdSchema).default([]),
  behavioralThemes: z.array(z.string()).default([]),
});
export type CompanyProfile = z.infer<typeof CompanyProfileSchema>;

export const TargetRoleSchema = z.object({
  id: z.string(),
  company: z.string(),
  role: z.string(),
  level: LevelSchema,
  jobDescription: z.string(),
  companyNotes: z.string().optional(),
  requirements: z.array(RequirementSchema).default([]),
  preferredSkills: z.array(RequirementSchema).default([]),
  companyProfile: CompanyProfileSchema.optional(),
});
export type TargetRole = z.infer<typeof TargetRoleSchema>;
