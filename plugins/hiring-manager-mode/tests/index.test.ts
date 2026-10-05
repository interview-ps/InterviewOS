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
  "roleFit",
  "scopeImpact",
  "prioritization",
  "leadership",
  "collaboration",
  "motivation",
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

describe("hiring-manager-mode", () => {
  it("declares the hiring_manager mode with include scope and rubric", () => {
    const mode = manifest.modes?.[0];
    expect(mode?.id).toBe("hiring_manager");
    expect(mode?.scope.include).toEqual([
      "hiring-manager",
      "behavioral.leadership",
      "communication",
    ]);
    expect(mode?.rubric.map((r) => r.id)).toEqual(RUBRIC_IDS);
    expect(mode?.context).toEqual({ companyThemes: true, storyTitles: true });
  });

  it("mode.reduce appends new question topics to themesCovered", async () => {
    const { output } = await runPluginWithMock({
      plugin,
      manifest,
      hook: "mode.reduce",
      request: {
        modeId: "hiring_manager",
        state: { themesCovered: ["Why this team"] },
        evaluation: SAMPLE_EVALUATION,
        question: {
          skillId: "hiring-manager.scope-impact",
          topic: "Scope and impact",
          extra: {},
        },
      },
    });
    const state = (output as { state: Record<string, unknown> }).state;
    expect(state.themesCovered).toEqual(["Why this team", "Scope and impact"]);
  });

  it("mode.mock interviewer picks a hiring-manager question", async () => {
    const { output } = await runPluginWithMock({
      plugin,
      manifest,
      hook: "mode.mock",
      request: {
        modeId: "hiring_manager",
        task: "interviewer",
        input: {
          skillId: "hiring-manager.scope-impact",
          label: "Scope & impact",
          previousQuestions: [],
          followUp: null,
        },
      },
    });
    const out = (output as { output: Record<string, unknown> }).output;
    expect(String(out.question)).toContain("impactful project");
    expect(out.problem).toBeNull();
    expect(out.focusDimension).toBeNull();
  });

  it("mode.mock evaluator scores the hiring-manager rubric", async () => {
    const { output } = await runPluginWithMock({
      plugin,
      manifest,
      hook: "mode.mock",
      request: {
        modeId: "hiring_manager",
        task: "evaluator",
        input: {
          question: {
            text: "Why this team?",
            skillId: "hiring-manager.role-fit",
            expectedConcepts: [],
          },
          answer:
            "I'm excited because this team owns the platform. I led a team of 6, grew users 40%, and want to lead here.",
        },
      },
    });
    const out = (output as {
      output: { rubric: { id: string; score: number }[] };
    }).output;
    expect(out.rubric.map((r) => r.id)).toEqual(RUBRIC_IDS);
    expect(
      out.rubric.find((r) => r.id === "motivation")!.score,
    ).toBeGreaterThan(0.4);
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
