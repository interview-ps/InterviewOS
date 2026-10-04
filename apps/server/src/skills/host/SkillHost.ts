import { z } from "zod";
import { AppError, type Logger } from "@interview-os/core";
import {
  INTERVIEW_OS_VERSION,
  PLUGIN_INPUT_KEYS,
  SkillManifestSchema,
  isPluginWritable,
  isWritePermission,
  satisfies,
  SLUG_ID_REGEX,
  isPluginApiCompatible,
  type Permission,
  type PluginInputKey,
  type SkillManifest,
} from "@interview-os/core";
import type { AIRuntime } from "@interview-os/runtime";
import type {
  InterviewSkill,
  PluginKvStorage,
  SkillContext,
} from "../framework/skill.js";

/** §9.6: permission failure code — thrown before a skill ever executes. */
export class PermissionError extends AppError {
  constructor(message: string) {
    super("PERMISSION_DENIED", message);
    this.name = "PermissionError";
  }
}

export class PluginError extends AppError {
  constructor(
    code:
      | "PLUGIN_TIMEOUT"
      | "PLUGIN_OUTPUT"
      | "PLUGIN_INVALID"
      | "PLUGIN_INCOMPATIBLE"
      | "PLUGIN_DISABLED"
      | "PLUGIN_INSTALL",
    message: string,
  ) {
    super(code, message);
    this.name = "PluginError";
  }
}

export const PLUGIN_TIMEOUT_MS = 30_000;
/** Plugin output must stay JSON-serializable and under this size. */
export const PLUGIN_OUTPUT_MAX_BYTES = 100 * 1024;

/** What a plugin's index module must default-export. */
export interface PluginExecutor {
  execute(
    input: Record<string, unknown>,
    ctx: SkillContext,
  ): Promise<unknown> | unknown;
  /** Optional output schema — validated like a structured skill output. */
  outputSchema?: z.ZodType;
  /** v1: report which Plugin API hooks the plugin implements. */
  describe?(): Promise<{ handlers: string[]; hasExecute: boolean }>;
}

interface HostEntry {
  manifest: SkillManifest;
  execute(input: unknown, ctx: SkillContext): Promise<unknown> | unknown;
  inputSchema?: z.ZodType;
  outputSchema?: z.ZodType;
  plugin: boolean;
}

export type PluginStateSlices = Partial<
  Record<PluginInputKey, unknown>
>;

function proxyRuntime(
  skillId: string,
  permissions: readonly Permission[],
  runtime: AIRuntime,
): AIRuntime {
  if (permissions.includes("runtime.invoke")) return runtime;
  return new Proxy({} as AIRuntime, {
    get(_target, prop) {
      if (typeof prop === "symbol" || prop === "then") return undefined;
      throw new PermissionError(
        `skill "${skillId}" cannot use the runtime — its manifest lacks runtime.invoke`,
      );
    },
  });
}

/** v0.4: effective permissions = manifest ∩ granted (granted omitted → all requested). */
function effectivePermissions(
  manifest: SkillManifest,
  granted?: readonly Permission[],
): Permission[] {
  if (!granted) return manifest.permissions;
  const set = new Set(granted);
  return manifest.permissions.filter((p) => set.has(p));
}

/** v0.4: engines["interview-os"] and engines["plugin-api"] (missing = ^1) must hold. */
export function isManifestCompatible(manifest: SkillManifest): boolean {
  const range = manifest.engines?.["interview-os"];
  const apiRange = manifest.engines?.["plugin-api"];
  return (
    (range === undefined || satisfies(INTERVIEW_OS_VERSION, range)) &&
    isPluginApiCompatible(apiRange)
  );
}

/**
 * §9.6: the single gateway for every skill call. Validates inputs against the
 * manifest (declared keys + granted permissions), gates ctx.runtime behind
 * runtime.invoke, and exposes assertCan() for write checks before the
 * orchestrator persists a skill's outputs.
 */
export class SkillHost {
  private readonly entries = new Map<string, HostEntry>();
  private readonly logger?: Logger;

  constructor(deps: { logger?: Logger } = {}) {
    this.logger = deps.logger;
  }

