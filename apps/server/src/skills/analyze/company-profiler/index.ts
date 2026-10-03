import { z } from "zod";
import {
  CompanyNotesProfileSchema,
  type CompanyNotesProfile,
  type SkillManifest,
} from "@interview-os/core";
import { runStructured } from "../../framework/runStructured.js";
import type { InterviewSkill } from "../../framework/skill.js";
import { normalizeSkillIds, TaxonomyEntrySchema } from "../../framework/common.js";
import { COMPANY_PROFILER_PROMPT } from "./prompt.js";

export const CompanyProfilerInputSchema = z.object({
  company: z.string(),
  /** Untrusted free text (careers page notes, values). Delimited for the model. */
  companyNotes: z.string(),
  taxonomy: z.array(TaxonomyEntrySchema),
});
export type CompanyProfilerInput = z.infer<typeof CompanyProfilerInputSchema>;

const CompanyProfilerAiOutputSchema = z.object({
  values: z.array(z.string()).default([]),
  interviewStyle: z.string().default(""),
  focusSkillIds: z.array(z.string()).default([]),
  behavioralThemes: z.array(z.string()).default([]),
});
export type CompanyProfilerOutput = CompanyNotesProfile;

const manifest: SkillManifest = {
  id: "company-profiler",
  version: "1.0.0",
  kind: "builtin",
  description:
    "Derives a company profile (values, interview style, focus skills, themes) from untrusted careers-page notes.",
  inputs: [
    { key: "company", permission: "target.read" },
    { key: "companyNotes", permission: "target.read" },
    { key: "taxonomy", permission: "taxonomy.read" },
  ],
  outputs: ["companyProfile"],
  permissions: [
    "target.read",
    "taxonomy.read",
    "runtime.invoke",
    "target.write",
  ],
};

export const companyProfiler: InterviewSkill<
  CompanyProfilerInput,
  CompanyProfilerOutput
> = {
  id: "company-profiler",
  manifest,
  inputSchema: CompanyProfilerInputSchema,
  outputSchema: CompanyNotesProfileSchema,
  async execute(input, ctx) {
    const output = await runStructured(ctx, {
      taskId: "company-profiler",
      instructions: COMPANY_PROFILER_PROMPT,
      input: {
        company: input.company,
        taxonomy: input.taxonomy,
        companyNotes: `<<<COMPANY-NOTES>>>\n${input.companyNotes}\n<<<END-COMPANY-NOTES>>>`,
      },
      schema: CompanyProfilerAiOutputSchema,
    });
    return {
      values: output.values,
      interviewStyle: output.interviewStyle,
      focusSkillIds: normalizeSkillIds(output.focusSkillIds),
      behavioralThemes: output.behavioralThemes,
    };
  },
};
