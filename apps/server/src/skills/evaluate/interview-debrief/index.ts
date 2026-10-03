import { z } from "zod";
import type { SkillManifest } from "@interview-os/core";
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

const manifest: SkillManifest = {
  id: "interview-debrief",
  version: "1.0.0",
  kind: "builtin",
  description:
    "Summarises a completed interview session: what went well, what to improve, next actions.",
  inputs: [
    { key: "role", permission: "target.read" },
    { key: "questions", permission: "interview.read" },
    { key: "evaluations", permission: "interview.read" },
    { key: "readinessBefore", permission: "readiness.read" },
    { key: "readinessAfter", permission: "readiness.read" },
    { key: "openActions", permission: "readiness.read" },
  ],
  outputs: ["debrief"],
  permissions: [
    "target.read",
    "interview.read",
    "readiness.read",
    "runtime.invoke",
    "interview.write",
  ],
};

export const interviewDebrief: InterviewSkill<
  InterviewDebriefInput,
  InterviewDebriefOutput
> = {
  id: "interview-debrief",
  manifest,
  inputSchema: InterviewDebriefInputSchema,
  outputSchema: InterviewDebriefOutputSchema,
  async execute(input, ctx) {
    return runStructured(ctx, {
      taskId: "interview-debrief",
      instructions: INTERVIEW_DEBRIEF_PROMPT,
      input,
      schema: InterviewDebriefOutputSchema,
      streamField: "summary",
    });
  },
};
