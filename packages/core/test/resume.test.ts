import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  atsCheck,
  guardSuggestion,
  selectWeakestBullets,
  type Requirement,
} from "../src/index.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

function exampleResume(name: string): string {
  return fs.readFileSync(
    path.join(REPO_ROOT, "examples", name, "resume.md"),
    "utf8",
  );
}

function req(skillId: string, kind: "required" | "preferred" = "required"): Requirement {
  return {
    skillId: skillId as Requirement["skillId"],
    label: skillId,
    importance: 0.8,
    kind,
    evidence: "",
  };
}

const BACKEND_REQS: Requirement[] = [
  req("python"),
  req("apis.rest"),
  req("sql"),
  req("distributed-systems.caching"),
  req("distributed-systems.message-queues"),
];

const check = (r: ReturnType<typeof atsCheck>, id: string) =>
  r.checks.find((c) => c.id === id)!;

describe("atsCheck (§9.5)", () => {
  it("scores the three example resumes deterministically", () => {
    // bullets per example: backend 7 → pass, data 5 → warn, pm 5 → warn
    const bulletStatus: Record<string, string> = {
      "backend-engineer": "pass",
      "data-engineer": "warn",
      "product-manager": "warn",
    };
    for (const name of ["backend-engineer", "data-engineer", "product-manager"]) {
      const r = atsCheck(exampleResume(name), BACKEND_REQS);
      // minimal seed resumes: headings + bullets present, no contact/dates/numbers
      expect(check(r, "headings").status).toBe("pass");
      expect(check(r, "bullets").status).toBe(bulletStatus[name]);
      expect(check(r, "contact").status).toBe("fail");
      expect(check(r, "dates").status).toBe("fail");
      expect(check(r, "length").status).toBe("fail"); // all under 150 words
      expect(check(r, "quantified").status).toBe("fail");
      expect(check(r, "first_person").status).toBe("pass");
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100);
    }
  });

  it("finds required-skill keywords via the taxonomy (children count)", () => {
    const r = atsCheck(exampleResume("backend-engineer"), BACKEND_REQS);
    const presentIds = r.keywordCoverage.present.map((p) => p.skillId);
    expect(presentIds).toContain("python");
    expect(presentIds).toContain("apis.rest");
    expect(presentIds).toContain("sql");
    // caching/message-queues are genuinely absent from the backend example
    const missingIds = r.keywordCoverage.missing.map((m) => m.skillId);
    expect(missingIds).toContain("distributed-systems.caching");
    expect(missingIds).toContain("distributed-systems.message-queues");
    // present entries cite where: first matching line, trimmed
    const py = r.keywordCoverage.present.find((p) => p.skillId === "python")!;
    expect(py.snippet.length).toBeGreaterThan(0);
    expect(exampleResume("backend-engineer")).toContain(py.snippet);
  });

  it("fails a crafted bad resume (no email, no headings, 120 words)", () => {
    const bad =
      "I worked at various companies doing many things. " +
      "I am a hard worker and I love technology and teamwork. ".repeat(12);
    expect(bad.split(/\s+/).length).toBeGreaterThan(100);
    const r = atsCheck(bad, BACKEND_REQS);
    expect(check(r, "contact").status).toBe("fail");
    expect(check(r, "headings").status).toBe("fail");
    expect(check(r, "length").status).toBe("fail"); // <150 words
    expect(check(r, "bullets").status).toBe("fail");
    expect(check(r, "first_person").status).toBe("fail"); // lots of "I"
    expect(check(r, "keywords").status).toBe("fail");
    expect(r.score).toBeLessThan(20);
  });

  it("warns on borderline length and reports the quantified ratio", () => {
    const words = Array(350).fill("experience").join(" ");
    const resume = `a@b.com\n+1 555 123 4567\n\n## Experience\n${words}\n- Built x\n- Led y\n- Reduced z\n- Shipped w\n- Owned v\n- Improved u by 3`;
    const r = atsCheck(resume, []);
    expect(check(r, "length").status).toBe("pass");
    const q = check(r, "quantified");
    expect(q.detail).toMatch(/1 of 6 bullets include a number \(17%\)/);
    expect(q.status).toBe("warn");
  });

  it("finishes quickly on pathological input (bounded quantifiers, no ReDoS)", () => {
    // CodeQL js/polynomial-redos: unbounded ambiguous quantifiers on uncontrolled
    // text are quadratic. Crafted inputs that hit each regex's worst case.
    const hostile = [
      "+".repeat(200_000), // EMAIL_RE local-part class
      "a@b.com\n",
      "1" + ".".repeat(200_000), // PHONE_RE middle class vs trailing \d
      "1" + ",".repeat(200_000), // NUMBER_RE [\d,]
      "jan" + "u".repeat(200_000) + " ".repeat(200_000), // MONTH_RE [a-z]*\s*
    ].join("\n");
    const start = performance.now();
    const r = atsCheck(hostile, BACKEND_REQS);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(2_000);
    expect(r.checks.length).toBeGreaterThan(0);
  });
});

