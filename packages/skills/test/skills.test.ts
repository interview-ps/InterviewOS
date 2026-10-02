import { describe, expect, it } from "vitest";
import { MockRuntime } from "@interview-os/runtime";
import { createLogger } from "@interview-os/shared";
import {
  answerEvaluator,
  gapAnalyzer,
  interviewDebrief,
  interviewer,
  interviewPlanner,
  jdAnalyzer,
  prepPlanner,
  registerMockHandlers,
  resumeAnalyzer,
  runStructured,
  SkillOutputError,
  SkillRuntimeError,
  taxonomyEntries,
  type SkillContext,
} from "../src/index.js";
import { z } from "zod";

const logger = createLogger({ level: "error", sink: () => {} });

function makeCtx(runtime = new MockRuntime()): { ctx: SkillContext; runtime: MockRuntime } {
  if (runtime) registerMockHandlers(runtime);
  return { ctx: { runtime, logger, now: () => new Date("2026-02-01T00:00:00Z") }, runtime };
}

const RESUME = `# Jane Doe
Senior engineer building REST APIs and Python services.

## Experience
- Senior Engineer — Acme — built Python REST APIs and more Python tooling with SQL
`;

const JD = `# Backend Engineer
## Requirements
- Python services and REST APIs
- SQL and relational modeling
- Caching: caching layers, caches, cache hit rates
## Nice to have
- Kubernetes
`;

describe("resume-analyzer", () => {
  it("extracts skills via taxonomy keyword matching", async () => {
    const { ctx } = makeCtx();
    const out = await resumeAnalyzer.execute(
      { resumeText: RESUME, taxonomy: taxonomyEntries() },
      ctx,
    );
    const ids = out.skills.map((s) => s.skillId);
    expect(ids).toContain("python");
    expect(ids).toContain("apis");
    expect(ids).toContain("apis.rest");
    expect(out.skills.every((s) => s.source === "resume" && s.evidence.length > 0)).toBe(true);
    expect(out.experience.length).toBeGreaterThan(0);
    expect(out.name).toBe("Jane Doe");
  });
});

describe("jd-analyzer", () => {
  it("splits requirements vs preferred at the nice-to-have heading", async () => {
    const { ctx } = makeCtx();
    const out = await jdAnalyzer.execute(
      { jobDescription: JD, company: "Acme", role: "BE", level: "senior", taxonomy: taxonomyEntries() },
      ctx,
    );
    const reqIds = out.requirements.map((r) => r.skillId);
    expect(reqIds).toContain("python");
    expect(reqIds).toContain("distributed-systems.caching");
    const caching = out.requirements.find((r) => r.skillId === "distributed-systems.caching")!;
    expect(caching.importance).toBeGreaterThan(0.75);
    const prefIds = out.preferredSkills.map((r) => r.skillId);
    expect(prefIds).toContain("infrastructure.kubernetes");
    expect(reqIds).not.toContain("infrastructure.kubernetes");
    expect(out.preferredSkills.every((r) => r.kind === "preferred" && r.importance === 0.5)).toBe(true);
  });
});

describe("prep-planner", () => {
  it("produces the canonical cache-invalidation action", async () => {
    const { ctx } = makeCtx();
    const out = await prepPlanner.execute(
      {
        targets: [
          {
            skillId: "distributed-systems.caching.cache-invalidation",
            label: "Cache Invalidation",
            reason: "gap",
            missingConcepts: ["TTL"],
            severity: "high",
          },
        ],
        role: "BE",
        level: "senior",
      },
      ctx,
    );
    expect(out.actions).toHaveLength(1);
    const a = out.actions[0]!;
    expect(a.action).toContain("invalidation");
    expect(a.successCriteria.length).toBeGreaterThanOrEqual(2);
    expect(a.successCriteria.join(" ")).toContain("TTL");
  });

  it("falls back to a generic action for untemplated skills", async () => {
    const { ctx } = makeCtx();
    const out = await prepPlanner.execute(
      {
        targets: [{ skillId: "ml.onnx", label: "ONNX", reason: "x", missingConcepts: ["graphs"], severity: "medium" }],
        role: "BE",
        level: "senior",
      },
      ctx,
    );
    expect(out.actions[0]!.action).toContain("ONNX");
    expect(out.actions[0]!.successCriteria.length).toBeGreaterThanOrEqual(2);
  });
});

describe("interviewer", () => {
  const input = {
    skillId: "distributed-systems.caching",
    label: "Caching",
    role: "Backend Engineer",
    level: "senior" as const,
    company: "Acme",
    reason: "gap",
    previousQuestions: [] as string[],
    candidateSummary: "x",
  };

  it("asks the canonical caching question first", async () => {
    const { ctx } = makeCtx();
    const out = await interviewer.execute(input, ctx);
    expect(out.question).toContain("cache entries consistent");
    expect(out.skillId).toBe("distributed-systems.caching");
    expect(out.expectedConcepts.length).toBe(5);
    expect(
      out.expectedConcepts.some((c) => c.skillId === "distributed-systems.caching.cache-invalidation"),
    ).toBe(true);
  });

  it("never repeats a previous question text", async () => {
    const { ctx } = makeCtx();
    const first = await interviewer.execute(input, ctx);
    const second = await interviewer.execute(
      { ...input, previousQuestions: [first.question] },
      ctx,
    );
    expect(second.question).not.toBe(first.question);
    const third = await interviewer.execute(
      { ...input, previousQuestions: [first.question, second.question] },
      ctx,
    );
    expect(third.question).not.toBe(first.question);
    expect(third.question).not.toBe(second.question);
  });

  it("has a cache-invalidation retest template", async () => {
    const { ctx } = makeCtx();
    const out = await interviewer.execute(
      { ...input, skillId: "distributed-systems.caching.cache-invalidation", label: "Cache Invalidation" },
      ctx,
    );
    expect(out.question.toLowerCase()).toContain("invalidation");
  });
});

