import { z } from "zod";
import { LevelSchema, type SkillManifest } from "@interview-os/core";
import { runStructured } from "../../framework/runStructured.js";
import type { InterviewSkill } from "../../framework/skill.js";
import { normalizeSkillIdValue } from "../../framework/common.js";
import { PREP_PLANNER_PROMPT } from "./prompt.js";

export const PrepTargetSchema = z.object({
  skillId: z.string(),
  label: z.string(),
  reason: z.string(),
  missingConcepts: z.array(z.string()).default([]),
  severity: z.enum(["low", "medium", "high"]),
});

export const PrepPlannerInputSchema = z.object({
  targets: z.array(PrepTargetSchema),
  role: z.string(),
  level: LevelSchema,
});
export type PrepPlannerInput = z.infer<typeof PrepPlannerInputSchema>;

export const PrepPlannerOutputSchema = z.object({
  actions: z.array(
    z.object({
      skillId: z.string(),
      action: z.string(),
      successCriteria: z.array(z.string()).min(2).max(4),
      reason: z.string(),
    }),
  ),
});
export type PrepPlannerOutput = z.infer<typeof PrepPlannerOutputSchema>;

const manifest: SkillManifest = {
  id: "prep-planner",
  version: "1.0.0",
  kind: "builtin",
  description:
    "Turns ranked gaps into concrete preparation actions with success criteria.",
  inputs: [
    { key: "targets", permission: "readiness.read" },
    { key: "role", permission: "target.read" },
    { key: "level", permission: "target.read" },
  ],
  outputs: ["actions"],
  permissions: [
    "target.read",
    "readiness.read",
    "runtime.invoke",
    "preparation.write",
  ],
};

export const prepPlanner: InterviewSkill<PrepPlannerInput, PrepPlannerOutput> = {
  id: "prep-planner",
  manifest,
  inputSchema: PrepPlannerInputSchema,
  outputSchema: PrepPlannerOutputSchema,
  async execute(input, ctx) {
    const output = await runStructured(ctx, {
      taskId: "prep-planner",
      instructions: PREP_PLANNER_PROMPT,
      input,
      schema: PrepPlannerOutputSchema,
    });
    return {
      actions: output.actions
        .map((a) => ({ ...a, skillId: normalizeSkillIdValue(a.skillId) }))
        .filter((a): a is typeof a & { skillId: string } => a.skillId !== null),
    };
  },
};
