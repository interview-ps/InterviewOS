import { describe, expect, it } from "vitest";
import {
  allModes,
  assertRubricIds,
  getMode,
  isModeId,
  MODE_IDS,
  nextUncoveredDimension,
  systemDesignMode,
  type AnswerEvaluation,
  type SkillId,
  type SystemDesignState,
} from "../src/index.js";

function evalWith(over: Partial<AnswerEvaluation> = {}): AnswerEvaluation {
  const dim = { score: 0.5, rationale: "t" };
  return {
    summary: "t",
    dimensions: {
      correctness: dim,
      technicalDepth: dim,
      reasoning: dim,
      structure: dim,
      communication: dim,
      evidence: dim,
      roleRelevance: dim,
    },
    strengths: [],
    weaknesses: [],
    scores: [],
    missingConcepts: [],
    betterApproach: "",
    followUpTopics: [],
    star: null,
    rubric: [],
    designUpdates: null,
    ...over,
  };
}

const rubricFor = (modeId: string, lowId?: string) =>
  getMode(modeId as never).rubric.map((r) => ({
    id: r.id,
    label: r.label,
    score: r.id === lowId ? 0.3 : 0.8,
    rationale: "t",
  }));

describe("§9.1 mode registry", () => {
  it("exposes exactly the six modes plus legacy mixed", () => {
    expect(MODE_IDS).toEqual([
      "technical",
      "coding",
      "system_design",
      "behavioral",
      "hiring_manager",
      "hr",
    ]);
    expect(allModes().map((m) => m.id).sort()).toEqual([...MODE_IDS].sort());
    expect(isModeId("coding")).toBe(true);
    expect(isModeId("mixed")).toBe(false);
    expect(getMode("mixed").rubric).toEqual([]);
  });
});

describe("§9.1 scopes", () => {
  it("technical excludes the dedicated subtrees", () => {
    const m = getMode("technical");
    expect(m.inScope("sql" as SkillId)).toBe(true);
    expect(m.inScope("sql.transactions" as SkillId)).toBe(true);
    expect(m.inScope("python" as SkillId)).toBe(true);
    for (const out of [
      "system-design",
      "system-design.scalability",
      "behavioral.conflict",
      "communication",
      "hr.motivation",
      "coding.algorithms",
      "hiring-manager.role-fit",
    ]) {
      expect(m.inScope(out as SkillId), out).toBe(false);
    }
    // distributed-systems is NOT excluded — it's fair game for technical depth
    expect(m.inScope("distributed-systems.caching" as SkillId)).toBe(true);
  });

  it("coding scope is coding.* only", () => {
    const m = getMode("coding");
    expect(m.inScope("coding" as SkillId)).toBe(true);
    expect(m.inScope("coding.algorithms" as SkillId)).toBe(true);
    expect(m.inScope("python" as SkillId)).toBe(false);
  });

  it("system_design scope is system-design.* + distributed-systems.*", () => {
    const m = getMode("system_design");
    expect(m.inScope("system-design.data-modeling" as SkillId)).toBe(true);
    expect(m.inScope("distributed-systems.consistency" as SkillId)).toBe(true);
    expect(m.inScope("sql" as SkillId)).toBe(false);
  });

  it("behavioral scope is behavioral.* + communication", () => {
    const m = getMode("behavioral");
    expect(m.inScope("behavioral.ownership" as SkillId)).toBe(true);
    expect(m.inScope("communication" as SkillId)).toBe(true);
    expect(m.inScope("hr.motivation" as SkillId)).toBe(false);
  });

  it("hiring_manager scope is hiring-manager.* + behavioral.leadership + communication", () => {
    const m = getMode("hiring_manager");
    expect(m.inScope("hiring-manager.prioritization" as SkillId)).toBe(true);
    expect(m.inScope("behavioral.leadership" as SkillId)).toBe(true);
    expect(m.inScope("communication" as SkillId)).toBe(true);
    expect(m.inScope("behavioral.conflict" as SkillId)).toBe(false);
  });

  it("hr scope is hr.*", () => {
    const m = getMode("hr");
    expect(m.inScope("hr.culture-fit" as SkillId)).toBe(true);
    expect(m.inScope("behavioral" as SkillId)).toBe(false);
  });
});

