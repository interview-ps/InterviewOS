import {
  CONCEPT,
  coverageOf,
  keywordsHit,
  pickQuestion,
  round2,
  type ConceptTemplate,
  type ExpectedConcept,
} from "../mock-shared.js";

interface CodingProblem {
  title: string;
  statement: string;
  constraints: string[];
  examples: { input: string; output: string; explanation?: string }[];
}

interface CodingTemplate extends ConceptTemplate {
  problem: CodingProblem;
}

const PROBLEMS: CodingTemplate[] = [
  {
    problem: {
      title: "Top-K recent items",
      statement:
        "Implement `recentK(items: number[], k: number)` returning the k most recently seen distinct values, newest first. Items arrive as an array in order.",
      constraints: ["1 ≤ k ≤ items.length", "items may contain duplicates", "aim for O(n) time"],
      examples: [
        {
          input: "items=[1,2,3,2,4], k=3",
          output: "[4,2,3]",
          explanation: "4 is newest; the earlier 2 keeps only its latest position.",
        },
      ],
    },
    text: "Solve this problem: first explain your approach, then write the code.",
    topic: "Top-K recent items",
    subSkills: ["coding.data-structures"],
    expectedConcepts: [
      CONCEPT("hash map / set for dedup", "coding.data-structures", ["hash", "map", "set"]),
      CONCEPT("O(n) time claim", "coding.complexity", ["o(n)", "linear", "time complexity"]),
      CONCEPT("edge cases (empty, k=0, dupes)", "coding.edge-cases", ["edge", "empty", "duplicate"]),
    ],
    difficulty: "medium",
  },
  {
    problem: {
      title: "Merge overlapping intervals",
      statement:
        "Implement `merge(intervals: [number,number][])` returning the sorted list of merged non-overlapping intervals.",
      constraints: ["intervals.length up to 10^4", "intervals may be unsorted", "endpoints inclusive"],
      examples: [
        {
          input: "[[1,3],[8,10],[2,6],[15,18]]",
          output: "[[1,6],[8,10],[15,18]]",
          explanation: "[1,3] and [2,6] overlap → [1,6].",
        },
      ],
    },
    text: "Solve this problem: first explain your approach, then write the code.",
    topic: "Merge intervals",
    subSkills: ["coding.algorithms"],
    expectedConcepts: [
      CONCEPT("sort by start", "coding.algorithms", ["sort"]),
      CONCEPT("single pass merge", "coding.algorithms", ["merge", "overlap", "previous"]),
      CONCEPT("O(n log n) complexity", "coding.complexity", ["n log n", "o(n", "complexity"]),
    ],
    difficulty: "medium",
  },
  {
    problem: {
      title: "LRU cache",
      statement:
        "Implement an LRU cache with `get(key)` and `put(key, value)` in O(1) each, evicting the least-recently-used entry when at capacity.",
      constraints: ["capacity ≥ 1", "both operations O(1)", "eviction on put when full"],
      examples: [
        {
          input: "cap=2; put(1,1); put(2,2); get(1); put(3,3)",
          output: "key 2 evicted",
          explanation: "get(1) made 1 most-recent; 2 is least-recent and evicted.",
        },
      ],
    },
    text: "Design and implement this data structure — explain your approach first, then code it.",
    topic: "LRU cache",
    subSkills: ["coding.data-structures"],
    expectedConcepts: [
      CONCEPT("hash map + doubly-linked list", "coding.data-structures", ["linked", "map", "hash"]),
      CONCEPT("O(1) operations", "coding.complexity", ["o(1)", "constant"]),
      CONCEPT("move-to-front on access", "coding.data-structures", ["recent", "front", "move"]),
    ],
    difficulty: "hard",
  },
  {
    problem: {
      title: "Sliding-window rate limiter",
      statement:
        "Implement `allow(userId, ts)` that permits at most N requests per user within a trailing T-second window.",
      constraints: ["timestamps are monotonically increasing", "memory per user should stay bounded"],
      examples: [
        {
          input: "N=3, T=60; requests at t=0,10,20,30",
          output: "first three allowed, fourth rejected",
          explanation: "At t=30, three earlier requests fall inside the last 60s.",
        },
      ],
    },
    text: "Solve this problem: first explain your approach, then write the code.",
    topic: "Rate limiter",
    subSkills: ["coding.data-structures", "coding.algorithms"],
    expectedConcepts: [
      CONCEPT("deque/queue of timestamps", "coding.data-structures", ["queue", "deque", "timestamps"]),
      CONCEPT("evict outside window", "coding.algorithms", ["window", "evict", "pop", "remove"]),
      CONCEPT("per-request O(1) amortized", "coding.complexity", ["o(1)", "amortized", "o(n)"]),
    ],
    difficulty: "hard",
  },
];

