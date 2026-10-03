import { z } from "zod";
import { LoopDebriefSchema, RoundHandoffSchema, type SkillManifest } from "@interview-os/core";
import { runStructured } from "../../framework/runStructured.js";
import type { InterviewSkill } from "../../framework/skill.js";
import { LOOP_DEBRIEF_PROMPT } from "./prompt.js";

/** §9.4: one completed loop round as the debrief sees it. */
export const LoopDebriefRoundInputSchema = z.object({
  mode: z.string(),
  label: z.string().default(""),
  summaries: z.array(z.string()).default([]),
  /** Mean score per rubric dimension this round. */
  rubricAverages: z.record(z.string(), z.number()).default({}),
  handoff: RoundHandoffSchema.nullable().default(null),
});

export const LoopDebriefInputSchema = z.object({
  role: z.string(),
  company: z.string().default(""),
  rounds: z.array(LoopDebriefRoundInputSchema),
  readinessChange: z.object({
    before: z.number().nullable(),
    after: z.number().nullable(),
  }),
});
export type LoopDebriefInput = z.input<typeof LoopDebriefInputSchema>;

const manifest: SkillManifest = {
  id: "loop-debrief",
  version: "1.0.0",
  kind: "builtin",
  description:
    "Summarises a completed multi-round loop into per-round signals and a readiness change — never a hire verdict.",
  inputs: [
    { key: "role", permission: "target.read" },
    { key: "company", permission: "target.read" },
    { key: "rounds", permission: "interview.read" },
    { key: "readinessChange", permission: "readiness.read" },
  ],
  outputs: ["loopDebrief"],
  permissions: [
    "target.read",
    "interview.read",
    "readiness.read",
    "runtime.invoke",
    "interview.write",
  ],
};

export const loopDebrief: InterviewSkill<
  LoopDebriefInput,
  z.infer<typeof LoopDebriefSchema>
> = {
  id: "loop-debrief",
  manifest,
  inputSchema: LoopDebriefInputSchema,
  outputSchema: LoopDebriefSchema,
  async execute(input, ctx) {
    return runStructured(ctx, {
      taskId: "loop-debrief",
      instructions: LOOP_DEBRIEF_PROMPT,
      input,
      schema: LoopDebriefSchema,
      streamField: "summary",
    });
  },
};
