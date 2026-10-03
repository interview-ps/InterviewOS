import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyScore } from "../src/lib/fuzzy.js";

describe("fuzzyScore (§9.7)", () => {
  it("returns -1 when the query is not a subsequence", () => {
    expect(fuzzyScore("xyz", "Start technical interview")).toBe(-1);
    expect(fuzzyScore("aaa", "abc")).toBe(-1);
  });

  it("matches subsequences case-insensitively", () => {
    expect(fuzzyScore("system", "Start System Design interview")).toBeGreaterThanOrEqual(0);
    expect(fuzzyScore("SDI", "System Design Interview")).toBeGreaterThanOrEqual(0);
  });

  it("empty query matches everything", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
    expect(fuzzyScore("   ", "anything")).toBe(0);
  });

  it("prefers word-boundary and consecutive matches", () => {
    const boundary = fuzzyScore("sys", "Start System Design");
    const scattered = fuzzyScore("sys", "glassy eyed aspirin");
    expect(scattered).toBeGreaterThanOrEqual(0);
    expect(boundary).toBeGreaterThan(scattered);
  });

  it("prefers earlier match positions", () => {
    const early = fuzzyScore("des", "Design the thing");
    const late = fuzzyScore("des", "The thing about design");
    expect(early).toBeGreaterThan(late);
  });
});

describe("fuzzyFilter", () => {
  const items = [
    "Start system design interview",
    "Start coding interview",
    "Check Codex connection",
    "Open resume coach",
  ];

  it("ranks the best match first and drops non-matches", () => {
    const out = fuzzyFilter(items, "system", (s) => s);
    expect(out[0]).toBe("Start system design interview");
    expect(out).not.toContain("Open resume coach");
  });

  it("empty query keeps the original order", () => {
    expect(fuzzyFilter(items, "", (s) => s)).toEqual(items);
  });
});