  /** Register a built-in skill with its manifest. */
  register<I, O>(
    skill: InterviewSkill<I, O>,
    manifest: SkillManifest = skill.manifest,
  ): void {
    const parsed = SkillManifestSchema.parse(manifest);
    if (parsed.id !== skill.id) {
      throw new AppError(
        "VALIDATION",
        `manifest id "${parsed.id}" does not match skill id "${skill.id}"`,
      );
    }
    this.entries.set(skill.id, {
      manifest: parsed,
      inputSchema: skill.inputSchema,
      outputSchema: skill.outputSchema,
      execute: (input, ctx) => skill.execute(input as I, ctx),
      plugin: false,
    });
  }

  /**
   * Register a plugin. The loader has already validated the manifest and
   * rejected write permissions; the host double-checks both plus the input
   * slices, since this is the security boundary.
   */
  registerPlugin(manifest: SkillManifest, executor: PluginExecutor): void {
    const parsed = SkillManifestSchema.parse({ ...manifest, kind: "plugin" });
    if (!SLUG_ID_REGEX.test(parsed.id)) {
      throw new PluginError(
        "PLUGIN_INVALID",
        `plugin id "${parsed.id}" is not a valid slug (${SLUG_ID_REGEX.source})`,
      );
    }
    parsed.name ??= parsed.id;
    for (const permission of parsed.permissions) {
      if (isWritePermission(permission) && !isPluginWritable(permission)) {
        throw new PermissionError(
          `plugin "${parsed.id}" requests write permission "${permission}" — plugins may only write evidence`,
        );
      }
    }
    for (const input of parsed.inputs) {
      const expected = PLUGIN_INPUT_KEYS[input.key as PluginInputKey];
      if (expected === undefined) {
        throw new PluginError(
          "PLUGIN_INVALID",
          `plugin "${parsed.id}" declares unsupported input "${input.key}"`,
        );
      }
      if (input.permission !== expected) {
        throw new PluginError(
          "PLUGIN_INVALID",
          `plugin "${parsed.id}" input "${input.key}" must require "${expected}"`,
        );
      }
    }
    this.entries.set(parsed.id, {
      manifest: parsed,
      outputSchema: executor.outputSchema,
      execute: (input, ctx) => executor.execute(input as Record<string, unknown>, ctx),
      plugin: true,
    });
  }

  private entry(id: string): HostEntry {
    const entry = this.entries.get(id);
    if (!entry) throw new AppError("NOT_FOUND", `unknown skill "${id}"`);
    return entry;
  }

  manifests(): SkillManifest[] {
    return [...this.entries.values()].map((e) => e.manifest);
  }

  /**
   * §9.6 write gate — the orchestrator calls this before persisting any of the
   * skill's outputs. For plugins, pass the effective grant set.
   */
  assertCan(
    id: string,
    permission: Permission,
    granted?: readonly Permission[],
  ): void {
    const { manifest } = this.entry(id);
    if (!effectivePermissions(manifest, granted).includes(permission)) {
      throw new PermissionError(
        `skill "${id}" is not allowed ${permission} (granted: ${effectivePermissions(manifest, granted).join(", ") || "none"})`,
      );
    }
  }

  /** Remove a registered plugin (v0.4 uninstall); built-ins cannot be removed. */
  unregister(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (!entry.plugin) {
      throw new AppError("VALIDATION", `skill "${id}" is not a plugin`);
    }
    this.entries.delete(id);
  }

  /** Reject top-level input keys the manifest doesn't declare or permit. */
  private checkInputKeys(manifest: SkillManifest, input: unknown): void {
    if (typeof input !== "object" || input === null) return;
    const declared = new Map(manifest.inputs.map((i) => [i.key, i.permission]));
    for (const key of Object.keys(input)) {
      const permission = declared.get(key);
      if (!permission) {
        throw new PermissionError(
          `skill "${manifest.id}" manifest does not declare input "${key}"`,
        );
      }
      if (!manifest.permissions.includes(permission)) {
        throw new PermissionError(
          `skill "${manifest.id}" lacks ${permission} for input "${key}"`,
        );
      }
    }
  }

