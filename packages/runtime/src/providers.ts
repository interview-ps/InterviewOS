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

export function isRuntimeKind(value: string): value is RuntimeKind {
  return (RUNTIME_KINDS as readonly string[]).includes(value);
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
export function instantiateProvider(
  kind: RuntimeKind,
  opts: { env: NodeJS.ProcessEnv; workspaceDir: string; logger?: Logger },
): AIRuntime {
  const { env, workspaceDir, logger } = opts;
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
export const HEALTH_CHECKERS: Record<RuntimeKind, RuntimeHealthChecker> = {
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
