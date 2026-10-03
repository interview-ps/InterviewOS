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

export function behavioralInterviewerMock(input: unknown): unknown {
  const { skillId, followUp } = input as MockInput;
  if (followUp) return followUpMockOutput(skillId, followUp.focus, "behavioral");
  return { ...(interviewerMock(input) as object), problem: null, focusDimension: null };
}

const BEH_LABELS: Record<string, string> = {
  situationClarity: "Situation clarity",
  ownership: "Ownership",
  actions: "Actions",
  decisionMaking: "Decision making",
  impact: "Impact",
  results: "Results",
  reflection: "Reflection",
  communication: "Communication",
};

export function behavioralEvaluatorMock(input: unknown): unknown {
  const { answer } = input as { answer: string };
  const base = answerEvaluatorMock(input) as {
    dimensions: Record<string, { score: number; rationale: string }>;
    star: { situation: boolean; task: boolean; action: boolean; result: boolean; notes: string } | null;
  };
  const star = starFrom(answer);
  const score = (v: number) => round2(Math.min(1, Math.max(0, v)));
  const kw = (kws: string[]) => keywordsHit(answer, kws);
  const rubric = [
    {
      id: "situationClarity",
      score: star.situation ? (star.task ? 0.9 : 0.7) : 0.3,
      rationale: star.situation ? "Context set." : "No clear situation set.",
    },
    {
      id: "ownership",
      score: score(0.3 + 0.2 * kw(["i led", "i decided", "i owned", "i drove", "my responsibility", "i was responsible"])),
      rationale: "First-person ownership signals.",
    },
    {
      id: "actions",
      score: star.action ? 0.85 : score(0.2 + 0.15 * kw(["i did", "i made", "i wrote"])),
      rationale: star.action ? "Concrete first-person actions." : "Few concrete actions.",
    },
    {
      id: "decisionMaking",
      score: score(0.25 + 0.2 * kw(["because", "decided", "chose", "trade-off", "rationale", "considered"])),
      rationale: "Reasoning behind choices.",
    },
    {
      id: "impact",
      score: score(0.25 + 0.2 * kw(["impact", "mattered", "business", "customer", "team", "importance"])),
      rationale: "Why the outcome mattered.",
    },
    {
      id: "results",
      score: star.result ? 0.85 : 0.2,
      rationale: star.result ? "Result given." : "No measurable result.",
    },
    {
      id: "reflection",
      score: score(0.2 + 0.25 * kw(["learned", "would do", "in hindsight", "next time", "retrospective"])),
      rationale: "Reflection signals.",
    },
    {
      id: "communication",
      score: base.dimensions.communication!.score,
      rationale: base.dimensions.communication!.rationale,
    },
  ].map((r) => ({ ...r, label: BEH_LABELS[r.id]! }));
  return { ...base, star: base.star ?? star, rubric, designUpdates: null };
}
