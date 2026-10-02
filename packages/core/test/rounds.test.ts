import { describe, expect, it } from "vitest";
import {
  inRound,
  roundFallbackRequirements,
  selectNextSkill,
  type Evidence,
  type Requirement,
  type SkillId,
  type SkillReadiness,
} from "../src/index.js";

describe("inRound", () => {
  it("mixed includes everything", () => {
    expect(inRound("distributed-systems.caching", "mixed")).toBe(true);
    expect(inRound("hr.motivation", "mixed")).toBe(true);
  });

  it("technical excludes system-design, behavioral, communication, hr", () => {
    expect(inRound("python", "technical")).toBe(true);
    expect(inRound("distributed-systems.caching", "technical")).toBe(true);
    expect(inRound("system-design.scalability", "technical")).toBe(false);
    expect(inRound("behavioral.leadership", "technical")).toBe(false);
    expect(inRound("communication", "technical")).toBe(false);
    expect(inRound("hr.motivation", "technical")).toBe(false);
  });

  it("system_design includes system-design.* and distributed-systems.*", () => {
    expect(inRound("system-design.scalability", "system_design")).toBe(true);
    expect(inRound("distributed-systems.caching", "system_design")).toBe(true);
    expect(inRound("python", "system_design")).toBe(false);
  });

  it("behavioral includes behavioral.* and communication", () => {
    expect(inRound("behavioral.ownership", "behavioral")).toBe(true);
    expect(inRound("communication", "behavioral")).toBe(true);
    expect(inRound("communication.storytelling" as SkillId, "behavioral")).toBe(true);
    expect(inRound("hr.motivation", "behavioral")).toBe(false);
    expect(inRound("python", "behavioral")).toBe(false);
  });

  it("hr includes only hr.*", () => {
    expect(inRound("hr.motivation", "hr")).toBe(true);
    expect(inRound("hr", "hr")).toBe(true);
    expect(inRound("behavioral.leadership", "hr")).toBe(false);
  });
});

describe("selectNextSkill roundType", () => {
  const reqs: Requirement[] = [
    { skillId: "distributed-systems.caching", label: "Caching", importance: 0.95, kind: "required", evidence: "jd" },
    { skillId: "python", label: "Python", importance: 0.9, kind: "required", evidence: "jd" },
  ];

  it("behavioral round on a technical JD falls back to round taxonomy nodes", () => {
    const result = selectNextSkill({
      requirements: reqs,
      readiness: {} as Record<SkillId, SkillReadiness>,
      evidence: [] as Evidence[],
      askedThisSession: [],
      askedPreviousSession: [],
      questionIndex: 0,
      roundType: "behavioral",
    });
    expect(result).not.toBeNull();
    expect(inRound(result!.skillId, "behavioral")).toBe(true);
    expect(
      result!.skillId === "behavioral" ||
        result!.skillId.startsWith("behavioral.") ||
        result!.skillId === "communication",
    ).toBe(true);
  });

  it("hr round only picks hr.* skills even when requirements exist elsewhere", () => {
    const result = selectNextSkill({
      requirements: reqs,
      readiness: {} as Record<SkillId, SkillReadiness>,
      evidence: [],
      askedThisSession: [],
      askedPreviousSession: [],
      questionIndex: 0,
      roundType: "hr",
    });
    expect(result!.skillId === "hr" || result!.skillId.startsWith("hr.")).toBe(true);
  });

  it("system_design round filters requirements to design skills", () => {
    const result = selectNextSkill({
      requirements: reqs,
      readiness: {} as Record<SkillId, SkillReadiness>,
      evidence: [],
      askedThisSession: [],
      askedPreviousSession: [],
      questionIndex: 0,
      roundType: "system_design",
    });
    expect(result!.skillId).toBe("distributed-systems.caching");
  });

  it("confirmation respects the round filter", () => {
    const dim = (skillId: string, score: number, confidence: number): SkillReadiness => ({
      skillId,
      label: skillId,
      score,
      confidence,
      evidenceIds: ["e1"],
      children: [],
      status: "strong",
    });
    const result = selectNextSkill({
      requirements: reqs,
      readiness: {
        python: dim("python", 0.95, 0.5), // strong, low-confidence — would confirm in mixed
        "distributed-systems.caching": dim("distributed-systems.caching", 0.9, 0.5),
      },
      evidence: [],
      askedThisSession: [],
      askedPreviousSession: [],
      questionIndex: 3, // every-4th confirmation index
      roundType: "hr",
    });
    // python/caching are out of scope for hr → no confirmation; falls back to hr nodes
    expect(result!.skillId === "hr" || result!.skillId.startsWith("hr.")).toBe(true);
  });

  it("mixed round is unchanged", () => {
    const result = selectNextSkill({
      requirements: reqs,
      readiness: {} as Record<SkillId, SkillReadiness>,
      evidence: [],
      askedThisSession: [],
      askedPreviousSession: [],
      questionIndex: 0,
    });
    expect(result!.skillId).toBe("distributed-systems.caching");
  });

  it("fallback requirements use the round taxonomy at 0.6 importance", () => {
    const fb = roundFallbackRequirements("behavioral");
    const ids = fb.map((r) => r.skillId);
    expect(ids).toContain("behavioral");
    expect(ids).toContain("behavioral.leadership");
    expect(ids).toContain("behavioral.ownership");
    expect(ids).toContain("communication");
    expect(fb.every((r) => r.importance === 0.6)).toBe(true);
  });
});
