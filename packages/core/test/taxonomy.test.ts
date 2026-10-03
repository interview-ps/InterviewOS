import { describe, expect, it } from "vitest";
import { taxonomy } from "../src/index.js";

describe("taxonomy", () => {
  it("resolves seeded nodes and ancestors", () => {
    expect(taxonomy.getNode("sql.indexing")?.label).toBe("SQL Indexing");
    expect(taxonomy.parentOf("sql.indexing")).toBe("sql");
    expect(taxonomy.ancestors("distributed-systems.caching.cache-invalidation")).toEqual([
      "distributed-systems.caching",
      "distributed-systems",
    ]);
  });

  it("creates unknown valid ids on demand with humanized labels", () => {
    const node = taxonomy.getNode("ml.reinforcement-learning");
    expect(node?.label).toBe("Reinforcement Learning");
    expect(taxonomy.labelFor("ml.reinforcement-learning")).toBe("Reinforcement Learning");
    expect(taxonomy.getNode("NOT VALID")).toBeUndefined();
  });

  it("matches skills by keyword, case-insensitive, word boundary", () => {
    const matches = taxonomy.matchSkills(
      "We used Redis as a cache, Kafka for the queue, and wrote SQL.",
    );
    const ids = matches.map((m) => m.skillId);
    expect(ids).toContain("distributed-systems.caching");
    expect(ids).toContain("distributed-systems.message-queues");
    expect(ids).toContain("sql");
    const kafka = matches.find((m) => m.skillId === "distributed-systems.message-queues")!;
    expect(kafka.mentions).toBeGreaterThanOrEqual(2); // kafka + queue
  });

  it("does not match substrings inside words", () => {
    const matches = taxonomy.matchSkills("stalemate and cachingest");
    expect(matches.find((m) => m.skillId === "distributed-systems.caching.cache-invalidation")).toBeUndefined();
  });

  it("spreads cache keywords across strategies vs invalidation", () => {
    const strat = taxonomy.matchSkills("we use a write-through cache-aside with short ttl");
    expect(strat.some((m) => m.skillId === "distributed-systems.caching.cache-strategies")).toBe(true);
    const inv = taxonomy.matchSkills("we invalidate stale entries on write");
    expect(
      inv.some((m) => m.skillId === "distributed-systems.caching.cache-invalidation"),
    ).toBe(true);
  });

  it("normalizes raw ids and maps known aliases", () => {
    expect(taxonomy.normalizeSkillId("Redis")).toBe("distributed-systems.caching");
    expect(taxonomy.normalizeSkillId("REST API")).toBe("apis.rest");
    expect(taxonomy.normalizeSkillId("  Message Queues ")).toBe(
      "distributed-systems.message-queues",
    );
    expect(taxonomy.normalizeSkillId("Kafka")).toBe("distributed-systems.message-queues");
    expect(taxonomy.normalizeSkillId("brand new skill")).toBe("brand-new-skill");
    // models sometimes prefix a keyword with a guessed branch — snap the last
    // segment to the canonical node so related edges keep working
    expect(taxonomy.normalizeSkillId("coding.complexity-analysis")).toBe("coding.complexity");
    expect(taxonomy.normalizeSkillId("coding.Complexity Analysis")).toBe("coding.complexity");
    // a genuinely unknown dotted id with no known last segment stays as-is
    expect(taxonomy.normalizeSkillId("cloud.quantum-safe-crypto")).toBe(
      "cloud.quantum-safe-crypto",
    );
    expect(taxonomy.normalizeSkillId("!!!")).toBeNull();
  });
});
