import { randomUUID } from "node:crypto";
import type { Logger } from "@interview-os/core";
import {
  RuntimeError,
  validateModelAndEffort,
  type AgentEvent,
  type AgentResult,
  type AgentTask,
  type AIRuntime,
  type ModelInfo,
  type RuntimeEvent,
  type RuntimeMessage,
  type RuntimeSession,
  type RuntimeStatus,
  type SessionInput,
} from "../interface/index.js";
import { CLAUDE_SETUP_MESSAGE, claudeHealthCheck, findClaudeExecutable } from "./detect.js";
import { buildClaudeChildEnv } from "./childEnv.js";
import { realClaudeSdk, type ClaudeSdk, type ClaudeSdkMessage } from "./sdk.js";

export const DEFAULT_TASK_TIMEOUT_MS = 120_000;

const DEFAULT_MODELS: ModelInfo[] = [
  { id: "default", displayName: "Default", supportedReasoningEfforts: [], defaultReasoningEffort: null, isDefault: true },
  { id: "sonnet", displayName: "Sonnet", supportedReasoningEfforts: [], defaultReasoningEffort: null },
  { id: "opus", displayName: "Opus", supportedReasoningEfforts: [], defaultReasoningEffort: null },
  { id: "haiku", displayName: "Haiku", supportedReasoningEfforts: [], defaultReasoningEffort: null },
];

export interface ClaudeRuntimeOptions {
  env: NodeJS.ProcessEnv;
  workspaceDir: string;
  logger?: Logger;
  /** Test-only SDK injection. */
  sdk?: ClaudeSdk;
  /** Test-only escape hatch: additional env keys/prefixes forwarded to children. */
  extraChildEnv?: { keys?: string[]; prefixes?: string[] };
}

interface ClaudeThread {
  session: RuntimeSession;
}

function resultText(message: ClaudeSdkMessage & { type: "result" }): string {
  return typeof (message as { result?: unknown }).result === "string"
    ? ((message as { result: string }).result)
    : "";
}

/**
 * Turn an opaque SDK/transport error into a typed, actionable RuntimeError.
 * A missing binary is a setup problem (UNAVAILABLE); a fetch/timeout failure is
 * reported with the step so the user can tell *where* the run broke.
 */
