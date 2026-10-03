import { childrenOf } from "../../taxonomy/index.js";
import type { SkillId } from "../../skill-id.js";
import {
  inSubtree,
  rubricScore,
  type FollowUpDecision,
  type ModeDefinition,
  type ModeState,
} from "./types.js";

export interface CodingProblem {
  title: string;
  statement: string;
  constraints: string[];
  examples: { input: string; output: string; explanation?: string }[];
}

export interface CodingModeState extends ModeState {
  problem: CodingProblem | null;
  phase: "briefing" | "working";
}

export const codingMode: ModeDefinition = {
  id: "coding",
  label: "Coding",
  description: "Solve a small algorithmic problem — explain your approach, then write code (reviewed, not executed).",
  inScope: (skillId: SkillId) => inSubtree(skillId, "coding"),
  fallbackSkills: ["coding", ...childrenOf("coding" as SkillId)],
  rubric: [
    { id: "problemUnderstanding", label: "Problem understanding", description: "Restates the goal, clarifies inputs, constraints and edge conditions before coding." },
    { id: "approach", label: "Approach", description: "Describes a workable plan before or while writing code." },
    { id: "correctness", label: "Correctness", description: "The proposed logic/code solves the stated problem." },
    { id: "complexity", label: "Complexity", description: "States and reasons about time/space complexity (big-O)." },
    { id: "edgeCases", label: "Edge cases", description: "Identifies and handles edge cases (empty input, duplicates, bounds)." },
    { id: "codeQuality", label: "Code quality", description: "Readable, structured code — good naming, no dead paths." },
    { id: "communication", label: "Communication", description: "Thinks aloud clearly; the interviewer could follow along." },
  ],
  initialState: (): CodingModeState => ({ problem: null, phase: "briefing" }),
  reduce: (state, _evaluation, question): CodingModeState => {
    const next = { ...state } as CodingModeState;
    const problem = question.extra?.problem as CodingProblem | undefined;
    if (problem) next.problem = problem;
    next.phase = "working";
    return next;
  },
  followUp: (evaluation, _state, depth, maxDepth): FollowUpDecision => {
    if (depth >= maxDepth) {
      return { ask: false, reason: "follow-up depth reached" };
    }
    const complexity = rubricScore(evaluation, "complexity");
    const edgeCases = rubricScore(evaluation, "edgeCases");
    if (complexity !== undefined && complexity < 0.6) {
      return {
        ask: true,
        focus: "complexity analysis",
        reason: `complexity scored ${complexity.toFixed(2)} — dig into big-O`,
      };
    }
    if (edgeCases !== undefined && edgeCases < 0.6) {
      return {
        ask: true,
        focus: "edge cases",
        reason: `edgeCases scored ${edgeCases.toFixed(2)} — probe edge handling`,
      };
    }
    return { ask: false, reason: "complexity and edge cases adequately covered" };
  },
};
