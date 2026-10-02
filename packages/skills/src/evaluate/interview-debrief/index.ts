import { z } from "zod";
import { runStructured } from "../../framework/runStructured.js";
import type { InterviewSkill } from "../../framework/skill.js";
import { INTERVIEW_DEBRIEF_PROMPT } from "./prompt.js";

export const InterviewDebriefInputSchema = z.object({
  role: z.string(),
  questions: z.array(
    z.object({
      text: z.string(),
      skillId: z.string(),
      topic: z.string().default(""),
    }),
  ),
  evaluations: z.array(z.unknown()),
  readinessBefore: z.record(z.string(), z.number().nullable()).default({}),
  readinessAfter: z.record(z.string(), z.number().nullable()).default({}),
  openActions: z.array(z.object({ skillId: z.string(), action: z.string() })).default([]),
});
export type InterviewDebriefInput = z.infer<typeof InterviewDebriefInputSchema>;

export const InterviewDebriefOutputSchema = z.object({
  summary: z.string(),
  wentWell: z.array(z.string()),
  toImprove: z.array(z.string()),
  nextActions: z.array(z.string()),
});
export type InterviewDebriefOutput = z.infer<typeof InterviewDebriefOutputSchema>;

export const interviewDebrief: InterviewSkill<
  InterviewDebriefInput,
  InterviewDebriefOutput
> = {
  id: "interview-debrief",
  inputSchema: InterviewDebriefInputSchema,
  outputSchema: InterviewDebriefOutputSchema,
  async execute(input, ctx) {
    return runStructured(ctx, {
      taskId: "interview-debrief",
      instructions: INTERVIEW_DEBRIEF_PROMPT,
      input,
      schema: InterviewDebriefOutputSchema,
    });
  },
};
