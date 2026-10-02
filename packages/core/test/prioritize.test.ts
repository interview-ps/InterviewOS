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
