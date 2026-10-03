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
import { OPENCODE_SETUP_MESSAGE, findOpencodeExecutable, opencodeHealthCheck } from "./detect.js";
import { runOpencodeCli, type OpencodeRunner } from "./cli.js";

export const DEFAULT_TASK_TIMEOUT_MS = 120_000;

export interface OpencodeRuntimeOptions {
  env: NodeJS.ProcessEnv;
  workspaceDir: string;
  logger?: Logger;
  /** Test-only: run the CLI without spawning it. */
  runner?: OpencodeRunner;
}

interface OpencodeThread {
  session: RuntimeSession;
}

function parseModel(model: string | null | undefined): string | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  if (slash <= 0) return undefined;
  return model;
}

/** Collect the assistant text from `opencode run --format json` NDJSON lines. */
function extractAssistantText(stdout: string): { text: string; providerError?: string } {
  let text = "";
  let providerError: string | undefined;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let ev: unknown;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!ev || typeof ev !== "object") continue;
    const obj = ev as { type?: string; part?: { type?: string; text?: unknown }; error?: unknown };
    if (obj.type === "text" && obj.part?.type === "text" && typeof obj.part.text === "string") {
      text += obj.part.text;
    } else if (obj.type === "error") {
      const err = obj.error as { data?: { message?: unknown }; name?: unknown } | undefined;
      const detail =
        typeof err?.data?.message === "string"
          ? err.data.message
          : typeof err?.name === "string"
            ? err.name
            : "unknown error";
      providerError = detail;
    }
  }
  return { text, ...(providerError ? { providerError } : {}) };
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
    return new RuntimeError("TIMEOUT", `opencode ${step} timed out`);
  }
  if (/ENOENT|not found|EINVAL/i.test(message)) {
    return new RuntimeError("UNAVAILABLE", `could not launch the opencode CLI while ${step}: ${message}`);
  }
  return new RuntimeError("CRASHED", `opencode ${step} failed: ${message}`);
}

/**
 * `AIRuntime` backed by one-shot `opencode run` CLI invocations. Each task is a
 * fresh process — there is no long-lived server to manage or crash. Structured
 * output is the model's JSON reply, validated upstream by `runStructured`.
 */
export class OpencodeRuntime implements AIRuntime {
  readonly kind = "opencode" as const;
  private readonly opts: OpencodeRuntimeOptions;
  private readonly timeoutMs: number;
  private readonly threads = new Map<string, OpencodeThread>();

  constructor(opts: OpencodeRuntimeOptions) {
    this.opts = opts;
    this.timeoutMs =
      Number(opts.env.INTERVIEW_OS_OPENCODE_TIMEOUT_MS) > 0
        ? Number(opts.env.INTERVIEW_OS_OPENCODE_TIMEOUT_MS)
        : DEFAULT_TASK_TIMEOUT_MS;
  }

  async healthCheck(): Promise<RuntimeStatus> {
    return opencodeHealthCheck(this.opts.env, this.opts.workspaceDir);
  }

  private async run(
    task: Pick<AgentTask, "taskId" | "instructions" | "input" | "model" | "timeoutMs"> & {
      outputSchema?: unknown;
      prompt?: string;
    },
  ): Promise<AgentResult> {
    const started = Date.now();
    const invalid = validateModelAndEffort(task.model ?? null, null);
    if (invalid) return { ok: false, error: invalid, durationMs: 0, events: [] };

    const bin = await findOpencodeExecutable(this.opts.env);
    if (!bin) {
      return {
        ok: false,
        error: new RuntimeError("UNAVAILABLE", OPENCODE_SETUP_MESSAGE),
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
    const model = parseModel(task.model);
    const args = ["run", "--format", "json"];
    if (model) args.push("-m", model);

    const timeoutMs = task.timeoutMs ?? this.timeoutMs;
    const events: AgentEvent[] = [{ type: "started" }];
    const step = "running the task";
    try {
      const result = await runOpencodeCli({
        bin,
        env: this.opts.env,
        workspaceDir: this.opts.workspaceDir,
        args,
        stdin: `${prompt}\n`,
        timeoutMs,
        runner: this.opts.runner,
      });

      if (result.code === null) {
        return {
          ok: false,
          error: new RuntimeError("TIMEOUT", `opencode did not finish within ${timeoutMs}ms`),
          durationMs: Date.now() - started,
          events,
        };
      }

      const { text, providerError } = extractAssistantText(result.stdout);
      if (providerError) {
        this.opts.logger?.warn("runtime.provider_error", {
          runtime: "opencode",
          taskId: task.taskId,
          detail: providerError.slice(0, 300),
        });
        return {
          ok: false,
          error: new RuntimeError("CRASHED", `opencode reported an error: ${providerError}`),
          raw: result.stdout,
          durationMs: Date.now() - started,
          events,
        };
      }
      if (result.code !== 0) {
        const detail = result.stderr.trim().slice(0, 300);
        return {
          ok: false,
          error: new RuntimeError(
            "CRASHED",
            `opencode exited with code ${result.code}${detail ? `: ${detail}` : ""}`,
          ),
          raw: result.stdout,
          durationMs: Date.now() - started,
          events,
        };
      }
      if (!text.trim()) {
        return {
          ok: false,
          error: new RuntimeError("MALFORMED_OUTPUT", "opencode produced no text output"),
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
          error: new RuntimeError("MALFORMED_OUTPUT", "opencode output was not valid JSON"),
          raw,
          durationMs: Date.now() - started,
          events,
        };
      }
      return {
        ok: true,
        output,
        raw,
        durationMs: Date.now() - started,
        events: [...events, { type: "completed", output, raw }],
      };
    } catch (err) {
      const error = asRuntimeError(err, step);
      this.opts.logger?.warn("runtime.task_failed", {
        runtime: "opencode",
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
    // One-shot transport: an opencode session is a local handle; each turn runs
    // the full prompt anew, so no server-side thread is created or resumed.
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
      yield { type: "error", error: new RuntimeError("PROTOCOL", `unknown opencode session "${sessionId}"`) };
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
      yield { type: "error", error: result.error };
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    this.threads.delete(sessionId);
  }

  async listModels(): Promise<ModelInfo[]> {
    const bin = await findOpencodeExecutable(this.opts.env);
    if (!bin) return [];
    try {
      const result = await runOpencodeCli({
        bin,
        env: this.opts.env,
        workspaceDir: this.opts.workspaceDir,
        args: ["models"],
        timeoutMs: 30_000,
        runner: this.opts.runner,
      });
      if (result.code !== 0) return [];
      const models: ModelInfo[] = [];
      for (const line of result.stdout.split("\n")) {
        const id = line.replace(/\u001b\[[0-9;]*m/g, "").trim();
        if (!/^[^/\s]+\/[^/\s]+$/.test(id)) continue;
        models.push({
          id,
          displayName: id,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: null,
        });
      }
      return models;
    } catch (err) {
      this.opts.logger?.warn("runtime.list_models_failed", {
        runtime: "opencode",
        message: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  async dispose(): Promise<void> {
    this.threads.clear();
  }
}
