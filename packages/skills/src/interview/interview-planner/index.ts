import { z } from "zod";
import {
  EvidenceSchema,
  RequirementSchema,
  selectNextSkill,
  SkillIdSchema,
  SkillReadinessSchema,
  type Evidence,
  type SelectNextSkillResult,
  type SkillId,
  type SkillReadiness,
} from "@interview-os/core";
import type { InterviewSkill } from "../../framework/skill.js";

export const InterviewPlannerInputSchema = z.object({
  requirements: z.array(RequirementSchema),
  readiness: z.record(z.string(), SkillReadinessSchema),
  evidence: z.array(EvidenceSchema),
  askedThisSession: z.array(SkillIdSchema),
  askedPreviousSession: z.array(SkillIdSchema),
  questionIndex: z.number().int().min(0),
});
export type InterviewPlannerInput = z.infer<typeof InterviewPlannerInputSchema>;

export const InterviewPlannerOutputSchema = z.object({
  skillId: SkillIdSchema,
  priority: z.number(),
  reason: z.string(),
  candidates: z.array(
    z.object({ skillId: SkillIdSchema, priority: z.number(), reason: z.string() }),
  ),
});
export type InterviewPlannerOutput = SelectNextSkillResult | null;

/** Deterministic — wraps core/interview/prioritize. */
export const interviewPlanner: InterviewSkill<
  InterviewPlannerInput,
  InterviewPlannerOutput
> = {
  id: "interview-planner",
  inputSchema: InterviewPlannerInputSchema,
  outputSchema: InterviewPlannerOutputSchema.nullable() as z.ZodType<InterviewPlannerOutput>,
  async execute(input) {
    return selectNextSkill({
      requirements: input.requirements,
      readiness: input.readiness as Record<SkillId, SkillReadiness>,
      evidence: input.evidence as Evidence[],
      askedThisSession: input.askedThisSession as SkillId[],
      askedPreviousSession: input.askedPreviousSession as SkillId[],
      questionIndex: input.questionIndex,
    });
  },
};
