import { describe, expect, it } from "vitest";
import {
  selectNextSkill,
  type Evidence,
  type Requirement,
  type SkillId,
  type SkillReadiness,
} from "../src/index.js";

function req(skillId: string, importance = 1): Requirement {
  return { skillId, label: skillId, importance, kind: "required", evidence: "jd" };
}

function dim(skillId: string, score: number | null, confidence = 0): SkillReadiness {
  return {
    skillId,
    label: skillId,
    score,
    confidence,
    evidenceIds: score === null ? [] : ["e1"],
    children: [],
    status: score === null ? "unknown" : score < 0.5 ? "weak" : score < 0.75 ? "developing" : "strong",
  };
}

function interviewEvidence(skillId: string, score: number): Evidence {
  return {
    id: `ev-${skillId}`,
    skillId,
    type: "interview_answer",
    score,
    confidence: 0.9,
    observation: "",
    createdAt: "2026-01-01T00:00:00Z",
  };
}

const baseInput = {
  requirements: [] as Requirement[],
  readiness: {} as Record<SkillId, SkillReadiness>,
  evidence: [] as Evidence[],
  askedThisSession: [] as SkillId[],
  askedPreviousSession: [] as SkillId[],
  questionIndex: 0,
};

describe("selectNextSkill", () => {
  it("returns null with no candidates", () => {
    expect(selectNextSkill(baseInput)).toBeNull();
  });

  it("boosts weak interview evidence ×1.6 over an equal non-weak skill", () => {
    const result = selectNextSkill({
      ...baseInput,
      requirements: [req("weak-skill"), req("fine-skill")],
      readiness: {
        "weak-skill": dim("weak-skill", 0.5, 0.8),
        "fine-skill": dim("fine-skill", 0.5, 0.8),
      },
      evidence: [interviewEvidence("weak-skill", 0.3)],
    });
    expect(result!.skillId).toBe("weak-skill");
    const weak = result!.candidates.find((c) => c.skillId === "weak-skill")!;
    const fine = result!.candidates.find((c) => c.skillId === "fine-skill")!;
    expect(weak.priority).toBeCloseTo(fine.priority * 1.6, 6);
  });

  it("suppresses a skill already asked this session (×0.15)", () => {
    const result = selectNextSkill({
      ...baseInput,
      requirements: [req("asked-skill"), req("other-skill")],
      readiness: {
        "asked-skill": dim("asked-skill", null),
        "other-skill": dim("other-skill", null),
      },
      askedThisSession: ["asked-skill" as SkillId],
    });
    expect(result!.skillId).toBe("other-skill");
    const asked = result!.candidates.find((c) => c.skillId === "asked-skill")!;
    const other = result!.candidates.find((c) => c.skillId === "other-skill")!;
    expect(asked.priority).toBeCloseTo(other.priority * 0.15, 6);
  });

  it("penalizes skills asked in a previous session when not weak (×0.6)", () => {
    const result = selectNextSkill({
      ...baseInput,
      requirements: [req("prev-skill"), req("fresh-skill")],
      readiness: {
        "prev-skill": dim("prev-skill", 0.4, 0.9),
        "fresh-skill": dim("fresh-skill", 0.4, 0.9),
      },
      askedPreviousSession: ["prev-skill" as SkillId],
    });
    expect(result!.skillId).toBe("fresh-skill");
  });

  it("uses the 4th question (index 3) as a strong-area confirmation", () => {
    const result = selectNextSkill({
      ...baseInput,
      requirements: [req("s1"), req("s2"), req("s3")],
      readiness: {
        s1: dim("s1", 0.9, 0.9), // too confident: not a confirmation candidate
        s2: dim("s2", 0.85, 0.6), // highest score with confidence < 0.8
        s3: dim("s3", 0.6, 0.5),
      },
      questionIndex: 3,
    });
    expect(result!.skillId).toBe("s2");
    expect(result!.reason).toContain("confirmation");
  });

  it("does not trigger confirmation on non-4th indices", () => {
    const result = selectNextSkill({
      ...baseInput,
      requirements: [req("s2"), req("s3")],
      readiness: { s2: dim("s2", 0.85, 0.6), s3: dim("s3", 0.6, 0.5) },
      questionIndex: 2,
    });
    expect(result!.reason).not.toContain("confirmation");
  });

  it("breaks ties deterministically by skillId", () => {
    const result = selectNextSkill({
      ...baseInput,
      requirements: [req("zeta"), req("alpha")],
      readiness: {},
    });
    expect(result!.skillId).toBe("alpha");
    expect(result!.candidates.map((c) => c.skillId)).toEqual(["alpha", "zeta"]);
  });
});

