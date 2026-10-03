import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { taxonomy, type SkillId } from "@interview-os/core";
import { InterviewOrchestrator, openStore } from "@interview-os/orchestrator";
import { MockRuntime } from "@interview-os/runtime";
import { createLogger } from "@interview-os/shared";
import { registerMockHandlers } from "@interview-os/skills";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RESUME = fs.readFileSync(
  path.join(REPO_ROOT, "examples/backend-engineer/resume.md"),
  "utf8",
);

// Transaction-heavy JD: sql.transactions dominates so round 1 of the loop is
// deterministic (technical scope covers sql.*; coding cannot reach it — §9.1).
const JD = `Senior Backend Engineer — Northwind Cloud
Requirements:
- Deep experience with SQL transactions: ACID guarantees, transactions under
  concurrency, transactions on Postgres, isolation level choices, rollback and
  deadlock handling.
`;

const WEAK = "I am not really sure — it probably just works somehow.";

async function answerAll(orch: InterviewOrchestrator, sessionId: string, text = WEAK) {
  let r = await orch.submitAnswer(sessionId, text);
  let guard = 0;
  while (r.nextAvailable === "question" && guard++ < 8) {
    const nq = await orch.nextQuestion(sessionId);
    if (!nq.question) break;
    r = await orch.submitAnswer(sessionId, text);
  }
  return r;
}

describe("v0.3 definition of done (§9, mock)", () => {
  it("two targets, amazon profile, all six modes, a full loop, review, history, metrics", async () => {
    const logger = createLogger({ level: "error", sink: () => {} });
    const runtime = new MockRuntime();
    registerMockHandlers(runtime);
    const store = openStore(":memory:");
    const orch = new InterviewOrchestrator({ store, runtime, logger });

    // --- two targets; the second becomes active
    await orch.setupWorkspace({
      resumeText: RESUME,
      jobDescription: JD,
      company: "Northwind Cloud",
      role: "Senior Backend Engineer",
      level: "senior",
    });
    const t2 = await orch.addTarget({
      jobDescription: `Staff Backend Engineer — Contoso\nRequirements:\n- Platform APIs, caching strategy, incident response.`,
      company: "Contoso",
      role: "Staff Backend Engineer",
      level: "staff",
    });
    const targets = orch.listTargets();
    expect(targets.length).toBe(2);
    expect(targets.find((t) => t.active)?.id).toBe(t2.target.id);

    // --- company profile: amazon, followUpDepth 2
    const amazon = orch.listCompanyProfiles().find((p) => p.id === "amazon")!;
    expect(amazon.followUpDepth).toBe(2);
    const patched = await orch.updateTargetCompanyProfile(t2.target.id, "amazon");
    expect(patched.target.companyProfileId).toBe("amazon");
    expect(orch.listTargets().find((t) => t.id === t2.target.id)!.companyProfileId).toBe(
      "amazon",
    );

    // --- one session per mode
    const modes = [
      "technical",
      "coding",
      "system_design",
      "behavioral",
      "hr",
      "hiring_manager",
    ] as const;
    for (const mode of modes) {
      const s = await orch.startInterview({ roundType: mode, plannedQuestions: 1 });
      expect(s.question).not.toBeNull();
      await answerAll(orch, s.session.id);
      const done = await orch.completeInterview(s.session.id);
      expect(done.debrief).not.toBeNull();
    }

    // --- a full loop where round-1 weakness drives round-2 selection
    const started = await orch.startLoop({
      rounds: [
        { mode: "technical", label: "Deep technical", plannedQuestions: 1 },
        { mode: "system_design", label: "Design", plannedQuestions: 1 },
      ],
    });
    const loopId = started.loop.id;
    expect(started.session.loopId).toBe(loopId);
    await answerAll(orch, started.session.id);
    const done1 = await orch.completeInterview(started.session.id);
    const round1 = done1.loop!.rounds[0]!;
    expect(round1.handoff!.weakSkills.length).toBeGreaterThan(0);

    // round 2 selection retests an earlier weakness (boost ≥ 1.4, reason names round 1)
    const q2 = done1.nextQuestion!;
    const weakIds = round1.handoff!.weakSkills.map((w) => w.skillId);
    const related = new Set(weakIds.flatMap((w) => taxonomy.relatedTo(w as SkillId)));
    expect(
      weakIds.includes(q2.skillId) || related.has(q2.skillId),
    ).toBe(true);
    expect(q2.selectionFactors!.weaknessBoost).toBeGreaterThanOrEqual(1.4);
    expect(q2.selectionReason).toMatch(/Round 1/i);

    await answerAll(orch, done1.nextSession!.id);
    const done2 = await orch.completeInterview(done1.nextSession!.id);
    const loop = done2.loop!;
    expect(loop.status).toBe("complete");
    expect(loop.debrief).not.toBeNull();
    expect(loop.debrief!.rounds).toHaveLength(2);

    // readiness snapshots + per-round skill deltas after each round
    const stored = store.getLoop(loopId)!;
    for (const r of stored.rounds as {
      readinessBefore: unknown;
      readinessAfter: unknown;
      skillDeltas: { skillId: string; label: string }[];
    }[]) {
      expect(r.readinessBefore).not.toBeNull();
      expect(r.readinessAfter).not.toBeNull();
      expect(r.skillDeltas.length).toBeGreaterThan(0);
      // labels are human-readable, never raw ids
      expect(r.skillDeltas.every((d) => d.label && !d.label.includes("."))).toBe(true);
    }

    // --- prep actions exist (generated at setup + after interviews)
    const actions = orch.listPreparationActions();
    expect(actions.length).toBeGreaterThan(0);

    // --- resume review ran through the guard
    const review = await orch.reviewResume();
    expect(review.ats.score).toBeGreaterThanOrEqual(0);
    expect(review.suggestions.length).toBeGreaterThan(0);
    expect(review.suggestions.some((s) => s.improved.includes("[add metric]"))).toBe(true);

    // --- history returns all sessions with mode/company/target/loop
    const history = orch.getHistory();
    expect(history.length).toBe(modes.length + 2);
    for (const e of history) {
      expect(e.session.modeLabel ?? e.session.roundType).toBeTruthy();
      expect(e.target?.id).toBe(t2.target.id);
      expect(e.target?.companyProfileId).toBe("amazon");
    }
    const loopEntries = history.filter((e) => e.loop);
    expect(loopEntries.length).toBe(2);
    expect(loopEntries.map((e) => e.loop!.id)).toEqual([loopId, loopId]);
    expect(loopEntries.map((e) => e.loop!.round).sort()).toEqual([1, 2]);

    // --- non-trivial metrics
    const m = orch.getMetrics();
    expect(
      Object.values(m.sessionsPerMode).filter((n) => n > 0).length,
    ).toBeGreaterThanOrEqual(6);
    expect(m.loopsCompleted).toBe(1);
    expect(m.loopsStarted).toBe(1);
    expect(m.weaknessRetestRate.rate).not.toBeNull();
    expect(m.weaknessRetestRate.rate!).toBeGreaterThan(0);
    expect(m.readinessCoverage.total).toBeGreaterThan(0);
  });
});
