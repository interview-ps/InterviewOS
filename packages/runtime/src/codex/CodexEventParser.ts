import type { AgentEvent } from "../interface/index.js";
import type { CodexExecEvent } from "./types.js";

export interface ParsedExecLine {
  /** 'malformed' for non-JSON stdout lines. */
  kind: "event" | "malformed";
  event?: CodexExecEvent;
  line: string;
}

export function parseExecLine(line: string): ParsedExecLine {
  const trimmed = line.trim();
  if (trimmed === "") return { kind: "event", line, event: { type: "blank" } };
  try {
    const parsed = JSON.parse(trimmed) as CodexExecEvent;
    if (parsed && typeof parsed === "object" && typeof parsed.type === "string") {
      return { kind: "event", line, event: parsed };
    }
    return { kind: "malformed", line };
  } catch {
    return { kind: "malformed", line };
  }
}

/**
 * Accumulates `codex exec --json` JSONL output: thread/turn lifecycle,
 * agent_message items, usage, failures, and non-JSON lines.
 */
export class CodexExecEventParser {
  readonly events: AgentEvent[] = [];
  readonly agentMessages: string[] = [];
  malformedEventCount = 0;
  threadId?: string;
  usage?: unknown;
  failedMessage?: string;

  feed(line: string): void {
    const parsed = parseExecLine(line);
    if (parsed.kind === "malformed") {
      this.malformedEventCount += 1;
      this.events.push({ type: "malformed_event", line: parsed.line });
      return;
    }
    const event = parsed.event!;
    if (event.type === "blank") return;
    this.events.push(event);
    switch (event.type) {
      case "thread.started":
        this.threadId = event.thread_id;
        break;
      case "item.completed":
        if (event.item?.type === "agent_message" && typeof event.item.text === "string") {
          this.agentMessages.push(event.item.text);
        }
        break;
      case "turn.completed":
        this.usage = event.usage;
        break;
      case "turn.failed":
      case "error":
        this.failedMessage =
          event.message ??
          (typeof event.error === "string" ? event.error : undefined) ??
          `${event.type}`;
        break;
    }
  }

  get lastAgentMessage(): string | undefined {
    return this.agentMessages[this.agentMessages.length - 1];
  }
}
