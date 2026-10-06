import { describe, expect, it } from "vitest";

import { evidenceTypeLabel, evidenceTypeTone } from "../src/evidence";

describe("evidenceTypeTone", () => {
  it("gives each evidence source its own tone", () => {
    expect(evidenceTypeTone("interview_answer")).toBe("blue");
    expect(evidenceTypeTone("practice")).toBe("green");
    expect(evidenceTypeTone("plugin")).toBe("amber");
    expect(evidenceTypeTone("resume_claim")).toBe("muted");
    expect(evidenceTypeTone("self_report")).toBe("muted");
  });

  it("falls back to muted for unknown types", () => {
    expect(evidenceTypeTone("mystery")).toBe("muted");
  });
});

describe("evidenceTypeLabel", () => {
  it("labels the known sources", () => {
    expect(evidenceTypeLabel("interview_answer")).toBe("Interview answer");
    expect(evidenceTypeLabel("plugin")).toBe("Extension");
    expect(evidenceTypeLabel("resume_claim")).toBe("Resume");
  });

  it("humanizes unknown types", () => {
    expect(evidenceTypeLabel("mock_signal")).toBe("Mock Signal");
  });
});
