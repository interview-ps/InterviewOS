import { z } from "zod";
import {
  AnswerEvaluationSchema,
  ExpectedConceptSchema,
  LevelSchema,
  QuestionDifficultySchema,
  RoundTypeSchema,
  type AnswerEvaluation,
  type SkillId,
} from "@interview-os/core";
import { runStructured } from "../../framework/runStructured.js";
import type { InterviewSkill } from "../../framework/skill.js";
import { normalizeSkillIds, normalizeSkillIdValue } from "../../framework/common.js";
import { ANSWER_EVALUATOR_PROMPT } from "./prompt.js";

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

export const answerEvaluator: InterviewSkill<
  z.input<typeof AnswerEvaluatorInputSchema>,
  AnswerEvaluation
> = {
  id: "answer-evaluator",
  inputSchema: AnswerEvaluatorInputSchema,
  outputSchema: AnswerEvaluationSchema,
  async execute(input, ctx) {
    const output = await runStructured(ctx, {
      taskId: "answer-evaluator",
      instructions: ANSWER_EVALUATOR_PROMPT,
      input,
      schema: AnswerEvaluationAiSchema,
      streamField: "summary",
    });
    const fix = (skill: string) => normalizeSkillIdValue(skill) ?? null;
    return {
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
    };
  },
};
