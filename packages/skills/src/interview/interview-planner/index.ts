import { z } from "zod";
import {
  EvidenceSchema,
  LevelSchema,
  RequirementSchema,
  RoundTypeSchema,
  selectNextSkill,
  SkillIdSchema,
  SkillReadinessSchema,
  type Evidence,
  type Level,
  type LoopWeakSkill,
  type RoundType,
  type SelectNextSkillResult,
  type SkillId,
  type SkillManifest,
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
  /** §9.2 engine inputs. */
  roundType: RoundTypeSchema.optional(),
  mode: RoundTypeSchema.optional(),
  level: LevelSchema.optional(),
  askCounts: z.record(z.string(), z.number().int().min(0)).default({}),
  loopWeakSkills: z
    .array(
      z.object({
        skillId: SkillIdSchema,
        round: z.number().int().min(1),
        mode: z.string(),
      }),
    )
    .default([]),
});
export type InterviewPlannerInput = z.input<typeof InterviewPlannerInputSchema>;

export const InterviewPlannerOutputSchema = z
  .object({
    skillId: SkillIdSchema,
    priority: z.number(),
    reason: z.string(),
    candidates: z.array(
      z.object({
        skillId: SkillIdSchema,
        priority: z.number(),
        reason: z.string(),
      }),
    ),
  })
  .passthrough()
  .nullable();
export type InterviewPlannerOutput = SelectNextSkillResult | null;

const manifest: SkillManifest = {
  id: "interview-planner",
  version: "1.0.0",
  kind: "builtin",
  description:
    "Deterministic engine — picks the next skill to ask about from requirements, readiness, evidence and loop weakness handoffs.",
  inputs: [
    { key: "requirements", permission: "target.read" },
    { key: "readiness", permission: "readiness.read" },
    { key: "evidence", permission: "readiness.read" },
    { key: "askedThisSession", permission: "interview.read" },
    { key: "askedPreviousSession", permission: "interview.read" },
    { key: "questionIndex", permission: "interview.read" },
    { key: "roundType", permission: "interview.read" },
    { key: "mode", permission: "interview.read" },
    { key: "level", permission: "target.read" },
    { key: "askCounts", permission: "interview.read" },
    { key: "loopWeakSkills", permission: "interview.read" },
  ],
  outputs: ["selection"],
  permissions: ["target.read", "readiness.read", "interview.read"],
};

/** Deterministic — wraps core/interview/prioritize. */
export const interviewPlanner: InterviewSkill<
  InterviewPlannerInput,
  InterviewPlannerOutput
> = {
  id: "interview-planner",
  manifest,
  inputSchema: InterviewPlannerInputSchema,
  outputSchema: InterviewPlannerOutputSchema as z.ZodType<InterviewPlannerOutput>,
  async execute(input) {
    return selectNextSkill({
      requirements: input.requirements,
      readiness: input.readiness as Record<SkillId, SkillReadiness>,
      evidence: input.evidence as Evidence[],
      askedThisSession: input.askedThisSession as SkillId[],
      askedPreviousSession: input.askedPreviousSession as SkillId[],
      questionIndex: input.questionIndex,
      roundType: input.roundType as RoundType | undefined,
      mode: input.mode as RoundType | undefined,
      level: input.level as Level | undefined,
      askCounts: input.askCounts as Record<SkillId, number>,
      loopWeakSkills: input.loopWeakSkills as LoopWeakSkill[],
    });
  },
};
