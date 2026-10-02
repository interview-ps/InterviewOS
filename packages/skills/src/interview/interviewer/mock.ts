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
        CONCEPT("situation and action", "behavioral.conflict", ["disagree", "conflict", "decided"]),
        CONCEPT("outcome", "behavioral", ["result", "outcome", "learned"]),
      ],
      difficulty: "easy",
    },
  ],
};

const GENERIC_TOPICS = ["applied in practice", "trade-offs", "debugging a failure"];

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
    GENERIC_TOPICS.map((topic) => ({
      text: `Walk me through how you have applied ${label} — ${topic} — what trade-offs did you make?`,
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
