import type { SkillId } from "../../skill-id.js";
import type { AnswerEvaluation } from "../../assessment/index.js";

export const MODE_IDS = [
  "technical",
  "coding",
  "system_design",
  "behavioral",
  "hiring_manager",
  "hr",
] as const;
export type ModeId = (typeof MODE_IDS)[number];

/** Opaque per-mode session state, persisted as JSON on interview_sessions. */
export type ModeState = Record<string, unknown>;

export interface RubricDimension {
  id: string;
  label: string;
  description: string;
}

export interface FollowUpDecision {
  ask: boolean;
  /** Short label the follow-up question should probe (missing concept/dimension). */
  focus?: string;
  reason: string;
}

/** The slice of a stored question the mode reducer sees. */
export interface ModeQuestionContext {
  skillId: SkillId;
  topic: string;
  /** Coding problem / design focus dimension etc. stored on the question. */
  extra?: Record<string, unknown>;
}

/** §9.1: one self-contained interview mode — scope, rubric, state, follow-ups. */
export interface ModeDefinition {
  id: ModeId | "mixed";
  label: string;
  description: string;
  inScope(skillId: SkillId): boolean;
  /** Taxonomy nodes that join an empty candidate pool at importance 0.6. */
  fallbackSkills: SkillId[];
  /** Independent rubric dimensions the evaluator must score (empty for mixed). */
  rubric: RubricDimension[];
  initialState(): ModeState;
  reduce(
    state: ModeState,
    evaluation: AnswerEvaluation,
    question: ModeQuestionContext,
  ): ModeState;
  /**
   * Decide whether to dig deeper before the next main question.
   * `depth` = follow-ups already chained under the active main question.
   */
  followUp(
    evaluation: AnswerEvaluation,
    state: ModeState,
    depth: number,
    maxDepth: number,
  ): FollowUpDecision;
}

export const inSubtree = (skillId: string, root: string): boolean =>
  skillId === root || skillId.startsWith(`${root}.`);

export const rubricScore = (
  evaluation: AnswerEvaluation,
  id: string,
): number | undefined => evaluation.rubric.find((r) => r.id === id)?.score;

/**
 * Default follow-up rule (technical / behavioral / hiring_manager / hr): dig
 * once per missing concept while a rubric dimension is weak and depth remains.
 */
export function genericFollowUp(
  evaluation: AnswerEvaluation,
  depth: number,
  maxDepth: number,
): FollowUpDecision {
  if (depth >= maxDepth) {
    return { ask: false, reason: "follow-up depth reached" };
  }
  const weak = evaluation.rubric.find((r) => r.score < 0.6);
  const missing = evaluation.missingConcepts[0];
  if (missing && weak) {
    return {
      ask: true,
      focus: missing,
      reason: `probing "${missing}" — ${weak.label || weak.id} scored ${weak.score.toFixed(2)}`,
    };
  }
  return {
    ask: false,
    reason: missing
      ? "concepts missed but rubric scores adequate"
      : "no missing concepts",
  };
}
