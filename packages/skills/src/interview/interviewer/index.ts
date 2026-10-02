import { z } from "zod";
import {
  ExpectedConceptSchema,
  LevelSchema,
  RoundTypeSchema,
  type SkillId,
} from "@interview-os/core";
import { runStructured } from "../../framework/runStructured.js";
import type { InterviewSkill } from "../../framework/skill.js";
import { normalizeSkillIds, normalizeSkillIdValue } from "../../framework/common.js";
import { INTERVIEWER_PROMPT } from "./prompt.js";

export const InterviewerInputSchema = z.object({
  skillId: z.string(),
  label: z.string(),
  role: z.string(),
  level: LevelSchema,
  company: z.string(),
  reason: z.string(),
  previousQuestions: z.array(z.string()),
  candidateSummary: z.string(),
  /** §8.4 round type — shapes the interviewer persona. */
  roundType: RoundTypeSchema.default("mixed"),
  /** Company behavioral themes (values etc.), for behavioral/hr questions. */
  companyThemes: z.array(z.string()).default([]),
  /** Titles of the candidate's STAR stories a behavioral interviewer may reference. */
  storyTitles: z.array(z.string()).default([]),
});
export type InterviewerInput = z.input<typeof InterviewerInputSchema>;

const InterviewerConceptSchema = z.object({
  concept: z.string(),
  skillId: z.string(),
  keywords: z.array(z.string()).default([]),
});

export const InterviewerOutputSchema = z.object({
  question: z.string(),
  topic: z.string(),
  skillId: z.string(),
  subSkills: z.array(z.string()).default([]),
  expectedConcepts: z.array(InterviewerConceptSchema).default([]),
  difficulty: z.enum(["easy", "medium", "hard"]),
});

export interface InterviewerOutput {
  question: string;
  topic: string;
  skillId: SkillId;
  subSkills: SkillId[];
  expectedConcepts: Array<{ concept: string; skillId: SkillId; keywords: string[] }>;
  difficulty: "easy" | "medium" | "hard";
}

export const interviewer: InterviewSkill<
  z.input<typeof InterviewerInputSchema>,
  InterviewerOutput
> = {
  id: "interviewer",
  inputSchema: InterviewerInputSchema,
  outputSchema: InterviewerOutputSchema as z.ZodType<InterviewerOutput>,
  async execute(input, ctx) {
    const output = await runStructured(ctx, {
      taskId: "interviewer",
      instructions: INTERVIEWER_PROMPT,
      input,
      schema: InterviewerOutputSchema,
      streamField: "question",
      // interviewer prefers the session thread when one is attached to ctx
      session: ctx.runtimeSessionId
        ? { runtimeSessionId: ctx.runtimeSessionId }
        : undefined,
    });
    const skillId = normalizeSkillIdValue(output.skillId) ?? (input.skillId as SkillId);
    return {
      question: output.question,
      topic: output.topic,
      skillId,
      subSkills: normalizeSkillIds(output.subSkills),
      expectedConcepts: output.expectedConcepts
        .map((c) => ({ ...c, skillId: normalizeSkillIdValue(c.skillId) }))
        .filter((c): c is { concept: string; skillId: SkillId; keywords: string[] } => c.skillId !== null),
      difficulty: output.difficulty,
    };
  },
};
