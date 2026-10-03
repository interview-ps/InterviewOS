import { COMPANY_DISCLAIMER, type CompanyProfile } from "./types.js";

/**
 * Commonly reported pattern: every round mixes in behavioral questions that
 * probe Amazon's public Leadership Principles by name, often with deep
 * follow-ups ("why?", "what would you do differently?") — plus coding and,
 * for senior roles, system design.
 */
export const amazonProfile: CompanyProfile = {
  id: "amazon",
  name: "Amazon",
  aliases: ["amazon", "aws", "amazon web services"],
  disclaimer: COMPANY_DISCLAIMER,
  typicalLoop: [
    { mode: "coding", label: "Coding", plannedQuestions: 2 },
    { mode: "behavioral", label: "Leadership Principles I", plannedQuestions: 4 },
    { mode: "behavioral", label: "Leadership Principles II", plannedQuestions: 4 },
    { mode: "system_design", label: "System design", plannedQuestions: 4 },
    { mode: "hiring_manager", label: "Hiring manager", plannedQuestions: 3 },
  ],
  emphasis: [
    { skillId: "behavioral", weight: 0.08 },
    { skillId: "behavioral.ownership", weight: 0.06 },
    { skillId: "coding", weight: 0.04 },
  ],
  behavioralFramework: {
    name: "Leadership Principles",
    themes: [
      "customer obsession",
      "ownership",
      "bias for action",
      "dive deep",
      "deliver results",
      "earn trust",
      "have backbone; disagree and commit",
      "learn and be curious",
    ],
    guidance:
      "Each behavioral answer should map to a Leadership Principle; probe two levels deep on the candidate's personal contribution and the measurable result.",
  },
  followUpDepth: 2,
  rubricEmphasis: { ownership: 1.2, results: 1.2, decisionMaking: 1.1 },
  roleExpectations: {
    junior: ["delivers with guidance", "learns quickly", "bias for action"],
    mid: ["owns features end to end", "dives deep into data"],
    senior: ["owns services/systems", "influences without authority", "develops others"],
    staff: ["org-wide ownership", "long-term technical vision"],
  },
};
