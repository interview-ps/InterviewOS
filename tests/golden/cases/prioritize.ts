/**
 * Golden cases for packages/core/src/interview/prioritize.ts:
 * difficultyFor and selectNextSkill.
 *
 * Mode note: without registered plugins, getMode() resolves only "mixed" —
 * every other mode id is an unavailable placeholder whose inScope() is
 * always false and whose fallbackSkills are empty. `selectNextSkill` cases
 * therefore exercise mode handling through "mixed" (whole pool) and an
 * unavailable id (empty pool → empty fallback → null).
 */

import { NOW, daysAgo, dim, ev, req, type AreaCases } from "./helpers.js";

const LEVELS = ["junior", "mid", "senior", "staff"] as const;
const SCORES: (number | null)[] = [null, 0.39, 0.4, 0.74, 0.75];

function selectInput(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    requirements: [],
    readiness: {},
    evidence: [],
    askedThisSession: [],
    askedPreviousSession: [],
    questionIndex: 0,
    ...extra,
  };
}

export const prioritizeCases: AreaCases = {
  area: "prioritize",
  cases: [
    // --- difficultyFor: full level × boundary-score matrix --------------------
    ...LEVELS.flatMap((level) =>
      SCORES.map((score) => ({
        fn: "difficultyFor",
        name: `${level} score ${score === null ? "null" : score}`,
        input: { level, score },
      })),
    ),

    // --- selectNextSkill ------------------------------------------------------
    {
      fn: "selectNextSkill",
      name: "empty pool returns null",
      input: selectInput({}),
    },
    {
      fn: "selectNextSkill",
      name: "asked this session applies recency 0.15",
      input: selectInput({
        requirements: [req("sql"), req("python")],
        askedThisSession: ["sql"],
      }),
    },
    {
      fn: "selectNextSkill",
      name: "asked this session cancels weakness boost",
      input: selectInput({
        requirements: [req("sql"), req("python")],
        evidence: [
          ev({ skillId: "sql", type: "interview_answer", score: 0.2 }),
        ],
        askedThisSession: ["sql"],
      }),
    },
    {
      fn: "selectNextSkill",
      name: "weak interview evidence boosts 1.6",
      input: selectInput({
        requirements: [req("sql"), req("python")],
        readiness: {
          sql: dim("sql", 0.5, 0.8, ["ev-sql"]),
          python: dim("python", 0.5, 0.8, ["ev-py"]),
        },
        evidence: [
          ev({ id: "ev-sql", skillId: "sql", type: "interview_answer", score: 0.3 }),
        ],
      }),
    },
    {
      fn: "selectNextSkill",
      name: "non-weak previous-session ask applies recency 0.6",
      input: selectInput({
        requirements: [req("sql"), req("python")],
        readiness: {
          sql: dim("sql", 0.4, 0.9, ["e1"]),
          python: dim("python", 0.4, 0.9, ["e2"]),
        },
        askedPreviousSession: ["sql"],
      }),
    },
    {
      fn: "selectNextSkill",
      name: "weak and asked before keeps boost, skips recency penalty",
      input: selectInput({
        requirements: [req("sql"), req("python")],
        readiness: {
          sql: dim("sql", 0.4, 0.9, ["ev-sql"]),
          python: dim("python", 0.4, 0.9, ["ev-py"]),
        },
        evidence: [
          ev({ id: "ev-sql", skillId: "sql", type: "interview_answer", score: 0.3 }),
        ],
        askedPreviousSession: ["sql"],
      }),
    },
    {
      fn: "selectNextSkill",
      name: "loop-weak skill direct retest boosts 1.4",
      input: selectInput({
        requirements: [req("system-design"), req("python")],
        readiness: {
          "system-design": dim("system-design", 0.5, 0.9, ["e1"]),
          python: dim("python", 0.5, 0.9, ["e2"]),
        },
        loopWeakSkills: [
          { skillId: "system-design", round: 1, mode: "technical" },
        ],
      }),
    },
    {
      fn: "selectNextSkill",
      name: "loop-weak skill pulls related skills into the pool at 1.4",
      input: selectInput({
        requirements: [req("system-design.scalability")],
        readiness: {
          "system-design.scalability": dim("system-design.scalability", 0.5, 0.9, ["e1"]),
        },
        loopWeakSkills: [
          { skillId: "sql.transactions", round: 2, mode: "coding" },
        ],
      }),
    },
    {
      fn: "selectNextSkill",
      name: "novelty cap 0.85 after three asks without weakness",
      input: selectInput({
        requirements: [req("sql"), req("python")],
        readiness: {
          sql: dim("sql", 0.4, 0.9, ["e1"]),
          python: dim("python", 0.4, 0.9, ["e2"]),
        },
        askCounts: { sql: 3 },
      }),
    },
    {
      fn: "selectNextSkill",
      name: "novelty cap ignored when the skill is weak",
      input: selectInput({
        requirements: [req("sql"), req("python")],
        readiness: {
          sql: dim("sql", 0.4, 0.9, ["ev-sql"]),
          python: dim("python", 0.4, 0.9, ["ev-py"]),
        },
        evidence: [
          ev({ id: "ev-sql", skillId: "sql", type: "interview_answer", score: 0.3 }),
        ],
        askCounts: { sql: 3 },
      }),
    },
    {
      fn: "selectNextSkill",
      name: "pack focus exact match adds 0.15",
      input: selectInput({
        requirements: [req("sql"), req("python")],
        readiness: {
          sql: dim("sql", 0.4, 0.9, ["e1"]),
          python: dim("python", 0.4, 0.9, ["e2"]),
        },
        focusSkills: ["sql"],
      }),
    },
    {
      fn: "selectNextSkill",
      name: "pack focus descendant adds 0.15",
      input: selectInput({
        requirements: [req("sql.indexing"), req("python")],
        readiness: {
          "sql.indexing": dim("sql.indexing", 0.4, 0.9, ["e1"]),
          python: dim("python", 0.4, 0.9, ["e2"]),
        },
        focusSkills: ["sql"],
      }),
    },
    {
      fn: "selectNextSkill",
      name: "every-4th question confirms highest-score low-confidence skill",
      input: selectInput({
        requirements: [req("s1"), req("s2"), req("s3")],
        readiness: {
          s1: dim("s1", 0.9, 0.9, ["e1"]), // confidence 0.9 ≥ 0.8 — not confirmable
          s2: dim("s2", 0.85, 0.6, ["e2"]),
          s3: dim("s3", 0.6, 0.5, ["e3"]),
        },
        questionIndex: 3,
      }),
    },
    {
      fn: "selectNextSkill",
      name: "every-4th question falls through when nothing is confirmable",
      input: selectInput({
        requirements: [req("s1"), req("s2")],
        readiness: {
          s1: dim("s1", 0.9, 0.9, ["e1"]),
          s2: dim("s2", 0.4, 0.85, ["e2"]), // weak score but confident
        },
        questionIndex: 3,
      }),
    },
    {
      fn: "selectNextSkill",
      name: "non-4th question index uses normal pool",
      input: selectInput({
        requirements: [req("s1"), req("s2")],
        readiness: {
          s1: dim("s1", 0.9, 0.9, ["e1"]),
          s2: dim("s2", 0.85, 0.6, ["e2"]),
        },
        questionIndex: 2,
      }),
    },
    {
      fn: "selectNextSkill",
      name: "unavailable mode scopes everything out and falls back to nothing",
      input: selectInput({
        requirements: [req("sql")],
        mode: "technical", // no plugin modes registered — placeholder scope
      }),
    },
    {
      fn: "selectNextSkill",
      name: "roundType mixed keeps the whole pool",
      input: selectInput({
        requirements: [req("sql"), req("behavioral.leadership"), req("hr.motivation")],
        roundType: "mixed",
      }),
    },
    {
      fn: "selectNextSkill",
      name: "mode key wins over roundType",
      input: selectInput({
        requirements: [req("sql")],
        roundType: "mixed",
        mode: "hr", // unavailable — empties the pool
      }),
    },
    {
      fn: "selectNextSkill",
      name: "taxonomy descendant with evidence joins the pool",
      input: selectInput({
        requirements: [req("sql")],
        readiness: {
          // evidence-bearing descendant of the "sql" requirement
          "sql.indexing": dim("sql.indexing", 0.6, 0.7, ["e1"]),
        },
      }),
    },
    {
      fn: "selectNextSkill",
      name: "low-confidence known skill joins the pool without a requirement",
      input: selectInput({
        requirements: [],
        readiness: {
          python: dim("python", 0.6, 0.3, ["e1"]), // status developing, conf < 0.5
        },
      }),
    },
    {
      fn: "selectNextSkill",
      name: "unknown-status skill is not a low-confidence candidate",
      input: selectInput({
        requirements: [],
        readiness: {
          python: dim("python", null, 0.1), // status unknown → excluded
        },
      }),
    },
    {
      fn: "selectNextSkill",
      name: "default level is mid",
      input: selectInput({
        requirements: [req("sql")],
      }),
    },
    {
      fn: "selectNextSkill",
      name: "priority ties break by skillId",
      input: selectInput({
        requirements: [req("zeta"), req("alpha")],
      }),
    },
    {
      fn: "selectNextSkill",
      name: "level staff pushes a strong skill to hard difficulty",
      input: selectInput({
        requirements: [req("sql")],
        readiness: { sql: dim("sql", 0.9, 0.9, ["e1"]) },
        level: "staff",
        questionIndex: 1, // avoid the every-4th confirmation path
      }),
    },
    {
      fn: "selectNextSkill",
      name: "confirmation candidate factors include pack focus",
      input: selectInput({
        requirements: [req("sql")],
        readiness: { sql: dim("sql", 0.8, 0.6, ["e1"]) },
        focusSkills: ["sql"],
        questionIndex: 3,
      }),
    },
    {
      fn: "selectNextSkill",
      name: "evidence date does not affect selection inputs",
      input: selectInput({
        requirements: [req("sql"), req("python")],
        evidence: [
          ev({ id: "ev-sql", skillId: "sql", type: "interview_answer", score: 0.3, createdAt: daysAgo(30) }),
          ev({ id: "ev-py", skillId: "python", type: "practice", score: 0.3, createdAt: daysAgo(1) }),
        ],
      }),
    },
  ],
};
