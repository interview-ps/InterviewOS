import { childrenOf } from "../../taxonomy/index.js";
import type { SkillId } from "../../skill-id.js";
import {
  genericFollowUp,
  inSubtree,
  type ModeDefinition,
  type ModeState,
} from "./types.js";

export interface HiringManagerState extends ModeState {
  themesCovered: string[];
}

export const hiringManagerMode: ModeDefinition = {
  id: "hiring_manager",
  label: "Hiring manager",
  description: "Scope, impact, priorities and leadership style — the conversation a hiring manager would have.",
  inScope: (skillId: SkillId) =>
    inSubtree(skillId, "hiring-manager") ||
    inSubtree(skillId, "behavioral.leadership") ||
    inSubtree(skillId, "communication"),
  fallbackSkills: [
    "hiring-manager",
    ...childrenOf("hiring-manager" as SkillId),
    "behavioral.leadership",
    "communication",
  ],
  rubric: [
    { id: "roleFit", label: "Role fit", description: "Understands the role and articulates mutual fit." },
    { id: "scopeImpact", label: "Scope & impact", description: "Describes scope of influence and business impact credibly." },
    { id: "prioritization", label: "Prioritization", description: "Makes and explains hard prioritization trade-offs." },
    { id: "leadership", label: "Leadership", description: "Leads through ambiguity; develops people and direction." },
    { id: "collaboration", label: "Collaboration", description: "Works across teams and manages stakeholders." },
    { id: "motivation", label: "Motivation", description: "Genuine, specific motivation for this team and role." },
  ],
  initialState: (): HiringManagerState => ({ themesCovered: [] }),
  reduce: (state, _evaluation, question): HiringManagerState => {
    const themes = [...(state.themesCovered as string[] ?? [])];
    if (question.topic && !themes.includes(question.topic)) themes.push(question.topic);
    return { themesCovered: themes };
  },
  followUp: (evaluation, _state, depth, maxDepth) =>
    genericFollowUp(evaluation, depth, maxDepth),
};