describe("§9.2 engine v3", () => {
  it("novelty factor 0.85 applies after 3 asks — but not when the skill is weak", () => {
    const res = selectNextSkill({
      ...baseInput,
      requirements: [req("seen"), req("fresh")],
      readiness: {
        seen: dim("seen", 0.4, 0.9),
        fresh: dim("fresh", 0.4, 0.9),
      },
      askCounts: { seen: 3 } as Record<SkillId, number>,
    });
    const seen = res!.candidates.find((c) => c.skillId === "seen")!;
    const fresh = res!.candidates.find((c) => c.skillId === "fresh")!;
    expect(seen.factors.noveltyFactor).toBe(0.85);
    expect(fresh.factors.noveltyFactor).toBe(1);
    expect(res!.skillId).toBe("fresh");

    // weak evidence keeps novelty at 1 (weak skills still get retested)
    const weakRes = selectNextSkill({
      ...baseInput,
      requirements: [req("seen"), req("fresh")],
      readiness: {
        seen: dim("seen", 0.4, 0.9),
        fresh: dim("fresh", 0.4, 0.9),
      },
      evidence: [interviewEvidence("seen", 0.3)],
      askCounts: { seen: 3 } as Record<SkillId, number>,
    });
    const weakSeen = weakRes!.candidates.find((c) => c.skillId === "seen")!;
    expect(weakSeen.factors.noveltyFactor).toBe(1);
    expect(weakSeen.factors.weaknessBoost).toBe(1.6);
    expect(weakRes!.skillId).toBe("seen"); // 1.6 boost beats 0.85 savings on fresh
  });

  it("loop-weak sql.transactions pulls in related distributed-systems.consistency at ×1.4", () => {
    const res = selectNextSkill({
      ...baseInput,
      mode: "system_design",
      requirements: [
        req("system-design", 0.9),
        req("system-design.scalability", 0.9),
      ],
      readiness: {
        "system-design": dim("system-design", 0.4, 0.9),
        "system-design.scalability": dim("system-design.scalability", 0.4, 0.9),
      },
      loopWeakSkills: [
        { skillId: "sql.transactions" as SkillId, round: 2, mode: "coding" as const },
      ],
    });
    const consistency = res!.candidates.find(
      (c) => c.skillId === "distributed-systems.consistency",
    );
    expect(consistency).toBeDefined();
    expect(consistency!.factors.weaknessBoost).toBe(1.4);
    expect(consistency!.reason).toMatch(
      /Round 2 \(Coding\) showed weak SQL Transactions → testing Consistency/,
    );
    // pulled in by the loop signal — outranks the unboosted requirements
    expect(consistency!.priority).toBeGreaterThan(
      res!.candidates.find((c) => c.skillId === "system-design")!.priority,
    );
  });

  it("a direct loop-weak skill in scope gets ×1.4 with a 'retesting' reason", () => {
    const res = selectNextSkill({
      ...baseInput,
      mode: "system_design",
      requirements: [req("system-design", 0.9)],
      readiness: { "system-design": dim("system-design", 0.5, 0.9) },
      loopWeakSkills: [
        { skillId: "system-design" as SkillId, round: 1, mode: "technical" as const },
      ],
    });
    const c = res!.candidates.find((x) => x.skillId === "system-design")!;
    expect(c.factors.weaknessBoost).toBe(1.4);
    expect(c.reason).toContain("retesting");
  });

  it("out-of-scope loop-weak skills don't enter the pool", () => {
    const res = selectNextSkill({
      ...baseInput,
      mode: "hr",
      requirements: [req("hr.motivation", 0.9)],
      readiness: { "hr.motivation": dim("hr.motivation", 0.4, 0.9) },
      loopWeakSkills: [
        { skillId: "sql.transactions" as SkillId, round: 2, mode: "coding" as const },
      ],
    });
    expect(res!.candidates.every((c) => c.skillId.startsWith("hr"))).toBe(true);
  });

  it("difficulty steps by level and readiness score", () => {
    const sel = (level: "junior" | "mid" | "senior" | "staff", score: number | null) =>
      selectNextSkill({
        ...baseInput,
        level,
        requirements: [req("x")],
        readiness: { x: dim("x", score, 0.9) },
      })!.difficulty;
    expect(sel("junior", null)).toBe("easy");
    expect(sel("mid", null)).toBe("medium");
    expect(sel("senior", null)).toBe("medium");
    expect(sel("staff", null)).toBe("hard");
    expect(sel("mid", 0.9)).toBe("hard"); // strong → +1 step
    expect(sel("senior", 0.3)).toBe("easy"); // weak → −1 step
    expect(sel("junior", 0.3)).toBe("easy"); // floor
    expect(sel("staff", 0.9)).toBe("hard"); // ceiling
  });

  it("factor breakdown multiplies to the reported priority", () => {
    const res = selectNextSkill({
      ...baseInput,
      requirements: [req("x", 0.8), req("y", 0.6)],
      readiness: { x: dim("x", 0.4, 0.7), y: dim("y", 0.3, 0.5) },
      evidence: [interviewEvidence("y", 0.2)],
    });
    for (const c of res!.candidates) {
      const f = c.factors;
      const expected =
        f.roleImportance *
        Math.max(f.readinessGap, 0.1) *
        (0.5 + f.uncertainty) *
        f.weaknessBoost *
        f.recencyFactor *
        f.noveltyFactor;
      expect(c.priority).toBeCloseTo(expected, 6);
    }
    // weak evidence on y wins over a stronger-importance x
    expect(res!.skillId).toBe("y");
  });

  it("preserves the v0.2 result when novelty=1 and no loop signals", () => {
    const input = {
      ...baseInput,
      requirements: [req("a", 0.9), req("b", 0.7)],
      readiness: { a: dim("a", 0.4, 0.8), b: dim("b", 0.2, 0.6) },
    };
    const v3 = selectNextSkill({ ...input, mode: "mixed", level: "senior", askCounts: {} });
    const v2 = selectNextSkill(input);
    expect(v3!.skillId).toBe(v2!.skillId);
    expect(v3!.priority).toBeCloseTo(v2!.priority, 10);
  });
});
