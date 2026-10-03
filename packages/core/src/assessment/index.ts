import { z } from "zod";
import { SkillIdSchema } from "../skill-id.js";
import { GapSchema } from "../gaps/schema.js";
import { SkillReadinessSchema } from "../readiness/schema.js";

export const EvaluationDimensionSchema = z.object({
  score: z.number().min(0).max(1),
  rationale: z.string(),
});
export type EvaluationDimension = z.infer<typeof EvaluationDimensionSchema>;

/** STAR coverage for behavioral/hr answers (§8.4); null for other rounds. */
export const StarAssessmentSchema = z.object({
  situation: z.boolean(),
  task: z.boolean(),
  action: z.boolean(),
  result: z.boolean(),
  notes: z.string(),
});
export type StarAssessment = z.infer<typeof StarAssessmentSchema>;

/** §9.1: one independently-scored rubric dimension of an interview mode. */
export const RubricScoreSchema = z.object({
  id: z.string(),
  label: z.string().default(""),
  score: z.number().min(0).max(1),
  rationale: z.string().default(""),
});
export type RubricScore = z.infer<typeof RubricScoreSchema>;

/** §9.1: evaluator's per-dimension coverage update for system-design turns. */
export const DesignUpdateSchema = z.object({
  dimension: z.string(),
  status: z.enum(["not_covered", "partial", "covered"]),
  notes: z.string().default(""),
});
export type DesignUpdate = z.infer<typeof DesignUpdateSchema>;

export const AnswerEvaluationSchema = z.object({
  summary: z.string(),
  dimensions: z.object({
    correctness: EvaluationDimensionSchema,
    technicalDepth: EvaluationDimensionSchema,
    reasoning: EvaluationDimensionSchema,
    structure: EvaluationDimensionSchema,
    communication: EvaluationDimensionSchema,
    evidence: EvaluationDimensionSchema,
    roleRelevance: EvaluationDimensionSchema,
  }),
  strengths: z.array(z.object({ skill: SkillIdSchema, evidence: z.string() })),
  weaknesses: z.array(
    z.object({
      skill: SkillIdSchema,
      severity: z.enum(["low", "medium", "high"]),
      evidence: z.string(),
    }),
  ),
  scores: z.array(
    z.object({
      skill: SkillIdSchema,
      score: z.number().min(0).max(1),
      confidence: z.number().min(0).max(1),
    }),
  ),
  missingConcepts: z.array(z.string()),
  betterApproach: z.string(),
  followUpTopics: z.array(z.string()),
  star: StarAssessmentSchema.nullable().default(null),
  /** §9.1 mode rubric — exactly the mode's rubric ids (empty for "mixed"). */
  rubric: z.array(RubricScoreSchema).default([]),
  /** §9.1 system_design: per-dimension coverage updates from the evaluator. */
  designUpdates: z.array(DesignUpdateSchema).nullable().default(null),
});
export type AnswerEvaluation = z.infer<typeof AnswerEvaluationSchema>;

/**
 * §9.1 contract: a mode evaluation must score exactly the mode's rubric ids.
 * Throws on mismatch — callers treat it as malformed output (retry path).
 */
export function assertRubricIds(
  evaluation: Pick<AnswerEvaluation, "rubric">,
  mode: { id: string; rubric: { id: string }[] },
): void {
  const expected = mode.rubric.map((r) => r.id).sort();
  const actual = [...evaluation.rubric.map((r) => r.id)].sort();
  if (actual.length !== expected.length || actual.some((id, i) => id !== expected[i])) {
    throw new Error(
      `rubric mismatch for mode "${mode.id}": expected [${expected.join(", ")}], got [${actual.join(", ")}]`,
    );
  }
}

const SEVERITY_RANK = { low: 0, medium: 1, high: 2 } as const;

/**
 * Merge duplicate per-skill entries an evaluator (mock or model) may emit:
 * weaknesses keep the worst severity and join evidence, strengths join
 * evidence, scores average with max confidence, missingConcepts deduped.
 * Idempotent — safe to re-apply (orchestrator applies it again on persist).
 */
export function normalizeEvaluation<T extends AnswerEvaluation>(e: T): T {
  const weaknesses = new Map<string, (typeof e.weaknesses)[number]>();
  for (const w of e.weaknesses) {
    const cur = weaknesses.get(w.skill);
    if (!cur) {
      weaknesses.set(w.skill, { ...w });
    } else {
      if (SEVERITY_RANK[w.severity] > SEVERITY_RANK[cur.severity]) cur.severity = w.severity;
      cur.evidence = `${cur.evidence}; ${w.evidence}`;
    }
  }
  const strengths = new Map<string, (typeof e.strengths)[number]>();
  for (const s of e.strengths) {
    const cur = strengths.get(s.skill);
    if (!cur) strengths.set(s.skill, { ...s });
    else cur.evidence = `${cur.evidence}; ${s.evidence}`;
  }
  const scoreAcc = new Map<string, { sum: number; n: number; confidence: number }>();
  for (const s of e.scores) {
    const cur = scoreAcc.get(s.skill) ?? { sum: 0, n: 0, confidence: 0 };
    cur.sum += s.score;
    cur.n += 1;
    cur.confidence = Math.max(cur.confidence, s.confidence);
    scoreAcc.set(s.skill, cur);
  }
  return {
    ...e,
    strengths: [...strengths.values()],
    weaknesses: [...weaknesses.values()],
    scores: [...scoreAcc.entries()].map(([skill, a]) => ({
      skill: skill as (typeof e.scores)[number]["skill"],
      score: a.sum / a.n,
      confidence: a.confidence,
    })),
    missingConcepts: [...new Set(e.missingConcepts)],
  };
}

export const AssessedItemSchema = z.object({
  skillId: SkillIdSchema,
  note: z.string(),
  evidenceIds: z.array(z.string()).default([]),
});
export type AssessedItem = z.infer<typeof AssessedItemSchema>;

export const AssessmentStateSchema = z.object({
  strengths: z.array(AssessedItemSchema).default([]),
  gaps: z.array(GapSchema).default([]),
  weakAnswers: z.array(AssessedItemSchema).default([]),
  strongAnswers: z.array(AssessedItemSchema).default([]),
  observations: z.array(z.string()).default([]),
  skillAssessments: z.record(z.string(), SkillReadinessSchema).default({}),
});
export type AssessmentState = z.infer<typeof AssessmentStateSchema>;
