import { describe, expect, it } from "vitest";
import { DevinRuntime, findDevinExecutable } from "@interview-os/runtime";

const LIVE = process.env.INTERVIEW_OS_LIVE_DEVIN === "1";

/**
 * Opt-in smoke against a real local Devin CLI install (one-shot `devin -p`).
 *   INTERVIEW_OS_LIVE_DEVIN=1 pnpm test:devin
 */
describe.skipIf(!LIVE)("devin live", () => {
  it("detects the CLI and lists models", async () => {
    const env = process.env;
    const bin = await findDevinExecutable(env);
    expect(bin, "devin CLI not found").toBeTruthy();
    const rt = new DevinRuntime({ env, workspaceDir: process.cwd() });
    const models = await rt.listModels();
    expect(Array.isArray(models)).toBe(true);
    await rt.dispose();
  }, 120_000);

  it("runs a one-shot structured task", async () => {
    const rt = new DevinRuntime({ env: process.env, workspaceDir: process.cwd() });
    const res = await rt.runTask({
      taskId: "devin-live-smoke",
      instructions: "Return JSON.",
      input: {},
      outputSchema: { type: "object", properties: { answer: { type: "number" } } },
    });
    expect(res.ok).toBe(true);
    await rt.dispose();
  }, 120_000);
});
