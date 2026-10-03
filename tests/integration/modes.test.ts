import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getMode, inRound, type RoundType } from "@interview-os/core";
import { InterviewOrchestrator, openStore } from "@interview-os/server/orchestrator";
import { MockRuntime } from "@interview-os/runtime";
import { createLogger } from "@interview-os/core";
import { registerMockHandlers } from "@interview-os/server/skills";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function loadExample(name: string) {
  const dir = path.join(REPO_ROOT, "examples", name);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
  const companyFile = path.join(dir, "company.md");
  return {
    resumeText: fs.readFileSync(path.join(dir, "resume.md"), "utf8"),
    jobDescription: fs.readFileSync(path.join(dir, "job.md"), "utf8"),
    company: meta.company as string,
    role: meta.role as string,
    level: meta.level as "senior",
    companyNotes: fs.existsSync(companyFile)
      ? fs.readFileSync(companyFile, "utf8")
      : undefined,
  };
}

function makeOrchestrator() {
  const logger = createLogger({ level: "error", sink: () => {} });
  const runtime = new MockRuntime();
  registerMockHandlers(runtime);
  const store = openStore(":memory:");
  const orch = new InterviewOrchestrator({ store, runtime, logger });
  return { orch, store, runtime };
}

const MODES: RoundType[] = [
  "technical",
  "coding",
  "system_design",
  "behavioral",
  "hiring_manager",
  "hr",
];

describe("interview modes (§9.1)", () => {
  for (const mode of MODES) {
    it(`starts a ${mode} session with an in-scope question`, async () => {
      const { orch, store } = makeOrchestrator();
      await orch.setupWorkspace(loadExample("backend-engineer"));
      const start = await orch.startInterview({ plannedQuestions: 1, roundType: mode });
      expect(start.question).not.toBeNull();
      expect(inRound(start.question!.skillId, mode)).toBe(true);
      const session = store.getSession(start.session.id)!;
      expect(session.roundType).toBe(mode);
      expect(session.modeState).toBeDefined();
    });
  }

  it("coding: weak answer triggers a complexity follow-up that doesn't consume the plan", async () => {
    const { orch, store } = makeOrchestrator();
    await orch.setupWorkspace(loadExample("backend-engineer"));
    const start = await orch.startInterview({ plannedQuestions: 1, roundType: "coding" });
    const q1 = start.question!;
    expect(q1.extra.problem).toBeTruthy(); // coding problems carry a statement

    const result = await orch.submitAnswer(start.session.id, {
      text: "I would iterate over the items and collect the latest ones.",
      code: "def recentK(items, k):\n    out = []\n    for x in items:\n        if x not in out: out.append(x)\n    return out[-k:]",
      language: "python",
    });
    const complexity = result.evaluation.rubric.find((r) => r.id === "complexity");
    expect(complexity).toBeDefined();
    expect(complexity!.score).toBeLessThan(0.6);
    // the answer row stored the code
    const answers = store.listAnswers(start.session.id);
    expect(answers[0]!.code).toContain("def recentK");
    expect(answers[0]!.language).toBe("python");
    expect(result.nextAvailable).toBe("question");

    // next() asks the follow-up — same skill, linked, focused on complexity
    const next = await orch.nextQuestion(start.session.id);
    const q2 = next.question!;
    expect(q2.followUpOf).toBe(q1.id);
    expect(q2.followUpFocus!.toLowerCase()).toContain("complexity");
    expect(q2.text.toLowerCase()).toContain("complexity");

    // the follow-up did not consume a planned question slot
    const questions = store.listQuestions(start.session.id);
    expect(questions.filter((q) => !q.followUpOf).length).toBe(1);
    expect(questions.length).toBe(2);
  });

  it("system_design walks dimensions across turns and progress is tracked", async () => {
    const { orch, store } = makeOrchestrator();
    await orch.setupWorkspace(loadExample("backend-engineer"));
    const start = await orch.startInterview({
      plannedQuestions: 4,
      roundType: "system_design",
    });
    const sid = start.session.id;
    expect(start.question!.extra.problem).toBeTruthy();

    // turn 1: cover requirements + scale → dims move from not_covered
    await orch.submitAnswer(sid, {
      text: "Requirements: shorten URLs and redirect fast. Scale estimate: 1k QPS writes, 100k QPS reads, about 10GB storage growth per year. Constraints: low latency redirects.",
    });
    let s = store.getSession(sid)!;
    let dims = (s.modeState as { dimensions: Record<string, { status: string }> }).dimensions;
    expect(dims.requirements!.status).not.toBe("not_covered");
    expect(s.modeState.problem).toBeTruthy();

    // turn 2: probes the first still-uncovered dimension
    const q2 = (await orch.nextQuestion(sid)).question!;
    expect(q2.extra.focusDimension).toBeTruthy();
    await orch.submitAnswer(sid, {
      text: "Architecture: a load balancer in front of stateless app servers writing to Postgres, with Redis as a read cache for hot redirects.",
    });
    s = store.getSession(sid)!;
    dims = (s.modeState as { dimensions: Record<string, { status: string }> }).dimensions;
    const covered = Object.values(dims).filter((d) => d.status !== "not_covered");
    expect(covered.length).toBeGreaterThanOrEqual(3);

    // turn 3: still probing uncovered dimensions
    const q3 = (await orch.nextQuestion(sid)).question!;
    expect(q3.extra.focusDimension).toBeTruthy();
    const status = (s.modeState as { dimensions: Record<string, { status: string }> })
      .dimensions[q3.extra.focusDimension as string]!.status;
    expect(status).not.toBe("covered");
  });

  it("behavioral and hiring_manager evaluations carry exactly the mode rubric ids", async () => {
    const { orch } = makeOrchestrator();
    await orch.setupWorkspace(loadExample("backend-engineer"));

    const beh = await orch.startInterview({ plannedQuestions: 1, roundType: "behavioral" });
    const behRes = await orch.submitAnswer(
      beh.session.id,
      "When I was at Acme our team had an outage and I led the fix, which reduced MTTR by 40% and we shipped it.",
    );
    expect(behRes.evaluation.rubric.map((r) => r.id).sort()).toEqual(
      getMode("behavioral")
        .rubric.map((r) => r.id)
        .sort(),
    );

    const hm = await orch.startInterview({ plannedQuestions: 1, roundType: "hiring_manager" });
    expect(inRound(hm.question!.skillId, "hiring_manager")).toBe(true);
    const hmRes = await orch.submitAnswer(
      hm.session.id,
      "At Acme I owned a payments migration end to end — scope was three teams, we cut latency by 30%, and I chose to deprioritize reporting to protect the launch because impact mattered more.",
    );
    expect(hmRes.evaluation.rubric.map((r) => r.id).sort()).toEqual(
      getMode("hiring_manager")
        .rubric.map((r) => r.id)
        .sort(),
    );
  });
});

