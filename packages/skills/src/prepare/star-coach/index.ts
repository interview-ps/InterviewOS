import { z } from "zod";
import {
  ExperienceSchema,
  LevelSchema,
  ProjectSchema,
  type SkillId,
} from "@interview-os/core";
import { runStructured } from "../../framework/runStructured.js";
import type { InterviewSkill } from "../../framework/skill.js";
import { normalizeSkillIds } from "../../framework/common.js";
import { STAR_COACH_GENERATE_PROMPT, STAR_COACH_REVIEW_PROMPT } from "./prompt.js";

const StoryDraftSchema = z.object({
  title: z.string(),
  situation: z.string().default(""),
  task: z.string().default(""),
  action: z.string().default(""),
  result: z.string().default(""),
  skillIds: z.array(z.string()).default([]),
});

export const StarCoachInputSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("generate"),
    experience: z.array(ExperienceSchema).default([]),
    achievements: z.array(z.string()).default([]),
    projects: z.array(ProjectSchema).default([]),
    /** Behavioral requirement skills the stories should cover. */
    behavioralSkillIds: z.array(z.string()).default([]),
    existingTitles: z.array(z.string()).default([]),
  }),
  z.object({
    mode: z.literal("review"),
    story: z.object({
      title: z.string(),
      situation: z.string(),
      task: z.string(),
      action: z.string(),
      result: z.string(),
      skillIds: z.array(z.string()).default([]),
    }),
    role: z.string(),
    level: LevelSchema,
  }),
]);
export type StarCoachInput = z.input<typeof StarCoachInputSchema>;

export const StarCoachGenerateOutputSchema = z.object({
  stories: z.array(StoryDraftSchema),
});
export interface StarCoachGenerateOutput {
  stories: Array<{
    title: string;
    situation: string;
    task: string;
    action: string;
    result: string;
    skillIds: SkillId[];
  }>;
}

export const StarCoachReviewOutputSchema = z.object({
  feedback: z.string(),
  missing: z.array(z.string()).default([]),
  suggestions: z.array(z.string()).default([]),
  improvedDraft: z.object({
    situation: z.string(),
    task: z.string(),
    action: z.string(),
    result: z.string(),
  }),
});
export type StarCoachReviewOutput = z.infer<typeof StarCoachReviewOutputSchema>;

export type StarCoachOutput = StarCoachGenerateOutput | StarCoachReviewOutput;

const StarCoachOutputSchema = z.union([
  StarCoachGenerateOutputSchema,
  StarCoachReviewOutputSchema,
]);

export const starCoach: InterviewSkill<StarCoachInput, StarCoachOutput> = {
  id: "star-coach",
  inputSchema: StarCoachInputSchema,
  outputSchema: StarCoachOutputSchema as z.ZodType<StarCoachOutput>,
  async execute(input, ctx) {
    if (input.mode === "generate") {
      const output = await runStructured(ctx, {
        taskId: "star-coach.generate",
        instructions: STAR_COACH_GENERATE_PROMPT,
        input,
        schema: StarCoachGenerateOutputSchema,
      });
      return {
        stories: output.stories.map((s) => ({
          ...s,
          skillIds: normalizeSkillIds(s.skillIds),
        })),
      };
    }
    return runStructured(ctx, {
      taskId: "star-coach.review",
      instructions: STAR_COACH_REVIEW_PROMPT,
      input,
      schema: StarCoachReviewOutputSchema,
      streamField: "feedback",
    });
  },
};
