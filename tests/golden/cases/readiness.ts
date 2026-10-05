/**
 * Golden cases for packages/core/src/readiness/index.ts:
 * statusForScore, confidenceForWeight, computeSkillReadiness, buildReadinessGraph.
 */

import { NOW, daysAgo, ev, req, type AreaCases } from "./helpers.js";

export const readinessCases: AreaCases = {
  area: "readiness",
  cases: [
    // --- statusForScore ----------------------------------------------------
    { fn: "statusForScore", name: "null score", input: { score: null } },
    { fn: "statusForScore", name: "score 0", input: { score: 0 } },
    {
      fn: "statusForScore",
      name: "score just below weak boundary",
      input: { score: 0.4999 },
    },
    {
      fn: "statusForScore",
      name: "score at weak/developing boundary",
      input: { score: 0.5 },
    },
    {
      fn: "statusForScore",
      name: "score just below strong boundary",
      input: { score: 0.7499 },
    },
    {
      fn: "statusForScore",
      name: "score at developing/strong boundary",
      input: { score: 0.75 },
    },
    { fn: "statusForScore", name: "score 1", input: { score: 1 } },

    // --- confidenceForWeight -------------------------------------------------
    { fn: "confidenceForWeight", name: "zero weight", input: { totalWeight: 0 } },
    {
      fn: "confidenceForWeight",
      name: "small weight",
      input: { totalWeight: 0.1 },
    },
    {
      fn: "confidenceForWeight",
      name: "weight equals saturation constant",
      input: { totalWeight: 1.5 },
    },
    {
      fn: "confidenceForWeight",
      name: "weight just past the 0.95 cap",
      input: { totalWeight: 4.5 },
    },
    {
      fn: "confidenceForWeight",
      name: "large weight saturating at cap",
      input: { totalWeight: 10 },
    },

    // --- computeSkillReadiness ----------------------------------------------
    {
      fn: "computeSkillReadiness",
      name: "empty evidence",
      input: { evidence: [], now: NOW },
    },
    {
      fn: "computeSkillReadiness",
      name: "single evidence",
      input: {
        evidence: [ev({ type: "interview_answer", score: 0.8, confidence: 0.9 })],
        now: NOW,
      },
    },
    {
      fn: "computeSkillReadiness",
      name: "all five evidence types",
      input: {
        evidence: [
          ev({ id: "ev-ia", type: "interview_answer", score: 0.9, confidence: 1, createdAt: daysAgo(0) }),
          ev({ id: "ev-pr", type: "practice", score: 0.7, confidence: 0.8, createdAt: daysAgo(1) }),
          ev({ id: "ev-pl", type: "plugin", score: 0.6, confidence: 0.7, createdAt: daysAgo(30) }),
          ev({ id: "ev-rc", type: "resume_claim", score: 0.85, confidence: 0.9, createdAt: daysAgo(60) }),
          ev({ id: "ev-sr", type: "self_report", score: 0.4, confidence: 0.5, createdAt: daysAgo(180) }),
        ],
        now: NOW,
      },
    },
    // age buckets: interview_answer half-life is 60 days
    ...[0, 1, 30, 60, 180, 400].map((days) => ({
      fn: "computeSkillReadiness",
      name: `interview_answer aged ${days} days`,
      input: {
        evidence: [
          ev({
            id: `ev-age-${days}`,
            type: "interview_answer",
            score: 0.75,
            confidence: 1,
            createdAt: daysAgo(days),
          }),
        ],
        now: NOW,
      },
    })),
    {
      fn: "computeSkillReadiness",
      name: "identical createdAt falls back to id order",
      input: {
        evidence: [
          ev({ id: "ev-c", type: "interview_answer", score: 0.2, createdAt: daysAgo(5) }),
          ev({ id: "ev-a", type: "interview_answer", score: 0.9, createdAt: daysAgo(5) }),
          ev({ id: "ev-b", type: "interview_answer", score: 0.6, createdAt: daysAgo(5) }),
        ],
        now: NOW,
      },
    },
    {
      fn: "computeSkillReadiness",
      name: "rank decay over seven items",
      input: {
        evidence: [0, 1, 2, 3, 4, 5, 6].map((d) =>
          ev({
            id: `ev-r${d}`,
            type: "interview_answer",
            score: 0.1 * (d + 3),
            confidence: 0.9,
            createdAt: daysAgo(d),
          }),
        ),
        now: NOW,
      },
    },
    {
      fn: "computeSkillReadiness",
      name: "slow resume_claim outlives fast interview_answer",
      input: {
        evidence: [
          ev({ id: "ev-ia", type: "interview_answer", score: 0.2, confidence: 1, createdAt: daysAgo(60) }),
          ev({ id: "ev-rc", type: "resume_claim", score: 0.9, confidence: 1, createdAt: daysAgo(180) }),
        ],
        now: NOW,
      },
    },

    // --- buildReadinessGraph --------------------------------------------------
    {
      fn: "buildReadinessGraph",
      name: "empty input",
      input: { evidence: [], requirements: [], now: NOW },
    },
    {
      fn: "buildReadinessGraph",
      name: "evidence but no requirements (importanceSum 0)",
      input: {
        evidence: [ev({ skillId: "python", type: "practice", score: 0.6 })],
        requirements: [],
        now: NOW,
      },
    },
    {
      fn: "buildReadinessGraph",
      name: "requirement without evidence uses unknown prior",
      input: {
        evidence: [],
        requirements: [req("sql")],
        now: NOW,
      },
    },
    {
      fn: "buildReadinessGraph",
      name: "leaf evidence rolls up through parent and grandparent",
      input: {
        evidence: [
          ev({
            skillId: "distributed-systems.caching.cache-invalidation",
            type: "interview_answer",
            score: 0.8,
            confidence: 0.9,
          }),
        ],
        requirements: [req("distributed-systems.caching")],
        now: NOW,
      },
    },
    {
      fn: "buildReadinessGraph",
      name: "parent with direct evidence and scored child",
      input: {
        evidence: [
          ev({ id: "ev-sql", skillId: "sql", type: "practice", score: 0.4, createdAt: daysAgo(1) }),
          ev({
            id: "ev-idx",
            skillId: "sql.indexing",
            type: "interview_answer",
            score: 0.9,
            createdAt: daysAgo(0),
          }),
        ],
        requirements: [req("sql")],
        now: NOW,
      },
    },
    {
      fn: "buildReadinessGraph",
      name: "unscored child is ignored by parent rollup",
      input: {
        evidence: [
          ev({ id: "ev-sql", skillId: "sql", type: "practice", score: 0.6 }),
          ev({
            id: "ev-tx",
            skillId: "sql.transactions",
            type: "interview_answer",
            score: 0.8,
          }),
        ],
        // sql.indexing is a node (via the requirement) but has no score —
        // it must not drag the parent rollup down.
        requirements: [req("sql"), req("sql.indexing")],
        now: NOW,
      },
    },
    {
      fn: "buildReadinessGraph",
      name: "skill id outside the taxonomy gets humanized label",
      input: {
        evidence: [ev({ skillId: "exotic.quantum-computing", score: 0.5 })],
        requirements: [req("exotic.quantum-computing")],
        now: NOW,
      },
    },
    {
      fn: "buildReadinessGraph",
      name: "multiple requirements with different importances",
      input: {
        evidence: [
          ev({ id: "ev-py", skillId: "python", type: "interview_answer", score: 1, confidence: 1 }),
          ev({ id: "ev-sql", skillId: "sql", type: "self_report", score: 0.4, confidence: 0.6 }),
        ],
        requirements: [req("python", 0.9), req("sql", 0.3), req("kubernetes", 0.2)],
        now: NOW,
      },
    },
    {
      fn: "buildReadinessGraph",
      name: "custom taxonomy overrides default labels",
      input: {
        evidence: [ev({ skillId: "zz-custom.alpha", score: 0.7 })],
        requirements: [req("zz-custom.alpha")],
        taxonomy: {
          parentOf: { "zz-custom.alpha": "zz-custom" },
          labelFor: { "zz-custom.alpha": "Alpha Custom", "zz-custom": "Zz Custom" },
          childrenOf: { "zz-custom": ["zz-custom.alpha"] },
        },
        now: NOW,
      },
    },
  ],
};
