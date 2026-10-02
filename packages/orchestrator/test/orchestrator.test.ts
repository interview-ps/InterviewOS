import { describe, expect, it } from "vitest";
import { MockRuntime } from "@interview-os/runtime";
import { createLogger } from "@interview-os/shared";
import { registerMockHandlers } from "@interview-os/skills";
import { InterviewOrchestrator, openStore } from "../src/index.js";

const logger = createLogger({ level: "error", sink: () => {} });

const RESUME = `# Jane Doe
Backend engineer.

## Experience
- Engineer — Acme — Python REST APIs, Python services, Python tooling, SQL
`;

const JD = `# Backend Engineer
## Requirements
- Python services
- SQL databases
- Caching: caches, cache hit rates, caching layers
## Nice to have
- Kubernetes
`;

const SETUP = {
  resumeText: RESUME,
  jobDescription: JD,
  company: "Acme",
  role: "Backend Engineer",
  level: "senior" as const,
};

function makeOrchestrator() {
  const runtime = new MockRuntime();
  registerMockHandlers(runtime);
  const store = openStore(":memory:");
  const orch = new InterviewOrchestrator({ store, runtime, logger });
  return { orch, store, runtime };
}

describe("InterviewOrchestrator", () => {
  it("recovers when evaluation fails: session returns to question, answer marked failed", async () => {
    const { orch, store, runtime } = makeOrchestrator();
    let calls = 0;
    runtime.register("answer-evaluator", () => {
      calls += 1;
      if (calls === 1) throw new Error("evaluator exploded");
      // delegate to the deterministic mock output on retry
      return {
        summary: "ok",
        dimensions: {
          correctness: { score: 0.8, rationale: "ok" },
          technicalDepth: { score: 0.8, rationale: "ok" },
          reasoning: { score: 0.8, rationale: "ok" },
          structure: { score: 0.8, rationale: "ok" },
          communication: { score: 0.8, rationale: "ok" },
          evidence: { score: 0.8, rationale: "ok" },
          roleRelevance: { score: 0.8, rationale: "ok" },
        },
        strengths: [],
        weaknesses: [],
        scores: [{ skill: "distributed-systems.caching", score: 0.8, confidence: 0.7 }],
        missingConcepts: [],
        betterApproach: "",
        followUpTopics: [],
      };
    });

    await orch.setupWorkspace(SETUP);
    const { session } = await orch.startInterview({ plannedQuestions: 2 });
    if (!session) throw new Error("no session");

    await expect(
      orch.submitAnswer(session.id, "Some answer text."),
    ).rejects.toThrow();

    expect(store.getSession(session.id)!.status).toBe("question");
    const answers = store.listAnswers(session.id);
    expect(answers).toHaveLength(1);
    expect(answers[0]!.status).toBe("failed");

    // resubmission works against the same question
    const result = await orch.submitAnswer(session.id, "A better answer.");
    expect(result.evaluation.scores.length).toBeGreaterThan(0);
    expect(store.getSession(session.id)!.status).toBe("follow_up");
  });

  it("interview-evidenced actions outrank generic gap actions after renumbering", async () => {
    const { orch, store } = makeOrchestrator();
    await orch.setupWorkspace(SETUP);
    const { session } = await orch.startInterview({ plannedQuestions: 1 });
    if (!session) throw new Error("no session");
    await orch.submitAnswer(
      session.id,
      "I would put Redis in front of the database using cache-aside so reads are fast.",
    );

    const open = store
      .listActions()
      .filter((a) => a.status === "open" || a.status === "in_progress")
      .sort((a, b) => a.priority - b.priority);
    expect(open.length).toBeGreaterThan(1);
    expect(open[0]!.priority).toBe(1);
    expect(open[0]!.skillId).toBe("distributed-systems.caching.cache-invalidation");
    expect(open.map((a) => a.priority)).toEqual(open.map((_, i) => i + 1));
  });
});
