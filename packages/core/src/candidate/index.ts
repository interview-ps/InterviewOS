import { z } from "zod";
import { SkillIdSchema } from "../skill-id.js";

export const CandidateSkillSchema = z.object({
  skillId: SkillIdSchema,
  level: z.number().min(0).max(1),
  source: z.literal("resume"),
  evidence: z.string(),
});
export type CandidateSkill = z.infer<typeof CandidateSkillSchema>;

export const ExperienceSchema = z.object({
  title: z.string(),
  company: z.string(),
  start: z.string().optional(),
  end: z.string().optional(),
  highlights: z.array(z.string()).default([]),
});
export type Experience = z.infer<typeof ExperienceSchema>;

export const ProjectSchema = z.object({
  name: z.string(),
  description: z.string(),
  technologies: z.array(z.string()).default([]),
});
export type Project = z.infer<typeof ProjectSchema>;

export const EducationSchema = z.object({
  institution: z.string(),
  degree: z.string().optional(),
  field: z.string().optional(),
  end: z.string().optional(),
});
export type Education = z.infer<typeof EducationSchema>;

export const StarStorySchema = z.object({
  id: z.string(),
  title: z.string(),
  situation: z.string(),
  task: z.string(),
  action: z.string(),
  result: z.string(),
  skillIds: z.array(SkillIdSchema).default([]),
});
export type StarStory = z.infer<typeof StarStorySchema>;

export const CandidateProfileSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  headline: z.string().optional(),
  experience: z.array(ExperienceSchema).default([]),
  skills: z.array(CandidateSkillSchema).default([]),
  projects: z.array(ProjectSchema).default([]),
  achievements: z.array(z.string()).default([]),
  education: z.array(EducationSchema).default([]),
  starStories: z.array(StarStorySchema).default([]),
});
export type CandidateProfile = z.infer<typeof CandidateProfileSchema>;
