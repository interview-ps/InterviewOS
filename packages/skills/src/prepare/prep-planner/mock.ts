import { taxonomy, type SkillId } from "@interview-os/core";

interface PrepTarget {
  skillId: string;
  label: string;
  reason: string;
  missingConcepts?: string[];
  severity: string;
}

const TEMPLATES: Record<string, { action: string; successCriteria: string[] }> = {
  "distributed-systems.caching.cache-invalidation": {
    action:
      "Practice explaining three cache invalidation strategies, then complete one mock question on them",
    successCriteria: [
      "Explain TTL-based expiration",
      "Explain explicit invalidation on writes",
      "Explain write-through/write-behind trade-offs",
      "Complete one mock question covering all three",
    ],
  },
  "distributed-systems.caching": {
    action:
      "Design the caching layer for a read-heavy product catalog on a whiteboard, then explain it aloud",
    successCriteria: [
      "Name the caching pattern you chose (cache-aside/read-through/write-through)",
      "Explain how entries expire or get invalidated",
      "Explain what happens on a cache stampede",
    ],
  },
  "distributed-systems.caching.cache-strategies": {
    action:
      "Compare cache-aside, read-through and write-through for a concrete service you know",
    successCriteria: [
      "Describe each strategy in one sentence",
      "Give one failure mode for each",
      "Complete one mock question",
    ],
  },
  "distributed-systems.message-queues": {
    action: "Sketch a producer/consumer design with a queue and explain delivery semantics",
    successCriteria: [
      "Explain at-least-once vs exactly-once",
      "Explain how you handle poison messages",
      "Complete one mock question",
    ],
  },
  "distributed-systems": {
    action: "Outline a microservice architecture you know and list its failure modes",
    successCriteria: [
      "Name two consistency challenges",
      "Explain one resilience pattern you would add",
    ],
  },
  "system-design": {
    action: "Practice one full system-design question end-to-end with explicit clarifying questions",
    successCriteria: [
      "Write down functional and non-functional requirements first",
      "Give a back-of-envelope capacity estimate",
      "Draw a high-level component diagram",
    ],
  },
  sql: {
    action: "Optimize two slow queries on a real schema: read the query plan, add an index",
    successCriteria: ["Explain the chosen index", "Explain a covering index vs a lookup"],
  },
  "sql.indexing": {
    action: "Design indexes for three query patterns and explain each choice",
    successCriteria: ["Explain B-tree ordering", "Explain composite index column order"],
  },
  apis: {
    action: "Design a small REST API surface and document it",
    successCriteria: ["Use consistent resource naming", "Choose correct status codes"],
  },
  behavioral: {
    action: "Prepare two STAR stories and tell each aloud in under 2 minutes",
    successCriteria: ["One story shows leadership", "One story shows handling conflict"],
  },
};

function genericAction(target: PrepTarget): { action: string; successCriteria: string[] } {
  const concepts =
    target.missingConcepts && target.missingConcepts.length > 0
      ? target.missingConcepts.slice(0, 3)
      : (taxonomy.getNode(target.skillId as SkillId)?.keywords ?? []).slice(0, 3);
  const label = target.label || taxonomy.labelFor(target.skillId as SkillId);
  return {
    action: `Practice ${label}: prepare a 2-minute explanation covering ${concepts.join(", ") || "the fundamentals"}, then answer one mock question on it.`,
    successCriteria: [
      ...concepts.map((c) => `Explain ${c}`),
      "Explain the key trade-offs",
      "Complete one mock question on the topic",
    ].slice(0, 4),
  };
}

export function prepPlannerMock(input: unknown): unknown {
  const { targets } = input as { targets: PrepTarget[] };
  return {
    actions: targets.map((t) => {
      const template = TEMPLATES[t.skillId] ?? genericAction(t);
      return {
        skillId: t.skillId,
        action: template.action,
        successCriteria: template.successCriteria,
        reason: t.reason,
      };
    }),
  };
}
