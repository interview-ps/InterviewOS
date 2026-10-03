import { COMPANY_DISCLAIMER, type CompanyProfile } from "./types.js";

/**
 * Commonly reported pattern: two coding rounds, a product/system design round,
 * and a behavioral round aligned with Meta's public core values.
 */
export const metaProfile: CompanyProfile = {
  id: "meta",
  name: "Meta",
  aliases: ["meta", "facebook"],
  disclaimer: COMPANY_DISCLAIMER,
  typicalLoop: [
    { mode: "coding", label: "Coding I", plannedQuestions: 2 },
    { mode: "coding", label: "Coding II", plannedQuestions: 2 },
    { mode: "system_design", label: "Product/system design", plannedQuestions: 4 },
    { mode: "behavioral", label: "Behavioral", plannedQuestions: 4 },
    { mode: "hiring_manager", label: "Hiring manager", plannedQuestions: 3 },
  ],
  emphasis: [
    { skillId: "coding", weight: 0.08 },
    { skillId: "coding.data-structures", weight: 0.05 },
    { skillId: "system-design", weight: 0.05 },
  ],
  behavioralFramework: {
    name: "Meta values",
    themes: [
      "move fast",
      "focus on impact",
      "be bold",
      "build social value",
    ],
    guidance:
      "Favor stories about shipping quickly under uncertainty, choosing impact over polish, and resolving disagreement directly.",
  },
  followUpDepth: 1,
  rubricEmphasis: { approach: 1.1, impact: 1.1 },
  roleExpectations: {
    junior: ["productive coder", "ramp quickly with support"],
    mid: ["ships end-to-end", "strong debugging instincts"],
    senior: ["drives ambiguous projects", "cross-functional influence"],
    staff: ["org-level technical leadership", "multiplies team output"],
  },
};
