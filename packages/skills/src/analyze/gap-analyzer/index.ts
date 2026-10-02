import { z } from "zod";
import {
  calculateGaps,
  GapSchema,
  LevelSchema,
  RequirementSchema,
  SkillReadinessSchema,
  type Gap,
  type SkillId,
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

/** Deterministic — wraps core/gaps. */
export const gapAnalyzer: InterviewSkill<GapAnalyzerInput, GapAnalyzerOutput> = {
  id: "gap-analyzer",
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
