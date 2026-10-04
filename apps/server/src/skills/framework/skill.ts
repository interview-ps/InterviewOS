import type { AIRuntime } from "@interview-os/runtime";
import type { Permission, SkillManifest } from "@interview-os/core";
import { AppError, type Logger } from "@interview-os/core";
import type { z } from "zod";

/** Progress update pushed by skills during long-running AI calls (§8.3). */
export type ProgressUpdate =
  | { stage: string }
  | { field: string; text: string };

export interface SkillContext {
  runtime: AIRuntime;
  logger: Logger;
  /** Interview OS session id (orchestrator scope). */
  sessionId?: string;
  /** Runtime session id for skills that talk on an existing thread. */
  runtimeSessionId?: string;
  /** Streamed progress: stage changes and partial field text. */
  onProgress?: (p: ProgressUpdate) => void;
  /** Per-call runtime overrides, resolved by the orchestrator from settings. */
  runtimeOptions?: {
    model?: string | null;
    effort?: "low" | "medium" | "high" | null;
    taskMode?: "app-server" | "exec";
  };
  /** v0.4 plugins: effective permission grant set (manifest ∩ granted). */
  grantedPermissions?: readonly Permission[];
  /** v1 plugins: which Plugin API hook this run dispatches to (if any). */
  pluginHook?: string;
  /** v1 plugins: the hook's raw request payload (for handlers dispatch). */
  hookRequest?: unknown;
  /** v1 plugins: declared settings values (defaults applied). */
  settings?: Record<string, unknown>;
  /** v1 plugins: plugin-owned KV storage (isolated per plugin, never shared). */
  storage?: PluginKvStorage;
  now(): Date;
}

/** Plugin-owned key/value storage: get/set/delete, backed by the host. */
export interface PluginKvStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface InterviewSkill<I, O> {
  readonly id: string;
  /** §9.6 manifest: declared inputs, outputs and permissions. */
  readonly manifest: SkillManifest;
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema: z.ZodType<O>;
  execute(input: I, ctx: SkillContext): Promise<O>;
}

export class SkillRuntimeError extends AppError {
  readonly runtimeCode: string;
  readonly taskId: string;

  constructor(taskId: string, cause: { code: string; message: string }) {
    super(
      "SKILL_RUNTIME",
      `skill "${taskId}" runtime failure (${cause.code}): ${cause.message}`,
    );
    this.name = "SkillRuntimeError";
    this.runtimeCode = cause.code;
    this.taskId = taskId;
  }
}

export class SkillOutputError extends AppError {
  readonly taskId: string;

  constructor(taskId: string, detail: string) {
    super("SKILL_OUTPUT", `skill "${taskId}" produced invalid output: ${detail}`);
    this.name = "SkillOutputError";
    this.taskId = taskId;
  }
}
