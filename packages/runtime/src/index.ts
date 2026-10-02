import path from "node:path";
import fs from "node:fs/promises";
import { createLogger, type Logger } from "@interview-os/shared";
import type { AIRuntime } from "./interface/index.js";
import { MockRuntime } from "./mock/MockRuntime.js";
import { CodexRuntime } from "./codex/CodexRuntime.js";

export * from "./interface/index.js";
export { MockRuntime } from "./mock/MockRuntime.js";
export type { MockTaskHandler } from "./mock/MockRuntime.js";
export { CodexRuntime } from "./codex/CodexRuntime.js";
export { CodexProcess } from "./codex/CodexProcess.js";
export { CodexProtocol } from "./codex/CodexProtocol.js";
export { CodexSessionManager } from "./codex/CodexSessionManager.js";
export { CodexExecAdapter } from "./codex/CodexExecAdapter.js";
export { CodexExecEventParser, parseExecLine } from "./codex/CodexEventParser.js";
export { codexHealthCheck, findCodexExecutable, getCodexVersion } from "./codex/detect.js";
export { buildChildEnv } from "./codex/childEnv.js";

export interface CreateRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  logger?: Logger;
}

export const DEFAULT_WORKSPACE_DIR = path.resolve("data/codex-workspace");

/**
 * INTERVIEW_OS_RUNTIME=mock|codex (default codex). When Codex is unavailable the
 * runtime still reports via healthCheck; it falls back to mock only when
 * INTERVIEW_OS_RUNTIME_FALLBACK=mock.
 */
export async function createRuntime(opts: CreateRuntimeOptions = {}): Promise<AIRuntime> {
  const env = opts.env ?? process.env;
  const workspaceDir = path.resolve(opts.workspaceDir ?? DEFAULT_WORKSPACE_DIR);
  const logger = opts.logger ?? createLogger({ level: "warn" });
  await fs.mkdir(workspaceDir, { recursive: true });

  const mockDelayMs = Math.max(0, Number(env.INTERVIEW_OS_MOCK_DELAY_MS ?? 0) || 0);

  const kind = env.INTERVIEW_OS_RUNTIME ?? "codex";
  if (kind === "mock") {
    return new MockRuntime({ chunkDelayMs: mockDelayMs });
  }

  const runtime = new CodexRuntime({ env, workspaceDir, logger });
  const status = await runtime.healthCheck();
  if (!status.available) {
    if (env.INTERVIEW_OS_RUNTIME_FALLBACK === "mock") {
      logger.warn("runtime.unavailable_fallback", {
        runtime: "codex",
        message: status.message,
        fallback: "mock",
      });
      return new MockRuntime({ chunkDelayMs: mockDelayMs });
    }
    logger.warn("runtime.unavailable", {
      runtime: "codex",
      message: status.message,
    });
  }
  return runtime;
}
