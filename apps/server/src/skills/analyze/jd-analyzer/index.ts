import { z } from "zod";
import { LevelSchema, RequirementSchema, type Requirement, type SkillManifest } from "@interview-os/core";
import { runStructured } from "../../framework/runStructured.js";
import type { InterviewSkill } from "../../framework/skill.js";
import { normalizeSkillIdValue, TaxonomyEntrySchema } from "../../framework/common.js";
import { JD_ANALYZER_PROMPT } from "./prompt.js";

export const JdAnalyzerInputSchema = z.object({
  jobDescription: z.string(),
  company: z.string(),
  role: z.string(),
  level: LevelSchema,
  taxonomy: z.array(TaxonomyEntrySchema),
});
export type JdAnalyzerInput = z.infer<typeof JdAnalyzerInputSchema>;

const AnalyzedRequirementSchema = z.object({
  skillId: z.string(),
  label: z.string(),
  importance: z.number().min(0).max(1),
  evidence: z.string(),
});

const JdAnalyzerAiOutputSchema = z.object({
  requirements: z.array(AnalyzedRequirementSchema),
  preferredSkills: z.array(AnalyzedRequirementSchema),
});

export const JdAnalyzerOutputSchema = z.object({
  requirements: z.array(RequirementSchema),
  preferredSkills: z.array(RequirementSchema),
});
export type JdAnalyzerOutput = z.infer<typeof JdAnalyzerOutputSchema>;

const manifest: SkillManifest = {
  id: "jd-analyzer",
  version: "1.0.0",
  kind: "builtin",
  description:
    "Extracts a TargetRole's requirements (required/preferred, importance) from a job description.",
  inputs: [
    { key: "jobDescription", permission: "target.read" },
    { key: "company", permission: "target.read" },
    { key: "role", permission: "target.read" },
    { key: "level", permission: "target.read" },
    { key: "taxonomy", permission: "taxonomy.read" },
  ],
  outputs: ["requirements", "preferredSkills"],
  permissions: [
    "target.read",
    "taxonomy.read",
    "runtime.invoke",
    "target.write",
  ],
};

export const jdAnalyzer: InterviewSkill<JdAnalyzerInput, JdAnalyzerOutput> = {
  id: "jd-analyzer",
  manifest,
  inputSchema: JdAnalyzerInputSchema,
  outputSchema: JdAnalyzerOutputSchema,
  async execute(input, ctx) {
    const output = await runStructured(ctx, {
      taskId: "jd-analyzer",
      instructions: JD_ANALYZER_PROMPT,
      input,
      schema: JdAnalyzerAiOutputSchema,
    });
    const toRequirement =
      (kind: Requirement["kind"]) =>
      (r: z.infer<typeof AnalyzedRequirementSchema>): Requirement | null => {
        const skillId = normalizeSkillIdValue(r.skillId);
        return skillId ? { skillId, label: r.label, importance: r.importance, kind, evidence: r.evidence } : null;
      };
    return {
      requirements: output.requirements.map(toRequirement("required")).filter((r): r is Requirement => r !== null),
      preferredSkills: output.preferredSkills.map(toRequirement("preferred")).filter((r): r is Requirement => r !== null),
    };
  },
};
