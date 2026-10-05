/**
 * Shared case-building helpers for the golden fixtures.
 *
 * Every case is `{ fn, name, input }` where `input` is a JSON object holding
 * the function's named arguments exactly as they will be handed to the
 * function (after the generator converts `now` strings to `Date`). Nothing
 * here executes code under test.
 */

/** Fixed clock used by every case that takes `now` (§golden README). */
export const NOW = "2026-01-01T00:00:00.000Z";

const DAY_MS = 86_400_000;

/** ISO string `n` days before NOW — evidence ages are fixed relative to it. */
export function daysAgo(n: number): string {
  return new Date(Date.parse(NOW) - n * DAY_MS).toISOString();
}

export interface GoldenCase {
  /** Function under test — key into the generator's runner table. */
  fn: string;
  /** Unique within the area file. */
  name: string;
  /** Named arguments, JSON-serializable. */
  input: Record<string, unknown>;
}

export interface AreaCases {
  area: string;
  cases: GoldenCase[];
}

/** Evidence input builder (mirrors readiness/schema.ts Evidence). */
export function ev(partial: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "ev-1",
    skillId: "sql",
    type: "practice",
    score: 0.5,
    confidence: 1,
    observation: "obs",
    createdAt: NOW,
    ...partial,
  };
}

/** Requirement input builder (mirrors target/index.ts Requirement). */
export function req(
  skillId: string,
  importance = 1,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    skillId,
    label: skillId,
    importance,
    kind: "required",
    evidence: "jd",
    ...extra,
  };
}

/**
 * SkillReadiness input builder for `selectNextSkill`/`calculateGaps` inputs.
 * `status` mirrors statusForScore thresholds (duplicated here so inputs are
 * plain data even if the implementation changes).
 */
export function dim(
  skillId: string,
  score: number | null,
  confidence = 0,
  evidenceIds: string[] = [],
): Record<string, unknown> {
  return {
    skillId,
    label: skillId,
    score,
    confidence,
    evidenceIds,
    children: [],
    status:
      score === null
        ? "unknown"
        : score < 0.5
          ? "weak"
          : score < 0.75
            ? "developing"
            : "strong",
  };
}
