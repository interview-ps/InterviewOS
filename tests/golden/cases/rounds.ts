/**
 * Golden cases for packages/core/src/interview/rounds.ts: inRound and
 * roundFallbackRequirements.
 *
 * Without plugins only "mixed" resolves to a real mode; every other
 * well-formed round type resolves to the unavailable placeholder whose
 * inScope() is false and fallbackSkills are []. Those outputs are recorded
 * verbatim — they are the contract the Python port must reproduce.
 */

import type { AreaCases } from "./helpers.js";

/** Built-in round ids: "mixed" plus the bundled plugin-mode ids. */
const ROUND_TYPES = [
  "mixed",
  "technical",
  "behavioral",
  "hiring_manager",
  "hr",
  "system_design",
  "coding",
  "nonexistent_mode",
] as const;

const SAMPLE_SKILLS = [
  "sql",
  "sql.indexing",
  "system-design.scalability",
  "behavioral.leadership",
  "coding.algorithms",
  "hr.motivation",
] as const;

export const roundsCases: AreaCases = {
  area: "rounds",
  cases: [
    ...ROUND_TYPES.flatMap((roundType) =>
      SAMPLE_SKILLS.map((skillId) => ({
        fn: "inRound",
        name: `${skillId} in ${roundType}`,
        input: { skillId, roundType },
      })),
    ),
    ...ROUND_TYPES.map((roundType) => ({
      fn: "roundFallbackRequirements",
      name: `fallback for ${roundType}`,
      input: { roundType },
    })),
  ],
};
