import { taxonomy, type SkillId } from "@interview-os/core";

interface QuestionTemplate {
  text: string;
  topic: string;
  subSkills: string[];
  expectedConcepts: Array<{ concept: string; skillId: string; keywords: string[] }>;
  difficulty: "easy" | "medium" | "hard";
}

const CONCEPT = (concept: string, skillId: string, keywords: string[]) => ({
  concept,
  skillId,
  keywords,
});

const TEMPLATES: Record<string, QuestionTemplate[]> = {
  "distributed-systems.caching": [
    {
      text: "How would you keep cache entries consistent with the database when the underlying data changes?",
      topic: "Cache consistency",
      subSkills: [
        "distributed-systems.caching.cache-strategies",
        "distributed-systems.caching.cache-invalidation",
      ],
      expectedConcepts: [
        CONCEPT(
          "cache-aside / read-through",
          "distributed-systems.caching.cache-strategies",
          ["cache-aside", "read-through", "lazy load"],
        ),
        CONCEPT(
          "TTL / expiration",
          "distributed-systems.caching.cache-invalidation",
          ["ttl", "expir"],
        ),
        CONCEPT(
          "explicit invalidation on write",
          "distributed-systems.caching.cache-invalidation",
          ["invalidat", "delete the key", "evict"],
        ),
        CONCEPT(
          "write-through / write-behind trade-offs",
          "distributed-systems.caching.cache-invalidation",
          ["write-through", "write-behind", "write-back"],
        ),
        CONCEPT(
          "stale reads / race conditions",
          "distributed-systems.consistency",
          ["stale", "race", "consisten"],
        ),
      ],
      difficulty: "medium",
    },
    {
      text: "A product page is read 10k times a second and rarely changes. Walk me through the caching layer you would put in front of it.",
      topic: "Caching design",
      subSkills: ["distributed-systems.caching.cache-strategies"],
      expectedConcepts: [
        CONCEPT("cache-aside vs read-through", "distributed-systems.caching.cache-strategies", [
          "cache-aside",
          "read-through",
        ]),
        CONCEPT("TTL choice", "distributed-systems.caching.cache-invalidation", ["ttl", "expir"]),
        CONCEPT("stampede / hot key protection", "distributed-systems.caching", [
          "stampede",
          "thundering herd",
          "hot key",
        ]),
      ],
      difficulty: "medium",
    },
    {
      text: "How do you size and shard a Redis cluster when the working set outgrows one machine?",
      topic: "Cache scaling",
      subSkills: ["distributed-systems.partitioning"],
      expectedConcepts: [
        CONCEPT("sharding / partitioning", "distributed-systems.partitioning", [
          "shard",
          "partition",
          "consistent hashing",
        ]),
        CONCEPT("eviction policy", "distributed-systems.caching", ["evict", "lru", "lfu"]),
        CONCEPT("replication for reads", "distributed-systems.replication", [
          "replica",
          "replication",
        ]),
      ],
      difficulty: "hard",
    },
  ],
  "distributed-systems.caching.cache-invalidation": [
    {
      text: "Compare TTL-based expiry with explicit invalidation for a product-catalog cache — when would you choose each, and what can go wrong?",
      topic: "Cache invalidation strategies",
      subSkills: ["distributed-systems.caching.cache-strategies"],
      expectedConcepts: [
        CONCEPT("TTL expiry semantics", "distributed-systems.caching.cache-invalidation", [
          "ttl",
          "expir",
        ]),
        CONCEPT("explicit invalidation", "distributed-systems.caching.cache-invalidation", [
          "invalidat",
          "delete the key",
          "evict",
        ]),
        CONCEPT("write-through / write-behind", "distributed-systems.caching.cache-invalidation", [
          "write-through",
          "write-behind",
          "write-back",
        ]),
        CONCEPT("stale-read window", "distributed-systems.consistency", [
          "stale",
          "consisten",
        ]),
      ],
      difficulty: "medium",
    },
    {
      text: "Your cache shows stale prices after a database update. Walk me through how you debug and fix the invalidation path.",
      topic: "Stale-cache debugging",
      subSkills: ["distributed-systems.caching.cache-strategies"],
      expectedConcepts: [
        CONCEPT("write-path invalidation", "distributed-systems.caching.cache-invalidation", [
          "invalidat",
          "evict",
          "delete the key",
        ]),
        CONCEPT("event/version-based expiry", "distributed-systems.caching.cache-invalidation", [
          "version",
          "event",
          "ttl",
        ]),
      ],
      difficulty: "hard",
    },
  ],
  "distributed-systems.caching.cache-strategies": [
    {
      text: "Explain the difference between cache-aside, read-through and write-through caching. Which would you pick for a low-latency read path and why?",
      topic: "Cache strategies",
      subSkills: [],
      expectedConcepts: [
        CONCEPT("cache-aside", "distributed-systems.caching.cache-strategies", ["cache-aside"]),
        CONCEPT("read-through", "distributed-systems.caching.cache-strategies", ["read-through"]),
        CONCEPT("write-through / write-behind", "distributed-systems.caching.cache-invalidation", [
          "write-through",
          "write-behind",
        ]),
      ],
      difficulty: "medium",
    },
  ],
  "distributed-systems.message-queues": [
    {
      text: "You need to send order confirmations reliably. Design the producer/queue/consumer flow and tell me how you handle failures.",
      topic: "Message queues",
      subSkills: [],
      expectedConcepts: [
        CONCEPT("at-least-once vs exactly-once", "distributed-systems.message-queues", [
          "at-least-once",
          "exactly-once",
          "idempoten",
        ]),
        CONCEPT("dead-letter / poison messages", "distributed-systems.message-queues", [
          "dead-letter",
          "poison",
          "dlq",
        ]),
        CONCEPT("backpressure", "distributed-systems.message-queues", ["backpressure", "lag"]),
      ],
      difficulty: "medium",
    },
  ],
  "distributed-systems": [
    {
      text: "What breaks first when you split a monolith into services? Give me a concrete example.",
      topic: "Distributed systems fundamentals",
      subSkills: [],
      expectedConcepts: [
        CONCEPT("partial failure", "distributed-systems", ["partial failure", "timeout", "retry"]),
        CONCEPT("consistency trade-offs", "distributed-systems.consistency", [
          "consisten",
          "eventual",
        ]),
      ],
      difficulty: "medium",
    },
  ],
  "system-design": [
    {
      text: "Design a URL shortener. Start with the requirements you would clarify, then walk me through the high-level design.",
      topic: "System design: URL shortener",
      subSkills: ["system-design.requirements-analysis", "system-design.scalability"],
      expectedConcepts: [
        CONCEPT("requirements clarification", "system-design.requirements-analysis", [
          "requirement",
          "clarif",
          "scope",
        ]),
        CONCEPT("capacity estimation", "system-design.capacity-estimation", [
          "qps",
          "estimate",
          "storage",
        ]),
        CONCEPT("scaling the reads", "system-design.scalability", [
          "cache",
          "load balanc",
          "scale",
        ]),
      ],
      difficulty: "medium",
    },
    {
      text: "Design a rate limiter as a shared service for multiple internal APIs.",
      topic: "System design: rate limiter",
      subSkills: ["system-design.scalability"],
      expectedConcepts: [
        CONCEPT("token bucket / sliding window", "system-design", [
          "token bucket",
          "sliding window",
          "fixed window",
        ]),
        CONCEPT("distributed counter store", "distributed-systems", [
          "redis",
          "distributed",
        ]),
      ],
      difficulty: "hard",
    },
  ],
  "system-design.scalability": [
    {
      text: "Your API latency doubles every time traffic doubles. Where do you look first?",
      topic: "Scalability",
      subSkills: [],
      expectedConcepts: [
        CONCEPT("bottleneck analysis", "system-design.scalability", [
          "bottleneck",
          "profil",
          "metric",
        ]),
        CONCEPT("horizontal scaling", "system-design.scalability", [
          "horizontal",
          "scale out",
          "load balanc",
        ]),
      ],
      difficulty: "medium",
    },
  ],
  sql: [
    {
      text: "A reporting query that joins three tables went from 50ms to 8s. How do you approach it?",
      topic: "SQL query optimization",
      subSkills: ["sql.query-optimization", "sql.indexing"],
      expectedConcepts: [
        CONCEPT("query plan", "sql.query-optimization", ["explain", "query plan", "plan"]),
        CONCEPT("indexing", "sql.indexing", ["index"]),
        CONCEPT("row estimates / statistics", "sql.query-optimization", [
          "statistic",
          "estimate",
          "cardinality",
        ]),
      ],
      difficulty: "medium",
    },
  ],
  python: [
    {
      text: "Tell me about a Python performance problem you solved — what did you measure and what did you change?",
      topic: "Python in practice",
      subSkills: [],
      expectedConcepts: [
        CONCEPT("profiling/measurement", "python", ["profil", "measure", "benchmark"]),
        CONCEPT("concrete fix", "python", ["async", "cache", "vectoriz", "multiprocess"]),
      ],
      difficulty: "easy",
    },
  ],
  apis: [
    {
      text: "Design the REST endpoints for a small order-management API — walk me through resources, methods and status codes.",
      topic: "REST API design",
      subSkills: ["apis.rest"],
      expectedConcepts: [
        CONCEPT("resource modeling", "apis.rest", ["resource", "endpoint", "/orders"]),
        CONCEPT("idempotency", "apis.rest", ["idempoten"]),
        CONCEPT("status codes", "apis.rest", ["200", "201", "404", "status"]),
      ],
      difficulty: "easy",
    },
  ],
  behavioral: [
    {
      text: "Tell me about a time you disagreed with a teammate on a technical approach. What happened?",
      topic: "Conflict",
      subSkills: ["behavioral.conflict"],
      expectedConcepts: [
        CONCEPT("Situation context", "communication", ["when i", "at my", "our team", "we were"]),
        CONCEPT("Your specific actions", "communication", [
          "i led",
          "i decided",
          "i proposed",
          "i talked",
          "i wrote",
        ]),
        CONCEPT("Measurable result", "communication", [
          "result",
          "outcome",
          "%",
          "reduced",
          "improved",
          "shipped",
        ]),
      ],
      difficulty: "easy",
    },
  ],
  "behavioral.conflict": [
    {
      text: "Tell me about a specific time you disagreed with a teammate or your manager. Walk me through what you did and how it ended.",
      topic: "Conflict",
      subSkills: [],
      expectedConcepts: [
        CONCEPT("Situation context", "communication", ["when i", "at my", "our team", "we were"]),
        CONCEPT("The disagreement", "behavioral.conflict", ["disagree", "conflict", "pushback"]),
        CONCEPT("Your specific actions", "communication", [
          "i led",
          "i decided",
          "i proposed",
          "i talked",
        ]),
        CONCEPT("Measurable result", "communication", ["result", "outcome", "%", "resolved"]),
      ],
      difficulty: "easy",
    },
  ],
  "behavioral.ownership": [
    {
      text: "Tell me about a time you took ownership of a problem that wasn't strictly yours. What did you do?",
      topic: "Ownership",
      subSkills: [],
      expectedConcepts: [
        CONCEPT("Situation context", "communication", ["when i", "at my", "our team", "we were"]),
        CONCEPT("Your specific actions", "communication", [
          "i led",
          "i decided",
          "i built",
          "i organized",
          "i drove",
        ]),
        CONCEPT("Measurable result", "communication", [
          "result",
          "%",
          "reduced",
          "improved",
          "shipped",
        ]),
      ],
      difficulty: "easy",
    },
  ],
  "behavioral.failure-learning": [
    {
      text: "Tell me about a time something you were responsible for failed. What did you do and what did you learn?",
      topic: "Learning from failure",
      subSkills: [],
      expectedConcepts: [
        CONCEPT("Situation context", "communication", ["when i", "at my", "our team", "we were"]),
        CONCEPT("What went wrong", "behavioral.failure-learning", [
          "fail",
          "broke",
          "outage",
          "mistake",
        ]),
        CONCEPT("Your specific actions", "communication", [
          "i led",
          "i decided",
          "i implemented",
          "i wrote",
        ]),
        CONCEPT("What changed after", "behavioral.failure-learning", [
          "learned",
          "after that",
          "now we",
          "postmortem",
        ]),
      ],
      difficulty: "medium",
    },
  ],
  "behavioral.collaboration": [
    {
      text: "Describe a time you worked closely with another team or function to ship something. What was your role?",
      topic: "Collaboration",
      subSkills: [],
      expectedConcepts: [
        CONCEPT("Situation context", "communication", ["when i", "at my", "our team", "we were"]),
        CONCEPT("Who you worked with", "behavioral.collaboration", [
          "product",
          "design",
          "team",
          "stakeholder",
          "partner",
        ]),
        CONCEPT("Your specific actions", "communication", [
          "i led",
          "i organized",
          "i proposed",
          "i built",
        ]),
        CONCEPT("Measurable result", "communication", ["result", "%", "shipped", "launched"]),
      ],
      difficulty: "easy",
    },
  ],
  "behavioral.leadership": [
    {
      text: "Tell me about a time you led without formal authority — how did you get people on board?",
      topic: "Leadership",
      subSkills: [],
      expectedConcepts: [
        CONCEPT("Situation context", "communication", ["when i", "at my", "our team", "we were"]),
        CONCEPT("Your specific actions", "communication", [
          "i led",
          "i proposed",
          "i convinced",
          "i organized",
        ]),
        CONCEPT("Measurable result", "communication", [
          "result",
          "%",
          "adopted",
          "shipped",
          "decided",
        ]),
      ],
      difficulty: "medium",
    },
  ],
  hr: [
    {
      text: "What draws you to this role, and where do you want to grow next?",
      topic: "Motivation & growth",
      subSkills: ["hr.motivation", "hr.career-goals"],
      expectedConcepts: [
        CONCEPT("Genuine motivation", "hr.motivation", ["excited", "motivated", "interested", "drawn"]),
        CONCEPT("Career direction", "hr.career-goals", ["grow", "goal", "next", "learn"]),
        CONCEPT("Mutual fit", "hr.culture-fit", ["team", "culture", "value"]),
      ],
      difficulty: "easy",
    },
  ],
  "hr.motivation": [
    {
      text: "Why this role, and why our company specifically?",
      topic: "Motivation",
      subSkills: [],
      expectedConcepts: [
        CONCEPT("Specific interest in the role", "hr.motivation", [
          "role",
          "excited",
          "interested",
          "motivated",
        ]),
        CONCEPT("Knowledge of the company", "hr.motivation", [
          "your",
          "company",
          "product",
          "mission",
          "values",
        ]),
        CONCEPT("What you bring", "hr.motivation", ["experience", "skills", "i've", "i have"]),
      ],
      difficulty: "easy",
    },
  ],
  "hr.career-goals": [
    {
      text: "Where do you want your career to go over the next few years, and how does this role fit?",
      topic: "Career goals",
      subSkills: [],
      expectedConcepts: [
        CONCEPT("A direction, not a title", "hr.career-goals", [
          "grow",
          "learn",
          "lead",
          "deepen",
          "goal",
        ]),
        CONCEPT("Fit with this role", "hr.career-goals", ["this role", "here", "opportunity"]),
      ],
      difficulty: "easy",
    },
  ],
  "hr.culture-fit": [
    {
      text: "What kind of team culture brings out your best work, and what kind drains you?",
      topic: "Culture fit",
      subSkills: [],
      expectedConcepts: [
        CONCEPT("Concrete culture traits", "hr.culture-fit", [
          "culture",
          "feedback",
          "autonomy",
          "collaboration",
          "transparent",
        ]),
        CONCEPT("Self-awareness", "hr.culture-fit", ["i work best", "i need", "i prefer", "thrive"]),
      ],
      difficulty: "easy",
    },
  ],
  "hr.work-style": [
    {
      text: "How do you like to work day to day — how do you communicate, take feedback, and manage your time?",
      topic: "Work style",
      subSkills: [],
      expectedConcepts: [
        CONCEPT("Concrete work habits", "hr.work-style", [
          "i prefer",
          "i usually",
          "async",
          "standup",
          "feedback",
        ]),
        CONCEPT("Collaboration style", "hr.work-style", [
          "pair",
          "review",
          "communicate",
          "slack",
          "docs",
        ]),
      ],
      difficulty: "easy",
    },
  ],
};

