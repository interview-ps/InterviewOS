import {
  CONCEPT,
  coverageOf,
  keywordsHit,
  round2,
  type ConceptTemplate,
  type ExpectedConcept,
} from "../mock-shared.js";

const DESIGN_PROBLEMS = [
  "Design a URL shortener service.",
  "Design a notification fan-out service (push/email/SMS) for a social app.",
  "Design a rate-limited public API gateway.",
];

/** Which skills each design problem exercises — picks turn-1's problem. */
const PROBLEM_SKILLS: string[][] = [
  ["apis", "sql", "system-design.data-modeling", "system-design"],
  [
    "distributed-systems.message-queues",
    "system-design.async-processing",
    "system-design.reliability",
    "distributed-systems",
  ],
  [
    "apis",
    "distributed-systems.caching",
    "system-design.scalability",
    "distributed-systems.caching.cache-invalidation",
  ],
];

/** Shared-prefix overlap between a skill id and a problem's related skill. */
const overlap = (skillId: string, related: string): number => {
  const a = skillId.split(".");
  const b = related.split(".");
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
};

const DIMENSION_PROBES: Record<string, string> = {
  requirements: "Let's pin down requirements: what are the core functional and non-functional requirements?",
  constraints: "What constraints shape this design — latency targets, consistency needs, budget?",
  scaleAssumptions: "Estimate the scale: expected QPS, storage growth, and bandwidth.",
  architecture: "Sketch the high-level architecture: the main components and how data flows between them.",
  dataModel: "What does the data model look like? Key entities and relationships.",
  apis: "Define the API surface: which endpoints, and their request/response shape.",
  storage: "What storage would you choose for each kind of data, and why?",
  caching: "Where would you cache, what would you cache, and how do you invalidate?",
  reliability: "How does the design handle failures — replication, retries, monitoring?",
  scalability: "How does the system scale as traffic grows 10× or 100×?",
  tradeOffs: "What are the main trade-offs you made, and what alternatives did you reject?",
};

const DESIGN_TEMPLATES: ConceptTemplate[] = DESIGN_PROBLEMS.map((problem) => ({
  text: `${problem} Start by clarifying requirements and scale estimates.`,
  topic: problem.replace(/^Design a |^Design an /, "").replace(/\.$/, ""),
  subSkills: ["system-design"],
  expectedConcepts: [
    CONCEPT("requirements", "system-design.requirements", ["requirement", "clarif"]),
    CONCEPT("scale estimate", "system-design.scale-estimation", ["qps", "users", "storage", "estimate", "requests"]),
  ],
  difficulty: "hard",
}));

export function systemDesignInterviewerMock(input: unknown): unknown {
  const { skillId, label, previousQuestions, modeState, followUp } = input as {
    skillId: string;
    label: string;
    previousQuestions: string[];
    modeState?: {
      problem?: string | null;
      dimensions?: Record<string, { status: string }>;
    };
    followUp?: { parentQuestion: string; focus: string } | null;
  };

  const status = (dim: string) => modeState?.dimensions?.[dim]?.status;

  if (followUp) {
    const focus = followUp.focus.toLowerCase();
    const dim = Object.keys(DIMENSION_PROBES).find((d) => focus.includes(d.toLowerCase()));
    const question = dim
      ? `Let's go deeper on ${dim}: ${DIMENSION_PROBES[dim]}`
      : `Let's go deeper on ${followUp.focus}: walk me through the specifics and the trade-offs.`;
    return {
      question,
      topic: `Follow-up: ${followUp.focus}`,
      skillId,
      subSkills: [],
      expectedConcepts: [CONCEPT(followUp.focus, skillId, followUp.focus.split(" "))],
      difficulty: "medium",
      problem: null,
      focusDimension: dim ?? null,
    };
  }

  if (!modeState?.problem) {
    // turn 1 is always a design problem — pick the one with the best
    // skill overlap (ties → earliest problem)
    let best = 0;
    let bestScore = -1;
    DESIGN_TEMPLATES.forEach((t, i) => {
      if (previousQuestions.includes(t.text)) return;
      const score = Math.max(...PROBLEM_SKILLS[i]!.map((s) => overlap(skillId, s)));
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    });
    const picked = DESIGN_TEMPLATES[best]!;
    return {
      question: picked.text,
      topic: picked.topic,
      skillId,
      subSkills: picked.subSkills,
      expectedConcepts: picked.expectedConcepts,
      difficulty: picked.difficulty,
      problem: DESIGN_PROBLEMS[best]!,
      focusDimension: null,
    };
  }

  // later turns: probe the first uncovered dimension
  const uncovered = Object.keys(DIMENSION_PROBES).find(
    (d) => status(d) !== "covered" && !previousQuestions.includes(DIMENSION_PROBES[d]!),
  );
  const dim = uncovered ?? "tradeOffs";
  return {
    question: DIMENSION_PROBES[dim]!,
    topic: `Probe: ${dim}`,
    skillId,
    subSkills: ["system-design"],
    expectedConcepts: [CONCEPT(dim, "system-design", dim.split(/(?=[A-Z])/).map((s) => s.toLowerCase()))],
    difficulty: "medium",
    problem: null,
    focusDimension: dim,
  };
}

