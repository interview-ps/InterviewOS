import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CodexRuntime } from "../src/codex/CodexRuntime.js";
import { codexHealthCheck } from "../src/codex/detect.js";
import type { RuntimeEvent } from "../src/index.js";

const FAKE_CODEX = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../tests/fixtures/fake-codex.mjs",
);

let workspaceDir: string;
const baseEnv = { ...process.env, SECRET_TOKEN: "super-secret-value" };

function fakeEnv(mode: string): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    INTERVIEW_OS_CODEX_BIN: FAKE_CODEX,
    FAKE_CODEX_MODE: mode,
  };
}

function fakeRuntime(mode: string): CodexRuntime {
  return new CodexRuntime({
    env: fakeEnv(mode),
    workspaceDir,
    extraChildEnv: { prefixes: ["FAKE_CODEX_"] },
  });
}

beforeAll(async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "ios-codex-test-"));
});

afterAll(async () => {
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

const task = {
  taskId: "test-task",
  instructions: "Return JSON. PROMPT_MARKER-12345",
  input: { x: 1 },
  outputSchema: { type: "object", properties: { answer: { type: "number" } } },
  taskMode: "exec" as const,
};

function recordedRuntime(mode: string, recordPath: string): CodexRuntime {
  return new CodexRuntime({
    env: { ...fakeEnv(mode), FAKE_CODEX_RECORD: recordPath },
    workspaceDir,
    extraChildEnv: { prefixes: ["FAKE_CODEX_"] },
  });
}

let recordSeq = 0;
const recordPath = () =>
  path.join(workspaceDir, `record-${Date.now()}-${recordSeq++}.jsonl`);

async function readRecord(p: string): Promise<Array<Record<string, unknown>>> {
  try {
    return (await fs.readFile(p, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

describe("detect / healthCheck", () => {
  it("reports unavailable for a bogus bin path", async () => {
    const status = await codexHealthCheck(
      { ...baseEnv, INTERVIEW_OS_CODEX_BIN: "/nonexistent/codex" },
      workspaceDir,
    );
    expect(status.available).toBe(false);
    expect(status.status).toBe("unavailable");
    expect(status.message).toContain("codex login");
  });

  it("reports ready and parses the version for a working bin", async () => {
    const status = await codexHealthCheck(fakeEnv("ok"), workspaceDir);
    expect(status.available).toBe(true);
    expect(status.status).toBe("ready");
    expect(status.version).toBe("0.157.0");
    expect(status.executable).toBe(FAKE_CODEX);
  });
});

describe("runTask (codex exec)", () => {
  it("fails UNAVAILABLE when codex cannot be found", async () => {
    const rt = new CodexRuntime({
      env: { ...baseEnv, INTERVIEW_OS_CODEX_BIN: "/nonexistent/codex" },
      workspaceDir,
    });
    const result = await rt.runTask(task);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNAVAILABLE");
  });

  it("parses the last agent_message as structured output", async () => {
    const rt = fakeRuntime("ok");
    const result = await rt.runTask(task);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const output = result.output as {
      answer: number;
      argv: string[];
      env: { SECRET_TOKEN: boolean };
      promptMarkerSeen: boolean;
    };
    expect(output.answer).toBe(42);
    // malformed stdout line was tolerated and recorded
    expect(result.events.some((e) => e.type === "malformed_event")).toBe(true);
    // prompt delivered via stdin, never argv
    expect(output.promptMarkerSeen).toBe(true);
    expect(output.argv.join(" ")).not.toContain("PROMPT_MARKER");
    // SECRET_TOKEN is stripped from the child env
    expect(output.env.SECRET_TOKEN).toBe(false);
  });

  it("reports CRASHED on non-zero exit", async () => {
    const rt = fakeRuntime("crash");
    const result = await rt.runTask(task);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CRASHED");
      expect(result.error.message).toContain("simulated crash");
    }
  });

  it("reports MALFORMED_EVENT when no agent_message arrives", async () => {
    const rt = fakeRuntime("malformed-event");
    const result = await rt.runTask(task);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("MALFORMED_EVENT");
  });

  it("reports MALFORMED_OUTPUT when the agent message is not JSON", async () => {
    const rt = fakeRuntime("malformed-output");
    const result = await rt.runTask(task);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("MALFORMED_OUTPUT");
  });

  it("reports TIMEOUT and kills a hung child", async () => {
    const rt = fakeRuntime("hang");
    const result = await rt.runTask({ ...task, timeoutMs: 1500 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TIMEOUT");
  });

  it("cleans up the temp schema dir", async () => {
    const rt = fakeRuntime("ok");
    await rt.runTask(task);
    const tmp = path.join(workspaceDir, ".tmp");
    const entries = await fs.readdir(tmp).catch(() => [] as string[]);
    expect(entries).toEqual([]);
  });

  it("exec mode passes model/effort via argv (-m / -c)", async () => {
    const rec = recordPath();
    const rt = recordedRuntime("ok", rec);
    const result = await rt.runTask({ ...task, model: "fake-large", effort: "high" });
    expect(result.ok).toBe(true);
    const recs = await readRecord(rec);
    const exec = recs.find((r) => r.event === "exec") as { argv: string[] };
    const argv = exec.argv;
    expect(argv[argv.indexOf("-m") + 1]).toBe("fake-large");
    expect(argv).toContain('model_reasoning_effort="high"');
  });
});

describe("runTask (app-server task mode)", () => {
  it("streams deltas via onEvent and parses the final message (default mode)", async () => {
    const rec = recordPath();
    const rt = recordedRuntime("ok", rec);
    try {
      const seen: RuntimeEvent[] = [];
      // no taskMode → default is app-server
      const result = await rt.runTask({
        taskId: "app-task",
        instructions: "Return JSON.",
        input: { x: 1 },
        outputSchema: { type: "object", properties: { answer: { type: "number" } } },
        onEvent: (e) => seen.push(e),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const output = result.output as { answer: number; approvalDeclined: boolean };
      expect(output.answer).toBe(42);
      expect(output.approvalDeclined).toBe(true);
      const deltas = seen.filter((e) => e.type === "delta");
      expect(deltas.length).toBe(2);
      expect(deltas.map((d) => (d as { text: string }).text).join("")).toBe(result.raw);
      expect(seen[0]?.type).toBe("started");
      expect(result.events).toEqual(seen);

      const recs = await readRecord(rec);
      const threadStart = recs.find((r) => r.event === "thread/start");
      expect(threadStart?.ephemeral).toBe(true);
      const turnStart = recs.find((r) => r.event === "turn/start");
      expect(turnStart?.outputSchema).toBe(true);
    } finally {
      await rt.dispose();
    }
  });

  it("reports MALFORMED_OUTPUT when the final message is not JSON", async () => {
    const rt = fakeRuntime("malformed-output");
    try {
      const result = await rt.runTask({ ...task, taskMode: "app-server" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("MALFORMED_OUTPUT");
    } finally {
      await rt.dispose();
    }
  });

  it("reports TIMEOUT and sends turn/interrupt on a hung turn", async () => {
    const rec = recordPath();
    const rt = recordedRuntime("hang", rec);
    try {
      const result = await rt.runTask({
        ...task,
        taskMode: "app-server",
        timeoutMs: 1200,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("TIMEOUT");
      const recs = await readRecord(rec);
      expect(recs.some((r) => r.event === "turn/interrupt")).toBe(true);
    } finally {
      await rt.dispose();
    }
  }, 15_000);

  it("reports CRASHED mid-turn; the next task restarts the process and works", async () => {
    const rec = recordPath();
    const rt = recordedRuntime("app-crash-midturn-once", rec);
    try {
      const crashed = await rt.runTask({ ...task, taskMode: "app-server" });
      expect(crashed.ok).toBe(false);
      if (!crashed.ok) expect(crashed.error.code).toBe("CRASHED");

      const after = await rt.runTask({ ...task, taskMode: "app-server" });
      expect(after.ok).toBe(true);
      if (after.ok) expect((after.output as { answer: number }).answer).toBe(42);
    } finally {
      await rt.dispose();
    }
  }, 15_000);

  it("passes model/effort through thread/start + turn/start params", async () => {
    const rec = recordPath();
    const rt = recordedRuntime("ok", rec);
    try {
      const result = await rt.runTask({
        ...task,
        taskMode: "app-server",
        model: "fake-large",
        effort: "high",
      });
      expect(result.ok).toBe(true);
      const recs = await readRecord(rec);
      expect(recs.find((r) => r.event === "thread/start")?.model).toBe("fake-large");
      const turn = recs.find((r) => r.event === "turn/start");
      expect(turn?.model).toBe("fake-large");
      expect(turn?.effort).toBe("high");
    } finally {
      await rt.dispose();
    }
  });

  it("rejects an invalid model before spawning anything", async () => {
    const rec = recordPath();
    const rt = recordedRuntime("ok", rec);
    try {
      for (const taskMode of ["app-server", "exec"] as const) {
        const result = await rt.runTask({
          ...task,
          taskMode,
          model: "bad model!!",
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe("PROTOCOL");
        const result2 = await rt.runTask({
          ...task,
          taskMode,
          effort: "extreme" as "low",
        });
        expect(result2.ok).toBe(false);
      }
      expect(await readRecord(rec)).toEqual([]);
    } finally {
      await rt.dispose();
    }
  });

  it("listModels paginates model/list and maps effort options", async () => {
    const rt = fakeRuntime("ok");
    try {
      const models = await rt.listModels();
      expect(models.map((m) => m.id)).toEqual(["fake-small", "fake-large"]);
      expect(models[0]?.displayName).toBe("Fake Small");
      expect(models[0]?.supportedReasoningEfforts).toEqual(["low", "medium"]);
      expect(models[0]?.defaultReasoningEffort).toBe("medium");
      expect(models[1]?.defaultReasoningEffort).toBe("high");
    } finally {
      await rt.dispose();
    }
  });
});

describe("app-server sessions", () => {
  it("runs a multi-turn session and declines approval requests", async () => {
    const rt = fakeRuntime("ok");
    try {
      const session = await rt.createSession({ instructions: "be helpful" });
      expect(session.threadId).toBe("thread-1");

      const collect = async (text: string) => {
        const events: RuntimeEvent[] = [];
        for await (const e of rt.sendMessage(session.id, { text, outputSchema: { type: "object" } })) {
          events.push(e);
        }
        return events;
      };

      const turn1 = await collect("first");
      const last1 = turn1.at(-1)!;
      expect(last1.type).toBe("completed");
      if (last1.type === "completed") {
        const out = last1.output as { answer: number; approvalDeclined: boolean };
        expect(out.answer).toBe(42);
        expect(out.approvalDeclined).toBe(true);
      }
      expect(turn1.some((e) => e.type === "delta")).toBe(true);
      expect(turn1.some((e) => e.type === "message")).toBe(true);

      const turn2 = await collect("second");
      const last2 = turn2.at(-1)!;
      expect(last2.type).toBe("completed");
      if (last2.type === "completed") {
        expect((last2.output as { turn: number }).turn).toBe(2);
      }
    } finally {
      await rt.dispose();
    }
  });

  it("resumes threads after an app-server crash", async () => {
    const rt = fakeRuntime("app-crash-once");
    try {
      const session = await rt.createSession({});
      const drain = async () => {
        const events: RuntimeEvent[] = [];
        for await (const e of rt.sendMessage(session.id, { text: "go", outputSchema: {} })) {
          events.push(e);
        }
        return events;
      };
      const first = await drain();
      expect(first.at(-1)?.type).toBe("completed");

      // fake app-server exited after the first turn; next message must
      // restart the process, re-initialize, and resume the thread
      const second = await drain();
      const last = second.at(-1)!;
      expect(last.type).toBe("completed");
      if (last.type === "completed") {
        // the fake restarted fresh, so its turn counter reset — proof the
        // restart + thread/resume path worked at all
        expect((last.output as { answer: number }).answer).toBe(42);
      }
    } finally {
      await rt.dispose();
    }
  });
});
