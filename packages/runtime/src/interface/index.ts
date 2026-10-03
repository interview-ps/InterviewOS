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

export type RuntimeKind = "codex" | "mock" | "claude" | "opencode" | "devin";

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
  /** Streaming callback — receives the same events collected on the result. */
  onEvent?: (e: RuntimeEvent) => void;
  /** Model override (validated by MODEL_ID_REGEX; provider-qualified ids allowed). */
  model?: string | null;
  /** Reasoning effort override. */
  effort?: "low" | "medium" | "high" | null;
  /** Codex-only: warm app-server turn (default) or `codex exec`. */
  taskMode?: "app-server" | "exec";
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
  model?: string | null;
  effort?: "low" | "medium" | "high" | null;
}

export interface ModelInfo {
  id: string;
  displayName: string;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string | null;
  /** Marks the provider's default model; used when a saved model disappears. */
  isDefault?: boolean;
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
  listModels(): Promise<ModelInfo[]>;
  dispose(): Promise<void>;
}

/** Model id: 1–128 chars, optionally one `/` separating provider and model. */
export const MODEL_ID_REGEX =
  /^(?=.{1,128}$)[A-Za-z0-9._:-]+(?:\/[A-Za-z0-9._:-]+)?$/;
export const REASONING_EFFORTS = ["low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** Defence-in-depth validation before a model/effort reaches a child process. */
export function validateModelAndEffort(
  model?: string | null,
  effort?: string | null,
): RuntimeError | null {
  if (model != null && !MODEL_ID_REGEX.test(model)) {
    return new RuntimeError("PROTOCOL", `invalid model id "${model.slice(0, 40)}…"`);
  }
  if (
    effort != null &&
    !(REASONING_EFFORTS as readonly string[]).includes(effort)
  ) {
    return new RuntimeError("PROTOCOL", `invalid reasoning effort "${effort}"`);
  }
  return null;
}
