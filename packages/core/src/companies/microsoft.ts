import { COMPANY_DISCLAIMER, type CompanyProfile } from "./types.js";

/**
 * Commonly reported pattern: coding plus a design round, a behavioral round,
 * and a final hiring-manager ("as appropriate") round for senior candidates.
 */
export const microsoftProfile: CompanyProfile = {
  id: "microsoft",
  name: "Microsoft",
  aliases: ["microsoft", "msft"],
  disclaimer: COMPANY_DISCLAIMER,
  typicalLoop: [
    { mode: "coding", label: "Coding", plannedQuestions: 2 },
    { mode: "technical", label: "Technical deep dive", plannedQuestions: 4 },
    { mode: "system_design", label: "Design", plannedQuestions: 4 },
    { mode: "behavioral", label: "Behavioral", plannedQuestions: 4 },
    { mode: "hiring_manager", label: "As-appropriate (hiring manager)", plannedQuestions: 3 },
  ],
  emphasis: [
    { skillId: "coding", weight: 0.06 },
    { skillId: "system-design", weight: 0.05 },
    { skillId: "hiring-manager", weight: 0.04 },
  ],
  behavioralFramework: {
    name: "Growth mindset",
    themes: [
      "growth mindset",
      "customer obsession",
      "diverse and inclusive collaboration",
      "making others around you better",
    ],
    guidance:
      "Favor stories about learning from feedback, inclusive collaboration across teams, and putting customer outcomes first.",
  },
  followUpDepth: 1,
  rubricEmphasis: { leadership: 1.1, collaboration: 1.1 },
  roleExpectations: {
    junior: ["solid fundamentals", "openness to feedback"],
    mid: ["independent delivery", "good collaboration hygiene"],
    senior: ["drives multi-team work", "mentors", "customer-focused design"],
    staff: ["division-level influence", "technical strategy"],
  },
};
