import type { SkillId } from "../../skill-id.js";
import {
  genericFollowUp,
  inSubtree,
  type ModeDefinition,
} from "./types.js";

/** Everything except the dedicated round subtrees (§9.1). */
const EXCLUDED_SUBTREES = [
  "system-design",
  "behavioral",
  "communication",
  "hr",
  "coding",
  "hiring-manager",
];

export const technicalMode: ModeDefinition = {
  id: "technical",
  label: "Technical",
  description: "Depth on tools, implementation details and trade-offs in the candidate's stack.",
  inScope: (skillId: SkillId) =>
    !EXCLUDED_SUBTREES.some((root) => inSubtree(skillId, root)),
  fallbackSkills: [],
  rubric: [
    { id: "correctness", label: "Correctness", description: "Technical claims are accurate." },
    { id: "technicalDepth", label: "Technical depth", description: "Goes beyond surface-level descriptions into mechanism and internals." },
    { id: "reasoning", label: "Reasoning", description: "Explains why, not just what; weighs alternatives." },
    { id: "communication", label: "Communication", description: "Structured, precise, easy to follow." },
    { id: "roleRelevance", label: "Role relevance", description: "Connects the answer to the target role's work." },
  ],
  initialState: () => ({}),
  reduce: (state) => state,
  followUp: (evaluation, _state, depth, maxDepth) =>
    genericFollowUp(evaluation, depth, maxDepth),
};
