import { z } from "zod";
import {
  LevelSchema,
  RequirementSchema,
  ResumeTailoringSchema,
  type SkillManifest,
} from "@interview-os/core";
import { runStructured } from "../../framework/runStructured.js";
import type { InterviewSkill } from "../../framework/skill.js";
import { normalizeSkillIds } from "../../framework/common.js";
import {
  RESUME_COACH_BULLETS_PROMPT,
  RESUME_COACH_TAILOR_PROMPT,
} from "./prompt.js";

export const ResumeCoachSuggestionSchema = z.object({
  original: z.string(),
  improved: z.string(),
  rationale: z.string().default(""),
  skillIds: z.array(z.string()).default([]),
});

export const ResumeCoachInputSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("bullets"),
    /** Full resume text (untrusted) — context for rewrites. */
    resumeText: z.string(),
    /** Up to 8 weakest bullets, pre-selected deterministically by the orchestrator. */
    bullets: z.array(z.string()).min(1).max(8),
  }),
  z.object({
    mode: z.literal("tailor"),
    resumeText: z.string(),
    requirements: z.array(RequirementSchema),
    role: z.string(),
    level: LevelSchema,
  }),
]);
export type ResumeCoachInput = z.input<typeof ResumeCoachInputSchema>;

export const ResumeCoachBulletsOutputSchema = z.object({
  suggestions: z.array(ResumeCoachSuggestionSchema),
});
export type ResumeCoachBulletsOutput = z.infer<
  typeof ResumeCoachBulletsOutputSchema
>;

export const ResumeCoachTailorOutputSchema = ResumeTailoringSchema;
export type ResumeCoachTailorOutput = z.infer<
  typeof ResumeCoachTailorOutputSchema
>;

export type ResumeCoachOutput =
  | ResumeCoachBulletsOutput
  | ResumeCoachTailorOutput;

const ResumeCoachOutputSchema = z.union([
  ResumeCoachBulletsOutputSchema,
  ResumeCoachTailorOutputSchema,
]);

const manifest: SkillManifest = {
  id: "resume-coach",
  version: "1.0.0",
  kind: "builtin",
  description:
    "§9.5 resume coach — rewrites weak bullets and tailors a resume to the target role, never inventing facts.",
  inputs: [
    { key: "mode", permission: "resume.read" },
    { key: "resumeText", permission: "resume.read" },
    { key: "bullets", permission: "resume.read" },
    { key: "requirements", permission: "target.read" },
    { key: "role", permission: "target.read" },
    { key: "level", permission: "target.read" },
  ],
  outputs: ["suggestions", "tailoring"],
  permissions: [
    "resume.read",
    "target.read",
    "runtime.invoke",
    "resume.write",
  ],
};

export const resumeCoach: InterviewSkill<ResumeCoachInput, ResumeCoachOutput> = {
  id: "resume-coach",
  manifest,
  inputSchema: ResumeCoachInputSchema,
  outputSchema: ResumeCoachOutputSchema as z.ZodType<ResumeCoachOutput>,
  async execute(input, ctx) {
    if (input.mode === "bullets") {
      const output = await runStructured(ctx, {
        taskId: "resume-coach.bullets",
        instructions: RESUME_COACH_BULLETS_PROMPT,
        input,
        schema: ResumeCoachBulletsOutputSchema,
      });
      return {
        suggestions: output.suggestions.map((s) => ({
          ...s,
          skillIds: normalizeSkillIds(s.skillIds),
        })),
      };
    }
    const tailoring = await runStructured(ctx, {
      taskId: "resume-coach.tailor",
      instructions: RESUME_COACH_TAILOR_PROMPT,
      input,
      schema: ResumeCoachTailorOutputSchema,
    });
    const resumeNorm = input.resumeText.toLowerCase();
    return {
      ...tailoring,
      // §9.5: evidence must be a verbatim substring of the resume — null it out otherwise.
      alignment: tailoring.alignment.map((a) => ({
        ...a,
        resumeEvidence:
          a.resumeEvidence !== null &&
          resumeNorm.includes(a.resumeEvidence.toLowerCase())
            ? a.resumeEvidence
            : null,
      })),
    };
  },
};
