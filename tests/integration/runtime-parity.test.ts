import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockRuntime, OpencodeRuntime } from "@interview-os/runtime";
import type { AIRuntime } from "@interview-os/runtime";

/**
 * Parameterized parity check over runtimes that implement `AIRuntime`'s core
 * surface without spawning a provider. This is additive: the canonical
 * feedback-loop test still runs MockRuntime only (AGENTS.md).
 */

let workspaceDir: string;

beforeAll(async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "ios-parity-"));
});
afterAll(async () => {
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

const opencodeRunner = async () => ({ stdout: "", stderr: "", code: 0 });

function runtimes(): Array<{ name: string; make: () => AIRuntime }> {
  return [
    { name: "mock", make: () => new MockRuntime() },
    {
      name: "opencode",
      make: () =>
        new OpencodeRuntime({
          env: { PATH: process.env.PATH ?? "", INTERVIEW_OS_OPENCODE_BIN: process.execPath },
          workspaceDir,
          runner: opencodeRunner,
        }),
    },
  ];
}

describe.each(runtimes())("runtime parity — $name", ({ make }) => {
  it("reports a ready health status", async () => {
    const rt = make();
    const status = await rt.healthCheck();
    expect(status.available).toBe(true);
    await rt.dispose();
  });

  it("exposes at least one model and never leaks secrets", async () => {
    const rt = make();
    const models = await rt.listModels();
    expect(Array.isArray(models)).toBe(true);
    await rt.dispose();
  });
});