describe("§9.3 company follow-up depth", () => {
  it("amazon allows two chained follow-ups; generic allows one", async () => {
    // Amazon — auto-matched profile, followUpDepth 2
    const a = makeOrchestrator();
    const ex = loadExample("backend-engineer");
    await a.orch.setupWorkspace({ ...ex, company: "Amazon", companyNotes: undefined });
    const aTarget = (await a.orch.getState()).target;
    expect(aTarget.companyProfileId).toBe("amazon");

    const start = await a.orch.startInterview({ plannedQuestions: 2, roundType: "behavioral" });
    const sid = start.session.id;
    const weak = "Hmm, I guess we worked on something once."; // no STAR, all misses
    const r1 = await a.orch.submitAnswer(sid, weak);
    expect(r1.nextAvailable).toBe("question");
    const fu1 = (await a.orch.nextQuestion(sid)).question!;
    expect(fu1.followUpOf).toBe(start.question!.id);
    const r2 = await a.orch.submitAnswer(sid, weak);
    expect(r2.nextAvailable).toBe("question");
    const fu2 = (await a.orch.nextQuestion(sid)).question!;
    // second follow-up chains under the SAME main question
    expect(fu2.followUpOf).toBe(start.question!.id);
    await a.orch.submitAnswer(sid, weak);
    // depth 2 reached → no third follow-up; next is a fresh main question
    const q3 = (await a.orch.nextQuestion(sid)).question!;
    expect(q3.followUpOf).toBeNull();

    // Generic — followUpDepth 1
    const g = makeOrchestrator();
    await g.orch.setupWorkspace(loadExample("backend-engineer"));
    const gstart = await g.orch.startInterview({ plannedQuestions: 2, roundType: "behavioral" });
    const gsid = gstart.session.id;
    await g.orch.submitAnswer(gsid, weak);
    const gfu = (await g.orch.nextQuestion(gsid)).question!;
    expect(gfu.followUpOf).toBe(gstart.question!.id);
    await g.orch.submitAnswer(gsid, weak);
    const gq3 = (await g.orch.nextQuestion(gsid)).question!;
    expect(gq3.followUpOf).toBeNull(); // depth 1 reached
  });

  it("auto-matches the target to a profile and PATCH re-applies boosts", async () => {
    const { orch, store } = makeOrchestrator();
    await orch.setupWorkspace(loadExample("backend-engineer"));
    const { target } = await orch.getState();
    expect(target.companyProfileId).toBe("generic"); // Northwind isn't a known company

    const patched = await orch.updateTargetCompanyProfile(target.id, "amazon");
    const t2 = patched.target;
    expect(t2.companyProfileId).toBe("amazon");
    // no compounding: importance == baseImportance + boost, capped at 0.95
    for (const r of [...t2.requirements, ...t2.preferredSkills]) {
      const base = r.baseImportance ?? r.importance;
      expect(r.importance).toBeLessThanOrEqual(0.95);
      if (r.boostedBy) expect(r.importance).toBeGreaterThanOrEqual(base);
    }
    // switching back to generic clears profile emphasis; the §8.4 notes overlay
    // (+0.05, cap 0.95, boostedBy "company-profile") may still apply.
    const reverted = await orch.updateTargetCompanyProfile(target.id, "generic");
    for (const r of [
      ...reverted.target.requirements,
      ...reverted.target.preferredSkills,
    ]) {
      expect(r.boostedBy === "company-profile:amazon").toBe(false);
      const base = r.baseImportance ?? r.importance;
      expect(r.importance).toBeCloseTo(
        Math.min(0.95, base + (r.boostedBy === "company-profile" ? 0.05 : 0)),
        6,
      );
    }
    expect(orch.listCompanyProfiles().length).toBe(5);
    expect(store.getTarget(target.id)).toBeDefined();
  });
});
