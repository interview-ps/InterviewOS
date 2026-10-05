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
  "situationClarity",
  "ownership",
  "actions",
  "decisionMaking",
  "impact",
  "results",
  "reflection",
  "communication",
];

const SAMPLE_EVALUATION = {
  summary: "s",
  dimensions: {},
  strengths: [],
  weaknesses: [],
  scores: [],
  missingConcepts: [],
  betterApproach: "",
  followUpTopics: [],
  star: null,
  rubric: [],
  designUpdates: null,
};

describe("behavioral-mode", () => {
  it("declares the behavioral mode with include scope, rubric and context", () => {
    const mode = manifest.modes?.[0];
    expect(mode?.id).toBe("behavioral");
    expect(mode?.scope.include).toEqual(["behavioral", "communication"]);
    expect(mode?.rubric.map((r) => r.id)).toEqual(RUBRIC_IDS);
    expect(mode?.initialState).toEqual({
      storyIdsUsed: [],
      competenciesCovered: [],
    });
    expect(mode?.context).toEqual({ companyThemes: true, storyTitles: true });
  });

  it("mode.reduce tracks story ids and covered competencies", async () => {
    const { output } = await runPluginWithMock({
      plugin,
      manifest,
      hook: "mode.reduce",
      request: {
        modeId: "behavioral",
        state: {
          storyIdsUsed: ["s1"],
          competenciesCovered: ["behavioral.ownership"],
        },
        evaluation: SAMPLE_EVALUATION,
        question: {
          skillId: "behavioral.conflict",
          topic: "Conflict",
          extra: { storyId: "s2" },
        },
      },
    });
    const state = (output as { state: Record<string, unknown> }).state;
    expect(state.storyIdsUsed).toEqual(["s1", "s2"]);
    expect(state.competenciesCovered).toEqual([
      "behavioral.ownership",
      "behavioral.conflict",
    ]);
  });

  it("mode.reduce ignores a repeated story id", async () => {
    const { output } = await runPluginWithMock({
      plugin,
      manifest,
      hook: "mode.reduce",
      request: {
        modeId: "behavioral",
        state: { storyIdsUsed: ["s1"], competenciesCovered: [] },
        evaluation: SAMPLE_EVALUATION,
        question: {
          skillId: "behavioral.teamwork",
          topic: "t",
          extra: { storyId: "s1" },
        },
      },
    });
    const state = (output as { state: Record<string, unknown> }).state;
    expect(state.storyIdsUsed).toEqual(["s1"]);
  });

  it("mode.mock evaluator is STAR-aware and scores the behavioral rubric", async () => {
    const { output } = await runPluginWithMock({
      plugin,
      manifest,
      hook: "mode.mock",
      request: {
        modeId: "behavioral",
        task: "evaluator",
        input: {
          question: {
            text: "Tell me about a conflict",
            skillId: "behavioral.conflict",
            expectedConcepts: [],
          },
          answer:
            "When I was at Acme, the situation was a heated disagreement. My task was to align the team. I organized a meeting because we needed consensus. As a result, delivery improved by 20%.",
        },
      },
    });
    const out = (output as {
      output: {
        rubric: { id: string }[];
        star: { situation: boolean; result: boolean } | null;
      };
    }).output;
    expect(out.rubric.map((r) => r.id)).toEqual(RUBRIC_IDS);
    expect(out.star?.situation).toBe(true);
    expect(out.star?.result).toBe(true);
  });

  it("mode.mock interviewer follow-up stays with the story", async () => {
    const { output } = await runPluginWithMock({
      plugin,
      manifest,
      hook: "mode.mock",
      request: {
        modeId: "behavioral",
        task: "interviewer",
        input: {
          skillId: "behavioral.conflict",
          label: "Conflict",
          previousQuestions: [],
          followUp: { parentQuestion: "q", focus: "the result" },
        },
      },
    });
    const out = (output as { output: Record<string, unknown> }).output;
    expect(String(out.question)).toContain("the result");
    expect(out.problem).toBeNull();
  });

  it("contract tests pass for declared hooks", async () => {
    const res = await runContractTests({ dir });
    expect(res.ok).toBe(true);
    expect(res.hookResults.map((r) => r.hook).sort()).toEqual([
      "mode.mock",
      "mode.reduce",
    ]);
  });
});
