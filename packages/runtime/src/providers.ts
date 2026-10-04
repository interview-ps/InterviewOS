import fs from "node:fs/promises";
import path from "node:path";
import type { Logger } from "@interview-os/core";
import type { AIRuntime, RuntimeKind, RuntimeStatus } from "./interface/index.js";
import { MockRuntime } from "./mock/MockRuntime.js";
import { CodexRuntime } from "./codex/CodexRuntime.js";
import { ClaudeCodeRuntime } from "./claude/ClaudeCodeRuntime.js";
import { OpencodeRuntime } from "./opencode/OpencodeRuntime.js";
import { DevinRuntime } from "./devin/DevinRuntime.js";
import { codexHealthCheck } from "./codex/detect.js";
import { claudeHealthCheck } from "./claude/detect.js";
import { opencodeHealthCheck } from "./opencode/detect.js";
import { devinHealthCheck } from "./devin/detect.js";

export const RUNTIME_KINDS = [
  "codex",
  "mock",
  "claude",
  "opencode",
  "devin",
] as const satisfies readonly RuntimeKind[];

export const DEFAULT_WORKSPACE_DIR = path.resolve("data/codex-workspace");

/* ------------------------------------------------- v1 provider registry -- */

export interface RuntimeProviderSpec {
  /** Slug id — must not collide with a built-in kind. */
  kind: string;
  label?: string;
  /** Build the provider's AIRuntime (called per switch + at startup). */
  create(opts: {
    env: NodeJS.ProcessEnv;
    workspaceDir: string;
    logger?: Logger;
  }): AIRuntime | Promise<AIRuntime>;
  /** Optional detection probe (defaults to the runtime's own healthCheck). */
  healthCheck?(
    env: NodeJS.ProcessEnv,
    workspaceDir: string,
  ): Promise<RuntimeStatus>;
}

const customProviders = new Map<string, RuntimeProviderSpec>();
const SLUG = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * Register a trusted local runtime provider. These run in-process (they need
 * networks/processes) and are loaded only from the local
 * `interview-os.runtimes.json` — never over HTTP.
 */
export function registerRuntimeProvider(spec: RuntimeProviderSpec): void {
  if (!SLUG.test(spec.kind)) {
    throw new Error(`invalid runtime provider kind "${spec.kind}"`);
  }
  if ((RUNTIME_KINDS as readonly string[]).includes(spec.kind)) {
    throw new Error(
      `runtime provider kind "${spec.kind}" collides with a built-in runtime`,
    );
  }
  if (typeof spec.create !== "function") {
    throw new Error(`runtime provider "${spec.kind}" must export create()`);
  }
  customProviders.set(spec.kind, spec);
}

export function registeredRuntimeProviders(): RuntimeProviderSpec[] {
  return [...customProviders.values()];
}

/** Built-ins + registered custom providers. */
export function allRuntimeKinds(): RuntimeKind[] {
  return [...RUNTIME_KINDS, ...customProviders.keys()];
}

export function isRuntimeKind(value: string): value is RuntimeKind {
  return allRuntimeKinds().includes(value);
}

export function workspaceDirFor(
  kind: RuntimeKind,
  env: NodeJS.ProcessEnv,
  override?: string,
): string {
  if (override) return path.resolve(override);
  const perProvider = env[`INTERVIEW_OS_${kind.toUpperCase()}_WORKSPACE`];
  if (perProvider) return path.resolve(perProvider);
  if (kind === "mock") return path.resolve(DEFAULT_WORKSPACE_DIR);
  return path.resolve(`data/${kind}-workspace`);
}

export function mockDelayMs(env: NodeJS.ProcessEnv): number {
  return Math.max(0, Number(env.INTERVIEW_OS_MOCK_DELAY_MS ?? 0) || 0);
}

