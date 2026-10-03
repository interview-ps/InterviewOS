import { childrenOf } from "../../taxonomy/index.js";
import type { SkillId } from "../../skill-id.js";
import {
  genericFollowUp,
  inSubtree,
  type ModeDefinition,
  type ModeState,
} from "./types.js";

export interface HrModeState extends ModeState {
  themesCovered: string[];
}

export const hrMode: ModeDefinition = {
  id: "hr",
  label: "HR",
  description: "Motivation, career goals, culture fit and work style — friendly but probing.",
  inScope: (skillId: SkillId) => inSubtree(skillId, "hr"),
  fallbackSkills: ["hr", ...childrenOf("hr" as SkillId)],
  rubric: [
    { id: "motivation", label: "Motivation", description: "Specific, genuine interest in the role and company." },
    { id: "careerGoals", label: "Career goals", description: "Coherent direction that this role plausibly serves." },
    { id: "cultureFit", label: "Culture fit", description: "Working preferences align with the company context." },
    { id: "workStyle", label: "Work style", description: "Concrete habits for communication, feedback and delivery." },
    { id: "communication", label: "Communication", description: "Direct, personable, concise answers." },
  ],
  initialState: (): HrModeState => ({ themesCovered: [] }),
  reduce: (state, _evaluation, question): HrModeState => {
    const themes = [...(state.themesCovered as string[] ?? [])];
    if (question.topic && !themes.includes(question.topic)) themes.push(question.topic);
    return { themesCovered: themes };
  },
  followUp: (evaluation, _state, depth, maxDepth) =>
    genericFollowUp(evaluation, depth, maxDepth),
};
