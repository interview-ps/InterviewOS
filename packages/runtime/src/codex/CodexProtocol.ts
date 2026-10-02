import type { CodexProcess } from "./CodexProcess.js";
import type {
  InitializeResult,
  ModelListResponse,
  ThreadResumeResult,
  ThreadStartParams,
  ThreadStartResult,
  TurnStartParams,
  TurnStartResult,
} from "./types.js";

/** Notification method names the runtime reacts to; everything else is ignored. */
export const APP_SERVER_NOTIFICATIONS = new Set([
  "item/agentMessage/delta",
  "item/completed",
  "turn/completed",
  "turn/failed",
  "error",
]);

export class CodexProtocol {
  constructor(private readonly proc: CodexProcess) {}

  initialize(): Promise<unknown> {
    return this.proc.request("initialize", {
      clientInfo: { name: "interview-os", title: "Interview OS", version: "0.1.0" },
      capabilities: null,
    }) as Promise<InitializeResult>;
  }

  initialized(): void {
    this.proc.notify("initialized", {});
  }

  async threadStart(params: ThreadStartParams): Promise<ThreadStartResult> {
    return (await this.proc.request("thread/start", params)) as ThreadStartResult;
  }

  async threadResume(threadId: string): Promise<ThreadResumeResult> {
    return (await this.proc.request("thread/resume", {
      threadId,
    })) as ThreadResumeResult;
  }

  async turnStart(params: TurnStartParams): Promise<TurnStartResult> {
    return (await this.proc.request("turn/start", params)) as TurnStartResult;
  }

  /** Best-effort cancel of an in-flight turn. */
  async turnInterrupt(threadId: string, turnId: string): Promise<void> {
    await this.proc.request("turn/interrupt", { threadId, turnId }, 5_000);
  }

  /** One page of the model catalog. */
  async modelList(cursor?: string | null): Promise<ModelListResponse> {
    return (await this.proc.request("model/list", {
      includeHidden: false,
      cursor: cursor ?? null,
    })) as ModelListResponse;
  }
}
