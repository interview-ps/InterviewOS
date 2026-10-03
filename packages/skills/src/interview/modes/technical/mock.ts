import { interviewerMock } from "../../interviewer/mock.js";
import { answerEvaluatorMock } from "../../../evaluate/answer-evaluator/mock.js";
import { followUpMockOutput } from "../mock-shared.js";

interface MockInput {
  skillId: string;
  followUp?: { parentQuestion: string; focus: string } | null;
}

export function technicalInterviewerMock(input: unknown): unknown {
  const { skillId, followUp } = input as MockInput;
  if (followUp) return followUpMockOutput(skillId, followUp.focus, "technical");
  return { ...(interviewerMock(input) as object), problem: null, focusDimension: null };
}

const TECH_LABELS: Record<string, string> = {
  correctness: "Correctness",
  technicalDepth: "Technical depth",
  reasoning: "Reasoning",
  communication: "Communication",
  roleRelevance: "Role relevance",
};

export function technicalEvaluatorMock(input: unknown): unknown {
  const base = answerEvaluatorMock(input) as {
    dimensions: Record<string, { score: number; rationale: string }>;
  };
  const rubric = Object.keys(TECH_LABELS).map((id) => ({
    id,
    label: TECH_LABELS[id]!,
    score: base.dimensions[id]!.score,
    rationale: base.dimensions[id]!.rationale,
  }));
  return { ...base, rubric, designUpdates: null };
}
