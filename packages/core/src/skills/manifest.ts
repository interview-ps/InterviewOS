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
  "runtime.invoke",
]);
export type Permission = z.infer<typeof PermissionSchema>;

export const SkillManifestInputSchema = z.object({
  key: z.string().min(1).max(64),
  permission: PermissionSchema,
});
export type SkillManifestInput = z.infer<typeof SkillManifestInputSchema>;

/** §9.6: every skill (built-in or plugin) carries a manifest. */
export const SkillManifestSchema = z.object({
  id: z.string().min(1).max(80),
  version: z.string().min(1).max(24),
  kind: z.enum(["builtin", "plugin"]),
  description: z.string().max(1000).default(""),
  inputs: z.array(SkillManifestInputSchema).default([]),
  outputs: z.array(z.string()).default([]),
  permissions: z.array(PermissionSchema).default([]),
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
} as const satisfies Record<string, Permission>;
export type PluginInputKey = keyof typeof PLUGIN_INPUT_KEYS;

export function isWritePermission(permission: Permission): boolean {
  return permission.endsWith(".write");
}
