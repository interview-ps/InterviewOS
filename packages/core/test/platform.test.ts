import { describe, expect, it } from "vitest";
import {
  EvidenceProposalSchema,
  INTERVIEW_OS_VERSION,
  SkillManifestSchema,
  describePermissions,
  isPluginWritable,
  parseVersion,
  pluginEvidenceProposals,
  satisfies,
} from "../src/index.js";

describe("semver", () => {
  it("parses x.y.z only", () => {
    expect(parseVersion("0.4.0")).toEqual({ major: 0, minor: 4, patch: 0 });
    expect(parseVersion("1.2")).toBeNull();
    expect(parseVersion("v1.2.3")).toBeNull();
    expect(parseVersion("1.2.3-rc")).toBeNull();
  });

  it("satisfies exact, wildcard and comparators", () => {
    expect(satisfies("0.4.0", "*")).toBe(true);
    expect(satisfies("0.4.0", "0.4.0")).toBe(true);
    expect(satisfies("0.4.1", "0.4.0")).toBe(false);
    expect(satisfies("0.4.0", ">=0.4.0")).toBe(true);
    expect(satisfies("0.4.0", ">0.4.0")).toBe(false);
    expect(satisfies("0.4.1", ">0.4.0")).toBe(true);
    expect(satisfies("0.3.9", "<=0.4.0")).toBe(true);
    expect(satisfies("0.4.0", "<0.5.0")).toBe(true);
  });

  it("satisfies caret and tilde ranges", () => {
    expect(satisfies("0.4.7", "^0.4.0")).toBe(true);
    expect(satisfies("0.5.0", "^0.4.0")).toBe(false);
    expect(satisfies("1.2.9", "^1.0.0")).toBe(true);
    expect(satisfies("2.0.0", "^1.0.0")).toBe(false);
    expect(satisfies("0.0.2", "^0.0.1")).toBe(false);
    expect(satisfies("0.4.9", "~0.4.0")).toBe(true);
    expect(satisfies("0.5.0", "~0.4.0")).toBe(false);
  });

  it("satisfies space-separated AND ranges", () => {
    expect(satisfies("0.4.2", ">=0.4.0 <0.5.0")).toBe(true);
    expect(satisfies("0.5.0", ">=0.4.0 <0.5.0")).toBe(false);
    expect(satisfies("0.4.0", "garbage")).toBe(false);
  });

  it("has a valid INTERVIEW_OS_VERSION", () => {
    expect(satisfies(INTERVIEW_OS_VERSION, ">=0.4.0 <0.5.0")).toBe(true);
  });
});

describe("manifest extensions", () => {
  const base = {
    id: "p",
    version: "1.0.0",
    kind: "plugin" as const,
  };

  it("defaults name to id and accepts capabilities + engines", () => {
    const m = SkillManifestSchema.parse({
      ...base,
      capabilities: ["interview", "question_source"],
      engines: { "interview-os": ">=0.4.0" },
      author: "community",
    });
    expect(m.name ?? m.id).toBe("p");
    expect(m.author).toBe("community");
    expect(m.capabilities).toEqual(["interview", "question_source"]);
    expect(m.engines?.["interview-os"]).toBe(">=0.4.0");
  });

  it("keeps backward compatibility with v0.3 manifests", () => {
    const m = SkillManifestSchema.parse({
      id: "interview-day-checklist",
      version: "1.0.0",
      kind: "plugin",
      description: "x",
      inputs: [{ key: "target", permission: "target.read" }],
      outputs: ["checklist"],
      permissions: ["target.read"],
    });
    expect(m.capabilities ?? []).toEqual([]);
    expect(m.engines).toBeUndefined();
  });

  it("rejects unknown capabilities", () => {
    expect(
      SkillManifestSchema.safeParse({ ...base, capabilities: ["nope"] }).success,
    ).toBe(false);
  });
});

describe("plugin writable permissions", () => {
  it("only evidence.write is plugin-writable", () => {
    expect(isPluginWritable("evidence.write")).toBe(true);
    expect(isPluginWritable("candidate.write")).toBe(false);
  });
});

describe("describePermissions", () => {
  const manifest = {
    permissions: [
      "candidate.read",
      "target.read",
      "evidence.write",
      "runtime.invoke",
    ] as const,
  };

  it("returns the fixed category list", () => {
    const view = describePermissions({ permissions: [] });
    expect(view.map((v) => v.category)).toEqual([
      "Candidate Profile",
      "Resume",
      "Target",
      "Readiness",
      "Interview History",
      "Interview Answers",
      "STAR Stories",
      "Evidence (write)",
      "AI Runtime",
      "Local Files",
      "Network",
      "Environment/Secrets",
      "Commands",
    ]);
    expect(view.find((v) => v.category === "Network")).toMatchObject({
      access: "DENIED",
      requested: false,
      granted: false,
    });
  });

  it("marks reads, writes and invokes per grant set", () => {
    const all = describePermissions(manifest as never);
    expect(all.find((v) => v.category === "Candidate Profile")).toMatchObject({
      access: "READ",
      requested: true,
      granted: true,
    });
    expect(all.find((v) => v.category === "Evidence (write)")).toMatchObject({
      access: "WRITE",
      requested: true,
      granted: true,
    });
    expect(all.find((v) => v.category === "AI Runtime")).toMatchObject({
      access: "INVOKE",
      requested: true,
    });

    const partial = describePermissions(manifest as never, [
      "candidate.read",
      "target.read",
    ]);
    expect(
      partial.find((v) => v.category === "Evidence (write)"),
    ).toMatchObject({ access: "DENIED", requested: true, granted: false });
    expect(
      partial.find((v) => v.category === "AI Runtime"),
    ).toMatchObject({ access: "DENIED", requested: true, granted: false });
  });
});

describe("EvidenceProposalSchema", () => {
  it("accepts and bounds proposals", () => {
    const ok = EvidenceProposalSchema.safeParse({
      skillId: "sql.indexing",
      score: 0.7,
      confidence: 0.4,
      observation: "self-check",
    });
    expect(ok.success).toBe(true);
    expect(
      EvidenceProposalSchema.safeParse({
        skillId: "Bad Id",
        score: 0.5,
        confidence: 0.5,
        observation: "x",
      }).success,
    ).toBe(false);
    expect(
      EvidenceProposalSchema.safeParse({
        skillId: "sql",
        score: 1.5,
        confidence: 0.5,
        observation: "x",
      }).success,
    ).toBe(false);
  });

  it("extracts proposals from plugin output", () => {
    expect(pluginEvidenceProposals(null)).toEqual([]);
    expect(pluginEvidenceProposals({ other: 1 })).toEqual([]);
    expect(
      pluginEvidenceProposals({
        evidenceProposals: [
          { skillId: "sql", score: 0.5, confidence: 0.5, observation: "o" },
        ],
      }),
    ).toHaveLength(1);
    expect(
      pluginEvidenceProposals({ evidenceProposals: [{ skillId: "x y" }] }),
    ).toBeNull();
  });
});
