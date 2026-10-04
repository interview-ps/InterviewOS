import { z } from "zod";
import { SlugIdSchema } from "../skills/slug.js";
import { SkillIdSchema } from "../skill-id.js";
import { isValidVersion } from "../platform/semver.js";
import {
  COMPANY_DISCLAIMER,
  CompanyProfileSchema,
  ModeIdSchema,
  type CompanyProfile,
} from "../companies/index.js";
import { PrepResourceSchema } from "../preparation/resources.js";
import { QuestionDifficultySchema } from "../interview/index.js";

export const PackVersionSchema = z
  .string()
  .min(1)
  .max(32)
  .refine(isValidVersion, "version must be semver x.y.z");

/** Whether an item is backed by a declared source or community observation. */
export const ProvenanceSchema = z.enum(["sourced", "community"]);
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const PackSourceSchema = z.object({
  id: SlugIdSchema,
  title: z.string().min(1).max(200),
  url: z
    .string()
    .max(2000)
    .refine((u) => u.startsWith("https://"), "source URLs must be https")
    .optional(),
});
export type PackSource = z.infer<typeof PackSourceSchema>;

/** A fact-like pack item — must clearly mark sourced vs community material. */
export const PackItemSchema = z.object({
  text: z.string().min(1).max(2000),
  provenance: ProvenanceSchema,
  /** required when provenance is "sourced"; must match a sources[].id. */
  source: SlugIdSchema.optional(),
});
export type PackItem = z.infer<typeof PackItemSchema>;

export const PackQuestionSchema = z.object({
  skillId: SkillIdSchema,
  text: z.string().min(10).max(1200),
  difficulty: QuestionDifficultySchema.optional(),
  mode: ModeIdSchema.optional(),
  provenance: ProvenanceSchema,
  source: SlugIdSchema.optional(),
});
export type PackQuestion = z.infer<typeof PackQuestionSchema>;

interface Provenanced {
  provenance: Provenance;
  source?: string | undefined;
}

/** Every "sourced" item must name a declared source id. */
function checkSourcedItems(
  items: Provenanced[],
  sourceIds: Set<string>,
  ctx: z.RefinementCtx,
  path: (string | number)[],
): void {
  items.forEach((item, i) => {
    if (item.provenance !== "sourced") return;
    if (!item.source) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, i, "source"],
        message: 'sourced items must reference a declared source id',
      });
    } else if (!sourceIds.has(item.source)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, i, "source"],
        message: `source "${item.source}" is not declared in the pack's sources`,
      });
    }
  });
}

// ---------------------------------------------------------------- company pack

export const CompanyPackSchema = z
  .object({
    format: z.literal("interview-os.company-pack").default("interview-os.company-pack"),
    id: SlugIdSchema,
    name: z.string().min(1).max(120),
    version: PackVersionSchema,
    description: z.string().max(2000).default(""),
    maintainers: z.array(z.string().min(1).max(120)).default([]),
    aliases: z.array(z.string().min(1).max(120)).default([]),
    sources: z.array(PackSourceSchema).default([]),
    stages: z
      .array(
        z.object({
          mode: ModeIdSchema,
          label: z.string().min(1).max(80),
          plannedQuestions: z.number().int().min(1).max(6),
          provenance: ProvenanceSchema,
          source: SlugIdSchema.optional(),
        }),
      )
      .min(2)
      .max(7),
    competencies: z.array(PackItemSchema).default([]),
    emphasis: z
      .array(
        z.object({
          skillId: SkillIdSchema,
          weight: z.number().min(0).max(0.1),
        }),
      )
      .default([]),
    behavioralFramework: z.object({
      name: z.string().min(1).max(120),
      themes: z.array(z.string().min(1).max(120)).default([]),
      guidance: z.string().max(1500).default(""),
    }),
    followUpDepth: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
    questionStyle: z.array(PackItemSchema).default([]),
    evaluationGuidance: z.array(PackItemSchema).default([]),
    roleExpectations: z.record(z.string(), z.array(z.string().max(300))).default({}),
    questions: z.array(PackQuestionSchema).default([]),
  })
  .superRefine((pack, ctx) => {
    const sourceIds = new Set(pack.sources.map((s) => s.id));
    checkSourcedItems(pack.stages, sourceIds, ctx, ["stages"]);
    for (const p of [
      "competencies",
      "questionStyle",
      "evaluationGuidance",
      "questions",
    ] as const) {
      checkSourcedItems(pack[p], sourceIds, ctx, [p]);
    }
  });
export type CompanyPack = z.infer<typeof CompanyPackSchema>;

/**
 * Extra YAML files in a company pack directory are overlays — they apply when
 * the target role matches `roleKeywords` or the round matches `mode`.
 */
export const CompanyPackOverlaySchema = z.object({
  appliesTo: z
    .object({
      roleKeywords: z.array(z.string().min(1).max(80)).default([]),
      mode: ModeIdSchema.optional(),
    })
    .default({ roleKeywords: [] }),
  competencies: z.array(PackItemSchema).default([]),
  questionStyle: z.array(PackItemSchema).default([]),
  evaluationGuidance: z.array(PackItemSchema).default([]),
  stages: z
    .array(
      z.object({
        mode: ModeIdSchema,
        label: z.string().min(1).max(80),
        plannedQuestions: z.number().int().min(1).max(6),
        provenance: ProvenanceSchema,
        source: SlugIdSchema.optional(),
      }),
    )
    .min(2)
    .max(7)
    .optional(),
  questions: z.array(PackQuestionSchema).default([]),
});
export type CompanyPackOverlay = z.infer<typeof CompanyPackOverlaySchema> & {
  /** file stem — set by the loader. */
  id: string;
};

