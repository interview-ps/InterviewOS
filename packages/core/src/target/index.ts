import { z } from "zod";
import { SkillIdSchema } from "../skill-id.js";

export const LevelSchema = z.enum(["junior", "mid", "senior", "staff"]);
export type Level = z.infer<typeof LevelSchema>;

export const RequirementSchema = z.object({
  skillId: SkillIdSchema,
  label: z.string(),
  importance: z.number().min(0).max(1),
  /** JD-analyzer importance before any boosts — boosts recompute from it (§9.3). */
  baseImportance: z.number().min(0).max(1).optional(),
  kind: z.enum(["required", "preferred"]),
  evidence: z.string(),
  /** e.g. "company-profile" / "company-profile:amazon" — why importance was raised. */
  boostedBy: z.string().optional(),
  /** v0.4: where the requirement came from ("jd" default, "role_pack"). */
  origin: z.string().max(64).optional(),
});
export type Requirement = z.infer<typeof RequirementSchema>;

/** §8.4: profile derived from untrusted pasted company notes (an overlay). */
export const CompanyNotesProfileSchema = z.object({
  values: z.array(z.string()).default([]),
  interviewStyle: z.string().default(""),
  focusSkillIds: z.array(SkillIdSchema).default([]),
  behavioralThemes: z.array(z.string()).default([]),
});
export type CompanyNotesProfile = z.infer<typeof CompanyNotesProfileSchema>;

export const TargetRoleSchema = z.object({
  id: z.string(),
  company: z.string(),
  role: z.string(),
  level: LevelSchema,
  jobDescription: z.string(),
  companyNotes: z.string().optional(),
  requirements: z.array(RequirementSchema).default([]),
  preferredSkills: z.array(RequirementSchema).default([]),
  companyProfile: CompanyNotesProfileSchema.optional(),
  /** §9.3 built-in company profile id (auto-matched from `company`). */
  companyProfileId: z.string().optional(),
  /** v0.4: assigned role pack id (packs add requirements + rubrics). */
  rolePackId: z.string().max(80).optional(),
});
export type TargetRole = z.infer<typeof TargetRoleSchema>;
