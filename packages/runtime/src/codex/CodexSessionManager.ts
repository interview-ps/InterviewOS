import { newId } from "@interview-os/shared";
import {
  RuntimeError,
  validateModelAndEffort,
  type AgentEvent,
  type AgentResult,
  type AgentTask,
  type RuntimeEvent,
  type RuntimeMessage,
  type RuntimeSession,
  type SessionInput,
} from "../interface/index.js";
import type { CodexProcess } from "./CodexProcess.js";
import { CodexProtocol } from "./CodexProtocol.js";

interface ManagedSession {
  id: string;
  threadId: string;
  /** CodexProcess generation the thread was created/resumed under. */
  generation: number;
  developerInstructions?: string;
}

interface TurnParams {
  threadId?: string;
  turnId?: string;
  delta?: string;
  item?: { type?: string; text?: string; phase?: string };
  turn?: { id?: string; status?: string; error?: unknown };
  message?: string;
}

class EventQueue implements AsyncIterable<RuntimeEvent> {
  private items: RuntimeEvent[] = [];
  private waiters: Array<() => void> = [];
  private done = false;

  push(event: RuntimeEvent): void {
    this.items.push(event);
    this.wake();
  }

  finish(): void {
    this.done = true;
    this.wake();
  }

  private wake(): void {
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<RuntimeEvent> {
    for (;;) {
      const item = this.items.shift();
      if (item !== undefined) {
        yield item;
        continue;
      }
      if (this.done) return;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

/** Maps Interview OS session ids ↔ Codex app-server thread ids. */
export class CodexSessionManager {
  private readonly protocol: CodexProtocol;
  private readonly sessions = new Map<string, ManagedSession>();

  constructor(
    private readonly proc: CodexProcess,
    private readonly opts: { workspaceDir: string; turnTimeoutMs: number },
  ) {
    this.protocol = new CodexProtocol(proc);
  }

  async createSession(input: SessionInput): Promise<RuntimeSession> {
    await this.proc.ensureReady();
    const result = await this.protocol.threadStart({
      cwd: this.opts.workspaceDir,
      sandbox: "read-only",
      approvalPolicy: "never",
      ephemeral: false,
      developerInstructions: input.developerInstructions ?? input.instructions ?? "",
    });
    return this.track(result.thread.id, input);
  }

  async resumeSession(threadId: string, input: SessionInput): Promise<RuntimeSession> {
    await this.proc.ensureReady();
    const result = await this.protocol.threadResume(threadId);
    return this.track(result.thread.id ?? threadId, input);
  }

  private track(threadId: string, input: SessionInput): RuntimeSession {
    const session: ManagedSession = {
      id: newId("sess"),
      threadId,
      generation: this.proc.generation,
      developerInstructions: input.developerInstructions ?? input.instructions,
    };
    this.sessions.set(session.id, session);
    return { id: session.id, threadId };
  }

  /** Re-resume threads created under an older (crashed) process generation. */
  private async ensureThreadCurrent(session: ManagedSession): Promise<void> {
    await this.proc.ensureReady();
    if (session.generation === this.proc.generation) return;
    await this.protocol.threadResume(session.threadId);
    session.generation = this.proc.generation;
  }

  sendMessage(sessionId: string, msg: RuntimeMessage): AsyncIterable<RuntimeEvent> {
    return this.streamTurn(sessionId, msg);
  }

  /**
   * One-shot task on an ephemeral thread over the shared app-server process
   * (§8.3 task mode). Streams `item/agentMessage/delta` through task.onEvent;
   * on timeout the turn is interrupted best-effort before failing.
   */
  async runTask(task: AgentTask): Promise<AgentResult> {
    const started = Date.now();
    const events: AgentEvent[] = [];
    const emit = (e: RuntimeEvent) => {
      events.push(e);
      task.onEvent?.(e);
    };
    const fail = (error: RuntimeError, raw?: string): AgentResult => ({
      ok: false,
      error,
      raw,
      durationMs: Date.now() - started,
      events,
    });

    const invalid = validateModelAndEffort(task.model, task.effort);
    if (invalid) return fail(invalid);
    const timeoutMs = task.timeoutMs ?? this.opts.turnTimeoutMs;
    emit({ type: "started" });

    let threadId: string | undefined;
    let turnId: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.proc.ensureReady();
        const thread = await this.protocol.threadStart({
          cwd: this.opts.workspaceDir,
          sandbox: "read-only",
          approvalPolicy: "never",
          ephemeral: true,
          developerInstructions: task.instructions,
          model: task.model ?? undefined,
        });
        threadId = thread.thread.id;
        const turn = await this.protocol.turnStart({
          threadId,
          input: [
            {
              type: "text",
              text: `Input (JSON):\n${JSON.stringify(task.input, null, 2)}\n`,
              text_elements: [],
            },
          ],
          outputSchema: task.outputSchema,
          model: task.model ?? undefined,
          effort: task.effort ?? undefined,
        });
        turnId = turn.turn.id;
        break;
      } catch (err) {
        const retryable =
          err instanceof RuntimeError &&
          (err.code === "CRASHED" || err.code === "SPAWN_FAILED");
        if (attempt === 1 || !retryable) {
          return fail(asRuntimeError(err));
        }
      }
    }

    return new Promise<AgentResult>((resolve) => {
      let lastText = "";
      let settled = false;
      const finish = (result: AgentResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        offNotification();
        offExit();
        resolve(result);
      };

      const offNotification = this.proc.onNotification((method, rawParams) => {
        const params = (rawParams ?? {}) as TurnParams;
        if (params.threadId !== undefined && params.threadId !== threadId) return;
        if (params.turnId !== undefined && turnId !== undefined && params.turnId !== turnId)
          return;
        if (
          params.turn?.id !== undefined &&
          turnId !== undefined &&
          params.turn.id !== turnId
        )
          return;

        switch (method) {
          case "item/agentMessage/delta":
            if (typeof params.delta === "string") {
              emit({ type: "delta", text: params.delta });
            }
            break;
          case "item/completed":
            if (params.item?.type === "agentMessage" && typeof params.item.text === "string") {
              lastText = params.item.text;
              emit({ type: "message", text: params.item.text });
            }
            break;
          case "turn/completed": {
            const status = params.turn?.status ?? "completed";
            if (status !== "completed") {
              finish(
                fail(
                  new RuntimeError(
                    "PROTOCOL",
                    `codex turn ended with status "${status}": ${JSON.stringify(params.turn?.error ?? null)}`,
                  ),
                  lastText,
                ),
              );
              return;
            }
            if (lastText === "") {
              finish(
                fail(
                  new RuntimeError(
                    "MALFORMED_EVENT",
                    "codex turn completed without an agent message",
                  ),
                ),
              );
              return;
            }
            try {
              const output = JSON.parse(lastText) as unknown;
              emit({ type: "completed", output, raw: lastText });
              finish({
                ok: true,
                output,
                raw: lastText,
                durationMs: Date.now() - started,
                events,
              });
            } catch {
              finish(
                fail(
                  new RuntimeError(
                    "MALFORMED_OUTPUT",
                    "turn completed but the final agent message was not valid JSON",
                  ),
                  lastText,
                ),
              );
            }
            break;
          }
          case "turn/failed":
          case "error":
            finish(
              fail(
                new RuntimeError(
                  "PROTOCOL",
                  `codex turn error: ${params.message ?? JSON.stringify(params)}`,
                ),
                lastText,
              ),
            );
            break;
        }
      });

      const offExit = this.proc.onExit(() => {
        finish(fail(new RuntimeError("CRASHED", "codex app-server exited mid-turn")));
      });

      const timer = setTimeout(() => {
        if (threadId && turnId) {
          this.protocol.turnInterrupt(threadId, turnId).catch(() => {});
        }
        finish(
          fail(
            new RuntimeError(
              "TIMEOUT",
              `codex task timed out after ${timeoutMs}ms`,
            ),
            lastText,
          ),
        );
      }, timeoutMs);
    });
  }

  private async *streamTurn(
    sessionId: string,
    msg: RuntimeMessage,
  ): AsyncIterable<RuntimeEvent> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      yield {
        type: "error",
        error: new RuntimeError("PROTOCOL", `unknown session "${sessionId}"`),
      };
      return;
    }
    const invalid = validateModelAndEffort(msg.model, msg.effort);
    if (invalid) {
      yield { type: "error", error: invalid };
      return;
    }
    yield { type: "started" };

    // The app-server may emit turn notifications before the turn/start response
    // has been consumed. Capture them until the turn listener is installed.
    const earlyNotifications: Array<[string, unknown]> = [];
    const offEarly = this.proc.onNotification((method, params) => {
      earlyNotifications.push([method, params]);
    });

    let turnId: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.ensureThreadCurrent(session);
        const result = await this.protocol.turnStart({
          threadId: session.threadId,
          input: [{ type: "text", text: msg.text, text_elements: [] }],
          outputSchema: msg.outputSchema,
          model: msg.model ?? undefined,
          effort: msg.effort ?? undefined,
        });
        turnId = result.turn?.id;
        break;
      } catch (err) {
        const retryable =
          err instanceof RuntimeError &&
          (err.code === "CRASHED" || err.code === "SPAWN_FAILED");
        if (attempt === 1 || !retryable) {
          offEarly();
          yield { type: "error", error: asRuntimeError(err) };
          return;
        }
        // process died between health check and request: force resume + retry once
        session.generation = -1;
      }
    }

    const queue = new EventQueue();
    let lastMessageText = "";

    const handleNotification = (method: string, rawParams: unknown) => {
      const params = (rawParams ?? {}) as TurnParams;
      if (params.threadId !== undefined && params.threadId !== session.threadId) return;
      if (params.turnId !== undefined && turnId !== undefined && params.turnId !== turnId)
        return;
      if (
        params.turn?.id !== undefined &&
        turnId !== undefined &&
        params.turn.id !== turnId
      )
        return;

      switch (method) {
        case "item/agentMessage/delta":
          if (typeof params.delta === "string") {
            queue.push({ type: "delta", text: params.delta });
          }
          break;
        case "item/completed":
          if (params.item?.type === "agentMessage" && typeof params.item.text === "string") {
            lastMessageText = params.item.text;
            queue.push({ type: "message", text: params.item.text });
          }
          break;
        case "turn/completed": {
          const status = params.turn?.status ?? "completed";
          const parseFailed =
            status === "completed" &&
            msg.outputSchema !== undefined &&
            lastMessageText !== "" &&
            !tryJsonParse(lastMessageText).ok;
          if (status === "completed" && !parseFailed) {
            queue.push({
              type: "completed",
              output: tryJsonParse(lastMessageText).value,
              raw: lastMessageText,
            });
          } else if (parseFailed) {
            queue.push({
              type: "error",
              error: new RuntimeError(
                "MALFORMED_OUTPUT",
                "turn completed but the final agent message was not valid JSON",
              ),
            });
          } else {
            queue.push({
              type: "error",
              error: new RuntimeError(
                "PROTOCOL",
                `codex turn ended with status "${status}": ${JSON.stringify(params.turn?.error ?? null)}`,
              ),
            });
          }
          queue.finish();
          break;
        }
        case "turn/failed":
        case "error":
          queue.push({
            type: "error",
            error: new RuntimeError(
              "PROTOCOL",
              `codex turn error: ${params.message ?? JSON.stringify(params)}`,
            ),
          });
          queue.finish();
          break;
      }
    };
    const offNotification = this.proc.onNotification(handleNotification);
    offEarly();
    for (const [method, params] of earlyNotifications) {
      handleNotification(method, params);
    }

    const offExit = this.proc.onExit(() => {
      queue.push({
        type: "error",
        error: new RuntimeError("CRASHED", "codex app-server exited mid-turn"),
      });
      queue.finish();
    });

    const timer = setTimeout(() => {
      queue.push({
        type: "error",
        error: new RuntimeError(
          "TIMEOUT",
          `codex turn timed out after ${this.opts.turnTimeoutMs}ms`,
        ),
      });
      queue.finish();
    }, this.opts.turnTimeoutMs);

    try {
      yield* queue;
    } finally {
      clearTimeout(timer);
      offNotification();
      offExit();
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  sessionThreadId(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.threadId;
  }

  async modelList(cursor?: string | null) {
    await this.proc.ensureReady();
    return this.protocol.modelList(cursor);
  }
}

function tryJsonParse(text: string): { ok: boolean; value?: unknown } {
  if (text === "") return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function asRuntimeError(err: unknown): RuntimeError {
  if (err instanceof RuntimeError) return err;
  return new RuntimeError("PROTOCOL", String(err));
}
