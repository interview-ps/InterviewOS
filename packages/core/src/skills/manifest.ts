import { z } from "zod";

/**
 * §9.6 permission names. Read permissions gate which state slices a skill's
 * manifest may declare as inputs; write permissions gate persistence of a
 * skill's outputs (the orchestrator calls `host.assertCan` before writing).
 * `runtime.invoke` gates access to the AI runtime. `taxonomy.read` covers the
 * shared skill taxonomy — public domain data, declared for completeness.
 */
export const PermissionSchema = z.enum([
  "candidate.read",
  "candidate.write",
  "target.read",
  "target.write",
  "readiness.read",
  "evidence.write",
  "interview.read",
  "interview.write",
  "stories.read",
  "stories.write",
  "resume.read",
  "resume.write",
  "preparation.write",
  "taxonomy.read",
  "answers.read",
  "runtime.invoke",
]);
export type Permission = z.infer<typeof PermissionSchema>;

export { SLUG_ID_REGEX, SlugIdSchema } from "./slug.js";
import { SlugIdSchema } from "./slug.js";
import { UIActionSchema } from "../platform/ui-schema.js";
import { PluginSettingFieldSchema } from "../platform/plugin-api.js";
import { SkillIdSchema } from "../skill-id.js";
import { RoundTypeSchema } from "../interview/rounds.js";

/** v0.4: the only `*.write` permission a plugin may request and be granted. */
export const PLUGIN_WRITABLE_PERMISSIONS = ["evidence.write"] as const;

export function isPluginWritable(permission: Permission): boolean {
  return (PLUGIN_WRITABLE_PERMISSIONS as readonly string[]).includes(permission);
}

/** v0.4: platform-facing capability tags for plugin discovery (packs, P2+). */
export const PluginCapabilitySchema = z.enum([
  "interview",
  "evaluation",
  "question_source",
  "preparation",
  "resources",
  "company_pack",
  "role_pack",
  /** deprecated alias of "preparation" — normalized at load. */
  "checklist",
  "ui",
]);
export type PluginCapability = z.infer<typeof PluginCapabilitySchema>;

/** Capability set after manifest load — "checklist" is normalized away. */
export type NormalizedPluginCapability = Exclude<PluginCapability, "checklist">;

export const SkillManifestInputSchema = z.object({
  key: z.string().min(1).max(64),
  permission: PermissionSchema,
});
export type SkillManifestInput = z.infer<typeof SkillManifestInputSchema>;

/** v0.4 plugin UI extension points (slots a plugin may contribute to). */
export const PLUGIN_UI_SLOTS = [
  "dashboard.cards",
  "dashboard.sidebar",
  "target.tabs",
  "prepare.activities",
  "interview.sidebar",
  "interview.toolbar",
  "readiness.panels",
  "resume.tabs",
  "settings.sections",
] as const;
export const PluginUISlotSchema = z.enum(PLUGIN_UI_SLOTS);
export type PluginUISlot = z.infer<typeof PluginUISlotSchema>;

/** Fixed icon vocabulary for plugin navigation items. */
export const PluginUIIconSchema = z.enum([
  "database",
  "cloud",
  "code",
  "book",
  "chart",
  "puzzle",
  "shield",
  "star",
]);
export type PluginUIIcon = z.infer<typeof PluginUIIconSchema>;

export const PluginUIContributionSchema = z.object({
  component: SlugIdSchema,
  kind: z.enum(["declarative", "frame"]),
  title: z.string().max(120).optional(),
  /** frame kind only — relative path under ui/, validated at load. */
  entry: z.string().max(200).optional(),
});
export type PluginUIContribution = z.infer<typeof PluginUIContributionSchema>;

