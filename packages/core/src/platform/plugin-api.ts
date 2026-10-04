import { z } from "zod";
import { AnswerEvaluationSchema } from "../assessment/index.js";
import { RoundTypeSchema } from "../interview/index.js";
import { QuestionCandidateSchema } from "../packs/index.js";
import { PrepResourceSchema } from "../preparation/resources.js";
import { SlugIdSchema } from "../skills/slug.js";
import { EvidenceProposalSchema } from "../skills/proposals.js";
import { SkillIdSchema } from "../skill-id.js";
import type { PluginCapability } from "../skills/manifest.js";
import { UIToneSchema, UINodeSchema } from "./ui-schema.js";
import { satisfies } from "./semver.js";

/**
 * Plugin API v1 — the typed, versioned contract between the host and plugins.
 * Every platform extension point is a named hook with a request/response
 * schema; the host validates the request before sending and the response
 * after receiving. Additive changes bump the minor version, breaking changes
 * the major; the host supports the current major.
 */
export const PLUGIN_API_VERSION = "1.0.0";

export interface PluginHookSpec {
  /** capability that owns this hook (undefined for manifest `events` hooks) */
  capability?: PluginCapability;
  request: z.ZodType;
  response: z.ZodType;
  description: string;
}

const CandidateLiteSchema = QuestionCandidateSchema.omit({ source: true });
const ResourceLiteSchema = PrepResourceSchema.omit({
  source: true,
  skillId: true,
}).extend({
  /** Host fills from the request context when the plugin omits it. */
  skillId: SkillIdSchema.optional(),
  /** Host stamps "plugin:<id>"; plugin-provided values are advisory. */
  source: z.string().min(1).max(120).optional(),
});
export const PluginReviewObservationSchema = z.object({
  text: z.string().min(1).max(400),
  tone: UIToneSchema.default("muted"),
});
export type PluginReviewObservation = z.infer<
  typeof PluginReviewObservationSchema
>;

export const PluginPrepActivitySchema = z.object({
  skillId: SkillIdSchema,
  title: z.string().min(1).max(120),
  action: z.string().min(1).max(500),
  successCriteria: z.array(z.string().min(1).max(200)).max(5).default([]),
});
export type PluginPrepActivity = z.infer<typeof PluginPrepActivitySchema>;

export const PLUGIN_HOOKS = {
  "questions.suggest": {
    capability: "question_source",
    description: "Suggest interview questions for a skill/round.",
    request: z.object({
      skillId: SkillIdSchema,
      roundType: RoundTypeSchema,
      level: z.string().max(40).optional(),
      count: z.number().int().min(1).max(20).default(5),
    }),
    response: z
      .object({ questions: z.array(CandidateLiteSchema).max(50) })
      .loose(),
  },
  "resources.suggest": {
    capability: "resources",
    description: "Suggest prep resources for skills.",
    request: z.object({
      skillIds: z.array(SkillIdSchema).min(1).max(20),
    }),
    response: z
      .object({ resources: z.array(ResourceLiteSchema).max(50) })
      .loose(),
  },
  "ui.render": {
    capability: "ui",
    description: "Render a declared declarative contribution.",
    request: z.object({
      slot: z.string().min(1).max(60).optional(),
      component: z.string().min(1).max(80),
      page: z.string().min(1).max(120).optional(),
      params: z.unknown().optional(),
    }),
    response: z.object({ ui: UINodeSchema }).loose(),
  },
  "ui.frameRun": {
    capability: "ui",
    description: "Stateless invocation from a sandboxed frame.",
    request: z.object({
      component: z.string().min(1).max(80).optional(),
      page: z.string().min(1).max(120).optional(),
      request: z.record(z.string(), z.unknown()).optional(),
    }),
    response: z
      .object({ output: z.unknown(), ui: UINodeSchema.optional() })
      .loose(),
  },
  "evaluation.review": {
    capability: "evaluation",
    description:
      "Review a persisted answer evaluation; observations shown to the user.",
    request: z.object({
      question: z.object({
        skillId: SkillIdSchema,
        text: z.string().max(2000),
        roundType: RoundTypeSchema,
        expectedConcepts: z.array(z.string().max(200)).max(16).default([]),
      }),
      /** null unless the plugin was granted answers.read */
      answer: z
        .object({
          text: z.string().max(50_000),
          code: z.string().max(100_000).nullable().default(null),
          language: z.string().max(40).nullable().default(null),
        })
        .nullable(),
      evaluation: AnswerEvaluationSchema,
    }),
    response: z
      .object({
        observations: z.array(PluginReviewObservationSchema).max(5),
        evidenceProposals: z
          .array(EvidenceProposalSchema)
          .max(20)
          .optional(),
      })
      .loose(),
  },
  "preparation.suggest": {
    capability: "preparation",
    description: "Suggest preparation activities for current gaps.",
    request: z.object({
      gaps: z.array(z.record(z.string(), z.unknown())).max(10),
      skillIds: z.array(SkillIdSchema).max(20),
    }),
    response: z
      .object({ activities: z.array(PluginPrepActivitySchema).max(10) })
      .loose(),
  },
  "events.sessionCompleted": {
    description: "Fired (outside the lock) when an interview session completes.",
    request: z.object({
      sessionId: z.string().min(1).max(80),
      roundType: z.string().max(40),
      /** Per-skill summary of the session's evaluations (no answer text). */
      scores: z
        .record(
          z.string(),
          z.object({
            meanScore: z.number().min(0).max(1),
            answers: z.number().int().min(0),
          }),
        )
        .default({}),
    }),
    response: z
      .object({
        evidenceProposals: z.array(EvidenceProposalSchema).max(20).optional(),
      })
      .loose(),
  },
  "events.readinessUpdated": {
    description:
      "Fired (outside the lock) after a readiness recompute that changed scores.",
    request: z.object({
      changedSkillIds: z.array(SkillIdSchema).max(100),
    }),
    response: z
      .object({
        evidenceProposals: z.array(EvidenceProposalSchema).max(20).optional(),
      })
      .loose(),
  },
} satisfies Record<string, PluginHookSpec>;

