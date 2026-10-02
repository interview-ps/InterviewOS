import type { JSONSchema } from "../interface/index.js";

/** Raw event line emitted by `codex exec --json` (JSONL). */
export interface CodexExecEvent {
  type: string;
  thread_id?: string;
  item?: { id?: string; type?: string; text?: string; phase?: string };
  usage?: unknown;
  message?: string;
  [key: string]: unknown;
}

/** JSON-RPC (newline-delimited, no "jsonrpc" field) shapes for `codex app-server`. */
export interface AppServerRequest {
  id: number | string;
  method: string;
  params?: unknown;
}

export interface AppServerResponse {
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface AppServerNotification {
  method: string;
  params?: unknown;
}

export interface InitializeResult {
  userAgent?: string;
  [key: string]: unknown;
}

export interface ThreadStartParams {
  cwd: string;
  sandbox: "read-only";
  approvalPolicy: "never";
  ephemeral: boolean;
  developerInstructions: string;
}

export interface ThreadStartResult {
  thread: { id: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface ThreadResumeParams {
  threadId: string;
}

export interface ThreadResumeResult {
  thread: { id: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface TurnStartParams {
  threadId: string;
  input: Array<{ type: "text"; text: string; text_elements: unknown[] }>;
  outputSchema?: JSONSchema;
}

export interface TurnStartResult {
  turn: { id: string; status: string; [key: string]: unknown };
  [key: string]: unknown;
}
