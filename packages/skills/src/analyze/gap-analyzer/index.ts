import { z } from "zod";
import {
  calculateGaps,
  GapSchema,
  LevelSchema,
  RequirementSchema,
  SkillReadinessSchema,
  type Gap,
  type SkillId,
  type SkillManifest,
  type SkillReadiness,
} from "@interview-os/core";
import type { InterviewSkill } from "../../framework/skill.js";

export const GapAnalyzerInputSchema = z.object({
  requirements: z.array(RequirementSchema),
  readiness: z.record(z.string(), SkillReadinessSchema),
  level: LevelSchema,
});
export type GapAnalyzerInput = z.infer<typeof GapAnalyzerInputSchema>;

export const GapAnalyzerOutputSchema = z.array(GapSchema);
export type GapAnalyzerOutput = Gap[];

const manifest: SkillManifest = {
  id: "gap-analyzer",
  version: "1.0.0",
  kind: "builtin",
  description:
    "Deterministically diff target requirements against current readiness into a ranked gap list.",
  inputs: [
    { key: "requirements", permission: "target.read" },
    { key: "readiness", permission: "readiness.read" },
    { key: "level", permission: "target.read" },
  ],
  outputs: ["gaps"],
  permissions: ["target.read", "readiness.read"],
};

/** Deterministic — wraps core/gaps. */
export const gapAnalyzer: InterviewSkill<GapAnalyzerInput, GapAnalyzerOutput> = {
  id: "gap-analyzer",
  manifest,
  inputSchema: GapAnalyzerInputSchema,
  outputSchema: GapAnalyzerOutputSchema,
  async execute(input) {
    return calculateGaps({
      requirements: input.requirements,
      readiness: input.readiness as Record<SkillId, SkillReadiness>,
      level: input.level,
    });
  },
};
