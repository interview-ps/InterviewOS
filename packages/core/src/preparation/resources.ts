import { z } from "zod";
import { SkillIdSchema, type SkillId } from "../skill-id.js";
import { labelFor } from "../taxonomy/index.js";

/** A learning resource attached to a preparation action. */
export const PrepResourceSchema = z.object({
  skillId: SkillIdSchema,
  title: z.string().min(1).max(200),
  /** https only — no arbitrary schemes reach the UI. */
  url: z
    .string()
    .max(2000)
    .refine((u) => u.startsWith("https://"), "resource URLs must be https")
    .optional(),
  summary: z.string().max(600).optional(),
  kind: z.enum(["docs", "explanation", "practice", "article", "video"]),
  /** "builtin" | "pack:<id>" | "plugin:<id>" — where the resource came from. */
  source: z.string().min(1).max(120),
});
export type PrepResource = z.infer<typeof PrepResourceSchema>;

/**
 * Built-in catalog, keyed by skill-id prefix. Only stable official
 * documentation URLs are used; entries without a confident URL carry none.
 */
const CATALOG: Record<string, Array<Omit<PrepResource, "skillId" | "source">>> = {
  "sql.indexing": [
    {
      title: "PostgreSQL documentation — Indexes",
      url: "https://www.postgresql.org/docs/current/indexes.html",
      kind: "docs",
    },
    {
      title: "Use The Index, Luke",
      url: "https://use-the-index-luke.com/",
      kind: "article",
    },
  ],
  "sql.query-optimization": [
    {
      title: "PostgreSQL documentation — Using EXPLAIN",
      url: "https://www.postgresql.org/docs/current/using-explain.html",
      kind: "docs",
    },
  ],
  "sql.transactions": [
    {
      title: "PostgreSQL documentation — Transaction Isolation",
      url: "https://www.postgresql.org/docs/current/transaction-iso.html",
      kind: "docs",
    },
  ],
  sql: [
    {
      title: "PostgreSQL documentation — SQL tutorial",
      url: "https://www.postgresql.org/docs/current/tutorial-sql.html",
      kind: "docs",
    },
  ],
  "apis.rest": [
    {
      title: "MDN — HTTP overview",
      url: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Overview",
      kind: "docs",
    },
  ],
  apis: [
    {
      title: "MDN — HTTP",
      url: "https://developer.mozilla.org/en-US/docs/Web/HTTP",
      kind: "docs",
    },
  ],
  "distributed-systems.consistency": [
    {
      title: "Interview OS explanation: consistency models",
      summary:
        "Strong vs eventual consistency, linearizability, and the trade-offs you are expected to name in a design interview.",
      kind: "explanation",
    },
  ],
  "distributed-systems.caching": [
    {
      title: "Interview OS explanation: caching patterns",
      summary:
        "Cache-aside, read/write-through, TTLs and invalidation — the vocabulary interviewers probe for.",
      kind: "explanation",
    },
  ],
  "distributed-systems.message-queues": [
    {
      title: "Interview OS explanation: delivery semantics",
      summary:
        "At-least-once vs exactly-once delivery, idempotent consumers, dead-letter queues and backpressure.",
      kind: "explanation",
    },
  ],
  "system-design": [
    {
      title: "Interview OS explanation: the design-interview frame",
      summary:
        "Clarify requirements, estimate capacity, sketch the high-level design, then drill into bottlenecks and trade-offs.",
      kind: "explanation",
    },
  ],
  "system-design.scalability": [
    {
      title: "Interview OS explanation: scaling reads and writes",
      summary:
        "Caching, replication, partitioning/sharding and load balancing — and when each breaks down.",
      kind: "explanation",
    },
  ],
  coding: [
    {
      title: "Interview OS explanation: interview coding technique",
      summary:
        "Think aloud, state complexity, test edge cases — the habits evaluators score on top of a correct solution.",
      kind: "explanation",
    },
  ],
  behavioral: [
    {
      title: "Interview OS explanation: STAR structure",
      summary:
        "Situation, Task, Action, Result — keep the result measurable and your own actions first-person.",
      kind: "explanation",
    },
  ],
  python: [
    {
      title: "Python documentation",
      url: "https://docs.python.org/3/",
      kind: "docs",
    },
  ],
  "infrastructure.kubernetes": [
    {
      title: "Kubernetes documentation",
      url: "https://kubernetes.io/docs/home/",
      kind: "docs",
    },
  ],
};

/**
 * Built-in resources for `skillId`: the most-specific catalog prefix match,
 * plus an always-available practice entry. Pack/plugin resources merge on top.
 */
export function builtinResourcesFor(skillId: SkillId): PrepResource[] {
  let prefix: string | null = skillId;
  let entries: Array<Omit<PrepResource, "skillId" | "source">> = [];
  while (prefix) {
    const hit = CATALOG[prefix];
    if (hit) {
      entries = hit;
      break;
    }
    const idx = prefix.lastIndexOf(".");
    prefix = idx === -1 ? null : prefix.slice(0, idx);
  }
  const resources: PrepResource[] = entries.map((e) => ({
    ...e,
    skillId,
    source: "builtin",
  }));
  resources.push({
    skillId,
    title: `Practice a ${labelFor(skillId)} question`,
    summary: "Start a practice session in Interview OS to verify this skill.",
    kind: "practice",
    source: "builtin",
  });
  return resources;
}

/** Merge resource lists, deduping by title+url. */
export function mergeResources(...lists: PrepResource[][]): PrepResource[] {
  const seen = new Set<string>();
  const out: PrepResource[] = [];
  for (const list of lists) {
    for (const r of list) {
      const key = `${r.title}	${r.url ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}
