import { z } from "zod";
import { SkillIdSchema } from "../skill-id.js";

/**
 * v0.4: a plugin may propose evidence rows; the server validates, caps
 * confidence, tags source `plugin:<id>` and persists them as type "plugin"
 * only when `evidence.write` is granted.
 */
export const EvidenceProposalSchema = z.object({
  skillId: SkillIdSchema,
  score: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  observation: z.string().min(1).max(500),
});
export type EvidenceProposal = z.infer<typeof EvidenceProposalSchema>;

export const PLUGIN_EVIDENCE_CONFIDENCE_CAP = 0.6;
export const PLUGIN_EVIDENCE_MAX_PROPOSALS = 20;

/** Optional extension field a plugin's JSON output may carry. */
export const PluginOutputExtensionsSchema = z.object({
  evidenceProposals: z
    .array(EvidenceProposalSchema)
    .max(PLUGIN_EVIDENCE_MAX_PROPOSALS)
    .optional(),
});
export type PluginOutputExtensions = z.infer<typeof PluginOutputExtensionsSchema>;

/**
 * Read the evidence proposals out of arbitrary plugin output.
 * Returns `[]` when absent, `null` when present but invalid.
 */
export function pluginEvidenceProposals(
  output: unknown,
): EvidenceProposal[] | null {
  if (typeof output !== "object" || output === null) return [];
  const raw = (output as Record<string, unknown>).evidenceProposals;
  if (raw === undefined) return [];
  const parsed = z
    .array(EvidenceProposalSchema)
    .max(PLUGIN_EVIDENCE_MAX_PROPOSALS)
    .safeParse(raw);
  return parsed.success ? parsed.data : null;
}
