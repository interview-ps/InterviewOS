/**
 * Golden cases for packages/core/src/gaps/index.ts: calculateGaps.
 * Severity = importance × gap vs the level's target score (junior 0.6,
 * mid 0.7, senior 0.8, staff 0.85); high ≥ 0.45, medium ≥ 0.2.
 */

import { dim, req, type AreaCases } from "./helpers.js";

function oneReq(
  skillId: string,
  level: string,
  score: number | null,
  importance = 1,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    requirements: [req(skillId, importance, extra)],
    readiness:
      score === null ? {} : { [skillId]: dim(skillId, score, 0.8, ["e1"]) },
    level,
  };
}

export const gapsCases: AreaCases = {
  area: "gaps",
  cases: [
    // every level → different targetScore
    {
      fn: "calculateGaps",
      name: "level junior",
      input: oneReq("sql", "junior", 0.5),
    },
    {
      fn: "calculateGaps",
      name: "level mid",
      input: oneReq("sql", "mid", 0.5),
    },
    {
      fn: "calculateGaps",
      name: "level senior",
      input: oneReq("sql", "senior", 0.5),
    },
    {
      fn: "calculateGaps",
      name: "level staff",
      input: oneReq("sql", "staff", 0.5),
    },
    {
      fn: "calculateGaps",
      name: "null score treated as zero with full uncertainty",
      input: {
        requirements: [req("sql")],
        readiness: { sql: dim("sql", null, 0) },
        level: "senior",
      },
    },
    {
      fn: "calculateGaps",
      name: "missing readiness entry is also unknown",
      input: { requirements: [req("sql")], readiness: {}, level: "senior" },
    },
    // severity boundary: weighted = importance * gap; senior target 0.8
    {
      fn: "calculateGaps",
      name: "weighted exactly 0.45 is high",
      input: oneReq("sql", "senior", 0.3, 0.9), // 0.9 * 0.5 = 0.45
    },
    {
      fn: "calculateGaps",
      name: "weighted just below 0.45 is medium",
      input: oneReq("sql", "senior", 0.31, 0.9), // 0.9 * 0.49 = 0.441
    },
    {
      fn: "calculateGaps",
      name: "weighted exactly 0.2 is medium",
      input: oneReq("sql", "senior", 0.4, 0.5), // 0.5 * 0.4 = 0.2
    },
    {
      fn: "calculateGaps",
      name: "weighted just below 0.2 is low",
      input: oneReq("sql", "senior", 0.41, 0.5), // 0.5 * 0.39 = 0.195
    },
    {
      fn: "calculateGaps",
      name: "empty requirement label falls back to taxonomy",
      input: {
        requirements: [
          req("distributed-systems.caching", 0.8, { label: "" }),
        ],
        readiness: {},
        level: "mid",
      },
    },
    {
      fn: "calculateGaps",
      name: "explicit requirement label wins over taxonomy",
      input: {
        requirements: [
          req("sql", 0.8, { label: "Structured Query Language" }),
        ],
        readiness: {},
        level: "mid",
      },
    },
    {
      fn: "calculateGaps",
      name: "equal weighted gaps sort by skillId",
      input: {
        requirements: [req("zeta-skill", 0.5), req("alpha-skill", 0.5)],
        readiness: {},
        level: "mid",
      },
    },
    {
      fn: "calculateGaps",
      name: "score above target clamps gap to zero",
      input: oneReq("python", "junior", 0.95),
    },
    {
      fn: "calculateGaps",
      name: "mixed pool sorts by weighted gap then skillId",
      input: {
        requirements: [
          req("python", 0.9),
          req("sql", 0.6),
          req("distributed-systems.caching", 0.8),
        ],
        readiness: {
          python: dim("python", 0.85, 0.9, ["e1"]),
          sql: dim("sql", 0.3, 0.6, ["e2"]),
          // caching has no evidence at all
        },
        level: "senior",
      },
    },
    {
      fn: "calculateGaps",
      name: "preferred kind requirement is treated the same",
      input: {
        requirements: [req("python", 0.4, { kind: "preferred" })],
        readiness: { python: dim("python", 0.5, 0.5, ["e1"]) },
        level: "mid",
      },
    },
  ],
};
