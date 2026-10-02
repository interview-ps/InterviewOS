import { describe, expect, it } from "vitest";
import {
  buildReadinessGraph,
  computeSkillReadiness,
  EVIDENCE_HALF_LIFE_DAYS,
  type Evidence,
  type Requirement,
} from "../src/index.js";

// Fixture dates are fixed in the past; pinning `now` before them keeps age-decay = 1
// so the pre-existing weight math is unchanged.
const NOW = new Date("2026-01-01T00:00:00Z");

let seq = 0;
function ev(partial: Partial<Evidence>): Evidence {
  seq += 1;
  return {
    id: `e${seq}`,
    skillId: "sql",
    type: "practice",
    score: 0.5,
    confidence: 1,
    observation: "obs",
    createdAt: `2026-01-0${(seq % 9) + 1}T00:00:00Z`,
    ...partial,
  };
}

function req(skillId: string, importance = 1): Requirement {
  return {
    skillId,
    label: skillId,
    importance,
    kind: "required",
    evidence: "jd",
  };
}

describe("computeSkillReadiness", () => {
  it("returns unknown for empty evidence", () => {
    const r = computeSkillReadiness([], NOW);
    expect(r.score).toBeNull();
    expect(r.confidence).toBe(0);
    expect(r.status).toBe("unknown");
    expect(r.evidenceIds).toEqual([]);
  });

  it("weights a single evidence by confidence and type weight", () => {
    const r = computeSkillReadiness(
      [ev({ type: "interview_answer", score: 0.8, confidence: 0.9 })],
      NOW,
    );
    expect(r.score).toBeCloseTo(0.8, 6);
    // w = 0.9 × 1.0 × 0.85^0 = 0.9 ; conf = min(0.95, 1 - e^{-0.9/1.5})
    expect(r.confidence).toBeCloseTo(1 - Math.exp(-0.9 / 1.5), 6);
    expect(r.status).toBe("strong");
    expect(r.evidenceIds).toHaveLength(1);
  });

  it("applies recency rank decay (0.85^r), newest first", () => {
    const newerGood = computeSkillReadiness(
      [
        ev({ type: "interview_answer", score: 0.9, confidence: 1, createdAt: "2026-02-02T00:00:00Z" }),
        ev({ type: "interview_answer", score: 0.2, confidence: 1, createdAt: "2026-01-01T00:00:00Z" }),
      ],
      NOW,
    );
    const newerBad = computeSkillReadiness(
      [
        ev({ type: "interview_answer", score: 0.2, confidence: 1, createdAt: "2026-02-02T00:00:00Z" }),
        ev({ type: "interview_answer", score: 0.9, confidence: 1, createdAt: "2026-01-01T00:00:00Z" }),
      ],
      NOW,
    );
    // (0.9×1 + 0.2×0.85)/1.85 ≈ 0.578 vs (0.2×1 + 0.9×0.85)/1.85 ≈ 0.522
    expect(newerGood.score!).toBeCloseTo((0.9 + 0.2 * 0.85) / 1.85, 6);
    expect(newerBad.score!).toBeCloseTo((0.2 + 0.9 * 0.85) / 1.85, 6);
    expect(newerGood.score!).toBeGreaterThan(newerBad.score!);
  });

  it("weights interview_answer more than resume_claim", () => {
    const mixed = computeSkillReadiness(
      [
        ev({ type: "interview_answer", score: 0.9, confidence: 1, createdAt: "2026-02-01T00:00:00Z" }),
        ev({ type: "resume_claim", score: 0.2, confidence: 1, createdAt: "2026-01-01T00:00:00Z" }),
      ],
      NOW,
    );
    // weights: 1.0 vs 0.4×0.85 = 0.34 → score closer to interview 0.9
    expect(mixed.score!).toBeCloseTo((0.9 + 0.2 * 0.34) / 1.34, 6);
    expect(mixed.score!).toBeGreaterThan(0.7);
  });

  it("a poor interview answer lowers a resume-only score", () => {
    const resumeOnly = computeSkillReadiness(
      [ev({ type: "resume_claim", score: 0.9, confidence: 0.9 })],
      NOW,
    );
    const withInterview = computeSkillReadiness(
      [
        ev({ type: "interview_answer", score: 0.3, confidence: 0.9, createdAt: "2026-02-01T00:00:00Z" }),
        ev({ type: "resume_claim", score: 0.9, confidence: 0.9, createdAt: "2026-01-01T00:00:00Z" }),
      ],
      NOW,
    );
    expect(resumeOnly.score).toBeCloseTo(0.9, 6);
    expect(withInterview.score!).toBeLessThan(0.6);
    expect(withInterview.status).toBe("weak");
  });
});

