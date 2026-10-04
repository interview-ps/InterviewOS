import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defineSkill, isDefinedSkill } from "../src/index.js";
import { runPluginWithMock, validatePlugin } from "../src/testing.js";
import type { SkillManifest } from "@interview-os/core";

const BIN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "bin",
  "interview-os.mjs",
);

const manifest: SkillManifest = {
  id: "t",
  version: "1.0.0",
  kind: "plugin",
  description: "",
  name: "t",
  author: "",
  capabilities: [],
  outputs: [],
  permissions: ["candidate.read"],
  inputs: [{ key: "candidate", permission: "candidate.read" }],
};

describe("defineSkill", () => {
  it("tags the definition with a non-enumerable marker", () => {
    const def = defineSkill({
      id: "t",
      permissions: [],
      execute: () => ({ ok: true }),
    });
    expect(isDefinedSkill(def)).toBe(true);
    expect(Object.keys(def)).not.toContain("__interviewOsSkill");
    expect(JSON.stringify(def)).not.toContain("interviewOsSkill");
  });
});

describe("runPluginWithMock", () => {
  it("passes only declared + granted slices", async () => {
    const def = defineSkill({
      id: "t",
      permissions: ["candidate.read"],
      execute: ({ input }) => ({ keys: Object.keys(input).sort() }),
    });
    const { output } = await runPluginWithMock({
      plugin: def,
      manifest,
      slices: { candidate: { id: "c" }, target: { id: "x" } },
    });
    expect((output as { keys: string[] }).keys).toEqual(["candidate"]);
  });

  it("omits runtime without runtime.invoke and provides it with the grant", async () => {
    const noRuntime = defineSkill({
      id: "t",
      permissions: ["candidate.read"],
      execute: ({ runtime }) => ({ hasRuntime: runtime !== undefined }),
    });
    expect(
      (
        (await runPluginWithMock({ plugin: noRuntime, manifest }))
          .output as { hasRuntime: boolean }
      ).hasRuntime,
    ).toBe(false);

    const m2: SkillManifest = {
      ...manifest,
      permissions: ["candidate.read", "runtime.invoke"],
    };
    const withRuntime = defineSkill({
      id: "t",
      permissions: ["candidate.read", "runtime.invoke"],
      execute: async ({ runtime }) => {
        const r = await runtime!.runTask({
          taskId: "demo",
          instructions: "",
          input: {},
          outputSchema: {},
        });
        return { ok: r.ok, output: r.ok ? r.output : null };
      },
    });
    const { output } = await runPluginWithMock({
      plugin: withRuntime,
      manifest: m2,
      mockHandlers: { demo: () => ({ answer: 42 }) },
    });
    expect(output).toEqual({ ok: true, output: { answer: 42 } });
  });

  it("rejects oversized or invalid evidence proposals", async () => {
    const bad = defineSkill({
      id: "t",
      permissions: [],
      execute: () => ({ evidenceProposals: [{ skillId: "bad id" }] }),
    });
    await expect(runPluginWithMock({ plugin: bad })).rejects.toThrow(
      /evidenceProposals/,
    );

    const good = defineSkill({
      id: "t",
      permissions: [],
      execute: () => ({
        evidenceProposals: [
          {
            skillId: "sql.indexing",
            score: 0.7,
            confidence: 0.4,
            observation: "ok",
          },
        ],
      }),
    });
    const { evidenceProposals } = await runPluginWithMock({ plugin: good });
    expect(evidenceProposals).toHaveLength(1);
  });
});

describe("cli", () => {
  it("create-skill scaffolds a plugin that validates and runs", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ios-sdk-"));
    execFileSync(process.execPath, [BIN, "create-skill", "my-skill", "--dir", parent], {
      encoding: "utf8",
    });
    const dir = path.join(parent, "my-skill");
    for (const f of ["skill.yaml", "index.ts", "tests/index.test.ts", "README.md"]) {
      expect(fs.existsSync(path.join(dir, f)), f).toBe(true);
    }

    const out = execFileSync(process.execPath, [BIN, "validate", dir], {
      encoding: "utf8",
    });
    expect(out).toMatch(/ok: my-skill@0\.1\.0/);
  });

  it("create-skill refuses an existing dir and bad names", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ios-sdk-"));
    execFileSync(process.execPath, [BIN, "create-skill", "dup", "--dir", parent]);
    expect(() =>
      execFileSync(process.execPath, [BIN, "create-skill", "dup", "--dir", parent], {
        stdio: "pipe",
      }),
    ).toThrow();
    expect(() =>
      execFileSync(process.execPath, [BIN, "create-skill", "BAD NAME", "--dir", parent], {
        stdio: "pipe",
      }),
    ).toThrow();
  });

  it("validatePlugin detects permission drift", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ios-sdk-"));
    execFileSync(process.execPath, [BIN, "create-skill", "drift", "--dir", parent]);
    const dir = path.join(parent, "drift");
    fs.writeFileSync(
      path.join(dir, "index.ts"),
      `import { defineSkill } from "@interview-os/plugin-sdk";
export default defineSkill({
  id: "drift",
  permissions: ["candidate.read", "evidence.write"],
  execute: () => ({}),
});
`,
    );
    const result = await validatePlugin(dir).then(
      () => ({ ok: true as const }),
      (err: Error) => ({ ok: false as const, err }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.message).toMatch(/evidence\.write/);
  });
});
