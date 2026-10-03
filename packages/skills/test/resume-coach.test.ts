import { describe, expect, it } from "vitest";
import { MockRuntime } from "@interview-os/runtime";
import { createLogger } from "@interview-os/shared";
import type { Requirement } from "@interview-os/core";
import {
  registerMockHandlers,
  resumeCoach,
  type SkillContext,
} from "../src/index.js";

const logger = createLogger({ level: "error", sink: () => {} });

function ctx(): SkillContext {
  const runtime = new MockRuntime();
  registerMockHandlers(runtime);
  return { runtime, logger, now: () => new Date("2026-02-01T00:00:00Z") };
}

const RESUME = `# Jane Doe

Senior engineer building REST APIs and Python services.

## Experience
- Senior Engineer — Acme — built Python REST APIs backed by PostgreSQL
- Engineer — Globex — responsible for internal tooling and scripts
- Intern — Initech — helped with deployments
`;

const REQS: Requirement[] = [
  {
    skillId: "python" as Requirement["skillId"],
    label: "Python",
    importance: 0.9,
    kind: "required",
    evidence: "",
  },
  {
    skillId: "distributed-systems.caching" as Requirement["skillId"],
    label: "Caching",
    importance: 0.8,
    kind: "required",
    evidence: "",
  },
];

describe("resume-coach (§9.5)", () => {
  it("bullets: rewrites weak bullets with action verb + [add metric]", async () => {
    const out = (await resumeCoach.execute(
      {
        mode: "bullets",
        resumeText: RESUME,
        bullets: [
          "- Engineer — Globex — responsible for internal tooling and scripts",
          "- Intern — Initech — helped with deployments",
        ],
      },
      ctx(),
    )) as { suggestions: { original: string; improved: string; rationale: string }[] };

    expect(out.suggestions).toHaveLength(2);
    for (const s of out.suggestions) {
      // mock rewrites never invent facts: no new numbers, placeholders instead
      expect(s.improved).toContain("[add metric]");
      expect(/\d/.test(s.improved.replace("[add metric]", ""))).toBe(false);
      expect(s.rationale.length).toBeGreaterThan(0);
    }
    // starts with an action verb
    expect(out.suggestions[0]!.improved).toMatch(/^Delivered/);
  });

  it("bullets: rewrites the backend-engineer example bullets faithfully", async () => {
    const out = (await resumeCoach.execute(
      {
        mode: "bullets",
        resumeText: RESUME,
        bullets: [
          "- Senior Backend Engineer — Acme Payments — designed Python REST APIs for payment processing",
          "- LedgerSync — a Python reconciliation service exposing a REST API",
        ],
      },
      ctx(),
    )) as { suggestions: { improved: string }[] };

    // Role — Company — prefix stripped; existing verb kept, capitalised
    expect(out.suggestions[0]!.improved).toBe(
      "Designed Python REST APIs for payment processing at Acme Payments, achieving [add metric]",
    );
    // named project bullet gets a neutral verb; proper-noun casing preserved
    expect(out.suggestions[1]!.improved).toBe(
      "Built LedgerSync, a Python reconciliation service exposing a REST API, achieving [add metric]",
    );
  });

  it("tailor: alignment evidence is a verbatim resume substring or null", async () => {
    const out = (await resumeCoach.execute(
      {
        mode: "tailor",
        resumeText: RESUME,
        requirements: REQS,
        role: "Senior Backend Engineer",
        level: "senior",
      },
      ctx(),
    )) as {
      summary: string;
      alignment: { requirement: string; resumeEvidence: string | null }[];
      prepGaps: string[];
    };

    const caching = out.alignment.find((a) => a.requirement === "Caching")!;
    expect(caching.resumeEvidence).toBeNull();
    const python = out.alignment.find((a) => a.requirement === "Python")!;
    expect(python.resumeEvidence).not.toBeNull();
    expect(RESUME).toContain(python.resumeEvidence!);
    expect(out.prepGaps).toContain("Caching");
    expect(out.summary.length).toBeGreaterThan(0);
  });

  it("tailor: nulls invented evidence the model produced", async () => {
    // bypass the mock — feed a fake runtime that returns fabricated evidence
    const runtime = new MockRuntime();
    runtime.register("resume-coach.tailor", () => ({
      summary: "s",
      emphasize: [],
      deEmphasize: [],
      alignment: [
        {
          requirement: "Python",
          resumeEvidence: "Scaled Kubernetes clusters to 40 nodes",
          suggestion: "",
        },
      ],
      prepGaps: [],
    }));
    const c: SkillContext = {
      runtime,
      logger,
      now: () => new Date(),
    };
    const out = (await resumeCoach.execute(
      {
        mode: "tailor",
        resumeText: RESUME,
        requirements: REQS,
        role: "r",
        level: "senior",
      },
      c,
    )) as { alignment: { resumeEvidence: string | null }[] };
    expect(out.alignment[0]!.resumeEvidence).toBeNull();
  });
});
