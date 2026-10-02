import { z } from "zod";
import {
  CandidateSkillSchema,
  EducationSchema,
  ExperienceSchema,
  ProjectSchema,
  StarStorySchema,
  type CandidateSkill,
} from "@interview-os/core";
import { runStructured } from "../../framework/runStructured.js";
import type { InterviewSkill } from "../../framework/skill.js";
import { normalizeSkillIdValue, TaxonomyEntrySchema } from "../../framework/common.js";
import { RESUME_ANALYZER_PROMPT } from "./prompt.js";

export const ResumeAnalyzerInputSchema = z.object({
  resumeText: z.string(),
  taxonomy: z.array(TaxonomyEntrySchema),
});
export type ResumeAnalyzerInput = z.infer<typeof ResumeAnalyzerInputSchema>;

// AI output is looser on skillId (normalized + validated post-hoc).
const AnalyzedSkillSchema = z.object({
  skillId: z.string(),
  level: z.number().min(0).max(1),
  evidence: z.string(),
});

const ResumeAnalyzerAiOutputSchema = z.object({
  name: z.string().nullable(),
  headline: z.string().nullable(),
  experience: z.array(ExperienceSchema),
  skills: z.array(AnalyzedSkillSchema),
  projects: z.array(ProjectSchema),
  achievements: z.array(z.string()),
  education: z.array(EducationSchema),
  starStories: z.array(StarStorySchema),
});

export const ResumeAnalyzerOutputSchema = ResumeAnalyzerAiOutputSchema.extend({
  skills: z.array(CandidateSkillSchema),
});
export interface ResumeAnalyzerOutput {
  name: string | null;
  headline: string | null;
  experience: z.infer<typeof ExperienceSchema>[];
  skills: CandidateSkill[];
  projects: z.infer<typeof ProjectSchema>[];
  achievements: string[];
  education: z.infer<typeof EducationSchema>[];
  starStories: z.infer<typeof StarStorySchema>[];
}

export const resumeAnalyzer: InterviewSkill<ResumeAnalyzerInput, ResumeAnalyzerOutput> = {
  id: "resume-analyzer",
  inputSchema: ResumeAnalyzerInputSchema,
  outputSchema: ResumeAnalyzerOutputSchema,
  async execute(input, ctx) {
    const output = await runStructured(ctx, {
      taskId: "resume-analyzer",
      instructions: RESUME_ANALYZER_PROMPT,
      input,
      schema: ResumeAnalyzerAiOutputSchema,
    });
    const skills: CandidateSkill[] = [];
    for (const s of output.skills) {
      const skillId = normalizeSkillIdValue(s.skillId);
      if (skillId) skills.push({ skillId, level: s.level, source: "resume", evidence: s.evidence });
    }
    return { ...output, skills };
  },
};
