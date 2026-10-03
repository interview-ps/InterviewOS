import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DevinRuntime } from "../src/devin/DevinRuntime.js";
import { buildDevinChildEnv } from "../src/devin/childEnv.js";
import { devinHealthCheck } from "../src/devin/detect.js";
import type { DevinRunner } from "../src/devin/cli.js";
import type { RuntimeEvent } from "../src/index.js";

let workspaceDir: string;
const baseEnv = { ...process.env, SECRET_TOKEN: "super-secret-value" };

/** Fake `devin -p` output: the response text lands directly on stdout. */
function runnerFor(opts: { text?: string; stderr?: string; code?: number | null } = {}): DevinRunner {
  return async () => ({
    stdout: opts.text !== undefined ? `${opts.text}\n` : "",
    stderr: opts.stderr ?? "",
    code: opts.code === undefined ? 0 : opts.code,
  });
}

beforeAll(async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "ios-devin-test-"));
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

describe("devin child env", () => {
  it("forwards only allowlisted variables", () => {
    const env = buildDevinChildEnv(baseEnv);
    expect(env.SECRET_TOKEN).toBeUndefined();
    expect(env.PATH).toBeDefined();
  });
});

describe("devin healthCheck", () => {
  it("reports unavailable without the binary", async () => {
    const status = await devinHealthCheck(
      { ...baseEnv, INTERVIEW_OS_DEVIN_BIN: "/nonexistent/devin" },
      workspaceDir,
    );
    expect(status.available).toBe(false);
    expect(status.runtime).toBe("devin");
  });
});

describe("devin runTask", () => {
  const rt = (runner: DevinRunner) =>
    new DevinRuntime({
      env: { ...baseEnv, INTERVIEW_OS_DEVIN_BIN: process.execPath },
      workspaceDir,
      runner,
    });

  it("parses stdout as structured output", async () => {
    const res = await rt(runnerFor({ text: '{"answer":42}' })).runTask(task);
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.output as { answer: number }).answer).toBe(42);
  });

  it("passes the prompt via --prompt-file, never as an argv prompt", async () => {
    let seenArgs: string[] = [];
    const runner: DevinRunner = async (args, opts) => {
      seenArgs = args;
      expect(opts.prompt).toContain("Return JSON.");
      return { stdout: '{"answer":1}\n', stderr: "", code: 0 };
    };
    const res = await rt(runner).runTask(task);
    expect(res.ok).toBe(true);
    expect(seenArgs).toContain("-p");
    const fileFlag = seenArgs.indexOf("--prompt-file");
    expect(fileFlag).toBeGreaterThan(-1);
    expect(seenArgs[fileFlag + 1]).toMatch(/\.txt$/);
    expect(seenArgs.join(" ")).not.toContain("Return JSON.");
  });

  it("strips a markdown code fence around JSON", async () => {
    const res = await rt(runnerFor({ text: '```json\n{"answer":7}\n```' })).runTask(task);
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.output as { answer: number }).answer).toBe(7);
  });

  it("reports MALFORMED_OUTPUT for non-JSON text", async () => {
    const res = await rt(runnerFor({ text: "not json" })).runTask(task);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("MALFORMED_OUTPUT");
  });

  it("reports MALFORMED_OUTPUT for empty stdout", async () => {
    const res = await rt(runnerFor({ text: "" })).runTask(task);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("MALFORMED_OUTPUT");
  });

  it("reports CRASHED with the stderr detail on non-zero exit", async () => {
    const res = await rt(
      runnerFor({ code: 1, stderr: "Error: Agent error: quota exhausted" }),
    ).runTask(task);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("CRASHED");
      expect(res.error.message).toContain("quota exhausted");
      expect(res.error.message).not.toContain("Error:");
    }
  });

  it("reports TIMEOUT when the process is killed", async () => {
    const res = await rt(runnerFor({ code: null })).runTask(task);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("TIMEOUT");
  });

  it("rejects an invalid model before running", async () => {
    const res = await rt(runnerFor()).runTask({ ...task, model: "bad model!" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("PROTOCOL");
  });

  it("forwards a valid model as --model", async () => {
    let seenArgs: string[] = [];
    const runner: DevinRunner = async (args) => {
      seenArgs = args;
      return { stdout: '{"answer":1}\n', stderr: "", code: 0 };
    };
    await rt(runner).runTask({ ...task, model: "opus" });
    expect(seenArgs.slice(0, 2)).toEqual(["--model", "opus"]);
  });
});

describe("devin sessions", () => {
  it("uses a local opaque threadId and streams a one-shot turn", async () => {
    const rt = new DevinRuntime({
      env: { ...baseEnv, INTERVIEW_OS_DEVIN_BIN: process.execPath },
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

  it("errors on an unknown session", async () => {
    const rt = new DevinRuntime({
      env: { ...baseEnv, INTERVIEW_OS_DEVIN_BIN: process.execPath },
      workspaceDir,
      runner: runnerFor(),
    });
    const events: RuntimeEvent[] = [];
    for await (const e of rt.sendMessage("nope", { text: "hi" })) events.push(e);
    expect(events[0]?.type).toBe("error");
  });
});

describe("devin listModels", () => {
  it("parses `devin models list --format json` when the CLI supports it", async () => {
    const runner: DevinRunner = async (args) => {
      if (args[0] === "models") {
        return {
          stdout: JSON.stringify({ families: [{ models: [{ id: "opus" }, { id: "swe" }] }] }),
          stderr: "",
          code: 0,
        };
      }
      return { stdout: "", stderr: "", code: 0 };
    };
    const rt = new DevinRuntime({
      env: { ...baseEnv, INTERVIEW_OS_DEVIN_BIN: process.execPath },
      workspaceDir,
      runner,
    });
    const models = await rt.listModels();
    expect(models.map((m) => m.id).sort()).toEqual(["opus", "swe"]);
  });

  it("falls back to family aliases when `devin models` is unsupported", async () => {
    const runner: DevinRunner = async () => ({
      stdout: "",
      stderr: "error: unexpected argument 'models' found",
      code: 2,
    });
    const rt = new DevinRuntime({
      env: { ...baseEnv, INTERVIEW_OS_DEVIN_BIN: process.execPath },
      workspaceDir,
      runner,
    });
    const models = await rt.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.isDefault)).toBe(true);
  });
});