const DIM_KEYWORDS: Record<string, string[]> = {
  requirements: ["requirement", "clarif", "scope", "functional"],
  constraints: ["constraint", "latency", "budget", "consistency"],
  scaleAssumptions: ["qps", "users", "requests", "storage", "bandwidth", "estimate", "per second", "million"],
  architecture: ["component", "service", "load balanc", "gateway", "architecture", "client", "worker"],
  dataModel: ["table", "schema", "entity", "record", "column", "data model", "index"],
  apis: ["endpoint", "api", "rest", "post ", "get ", "/shorten", "request"],
  storage: ["database", "sql", "nosql", "postgres", "dynamodb", "s3", "blob", "key-value"],
  caching: ["cache", "redis", "cdn", "invalidat", "memoiz"],
  reliability: ["failover", "replica", "redundan", "availability", "retry", "monitoring", "alert"],
  scalability: ["scale", "shard", "partition", "horizontal", "load balanc"],
  tradeOffs: ["trade-off", "tradeoff", "alternative", "versus", "chose", "instead"],
};

const SD_LABELS: Record<string, string> = {
  requirements: "Requirements",
  constraints: "Constraints",
  scaleAssumptions: "Scale assumptions",
  architecture: "Architecture",
  dataModel: "Data model",
  apis: "APIs",
  storage: "Storage",
  caching: "Caching",
  reliability: "Reliability",
  scalability: "Scalability",
  tradeOffs: "Trade-offs",
};

export function systemDesignEvaluatorMock(input: unknown): unknown {
  const { question, answer, modeState } = input as {
    question: { text: string; skillId: string; expectedConcepts?: ExpectedConcept[] };
    answer: string;
    modeState?: { dimensions?: Record<string, { status: string }> };
  };
  const concepts = question.expectedConcepts ?? [];
  const { ratio } = coverageOf(concepts, answer);
  const words = answer.trim().split(/\s+/).filter(Boolean).length;
  const statusOf = (dim: string) => modeState?.dimensions?.[dim]?.status;
  const rank = { not_covered: 0, partial: 1, covered: 2 } as Record<string, number>;

  const rubric = Object.keys(DIM_KEYWORDS).map((dim) => {
    const hits = keywordsHit(answer, DIM_KEYWORDS[dim]!);
    const score = round2(Math.min(1, hits === 0 ? 0.15 : 0.35 + 0.2 * hits));
    return {
      id: dim,
      label: SD_LABELS[dim]!,
      score,
      rationale:
        hits === 0 ? "Not discussed this turn." : `${hits} relevant term(s) detected.`,
    };
  });

  const designUpdates = rubric
    .filter((r) => {
      const proposed = r.score >= 0.75 ? "covered" : r.score >= 0.4 ? "partial" : "not_covered";
      return (rank[proposed] ?? 0) > (rank[statusOf(r.id) ?? "not_covered"] ?? 0);
    })
    .map((r) => ({
      dimension: r.id,
      status: (r.score >= 0.75 ? "covered" : "partial") as "covered" | "partial",
      notes: r.rationale,
    }));

  const score = (v: number) => round2(Math.min(1, Math.max(0, v)));
  return {
    summary: `Design turn evaluated; ${designUpdates.length} dimension(s) updated.`,
    dimensions: {
      correctness: { score: score(0.3 + 0.5 * ratio), rationale: "deterministic mock evaluation" },
      technicalDepth: { score: score(0.2 + 0.7 * ratio), rationale: "deterministic mock evaluation" },
      reasoning: { score: score(0.25 + 0.5 * ratio), rationale: "deterministic mock evaluation" },
      structure: { score: score(Math.min(0.9, 0.3 + words / 250)), rationale: "deterministic mock evaluation" },
      communication: { score: score(Math.min(0.9, 0.3 + words / 120)), rationale: "deterministic mock evaluation" },
      evidence: { score: score(0.2 + 0.6 * ratio), rationale: "deterministic mock evaluation" },
      roleRelevance: { score: score(0.4 + 0.4 * ratio), rationale: "deterministic mock evaluation" },
    },
    strengths: [],
    weaknesses: rubric
      .filter((r) => r.score < 0.3)
      .slice(0, 3)
      .map((r) => ({
        skill: "system-design",
        severity: "medium" as const,
        evidence: `${r.label} not addressed`,
      })),
    scores: [
      { skill: question.skillId, score: score(0.15 + 0.8 * ratio), confidence: 0.7 },
      ...rubric
        .filter((r) => r.score >= 0.4)
        .slice(0, 4)
        .map((r) => ({ skill: "system-design", score: r.score, confidence: 0.7 })),
    ],
    missingConcepts: rubric.filter((r) => r.score < 0.3).map((r) => r.label),
    star: null,
    rubric,
    designUpdates: designUpdates.length > 0 ? designUpdates : null,
    betterApproach: "Cover more design dimensions with concrete numbers.",
    followUpTopics: rubric.filter((r) => r.score < 0.4).map((r) => r.id),
  };
}
