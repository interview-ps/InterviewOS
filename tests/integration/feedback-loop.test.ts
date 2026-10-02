import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { InterviewOrchestrator, openStore } from "@interview-os/orchestrator";
import { MockRuntime } from "@interview-os/runtime";
import { createLogger } from "@interview-os/shared";
import { registerMockHandlers } from "@interview-os/skills";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function loadExample(name: string) {
  const dir = path.join(REPO_ROOT, "examples", name);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
  return {
    resumeText: fs.readFileSync(path.join(dir, "resume.md"), "utf8"),
    jobDescription: fs.readFileSync(path.join(dir, "job.md"), "utf8"),
    company: meta.company as string,
    role: meta.role as string,
    level: meta.level as "senior",
  };
}

describe("feedback loop (canonical)", () => {
  it("runs the full readiness → gap → prep → interview → retest loop", async () => {
    const logger = createLogger({ level: "error", sink: () => {} });
    const runtime = new MockRuntime();
    registerMockHandlers(runtime);
    const store = openStore(":memory:");
    const orch = new InterviewOrchestrator({ store, runtime, logger });

    // --- 1. Setup ---
    const ex = loadExample("backend-engineer");
    const setup = await orch.setupWorkspace(ex);
    expect(setup.gaps.length).toBeGreaterThan(0);
    expect(setup.actions.length).toBeGreaterThan(0);
    const state = await orch.getState();

    const r = state.readiness.dimensions;
    expect(r["python"]!.score!).toBeGreaterThanOrEqual(0.75);
    expect(r["apis"]!.score!).toBeGreaterThanOrEqual(0.75);
    const sql = r["sql"]!;
    expect(sql.score!).toBeGreaterThanOrEqual(0.3);
    expect(sql.score!).toBeLessThan(0.7);

    const deepGaps = state.assessment.gaps.filter(
      (g) => g.severity === "high" || g.severity === "medium",
    );
    expect(
      deepGaps.some(
        (g) =>
          g.skillId.startsWith("distributed-systems") ||
          g.skillId === "system-design",
      ),
    ).toBe(true);
    const pythonGap = state.assessment.gaps.find((g) => g.skillId === "python");
    expect(
      pythonGap === undefined ||
        pythonGap.severity === "none" ||
        pythonGap.severity === "low",
    ).toBe(true);

    expect(
      state.preparation.nextActions.some((a) =>
        a.skillId.startsWith("distributed-systems"),
      ),
    ).toBe(true);

    const snapshotsAfterSetup = store.countReadinessSnapshots();
    expect(snapshotsAfterSetup).toBeGreaterThan(0);

    // --- 2. First interview ---
    const start1 = await orch.startInterview({ plannedQuestions: 1 });
    const session1 = start1.session;
    const q1 = start1.question!;
    expect(q1.skillId).toBe("distributed-systems.caching");
    expect(q1.text).toContain("cache entries consistent");

    // --- 3. Poor answer ---
    const result = await orch.submitAnswer(
      session1.id,
      "I would put Redis in front of the database using cache-aside so reads are fast.",
    );

    const evaln = result.evaluation;
    const invWeakness = evaln.weaknesses.find(
      (w) => w.skill === "distributed-systems.caching.cache-invalidation",
    );
    expect(invWeakness).toBeDefined();
    expect(["medium", "high"]).toContain(invWeakness!.severity);

    const invEvidence = store
      .listEvidence()
      .filter(
        (e) =>
          e.skillId === "distributed-systems.caching.cache-invalidation" &&
          e.type === "interview_answer",
      );
    expect(invEvidence.length).toBe(1);
    expect(invEvidence[0]!.sessionId).toBe(session1.id);
    expect(invEvidence[0]!.questionId).toBe(q1.id);
    const invEvidenceId = invEvidence[0]!.id;

    const invReadiness = await orch.getSkillDetail(
      "distributed-systems.caching.cache-invalidation",
    );
    expect(invReadiness.readiness!.status).toBe("weak");
    expect(invReadiness.readiness!.evidenceIds).toContain(invEvidenceId);

    expect(store.countReadinessSnapshots()).toBeGreaterThan(snapshotsAfterSetup);

    const invAction = result.newActions.find(
      (a) => a.skillId === "distributed-systems.caching.cache-invalidation",
    );
    expect(invAction).toBeDefined();
    expect(invAction!.action.toLowerCase()).toContain("invalidat");
    expect(invAction!.successCriteria.length).toBeGreaterThanOrEqual(2);

    // --- 4. Complete interview 1 ---
    for (let guard = 0; guard < 10; guard++) {
      const current = orch.getInterview(session1.id);
      const status = current.session.status;
      if (status === "complete" || status === "debrief") break;
      if (status === "follow_up") {
        const nq = await orch.nextQuestion(session1.id);
        if (nq.question === null) break;
      } else if (status === "question") {
        const q = current.questions[current.questions.length - 1]!;
        await orch.submitAnswer(
          session1.id,
          `For ${q.topic}: I would define clear ownership, name the trade-offs, and describe validation criteria; in practice I combine a ttl with explicit invalidation on writes.`,
        );
      }
    }
    await orch.completeInterview(session1.id);
    const done1 = orch.getInterview(session1.id);
    expect(done1.session.status).toBe("debrief");
    expect(done1.debrief).toBeTruthy();
    expect((done1.debrief as { summary: string }).summary.length).toBeGreaterThan(0);

    // --- 5. Second interview retests the weakness ---
    const askedTexts = done1.questions.map((q) => q.text);
    const start2 = await orch.startInterview({ plannedQuestions: 2 });
    const q2 = start2.question!;
    expect(q2.skillId.startsWith("distributed-systems.caching")).toBe(true);
    expect(askedTexts).not.toContain(q2.text);
    expect((q2.selectionReason ?? "").toLowerCase()).toContain("weak");
    await orch.completeInterview(start2.session.id);
  }, 60_000);

  it("multi-question session 1 retests in-session; session 2 retests a weak skill", async () => {
    const logger = createLogger({ level: "error", sink: () => {} });
    const runtime = new MockRuntime();
    registerMockHandlers(runtime);
    const store = openStore(":memory:");
    const orch = new InterviewOrchestrator({ store, runtime, logger });
    const ex = loadExample("backend-engineer");
    await orch.setupWorkspace(ex);

    const start1 = await orch.startInterview({ plannedQuestions: 4 });
    const s1 = start1.session.id;
    const q1 = start1.question!;
    expect(q1.skillId).toBe("distributed-systems.caching");

    await orch.submitAnswer(
      s1,
      "I would put Redis in front of the database using cache-aside so reads are fast.",
    );

    const goodAnswer = (q: { topic: string; expectedConcepts?: { concept: string; keywords: string[] }[] }) =>
      `For ${q.topic}: ` +
      (q.expectedConcepts ?? [])
        .map((c) => `I would use ${c.concept} (${c.keywords.join(", ")}), `)
        .join("") +
      "explaining the trade-offs and how I validated the approach.";
    // a short, honest-but-partial answer: the candidate is still weak here
    const partialAnswer = (q: { topic: string; expectedConcepts?: { concept: string; keywords: string[] }[] }) =>
      `For ${q.topic}: honestly I have limited hands-on experience with ` +
      `${q.expectedConcepts?.[0]?.concept ?? "this"} — I would start there and look up the rest.`;

    const answerFor = (q: { selectionReason?: string | null; topic: string; expectedConcepts?: { concept: string; keywords: string[] }[] }) =>
      (q.selectionReason ?? "").includes("retesting") ? partialAnswer(q) : goodAnswer(q);

    // finish session 1 with reasonable answers
    const s1Questions: string[] = [q1.skillId];
    for (let guard = 0; guard < 10; guard++) {
      const cur = orch.getInterview(s1);
      const status = cur.session.status;
      if (status === "complete" || status === "debrief") break;
      if (status === "follow_up") {
        const nq = await orch.nextQuestion(s1);
        if (!nq.question) break;
        s1Questions.push(nq.question.skillId);
      } else if (status === "question") {
        const q = cur.questions[cur.questions.length - 1]!;
        await orch.submitAnswer(s1, answerFor(q));
      }
    }
    await orch.completeInterview(s1);

    // (a) an in-session follow-up targeted a weak skill from the first answer
    const retestInSession = s1Questions.slice(1).filter((s) =>
      s.startsWith("distributed-systems.caching.") || s === "distributed-systems.consistency",
    );
    expect(retestInSession.length).toBeGreaterThan(0);
    const retestQ = orch
      .getInterview(s1)
      .questions.find((q) => q.skillId === retestInSession[0])!;
    expect(retestQ.selectionReason?.toLowerCase()).toContain("retest");

    // skills with weak interview evidence at end of session 1
    const weakAtEnd = new Set(
      store
        .listEvidence()
        .filter((e) => e.type === "interview_answer" && e.score < 0.5)
        .map((e) => e.skillId),
    );
    expect(weakAtEnd.size).toBeGreaterThan(0);

    // (b) session 2 asks at least one question on a weak-evidence skill
    const start2 = await orch.startInterview({ plannedQuestions: 4 });
    const s2 = start2.session.id;
    const s2Questions = start2.question ? [start2.question] : [];
    for (let guard = 0; guard < 10 && s2Questions.length < 4; guard++) {
      const cur = orch.getInterview(s2);
      if (cur.session.status === "question") {
        const q = cur.questions[cur.questions.length - 1]!;
        await orch.submitAnswer(s2, goodAnswer(q));
      } else if (cur.session.status === "follow_up") {
        const nq = await orch.nextQuestion(s2);
        if (!nq.question) break;
        s2Questions.push(nq.question);
      } else break;
    }
    const retest = s2Questions.find(
      (q) =>
        weakAtEnd.has(q.skillId) &&
        (q.selectionReason ?? "").toLowerCase().includes("retest"),
    );
    expect(retest, `expected a retest question; got ${s2Questions.map((q) => q.skillId)}`).toBeDefined();
    await orch.completeInterview(s2);
  }, 60_000);
});
