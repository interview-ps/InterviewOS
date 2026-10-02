import { describe, expect, it } from "vitest";
import { AnswerEvaluationSchema, SkillIdSchema } from "../src/index.js";

describe("SkillIdSchema", () => {
  it("accepts dotted lowercase paths", () => {
    for (const id of [
      "python",
      "apis.rest",
      "distributed-systems.caching.cache-invalidation",
      "a0.b-c1",
    ]) {
      expect(SkillIdSchema.safeParse(id).success).toBe(true);
    }
  });

  it("rejects invalid ids", () => {
    for (const id of ["Python", "a..b", ".a", "a.", "a b", "a_b", ""]) {
      expect(SkillIdSchema.safeParse(id).success, id).toBe(false);
    }
  });
});

function validEvaluation() {
  const dim = { score: 0.5, rationale: "ok" };
  return {
    summary: "fine",
    dimensions: {
      correctness: dim,
      technicalDepth: dim,
      reasoning: dim,
      structure: dim,
      communication: dim,
      evidence: dim,
      roleRelevance: dim,
    },
    strengths: [{ skill: "sql", evidence: "explained indexing" }],
    weaknesses: [{ skill: "sql.indexing", severity: "medium", evidence: "no btree mention" }],
    scores: [{ skill: "sql", score: 0.6, confidence: 0.7 }],
    missingConcepts: [],
    betterApproach: "add covering index",
    followUpTopics: ["index selectivity"],
  };
}

describe("AnswerEvaluationSchema", () => {
  it("accepts a valid evaluation", () => {
    expect(AnswerEvaluationSchema.safeParse(validEvaluation()).success).toBe(true);
  });

  it("rejects a score above 1", () => {
    const bad = validEvaluation();
    bad.scores[0]!.score = 1.5;
    expect(AnswerEvaluationSchema.safeParse(bad).success).toBe(false);
    const badDim = validEvaluation();
    badDim.dimensions.correctness = { score: 1.2, rationale: "x" };
    expect(AnswerEvaluationSchema.safeParse(badDim).success).toBe(false);
  });

  it("rejects a non-skill-id in scores", () => {
    const bad = validEvaluation();
    (bad.scores[0] as { skill: string }).skill = "Not A Skill!";
    expect(AnswerEvaluationSchema.safeParse(bad).success).toBe(false);
  });
});
