import { describe, expect, it } from "vitest";
import {
  COMPANY_DISCLAIMER,
  COMPANY_PROFILES,
  getCompanyProfile,
  matchCompanyProfile,
} from "../src/index.js";

describe("§9.3 company profiles", () => {
  it("every profile carries the disclaimer and a valid shape", () => {
    for (const p of COMPANY_PROFILES) {
      expect(p.disclaimer).toBe(COMPANY_DISCLAIMER);
      expect(p.typicalLoop.length).toBeGreaterThan(0);
      expect([1, 2, 3]).toContain(p.followUpDepth);
      for (const e of p.emphasis) expect(e.weight).toBeLessThanOrEqual(0.1);
    }
  });

  it("amazon uses two-deep follow-ups; generic uses one", () => {
    expect(getCompanyProfile("amazon").followUpDepth).toBe(2);
    expect(getCompanyProfile("generic").followUpDepth).toBe(1);
  });
});

describe("matchCompanyProfile", () => {
  it("matches names and aliases case-insensitively", () => {
    expect(matchCompanyProfile("Google").id).toBe("google");
    expect(matchCompanyProfile("ALPHABET").id).toBe("google");
    expect(matchCompanyProfile("Meta").id).toBe("meta");
    expect(matchCompanyProfile("facebook").id).toBe("meta");
    expect(matchCompanyProfile("Amazon Web Services").id).toBe("amazon");
    expect(matchCompanyProfile("aws").id).toBe("amazon");
    expect(matchCompanyProfile("Microsoft").id).toBe("microsoft");
    expect(matchCompanyProfile("MSFT").id).toBe("microsoft");
  });

  it("matches single-word aliases on word boundaries", () => {
    expect(matchCompanyProfile("Meta Platforms Inc").id).toBe("meta");
    // substring-only matches must NOT hit ("amazing" contains "amazi..."? "aws" boundary)
    expect(matchCompanyProfile("Amazone Corp").id).toBe("generic");
    expect(matchCompanyProfile("Metaverse Labs").id).toBe("generic");
  });

  it("falls back to generic for unknown/empty names", () => {
    expect(matchCompanyProfile("Northwind Cloud").id).toBe("generic");
    expect(matchCompanyProfile("").id).toBe("generic");
    expect(matchCompanyProfile("   ").id).toBe("generic");
  });
});
