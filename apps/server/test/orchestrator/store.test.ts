import { describe, expect, it } from "vitest";
import { openStore } from "../../src/orchestrator/index.js";

describe("store", () => {
  it("persists entities and keeps readiness snapshots append-only", async () => {
    const store = openStore(":memory:");
    await store.insertCandidate({
      id: "c1",
      active: 1,
      name: "Test",
      headline: null,
      resumeText: "resume",
      data: { id: "c1", name: "Test", skills: [] },
      createdAt: "2026-01-01T00:00:00Z",
    });
    await store.insertCandidate({
      id: "c2",
      active: 1,
      name: "New",
      headline: null,
      resumeText: "resume2",
      data: { id: "c2", name: "New", skills: [] },
      createdAt: "2026-01-02T00:00:00Z",
    });
    await store.deactivateCandidates();
    await store.insertCandidate({
      id: "c3",
      active: 1,
      name: "Active",
      headline: null,
      resumeText: "resume3",
      data: { id: "c3", name: "Active", skills: [] },
      createdAt: "2026-01-03T00:00:00Z",
    });
    expect((await store.getActiveCandidate())!.id).toBe("c3");

    await store.insertEvidence({
      id: "e1",
      candidateId: "c3",
      skillId: "python",
      type: "resume_claim",
      score: 0.9,
      confidence: 0.5,
      observation: "resume",
      sessionId: null,
      questionId: null,
      createdAt: "2026-01-03T00:00:00Z",
    });
    await store.insertEvidence({
      id: "e2",
      candidateId: "c3",
      skillId: "python",
      type: "interview_answer",
      score: 0.2,
      confidence: 0.7,
      observation: "weak",
      sessionId: "s1",
      questionId: "q1",
      createdAt: "2026-01-04T00:00:00Z",
    });
    expect(await store.listEvidence("c3")).toHaveLength(2);
    expect((await store.evidenceForSkill("python", "c3"))[1]!.sessionId).toBe("s1");

    for (const [i, score] of [0.9, 0.5, 0.4].entries()) {
      await store.appendReadinessSnapshot({
        skillId: "python",
        score,
        confidence: 0.5,
        evidenceIds: ["e1"],
        reason: `r${i}`,
        computedAt: `2026-01-0${i + 3}T00:00:00Z`,
      });
    }
    expect(await store.countReadinessSnapshots()).toBe(3);
    const hist = await store.readinessHistory("python");
    expect(hist.map((h) => h.score)).toEqual([0.4, 0.5, 0.9]); // newest first
    expect((await store.latestReadinessBySkill()).get("python")!.score).toBe(0.4);

    store.close();
  });

  it("tracks action status transitions without deleting rows", async () => {
    const store = openStore(":memory:");
    await store.insertAction({
      id: "a1",
      skillId: "sql",
      priority: 1,
      reason: "gap",
      action: "practice",
      successCriteria: ["x"],
      status: "open",
      createdAt: "2026-01-01T00:00:00Z",
      sourceEvidenceIds: [],
    });
    await store.updateActionStatus("a1", "superseded");
    expect(await store.listActions("open")).toHaveLength(0);
    expect((await store.actionsForSkill("sql"))[0]!.status).toBe("superseded");
    store.close();
  });
});
