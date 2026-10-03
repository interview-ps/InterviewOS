import { COMPANY_DISCLAIMER, type CompanyProfile } from "./types.js";

/**
 * Commonly reported pattern: heavy emphasis on live coding (often two rounds),
 * system design for senior+, and one behavioral round probing collaboration
 * and comfort with ambiguity ("Googleyness").
 */
export const googleProfile: CompanyProfile = {
  id: "google",
  name: "Google",
  aliases: ["google", "alphabet"],
  disclaimer: COMPANY_DISCLAIMER,
  typicalLoop: [
    { mode: "coding", label: "Coding I", plannedQuestions: 2 },
    { mode: "coding", label: "Coding II", plannedQuestions: 2 },
    { mode: "system_design", label: "System design", plannedQuestions: 4 },
    { mode: "behavioral", label: "Behavioral (Googleyness)", plannedQuestions: 4 },
  ],
  emphasis: [
    { skillId: "coding", weight: 0.08 },
    { skillId: "coding.complexity", weight: 0.06 },
    { skillId: "system-design", weight: 0.05 },
  ],
  behavioralFramework: {
    name: "Googleyness",
    themes: [
      "comfort with ambiguity",
      "collaboration across teams",
      "humility and learning",
      "doing the right thing for users",
    ],
    guidance:
      "Favor stories about navigating ambiguity, helping others succeed, and pushing back respectfully with data.",
  },
  followUpDepth: 2,
  rubricEmphasis: { complexity: 1.2, problemUnderstanding: 1.1 },
  roleExpectations: {
    junior: ["strong CS fundamentals", "clean coding under guidance"],
    mid: ["solves novel coding problems independently", "clear complexity reasoning"],
    senior: ["designs systems at scale", "handles ambiguous requirements"],
    staff: ["industry-level design depth", "leads technical strategy discussions"],
  },
};
