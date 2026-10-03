interface DebriefEval {
  summary?: string;
  strengths?: Array<{ skill: string; evidence: string }>;
  weaknesses?: Array<{ skill: string; severity: string; evidence: string }>;
}

interface DebriefInput {
  role: string;
  questions: Array<{ text: string; skillId: string }>;
  evaluations: DebriefEval[];
  openActions?: Array<{ skillId: string; action: string }>;
}

export function interviewDebriefMock(input: unknown): unknown {
  const { role, questions, evaluations, openActions } = input as DebriefInput;
  const strengths = new Set<string>();
  const weaknesses = new Map<string, string>();
  for (const ev of evaluations) {
    for (const s of ev.strengths ?? []) strengths.add(`${s.skill}: ${s.evidence}`);
    for (const w of ev.weaknesses ?? []) {
      if (!weaknesses.has(w.skill) || w.severity === "high") {
        weaknesses.set(w.skill, `${w.skill}: ${w.evidence}`);
      }
    }
  }
  const answered = evaluations.length;
  return {
    summary: `Mock interview for ${role}: ${answered} answer(s) across ${questions.length} question(s), ${strengths.size} strength area(s), ${weaknesses.size} weak area(s).`,
    wentWell: [...strengths].slice(0, 5),
    toImprove: [...weaknesses.values()].slice(0, 5),
    nextActions: (openActions ?? []).slice(0, 5).map((a) => a.action),
  };
}
