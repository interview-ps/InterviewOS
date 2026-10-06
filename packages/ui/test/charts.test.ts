import { describe, expect, it } from "vitest";

import {
  CONFIDENCE_SPREAD,
  clamp01,
  confidenceBand,
  historySummary,
  isLowConfidence,
  severityTone,
  statusTone,
} from "../src/charts";

describe("clamp01", () => {
  it("clamps to the 0–1 range", () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(1.5)).toBe(1);
    expect(clamp01(0.42)).toBe(0.42);
  });

  it("treats non-finite input as 0", () => {
    expect(clamp01(Number.NaN)).toBe(0);
    expect(clamp01(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("confidenceBand", () => {
  it("is widest at zero confidence and collapses at full confidence", () => {
    const unsure = confidenceBand(0.5, 0);
    const sure = confidenceBand(0.5, 1);
    expect(unsure.upper - unsure.lower).toBeCloseTo(2 * CONFIDENCE_SPREAD, 5);
    expect(sure.upper).toBeCloseTo(sure.lower, 5);
  });

  it("widens monotonically as confidence falls", () => {
    const high = confidenceBand(0.5, 0.9);
    const mid = confidenceBand(0.5, 0.5);
    const low = confidenceBand(0.5, 0.1);
    expect(high.upper - high.lower).toBeLessThan(mid.upper - mid.lower);
    expect(mid.upper - mid.lower).toBeLessThan(low.upper - low.lower);
  });

  it("clamps both edges to [0, 1]", () => {
    const band = confidenceBand(0.98, 0);
    expect(band.upper).toBeLessThanOrEqual(1);
    expect(band.lower).toBeGreaterThanOrEqual(0);
    const bottom = confidenceBand(0.02, 0);
    expect(bottom.lower).toBe(0);
  });
});

describe("isLowConfidence", () => {
  it("flags confidence below the threshold only", () => {
    expect(isLowConfidence(0.39)).toBe(true);
    expect(isLowConfidence(0.4)).toBe(false);
  });
});

describe("severityTone / statusTone", () => {
  it("maps gap severity to tokens", () => {
    expect(severityTone("high")).toBe("var(--color-danger)");
    expect(severityTone("medium")).toBe("var(--color-accent)");
    expect(severityTone("low")).toBe("var(--color-neutral)");
  });

  it("maps readiness status to tokens, unassessed is the divider", () => {
    expect(statusTone("strong")).toBe("var(--color-green)");
    expect(statusTone("developing")).toBe("var(--color-blue)");
    expect(statusTone("weak")).toBe("var(--color-accent)");
    expect(statusTone("unknown")).toBe("var(--color-divider)");
  });
});

describe("historySummary", () => {
  const p = (score: number | null, confidence = 0.9, computedAt = "2026-01-01") => ({
    score,
    confidence,
    computedAt,
  });

  it("handles an empty series", () => {
    expect(historySummary([])).toEqual({ count: 0, first: null, latest: null, lowConfidence: 0 });
  });

  it("handles a single point", () => {
    const s = historySummary([p(0.4)]);
    expect(s.count).toBe(1);
    expect(s.first).toBe(0.4);
    expect(s.latest).toBe(0.4);
  });

  it("ignores null scores and counts low-confidence points", () => {
    const s = historySummary([
      p(null),
      p(0.3, 0.2),
      p(0.6, 0.9),
      p(0.7, 0.35),
    ]);
    expect(s.count).toBe(3);
    expect(s.first).toBe(0.3);
    expect(s.latest).toBe(0.7);
    expect(s.lowConfidence).toBe(2);
  });
});
