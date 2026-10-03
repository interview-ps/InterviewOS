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
import { DEVIN_SETUP_MESSAGE, devinHealthCheck, findDevinExecutable } from "./detect.js";
import { runDevinCli, type DevinRunner } from "./cli.js";

export const DEFAULT_TASK_TIMEOUT_MS = 120_000;

/** Model family aliases accepted by `devin --model` (see `devin docs`: models). */
const DEFAULT_MODELS: ModelInfo[] = [
  { id: "adaptive", displayName: "Adaptive (auto)", supportedReasoningEfforts: [], defaultReasoningEffort: null, isDefault: true },
  { id: "swe", displayName: "SWE (latest)", supportedReasoningEfforts: [], defaultReasoningEffort: null },
  { id: "opus", displayName: "Opus (latest)", supportedReasoningEfforts: [], defaultReasoningEffort: null },
  { id: "sonnet", displayName: "Sonnet (latest)", supportedReasoningEfforts: [], defaultReasoningEffort: null },
  { id: "gpt", displayName: "GPT (latest)", supportedReasoningEfforts: [], defaultReasoningEffort: null },
  { id: "codex", displayName: "Codex (latest)", supportedReasoningEfforts: [], defaultReasoningEffort: null },
  { id: "gemini", displayName: "Gemini (latest)", supportedReasoningEfforts: [], defaultReasoningEffort: null },
];

export interface DevinRuntimeOptions {
  env: NodeJS.ProcessEnv;
  workspaceDir: string;
  logger?: Logger;
  /** Test-only: run the CLI without spawning it. */
  runner?: DevinRunner;
}

interface DevinThread {
  session: RuntimeSession;
}

/** Strip a leading/trailing markdown code fence if the model wrapped its JSON. */
function stripFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? trimmed;
}

function asRuntimeError(err: unknown, step: string): RuntimeError {
  if (err instanceof RuntimeError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (/timeout|aborted/i.test(message)) {
    return new RuntimeError("TIMEOUT", `devin ${step} timed out`);
  }
  if (/ENOENT|not found|EINVAL/i.test(message)) {
    return new RuntimeError("UNAVAILABLE", `could not launch the Devin CLI while ${step}: ${message}`);
  }
  return new RuntimeError("CRASHED", `devin ${step} failed: ${message}`);
}

/** Tolerant parse of `devin models list --format json` (newer CLI versions). */
function parseModelsJson(stdout: string): ModelInfo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const ids = new Set<string>();
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      if (/^[A-Za-z0-9._:-]{1,128}$/.test(value)) ids.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      const id = obj.id ?? obj.slug ?? obj.name ?? obj.model;
      if (typeof id === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(id)) ids.add(id);
      else for (const v of Object.values(obj)) visit(v);
    }
  };
  visit(parsed);
  return [...ids].map((id) => ({
    id,
    displayName: id,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null,
  }));
}

/**
 * `AIRuntime` backed by one-shot `devin -p --prompt-file <file>` invocations.
 * Each task is a fresh process — there is no long-lived server to manage.
 * `-p` prints only the assistant response on stdout; structured output is the
 * model's JSON reply, validated upstream by `runStructured`. Sessions are
 * local one-shot wrappers (no server-side resume), like claude/opencode.
 */
export class DevinRuntime implements AIRuntime {
  readonly kind = "devin" as const;
  private readonly opts: DevinRuntimeOptions;
  private readonly timeoutMs: number;
  private readonly threads = new Map<string, DevinThread>();

  constructor(opts: DevinRuntimeOptions) {
    this.opts = opts;
    this.timeoutMs =
      Number(opts.env.INTERVIEW_OS_DEVIN_TIMEOUT_MS) > 0
        ? Number(opts.env.INTERVIEW_OS_DEVIN_TIMEOUT_MS)
        : DEFAULT_TASK_TIMEOUT_MS;
  }

  async healthCheck(): Promise<RuntimeStatus> {
    return devinHealthCheck(this.opts.env, this.opts.workspaceDir);
  }

