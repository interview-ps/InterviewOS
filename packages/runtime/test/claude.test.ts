import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClaudeCodeRuntime } from "../src/claude/ClaudeCodeRuntime.js";
import { buildClaudeChildEnv } from "../src/claude/childEnv.js";
import { claudeHealthCheck } from "../src/claude/detect.js";
import type {
  ClaudeSdk,
  ClaudeSdkMessage,
  ClaudeSdkModelInfo,
  ClaudeSdkOptions,
  ClaudeSdkQuery,
} from "../src/claude/sdk.js";
import type { RuntimeEvent } from "../src/index.js";

let workspaceDir: string;
const baseEnv = {
  ...process.env,
  SECRET_TOKEN: "super-secret-value",
  INTERVIEW_OS_CLAUDE_BIN: process.execPath,
};

interface FakeScript {
  messages: ClaudeSdkMessage[];
  models?: ClaudeSdkModelInfo[];
  throwOnQuery?: boolean;
}

function fakeQueryFactory(script: FakeScript, captured: { options?: ClaudeSdkOptions; prompt?: string }) {
  return (params: { prompt: string; options?: ClaudeSdkOptions }): ClaudeSdkQuery => {
    captured.options = params.options;
    captured.prompt = params.prompt;
    if (script.throwOnQuery) throw new Error("boom");
    const messages = script.messages;
    const gen = (async function* () {
      for (const m of messages) yield m;
    })();
    return Object.assign(gen, {
      supportedModels: async () => script.models ?? [],
      interrupt: async () => undefined,
      close: () => {},
    }) as unknown as ClaudeSdkQuery;
  };
}

function sdkFor(script: FakeScript, captured: { options?: ClaudeSdkOptions; prompt?: string }): ClaudeSdk {
  return { query: fakeQueryFactory(script, captured) };
}

function resultMessage(extra: Record<string, unknown>): ClaudeSdkMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    session_id: "sess-1",
    uuid: "uuid-1",
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    total_cost_usd: 0,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    ...extra,
  } as unknown as ClaudeSdkMessage;
}

beforeAll(async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "ios-claude-test-"));
});
afterAll(async () => {
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

const task = {
  taskId: "t",
  instructions: "Return JSON.",
  input: { x: 1 },
  outputSchema: { type: "object", properties: { answer: { type: "number" } } },
};

function runtime(script: FakeScript, env: NodeJS.ProcessEnv = baseEnv) {
  const captured: { options?: ClaudeSdkOptions; prompt?: string } = {};
  return {
    rt: new ClaudeCodeRuntime({
      env,
      workspaceDir,
      sdk: sdkFor(script, captured),
      extraChildEnv: { keys: ["FAKE_CLAUDE"] },
    }),
    captured,
  };
}

describe("claude child env", () => {
  it("forwards only allowlisted variables", () => {
    const env = buildClaudeChildEnv(baseEnv);
    expect(env.SECRET_TOKEN).toBeUndefined();
    expect(env.PATH).toBeDefined();
  });
});

describe("claude healthCheck", () => {
  it("reports unavailable without the binary", async () => {
    const status = await claudeHealthCheck(
      { ...baseEnv, INTERVIEW_OS_CLAUDE_BIN: "/nonexistent/claude" },
      workspaceDir,
    );
    expect(status.available).toBe(false);
    expect(status.runtime).toBe("claude");
  });
});

describe("claude runTask (structured output)", () => {
  it("returns structured_output and never logs the secret", async () => {
    const { rt, captured } = runtime({
      messages: [resultMessage({ structured_output: { answer: 42 } })],
    });
    const res = await rt.runTask(task);
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.output as { answer: number }).answer).toBe(42);
    const opts = captured.options as { permissionMode?: string; env?: Record<string, string> };
    expect(opts.permissionMode).toBe("dontAsk");
    expect(opts.env?.SECRET_TOKEN).toBeUndefined();
  });

  it("reports UNAVAILABLE when the CLI is missing", async () => {
    const { rt } = runtime({ messages: [] }, {
      ...baseEnv,
      INTERVIEW_OS_CLAUDE_BIN: "/nonexistent/claude",
    });
    const res = await rt.runTask(task);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("UNAVAILABLE");
  });

  it("reports MALFORMED_EVENT when no result arrives", async () => {
    const { rt } = runtime({ messages: [] });
    const res = await rt.runTask(task);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("MALFORMED_EVENT");
  });

  it("rejects an invalid model before querying", async () => {
    const { rt, captured } = runtime({
      messages: [resultMessage({ structured_output: {} })],
    });
    const res = await rt.runTask({ ...task, model: "bad model!" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("PROTOCOL");
    expect(captured.options).toBeUndefined();
  });
});

describe("claude sessions (one-shot)", () => {
  it("returns a local opaque threadId and completes a one-shot turn", async () => {
    const env = { ...baseEnv, INTERVIEW_OS_CLAUDE_BIN: process.execPath };
    const { rt } = runtime(
      { messages: [resultMessage({ structured_output: { answer: 7 } })] },
      env,
    );
    const session = await rt.createSession({});
    expect(session.threadId).toMatch(/[0-9a-f-]{36}/);
    const events: RuntimeEvent[] = [];
    for await (const e of rt.sendMessage(session.id, { text: "hi" })) events.push(e);
    expect(events.at(-1)?.type).toBe("completed");
    const last = events.at(-1);
    if (last?.type === "completed") {
      expect((last.output as { answer: number }).answer).toBe(7);
    }
  });

  it("rejects an unknown session id", async () => {
    const env = { ...baseEnv, INTERVIEW_OS_CLAUDE_BIN: process.execPath };
    const { rt } = runtime({ messages: [] }, env);
    const events: RuntimeEvent[] = [];
    for await (const e of rt.sendMessage("nope", { text: "hi" })) events.push(e);
    expect(events.at(-1)?.type).toBe("error");
  });
});

describe("claude listModels", () => {
  it("maps SDK models and falls back to aliases", async () => {
    const { rt } = runtime({
      messages: [],
      models: [
        { value: "claude-sonnet-5", displayName: "Sonnet 5", description: "", supportedEffortLevels: ["low", "high"] },
      ],
    });
    const models = await rt.listModels();
    expect(models[0]?.id).toBe("claude-sonnet-5");
    expect(models[0]?.isDefault).toBe(true);
    expect(models[0]?.supportedReasoningEfforts).toEqual(["low", "high"]);
  });
});
