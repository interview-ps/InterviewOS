import { z } from "zod";

export const SKILL_ID_REGEX = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;

export const SkillIdSchema = z
  .string()
  .regex(SKILL_ID_REGEX, "skill id must be a dotted lowercase path");

export type SkillId = z.infer<typeof SkillIdSchema>;

export function isSkillId(value: string): value is SkillId {
  return SKILL_ID_REGEX.test(value);
}

export function parentSkillId(id: SkillId): SkillId | null {
  const idx = id.lastIndexOf(".");
  return idx === -1 ? null : (id.slice(0, idx) as SkillId);
}

export function humanizeSkillSegment(segment: string): string {
  return segment
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
