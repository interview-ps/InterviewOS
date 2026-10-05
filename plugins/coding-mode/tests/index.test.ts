import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  runContractTests,
  runPluginWithMock,
} from "@interview-os/plugin-sdk/testing";
import { loadManifestFile } from "@interview-os/plugin-sdk";
import { validateUITree } from "@interview-os/core";
import plugin from "../index.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = await loadManifestFile(dir);

const RUBRIC_IDS = [
  "problemUnderstanding",
  "approach",
  "correctness",
  "complexity",
  "edgeCases",
  "codeQuality",
  "communication",
];

describe("coding-mode", () => {
  it("declares the coding mode with the coding rubric and text+code format", () => {
    const mode = manifest.modes?.[0];
    expect(mode?.id).toBe("coding");
    expect(mode?.scope).toEqual({ include: ["coding"], exclude: [] });
    expect(mode?.answerFormat).toBe("text+code");
    expect(mode?.rubric.map((r) => r.id)).toEqual(RUBRIC_IDS);
    expect(mode?.followUpRules).toEqual([
      { rubricId: "complexity", below: 0.6, focus: "complexity analysis" },
      { rubricId: "edgeCases", below: 0.6, focus: "edge cases" },
    ]);
    expect(mode?.reduce).toEqual({
      copyExtra: ["problem"],
      set: { phase: "working" },
    });
    expect(mode?.initialState).toEqual({ problem: null, phase: "briefing" });
  });

  it("mode.mock interviewer returns a self-contained coding problem", async () => {
    const { output } = await runPluginWithMock({
      plugin,
      manifest,
      hook: "mode.mock",
      request: {
        modeId: "coding",
        task: "interviewer",
        input: {
          skillId: "coding.algorithms",
          label: "Algorithms",
          previousQuestions: [],
          followUp: null,
        },
      },
    });
    const out = (output as { output: Record<string, unknown> }).output;
    const problem = out.problem as {
      title: string;
      statement: string;
      constraints: string[];
      examples: { input: string; output: string }[];
    };
    expect(problem.title).toBeTruthy();
    expect(problem.statement).toBeTruthy();
    expect(problem.constraints.length).toBeGreaterThan(0);
    expect(problem.examples.length).toBeGreaterThan(0);
    expect(out.skillId).toBe("coding.algorithms");
    expect(String(out.question)).toContain(problem.title);
  });

  it("mode.mock interviewer follow-up keeps problem null", async () => {
    const { output } = await runPluginWithMock({
      plugin,
      manifest,
      hook: "mode.mock",
      request: {
        modeId: "coding",
        task: "interviewer",
        input: {
          skillId: "coding.algorithms",
          label: "Algorithms",
          previousQuestions: [],
          followUp: { parentQuestion: "q", focus: "complexity analysis" },
        },
      },
    });
    const out = (output as { output: Record<string, unknown> }).output;
    expect(out.problem).toBeNull();
    expect(String(out.question)).toContain("complexity analysis");
  });

  it("mode.mock evaluator scores exactly the coding rubric", async () => {
    const { output } = await runPluginWithMock({
      plugin,
      manifest,
      hook: "mode.mock",
      request: {
        modeId: "coding",
        task: "evaluator",
        input: {
          question: {
            text: "Merge intervals",
            skillId: "coding.algorithms",
            expectedConcepts: [
              { concept: "sort by start", skillId: "coding.algorithms", keywords: ["sort"] },
            ],
          },
          answer:
            "My approach is to sort the intervals by start, then merge in one pass. O(n log n) time complexity. Edge cases: empty input.",
          code: "function merge(intervals) { /* sort + sweep */ return intervals; }",
          language: "typescript",
        },
      },
    });
    const out = (output as {
      output: {
        rubric: { id: string; score: number }[];
        scores: { skill: string; score: number }[];
        missingConcepts: string[];
      };
    }).output;
    expect(out.rubric.map((r) => r.id)).toEqual(RUBRIC_IDS);
    expect(out.rubric.find((r) => r.id === "complexity")!.score).toBeGreaterThan(0.5);
    expect(out.scores.some((s) => s.skill === "coding.complexity")).toBe(true);
    expect(out.scores.some((s) => s.skill === "coding.edge-cases")).toBe(true);
  });

  it("ui.render coding-problem renders the problem panel", async () => {
    const { output } = await runPluginWithMock({
      plugin,
      manifest,
      hook: "ui.render",
      request: {
        slot: "interview.question",
        component: "coding-problem",
        params: {
          modeId: "coding",
          extra: {
            problem: {
              title: "LRU cache",
              statement: "Implement an LRU cache…",
              constraints: ["capacity ≥ 1", "both operations O(1)"],
              examples: [{ input: "cap=2", output: "key 2 evicted" }],
            },
          },
        },
      },
    });
    const tree = validateUITree((output as { ui?: unknown }).ui, {
      pluginId: manifest.id,
    }) as { type: string; title?: string; children?: { type: string }[] };
    expect(tree.type).toBe("card");
    expect(tree.title).toBe("LRU cache");
    expect(tree.children?.some((c) => c.type === "list")).toBe(true);
  });

  it("ui.render tolerates a missing/invalid problem", async () => {
    const { output } = await runPluginWithMock({
      plugin,
      manifest,
      hook: "ui.render",
      request: {
        slot: "interview.question",
        component: "coding-problem",
        params: { modeId: "coding", extra: {} },
      },
    });
    const tree = validateUITree((output as { ui?: unknown }).ui, {
      pluginId: manifest.id,
    });
    expect(tree.type).toBe("emptyState");
  });

  it("contract tests pass for declared hooks", async () => {
    const res = await runContractTests({ dir });
    expect(res.ok).toBe(true);
    expect(res.hookResults.map((r) => r.hook).sort()).toEqual([
      "mode.mock",
      "ui.render",
    ]);
  });
});
