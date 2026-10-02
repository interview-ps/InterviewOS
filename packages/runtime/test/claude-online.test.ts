import { describe, expect, it } from "vitest";
import { ClaudeCodeRuntime, findClaudeExecutable } from "@interview-os/runtime";

const LIVE = process.env.INTERVIEW_OS_LIVE_CLAUDE === "1";

/**
 * Opt-in smoke against a real local Claude Code install. Run with:
 *   INTERVIEW_OS_LIVE_CLAUDE=1 pnpm test:claude
 * Never runs in CI by default; no tokens are read or printed here.
 */
describe.skipIf(!LIVE)("claude live", () => {
  it("detects the CLI and completes a structured task", async () => {
    const env = process.env;
    const bin = await findClaudeExecutable(env);
    expect(bin, "claude CLI not found").toBeTruthy();
    const rt = new ClaudeCodeRuntime({
      env,
      workspaceDir: process.cwd(),
    });
    const res = await rt.runTask({
      taskId: "live-smoke",
      instructions: "Return the JSON object described by the schema.",
      input: { question: "what is 2+2?" },
      outputSchema: {
        type: "object",
        properties: { answer: { type: "number" } },
        required: ["answer"],
      },
      timeoutMs: 90_000,
    });
    expect(res.ok).toBe(true);
    await rt.dispose();
  }, 120_000);
});