function asRuntimeError(err: unknown, step: string, timeoutMs: number, aborted: boolean): RuntimeError {
  if (err instanceof RuntimeError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (aborted || /timeout|aborted/i.test(message)) {
    return new RuntimeError("TIMEOUT", `claude ${step} timed out after ${timeoutMs}ms`);
  }
  if (/ENOENT|not found|spawn .*EINVAL/i.test(message)) {
    return new RuntimeError("UNAVAILABLE", `could not launch the Claude Code CLI while ${step}: ${message}`);
  }
  if (/fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|getaddrinfo/i.test(message)) {
    return new RuntimeError(
      "CRASHED",
      `claude ${step} failed to reach the model API: ${message}. Check network access and \`claude\` login.`,
    );
  }
  return new RuntimeError("CRASHED", `claude ${step} failed: ${message}`);
}

/**
 * `AIRuntime` backed by the Claude Agent SDK. Structured tasks use the SDK's
 * `outputFormat: { type: "json_schema" }`. Sessions are one-shot wrappers: each
 * turn runs a fresh query across a local opaque `threadId` (no server-side
 * resume).
 */
export class ClaudeCodeRuntime implements AIRuntime {
  readonly kind = "claude" as const;
  private readonly opts: ClaudeRuntimeOptions;
  private readonly sdk: ClaudeSdk;
  private readonly timeoutMs: number;
  private readonly threads = new Map<string, ClaudeThread>();

  constructor(opts: ClaudeRuntimeOptions) {
    this.opts = opts;
    this.sdk = opts.sdk ?? realClaudeSdk;
    this.timeoutMs =
      Number(opts.env.INTERVIEW_OS_CLAUDE_TIMEOUT_MS) > 0
        ? Number(opts.env.INTERVIEW_OS_CLAUDE_TIMEOUT_MS)
        : DEFAULT_TASK_TIMEOUT_MS;
  }

  async healthCheck(): Promise<RuntimeStatus> {
    return claudeHealthCheck(this.opts.env, this.opts.workspaceDir);
  }

  private baseOptions(instructions: string, model?: string | null): Record<string, unknown> {
    return {
      cwd: this.opts.workspaceDir,
      env: buildClaudeChildEnv(this.opts.env, this.opts.extraChildEnv),
      permissionMode: "dontAsk" as const,
      allowedTools: [] as string[],
      settingSources: [] as string[],
      systemPrompt: instructions,
      ...(model ? { model } : {}),
    };
  }

  async runTask(task: AgentTask): Promise<AgentResult> {
    const started = Date.now();
    const invalid = validateModelAndEffort(task.model, task.effort);
    if (invalid) {
      return { ok: false, error: invalid, durationMs: 0, events: [] };
    }
    const bin = await findClaudeExecutable(this.opts.env);
    if (!bin) {
      return {
        ok: false,
        error: new RuntimeError("UNAVAILABLE", CLAUDE_SETUP_MESSAGE),
        durationMs: Date.now() - started,
        events: [],
      };
    }
    const events: AgentEvent[] = [{ type: "started" }];
    task.onEvent?.({ type: "started" });
    const controller = new AbortController();
    const timeoutMs = task.timeoutMs ?? this.timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let step = "starting the task";
    try {
      let result: { structured?: unknown; text?: string } | undefined;
      step = "waiting for the model response";
      const stream = this.sdk.query({
        prompt: `${task.instructions}\n\nInput (JSON):\n${JSON.stringify(task.input)}`,
        options: {
          ...this.baseOptions(task.instructions, task.model),
          pathToClaudeCodeExecutable: bin,
          abortController: controller,
          outputFormat: { type: "json_schema" as const, schema: task.outputSchema },
        },
      });
      for await (const message of stream) {
        if (message.type === "result") {
          const rText = resultText(message);
          if (message.is_error) {
            const error = new RuntimeError(
              "CRASHED",
              `claude ${step} failed: ${rText || "the model reported an error"}`,
            );
            this.opts.logger?.warn("runtime.provider_error", {
              runtime: "claude",
              taskId: task.taskId,
              step,
              detail: rText.slice(0, 300),
            });
            return {
              ok: false,
              error,
              raw: rText,
              durationMs: Date.now() - started,
              events,
            };
          }
          result = {
            structured: (message as { structured_output?: unknown }).structured_output,
            text: rText,
          };
        }
      }
      if (controller.signal.aborted) {
        return {
          ok: false,
          error: new RuntimeError("TIMEOUT", `claude task timed out after ${timeoutMs}ms`),
          durationMs: Date.now() - started,
          events,
        };
      }
      if (!result) {
        return {
          ok: false,
          error: new RuntimeError("MALFORMED_EVENT", "claude stream ended without a result"),
          durationMs: Date.now() - started,
          events,
        };
      }
      const raw = result.structured !== undefined ? JSON.stringify(result.structured) : (result.text ?? "");
      events.push({ type: "completed", output: result.structured, raw });
      task.onEvent?.({ type: "completed", output: result.structured, raw });
      return {
        ok: true,
        output: result.structured,
        raw,
        durationMs: Date.now() - started,
        events,
      };
    } catch (err) {
      const error = asRuntimeError(err, step, timeoutMs, controller.signal.aborted);
      this.opts.logger?.warn("runtime.task_failed", {
        runtime: "claude",
        taskId: task.taskId,
        step,
        code: error.code,
        message: error.message,
      });
      return { ok: false, error, durationMs: Date.now() - started, events };
    } finally {
      clearTimeout(timer);
    }
  }

  async createSession(_input: SessionInput): Promise<RuntimeSession> {
    const bin = await findClaudeExecutable(this.opts.env);
    if (!bin) throw new RuntimeError("UNAVAILABLE", CLAUDE_SETUP_MESSAGE);
    const threadId = randomUUID();
    const session: RuntimeSession = { id: randomUUID(), threadId };
    this.threads.set(session.id, { session });
    return session;
  }

  async resumeSession(threadId: string, _input: SessionInput): Promise<RuntimeSession> {
    const bin = await findClaudeExecutable(this.opts.env);
    if (!bin) throw new RuntimeError("UNAVAILABLE", CLAUDE_SETUP_MESSAGE);
    for (const thread of this.threads.values()) {
      if (thread.session.threadId === threadId) return thread.session;
    }
    const session: RuntimeSession = { id: randomUUID(), threadId };
    this.threads.set(session.id, { session });
    return session;
  }

  async *sendMessage(sessionId: string, msg: RuntimeMessage): AsyncIterable<RuntimeEvent> {
    const thread = this.threads.get(sessionId);
    if (!thread) {
      yield { type: "error", error: new RuntimeError("PROTOCOL", `unknown claude session "${sessionId}"`) };
      return;
    }
    const invalid = validateModelAndEffort(msg.model, msg.effort);
    if (invalid) {
      yield { type: "error", error: invalid };
      return;
    }
    // One-shot transport: each turn is a fresh query carrying the full prompt
    // (the caller already includes prior context). No server-side resume.
    yield { type: "started" };
    const result = await this.runTask({
      taskId: msg.taskId ?? "session-turn",
      instructions: msg.text,
      input: msg.input ?? {},
      outputSchema: msg.outputSchema ?? { type: "object" },
      model: msg.model,
      effort: msg.effort,
    });
    if (result.ok) {
      yield { type: "completed", output: result.output, raw: result.raw };
    } else {
      this.opts.logger?.warn("runtime.turn_failed", {
        runtime: "claude",
        sessionId,
        code: result.error.code,
        message: result.error.message,
      });
      yield { type: "error", error: result.error };
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    this.threads.delete(sessionId);
  }

  async listModels(): Promise<ModelInfo[]> {
    const bin = await findClaudeExecutable(this.opts.env);
    if (!bin) return DEFAULT_MODELS;
    try {
      const stream = this.sdk.query({
        prompt: "",
        options: { ...this.baseOptions(""), pathToClaudeCodeExecutable: bin, maxTurns: 0 },
      });
      const models = await stream.supportedModels();
      if (!models || models.length === 0) return DEFAULT_MODELS;
      return models.map((m, index) => ({
        id: m.value,
        displayName: m.displayName || m.value,
        supportedReasoningEfforts: m.supportedEffortLevels ?? [],
        defaultReasoningEffort: null,
        isDefault: index === 0,
      }));
    } catch {
      return DEFAULT_MODELS;
    }
  }

  async dispose(): Promise<void> {
    this.threads.clear();
  }
}
