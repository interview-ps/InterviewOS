import fs from "node:fs/promises";
import { createLogger, type Logger } from "@interview-os/shared";
import {
  RuntimeError,
  type AgentResult,
  type AgentTask,
  type AIRuntime,
  type ModelInfo,
  type RuntimeEvent,
  type RuntimeKind,
  type RuntimeMessage,
  type RuntimeSession,
  type RuntimeStatus,
  type SessionInput,
} from "./interface/index.js";
import {
  HEALTH_CHECKERS,
  RUNTIME_KINDS,
  instantiateProvider,
  isRuntimeKind,
  workspaceDirFor,
  type RuntimeHealthChecker,
} from "./providers.js";

export type RuntimeFactory = (
  kind: RuntimeKind,
  opts: { env: NodeJS.ProcessEnv; workspaceDir: string; logger: Logger },
) => AIRuntime | Promise<AIRuntime>;

export interface RuntimeManagerOptions {
  env: NodeJS.ProcessEnv;
  logger?: Logger;
  workspaceDir?: string;
  /**
   * Saved UI selection (`runtimeKind` setting). Only consulted when
   * `INTERVIEW_OS_RUNTIME` is unset — the env var always wins.
   */
  preferredKind?: string | null;
  /**
   * Fires for the initial runtime and every `switchTo` delegate. Use it for
   * provider-specific setup the server owns (e.g. `registerMockHandlers`).
   */
  onSwitch?: (runtime: AIRuntime) => void;
  /** Test seam: build delegates without spawning real providers. */
  factory?: RuntimeFactory;
  /** Test seam: override per-provider detection probes. */
  healthCheckers?: Partial<Record<RuntimeKind, RuntimeHealthChecker>>;
}

async function instantiate(
  opts: RuntimeManagerOptions,
  kind: RuntimeKind,
): Promise<AIRuntime> {
  const logger = opts.logger ?? createLogger({ level: "warn" });
  const workspaceDir = workspaceDirFor(kind, opts.env, opts.workspaceDir);
  if (opts.factory) {
    return opts.factory(kind, { env: opts.env, workspaceDir, logger });
  }
  await fs.mkdir(workspaceDir, { recursive: true });
  return instantiateProvider(kind, { env: opts.env, workspaceDir, logger });
}

/**
 * A switchable `AIRuntime`: delegates every call to the currently selected
 * provider and can swap it at runtime (Settings UI → `PUT /api/runtime`).
 * Orchestrator and server hold the single manager instance, so switching needs
 * no rewiring. Selection precedence: `INTERVIEW_OS_RUNTIME` env > `preferredKind`
 * (the persisted `runtimeKind` setting) > `codex`.
 *
 * Sessions do not migrate across a switch: the old delegate is disposed, and
 * its live threads die. Interview sessions rehydrate through `resumeSession`
 * on the new provider (local-wrapper providers replay full context anyway).
 */
export class RuntimeManager implements AIRuntime {
  private current: AIRuntime;
  private disposed = false;

  private constructor(
    private readonly opts: RuntimeManagerOptions,
    initial: AIRuntime,
  ) {
    this.current = initial;
  }

  static async create(opts: RuntimeManagerOptions): Promise<RuntimeManager> {
    const env = opts.env;
    const logger = opts.logger ?? createLogger({ level: "warn" });
    const rawKind = env.INTERVIEW_OS_RUNTIME ?? opts.preferredKind ?? "codex";
    const kind = isRuntimeKind(rawKind) ? (rawKind as RuntimeKind) : "codex";

    let runtime = await instantiate(opts, kind);
    const status = await runtime.healthCheck();
    if (!status.available) {
      if (env.INTERVIEW_OS_RUNTIME_FALLBACK === "mock" && kind !== "mock") {
        logger.warn("runtime.unavailable_fallback", {
          runtime: kind,
          message: status.message,
          fallback: "mock",
        });
        await runtime.dispose();
        runtime = await instantiate(opts, "mock");
      } else {
        logger.warn("runtime.unavailable", {
          runtime: kind,
          message: status.message,
        });
      }
    }
    const manager = new RuntimeManager(opts, runtime);
    opts.onSwitch?.(runtime);
    return manager;
  }

  get kind(): RuntimeKind {
    return this.current.kind;
  }

  /** Swap the delegate and health-check it. The choice is kept even when the
   * provider is unavailable — the returned status carries the setup hint. */
  async switchTo(kind: RuntimeKind): Promise<RuntimeStatus> {
    if (this.disposed) {
      throw new RuntimeError("UNAVAILABLE", "runtime manager is disposed");
    }
    const next = await instantiate(this.opts, kind);
    const status = await next.healthCheck();
    const prev = this.current;
    this.current = next;
    this.opts.onSwitch?.(next);
    if (prev !== next) await prev.dispose();
    if (!status.available) {
      this.opts.logger?.warn("runtime.unavailable", {
        runtime: kind,
        message: status.message,
      });
    }
    return status;
  }

  /** Probe every provider's detect path in parallel (PATH scan + `--version`). */
  async probeAll(): Promise<RuntimeStatus[]> {
    return Promise.all(
      RUNTIME_KINDS.map(async (kind) => {
        const checker = this.opts.healthCheckers?.[kind] ?? HEALTH_CHECKERS[kind];
        const workspaceDir = workspaceDirFor(
          kind,
          this.opts.env,
          kind === this.current.kind ? this.opts.workspaceDir : undefined,
        );
        try {
          return await checker(this.opts.env, workspaceDir);
        } catch (err) {
          return {
            runtime: kind,
            available: false,
            workspace: workspaceDir,
            status: "error" as const,
            message: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
  }

  healthCheck(): Promise<RuntimeStatus> {
    return this.current.healthCheck();
  }
  runTask(task: AgentTask): Promise<AgentResult> {
    return this.current.runTask(task);
  }
  createSession(input: SessionInput): Promise<RuntimeSession> {
    return this.current.createSession(input);
  }
  resumeSession(threadId: string, input: SessionInput): Promise<RuntimeSession> {
    return this.current.resumeSession(threadId, input);
  }
  sendMessage(sessionId: string, msg: RuntimeMessage): AsyncIterable<RuntimeEvent> {
    return this.current.sendMessage(sessionId, msg);
  }
  closeSession(sessionId: string): Promise<void> {
    return this.current.closeSession(sessionId);
  }
  listModels(): Promise<ModelInfo[]> {
    return this.current.listModels();
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.current.dispose();
  }
}
