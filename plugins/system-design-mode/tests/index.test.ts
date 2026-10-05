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
  "requirements",
  "constraints",
  "scaleAssumptions",
  "architecture",
  "dataModel",
  "apis",
  "storage",
  "caching",
  "reliability",
  "scalability",
  "tradeOffs",
];

const EMPTY_STATE = {
  problem: null,
  focusDimension: null,
  dimensions: Object.fromEntries(
    RUBRIC_IDS.map((id) => [id, { status: "not_covered", notes: "" }]),
  ),
};

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

describe("system-design-mode", () => {
  it("declares the system_design mode with include scope, rubric and never-follow-up", () => {
    const mode = manifest.modes?.[0];
    expect(mode?.id).toBe("system_design");
    expect(mode?.scope.include).toEqual(["system-design", "distributed-systems"]);
    expect(mode?.rubric.map((r) => r.id)).toEqual(RUBRIC_IDS);
    expect(mode?.initialState).toEqual(EMPTY_STATE);
    expect(mode?.followUp).toBe("never");
    expect(mode?.followUpReason).toContain("walk uncovered dimensions");
    expect(mode?.reduce).toEqual({ copyExtra: ["problem", "focusDimension"] });
  });

  it("mode.prepareTurn returns the first uncovered dimension and its skill", async () => {
    const { output } = await runPluginWithMock({
      plugin,
      manifest,
      hook: "mode.prepareTurn",
      request: { modeId: "system_design", state: EMPTY_STATE, followUp: false },
    });
    const turn = (output as { turn: Record<string, unknown> }).turn;
    expect(turn.focusDimension).toBe("requirements");
    expect(turn.skillId).toBe("system-design.requirements-analysis");
  });

  it("mode.prepareTurn skips covered dimensions and is null on follow-ups", async () => {
    const state = {
      ...EMPTY_STATE,
      dimensions: {
        ...EMPTY_STATE.dimensions,
        requirements: { status: "covered", notes: "done" },
      },
    };
    const { output: o1 } = await runPluginWithMock({
      plugin,
      manifest,
      hook: "mode.prepareTurn",
      request: { modeId: "system_design", state, followUp: false },
    });
    expect((o1 as { turn: { focusDimension: string | null } }).turn.focusDimension)
      .toBe("constraints");

    const { output: o2 } = await runPluginWithMock({
      plugin,
      manifest,
      hook: "mode.prepareTurn",
      request: { modeId: "system_design", state, followUp: true },
    });
    expect((o2 as { turn: { focusDimension: string | null } }).turn.focusDimension)
      .toBeNull();
  });

  it("mode.reduce merges modeSignals.designUpdates without downgrading", async () => {
    const { output } = await runPluginWithMock({
      plugin,
      manifest,
      hook: "mode.reduce",
      request: {
        modeId: "system_design",
        state: {
          ...EMPTY_STATE,
          dimensions: {
            ...EMPTY_STATE.dimensions,
            caching: { status: "covered", notes: "redis" },
          },
        },
        evaluation: {
          ...SAMPLE_EVALUATION,
          modeSignals: {
            designUpdates: [
              { dimension: "requirements", status: "partial", notes: "some reqs" },
              { dimension: "caching", status: "partial", notes: "would downgrade" },
            ],
          },
        },
        question: {
          skillId: "system-design",
          topic: "Design",
          extra: { problem: "Design a URL shortener", focusDimension: "requirements" },
        },
      },
    });
    const state = (output as {
      state: {
        problem: string;
        focusDimension: string;
        dimensions: Record<string, { status: string; notes: string }>;
      };
    }).state;
    expect(state.problem).toBe("Design a URL shortener");
    expect(state.focusDimension).toBe("requirements");
    expect(state.dimensions.requirements!.status).toBe("partial");
    // covered is never downgraded
    expect(state.dimensions.caching!.status).toBe("covered");
    expect(state.dimensions.caching!.notes).toBe("redis");
  });

  it("mode.reduce still reads the legacy designUpdates field", async () => {
    const { output } = await runPluginWithMock({
      plugin,
      manifest,
      hook: "mode.reduce",
      request: {
        modeId: "system_design",
        state: EMPTY_STATE,
        evaluation: {
          ...SAMPLE_EVALUATION,
          designUpdates: [
            { dimension: "apis", status: "partial", notes: "endpoints sketched" },
          ],
        },
        question: { skillId: "system-design", topic: "Design", extra: {} },
      },
    });
    const state = (output as {
      state: { dimensions: Record<string, { status: string }> };
    }).state;
    expect(state.dimensions.apis!.status).toBe("partial");
  });

  it("mode.mock interviewer turn 1 returns a design problem", async () => {
    const { output } = await runPluginWithMock({
      plugin,
      manifest,
      hook: "mode.mock",
      request: {
        modeId: "system_design",
        task: "interviewer",
        input: {
          skillId: "system-design",
          label: "System design",
          previousQuestions: [],
          modeState: EMPTY_STATE,
          followUp: null,
        },
      },
    });
    const out = (output as { output: Record<string, unknown> }).output;
    expect(typeof out.problem).toBe("string");
    expect(String(out.problem)).toContain("Design");
  });

  it("mode.mock evaluator emits modeSignals.designUpdates and the full rubric", async () => {
    const { output } = await runPluginWithMock({
      plugin,
      manifest,
      hook: "mode.mock",
      request: {
        modeId: "system_design",
        task: "evaluator",
        input: {
          question: {
            text: "Design a URL shortener",
            skillId: "system-design",
            expectedConcepts: [],
          },
          answer:
            "Requirements: /shorten endpoint redirecting via a table of hashes. QPS estimate: 1k per second. Postgres storage with a redis cache; replicas for failover.",
          modeState: EMPTY_STATE,
        },
      },
    });
    const out = (output as {
      output: {
        rubric: { id: string }[];
        designUpdates: unknown;
        modeSignals: {
          designUpdates: { dimension: string; status: string }[];
        } | null;
      };
    }).output;
    expect(out.rubric.map((r) => r.id)).toEqual(RUBRIC_IDS);
    expect(out.designUpdates).toBeNull();
    const updates = out.modeSignals?.designUpdates;
    expect(updates?.length).toBeGreaterThan(0);
    expect(updates?.some((u) => u.dimension === "requirements")).toBe(true);
  });

  it("ui.render design-dimensions renders the coverage panel", async () => {
    const { output } = await runPluginWithMock({
      plugin,
      manifest,
      hook: "ui.render",
      request: {
        slot: "interview.sidebar",
        component: "design-dimensions",
        params: {
          modeId: "system_design",
          state: {
            ...EMPTY_STATE,
            dimensions: {
              ...EMPTY_STATE.dimensions,
              requirements: { status: "partial", notes: "" },
            },
          },
          focus: "requirements",
        },
      },
    });
    const tree = validateUITree((output as { ui?: unknown }).ui, {
      pluginId: manifest.id,
    }) as { type: string };
    expect(tree.type).toBe("card");
  });

  it("contract tests pass for declared hooks", async () => {
    const res = await runContractTests({ dir });
    expect(res.ok).toBe(true);
    expect(res.hookResults.map((r) => r.hook).sort()).toEqual([
      "mode.mock",
      "mode.prepareTurn",
      "mode.reduce",
      "ui.render",
    ]);
  });
});
