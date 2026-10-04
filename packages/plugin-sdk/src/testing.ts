import fs from "node:fs/promises";
import path from "node:path";
import {
  CAPABILITY_HOOKS,
  hookRequestSchema,
  hookResponseSchema,
  LEGACY_HOOK_KIND,
  PLUGIN_HOOK_NAMES,
  isPluginHookName,
  pluginEvidenceProposals,
  type EvidenceProposal,
  type Permission,
  type PluginHookName,
  type PluginInputKey,
  type SkillManifest,
} from "@interview-os/core";
import { MockRuntime, type MockTaskHandler } from "@interview-os/runtime";
import {
  isDefinedSkill,
  type PluginContext,
  type PluginHookHandler,
  type PluginStorage,
  type SkillDefinition,
} from "./index.js";
import { findEntryFile, loadManifestFile } from "./manifest.js";

const OUTPUT_MAX_BYTES = 100 * 1024;

export interface MockPluginRun {
  plugin:
    | SkillDefinition
    | { execute(input: Record<string, unknown>, ctx: PluginContext): unknown };
  /** Manifest to enforce host semantics; omit to run without a manifest. */
  manifest?: SkillManifest;
  slices?: Record<string, unknown>;
  request?: unknown;
  /** v1: invoke `plugin.handlers[hook]` instead of legacy execute. */
  hook?: string;
  /** v1: settings values handed to the plugin (ctx.settings). */
  settings?: Record<string, unknown>;
  /** v1: seed values for the in-memory KV store (ctx.storage). */
  storage?: Record<string, unknown>;
  mockHandlers?: Record<string, MockTaskHandler>;
}

export interface MockRunResult {
  output: unknown;
  evidenceProposals: EvidenceProposal[];
  logs: string[];
}

/**
 * Execute a plugin in-process against a MockRuntime, enforcing the same
 * semantics as the host: only declared + granted slices, runtime absent
 * without runtime.invoke, JSON-serializable output ≤ 100 KB, proposals
 * schema-validated.
 */
export async function runPluginWithMock(
  run: MockPluginRun,
): Promise<MockRunResult> {
  const { manifest } = run;
  const granted = new Set<Permission>(manifest?.permissions ?? []);
  const declared = new Map<string, Permission>(
    manifest?.inputs.map((i) => [i.key, i.permission]) ?? [],
  );

  const input: Record<string, unknown> = {};
  if (manifest) {
    for (const [key, permission] of declared) {
      if (granted.has(permission)) input[key] = run.slices?.[key];
    }
  } else {
    Object.assign(input, run.slices ?? {});
  }

  const runtime = new MockRuntime();
  for (const [taskId, handler] of Object.entries(run.mockHandlers ?? {})) {
    runtime.register(taskId, handler);
  }

  const logs: string[] = [];
  const kv = new Map<string, unknown>(Object.entries(run.storage ?? {}));
  const storage: PluginStorage = {
    get: async (key) => kv.get(key),
    set: async (key, value) => {
      kv.set(key, value);
    },
    delete: async (key) => {
      kv.delete(key);
    },
  };
  const context: PluginContext = {
    input,
    request: run.request,
    runtime: granted.has("runtime.invoke") ? runtime : undefined,
    settings: run.settings ?? {},
    storage,
    log: (m) => logs.push(String(m)),
  };

  const plugin = run.plugin;
  const handler = run.hook
    ? ((plugin as SkillDefinition).handlers?.[run.hook as PluginHookName] as
        | PluginHookHandler
        | undefined)
    : undefined;
  const output = handler
    ? await handler(run.request, {
        input,
        runtime: context.runtime,
        settings: context.settings,
        storage,
        log: context.log,
      })
    : isDefinedSkill(plugin) && plugin.execute
      ? await plugin.execute(context)
      : !isDefinedSkill(plugin) && typeof plugin.execute === "function"
        ? await (plugin.execute as (
            i: Record<string, unknown>,
            c: PluginContext,
          ) => unknown)(input, context)
        : (() => {
            throw new Error(
              `plugin has no handler for "${run.hook ?? "(run)"}" and no execute`,
            );
          })();

  let serialized: string;
  try {
    serialized = JSON.stringify(output);
  } catch {
    throw new Error("plugin output is not JSON-serializable");
  }
  if (serialized === undefined || serialized.length > OUTPUT_MAX_BYTES) {
    throw new Error(`plugin output exceeds ${OUTPUT_MAX_BYTES} bytes`);
  }

  const proposals = pluginEvidenceProposals(output);
  if (proposals === null) {
    throw new Error("plugin evidenceProposals failed schema validation");
  }
  return { output, evidenceProposals: proposals, logs };
}

export interface ValidatePluginResult {
  manifest: SkillManifest;
  entryFile: string;
}

/**
 * Static plugin check: manifest parses, an entry file exists, and the
 * defineSkill id/permissions written in the entry source match the manifest
 * (code permissions ⊆ manifest permissions).
 */
