import { newId } from "@interview-os/core";
import {
  RuntimeError,
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

export type MockTaskHandler = (input: unknown, task: AgentTask) => unknown;

export interface MockRuntimeOptions {
  /**
   * Delay between streamed delta chunks (INTERVAL for demos / e2e where the
   * streaming path must be observable). Server reads INTERVIEW_OS_MOCK_DELAY_MS.
   */
  chunkDelayMs?: number;
}

interface MockThread {
  session: RuntimeSession;
  turns: number;
}

const CHUNK = 40;

function chunks(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += CHUNK) out.push(text.slice(i, i + CHUNK));
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Deterministic, network-free runtime. Task handlers are registered per taskId;
 * default handlers ship with apps/server (src/skills).
 */
export class MockRuntime implements AIRuntime {
  readonly kind = "mock" as const;
  private readonly handlers = new Map<string, MockTaskHandler>();
  private readonly threads = new Map<string, MockThread>();
  private readonly delayMs: number;
  private threadSeq = 0;

  constructor(opts: MockRuntimeOptions = {}) {
    this.delayMs = opts.chunkDelayMs ?? 0;
  }

  register(taskId: string, handler: MockTaskHandler): void {
    this.handlers.set(taskId, handler);
  }

  async healthCheck(): Promise<RuntimeStatus> {
    return { runtime: "mock", available: true, status: "ready" };
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      {
        id: "mock",
        displayName: "Mock (deterministic)",
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
      },
    ];
  }

  async runTask(task: AgentTask): Promise<AgentResult> {
    const started = Date.now();
    const handler = this.handlers.get(task.taskId);
    if (!handler) {
      return {
        ok: false,
        error: new RuntimeError(
          "PROTOCOL",
          `mock runtime has no handler registered for task "${task.taskId}"`,
        ),
        durationMs: Date.now() - started,
        events: [{ type: "started" }],
      };
    }
    const output = handler(task.input, task);
    const raw = JSON.stringify(output);
    const events: RuntimeEvent[] = [{ type: "started" }];
    task.onEvent?.({ type: "started" });
    for (const chunk of chunks(raw)) {
      if (this.delayMs > 0) await sleep(this.delayMs);
      const e: RuntimeEvent = { type: "delta", text: chunk };
      events.push(e);
      task.onEvent?.(e);
    }
    events.push({ type: "message", text: raw });
    events.push({ type: "completed", output, raw });
    task.onEvent?.({ type: "message", text: raw });
    task.onEvent?.({ type: "completed", output, raw });
    return {
      ok: true,
      output,
      raw,
      durationMs: Date.now() - started,
      events,
    };
  }

  async createSession(_input: SessionInput): Promise<RuntimeSession> {
    const session: RuntimeSession = {
      id: newId("sess"),
      threadId: `mock-thread-${++this.threadSeq}`,
    };
    this.threads.set(session.id, { session, turns: 0 });
    return session;
  }

  async resumeSession(threadId: string, _input: SessionInput): Promise<RuntimeSession> {
    for (const thread of this.threads.values()) {
      if (thread.session.threadId === threadId) return thread.session;
    }
    const session: RuntimeSession = { id: newId("sess"), threadId };
    this.threads.set(session.id, { session, turns: 0 });
    return session;
  }

  async *sendMessage(sessionId: string, msg: RuntimeMessage): AsyncIterable<RuntimeEvent> {
    const thread = this.threads.get(sessionId);
    if (!thread) {
      yield {
        type: "error",
        error: new RuntimeError("PROTOCOL", `unknown mock session "${sessionId}"`),
      };
      return;
    }
    thread.turns += 1;
    yield { type: "started" };

    let text: string;
    let output: unknown;
    const handler = msg.taskId ? this.handlers.get(msg.taskId) : undefined;
    if (msg.taskId && !handler) {
      yield {
        type: "error",
        error: new RuntimeError(
          "PROTOCOL",
          `mock runtime has no handler registered for task "${msg.taskId}"`,
        ),
      };
      return;
    }
    if (handler) {
      output = handler(msg.input ?? msg.text, {
        taskId: msg.taskId!,
        instructions: "",
        input: msg.input,
        outputSchema: msg.outputSchema ?? {},
      });
      text = JSON.stringify(output);
    } else {
      text = `[mock turn ${thread.turns}] ${msg.text.length} chars`;
    }
    for (const chunk of chunks(text)) {
      if (this.delayMs > 0) await sleep(this.delayMs);
      yield { type: "delta", text: chunk };
    }
    yield { type: "message", text };
    yield { type: "completed", output, raw: text };
  }

  async closeSession(sessionId: string): Promise<void> {
    this.threads.delete(sessionId);
  }

  async dispose(): Promise<void> {
    this.threads.clear();
  }
}
