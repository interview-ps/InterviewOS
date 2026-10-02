import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CodexRuntime } from "../src/codex/CodexRuntime.js";
import type { RuntimeEvent } from "../src/index.js";

const LIVE = process.env.INTERVIEW_OS_LIVE_CODEX === "1";

describe.skipIf(!LIVE)("live codex runtime", () => {
  it("healthCheck, runTask, and one app-server session turn", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "ios-codex-live-"));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      INTERVIEW_OS_CODEX_TIMEOUT_MS: "90000",
    };
    delete env.INTERVIEW_OS_RUNTIME;
    const rt = new CodexRuntime({ env, workspaceDir });
    try {
      const status = await rt.healthCheck();
      expect(status.available, status.message).toBe(true);
      expect(status.status).toBe("ready");

      const taskResult = await rt.runTask({
        taskId: "live-smoke",
        instructions:
          "Return a JSON object answering the input question. Output only JSON per the schema.",
        input: { question: "What is 6 * 7? Put the number in `answer`." },
        outputSchema: {
          type: "object",
          properties: { answer: { type: "number" } },
          required: ["answer"],
          additionalProperties: false,
        },
        timeoutMs: 90_000,
      });
      expect(taskResult.ok, !taskResult.ok ? taskResult.error.message : "").toBe(true);
      if (taskResult.ok) {
        expect((taskResult.output as { answer: number }).answer).toBe(42);
      }

      const session = await rt.createSession({
        developerInstructions: "Reply with short JSON: {\"echo\": <the text you received>}",
      });
      const events: RuntimeEvent[] = [];
      for await (const e of rt.sendMessage(session.id, {
        text: "ping",
        outputSchema: {
          type: "object",
          properties: { echo: { type: "string" } },
          required: ["echo"],
          additionalProperties: false,
        },
      })) {
        events.push(e);
      }
      const last = events.at(-1)!;
      expect(last.type).toBe("completed");
      if (last.type === "completed") {
        expect((last.output as { echo: string }).echo).toContain("ping");
      }
    } finally {
      await rt.dispose();
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  }, 240_000);
});
