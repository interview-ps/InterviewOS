export type JSONSchema = Record<string, unknown>;

export type RuntimeErrorCode =
  | "UNAVAILABLE"
  | "SPAWN_FAILED"
  | "CRASHED"
  | "TIMEOUT"
  | "MALFORMED_EVENT"
  | "MALFORMED_OUTPUT"
  | "PROTOCOL";

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;

  constructor(code: RuntimeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeError";
    this.code = code;
  }
}

export type RuntimeKind = "codex" | "mock";

export interface RuntimeStatus {
  runtime: RuntimeKind;
  available: boolean;
  version?: string;
  executable?: string;
  workspace?: string;
  status: "ready" | "unavailable" | "error";
  message?: string;
}

export interface AgentTask {
  taskId: string;
  instructions: string;
  input: unknown;
  outputSchema: JSONSchema;
  timeoutMs?: number;
}

export type AgentEvent = { type: string } & Record<string, unknown>;

export type AgentResult =
  | { ok: true; output: unknown; raw: string; durationMs: number; events: AgentEvent[] }
  | { ok: false; error: RuntimeError; raw?: string; durationMs: number; events: AgentEvent[] };

export interface RuntimeMessage {
  text: string;
  taskId?: string;
  input?: unknown;
  outputSchema?: JSONSchema;
}

export type RuntimeEvent =
  | { type: "started" }
  | { type: "delta"; text: string }
  | { type: "message"; text: string }
  | { type: "completed"; output?: unknown; raw: string }
  | { type: "error"; error: RuntimeError };

export interface SessionInput {
  instructions?: string;
  developerInstructions?: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeSession {
  id: string;
  threadId: string;
}

export interface AIRuntime {
  readonly kind: RuntimeKind;
  healthCheck(): Promise<RuntimeStatus>;
  runTask(task: AgentTask): Promise<AgentResult>;
  createSession(input: SessionInput): Promise<RuntimeSession>;
  resumeSession(threadId: string, input: SessionInput): Promise<RuntimeSession>;
  sendMessage(sessionId: string, msg: RuntimeMessage): AsyncIterable<RuntimeEvent>;
  closeSession(sessionId: string): Promise<void>;
  dispose(): Promise<void>;
}
