import { describe, expect, it } from "vitest";
import { MockRuntime } from "@interview-os/runtime";
import { createLogger } from "@interview-os/shared";
import {
  answerEvaluator,
  companyProfiler,
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
  starCoach,
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

describe("answer-evaluator STAR (§8.4)", () => {
  const behavioralQuestion = {
    text: "Tell me about a time you took ownership of a problem.",
    topic: "Ownership",
    skillId: "behavioral.ownership",
    difficulty: "easy" as const,
    expectedConcepts: [],
  };

  it("detects STAR coverage and missing parts on behavioral answers", async () => {
    const { ctx } = makeCtx();
    const out = await answerEvaluator.execute(
      {
        question: behavioralQuestion,
        answer: "When I was at Acme our team had an outage and I led the fix.",
        role: "BE",
        level: "senior",
        roundType: "behavioral",
      },
      ctx,
    );
    expect(out.star).not.toBeNull();
    expect(out.star!.situation).toBe(true);
    expect(out.star!.action).toBe(true);
    expect(out.star!.task).toBe(false);
    expect(out.star!.result).toBe(false);
    const w = out.weaknesses.find((w) => w.skill === "communication")!;
    expect(w.severity).toBe("medium");
    expect(w.evidence).toContain("Answer lacked a clear");
    expect(out.missingConcepts).toContain("STAR Result");
    expect(out.missingConcepts).toContain("STAR Task");
  });

  it("marks all four parts on a complete STAR answer", async () => {
    const { ctx } = makeCtx();
    const out = await answerEvaluator.execute(
      {
        question: behavioralQuestion,
        answer:
          "When I was at Acme in 2024 our team was responsible for checkout. My task was to cut " +
          "errors; I led a retry redesign and shipped it, which reduced failures by 40%.",
        role: "BE",
        level: "senior",
        roundType: "behavioral",
      },
      ctx,
    );
    expect(out.star).toMatchObject({
      situation: true,
      task: true,
      action: true,
      result: true,
    });
    expect(out.weaknesses.every((w) => w.skill !== "communication")).toBe(true);
  });

  it("leaves star null for non-behavioral questions", async () => {
    const { ctx } = makeCtx();
    const out = await answerEvaluator.execute(
      {
        question: {
          text: "How does a B-tree index work?",
          topic: "Indexing",
          skillId: "sql.indexing",
          difficulty: "medium" as const,
          expectedConcepts: [],
        },
        answer: "It keeps keys sorted so range scans are fast.",
        role: "BE",
        level: "senior",
        roundType: "technical",
      },
      ctx,
    );
    expect(out.star).toBeNull();
  });
});

describe("star-coach (§8.4)", () => {
  it("generate produces resume-grounded stories with placeholders", async () => {
    const { ctx } = makeCtx();
    const out = await starCoach.execute(
      {
        mode: "generate",
        experience: [
          {
            title: "Senior Engineer",
            company: "Acme",
            highlights: ["led the incident response", "built the billing API"],
          },
        ],
        achievements: ["won the hackathon"],
        projects: [],
        behavioralSkillIds: ["behavioral.ownership"],
        existingTitles: [],
      },
      ctx,
    );
    expect("stories" in out).toBe(true);
    if (!("stories" in out)) return;
    expect(out.stories.length).toBeGreaterThan(0);
    expect(out.stories.length).toBeLessThanOrEqual(4);
    expect(out.stories[0]!.title).toContain("Acme");
    expect(out.stories[0]!.result).toContain("[add metric]");
  });

  it("generate dedupes against existing titles", async () => {
    const { ctx } = makeCtx();
    const existing = "Acme: led the incident response";
    const out = await starCoach.execute(
      {
        mode: "generate",
        experience: [
          {
            title: "Senior Engineer",
            company: "Acme",
            highlights: ["led the incident response"],
          },
        ],
        achievements: [],
        projects: [],
        behavioralSkillIds: [],
        existingTitles: [existing],
      },
      ctx,
    );
    if (!("stories" in out)) throw new Error("expected generate output");
    expect(out.stories.map((s) => s.title)).not.toContain(existing);
  });

  it("review flags placeholders and number-less results", async () => {
    const { ctx } = makeCtx();
    const out = await starCoach.execute(
      {
        mode: "review",
        story: {
          title: "Outage fix",
          situation: "",
          task: "[add task]",
          action: "I led the fix",
          result: "it got better",
        },
        role: "Backend Engineer",
        level: "senior",
      },
      ctx,
    );
    if (!("missing" in out)) throw new Error("expected review output");
    expect(out.missing.some((m) => /result/i.test(m))).toBe(true);
    expect(out.missing.some((m) => /situation/i.test(m))).toBe(true);
    expect(out.improvedDraft.result).toContain("[add metric");
    expect(out.feedback.length).toBeGreaterThan(0);
  });
});

describe("company-profiler (§8.4)", () => {
  it("extracts values, focus skills and behavioral themes", async () => {
    const { ctx } = makeCtx();
    const notes = `# Acme values
- We value ownership: engineers take problems end-to-end.
- Customer focus: every decision starts from the customer.
- We value engineers who reason about caching and reliability.
## Interview process
- A technical deep-dive loop with a behavioral round.`;
    const out = await companyProfiler.execute(
      { company: "Acme", companyNotes: notes, taxonomy: taxonomyEntries() },
      ctx,
    );
    expect(out.values.length).toBeGreaterThan(0);
    expect(out.values.join(" ")).toMatch(/ownership/i);
    expect(out.focusSkillIds).toContain("distributed-systems.caching");
    expect(out.behavioralThemes).toContain("ownership");
    expect(out.behavioralThemes).toContain("customer focus");
    expect(out.interviewStyle).toMatch(/interview|loop/i);
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

describe("W1 fixes (§9.1)", () => {
  const baseInput = {
    skillId: "distributed-systems.caching.cache-invalidation",
    label: "Cache Invalidation",
    role: "Backend Engineer",
    level: "senior" as const,
    company: "Acme",
    reason: "test",
    previousQuestions: [] as string[],
    candidateSummary: "cand",
    roundType: "system_design" as const,
    mode: "system_design" as const,
    modeState: {},
    companyGuidance: "",
    companyThemes: [] as string[],
    storyTitles: [] as string[],
    priorRoundObservations: [] as string[],
  };

  it("system_design turn 1 always presents a design problem even for a non-SD skill", async () => {
    const { ctx } = makeCtx();
    const out = await interviewer.execute(
      { ...baseInput, modeState: { problem: null } },
      ctx,
    );
    expect(out.problem).not.toBeNull();
    expect(String(out.problem)).toMatch(/^Design (a|an)/);
    expect(out.question).toContain("Design");
  });

  it("generic fallback questions are well-formed sentences", async () => {
    const { ctx } = makeCtx();
    const out = await interviewer.execute(
      {
        ...baseInput,
        skillId: "infrastructure.kubernetes",
        label: "Kubernetes",
        mode: "technical",
        roundType: "technical",
      },
      ctx,
    );
    expect(out.question).toMatch(/Kubernetes/);
    expect(out.question).not.toMatch(/applied in practice|— applied/);
    expect(/[.?]$/.test(out.question)).toBe(true);
  });

  it("evaluator output is normalized: one entry per skill", async () => {
    const runtime = new MockRuntime();
    runtime.register("answer-evaluator.technical", () => ({
      summary: "dup",
      dimensions: {
        correctness: { score: 0.5, rationale: "" },
        technicalDepth: { score: 0.5, rationale: "" },
        reasoning: { score: 0.5, rationale: "" },
        structure: { score: 0.5, rationale: "" },
        communication: { score: 0.5, rationale: "" },
        evidence: { score: 0.5, rationale: "" },
        roleRelevance: { score: 0.5, rationale: "" },
      },
      strengths: [],
      weaknesses: [
        { skill: "sql", severity: "low", evidence: "a" },
        { skill: "sql", severity: "high", evidence: "b" },
      ],
      scores: [
        { skill: "sql", score: 0.2, confidence: 0.4 },
        { skill: "sql", score: 0.6, confidence: 0.8 },
      ],
      missingConcepts: ["x", "x"],
      betterApproach: "",
      followUpTopics: [],
      star: null,
      rubric: [
        { id: "correctness", label: "Correctness", score: 0.5, rationale: "" },
        { id: "technicalDepth", label: "Technical depth", score: 0.5, rationale: "" },
        { id: "reasoning", label: "Reasoning", score: 0.5, rationale: "" },
        { id: "communication", label: "Communication", score: 0.5, rationale: "" },
        { id: "roleRelevance", label: "Role relevance", score: 0.5, rationale: "" },
      ],
      designUpdates: null,
    }));
    const ctx: SkillContext = { runtime, logger, now: () => new Date() };
    const out = await answerEvaluator.execute(
      {
        question: { text: "q", topic: "t", skillId: "sql", expectedConcepts: [], difficulty: "medium" },
        answer: "a",
        role: "BE",
        level: "senior",
        roundType: "technical",
        mode: "technical",
      },
      ctx,
    );
    expect(out.weaknesses.filter((w) => w.skill === "sql")).toHaveLength(1);
    expect(out.weaknesses[0]!.severity).toBe("high");
    expect(out.scores.filter((s) => s.skill === "sql")).toHaveLength(1);
    expect(out.missingConcepts).toEqual(["x"]);
  });
});

describe("loop-debrief (§9.4)", () => {
  it("signals each round and never renders a hire verdict", async () => {
    const { ctx } = makeCtx();
    const { loopDebrief } = await import("../src/evaluate/loop-debrief/index.js");
    const out = await loopDebrief.execute(
      {
        role: "BE",
        company: "Acme",
        rounds: [
          {
            mode: "coding",
            label: "Coding",
            summaries: ["missed edge cases"],
            rubricAverages: { complexity: 0.2, correctness: 0.3 },
            handoff: {
              weakSkills: [{ skillId: "coding.edge-cases", score: 0.2, observation: "missed" }],
              strongSkills: [],
              observations: ["missed edge cases"],
            },
          },
          {
            mode: "behavioral",
            label: "Behavioral",
            summaries: ["clear STAR story"],
            rubricAverages: { clarity: 0.85, relevance: 0.8 },
            handoff: {
              weakSkills: [],
              strongSkills: [{ skillId: "behavioral.ownership", score: 0.85 }],
              observations: ["clear STAR story"],
            },
          },
        ],
        readinessChange: { before: 0.4, after: 0.52 },
      },
      ctx,
    );
    expect(out.rounds).toHaveLength(2);
    expect(out.rounds[0]!.signal).toBe("weak");
    expect(out.rounds[1]!.signal).toBe("strong");
    expect(out.readinessChange).toEqual({ before: 0.4, after: 0.52 });
    expect(out.summary).not.toMatch(/no-hire|would hire|recommend hiring/i);
    expect(out.topActions.length).toBeGreaterThan(0);
  });
});
