import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OpencodeRuntime } from "../src/opencode/OpencodeRuntime.js";
import { buildOpencodeChildEnv } from "../src/opencode/childEnv.js";
import { opencodeHealthCheck } from "../src/opencode/detect.js";
import type { OpencodeRunner } from "../src/opencode/cli.js";
import type { RuntimeEvent } from "../src/index.js";

let workspaceDir: string;
const baseEnv = { ...process.env, SECRET_TOKEN: "super-secret-value" };

/** Fake `opencode run --format json` output: NDJSON text parts. */
function runnerFor(opts: { text?: string; error?: string; code?: number } = {}): OpencodeRunner {
  return async () => {
    if (opts.error) {
      return {
        stdout: `${JSON.stringify({ type: "error", error: { name: "UnknownError", data: { message: opts.error } } })}\n`,
        stderr: "",
        code: opts.code ?? 1,
      };
    }
    const lines = [
      JSON.stringify({
        type: "text",
        part: { type: "text", text: opts.text ?? '{"answer":42}' },
      }),
    ];
    return { stdout: `${lines.join("\n")}\n`, stderr: "", code: opts.code ?? 0 };
  };
}

beforeAll(async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "ios-opencode-test-"));
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

describe("opencode child env", () => {
  it("forwards only allowlisted variables", () => {
    const env = buildOpencodeChildEnv(baseEnv);
    expect(env.SECRET_TOKEN).toBeUndefined();
    expect(env.PATH).toBeDefined();
  });
});

describe("opencode healthCheck", () => {
  it("reports unavailable without the binary", async () => {
    const status = await opencodeHealthCheck(
      { ...baseEnv, INTERVIEW_OS_OPENCODE_BIN: "/nonexistent/opencode" },
      workspaceDir,
    );
    expect(status.available).toBe(false);
    expect(status.runtime).toBe("opencode");
  });
});

describe("opencode runTask", () => {
  it("parses the assistant text part as structured output", async () => {
    const rt = new OpencodeRuntime({
      env: { ...baseEnv, INTERVIEW_OS_OPENCODE_BIN: process.execPath },
      workspaceDir,
      runner: runnerFor(),
    });
    const res = await rt.runTask(task);
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.output as { answer: number }).answer).toBe(42);
  });

  it("strips a markdown code fence around JSON", async () => {
    const rt = new OpencodeRuntime({
      env: { ...baseEnv, INTERVIEW_OS_OPENCODE_BIN: process.execPath },
      workspaceDir,
      runner: runnerFor({ text: '```json\n{"answer":7}\n```' }),
    });
    const res = await rt.runTask(task);
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.output as { answer: number }).answer).toBe(7);
  });

  it("reports MALFORMED_OUTPUT for non-JSON text", async () => {
    const rt = new OpencodeRuntime({
      env: { ...baseEnv, INTERVIEW_OS_OPENCODE_BIN: process.execPath },
      workspaceDir,
      runner: runnerFor({ text: "not json" }),
    });
    const res = await rt.runTask(task);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("MALFORMED_OUTPUT");
  });

  it("reports CRASHED when opencode emits an error event", async () => {
    const rt = new OpencodeRuntime({
      env: { ...baseEnv, INTERVIEW_OS_OPENCODE_BIN: process.execPath },
      workspaceDir,
      runner: runnerFor({ error: "Unexpected server error" }),
    });
    const res = await rt.runTask(task);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("CRASHED");
      expect(res.error.message).toContain("Unexpected server error");
    }
  });

  it("rejects an invalid model before running", async () => {
    const rt = new OpencodeRuntime({
      env: { ...baseEnv, INTERVIEW_OS_OPENCODE_BIN: process.execPath },
      workspaceDir,
      runner: runnerFor(),
    });
    const res = await rt.runTask({ ...task, model: "bad model!" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("PROTOCOL");
  });
});

describe("opencode sessions", () => {
  it("uses a local opaque threadId and streams a one-shot turn", async () => {
    const rt = new OpencodeRuntime({
      env: { ...baseEnv, INTERVIEW_OS_OPENCODE_BIN: process.execPath },
      workspaceDir,
      runner: runnerFor({ text: '{"reply":"hello"}' }),
    });
    const session = await rt.createSession({});
    expect(typeof session.threadId).toBe("string");
    const events: RuntimeEvent[] = [];
    for await (const e of rt.sendMessage(session.id, { text: "hi", input: { x: 1 } })) {
      events.push(e);
    }
    expect(events.at(-1)?.type).toBe("completed");
  });
});

describe("opencode listModels", () => {
  it("maps `opencode models` lines to provider-qualified ids", async () => {
    const runner: OpencodeRunner = async (args) => {
      if (args[0] === "models") {
        return {
          stdout: "anthropic/claude-sonnet-5\nopencode-go/gpt-5.6-luna\nnot-a-model\n",
          stderr: "",
          code: 0,
        };
      }
      return { stdout: "", stderr: "", code: 0 };
    };
    const rt = new OpencodeRuntime({
      env: { ...baseEnv, INTERVIEW_OS_OPENCODE_BIN: process.execPath },
      workspaceDir,
      runner,
    });
    const models = await rt.listModels();
    expect(models.map((m) => m.id)).toEqual([
      "anthropic/claude-sonnet-5",
      "opencode-go/gpt-5.6-luna",
    ]);
  });
});
