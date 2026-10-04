import type { Logger } from "@interview-os/core";
import type { AIRuntime } from "./interface/index.js";
import {
  RuntimeManager,
  type RuntimeFactory,
  type RuntimeManagerOptions,
} from "./manager.js";

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
export { RuntimeManager } from "./manager.js";
export type { RuntimeManagerOptions, RuntimeFactory } from "./manager.js";
export {
  RUNTIME_KINDS,
  DEFAULT_WORKSPACE_DIR,
  HEALTH_CHECKERS,
  allRuntimeKinds,
  healthCheckerFor,
  isRuntimeKind,
  loadRuntimeProviders,
  registerRuntimeProvider,
  registeredRuntimeProviders,
  workspaceDirFor,
} from "./providers.js";
export type { RuntimeHealthChecker, RuntimeProviderSpec } from "./providers.js";

export interface CreateRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  logger?: Logger;
  /**
   * Saved UI selection (`runtimeKind` setting). Only consulted when
   * `INTERVIEW_OS_RUNTIME` is unset — the env var always wins.
   */
  preferredKind?: string | null;
  /** Fires for the initial runtime and every switch. */
  onSwitch?: (runtime: AIRuntime) => void;
  /** Test seams. */
  factory?: RuntimeFactory;
  healthCheckers?: RuntimeManagerOptions["healthCheckers"];
}

/**
 * INTERVIEW_OS_RUNTIME=codex|mock|claude|opencode|devin (default codex), or the
 * persisted `preferredKind` when the env var is unset. Returns a RuntimeManager
 * so the active provider can be swapped later (`PUT /api/runtime`). When the
 * selected provider is unavailable the runtime still reports via healthCheck;
 * it falls back to mock only when INTERVIEW_OS_RUNTIME_FALLBACK=mock.
 */
export async function createRuntime(
  opts: CreateRuntimeOptions = {},
): Promise<RuntimeManager> {
  return RuntimeManager.create({
    env: opts.env ?? process.env,
    logger: opts.logger,
    workspaceDir: opts.workspaceDir,
    preferredKind: opts.preferredKind,
    onSwitch: opts.onSwitch,
    factory: opts.factory,
    healthCheckers: opts.healthCheckers,
  });
}
