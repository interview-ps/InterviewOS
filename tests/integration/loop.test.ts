import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { taxonomy, type SkillId } from "@interview-os/core";
import { InterviewOrchestrator, openStore } from "@interview-os/server/orchestrator";
import { MockRuntime } from "@interview-os/runtime";
import { createLogger } from "@interview-os/core";
import { registerMockHandlers } from "@interview-os/server/skills";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RESUME = fs.readFileSync(
  path.join(REPO_ROOT, "examples/backend-engineer/resume.md"),
  "utf8",
);

// A JD that makes sql.transactions the dominant requirement so the technical
// round's first question targets it deterministically (§9.1 scope: technical
// covers sql.*; coding can't reach it).
const JD = `Senior Backend Engineer — Northwind Cloud
Requirements:
- Deep experience with SQL transactions: ACID guarantees, transactions under
  concurrency, transactions on Postgres, isolation level choices, rollback and
  deadlock handling.
`;

function makeOrchestrator() {
  const logger = createLogger({ level: "error", sink: () => {} });
  const runtime = new MockRuntime();
  registerMockHandlers(runtime);
  const store = openStore(":memory:");
  const orch = new InterviewOrchestrator({ store, runtime, logger });
  return { orch, store, runtime };
}

async function setup(orch: InterviewOrchestrator) {
  await orch.setupWorkspace({
    resumeText: RESUME,
    jobDescription: JD,
    company: "Northwind Cloud",
    role: "Senior Backend Engineer",
    level: "senior",
  });
}

/** Answer every remaining question (incl. follow-ups) with `text`. */
async function drainRound(orch: InterviewOrchestrator, sessionId: string, text: string) {
  let r = await orch.submitAnswer(sessionId, text);
  let guard = 0;
  while (r.nextAvailable === "question" && guard++ < 8) {
    const nq = await orch.nextQuestion(sessionId);
    if (!nq.question) break;
    r = await orch.submitAnswer(sessionId, text);
  }
  return r;
}

const WEAK = "Hmm, I am not sure — it just works somehow.";

describe("§9.4 full interview loops", () => {
  it("technical → system_design → behavioral carries weak skills forward", async () => {
    const { orch, store } = makeOrchestrator();
    await setup(orch);

    const started = await orch.startLoop({
      rounds: [
        { mode: "technical", label: "Deep technical", plannedQuestions: 1 },
        { mode: "system_design", label: "Design", plannedQuestions: 1 },
        { mode: "behavioral", label: "Behavioral", plannedQuestions: 1 },
      ],
    });
    const loopId = started.loop.id;
    expect(started.loop.rounds).toHaveLength(3);
    expect(started.question).not.toBeNull();
    // round 1 targets the dominant requirement: sql.transactions
    expect(started.question!.skillId).toBe("sql.transactions");
    const r1sid = started.session.id;
    expect(started.session.loopId).toBe(loopId);
    expect(started.session.loopRound).toBe(1);

    // --- round 1: answer weakly, then complete → handoff + next round
    await drainRound(orch, r1sid, WEAK);
    const done1 = await orch.completeInterview(r1sid);
    const loop1 = done1.loop!;
    const round1 = loop1.rounds[0]!;
    expect(round1.status).toBe("complete");
    expect(round1.handoff!.weakSkills.map((w) => w.skillId)).toContain("sql.transactions");
    expect(round1.readinessBefore).not.toBeNull();
    expect(round1.readinessAfter).not.toBeNull();
    expect(loop1.currentRound).toBe(2);
    expect(loop1.status).toBe("in_progress");

    // --- round 2: system_design picks a related skill with weaknessBoost 1.4
    const q2 = done1.nextQuestion!;
    const weakIds = round1.handoff!.weakSkills.map((w) => w.skillId);
    const inScopeRelated = weakIds
      .flatMap((w) => taxonomy.relatedTo(w as SkillId))
      .filter((s) => s.startsWith("system-design") || s.startsWith("distributed-systems"));
    expect(inScopeRelated).toContain(q2.skillId);
    expect(q2.selectionFactors!.weaknessBoost).toBe(1.4);
    expect(q2.selectionReason).toMatch(/Round 1 \(Technical\)/);
    expect(q2.extra.problem ?? q2.text).toMatch(/design/i);
    const r2sid = done1.nextSession!.id;

    // --- round 3: behavioral
    await drainRound(orch, r2sid, WEAK);
    const done2 = await orch.completeInterview(r2sid);
    expect(done2.nextSession!.roundType).toBe("behavioral");
    const r3sid = done2.nextSession!.id;
    expect(done2.nextQuestion).not.toBeNull();

    // --- final round → loop completes with a loop debrief
    await drainRound(orch, r3sid, WEAK);
    const done3 = await orch.completeInterview(r3sid);
    const loop3 = done3.loop!;
    expect(loop3.status).toBe("complete");
    expect(loop3.completedAt).toBeTruthy();
    expect(loop3.debrief).not.toBeNull();
    expect(loop3.debrief!.summary.length).toBeGreaterThan(10);
    expect(loop3.debrief!.rounds).toHaveLength(3);
    for (const r of loop3.debrief!.rounds) {
      expect(["strong", "mixed", "weak"]).toContain(r.signal);
    }
    // never a hire/no-hire verdict
    expect(loop3.debrief!.summary).not.toMatch(/no-hire|would hire|recommend hiring/i);
    expect(done3.nextSession).toBeNull();

    // readiness snapshots recorded per round
    const stored = store.getLoop(loopId)!;
    for (const r of stored.rounds as { readinessBefore: unknown; readinessAfter: unknown }[]) {
      expect(r.readinessBefore).not.toBeNull();
      expect(r.readinessAfter).not.toBeNull();
    }

    // accessors
    expect(orch.getLoop(loopId).id).toBe(loopId);
    expect(orch.listLoops().map((l) => l.id)).toContain(loopId);
  });

  it("defaults to the company profile's typical loop and validates rounds", async () => {
    const { orch } = makeOrchestrator();
    await setup(orch);
    const started = await orch.startLoop();
    // generic profile typical loop per §9.3
    expect(started.loop.rounds.length).toBeGreaterThanOrEqual(2);
    expect(started.loop.companyProfileId).toBe("generic");
    await expect(orch.abandonLoop(started.loop.id)).resolves.toBeDefined();

    await expect(orch.startLoop({ rounds: [{ mode: "technical" }] })).rejects.toThrow(
      /2 and 7|between/i,
    );
    await expect(
      orch.startLoop({ rounds: [{ mode: "technical" }, { mode: "wat" }] }),
    ).rejects.toThrow();
  });

  it("abandoning a mid-loop session completes the session and closes the loop", async () => {
    const { orch, store } = makeOrchestrator();
    await setup(orch);
    const started = await orch.startLoop({
      rounds: [
        { mode: "technical", plannedQuestions: 1 },
        { mode: "behavioral", plannedQuestions: 1 },
      ],
    });
    const loop = await orch.abandonLoop(started.loop.id);
    expect(loop.status).toBe("complete");
    expect(loop.abandoned).toBe(true);
    const s = store.getSession(started.session.id)!;
    expect(["complete", "debrief"]).toContain(s.status);
    // idempotent
    const again = await orch.abandonLoop(started.loop.id);
    expect(again.status).toBe("complete");
  });
});
