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
};

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
