import type { SkillId } from "../skill-id.js";
import * as defaultTaxonomy from "../taxonomy/index.js";
import type { TaxonomyLike } from "../readiness/index.js";
import type { Level, Requirement } from "../target/index.js";
import type { SkillReadiness } from "../readiness/schema.js";
import type { Gap } from "./schema.js";

export * from "./schema.js";

export const TARGET_SCORE_BY_LEVEL: Record<Level, number> = {
  junior: 0.6,
  mid: 0.7,
  senior: 0.8,
  staff: 0.85,
};

export interface CalculateGapsInput {
  requirements: Requirement[];
  readiness: Record<SkillId, SkillReadiness>;
  level: Level;
  taxonomy?: TaxonomyLike;
}

export function calculateGaps(input: CalculateGapsInput): Gap[] {
  const taxonomy = input.taxonomy ?? defaultTaxonomy;
  const targetScore = TARGET_SCORE_BY_LEVEL[input.level];

  const gaps: Gap[] = input.requirements.map((req) => {
    const dim = input.readiness[req.skillId];
    const currentScore = dim?.score ?? null;
    const uncertainty = 1 - (dim?.confidence ?? 0);
    const gap = Math.max(0, targetScore - (currentScore ?? 0));
    const weighted = req.importance * gap;
    const severity = weighted >= 0.45 ? "high" : weighted >= 0.2 ? "medium" : "low";
    const reason =
      currentScore === null
        ? `no evidence for ${req.kind} skill; ${input.level} target is ${targetScore}`
        : `current ${currentScore.toFixed(2)} vs ${input.level} target ${targetScore} (importance ${req.importance})`;
    return {
      skillId: req.skillId,
      label: req.label || taxonomy.labelFor(req.skillId),
      importance: req.importance,
      targetScore,
      currentScore,
      gap,
      uncertainty,
      severity,
      reason,
    };
  });

  gaps.sort(
    (a, b) =>
      b.importance * b.gap * (0.5 + b.uncertainty) -
        a.importance * a.gap * (0.5 + a.uncertainty) ||
      a.skillId.localeCompare(b.skillId),
  );
  return gaps;
}
