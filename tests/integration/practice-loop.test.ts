import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { InterviewOrchestrator, openStore } from "@interview-os/server/orchestrator";
import { MockRuntime } from "@interview-os/runtime";
import { createLogger } from "@interview-os/core";
import { registerMockHandlers } from "@interview-os/server/skills";

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

const CACHE_INV = "distributed-systems.caching.cache-invalidation";

function makeOrchestrator() {
  const logger = createLogger({ level: "error", sink: () => {} });
  const runtime = new MockRuntime();
  registerMockHandlers(runtime);
  const store = openStore(":memory:");
  const orch = new InterviewOrchestrator({ store, runtime, logger });
  return { orch, store };
}

describe("practice loop (§8.1)", () => {
  it("practice session on a weak skill verifies it and completes the action", async () => {
    const { orch, store } = makeOrchestrator();
    await orch.setupWorkspace(loadExample("backend-engineer"));

    // a poor interview answer makes cache invalidation weak and creates an action
    const start1 = await orch.startInterview({ plannedQuestions: 1 });
    const result = await orch.submitAnswer(
      start1.session.id,
      "I would put Redis in front of the database using cache-aside so reads are fast.",
    );
    const invAction = result.newActions.find((a) => a.skillId === CACHE_INV)!;
    expect(invAction).toBeDefined();

    const before = await orch.getSkillDetail(CACHE_INV);
    expect(before.readiness!.status).toBe("weak");
    const beforeScore = before.readiness!.score!;

    // practice session on the action's skill
    const practice = await orch.startInterview({
      mode: "practice",
      focusSkillId: invAction.skillId,
      actionId: invAction.id,
    });
    expect(practice.session.mode).toBe("practice");
    expect(practice.session.plannedQuestions).toBe(1);
    const pq = practice.question!;
    expect(pq.skillId).toBe(CACHE_INV);
    expect(pq.selectionReason).toBe("practice: verifying Cache Invalidation");

    // a strong answer covering the expected concepts
    const strong = await orch.submitAnswer(
      practice.session.id,
      "I would use a short TTL for expiry and add explicit invalidation on the write path — " +
        "delete the key on update. For latency-sensitive writes I would consider write-through " +
        "or write-behind; both keep the cache consistent and avoid stale reads.",
    );
    const focusScore = strong.evaluation.scores.find((s) => s.skill === CACHE_INV)!;
    expect(focusScore.score).toBeGreaterThanOrEqual(0.7);

    // practice evidence (not interview_answer) was created and raises readiness
    const practiceEvidence = store
      .listEvidence()
      .filter((e) => e.skillId === CACHE_INV && e.type === "practice");
    expect(practiceEvidence.length).toBe(1);
    expect(practiceEvidence[0]!.sessionId).toBe(practice.session.id);

    const after = await orch.getSkillDetail(CACHE_INV);
    expect(after.readiness!.score!).toBeGreaterThan(beforeScore);

    // the linked action is done
    expect(store.getAction(invAction.id)!.status).toBe("done");

    // self-check on another action records one self_report evidence
    const state = await orch.getState();
    const candidate = state.preparation.nextActions.find(
      (a) => a.successCriteria.length >= 4 && a.status !== "done",
    ) ?? state.preparation.nextActions.find((a) => a.status !== "done")!;
    expect(candidate).toBeDefined();
    const criteria = candidate.successCriteria;
    const checked = criteria.slice(0, Math.max(1, Math.min(3, criteria.length - 1)));

    const skillBefore = await orch.getSkillDetail(candidate.skillId);
    const done = await orch.completeAction(candidate.id, { checkedCriteria: checked });
    expect(done.ok).toBe(true);
    expect(done.evidenceId).not.toBeNull();

    const reports = store
      .listEvidence()
      .filter((e) => e.skillId === candidate.skillId && e.type === "self_report");
    expect(reports.length).toBe(1);
    expect(reports[0]!.score).toBeCloseTo(checked.length / criteria.length, 6);
    expect(reports[0]!.confidence).toBeCloseTo(0.5, 6);
    expect(reports[0]!.observation).toContain(
      `Self-check: met ${checked.length}/${criteria.length} criteria`,
    );
    expect(store.getAction(candidate.id)!.status).toBe("done");

    const skillAfter = await orch.getSkillDetail(candidate.skillId);
    expect(skillAfter.readiness!.score).not.toBeNull();
    // the self-report is part of the evidence set now
    expect(skillAfter.readiness!.evidenceIds).toContain(done.evidenceId);
    expect(skillAfter.readiness!.score).not.toBe(skillBefore.readiness?.score ?? null);

    // invalid criteria are rejected without side effects
    const third = (await orch.getState()).preparation.nextActions.find(
      (a) => a.status !== "done",
    );
    if (third) {
      await expect(
        orch.completeAction(third.id, { checkedCriteria: ["not a real criterion"] }),
      ).rejects.toThrow(/criteria/i);
      expect(store.getAction(third.id)!.status).not.toBe("done");
    }
  }, 60_000);
});
