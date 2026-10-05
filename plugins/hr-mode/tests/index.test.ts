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
  "motivation",
  "careerGoals",
  "cultureFit",
  "workStyle",
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

describe("hr-mode", () => {
  it("declares the hr mode with include scope and rubric", () => {
    const mode = manifest.modes?.[0];
    expect(mode?.id).toBe("hr");
    expect(mode?.scope.include).toEqual(["hr"]);
    expect(mode?.rubric.map((r) => r.id)).toEqual(RUBRIC_IDS);
    expect(mode?.context).toEqual({ companyThemes: true, storyTitles: true });
  });

  it("mode.reduce appends new question topics to themesCovered", async () => {
    const { output } = await runPluginWithMock({
      plugin,
      manifest,
      hook: "mode.reduce",
      request: {
        modeId: "hr",
        state: { themesCovered: [] },
        evaluation: SAMPLE_EVALUATION,
        question: { skillId: "hr.motivation", topic: "Motivation", extra: {} },
      },
    });
    const state = (output as { state: Record<string, unknown> }).state;
    expect(state.themesCovered).toEqual(["Motivation"]);
  });

  it("mode.mock interviewer follow-up digs into the focus", async () => {
    const { output } = await runPluginWithMock({
      plugin,
      manifest,
      hook: "mode.mock",
      request: {
        modeId: "hr",
        task: "interviewer",
        input: {
          skillId: "hr.motivation",
          label: "Motivation",
          previousQuestions: [],
          followUp: { parentQuestion: "q", focus: "career goals" },
        },
      },
    });
    const out = (output as { output: Record<string, unknown> }).output;
    expect(String(out.question)).toContain("career goals");
  });

  it("mode.mock evaluator scores the hr rubric", async () => {
    const { output } = await runPluginWithMock({
      plugin,
      manifest,
      hook: "mode.mock",
      request: {
        modeId: "hr",
        task: "evaluator",
        input: {
          question: {
            text: "What motivates you?",
            skillId: "hr.motivation",
            expectedConcepts: [],
          },
          answer:
            "I'm excited about this role because I want to grow. I value a team culture with feedback.",
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
    expect(res.hookResults.map((r) => r.hook).sort()).toEqual([
      "mode.mock",
      "mode.reduce",
    ]);
  });
});
