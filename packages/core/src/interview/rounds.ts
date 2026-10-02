import { z } from "zod";
import type { SkillId } from "../skill-id.js";
import { childrenOf, getNode } from "../taxonomy/index.js";
import type { Requirement } from "../target/index.js";

export const RoundTypeSchema = z.enum([
  "mixed",
  "technical",
  "system_design",
  "behavioral",
  "hr",
]);
export type RoundType = z.infer<typeof RoundTypeSchema>;

const inSubtree = (skillId: string, root: string): boolean =>
  skillId === root || skillId.startsWith(`${root}.`);

/** §8.4: which skills a round may ask about. */
export function inRound(skillId: SkillId, roundType: RoundType): boolean {
  switch (roundType) {
    case "mixed":
      return true;
    case "system_design":
      return inSubtree(skillId, "system-design") || inSubtree(skillId, "distributed-systems");
    case "behavioral":
      return inSubtree(skillId, "behavioral") || inSubtree(skillId, "communication");
    case "hr":
      return inSubtree(skillId, "hr");
    case "technical":
      return (
        !inSubtree(skillId, "system-design") &&
        !inSubtree(skillId, "behavioral") &&
        !inSubtree(skillId, "communication") &&
        !inSubtree(skillId, "hr")
      );
  }
}

/** Top-level roots of a round (used for the empty-pool fallback). */
function roundRoots(roundType: RoundType): SkillId[] {
  switch (roundType) {
    case "system_design":
      return ["system-design", "distributed-systems"];
    case "behavioral":
      return ["behavioral", "communication"];
    case "hr":
      return ["hr"];
    case "technical":
    case "mixed":
      return [];
  }
}

/**
 * When a round's filtered candidate pool is empty, the round's taxonomy nodes
 * (roots + their seed children) join the pool with importance 0.6.
 */
export function roundFallbackRequirements(roundType: RoundType): Requirement[] {
  const out: Requirement[] = [];
  for (const root of roundRoots(roundType)) {
    for (const id of [root, ...childrenOf(root)]) {
      out.push({
        skillId: id,
        label: getNode(id)?.label ?? id,
        importance: 0.6,
        kind: "required",
        evidence: "round coverage",
      });
    }
  }
  return out;
}