export function codingInterviewerMock(input: unknown): unknown {
  const { skillId, label, previousQuestions, followUp } = input as {
    skillId: string;
    label: string;
    previousQuestions: string[];
    followUp?: { parentQuestion: string; focus: string } | null;
  };

  if (followUp) {
    return {
      question: `Let's go deeper on ${followUp.focus}: for the same problem, walk me through it — what are the exact considerations and how does your solution handle them?`,
      topic: `Follow-up: ${followUp.focus}`,
      skillId,
      subSkills: [],
      expectedConcepts: [
        CONCEPT(followUp.focus, skillId, followUp.focus.split(" ")),
      ],
      difficulty: "medium",
      problem: null,
      focusDimension: null,
    };
  }

  const picked = pickQuestion(
    Object.fromEntries([
      ["coding", PROBLEMS],
      ["coding.algorithms", PROBLEMS],
      ["coding.data-structures", PROBLEMS],
      ["coding.complexity", PROBLEMS],
      ["coding.edge-cases", PROBLEMS],
      ["coding.code-quality", PROBLEMS],
    ]),
    skillId,
    label,
    previousQuestions,
  );
  const problem =
    (picked as Partial<CodingTemplate>).problem ?? PROBLEMS[0]!.problem;
  return {
    question: `${problem.title}: ${picked.renderedText}`,
    topic: problem.title,
    skillId,
    subSkills: picked.subSkills,
    expectedConcepts: picked.expectedConcepts,
    difficulty: picked.difficulty,
    problem,
    focusDimension: null,
  };
}

const RUBRIC_LABELS: Record<string, string> = {
  problemUnderstanding: "Problem understanding",
  approach: "Approach",
  correctness: "Correctness",
  complexity: "Complexity",
  edgeCases: "Edge cases",
  codeQuality: "Code quality",
  communication: "Communication",
};

