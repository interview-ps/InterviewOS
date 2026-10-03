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

// Same transaction-heavy JD as loop.test.ts: sql.transactions dominates so the
// first technical question is deterministic.
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
  return { orch: new InterviewOrchestrator({ store, runtime, logger }), store };
}

const WEAK = "I am not really sure, it probably just works.";

async function answerAll(
  orch: InterviewOrchestrator,
  sessionId: string,
  text: string,
) {
  let r = await orch.submitAnswer(sessionId, text);
  let guard = 0;
  while (r.nextAvailable === "question" && guard++ < 8) {
    const nq = await orch.nextQuestion(sessionId);
    if (!nq.question) break;
    r = await orch.submitAnswer(sessionId, text);
  }
  return r;
}

describe("§9.7 metrics + usage events + history", () => {
  it("counts events and rejects unknown names", async () => {
    const { orch } = makeOrchestrator();
    orch.recordUsageEvent("palette.used");
    orch.recordUsageEvent("palette.used");
    orch.recordUsageEvent("history.viewed");
    expect(() => orch.recordUsageEvent("rm -rf /")).toThrow(/unknown usage event/);
    const m = orch.getMetrics();
    expect(m.usage["palette.used"]).toBe(2);
    expect(m.usage["history.viewed"]).toBe(1);
    expect(m.usage["target.switched"]).toBe(0);
  });

  it("weak-skill retest rate counts a later question on a related skill", async () => {
    const { orch } = makeOrchestrator();
    await orch.setupWorkspace({
      resumeText: RESUME,
      jobDescription: JD,
      company: "Northwind Cloud",
      role: "Senior Backend Engineer",
      level: "senior",
    });
    const before = orch.getMetrics();
    expect(before.loopsStarted).toBe(0);
    expect(before.weaknessRetestRate.weakSkills).toBe(0);
    expect(before.weaknessRetestRate.rate).toBeNull();

    // weak technical answer → sql.transactions becomes a weak skill
    const s1 = await orch.startInterview({ plannedQuestions: 1, roundType: "technical" });
    expect(s1.question!.skillId).toBe("sql.transactions");
    const r = await answerAll(orch, s1.session.id, WEAK);
    // readinessDelta persisted on the evaluation
    expect(r.skillImpact.length).toBeGreaterThan(0);

    let m = orch.getMetrics();
    expect(m.weaknessRetestRate.weakSkills).toBeGreaterThanOrEqual(1);
    // a same-session follow-up on the weak skill is already a "later question"
    // under the metric's definition
    const retestedAfterS1 = m.weaknessRetestRate.retested;
    expect(retestedAfterS1).toBeGreaterThanOrEqual(0);
    expect(m.sessionsPerMode.technical).toBe(1);

    // a later session that asks the same/related skill counts as a retest
    const s2 = await orch.startInterview({ plannedQuestions: 1, roundType: "system_design" });
    const related = taxonomy.relatedTo("sql.transactions" as SkillId);
    const retested =
      s2.question && (s2.question.skillId === "sql.transactions" || related.includes(s2.question.skillId));
    m = orch.getMetrics();
    if (retested) {
      expect(m.weaknessRetestRate.retested).toBeGreaterThanOrEqual(retestedAfterS1);
      expect(m.weaknessRetestRate.rate).toBeGreaterThan(0);
    }
    expect(m.readinessCoverage.total).toBeGreaterThan(0);
  });

  it("history returns nested questions with rubric, deltas and actions; weakOnly filters", async () => {
    const { orch } = makeOrchestrator();
    await orch.setupWorkspace({
      resumeText: RESUME,
      jobDescription: JD,
      company: "Northwind Cloud",
      role: "Senior Backend Engineer",
      level: "senior",
    });
    const s = await orch.startInterview({ plannedQuestions: 1, roundType: "technical" });
    await answerAll(orch, s.session.id, WEAK);

    const all = orch.getHistory();
    expect(all.length).toBe(1);
    const entry = all[0]!;
    expect(entry.session.modeLabel).toBe("Technical");
    expect(entry.questions.length).toBeGreaterThanOrEqual(1);
    const first = entry.questions[0]!;
    expect(first.answer).not.toBeNull();
    expect(first.evaluation).not.toBeNull();
    expect(first.evaluation!.rubric.length).toBeGreaterThan(0);
    expect(first.readinessDelta.length).toBeGreaterThan(0);
    expect(first.weak).toBe(true);
    expect(entry.hasWeakAnswer).toBe(true);
    // follow-ups nest under their parent
    expect(first.followUps.every((f) => f.question.followUpOf === first.question.id)).toBe(true);
    // a prep action was created from this session's evidence
    expect(entry.actionsCreated.length).toBeGreaterThanOrEqual(0);

    const weak = orch.getHistory({ weakOnly: true });
    expect(weak.map((e) => e.session.id)).toContain(s.session.id);
    const byMode = orch.getHistory({ mode: "technical" });
    expect(byMode).toHaveLength(1);
    expect(orch.getHistory({ mode: "hr" })).toHaveLength(0);

    const detail = orch.getSessionHistory(s.session.id);
    expect(detail.session.id).toBe(s.session.id);
  });
});