describe("guardSuggestion (§9.5)", () => {
  const resume =
    "## Experience\n- Built Python REST APIs at Acme Payments using PostgreSQL\n- Led migration to AWS";

  it("replaces invented numbers with [add metric]", () => {
    const r = guardSuggestion(
      "Built Python REST APIs",
      "Built Python REST APIs, improving latency by 40%",
      resume,
    );
    expect(r.ok).toBe(true);
    expect(r.improved).toContain("[add metric]");
    expect(r.improved).not.toContain("40%");
    expect(r.substitutions).toEqual(["40%"]);
  });

  it("handles currency, multipliers and k/M suffixes", () => {
    const r = guardSuggestion(
      "Built Python REST APIs",
      "Saved $120k and grew traffic 3M to 10x at 1.5s latency",
      resume,
    );
    expect(r.ok).toBe(true);
    expect(r.substitutions.length).toBe(4);
    expect(r.improved.match(/\[add metric\]/g)!.length).toBe(4);
  });

  it("keeps numbers that appear in the resume", () => {
    const r = guardSuggestion(
      "Led migration to AWS",
      "Led the 2021 migration to AWS",
      "Led migration to AWS in 2021",
    );
    expect(r.ok).toBe(true);
    expect(r.substitutions).toEqual([]);
    expect(r.improved).toContain("2021");
  });

  it("drops suggestions inventing entities not in the resume", () => {
    const r = guardSuggestion(
      "Built Python REST APIs",
      "Built Python REST APIs on Kubernetes",
      resume,
    );
    expect(r.ok).toBe(false);
    expect(r.dropped).toMatch(/Kubernetes/);
  });

  it("keeps entities present in the resume (PostgreSQL, AWS)", () => {
    const r = guardSuggestion(
      "Built Python REST APIs at Acme Payments using PostgreSQL",
      "Built Python REST APIs at Acme Payments backed by PostgreSQL and deployed on AWS",
      resume,
    );
    expect(r.ok).toBe(true);
    expect(r.improved).toContain("PostgreSQL");
    expect(r.improved).toContain("AWS");
  });

  it("allows sentence-initial common verbs like 'Reduced'", () => {
    const r = guardSuggestion(
      "Built Python REST APIs",
      "Reduced p99 latency of Python REST APIs",
      resume,
    );
    expect(r.ok).toBe(true);
    expect(r.improved).toMatch(/^Reduced/);
  });

  it("is strict: API/REST/SQL must exist in the resume", () => {
    const r = guardSuggestion(
      "Wrote backend services",
      "Designed REST endpoints backed by SQL",
      "Wrote backend services for internal tools",
    );
    expect(r.ok).toBe(false);
    expect(r.dropped).toMatch(/REST|SQL/);
  });

  it("finishes quickly on pathological input (bounded quantifiers, no ReDoS)", () => {
    // CodeQL js/polynomial-redos: crafted inputs hitting each guard regex.
    const improved = [
      "[".repeat(200_000), // PLACEHOLDER_RE with no closing ]
      "1" + ",".repeat(200_000), // NUMBER_TOKEN_RE [\d,]
      "A" + "+a".repeat(100_000), // ENTITY_RE suffix group
    ].join(" ");
    const start = performance.now();
    const r = guardSuggestion("Built APIs", improved, resume);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(2_000);
    expect(typeof r.ok).toBe("boolean");
  });
});

describe("selectWeakestBullets (§9.5)", () => {
  it("prioritises bullets lacking numbers and action verbs", () => {
    const resume = [
      "## Experience",
      "- Responsible for the backend service",
      "- Built caching layer reducing load 40%",
      "- Team player on migrations",
      "- Improved deploy pipeline",
    ].join("\n");
    const picked = selectWeakestBullets(resume, 3);
    expect(picked).toHaveLength(3);
    // weakest first: missing both number and action verb
    expect(picked[0]).toContain("Responsible for the backend");
    expect(picked[1]).toContain("Team player");
    // strong bullet (verb + number) not in the top 3
    expect(picked.some((b) => b.includes("caching"))).toBe(false);
  });

  it("caps at max bullets", () => {
    const resume = Array.from(
      { length: 12 },
      (_, i) => `- bullet number ${i + 1}`,
    ).join("\n");
    expect(selectWeakestBullets(resume, 8)).toHaveLength(8);
  });

  it("only picks bullets from experience/projects sections", () => {
    const resume = [
      "# Jordan Reyes",
      "",
      "## Experience",
      "- Senior Backend Engineer — Acme Payments — designed Python REST APIs",
      "",
      "## Projects",
      "- LedgerSync — a Python reconciliation service",
      "",
      "## Education",
      "- BSc Computer Science — Ridgeview University",
      "",
      "## Skills",
      "- Python, SQL, distributed systems",
      "",
      "## Contact",
      "- jordan@example.com",
    ].join("\n");
    const picked = selectWeakestBullets(resume, 8);
    expect(picked).toHaveLength(2);
    expect(picked.some((b) => b.includes("Ridgeview"))).toBe(false);
    expect(picked.some((b) => b.includes("distributed systems"))).toBe(false);
    expect(picked.some((b) => b.includes("jordan@"))).toBe(false);
    expect(picked.some((b) => b.includes("Acme"))).toBe(true);
    expect(picked.some((b) => b.includes("LedgerSync"))).toBe(true);
  });
});
