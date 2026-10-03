import { z } from "zod";
import type { SkillId } from "@interview-os/core";
import { taxonomy } from "@interview-os/core";

export const TaxonomyEntrySchema = z.object({
  id: z.string(),
  label: z.string(),
});
export type TaxonomyEntry = z.infer<typeof TaxonomyEntrySchema>;

export function taxonomyEntries(): TaxonomyEntry[] {
  return taxonomy.allNodes().map((n) => ({ id: n.id, label: n.label }));
}

/** Map raw AI-produced ids through normalizeSkillId, dropping invalid ones. */
export function normalizeSkillIds(raw: string[]): SkillId[] {
  const out: SkillId[] = [];
  for (const r of raw) {
    const id = taxonomy.normalizeSkillId(r);
    if (id) out.push(id);
  }
  return out;
}

export function normalizeSkillIdValue(raw: string): SkillId | null {
  return taxonomy.normalizeSkillId(raw);
}