export type PluginHookName = keyof typeof PLUGIN_HOOKS;
export const PLUGIN_HOOK_NAMES = Object.keys(PLUGIN_HOOKS) as PluginHookName[];

export function isPluginHookName(name: string): name is PluginHookName {
  return name in PLUGIN_HOOKS;
}

/** Event hook names a manifest may subscribe to via `events: [...]`. */
export const PLUGIN_EVENT_HOOKS = [
  "events.sessionCompleted",
  "events.readinessUpdated",
] as const satisfies readonly PluginHookName[];
export type PluginEventHook = (typeof PLUGIN_EVENT_HOOKS)[number];

/** Short event names accepted in manifest `events` (without the `events.` prefix). */
export const PLUGIN_EVENT_NAMES = ["sessionCompleted", "readinessUpdated"] as const;
export type PluginEventName = (typeof PLUGIN_EVENT_NAMES)[number];

/**
 * The `request.kind` value legacy plugins see for each hook. Hooks whose
 * names predate v1 keep their old kind strings so `request.kind` checks in
 * existing plugins keep working.
 */
export const LEGACY_HOOK_KIND: Record<PluginHookName, string> = {
  "questions.suggest": "questions",
  "resources.suggest": "resources",
  "ui.render": "ui",
  "ui.frameRun": "ui-frame",
  "evaluation.review": "evaluation.review",
  "preparation.suggest": "preparation.suggest",
  "events.sessionCompleted": "events.sessionCompleted",
  "events.readinessUpdated": "events.readinessUpdated",
};

/** The declared capability a hook backs (undefined = events). */
export function hookCapability(hook: PluginHookName): PluginCapability | undefined {
  return (PLUGIN_HOOKS[hook] as PluginHookSpec).capability;
}

export type HookRequest<H extends PluginHookName> = z.infer<
  (typeof PLUGIN_HOOKS)[H]["request"]
>;
export type HookResponse<H extends PluginHookName> = z.infer<
  (typeof PLUGIN_HOOKS)[H]["response"]
>;

/** Request/response validators for a hook (always present in the registry). */
export function hookRequestSchema(hook: PluginHookName): z.ZodType {
  return (PLUGIN_HOOKS[hook] as PluginHookSpec).request;
}
export function hookResponseSchema(hook: PluginHookName): z.ZodType {
  return (PLUGIN_HOOKS[hook] as PluginHookSpec).response;
}
/** Hooks that can back a capability (empty for pack/event-driven caps). */
export function capabilityHooks(cap: PluginCapability): PluginHookName[] {
  return CAPABILITY_HOOKS[cap] ?? [];
}

/** Capabilities (beyond `ui`, which needs a ui section) and the hooks that can back them. */
export const CAPABILITY_HOOKS: Partial<Record<PluginCapability, PluginHookName[]>> = {
  question_source: ["questions.suggest"],
  resources: ["resources.suggest"],
  ui: ["ui.render", "ui.frameRun"],
  evaluation: ["evaluation.review"],
  preparation: ["preparation.suggest"],
};

/** engines["plugin-api"] compat: missing = ^1.0.0, checked like interview-os. */
export function isPluginApiCompatible(range: string | undefined): boolean {
  return range === undefined || satisfies(PLUGIN_API_VERSION, range);
}

/* ------------------------------------------------------ manifest extensions */

/** v0.4: one declared plugin setting field (auto-rendered config UI). */
export const PluginSettingFieldSchema = z.object({
  key: SlugIdSchema,
  label: z.string().min(1).max(120),
  type: z.enum(["string", "number", "boolean", "enum"]),
  options: z.array(z.string().min(1).max(80)).max(20).optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  description: z.string().max(300).optional(),
});
export type PluginSettingField = z.infer<typeof PluginSettingFieldSchema>;

export const PluginSettingValueSchema = z.union([
  z.string().max(4000),
  z.number(),
  z.boolean(),
]);
export type PluginSettingValue = z.infer<typeof PluginSettingValueSchema>;

/** v0.4: hooks filter — which skills a plugin applies to (absent = all). */
export const PluginAppliesToSchema = z.object({
  skillPrefixes: z.array(z.string().min(1).max(80)).max(30).optional(),
});
export type PluginAppliesTo = z.infer<typeof PluginAppliesToSchema>;

export function pluginAppliesToSkill(
  appliesTo: PluginAppliesTo | undefined,
  skillId: string,
): boolean {
  const prefixes = appliesTo?.skillPrefixes;
  if (!prefixes || prefixes.length === 0) return true;
  return prefixes.some((p) => skillId === p || skillId.startsWith(`${p}.`));
}
