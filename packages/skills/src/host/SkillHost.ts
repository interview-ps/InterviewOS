import { z } from "zod";
import { AppError, type Logger } from "@interview-os/shared";
import {
  PLUGIN_INPUT_KEYS,
  SkillManifestSchema,
  isWritePermission,
  type Permission,
  type PluginInputKey,
  type SkillManifest,
} from "@interview-os/core";
import type { AIRuntime } from "@interview-os/runtime";
import type { InterviewSkill, SkillContext } from "../framework/skill.js";

/** §9.6: permission failure code — thrown before a skill ever executes. */
export class PermissionError extends AppError {
  constructor(message: string) {
    super("PERMISSION_DENIED", message);
    this.name = "PermissionError";
  }
}

export class PluginError extends AppError {
  constructor(code: "PLUGIN_TIMEOUT" | "PLUGIN_OUTPUT" | "PLUGIN_INVALID", message: string) {
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

function proxyRuntime(manifest: SkillManifest, runtime: AIRuntime): AIRuntime {
  if (manifest.permissions.includes("runtime.invoke")) return runtime;
  return new Proxy({} as AIRuntime, {
    get(_target, prop) {
      if (typeof prop === "symbol" || prop === "then") return undefined;
      throw new PermissionError(
        `skill "${manifest.id}" cannot use the runtime — its manifest lacks runtime.invoke`,
      );
    },
  });
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
    for (const permission of parsed.permissions) {
      if (isWritePermission(permission)) {
        throw new PermissionError(
          `plugin "${parsed.id}" requests write permission "${permission}" — plugins are read-only`,
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
   * skill's outputs.
   */
  assertCan(id: string, permission: Permission): void {
    const { manifest } = this.entry(id);
    if (!manifest.permissions.includes(permission)) {
      throw new PermissionError(
        `skill "${id}" is not allowed ${permission} (granted: ${manifest.permissions.join(", ") || "none"})`,
      );
    }
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
      runtime: proxyRuntime(entry.manifest, ctx.runtime),
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
  ): Promise<unknown> {
    const entry = this.entry(id);
    if (!entry.plugin) {
      throw new AppError("VALIDATION", `skill "${id}" is not a plugin`);
    }
    const input: Record<string, unknown> = {};
    for (const declared of entry.manifest.inputs) {
      if (!entry.manifest.permissions.includes(declared.permission)) continue;
      const key = declared.key as PluginInputKey;
      input[key] = slices[key];
    }

    const guardedCtx: SkillContext = {
      ...ctx,
      runtime: proxyRuntime(entry.manifest, ctx.runtime),
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