export async function validatePlugin(dir: string): Promise<ValidatePluginResult> {
  const manifest = await loadManifestFile(dir);
  const entryFile = await findEntryFile(dir);
  if (!entryFile) {
    throw new Error(`plugin "${manifest.id}" has no index.ts/index.js entry`);
  }
  const source = await fs.readFile(path.join(dir, entryFile), "utf8");

  const idMatch = /\bid\s*:\s*["'`]([a-z][a-z0-9-]{0,79})["'`]/.exec(source);
  if (idMatch && idMatch[1] !== manifest.id) {
    throw new Error(
      `entry id "${idMatch[1]}" does not match manifest id "${manifest.id}"`,
    );
  }

  const permsMatch = /\bpermissions\s*:\s*\[([^\]]*)\]/s.exec(source);
  if (permsMatch) {
    const codePerms = [
      ...(permsMatch[1] ?? "").matchAll(/["'`]([a-z]+\.[a-z_]+)["'`]/g),
    ]
      .map((m) => m[1] ?? "")
      .filter(
        (p) =>
          p.endsWith(".read") || p.endsWith(".write") || p === "runtime.invoke",
      );
    const manifestPerms = new Set<string>(manifest.permissions);
    for (const perm of codePerms) {
      if (!manifestPerms.has(perm)) {
        throw new Error(
          `entry requests "${perm}" which is not in the manifest permissions`,
        );
      }
    }
  }
  return { manifest, entryFile };
}

/* ------------------------------------------------- v1 contract tests ------ */

/** Built-in sample requests per hook (overridable via `fixtures`). */
export const CONTRACT_FIXTURES: Record<PluginHookName, unknown> = {
  "questions.suggest": {
    skillId: "coding.algorithms",
    roundType: "technical",
    level: "senior",
    count: 2,
  },
  "resources.suggest": { skillIds: ["coding.algorithms"] },
  "ui.render": { slot: "dashboard.cards", component: "main" },
  "ui.frameRun": { component: "main", request: {} },
  "evaluation.review": {
    question: {
      skillId: "coding.algorithms",
      text: "Explain binary search complexity.",
      roundType: "technical",
      expectedConcepts: ["time complexity"],
    },
    answer: { text: "It is O(log n).", code: null, language: null },
    evaluation: {
      summary: "Correct, terse.",
      dimensions: {
        correctness: { score: 0.9, note: "right answer" },
        technicalDepth: { score: 0.6, note: "shallow" },
        reasoning: { score: 0.7, note: "fine" },
        structure: { score: 0.7, note: "fine" },
        communication: { score: 0.8, note: "clear" },
        evidence: { score: 0.5, note: "thin" },
        roleRelevance: { score: 0.8, note: "relevant" },
      },
      strengths: [],
      weaknesses: [],
      scores: [{ skill: "coding.algorithms", score: 0.8, confidence: 0.6 }],
      missingConcepts: [],
      betterApproach: "Same answer with an example.",
      followUpTopics: ["space complexity"],
      star: null,
      rubric: [],
      designUpdates: null,
    },
  },
  "preparation.suggest": {
    gaps: [{ skillId: "coding.algorithms", label: "Algorithms", severity: "medium" }],
    skillIds: ["coding.algorithms"],
  },
  "events.sessionCompleted": {
    sessionId: "int_test",
    roundType: "technical",
    scores: {},
  },
  "events.readinessUpdated": { changedSkillIds: ["coding.algorithms"] },
};

export interface ContractTestResult {
  ok: boolean;
  hookResults: { hook: string; ok: boolean; error?: string }[];
  warnings: string[];
}

/** All hooks a plugin is expected to back: manifest hooks ∪ declared handlers. */
function declaredHooks(
  manifest: SkillManifest,
  handlers: string[],
): PluginHookName[] {
  return [
    ...new Set([...(manifest.hooks ?? []), ...handlers]),
  ].filter((h): h is PluginHookName => isPluginHookName(h));
}

/**
 * Plugin API v1 contract check: loads the manifest, verifies capability↔hook
 * coverage, then invokes each declared hook with a sample request (in-process
 * — same validation the host applies) and checks the response schema.
 */
export async function runContractTests(opts: {
  dir: string;
  /** Per-hook request overrides. */
  fixtures?: Partial<Record<PluginHookName, unknown>>;
}): Promise<ContractTestResult> {
  const manifest = await loadManifestFile(opts.dir);
  const entryFile = await findEntryFile(opts.dir);
  const warnings: string[] = [];
  if (!entryFile) {
    throw new Error(`plugin "${manifest.id}" has no entry file`);
  }
  const { pathToFileURL } = await import("node:url");
  const mod = (await import(
    pathToFileURL(path.resolve(opts.dir, entryFile)).href
  )) as { default?: SkillDefinition & { handlers?: Record<string, unknown> } };
  const plugin = mod.default ?? (mod as unknown as SkillDefinition);
  const handlers = Object.keys(plugin?.handlers ?? {});
  const hooks = declaredHooks(manifest, handlers);
  const hasExecute = typeof plugin?.execute === "function";

  // capability ↔ hook coverage (same rules as the host loader)
  for (const cap of manifest.capabilities ?? []) {
    const backing = CAPABILITY_HOOKS[cap];
    if (!backing) continue; // interview/pack caps verified separately
    if (backing.some((h) => hooks.includes(h))) continue;
    if (hasExecute && hooks.length === 0) {
      warnings.push(
        `capability "${cap}": covered only by legacy execute — declare hooks`,
      );
    } else {
      throw new Error(
        `capability "${cap}" is not backed by any hook (${backing.join(", ")})`,
      );
    }
  }

  const hookResults: ContractTestResult["hookResults"] = [];
  for (const hook of hooks) {
    const fixture =
      opts.fixtures?.[hook] ?? CONTRACT_FIXTURES[hook];
    try {
      const req = hookRequestSchema(hook).parse(fixture) as Record<
        string,
        unknown
      >;
      const { output } = await runPluginWithMock({
        plugin: plugin as SkillDefinition,
        manifest,
        request: { ...req, kind: LEGACY_HOOK_KIND[hook] },
        hook,
      });
      hookResponseSchema(hook).parse(output);
      hookResults.push({ hook, ok: true });
    } catch (err) {
      hookResults.push({
        hook,
        ok: false,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      });
    }
  }
  return {
    ok: hookResults.every((r) => r.ok),
    hookResults,
    warnings,
  };
}
