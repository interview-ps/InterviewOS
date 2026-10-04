import type { z } from "zod";
import type {
  Permission,
  PluginInputKey,
  PluginCapability,
  PluginHookName,
} from "@interview-os/core";
import type { PLUGIN_HOOKS } from "@interview-os/core";
import type { AgentResult, AgentTask } from "@interview-os/runtime";

export type {
  Permission,
  PluginCapability,
  PluginInputKey,
  SkillManifest,
  SkillManifestInput,
  EvidenceProposal,
  CandidateProfile,
  TargetRole,
  Gap,
  SkillReadiness,
  ReadinessGraph,
  Evidence,
} from "@interview-os/core";
export type { AgentTask, AgentResult } from "@interview-os/runtime";

export const SKILL_MARKER = "__interviewOsSkill" as const;

/** Everything the host hands to a plugin for one run. */
export interface PluginContext {
  /** Declared + granted state slices, keyed by PluginInputKey. */
  input: Record<string, unknown>;
  /** Small typed request object (the `request` input key). */
  request?: unknown;
  /** Present only when the manifest has runtime.invoke and it is granted. */
  runtime?: { runTask(task: AgentTask): Promise<AgentResult> };
  /** v1: manifest-declared settings values (defaults + stored overrides). */
  settings: Record<string, unknown>;
  /** v1: the plugin's own key/value store (not shared, wiped on uninstall). */
  storage: PluginStorage;
  log(message: string): void;
}

/** v1: per-plugin KV storage — the plugin's own rows, no permission needed. */
export interface PluginStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

/** v1: context handed to a typed `handlers` hook (no `request` — it IS the arg). */
export interface PluginHookContext {
  input: Record<string, unknown>;
  runtime?: { runTask(task: AgentTask): Promise<AgentResult> };
  settings: Record<string, unknown>;
  storage: PluginStorage;
  log(message: string): void;
}

export type PluginHookHandler<Req = unknown, Res = unknown> = (
  request: Req,
  ctx: PluginHookContext,
) => Promise<Res> | Res;

/** Hook request/response types inferred from the Plugin API v1 contracts. */
export type HookRequest<H extends PluginHookName> = z.infer<
  (typeof PLUGIN_HOOKS)[H]["request"]
>;
export type HookResponse<H extends PluginHookName> = z.infer<
  (typeof PLUGIN_HOOKS)[H]["response"]
>;
export type PluginHandlers = {
  [H in PluginHookName]?: PluginHookHandler<
    HookRequest<H>,
    HookResponse<H> | unknown
  >;
};

export interface SkillDefinition {
  id: string;
  name?: string;
  version?: string;
  permissions: Permission[];
  capabilities?: PluginCapability[];
  inputs?: PluginInputKey[];
  /** v1: typed hook handlers dispatched by {hook, request} — preferred. */
  handlers?: PluginHandlers;
  /** Legacy catch-all — still supported (`request.kind` dispatch). */
  execute?(context: PluginContext): Promise<unknown> | unknown;
}

export type DefinedSkill<D extends SkillDefinition = SkillDefinition> = D & {
  readonly [SKILL_MARKER]: 1;
};

export function defineSkill<D extends SkillDefinition>(def: D): DefinedSkill<D> {
  Object.defineProperty(def, SKILL_MARKER, {
    value: 1,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return def as DefinedSkill<D>;
}

export function isDefinedSkill(value: unknown): value is DefinedSkill {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)[SKILL_MARKER] === 1
  );
}

export { loadManifestFile, findEntryFile } from "./manifest.js";

// v0.4 plugin UI Level 2 contract — what a built ui/index.js default-exports.
export type {
  PluginFrameComponent,
  PluginFrameContext,
  PluginFrameModule,
  PluginFrameProps,
  PluginFrameRunResult,
  PluginFrameSDK,
} from "@interview-os/ui/frame";
