import { describe, expect, it } from "vitest";
import {
  CompanyPackOverlaySchema,
  CompanyPackSchema,
  CompanyProfileSchema,
  InterviewPackSchema,
  QuestionCandidateSchema,
  RolePackSchema,
  builtinResourcesFor,
  compileCompanyPack,
  mergeResources,
  selectNextSkill,
  taxonomy,
  type CompanyPackWithOverlays,
  type Requirement,
} from "../src/index.js";

function baseCompanyPack() {
  return {
    id: "acme",
    name: "Acme",
    version: "1.0.0",
    sources: [{ id: "blog", title: "Acme eng blog", url: "https://acme.example/blog" }],
    stages: [
      { mode: "technical", label: "Tech", plannedQuestions: 3, provenance: "community" },
      { mode: "behavioral", label: "Behavioral", plannedQuestions: 2, provenance: "community" },
    ],
    behavioralFramework: { name: "Principles", themes: ["rigor"], guidance: "" },
    competencies: [
      { text: "emphasizes correctness", provenance: "sourced", source: "blog" },
    ],
    questionStyle: [{ text: "drills into edge cases", provenance: "community" }],
    evaluationGuidance: [{ text: "values working code", provenance: "community" }],
  };
}

describe("pack provenance", () => {
  it("accepts a sourced item that names a declared source", () => {
    expect(CompanyPackSchema.safeParse(baseCompanyPack()).success).toBe(true);
  });

  it("rejects a sourced item without a source", () => {
    const pack = baseCompanyPack();
    pack.competencies = [{ text: "x", provenance: "sourced" } as never];
    expect(CompanyPackSchema.safeParse(pack).success).toBe(false);
  });

  it("rejects a sourced item naming an undeclared source", () => {
    const pack = baseCompanyPack();
    pack.competencies = [
      { text: "x", provenance: "sourced", source: "nope" } as never,
    ];
    expect(CompanyPackSchema.safeParse(pack).success).toBe(false);
  });

  it("rejects unknown provenance values", () => {
    const pack = baseCompanyPack();
    pack.competencies = [{ text: "x", provenance: "verified" } as never];
    expect(CompanyPackSchema.safeParse(pack).success).toBe(false);
  });
});

describe("compileCompanyPack", () => {
  it("produces a value that passes CompanyProfileSchema", () => {
    const pack = CompanyPackSchema.parse(baseCompanyPack());
    const withOverlays: CompanyPackWithOverlays = { ...pack, overlays: [] };
    const profile = compileCompanyPack(withOverlays);
    expect(CompanyProfileSchema.safeParse(profile).success).toBe(true);
    expect(profile.id).toBe("acme");
    expect(profile.disclaimer).toMatch(/unverified/);
    expect(profile.pack).toMatchObject({ kind: "company", sourcedCount: 1 });
  });
});

describe("overlay / role / interview pack schemas", () => {
  it("parses a minimal overlay", () => {
    const overlay = CompanyPackOverlaySchema.parse({
      appliesTo: { roleKeywords: ["backend"] },
      competencies: [{ text: "x", provenance: "community" }],
    });
    expect(overlay.appliesTo.roleKeywords).toEqual(["backend"]);
  });

  it("rejects an overlay stage list out of bounds", () => {
    expect(
      CompanyPackOverlaySchema.safeParse({
        stages: [
          { mode: "technical", label: "only", plannedQuestions: 2, provenance: "community" },
        ],
      }).success,
    ).toBe(false);
  });

  it("parses a role pack and enforces rubric skillId/mode", () => {
    const ok = RolePackSchema.safeParse({
      id: "backend",
      name: "Backend",
      version: "1.0.0",
      dimensions: [{ skillId: "sql", weight: 0.9 }],
      defaultQuestionCategories: ["technical", "behavioral"],
      rubrics: [{ mode: "technical", criteria: ["clarifies"] }],
    });
    expect(ok.success).toBe(true);
    const bad = RolePackSchema.safeParse({
      id: "backend",
      name: "Backend",
      version: "1.0.0",
      dimensions: [{ skillId: "sql", weight: 0.9 }],
      defaultQuestionCategories: ["technical", "behavioral"],
      rubrics: [{ criteria: ["no skill or mode"] }],
    });
    expect(bad.success).toBe(false);
  });

  it("enforces interview-pack round bounds (2–7)", () => {
    const base = {
      id: "p",
      name: "P",
      version: "1.0.0",
      skills: ["sql"],
      durationMinutes: 60,
    };
    expect(
      InterviewPackSchema.safeParse({
        ...base,
        rounds: [{ mode: "technical", label: "t", plannedQuestions: 2 }],
      }).success,
    ).toBe(false);
    expect(
      InterviewPackSchema.safeParse({
        ...base,
        rounds: [
          { mode: "technical", label: "t", plannedQuestions: 2 },
          { mode: "behavioral", label: "b", plannedQuestions: 2 },
        ],
      }).success,
    ).toBe(true);
  });

  it("validates question candidates", () => {
    expect(
      QuestionCandidateSchema.safeParse({
        skillId: "sql",
        text: "What does an index do?",
        source: { kind: "user_bank", id: "uq_1" },
      }).success,
    ).toBe(true);
    expect(
      QuestionCandidateSchema.safeParse({
        skillId: "sql",
        text: "short",
        source: { kind: "user_bank", id: "uq_1" },
      }).success,
    ).toBe(false);
  });
});

describe("resources", () => {
  it("resolves the most-specific built-in catalog prefix plus a practice entry", () => {
    const indexing = builtinResourcesFor("sql.indexing");
    expect(indexing.length).toBeGreaterThan(0);
    expect(indexing.some((r) => r.kind === "practice")).toBe(true);
    expect(indexing.every((r) => r.skillId === "sql.indexing")).toBe(true);
  });

  it("mergeResources dedupes by title+url", () => {
    const a = builtinResourcesFor("sql");
    const merged = mergeResources(a, [...a]);
    expect(merged).toHaveLength(a.length);
  });
});

describe("interview pack focus (v0.4)", () => {
  const req = (skillId: string): Requirement => ({
    skillId: skillId as Requirement["skillId"],
    label: skillId,
    importance: 0.5,
    kind: "required",
    evidence: "test",
  });
  const base = {
    readiness: {},
    evidence: [],
    askedThisSession: [],
    askedPreviousSession: [],
    questionIndex: 0,
    roundType: "technical" as const,
  };

  it("records packFocus on skills that descend from a focus skill", () => {
    const picked = selectNextSkill({
      ...base,
      requirements: [req("sql")],
      focusSkills: ["sql"],
    });
    expect(picked?.factors?.packFocus).toBe(0.15);
  });

  it("leaves packFocus at 0 for unfocused skills", () => {
    const picked = selectNextSkill({
      ...base,
      requirements: [req("sql")],
      focusSkills: ["distributed-systems"],
    });
    expect(picked?.factors?.packFocus).toBe(0);
  });
});

describe("taxonomy.registerNodes", () => {
  it("registers new nodes idempotently and resolves labels", () => {
    taxonomy.registerNodes([
      { id: "test-pack.node", label: "Pack Node", keywords: ["packnode"] },
    ]);
    expect(taxonomy.labelFor("test-pack.node")).toBe("Pack Node");
    // idempotent: re-registering with a different label overwrites, no throw
    taxonomy.registerNodes([{ id: "test-pack.node", label: "Pack Node v2" }]);
    expect(taxonomy.labelFor("test-pack.node")).toBe("Pack Node v2");
  });
});