describe("time decay (§8.1)", () => {
  it("halves the weight of an interview answer at its 60-day half-life", () => {
    const fresh = computeSkillReadiness(
      [ev({ type: "interview_answer", score: 0.8, confidence: 1, createdAt: "2026-03-01T00:00:00Z" })],
      new Date("2026-03-01T00:00:00Z"),
    );
    const aged = computeSkillReadiness(
      [ev({ type: "interview_answer", score: 0.8, confidence: 1, createdAt: "2026-01-01T00:00:00Z" })],
      new Date("2026-03-02T00:00:00Z"), // 60 days later
    );
    expect(aged.weight).toBeCloseTo(fresh.weight * 0.5, 6);
    expect(aged.score).toBeCloseTo(fresh.score!, 6); // single-evidence score unchanged
    expect(aged.confidence).toBeLessThan(fresh.confidence);
  });

  it("decays resume claims slowly (180-day half-life)", () => {
    const fresh = computeSkillReadiness(
      [ev({ type: "resume_claim", score: 0.8, confidence: 1, createdAt: "2026-03-01T00:00:00Z" })],
      new Date("2026-03-01T00:00:00Z"),
    );
    const aged = computeSkillReadiness(
      [ev({ type: "resume_claim", score: 0.8, confidence: 1, createdAt: "2026-01-01T00:00:00Z" })],
      new Date("2026-03-02T00:00:00Z"),
    );
    expect(aged.weight).toBeCloseTo(
      fresh.weight * Math.pow(0.5, 60 / EVIDENCE_HALF_LIFE_DAYS.resume_claim),
      6,
    );
    expect(aged.weight).toBeGreaterThan(fresh.weight * 0.75);
  });

  it("shifts the score toward slower-decaying evidence as time passes", () => {
    const evidence = () => [
      // fresh but bad interview answer (60-day half-life)
      ev({ type: "interview_answer", score: 0.2, confidence: 1, createdAt: "2026-03-01T00:00:00Z" }),
      // old but strong resume claim (180-day half-life, lower type weight)
      ev({ type: "resume_claim", score: 0.9, confidence: 1, createdAt: "2026-01-01T00:00:00Z" }),
    ];
    const recent = computeSkillReadiness(evidence(), new Date("2026-03-01T00:00:00Z"));
    const later = computeSkillReadiness(evidence(), new Date("2026-06-01T00:00:00Z"));
    // the fast-decaying interview evidence loses relative weight → score rises toward 0.9
    expect(later.score!).toBeGreaterThan(recent.score!);
    expect(later.confidence).toBeLessThan(recent.confidence);
  });

  it("confidence drops as evidence ages", () => {
    const e = ev({ type: "practice", score: 0.7, confidence: 0.8, createdAt: "2026-01-02T00:00:00Z" });
    const early = computeSkillReadiness([e], new Date("2026-01-02T00:00:00Z"));
    const late = computeSkillReadiness([e], new Date("2026-04-02T00:00:00Z")); // 90 days = 2 half-lives
    expect(late.weight).toBeCloseTo(early.weight * 0.25, 6);
    expect(late.confidence).toBeLessThan(early.confidence);
  });
});

describe("buildReadinessGraph", () => {
  it("rolls child scores up into a parent with no direct evidence", () => {
    const evidence = [
      ev({
        skillId: "distributed-systems.caching.cache-invalidation",
        type: "interview_answer",
        score: 0.8,
        confidence: 0.9,
      }),
    ];
    const graph = buildReadinessGraph({
      evidence,
      requirements: [req("distributed-systems.caching")],
      now: NOW,
    });
    const child = graph.dimensions["distributed-systems.caching.cache-invalidation"]!;
    const parent = graph.dimensions["distributed-systems.caching"]!;
    expect(child.score).toBeCloseTo(0.8, 6);
    expect(parent.evidenceIds).toEqual([]); // only direct evidence ids
    expect(parent.children).toEqual(["distributed-systems.caching.cache-invalidation"]);
    expect(parent.score).toBeCloseTo(0.8, 6);
    // child confidence = 1-exp(-0.9/1.5) ≈ 0.451 ; parent conf = 1-exp(-0.451/1.5)
    const childConf = 1 - Math.exp(-0.9 / 1.5);
    expect(parent.confidence).toBeCloseTo(1 - Math.exp(-childConf / 1.5), 6);
    expect(parent.status).toBe("strong");
    // ancestors of the evidence exist as nodes too
    expect(graph.dimensions["distributed-systems"]).toBeDefined();
  });

  it("combines direct evidence with child rollup", () => {
    const evidence = [
      ev({ skillId: "sql", type: "practice", score: 0.4, confidence: 1, createdAt: "2026-01-01T00:00:00Z" }),
      ev({ skillId: "sql.indexing", type: "interview_answer", score: 0.9, confidence: 1, createdAt: "2026-01-02T00:00:00Z" }),
    ];
    const graph = buildReadinessGraph({
      evidence,
      requirements: [req("sql")],
      now: NOW,
    });
    const sql = graph.dimensions["sql"]!;
    const child = graph.dimensions["sql.indexing"]!;
    // direct weight 0.7, childScore 0.9, childWeight = child.confidence
    const childWeight = child.confidence;
    const expected = (0.7 * 0.4 + 0.9 * childWeight) / (0.7 + childWeight);
    expect(sql.score!).toBeCloseTo(expected, 6);
  });

  it("marks nodes with no evidence anywhere as unknown", () => {
    const graph = buildReadinessGraph({
      evidence: [],
      requirements: [req("sql")],
      now: NOW,
    });
    expect(graph.dimensions["sql"]!.status).toBe("unknown");
    expect(graph.dimensions["sql"]!.score).toBeNull();
  });

  it("uses the 0.25 prior for unknown skills in overall", () => {
    const evidence = [
      ev({ skillId: "python", type: "interview_answer", score: 1, confidence: 1 }),
    ];
    const graph = buildReadinessGraph({
      evidence,
      requirements: [req("python"), req("sql")],
      now: NOW,
    });
    expect(graph.overall).toBeCloseTo((1 + 0.25) / 2, 6);
    const pyConf = 1 - Math.exp(-1 / 1.5);
    expect(graph.overallConfidence).toBeCloseTo((pyConf + 0) / 2, 6);
  });
});
