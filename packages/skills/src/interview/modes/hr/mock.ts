import { interviewerMock } from "../../interviewer/mock.js";
import { answerEvaluatorMock } from "../../../evaluate/answer-evaluator/mock.js";
import {
  followUpMockOutput,
  keywordsHit,
  round2,
  starFrom,
} from "../mock-shared.js";

interface MockInput {
  skillId: string;
  followUp?: { parentQuestion: string; focus: string } | null;
}

export function hrInterviewerMock(input: unknown): unknown {
  const { skillId, followUp } = input as MockInput;
  if (followUp) return followUpMockOutput(skillId, followUp.focus, "hr");
  return { ...(interviewerMock(input) as object), problem: null, focusDimension: null };
}

const HR_KWS: Record<string, string[]> = {
  motivation: ["excited", "interested", "motivated", "drawn", "passionate", "because"],
  careerGoals: ["grow", "goal", "learn", "next", "lead", "deepen", "years"],
  cultureFit: ["culture", "value", "team", "collaboration", "feedback", "autonomy"],
  workStyle: ["i prefer", "i usually", "async", "feedback", "communicate", "thrive", "i work best"],
};

const HR_LABELS: Record<string, string> = {
  motivation: "Motivation",
  careerGoals: "Career goals",
  cultureFit: "Culture fit",
  workStyle: "Work style",
  communication: "Communication",
};

export function hrEvaluatorMock(input: unknown): unknown {
  const { answer } = input as { answer: string };
  const base = answerEvaluatorMock(input) as {
    dimensions: Record<string, { score: number; rationale: string }>;
    star: unknown;
  };
  const score = (v: number) => round2(Math.min(1, Math.max(0, v)));
  // iterate the mode rubric (HR_LABELS covers communication too) — HR_KWS has
  // no keyword set for communication; it comes from the base evaluator
  const rubric = Object.keys(HR_LABELS).map((id) => {
    const kws = HR_KWS[id] ?? [];
    const hits = keywordsHit(answer, kws);
    return {
      id,
      label: HR_LABELS[id]!,
      score:
        id === "communication"
          ? base.dimensions.communication!.score
          : score(hits === 0 ? 0.2 : 0.4 + 0.15 * hits),
      rationale: hits === 0 ? "Not evidenced." : `${hits} relevant term(s).`,
    };
  });
  return { ...base, rubric, designUpdates: null };
}