  async invoke<I, O>(
    skill: InterviewSkill<I, O>,
    input: I,
    ctx: SkillContext,
  ): Promise<O>;
  async invoke(id: string, input: unknown, ctx: SkillContext): Promise<unknown>;
  async invoke(
    skillOrId: InterviewSkill<never, never> | InterviewSkill<unknown, unknown> | string,
    input: unknown,
    ctx: SkillContext,
  ): Promise<unknown> {
    const id = typeof skillOrId === "string" ? skillOrId : skillOrId.id;
    const entry = this.entry(id);
    this.checkInputKeys(entry.manifest, input);

    let parsedInput = input;
    if (entry.inputSchema) {
      const parsed = entry.inputSchema.safeParse(input);
      if (!parsed.success) {
        throw new AppError(
          "VALIDATION",
          `invalid input for skill "${id}": ${parsed.error.issues
            .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
            .join("; ")}`,
        );
      }
      parsedInput = parsed.data;
    }

    const guardedCtx: SkillContext = {
      ...ctx,
      runtime: proxyRuntime(id, entry.manifest.permissions, ctx.runtime),
    };
    const output = await entry.execute(parsedInput, guardedCtx);
    if (entry.outputSchema) {
      const parsed = entry.outputSchema.safeParse(output);
      if (!parsed.success) {
        throw new AppError(
          "VALIDATION",
          `skill "${id}" produced invalid output: ${parsed.error.issues
            .map((i) => `${i.path.join(".") || "output"}: ${i.message}`)
            .join("; ")}`,
        );
      }
    }
    return output;
  }

  /**
   * §9.6 plugin execution: input assembled from state, only the declared
   * slices, 30s timeout, output schema-validated when provided and capped at
   * 100 KB.
   */
  async invokePlugin(
    id: string,
    slices: PluginStateSlices,
    ctx: SkillContext,
    opts: {
      granted?: readonly Permission[];
      /** v1: Plugin API hook to dispatch (handlers) — legacy falls back. */
      hook?: string;
      hookRequest?: unknown;
      /** v1: declared settings values + plugin-owned KV storage adapter. */
      settings?: Record<string, unknown>;
      storage?: PluginKvStorage;
    } = {},
  ): Promise<unknown> {
    const entry = this.entry(id);
    if (!entry.plugin) {
      throw new AppError("VALIDATION", `skill "${id}" is not a plugin`);
    }
    if (!isManifestCompatible(entry.manifest)) {
      throw new PluginError(
        "PLUGIN_INCOMPATIBLE",
        `plugin "${id}" requires interview-os ${entry.manifest.engines?.["interview-os"]} (running ${INTERVIEW_OS_VERSION})`,
      );
    }
    const effective = effectivePermissions(entry.manifest, opts.granted);
    const input: Record<string, unknown> = {};
    for (const declared of entry.manifest.inputs) {
      if (!effective.includes(declared.permission)) continue;
      const key = declared.key as PluginInputKey;
      input[key] = slices[key];
    }

    const guardedCtx: SkillContext = {
      ...ctx,
      runtime: proxyRuntime(id, effective, ctx.runtime),
      grantedPermissions: effective,
      pluginHook: opts.hook,
      hookRequest: opts.hookRequest,
      settings: opts.settings,
      storage: opts.storage,
    };
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new PluginError(
              "PLUGIN_TIMEOUT",
              `plugin "${id}" exceeded ${PLUGIN_TIMEOUT_MS / 1000}s`,
            ),
          ),
        PLUGIN_TIMEOUT_MS,
      ),
    );
    let output: unknown;
    try {
      output = await Promise.race([entry.execute(input, guardedCtx), timeout]);
    } finally {
      // allow the timer's rejection to settle harmlessly
      timeout.catch(() => {});
    }

    if (entry.outputSchema) {
      const parsed = entry.outputSchema.safeParse(output);
      if (!parsed.success) {
        throw new PluginError(
          "PLUGIN_OUTPUT",
          `plugin "${id}" output failed schema validation`,
        );
      }
      output = parsed.data;
    }

    let serialized: string;
    try {
      serialized = JSON.stringify(output);
    } catch {
      throw new PluginError(
        "PLUGIN_OUTPUT",
        `plugin "${id}" returned a non-JSON-serializable value`,
      );
    }
    if (serialized.length > PLUGIN_OUTPUT_MAX_BYTES) {
      throw new PluginError(
        "PLUGIN_OUTPUT",
        `plugin "${id}" output exceeds ${PLUGIN_OUTPUT_MAX_BYTES} bytes`,
      );
    }
    this.logger?.info("plugin.ran", { plugin: id });
    return output;
  }
}
