import { describe, expect, it } from "vitest";
import {
  AnswerEvaluationSchema,
  assertRubricIds,
  normalizeEvaluation,
  type AnswerEvaluation,
} from "../src/assessment/index.js";

const dim = (score = 0.5) => ({ score, rationale: "r" });
const dimScore = (id: string, score: number) => ({ id, label: id, score, rationale: "" });

const base: AnswerEvaluation = AnswerEvaluationSchema.parse({
  summary: "s",
  dimensions: {
    correctness: dim(),
    technicalDepth: dim(),
    reasoning: dim(),
    structure: dim(),
    communication: dim(),
    evidence: dim(),
    roleRelevance: dim(),
  },
  strengths: [],
  weaknesses: [],
  scores: [],
  missingConcepts: [],
  betterApproach: "",
  followUpTopics: [],
  star: null,
  rubric: [],
  designUpdates: null,
});

describe("normalizeEvaluation", () => {
  it("merges duplicate weaknesses per skill: worst severity wins, evidence joins", () => {
    const e = normalizeEvaluation({
      ...base,
      weaknesses: [
        { skill: "sql.transactions", severity: "medium", evidence: "no isolation levels" },
        { skill: "sql.transactions", severity: "high", evidence: "no ACID reasoning" },
        { skill: "sql.indexing", severity: "low", evidence: "no index mention" },
      ],
    });
    expect(e.weaknesses).toHaveLength(2);
    const t = e.weaknesses.find((w) => w.skill === "sql.transactions")!;
    expect(t.severity).toBe("high");
    expect(t.evidence).toBe("no isolation levels; no ACID reasoning");
  });

  it("merges duplicate strengths and averages scores with max confidence", () => {
    const e = normalizeEvaluation({
      ...base,
      strengths: [
        { skill: "sql", evidence: "good plan" },
        { skill: "sql", evidence: "clean indexing" },
      ],
      scores: [
        { skill: "sql", score: 0.4, confidence: 0.5 },
        { skill: "sql", score: 0.8, confidence: 0.9 },
        { skill: "apis", score: 0.7, confidence: 0.6 },
      ],
    });
    expect(e.strengths).toHaveLength(1);
    expect(e.strengths[0]!.evidence).toBe("good plan; clean indexing");
    expect(e.scores).toHaveLength(2);
    const s = e.scores.find((x) => x.skill === "sql")!;
    expect(s.score).toBeCloseTo(0.6);
    expect(s.confidence).toBe(0.9);
  });

  it("dedupes missingConcepts and is idempotent", () => {
    const e = {
      ...base,
      missingConcepts: ["TTL", "TTL", "indexing"],
      weaknesses: [
        { skill: "sql", severity: "low" as const, evidence: "a" },
        { skill: "sql", severity: "low" as const, evidence: "b" },
      ],
    };
    const once = normalizeEvaluation(e);
    expect(once.missingConcepts).toEqual(["TTL", "indexing"]);
    const twice = normalizeEvaluation(once);
    expect(twice.weaknesses[0]!.evidence).toBe("a; b"); // not "a; b; a; b"
    expect(twice).toEqual(once);
  });
});

describe("assertRubricIds", () => {
  const mode = { id: "coding", rubric: [{ id: "complexity" }, { id: "approach" }] };
  it("passes for exact ids, throws on mismatch", () => {
    expect(() =>
      assertRubricIds(
        { rubric: [dimScore("approach", 0.5), dimScore("complexity", 0.5)] },
        mode,
      ),
    ).not.toThrow();
    expect(() =>
      assertRubricIds({ rubric: [dimScore("approach", 0.5)] }, mode),
    ).toThrow(/rubric mismatch/);
    expect(() =>
      assertRubricIds(
        { rubric: [dimScore("approach", 0.5), dimScore("nope", 0.5)] },
        mode,
      ),
    ).toThrow(/rubric mismatch/);
  });
});