export function codingEvaluatorMock(input: unknown): unknown {
  const { question, answer, code, language } = input as {
    question: { text: string; skillId: string; expectedConcepts?: ExpectedConcept[] };
    answer: string;
    code?: string | null;
    language?: string | null;
  };
  const concepts = question.expectedConcepts ?? [];
  const { ratio } = coverageOf(concepts, answer);
  const text = `${answer}\n${code ?? ""}`;
  const words = answer.trim().split(/\s+/).filter(Boolean).length;
  const codeLen = (code ?? "").trim().length;

  const complexityHit = keywordsHit(text, [
    "o(",
    "big-o",
    "complexity",
    "linear",
    "quadratic",
    "constant time",
  ]);
  const edgeHit = keywordsHit(text, [
    "edge",
    "empty",
    "null",
    "duplicate",
    "boundary",
    "overflow",
    "negative",
  ]);

  const score = (v: number) => round2(Math.min(1, Math.max(0, v)));
  const rubric = [
    {
      id: "problemUnderstanding",
      score: score(0.4 + 0.3 * ratio + (answer.length > 60 ? 0.15 : 0)),
      rationale: "Derived from restating the goal and constraints.",
    },
    {
      id: "approach",
      score: score(0.3 + 0.4 * ratio + (/approach|plan|first|then|step/i.test(answer) ? 0.2 : 0)),
      rationale: "Whether an approach was articulated.",
    },
    {
      id: "correctness",
      score: score(0.3 + 0.5 * ratio + (codeLen > 40 ? 0.1 : 0)),
      rationale: "Plausibility of the described/written solution.",
    },
    {
      id: "complexity",
      score: score(complexityHit > 0 ? 0.5 + 0.15 * complexityHit : 0.2),
      rationale:
        complexityHit > 0 ? "Complexity terms found." : "No complexity analysis detected.",
    },
    {
      id: "edgeCases",
      score: score(edgeHit > 0 ? 0.5 + 0.15 * edgeHit : 0.2),
      rationale: edgeHit > 0 ? "Edge-case terms found." : "No edge cases detected.",
    },
    {
      id: "codeQuality",
      score: score(
        codeLen === 0 ? 0.3 : codeLen > 600 ? 0.55 : 0.45 + Math.min(0.3, codeLen / 400),
      ),
      rationale:
        codeLen === 0
          ? `No code submitted${language ? "" : " (language n/a)"}.`
          : `Code submitted (${language ?? "text"}, ${codeLen} chars).`,
    },
    {
      id: "communication",
      score: score(Math.min(0.9, 0.3 + words / 120)),
      rationale: "Explanation length/structure proxy.",
    },
  ].map((r) => ({ ...r, label: RUBRIC_LABELS[r.id]! }));

  // reuse the generic mock shape for the rest of the evaluation
  const coverage = coverageOf(concepts, answer);
  const confidence = round2(0.55 + 0.25 * Math.min(1, words / 80));
  const bySkill = new Map<string, { total: number; covered: number; names: string[]; missed: string[] }>();
  for (const c of concepts) {
    const s = bySkill.get(c.skillId) ?? { total: 0, covered: 0, names: [], missed: [] };
    s.total += 1;
    if (coverage.covered.includes(c)) {
      s.covered += 1;
      s.names.push(c.concept);
    } else s.missed.push(c.concept);
    bySkill.set(c.skillId, s);
  }
  bySkill.set(
    question.skillId,
    bySkill.get(question.skillId) ?? { total: 0, covered: 0, names: [], missed: [] },
  );
  const scores = [...bySkill.entries()].map(([skillId, s]) => ({
    skill: skillId,
    score:
      skillId === question.skillId
        ? round2(0.15 + 0.8 * ratio)
        : round2(0.15 + 0.8 * (s.total === 0 ? ratio : s.covered / s.total)),
    confidence,
  }));
  // rubric dims feed their mapped coding.* skills too
  const complexityScore = rubric.find((r) => r.id === "complexity")!.score;
  const edgeScore = rubric.find((r) => r.id === "edgeCases")!.score;
  scores.push(
    { skill: "coding.complexity", score: complexityScore, confidence },
    { skill: "coding.edge-cases", score: edgeScore, confidence },
  );

  const weaknesses = [...bySkill.entries()]
    .filter(([, s]) => s.total > 0 && s.covered / s.total < 0.5)
    .map(([skill, s]) => ({
      skill,
      severity: s.covered / s.total < 0.25 ? ("high" as const) : ("medium" as const),
      evidence: `Did not address: ${s.missed.join(", ")}`,
    }));
  if (complexityScore < 0.6) {
    weaknesses.push({
      skill: "coding.complexity",
      severity: "medium",
      evidence: "No clear time/space complexity analysis",
    });
  }
  if (edgeScore < 0.6) {
    weaknesses.push({
      skill: "coding.edge-cases",
      severity: "medium",
      evidence: "Edge cases not discussed",
    });
  }

  const missing = [
    ...coverage.missing.map((c) => c.concept),
    ...(complexityScore < 0.6 ? ["Complexity analysis"] : []),
    ...(edgeScore < 0.6 ? ["Edge cases"] : []),
  ];

  return {
    summary: `Covered ${coverage.covered.length} of ${concepts.length} expected concepts (${Math.round(ratio * 100)}%)${code ? `; submitted ${codeLen} chars of ${language ?? "code"}` : ""}.`,
    dimensions: {
      correctness: { score: rubric[2]!.score, rationale: "deterministic mock evaluation" },
      technicalDepth: { score: score(0.2 + 0.7 * ratio), rationale: "deterministic mock evaluation" },
      reasoning: { score: score(0.25 + 0.5 * ratio), rationale: "deterministic mock evaluation" },
      structure: { score: score(Math.min(0.9, 0.3 + words / 200)), rationale: "deterministic mock evaluation" },
      communication: { score: rubric[6]!.score, rationale: "deterministic mock evaluation" },
      evidence: { score: score(0.2 + 0.6 * ratio), rationale: "deterministic mock evaluation" },
      roleRelevance: { score: score(0.4 + 0.4 * ratio), rationale: "deterministic mock evaluation" },
    },
    strengths: [...bySkill.entries()]
      .filter(([, s]) => s.total > 0 && s.covered / s.total >= 0.75)
      .map(([skill, s]) => ({ skill, evidence: `Explained ${s.names.join(", ")}` })),
    weaknesses,
    scores,
    missingConcepts: missing,
    star: null,
    rubric,
    designUpdates: null,
    betterApproach:
      coverage.missing.length === 0
        ? "The answer covered the expected ground."
        : `A stronger answer would cover: ${coverage.missing.map((c) => c.concept).join(", ")}.`,
    followUpTopics: coverage.missing.map((c) => c.concept),
  };
}
