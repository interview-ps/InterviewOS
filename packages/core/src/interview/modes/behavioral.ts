import { childrenOf } from "../../taxonomy/index.js";
import type { SkillId } from "../../skill-id.js";
import {
  genericFollowUp,
  inSubtree,
  type ModeDefinition,
  type ModeState,
} from "./types.js";

export interface BehavioralModeState extends ModeState {
  storyIdsUsed: string[];
  competenciesCovered: string[];
}

export const behavioralMode: ModeDefinition = {
  id: "behavioral",
  label: "Behavioral",
  description: "STAR stories from your experience — a specific situation, your actions, measurable results.",
  inScope: (skillId: SkillId) =>
    inSubtree(skillId, "behavioral") || inSubtree(skillId, "communication"),
  fallbackSkills: [
    "behavioral",
    ...childrenOf("behavioral" as SkillId),
    "communication",
    ...childrenOf("communication" as SkillId),
  ],
  rubric: [
    { id: "situationClarity", label: "Situation clarity", description: "Sets clear context — when, where, what was at stake." },
    { id: "ownership", label: "Ownership", description: "Shows personal accountability rather than team-only framing." },
    { id: "actions", label: "Actions", description: "Describes what the candidate personally did, in first person." },
    { id: "decisionMaking", label: "Decision making", description: "Explains reasoning and trade-offs behind choices." },
    { id: "impact", label: "Impact", description: "Shows the outcome mattered to the business or team." },
    { id: "results", label: "Results", description: "Reports concrete, ideally quantified, results." },
    { id: "reflection", label: "Reflection", description: "Shows learning — what changed or what they would do differently." },
    { id: "communication", label: "Communication", description: "Concise, well-structured story under ~2 minutes." },
  ],
  initialState: (): BehavioralModeState => ({
    storyIdsUsed: [],
    competenciesCovered: [],
  }),
  reduce: (state, _evaluation, question): BehavioralModeState => {
    const next = {
      storyIdsUsed: [...(state.storyIdsUsed as string[] ?? [])],
      competenciesCovered: [...(state.competenciesCovered as string[] ?? [])],
    };
    const storyId = question.extra?.storyId;
    if (typeof storyId === "string" && storyId && !next.storyIdsUsed.includes(storyId)) {
      next.storyIdsUsed.push(storyId);
    }
    if (!next.competenciesCovered.includes(question.skillId)) {
      next.competenciesCovered.push(question.skillId);
    }
    return next;
  },
  followUp: (evaluation, _state, depth, maxDepth) =>
    genericFollowUp(evaluation, depth, maxDepth),
};
