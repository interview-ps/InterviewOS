import { z } from "zod";
import {
  AnswerEvaluationSchema,
  ExpectedConceptSchema,
  getMode,
  isModeId,
  LevelSchema,
  normalizeEvaluation,
  QuestionDifficultySchema,
  RoundTypeSchema,
  type AnswerEvaluation,
  type SkillId,
  type SkillManifest,
} from "@interview-os/core";
import { runStructured } from "../../framework/runStructured.js";
import type { InterviewSkill } from "../../framework/skill.js";
import { normalizeSkillIds, normalizeSkillIdValue } from "../../framework/common.js";
import { ANSWER_EVALUATOR_PROMPT } from "./prompt.js";
import { TECHNICAL_EVALUATOR_PROMPT } from "../../interview/modes/technical/evaluator.js";
import { CODING_EVALUATOR_PROMPT } from "../../interview/modes/coding/evaluator.js";
import { SYSTEM_DESIGN_EVALUATOR_PROMPT } from "../../interview/modes/system-design/evaluator.js";
import { BEHAVIORAL_EVALUATOR_PROMPT } from "../../interview/modes/behavioral/evaluator.js";
import { HIRING_MANAGER_EVALUATOR_PROMPT } from "../../interview/modes/hiring-manager/evaluator.js";
import { HR_EVALUATOR_PROMPT } from "../../interview/modes/hr/evaluator.js";

export const AnswerEvaluatorInputSchema = z.object({
  question: z.object({
    text: z.string(),
    topic: z.string(),
    skillId: z.string(),
    expectedConcepts: z.array(ExpectedConceptSchema).default([]),
    difficulty: QuestionDifficultySchema,
  }),
  answer: z.string(),
  role: z.string(),
  level: LevelSchema,
  /** §8.4: behavioral/hr rounds require a STAR assessment. */
  roundType: RoundTypeSchema.default("mixed"),
  /** §9.1 interview mode (defaults to roundType). */
  mode: RoundTypeSchema.optional(),
  /** §9.1: optional submitted code + language (coding rounds). */
  code: z.string().nullable().default(null),
  language: z.string().nullable().default(null),
  /** Per-mode state blob (system-design dimension status etc.). */
  modeState: z.record(z.string(), z.unknown()).default({}),
});
export type AnswerEvaluatorInput = z.input<typeof AnswerEvaluatorInputSchema>;

/** AI output keeps skill ids loose; they are normalized post-hoc. */
export const AnswerEvaluationAiSchema = AnswerEvaluationSchema.extend({
  strengths: z.array(z.object({ skill: z.string(), evidence: z.string() })),
  weaknesses: z.array(
    z.object({
      skill: z.string(),
      severity: z.enum(["low", "medium", "high"]),
      evidence: z.string(),
    }),
  ),
  scores: z.array(
    z.object({
      skill: z.string(),
      score: z.number().min(0).max(1),
      confidence: z.number().min(0).max(1),
    }),
  ),
});

const MODE_PROMPTS: Record<string, string> = {
  technical: TECHNICAL_EVALUATOR_PROMPT,
  coding: CODING_EVALUATOR_PROMPT,
  system_design: SYSTEM_DESIGN_EVALUATOR_PROMPT,
  behavioral: BEHAVIORAL_EVALUATOR_PROMPT,
  hiring_manager: HIRING_MANAGER_EVALUATOR_PROMPT,
  hr: HR_EVALUATOR_PROMPT,
};

/** §9.2: a mode's evaluation must carry exactly its rubric ids — malformed otherwise. */
function rubricSchemaFor(mode: string) {
  if (!isModeId(mode)) return AnswerEvaluationAiSchema;
  const expected = getMode(mode)
    .rubric.map((r) => r.id)
    .sort();
  return AnswerEvaluationAiSchema.superRefine((val, ctx) => {
    const actual = val.rubric.map((r) => r.id).sort();
    if (actual.length !== expected.length || actual.some((id, i) => id !== expected[i])) {
      ctx.addIssue({
        code: "custom",
        path: ["rubric"],
        message: `rubric must contain exactly [${expected.join(", ")}], got [${actual.join(", ")}]`,
      });
    }
  });
}

const manifest: SkillManifest = {
  id: "answer-evaluator",
  version: "1.0.0",
  kind: "builtin",
  description:
    "Scores an interview answer against the mode rubric; produces evidence for the readiness graph.",
  inputs: [
    { key: "question", permission: "interview.read" },
    { key: "answer", permission: "interview.read" },
    { key: "role", permission: "target.read" },
    { key: "level", permission: "target.read" },
    { key: "roundType", permission: "interview.read" },
    { key: "mode", permission: "interview.read" },
    { key: "code", permission: "interview.read" },
    { key: "language", permission: "interview.read" },
    { key: "modeState", permission: "interview.read" },
  ],
  outputs: ["evaluation", "evidence"],
  permissions: [
    "interview.read",
    "target.read",
    "runtime.invoke",
    "evidence.write",
    "interview.write",
  ],
};

export const answerEvaluator: InterviewSkill<
  z.input<typeof AnswerEvaluatorInputSchema>,
  AnswerEvaluation
> = {
  id: "answer-evaluator",
  manifest,
  inputSchema: AnswerEvaluatorInputSchema,
  outputSchema: AnswerEvaluationSchema,
  async execute(input, ctx) {
    const mode = input.mode ?? input.roundType ?? "mixed";
    const output = await runStructured(ctx, {
      taskId:
        mode === "mixed" || !isModeId(mode)
          ? "answer-evaluator"
          : `answer-evaluator.${mode}`,
      instructions:
        mode === "mixed" || !isModeId(mode)
          ? ANSWER_EVALUATOR_PROMPT
          : MODE_PROMPTS[mode]!,
      input,
      schema: rubricSchemaFor(mode),
      streamField: "summary",
    });
    const fix = (skill: string) => normalizeSkillIdValue(skill) ?? null;
    // merge duplicate per-skill entries (mock can emit one per concept)
    return normalizeEvaluation({
      ...output,
      strengths: output.strengths
        .map((s) => ({ ...s, skill: fix(s.skill) }))
        .filter((s): s is { skill: SkillId; evidence: string } => s.skill !== null),
      weaknesses: output.weaknesses
        .map((w) => ({ ...w, skill: fix(w.skill) }))
        .filter(
          (w): w is { skill: SkillId; severity: "low" | "medium" | "high"; evidence: string } =>
            w.skill !== null,
        ),
      scores: output.scores
        .map((s) => ({ ...s, skill: fix(s.skill) }))
        .filter(
          (s): s is { skill: SkillId; score: number; confidence: number } => s.skill !== null,
        ),
    });
  },
};