/** Instantiate a provider in its own workspace dir (callers mkdir first). */
export async function instantiateProvider(
  kind: RuntimeKind,
  opts: { env: NodeJS.ProcessEnv; workspaceDir: string; logger?: Logger },
): Promise<AIRuntime> {
  const { env, workspaceDir, logger } = opts;
  const custom = customProviders.get(kind);
  if (custom) return custom.create({ env, workspaceDir, logger });
  switch (kind) {
    case "mock":
      return new MockRuntime({ chunkDelayMs: mockDelayMs(env) });
    case "claude":
      return new ClaudeCodeRuntime({ env, workspaceDir, logger });
    case "opencode":
      return new OpencodeRuntime({ env, workspaceDir, logger });
    case "devin":
      return new DevinRuntime({ env, workspaceDir, logger });
    default:
      return new CodexRuntime({ env, workspaceDir, logger });
  }
}

export type RuntimeHealthChecker = (
  env: NodeJS.ProcessEnv,
  workspaceDir: string,
) => Promise<RuntimeStatus>;

/** Per-provider detection probes — cheap (PATH scan + `--version`). */
export const HEALTH_CHECKERS: Record<string, RuntimeHealthChecker> = {
  codex: codexHealthCheck,
  claude: claudeHealthCheck,
  opencode: opencodeHealthCheck,
  devin: devinHealthCheck,
  mock: async (_env, workspaceDir) => ({
    runtime: "mock",
    available: true,
    workspace: workspaceDir,
    status: "ready",
    message: "deterministic mock",
  }),
};

/**
 * Load trusted local runtime providers from `interview-os.runtimes.json`
 * (`INTERVIEW_OS_RUNTIMES_CONFIG` overrides the path). Each entry names an ESM
 * module (absolute or relative to the config file) whose default export is a
 * RuntimeProviderSpec. This is the ONLY way providers are added — local config
 * like MCP, never HTTP. Returns loaded kinds + per-entry errors; a bad module
 * must not stop the server.
 */
export async function loadRuntimeProviders(
  configPath: string,
  logger?: Logger,
): Promise<{ loaded: string[]; errors: string[] }> {
  const loaded: string[] = [];
  const errors: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      errors.push(`cannot read ${configPath}: ${String(err).slice(0, 200)}`);
    }
    return { loaded, errors };
  }
  const entries = Array.isArray(raw) ? raw : (raw as { providers?: unknown[] })?.providers;
  if (!Array.isArray(entries)) {
    errors.push(`${configPath}: expected an array or { providers: [...] }`);
    return { loaded, errors };
  }
  const { pathToFileURL } = await import("node:url");
  for (const e of entries) {
    const kind = (e as { kind?: unknown })?.kind;
    const mod = (e as { module?: unknown })?.module;
    try {
      if (typeof kind !== "string" || typeof mod !== "string") {
        throw new Error("entries must be { kind, module }");
      }
      const modPath = path.isAbsolute(mod)
        ? mod
        : path.resolve(path.dirname(configPath), mod);
      const spec = (await import(pathToFileURL(modPath).href))?.default;
      registerRuntimeProvider({ ...(spec as object), kind } as RuntimeProviderSpec);
      loaded.push(kind);
    } catch (err) {
      const msg = `${String(kind ?? "?")}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
      errors.push(msg);
      logger?.warn("runtime.provider_load_failed", { error: msg });
    }
  }
  return { loaded, errors };
}

/** Probe for a kind: built-in checker, then the provider's own, else create+healthCheck. */
export function healthCheckerFor(kind: RuntimeKind): RuntimeHealthChecker {
  const custom = customProviders.get(kind);
  if (custom?.healthCheck) {
    return async (env, workspaceDir) => ({
      ...(await custom.healthCheck!(env, workspaceDir)),
      trustedLocal: true,
    });
  }
  if (custom) {
    return async (env, workspaceDir) => {
      const rt = await custom.create({ env, workspaceDir });
      try {
        return { ...(await rt.healthCheck()), trustedLocal: true };
      } finally {
        await rt.dispose().catch(() => {});
      }
    };
  }
  const checker = HEALTH_CHECKERS[kind];
  if (checker) return checker;
  return async (_env, workspaceDir) => ({
    runtime: kind,
    available: false,
    workspace: workspaceDir,
    status: "unavailable" as const,
    message: `unknown runtime "${kind}"`,
  });
}
