import { z } from "zod";
import type { SkillId } from "../skill-id.js";
import { getNode } from "../taxonomy/index.js";
import type { Requirement } from "../target/index.js";
import { getMode } from "./modes/index.js";

export const RoundTypeSchema = z.enum([
  "mixed",
  "technical",
  "coding",
  "system_design",
  "behavioral",
  "hiring_manager",
  "hr",
]);
export type RoundType = z.infer<typeof RoundTypeSchema>;

/**
 * §8.4/§9.1: which skills a round may ask about. "mixed" keeps the whole
 * pool; every other value delegates to its mode definition.
 */
export function inRound(skillId: SkillId, roundType: RoundType): boolean {
  return getMode(roundType).inScope(skillId);
}

/**
 * When a round's filtered candidate pool is empty, the mode's fallback
 * taxonomy nodes join the pool with importance 0.6.
 */
export function roundFallbackRequirements(roundType: RoundType): Requirement[] {
  return getMode(roundType).fallbackSkills.map((skillId) => ({
    skillId,
    label: getNode(skillId)?.label ?? skillId,
    importance: 0.6,
    kind: "required" as const,
    evidence: "round coverage",
  }));
}