export const PluginUISchema = z.object({
  navigation: z
    .array(
      z.object({
        label: z.string().min(1).max(60),
        icon: PluginUIIconSchema,
        /** path relative to /plugins/<id> */
        page: z.string().regex(/^\//, "nav page must start with /").max(120),
      }),
    )
    .max(2)
    .default([]),
  commands: z
    .array(
      z.object({
        id: SlugIdSchema,
        label: z.string().min(1).max(120),
        action: UIActionSchema,
      }),
    )
    .max(5)
    .default([]),
  slots: z
    .partialRecord(PluginUISlotSchema, z.array(PluginUIContributionSchema).max(3))
    .default({}),
  pages: z
    .array(
      z.object({
        path: z.string().regex(/^\//, "page path must start with /").max(120),
        title: z.string().min(1).max(120),
        kind: z.enum(["declarative", "frame"]),
        component: SlugIdSchema,
        entry: z.string().max(200).optional(),
      }),
    )
    .max(5)
    .default([]),
});
export type PluginUI = z.infer<typeof PluginUISchema>;

/** A plugin-declared interview mode surfaced on the interview start page. */
export const PluginInterviewModeSchema = z.object({
  id: SlugIdSchema,
  label: z.string().min(1).max(120),
  description: z.string().max(300).default(""),
  roundType: RoundTypeSchema,
  focusSkills: z.array(SkillIdSchema).max(12).default([]),
  plannedQuestions: z.number().int().min(1).max(10).default(4),
  /** v0.4: untrusted pack-like guidance rendered into interviewer/evaluator prompts. */
  guidance: z.string().max(1500).optional(),
});
export type PluginInterviewMode = z.infer<typeof PluginInterviewModeSchema>;

/** Extra taxonomy nodes a plugin may register (same shape as role packs). */
export const PluginTaxonomyNodeSchema = z.object({
  id: SkillIdSchema,
  label: z.string().min(1).max(120),
  keywords: z.array(z.string().min(1).max(80)).default([]),
});
export type PluginTaxonomyNode = z.infer<typeof PluginTaxonomyNodeSchema>;

/** §9.6: every skill (built-in or plugin) carries a manifest. */
export const SkillManifestSchema = z.object({
  id: z.string().min(1).max(80),
  version: z.string().min(1).max(24),
  kind: z.enum(["builtin", "plugin"]),
  description: z.string().max(1000).default(""),
  inputs: z.array(SkillManifestInputSchema).default([]),
  outputs: z.array(z.string()).default([]),
  permissions: z.array(PermissionSchema).default([]),
  /** Display name; empty/missing means "use id". */
  name: z.string().max(120).optional(),
  author: z.string().max(120).optional(),
  capabilities: z
    .array(PluginCapabilitySchema)
    // deprecated "checklist" alias normalizes to "preparation" (deduped).
    .transform(
      (caps): NormalizedPluginCapability[] => [
        ...new Set(
          caps.map((c): NormalizedPluginCapability =>
            c === "checklist" ? "preparation" : c,
          ),
        ),
      ],
    )
    .optional(),
  engines: z
    .object({
      "interview-os": z.string().min(1).max(80),
      "plugin-api": z.string().min(1).max(80).optional(),
    })
    .optional(),
  /** v0.4 Plugin API v1: hooks this plugin implements (legacy plugins declare
   *  them here; SDK `handlers` are discovered via describe). */
  hooks: z.array(z.string().min(1).max(80)).max(30).optional(),
  /** v0.4: event subscriptions ("sessionCompleted" | "readinessUpdated"). */
  events: z.array(z.enum(["sessionCompleted", "readinessUpdated"])).max(4).optional(),
  /** v0.4: which skills a hook applies to (absent = all). */
  appliesTo: z
    .object({
      skillPrefixes: z.array(z.string().min(1).max(80)).max(30).optional(),
    })
    .optional(),
  /** v0.4: declared settings fields; values live in plugin_settings. */
  settings: z.array(PluginSettingFieldSchema).max(20).optional(),
  /** v0.4: UI contributions — requires the "ui" capability (checked at load). */
  ui: PluginUISchema.optional(),
  /** v0.4: plugin-declared interview modes ("<pluginId>:<modeId>"). */
  interviewModes: z.array(PluginInterviewModeSchema).max(5).optional(),
  /** v0.4: extra taxonomy nodes registered at load. */
  taxonomy: z.array(PluginTaxonomyNodeSchema).max(30).optional(),
});
export type SkillManifest = z.infer<typeof SkillManifestSchema>;

/**
 * §9.6: state slices the host may assemble as plugin inputs, each mapped to
 * the read permission that gates it. Plugin manifests may only declare these.
 */
export const PLUGIN_INPUT_KEYS = {
  candidate: "candidate.read",
  target: "target.read",
  readiness: "readiness.read",
  gaps: "readiness.read",
  stories: "stories.read",
  recentEvaluations: "interview.read",
  resume: "resume.read",
  request: "taxonomy.read",
} as const satisfies Record<string, Permission>;
export type PluginInputKey = keyof typeof PLUGIN_INPUT_KEYS;

export function isWritePermission(permission: Permission): boolean {
  return permission.endsWith(".write");
}
