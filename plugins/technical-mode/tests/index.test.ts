import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  runContractTests,
  runPluginWithMock,
} from "@interview-os/plugin-sdk/testing";
import { loadManifestFile } from "@interview-os/plugin-sdk";
import plugin from "../index.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = await loadManifestFile(dir);

const RUBRIC_IDS = [
  "correctness",
  "technicalDepth",
  "reasoning",
  "communication",
  "roleRelevance",
];

describe("technical-mode", () => {
  it("declares the technical mode with exclusion scope and the 5-dim rubric", () => {
    const mode = manifest.modes?.[0];
    expect(mode?.id).toBe("technical");
    expect(mode?.scope.include).toEqual([]);
    expect(mode?.scope.exclude).toEqual([
      "system-design",
      "behavioral",
      "communication",
      "hr",
      "coding",
      "hiring-manager",
    ]);
    expect(mode?.rubric.map((r) => r.id)).toEqual(RUBRIC_IDS);
    expect(mode?.followUp ?? "generic").toBe("generic");
  });

  it("mode.mock interviewer returns a plain technical question", async () => {
    const { output } = await runPluginWithMock({
      plugin,
      manifest,
      hook: "mode.mock",
      request: {
        modeId: "technical",
        task: "interviewer",
        input: {
          skillId: "sql.indexing",
          label: "Indexing",
          previousQuestions: [],
          followUp: null,
          skillKeywords: ["b-tree", "index", "covering index"],
        },
      },
    });
    const out = (output as { output: Record<string, unknown> }).output;
    expect(typeof out.question).toBe("string");
    expect(String(out.question).length).toBeGreaterThan(0);
    expect(out.skillId).toBe("sql.indexing");
    expect(out.problem).toBeNull();
    expect(out.focusDimension).toBeNull();
  });

  it("mode.mock interviewer follow-up probes the focus", async () => {
    const { output } = await runPluginWithMock({
      plugin,
      manifest,
      hook: "mode.mock",
      request: {
        modeId: "technical",
        task: "interviewer",
        input: {
          skillId: "sql.indexing",
          label: "Indexing",
          previousQuestions: [],
          followUp: { parentQuestion: "q", focus: "b-tree internals" },
        },
      },
    });
    const out = (output as { output: Record<string, unknown> }).output;
    expect(String(out.question)).toContain("b-tree internals");
  });

  it("mode.mock evaluator scores exactly the technical rubric", async () => {
    const { output } = await runPluginWithMock({
      plugin,
      manifest,
      hook: "mode.mock",
      request: {
        modeId: "technical",
        task: "evaluator",
        input: {
          question: {
            text: "Explain indexing",
            skillId: "sql.indexing",
            expectedConcepts: [
              { concept: "b-tree", skillId: "sql.indexing", keywords: ["b-tree"] },
            ],
          },
          answer: "A B-tree index keeps keys sorted for range lookups.",
        },
      },
    });
    const out = (output as {
      output: { rubric: { id: string; score: number }[] };
    }).output;
    expect(out.rubric.map((r) => r.id)).toEqual(RUBRIC_IDS);
  });

  it("contract tests pass for declared hooks", async () => {
    const res = await runContractTests({ dir });
    expect(res.ok).toBe(true);
    expect(res.hookResults.map((r) => r.hook)).toEqual(["mode.mock"]);
  });
});
