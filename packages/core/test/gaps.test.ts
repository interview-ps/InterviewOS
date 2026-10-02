import { describe, expect, it } from "vitest";
import { calculateGaps, type Requirement, type SkillReadiness } from "../src/index.js";

function req(skillId: string, importance: number, kind: "required" | "preferred" = "required"): Requirement {
  return { skillId, label: skillId, importance, kind, evidence: "jd" };
}

function dim(skillId: string, score: number | null, confidence = 0): SkillReadiness {
  return {
    skillId,
    label: skillId,
    score,
    confidence,
    evidenceIds: score === null ? [] : ["e1"],
    children: [],
    status: score === null ? "unknown" : score < 0.5 ? "weak" : score < 0.75 ? "developing" : "strong",
  };
}

describe("calculateGaps", () => {
  it("assigns severity buckets by importance × gap", () => {
    const gaps = calculateGaps({
      level: "senior", // target 0.8
      requirements: [
        req("high-one", 1.0), // gap 0.8 → 0.8 high
        req("mid-one", 0.5), // gap 0.8 → 0.4 medium
        req("low-one", 0.2), // gap 0.8 → 0.16 low
      ],
      readiness: {},
    });
    const by = Object.fromEntries(gaps.map((g) => [g.skillId, g]));
    expect(by["high-one"]!.severity).toBe("high");
    expect(by["mid-one"]!.severity).toBe("medium");
    expect(by["low-one"]!.severity).toBe("low");
    for (const g of gaps) {
      expect(g.targetScore).toBe(0.8);
      expect(g.currentScore).toBeNull();
      expect(g.gap).toBeCloseTo(0.8);
      expect(g.uncertainty).toBe(1);
    }
  });

  it("shrinks the gap as current score approaches target", () => {
    const [g] = calculateGaps({
      level: "mid", // target 0.7
      requirements: [req("sql", 1)],
      readiness: { sql: dim("sql", 0.6, 0.8) },
    });
    expect(g!.gap).toBeCloseTo(0.1);
    expect(g!.uncertainty).toBeCloseTo(0.2);
    expect(g!.severity).toBe("low"); // 1 × 0.1 = 0.1 < 0.2
  });

  it("sorts by importance × gap × (0.5 + uncertainty) desc, ties by skillId", () => {
    const gaps = calculateGaps({
      level: "senior",
      requirements: [req("b-skill", 1), req("a-skill", 1), req("c-known", 1)],
      readiness: {
        "b-skill": dim("b-skill", null),
        "a-skill": dim("a-skill", null),
        "c-known": dim("c-known", 0.1, 0.95), // gap 0.7, low uncertainty
      },
    });
    // a/b both gap 0.8, uncertainty 1 → equal weight → skillId asc; c-known has smaller gap
    expect(gaps.map((g) => g.skillId)).toEqual(["a-skill", "b-skill", "c-known"]);
  });
});
