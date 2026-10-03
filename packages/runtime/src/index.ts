import path from "node:path";
import fs from "node:fs/promises";
import { createLogger, type Logger } from "@interview-os/shared";
import type { AIRuntime, RuntimeKind } from "./interface/index.js";
import { MockRuntime } from "./mock/MockRuntime.js";
import { CodexRuntime } from "./codex/CodexRuntime.js";
import { ClaudeCodeRuntime } from "./claude/ClaudeCodeRuntime.js";
import { OpencodeRuntime } from "./opencode/OpencodeRuntime.js";
import { DevinRuntime } from "./devin/DevinRuntime.js";

export * from "./interface/index.js";
export { MockRuntime } from "./mock/MockRuntime.js";
export type { MockTaskHandler } from "./mock/MockRuntime.js";
export { launchSpec, spawnCommand, execFileSafe } from "./process/launch.js";
export { CodexRuntime } from "./codex/CodexRuntime.js";
export { CodexProcess } from "./codex/CodexProcess.js";
export { CodexProtocol } from "./codex/CodexProtocol.js";
export { CodexSessionManager } from "./codex/CodexSessionManager.js";
export { CodexExecAdapter } from "./codex/CodexExecAdapter.js";
export { CodexExecEventParser, parseExecLine } from "./codex/CodexEventParser.js";
export { codexHealthCheck, findCodexExecutable, getCodexVersion } from "./codex/detect.js";
export { buildChildEnv } from "./codex/childEnv.js";
export { ClaudeCodeRuntime } from "./claude/ClaudeCodeRuntime.js";
export { claudeHealthCheck, findClaudeExecutable, getClaudeVersion } from "./claude/detect.js";
export { buildClaudeChildEnv } from "./claude/childEnv.js";
export { OpencodeRuntime } from "./opencode/OpencodeRuntime.js";
export { opencodeHealthCheck, findOpencodeExecutable, getOpencodeVersion } from "./opencode/detect.js";
export { buildOpencodeChildEnv } from "./opencode/childEnv.js";
export { runOpencodeCli } from "./opencode/cli.js";
export type { OpencodeRunner, OpencodeRunResult } from "./opencode/cli.js";
export { DevinRuntime } from "./devin/DevinRuntime.js";
export { devinHealthCheck, findDevinExecutable, getDevinVersion } from "./devin/detect.js";
export { buildDevinChildEnv } from "./devin/childEnv.js";
export { runDevinCli } from "./devin/cli.js";
export type { DevinRunner, DevinRunResult } from "./devin/cli.js";

export interface CreateRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  logger?: Logger;
}

export const DEFAULT_WORKSPACE_DIR = path.resolve("data/codex-workspace");

const RUNTIME_KINDS: readonly RuntimeKind[] = ["codex", "mock", "claude", "opencode", "devin"];

function workspaceDirFor(kind: RuntimeKind, env: NodeJS.ProcessEnv, override?: string): string {
  if (override) return path.resolve(override);
  const perProvider = env[`INTERVIEW_OS_${kind.toUpperCase()}_WORKSPACE`];
  if (perProvider) return path.resolve(perProvider);
  if (kind === "mock") return path.resolve(DEFAULT_WORKSPACE_DIR);
  return path.resolve(`data/${kind}-workspace`);
}

/**
 * INTERVIEW_OS_RUNTIME=codex|mock|claude|opencode|devin (default codex). When the
 * selected provider is unavailable the runtime still reports via healthCheck;
 * it falls back to mock only when INTERVIEW_OS_RUNTIME_FALLBACK=mock.
 */
export async function createRuntime(opts: CreateRuntimeOptions = {}): Promise<AIRuntime> {
  const env = opts.env ?? process.env;
  const logger = opts.logger ?? createLogger({ level: "warn" });

  const rawKind = env.INTERVIEW_OS_RUNTIME ?? "codex";
  const kind: RuntimeKind = (RUNTIME_KINDS as readonly string[]).includes(rawKind)
    ? (rawKind as RuntimeKind)
    : "codex";
  const workspaceDir = workspaceDirFor(kind, env, opts.workspaceDir);
  await fs.mkdir(workspaceDir, { recursive: true });

  const mockDelayMs = Math.max(0, Number(env.INTERVIEW_OS_MOCK_DELAY_MS ?? 0) || 0);

  if (kind === "mock") {
    return new MockRuntime({ chunkDelayMs: mockDelayMs });
  }

  const runtime: AIRuntime =
    kind === "claude"
      ? new ClaudeCodeRuntime({ env, workspaceDir, logger })
      : kind === "opencode"
        ? new OpencodeRuntime({ env, workspaceDir, logger })
        : kind === "devin"
          ? new DevinRuntime({ env, workspaceDir, logger })
          : new CodexRuntime({ env, workspaceDir, logger });

  const status = await runtime.healthCheck();
  if (!status.available) {
    if (env.INTERVIEW_OS_RUNTIME_FALLBACK === "mock") {
      logger.warn("runtime.unavailable_fallback", {
        runtime: kind,
        message: status.message,
        fallback: "mock",
      });
      return new MockRuntime({ chunkDelayMs: mockDelayMs });
    }
    logger.warn("runtime.unavailable", {
      runtime: kind,
      message: status.message,
    });
  }
  return runtime;
}
