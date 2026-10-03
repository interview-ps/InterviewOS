import { COMPANY_DISCLAIMER, type CompanyProfile } from "./types.js";

/** Default loop for any company without a specific profile. */
export const genericProfile: CompanyProfile = {
  id: "generic",
  name: "Generic",
  aliases: [],
  disclaimer: COMPANY_DISCLAIMER,
  typicalLoop: [
    { mode: "technical", label: "Technical screen", plannedQuestions: 4 },
    { mode: "coding", label: "Coding round", plannedQuestions: 2 },
    { mode: "system_design", label: "System design", plannedQuestions: 4 },
    { mode: "behavioral", label: "Behavioral", plannedQuestions: 4 },
    { mode: "hr", label: "HR / culture", plannedQuestions: 3 },
  ],
  emphasis: [],
  behavioralFramework: {
    name: "STAR",
    themes: ["ownership", "collaboration", "conflict resolution", "learning from failure"],
    guidance:
      "Probe for a specific past situation; expect Situation → Task → Action → Result with at least one concrete outcome.",
  },
  followUpDepth: 1,
  rubricEmphasis: {},
  roleExpectations: {
    junior: ["solid fundamentals", "learns quickly", "asks good clarifying questions"],
    mid: ["delivers independently", "owns medium-sized features end to end"],
    senior: ["drives projects across teams", "mentors others", "makes sound trade-offs"],
    staff: ["sets technical direction", "influences beyond own team", "unblocks ambiguous programs"],
  },
};