describe("§9.1 follow-up rules", () => {
  it("generic modes dig once while a rubric dimension is weak and depth remains", () => {
    const m = getMode("technical");
    const ev = evalWith({
      rubric: rubricFor("technical", "correctness"),
      missingConcepts: ["indexing"],
    });
    expect(m.followUp(ev, {}, 0, 1).ask).toBe(true);
    expect(m.followUp(ev, {}, 0, 1).focus).toBe("indexing");
    expect(m.followUp(ev, {}, 1, 1).ask).toBe(false); // depth cap
    expect(m.followUp(evalWith({ rubric: rubricFor("technical") }), {}, 0, 1).ask).toBe(false);
  });

  it("coding follows up on weak complexity or edge cases", () => {
    const m = getMode("coding");
    const weakComplexity = evalWith({ rubric: rubricFor("coding", "complexity") });
    const decision = m.followUp(weakComplexity, {}, 0, 1);
    expect(decision.ask).toBe(true);
    expect(decision.focus).toContain("complexity");
    const weakEdges = evalWith({ rubric: rubricFor("coding", "edgeCases") });
    expect(m.followUp(weakEdges, {}, 0, 1).focus).toContain("edge");
    const strong = evalWith({ rubric: rubricFor("coding") });
    expect(m.followUp(strong, {}, 0, 1).ask).toBe(false);
  });

  it("system_design never chains follow-ups (the session walks dimensions)", () => {
    const m = getMode("system_design");
    const ev = evalWith({ rubric: rubricFor("system_design", "caching"), missingConcepts: ["x"] });
    expect(m.followUp(ev, m.initialState(), 0, 2).ask).toBe(false);
  });

  it("mixed never follows up", () => {
    expect(getMode("mixed").followUp(evalWith(), {}, 0, 3).ask).toBe(false);
  });
});

describe("§9.1 system_design state", () => {
  it("reduce applies designUpdates and never downgrades status", () => {
    let state = systemDesignMode.initialState() as SystemDesignState;
    const q = { skillId: "system-design" as SkillId, topic: "t", extra: {} };
    state = systemDesignMode.reduce(
      state,
      evalWith({ designUpdates: [{ dimension: "caching", status: "covered", notes: "good" }] }),
      q,
    ) as SystemDesignState;
    expect(state.dimensions.caching!.status).toBe("covered");
    // a later weaker update must not downgrade
    state = systemDesignMode.reduce(
      state,
      evalWith({ designUpdates: [{ dimension: "caching", status: "partial", notes: "worse" }] }),
      q,
    ) as SystemDesignState;
    expect(state.dimensions.caching!.status).toBe("covered");
    // equal-rank update may refresh notes only
    state = systemDesignMode.reduce(
      state,
      evalWith({ designUpdates: [{ dimension: "storage", status: "partial", notes: "sql chosen" }] }),
      q,
    ) as SystemDesignState;
    expect(state.dimensions.storage!.status).toBe("partial");
    expect(state.dimensions.storage!.notes).toBe("sql chosen");
  });

  it("reduce stores the turn-1 problem and focus dimension", () => {
    let state = systemDesignMode.initialState() as SystemDesignState;
    state = systemDesignMode.reduce(
      state,
      evalWith(),
      { skillId: "system-design" as SkillId, topic: "t", extra: { problem: "Design a URL shortener" } },
    ) as SystemDesignState;
    expect(state.problem).toBe("Design a URL shortener");
  });

  it("nextUncoveredDimension walks rubric order skipping covered", () => {
    let state = systemDesignMode.initialState() as SystemDesignState;
    expect(nextUncoveredDimension(state)).toBe("requirements");
    state.dimensions.requirements = { status: "covered", notes: "" };
    state.dimensions.constraints = { status: "partial", notes: "" };
    expect(nextUncoveredDimension(state)).toBe("constraints");
  });
});

describe("§9.1 rubric contract", () => {
  it("assertRubricIds passes on exact ids and throws on mismatch", () => {
    const mode = getMode("coding");
    expect(() =>
      assertRubricIds(evalWith({ rubric: rubricFor("coding") }), mode),
    ).not.toThrow();
    expect(() =>
      assertRubricIds(
        evalWith({ rubric: rubricFor("coding").filter((r) => r.id !== "complexity") }),
        mode,
      ),
    ).toThrow(/rubric mismatch/);
    expect(() =>
      assertRubricIds(
        evalWith({ rubric: [...rubricFor("coding"), { id: "extra", label: "x", score: 1, rationale: "" }] }),
        mode,
      ),
    ).toThrow(/rubric mismatch/);
    // mixed mode has no rubric contract
    expect(() => assertRubricIds(evalWith(), getMode("mixed"))).not.toThrow();
  });
});
