import { newId } from "@interview-os/shared";
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

export type MockTaskHandler = (input: unknown, task: AgentTask) => unknown;

interface MockThread {
  session: RuntimeSession;
  turns: number;
}

/**
 * Deterministic, network-free runtime. Task handlers are registered per taskId;
 * default handlers ship with packages/skills.
 */
export class MockRuntime implements AIRuntime {
  readonly kind = "mock" as const;
  private readonly handlers = new Map<string, MockTaskHandler>();
  private readonly threads = new Map<string, MockThread>();
  private threadSeq = 0;

  register(taskId: string, handler: MockTaskHandler): void {
    this.handlers.set(taskId, handler);
  }

  async healthCheck(): Promise<RuntimeStatus> {
    return { runtime: "mock", available: true, status: "ready" };
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
    return {
      ok: true,
      output,
      raw,
      durationMs: Date.now() - started,
      events: [
        { type: "started" },
        { type: "message", text: raw },
        { type: "completed", output, raw },
      ],
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
    const words = text.split(" ");
    for (const word of words) {
      yield { type: "delta", text: word + " " };
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