const GENERIC_PROMPTS: ((label: string) => string)[] = [
  (l) =>
    `Walk me through a real project where you applied ${l}. What trade-offs did you make?`,
  (l) =>
    `Tell me about a time ${l} mattered in your work — what was hard about it?`,
  (l) =>
    `Looking back at your experience with ${l}, what would you do differently today?`,
];

export function interviewerMock(input: unknown): unknown {
  const { skillId, label, previousQuestions } = input as {
    skillId: string;
    label: string;
    previousQuestions: string[];
  };
  const asked = new Set(previousQuestions);
  const templates =
    TEMPLATES[skillId] ??
    TEMPLATES[taxonomy.parentOf(skillId as SkillId) ?? ""] ??
    GENERIC_PROMPTS.map((prompt) => ({
      text: prompt(label),
      topic: label,
      subSkills: [] as string[],
      expectedConcepts: (taxonomy.getNode(skillId as SkillId)?.keywords ?? [])
        .slice(0, 3)
        .map((k) => CONCEPT(k, skillId, [k.split(" ")[0]!])),
      difficulty: "medium" as const,
    }));

  const chosen = templates.find((t) => !asked.has(t.text));
  let text: string;
  let template = chosen ?? templates[0]!;
  if (chosen) {
    text = chosen.text;
  } else {
    let n = 2;
    while (asked.has(`${template.text} (variant ${n})`)) n++;
    text = `${template.text} (variant ${n})`;
  }
  return {
    question: text,
    topic: template.topic,
    skillId,
    subSkills: template.subSkills,
    expectedConcepts: template.expectedConcepts,
    difficulty: template.difficulty,
  };
}
