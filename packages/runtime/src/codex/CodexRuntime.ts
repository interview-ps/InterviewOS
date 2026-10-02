import fs from "node:fs/promises";
import type { Logger } from "@interview-os/shared";
import {
  RuntimeError,
  type AgentResult,
  type AgentTask,
  type AIRuntime,
  type RuntimeEvent,
  type RuntimeMessage,
  type RuntimeSession,
  type RuntimeStatus,
  type SessionInput,
} from "../interface/index.js";
import { CodexExecAdapter, DEFAULT_TASK_TIMEOUT_MS } from "./CodexExecAdapter.js";
import { CodexProcess } from "./CodexProcess.js";
import { CodexSessionManager } from "./CodexSessionManager.js";
import { codexHealthCheck, findCodexExecutable } from "./detect.js";

export interface CodexRuntimeOptions {
  env: NodeJS.ProcessEnv;
  workspaceDir: string;
  logger?: Logger;
  /** Test-only escape hatch: additional env keys/prefixes forwarded to children. */
  extraChildEnv?: { keys?: string[]; prefixes?: string[] };
}

export class CodexRuntime implements AIRuntime {
  readonly kind = "codex" as const;
  private readonly opts: CodexRuntimeOptions;
  private readonly timeoutMs: number;
  private proc: CodexProcess | null = null;
  private sessions: CodexSessionManager | null = null;

  constructor(opts: CodexRuntimeOptions) {
    this.opts = opts;
    this.timeoutMs =
      Number(opts.env.INTERVIEW_OS_CODEX_TIMEOUT_MS) > 0
        ? Number(opts.env.INTERVIEW_OS_CODEX_TIMEOUT_MS)
        : DEFAULT_TASK_TIMEOUT_MS;
  }

  async healthCheck(): Promise<RuntimeStatus> {
    return codexHealthCheck(this.opts.env, this.opts.workspaceDir);
  }

  async runTask(task: AgentTask): Promise<AgentResult> {
    const started = Date.now();
    const bin = await findCodexExecutable(this.opts.env);
    if (!bin) {
      return {
        ok: false,
        error: new RuntimeError(
          "UNAVAILABLE",
          "Codex CLI not found. Install: npm i -g @openai/codex, then run `codex login`.",
        ),
        durationMs: Date.now() - started,
        events: [],
      };
    }
    await fs.mkdir(this.opts.workspaceDir, { recursive: true });
    const adapter = new CodexExecAdapter({
      bin,
      workspaceDir: this.opts.workspaceDir,
      env: this.opts.env,
      defaultTimeoutMs: this.timeoutMs,
      extraChildEnv: this.opts.extraChildEnv,
    });
    return adapter.runTask(task);
  }

  async createSession(input: SessionInput): Promise<RuntimeSession> {
    const bin = await findCodexExecutable(this.opts.env);
    if (!bin) {
      throw new RuntimeError(
        "UNAVAILABLE",
        "Codex CLI not found. Install: npm i -g @openai/codex, then run `codex login`.",
      );
    }
    await fs.mkdir(this.opts.workspaceDir, { recursive: true });
    const mgr = this.sessionManagerFor(bin);
    return mgr.createSession(input);
  }

  async resumeSession(threadId: string, input: SessionInput): Promise<RuntimeSession> {
    const bin = await findCodexExecutable(this.opts.env);
    if (!bin) {
      throw new RuntimeError("UNAVAILABLE", "Codex CLI not found");
    }
    await fs.mkdir(this.opts.workspaceDir, { recursive: true });
    const mgr = this.sessionManagerFor(bin);
    return mgr.resumeSession(threadId, input);
  }

  private sessionManagerFor(bin: string): CodexSessionManager {
    if (!this.sessions) {
      this.proc = new CodexProcess({
        bin,
        workspaceDir: this.opts.workspaceDir,
        env: this.opts.env,
        extraChildEnv: this.opts.extraChildEnv,
      });
      this.sessions = new CodexSessionManager(this.proc, {
        workspaceDir: this.opts.workspaceDir,
        turnTimeoutMs: this.timeoutMs,
      });
    }
    return this.sessions;
  }

  sendMessage(sessionId: string, msg: RuntimeMessage): AsyncIterable<RuntimeEvent> {
    const mgr = this.sessions;
    if (!mgr) {
      return (async function* () {
        yield {
          type: "error",
          error: new RuntimeError("PROTOCOL", `unknown session "${sessionId}"`),
        } satisfies RuntimeEvent;
      })();
    }
    return mgr.sendMessage(sessionId, msg);
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.sessions?.closeSession(sessionId);
  }

  async dispose(): Promise<void> {
    await this.proc?.close();
    this.proc = null;
    this.sessions = null;
  }
}