  private async run(
    task: Pick<AgentTask, "taskId" | "instructions" | "input" | "model" | "timeoutMs" | "onEvent"> & {
      outputSchema?: unknown;
      prompt?: string;
    },
  ): Promise<AgentResult> {
    const started = Date.now();
    const invalid = validateModelAndEffort(task.model ?? null, null);
    if (invalid) return { ok: false, error: invalid, durationMs: 0, events: [] };

    const bin = await findDevinExecutable(this.opts.env);
    if (!bin) {
      return {
        ok: false,
        error: new RuntimeError("UNAVAILABLE", DEVIN_SETUP_MESSAGE),
        durationMs: Date.now() - started,
        events: [],
      };
    }

    const prompt =
      task.prompt ??
      [
        task.instructions,
        "",
        "You are a data-extraction function, not a coding assistant. Do NOT use tools, read files, or ask questions.",
        "Reply with ONLY a single JSON value that conforms to this JSON Schema, with no prose and no markdown fences:",
        JSON.stringify(task.outputSchema ?? {}),
        "",
        "Input (JSON):",
        JSON.stringify(task.input),
      ].join("\n");

    const args = ["-p"];
    if (task.model) args.unshift("--model", task.model);

    const timeoutMs = task.timeoutMs ?? this.timeoutMs;
    const events: AgentEvent[] = [{ type: "started" }];
    task.onEvent?.({ type: "started" });
    const step = "running the task";
    try {
      const result = await runDevinCli({
        bin,
        env: this.opts.env,
        workspaceDir: this.opts.workspaceDir,
        args,
        prompt: `${prompt}\n`,
        timeoutMs,
        runner: this.opts.runner,
      });

      if (result.code === null) {
        return {
          ok: false,
          error: new RuntimeError("TIMEOUT", `devin did not finish within ${timeoutMs}ms`),
          durationMs: Date.now() - started,
          events,
        };
      }
      if (result.code !== 0) {
        const detail = result.stderr.trim().replace(/^Error:\s*/i, "").slice(0, 300);
        return {
          ok: false,
          error: new RuntimeError(
            "CRASHED",
            `devin exited with code ${result.code}${detail ? `: ${detail}` : ""}`,
          ),
          raw: result.stdout,
          durationMs: Date.now() - started,
          events,
        };
      }

      const text = result.stdout.trim();
      if (!text) {
        return {
          ok: false,
          error: new RuntimeError("MALFORMED_OUTPUT", "devin produced no output"),
          raw: result.stdout,
          durationMs: Date.now() - started,
          events,
        };
      }

      const raw = stripFence(text);
      let output: unknown;
      try {
        output = JSON.parse(raw);
      } catch {
        return {
          ok: false,
          error: new RuntimeError("MALFORMED_OUTPUT", "devin output was not valid JSON"),
          raw,
          durationMs: Date.now() - started,
          events,
        };
      }
      const completed: AgentEvent = { type: "completed", output, raw };
      events.push(completed);
      task.onEvent?.({ type: "completed", output, raw });
      return {
        ok: true,
        output,
        raw,
        durationMs: Date.now() - started,
        events,
      };
    } catch (err) {
      const error = asRuntimeError(err, step);
      this.opts.logger?.warn("runtime.task_failed", {
        runtime: "devin",
        taskId: task.taskId,
        step,
        code: error.code,
        message: error.message,
      });
      return { ok: false, error, durationMs: Date.now() - started, events };
    }
  }

  async runTask(task: AgentTask): Promise<AgentResult> {
    return this.run(task);
  }

  async createSession(_input: SessionInput): Promise<RuntimeSession> {
    // One-shot transport: a devin session is a local handle; each turn runs
    // the full prompt anew, so no server-side session is created or resumed.
    const threadId = randomUUID();
    const session: RuntimeSession = { id: randomUUID(), threadId };
    this.threads.set(session.id, { session });
    return session;
  }

  async resumeSession(threadId: string, _input: SessionInput): Promise<RuntimeSession> {
    const session: RuntimeSession = { id: randomUUID(), threadId };
    this.threads.set(session.id, { session });
    return session;
  }

  async *sendMessage(sessionId: string, msg: RuntimeMessage): AsyncIterable<RuntimeEvent> {
    const thread = this.threads.get(sessionId);
    if (!thread) {
      yield { type: "error", error: new RuntimeError("PROTOCOL", `unknown devin session "${sessionId}"`) };
      return;
    }
    const invalid = validateModelAndEffort(msg.model, msg.effort);
    if (invalid) {
      yield { type: "error", error: invalid };
      return;
    }
    yield { type: "started" };
    const result = await this.run({
      taskId: msg.taskId ?? "session-turn",
      instructions: msg.text,
      input: msg.input ?? {},
      model: msg.model,
      prompt: msg.text,
    });
    if (result.ok) {
      yield { type: "completed", output: result.output, raw: result.raw };
    } else {
      this.opts.logger?.warn("runtime.turn_failed", {
        runtime: "devin",
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
    const bin = await findDevinExecutable(this.opts.env);
    if (!bin) return DEFAULT_MODELS;
    try {
      const result = await runDevinCli({
        bin,
        env: this.opts.env,
        workspaceDir: this.opts.workspaceDir,
        args: ["models", "list", "--format", "json"],
        timeoutMs: 30_000,
        runner: this.opts.runner,
      });
      if (result.code !== 0) return DEFAULT_MODELS;
      const models = parseModelsJson(result.stdout);
      return models.length > 0 ? models : DEFAULT_MODELS;
    } catch (err) {
      this.opts.logger?.warn("runtime.list_models_failed", {
        runtime: "devin",
        message: err instanceof Error ? err.message : String(err),
      });
      return DEFAULT_MODELS;
    }
  }

  async dispose(): Promise<void> {
    this.threads.clear();
  }
}