export type CompanyPackWithOverlays = CompanyPack & {
  overlays: CompanyPackOverlay[];
};

/** Validate overlay items against the parent pack's declared sources. */
export function checkOverlayProvenance(
  overlay: CompanyPackOverlay,
  sources: PackSource[],
): void {
  const sourceIds = new Set(sources.map((s) => s.id));
  const items: Provenanced[] = [
    ...overlay.competencies,
    ...overlay.questionStyle,
    ...overlay.evaluationGuidance,
    ...(overlay.stages ?? []),
    ...overlay.questions,
  ];
  const bad = items.find((i) => i.provenance === "sourced" && (!i.source || !sourceIds.has(i.source)));
  if (bad) {
    throw new Error(
      `overlay "${overlay.id}" has a sourced item without a declared pack source`,
    );
  }
}

/** Compile a company pack into a CompanyProfile the rest of the app consumes. */
export function compileCompanyPack(pack: CompanyPackWithOverlays): CompanyProfile {
  let sourcedCount = 0;
  let communityCount = 0;
  const count = (items: Provenanced[]) => {
    for (const i of items) {
      if (i.provenance === "sourced") sourcedCount += 1;
      else communityCount += 1;
    }
  };
  count(pack.stages);
  count(pack.competencies);
  count(pack.questionStyle);
  count(pack.evaluationGuidance);
  count(pack.questions);
  for (const o of pack.overlays) {
    count(o.competencies);
    count(o.questionStyle);
    count(o.evaluationGuidance);
    count(o.stages ?? []);
    count(o.questions);
  }
  return CompanyProfileSchema.parse({
    id: pack.id,
    name: pack.name,
    aliases: pack.aliases,
    disclaimer:
      COMPANY_DISCLAIMER +
      " Community pack — items marked community are unverified observations.",
    typicalLoop: pack.stages.map((s) => ({
      mode: s.mode,
      label: s.label,
      plannedQuestions: s.plannedQuestions,
    })),
    emphasis: pack.emphasis,
    behavioralFramework: pack.behavioralFramework,
    followUpDepth: pack.followUpDepth,
    rubricEmphasis: {},
    roleExpectations: pack.roleExpectations,
    pack: {
      version: pack.version,
      kind: "company" as const,
      sourcedCount,
      communityCount,
    },
  });
}

// ------------------------------------------------------------------ role pack

/** A role-pack resource entry — the pack id is stamped at load time. */
export const PackResourceSchema = PrepResourceSchema.omit({ source: true });
export type PackResource = z.infer<typeof PackResourceSchema>;

export const RolePackSchema = z
  .object({
    format: z.literal("interview-os.role-pack").default("interview-os.role-pack"),
    id: SlugIdSchema,
    name: z.string().min(1).max(120),
    version: PackVersionSchema,
    description: z.string().max(2000).default(""),
    maintainers: z.array(z.string().min(1).max(120)).default([]),
    sources: z.array(PackSourceSchema).default([]),
    taxonomy: z
      .array(
        z.object({
          id: SkillIdSchema,
          label: z.string().min(1).max(120),
          keywords: z.array(z.string().min(1).max(80)).default([]),
        }),
      )
      .default([]),
    dimensions: z
      .array(
        z.object({
          skillId: SkillIdSchema,
          weight: z.number().min(0).max(1),
        }),
      )
      .min(1)
      .max(30),
    defaultQuestionCategories: z.array(ModeIdSchema).min(2).max(7),
    rubrics: z
      .array(
        z
          .object({
            skillId: SkillIdSchema.optional(),
            mode: ModeIdSchema.optional(),
            criteria: z.array(z.string().min(1).max(300)).min(1).max(8),
          })
          .refine((r) => r.skillId !== undefined || r.mode !== undefined, {
            message: "a rubric needs a skillId or a mode",
          }),
      )
      .default([]),
    resources: z.array(PackResourceSchema).default([]),
    questions: z.array(PackQuestionSchema).default([]),
  })
  .superRefine((pack, ctx) => {
    checkSourcedItems(pack.questions, new Set(pack.sources.map((s) => s.id)), ctx, [
      "questions",
    ]);
  });
export type RolePack = z.infer<typeof RolePackSchema>;

// ------------------------------------------------------------- interview pack

export const InterviewPackSchema = z.object({
  format: z
    .literal("interview-os.interview-pack")
    .default("interview-os.interview-pack"),
  id: SlugIdSchema,
  name: z.string().min(1).max(120),
  version: PackVersionSchema,
  description: z.string().max(2000).default(""),
  author: z.string().max(120).default(""),
  skills: z.array(SkillIdSchema).min(1).max(12),
  rounds: z
    .array(
      z.object({
        mode: ModeIdSchema,
        label: z.string().min(1).max(80),
        plannedQuestions: z.number().int().min(1).max(6),
      }),
    )
    .min(2)
    .max(7),
  durationMinutes: z.number().int().min(15).max(600),
});
export type InterviewPack = z.infer<typeof InterviewPackSchema>;

// ----------------------------------------------------------- question sources

/** A candidate question offered by a question source (pack, bank, plugin). */
export const QuestionCandidateSchema = z.object({
  skillId: SkillIdSchema,
  text: z.string().min(10).max(1200),
  difficulty: QuestionDifficultySchema.optional(),
  expectedConcepts: z.array(z.string().min(1).max(200)).max(8).optional(),
  mode: ModeIdSchema.optional(),
  source: z.object({
    kind: z.enum(["company_pack", "role_pack", "user_bank", "plugin"]),
    id: z.string().min(1).max(120),
    provenance: ProvenanceSchema.optional(),
  }),
});
export type QuestionCandidate = z.infer<typeof QuestionCandidateSchema>;
