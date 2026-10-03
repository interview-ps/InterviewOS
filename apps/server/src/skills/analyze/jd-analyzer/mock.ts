import { taxonomy, type Requirement, type SkillId } from "@interview-os/core";
import { firstMatchingLine } from "../../mock/text.js";

const PREFERRED_HEADING = /prefer|nice to have|bonus|plus\b/i;

export function jdAnalyzerMock(input: unknown): unknown {
  const { jobDescription } = input as { jobDescription: string };
  const lines = jobDescription.split("\n");
  const splitIdx = lines.findIndex((l) => PREFERRED_HEADING.test(l));
  const requiredText = splitIdx === -1 ? jobDescription : lines.slice(0, splitIdx).join("\n");
  const preferredText = splitIdx === -1 ? "" : lines.slice(splitIdx).join("\n");

  const requiredMatches = taxonomy.matchSkills(requiredText);
  const preferredMatches = taxonomy.matchSkills(preferredText);
  const requiredIds = new Set(requiredMatches.map((m) => m.skillId));

  const requirements: Requirement[] = requiredMatches.map((m) => ({
    skillId: m.skillId as SkillId,
    label: taxonomy.labelFor(m.skillId as SkillId),
    importance: Math.min(0.95, 0.75 + 0.05 * (m.mentions - 1)),
    kind: "required",
    evidence: firstMatchingLine(requiredText, m.skillId as SkillId),
  }));

  const preferredSkills: Requirement[] = preferredMatches
    .filter((m) => !requiredIds.has(m.skillId))
    .map((m) => ({
      skillId: m.skillId as SkillId,
      label: taxonomy.labelFor(m.skillId as SkillId),
      importance: 0.5,
      kind: "preferred",
      evidence: firstMatchingLine(preferredText, m.skillId as SkillId),
    }));

  return { requirements, preferredSkills };
}