describe("answer-evaluator", () => {
  const cachingQuestion = {
    text: "How would you keep cache entries consistent with the database when the underlying data changes?",
    topic: "Cache consistency",
    skillId: "distributed-systems.caching",
    difficulty: "medium" as const,
    expectedConcepts: [
      { concept: "cache-aside", skillId: "distributed-systems.caching.cache-strategies", keywords: ["cache-aside", "read-through"] },
      { concept: "TTL", skillId: "distributed-systems.caching.cache-invalidation", keywords: ["ttl", "expir"] },
      { concept: "explicit invalidation", skillId: "distributed-systems.caching.cache-invalidation", keywords: ["invalidat", "evict"] },
      { concept: "write-through", skillId: "distributed-systems.caching.cache-invalidation", keywords: ["write-through", "write-behind"] },
      { concept: "stale reads", skillId: "distributed-systems.consistency", keywords: ["stale", "race"] },
    ],
  };

  it("flags uncovered invalidation concepts as weaknesses", async () => {
    const { ctx } = makeCtx();
    const out = await answerEvaluator.execute(
      {
        question: cachingQuestion,
        answer: "I would put Redis in front of the database using cache-aside so reads are fast.",
        role: "BE",
        level: "senior",
      },
      ctx,
    );
    const inv = out.scores.find((s) => s.skill === "distributed-systems.caching.cache-invalidation")!;
    expect(inv.score).toBeCloseTo(0.15, 2);
    const w = out.weaknesses.find((w) => w.skill === "distributed-systems.caching.cache-invalidation")!;
    expect(w.severity).toBe("high");
    expect(out.missingConcepts).toContain("TTL");
  });

  it("scores a strong answer highly", async () => {
    const { ctx } = makeCtx();
    const strong = `I would use cache-aside with a short TTL as the baseline, plus explicit invalidation on every write path — the service deletes the key after the DB commit, so we evict stale entries immediately. Write-through is an option if we need read-your-writes, trading write latency; write-behind batches but risks loss. TTL expiry covers races between writers; without invalidation you can serve stale data until expiry.`;
    const out = await answerEvaluator.execute(
      { question: cachingQuestion, answer: strong, role: "BE", level: "senior" },
      ctx,
    );
    const inv = out.scores.find((s) => s.skill === "distributed-systems.caching.cache-invalidation")!;
    expect(inv.score).toBeGreaterThanOrEqual(0.9);
    expect(out.weaknesses).toHaveLength(0);
  });
});

describe("interview-debrief", () => {
  it("aggregates strengths and weaknesses", async () => {
    const { ctx } = makeCtx();
    const out = await interviewDebrief.execute(
      {
        role: "BE",
        questions: [{ text: "q1", skillId: "sql", topic: "sql" }],
        evaluations: [
          {
            strengths: [{ skill: "sql", evidence: "explained indexing" }],
            weaknesses: [{ skill: "sql.indexing", severity: "medium", evidence: "vague" }],
          },
        ],
        readinessBefore: {},
        readinessAfter: {},
        openActions: [{ skillId: "sql", action: "Practice indexing" }],
      },
      ctx,
    );
    expect(out.wentWell.join(" ")).toContain("sql");
    expect(out.toImprove.join(" ")).toContain("sql.indexing");
    expect(out.nextActions).toContain("Practice indexing");
  });
});

describe("gap-analyzer + interview-planner (deterministic)", () => {
  it("run through the deterministic cores", async () => {
    const gaps = await gapAnalyzer.execute(
      {
        requirements: [
          { skillId: "sql", label: "SQL", importance: 1, kind: "required", evidence: "jd" },
        ],
        readiness: {},
        level: "senior",
      },
      makeCtx().ctx,
    );
    expect(gaps[0]!.severity).toBe("high");

    const pick = await interviewPlanner.execute(
      {
        requirements: [{ skillId: "sql", label: "SQL", importance: 1, kind: "required", evidence: "jd" }],
        readiness: {},
        evidence: [],
        askedThisSession: [],
        askedPreviousSession: [],
        questionIndex: 0,
      },
      makeCtx().ctx,
    );
    expect(pick!.skillId).toBe("sql");
  });
});

describe("runStructured retries", () => {
  const schema = z.object({ answer: z.number() });

  it("retries on invalid output then succeeds", async () => {
    const runtime = new MockRuntime();
    let calls = 0;
    runtime.register("flaky", () => (calls++ === 0 ? { answer: "nope" } : { answer: 42 }));
    const ctx: SkillContext = { runtime, logger, now: () => new Date() };
    const out = await runStructured(ctx, { taskId: "flaky", instructions: "x", input: {}, schema });
    expect(out.answer).toBe(42);
    expect(calls).toBe(2);
  });

  it("throws SkillOutputError after exhausting retries", async () => {
    const runtime = new MockRuntime();
    runtime.register("always-bad", () => ({ answer: "nope" }));
    const ctx: SkillContext = { runtime, logger, now: () => new Date() };
    await expect(
      runStructured(ctx, { taskId: "always-bad", instructions: "x", input: {}, schema }),
    ).rejects.toBeInstanceOf(SkillOutputError);
  });

  it("throws SkillRuntimeError immediately on non-retryable errors", async () => {
    const runtime = new MockRuntime();
    const ctx: SkillContext = { runtime, logger, now: () => new Date() };
    await expect(
      runStructured(ctx, { taskId: "unregistered", instructions: "x", input: {}, schema }),
    ).rejects.toBeInstanceOf(SkillRuntimeError);
  });
});
