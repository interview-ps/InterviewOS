import { describe, expect, it } from "vitest";
import { OpencodeRuntime, findOpencodeExecutable } from "@interview-os/runtime";

const LIVE = process.env.INTERVIEW_OS_LIVE_OPENCODE === "1";

/**
 * Opt-in smoke against a real local opencode install (one-shot `opencode run`).
 *   INTERVIEW_OS_LIVE_OPENCODE=1 pnpm test:opencode
 */
describe.skipIf(!LIVE)("opencode live", () => {
  it("detects the CLI and lists provider models", async () => {
    const env = process.env;
    const bin = await findOpencodeExecutable(env);
    expect(bin, "opencode CLI not found").toBeTruthy();
    const rt = new OpencodeRuntime({ env, workspaceDir: process.cwd() });
    const models = await rt.listModels();
    expect(Array.isArray(models)).toBe(true);
    await rt.dispose();
  }, 120_000);
});
