import { inRound, type SkillId } from "@interview-os/core";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** §8.4 STAR detection heuristics for the mock runtime. */
const STAR_PARTS: Array<{ name: string; key: "situation" | "task" | "action" | "result"; re: RegExp }> = [
  {
    name: "Situation",
    key: "situation",
    re: /when i|at my (previous|last)|in 20\d\d|our team was/i,
  },
  {
    name: "Task",
    key: "task",
    re: /my (goal|task|responsibility)|i was (responsible|asked)|needed to/i,
  },
  {
    name: "Action",
    key: "action",
    re: /\bi (led|built|implemented|decided|proposed|organized|wrote|designed|talked)/i,
  },
  {
    name: "Result",
    key: "result",
    re: /result|reduced|increased|improved|saved|\d+%|shipped|launched/i,
  },
];

interface ExpectedConcept {
  concept: string;
  skillId: string;
  keywords?: string[];
}

interface EvalInput {
  question: { text: string; skillId: string; expectedConcepts?: ExpectedConcept[] };
  answer: string;
  roundType?: string;
}

function conceptCovered(concept: ExpectedConcept, answer: string): boolean {
  const keys = concept.keywords?.length ? concept.keywords : [concept.concept];
  const lower = answer.toLowerCase();
  return keys.some((k) => lower.includes(k.toLowerCase()));
}

export function answerEvaluatorMock(input: unknown): unknown {
  const { question, answer, roundType = "mixed" } = input as EvalInput;
  const concepts = question.expectedConcepts ?? [];

  // §8.4: STAR applies to behavioral/hr questions (round type or skill subtree).
  const starRelevant =
    roundType === "behavioral" ||
    roundType === "hr" ||
    inRound(question.skillId as SkillId, "behavioral") ||
    inRound(question.skillId as SkillId, "hr");
  const starHits = STAR_PARTS.map((p) => ({ ...p, hit: starRelevant && p.re.test(answer) }));
  const missingStar = starRelevant ? starHits.filter((p) => !p.hit) : [];
  const star = starRelevant
    ? {
        situation: starHits[0]!.hit,
        task: starHits[1]!.hit,
        action: starHits[2]!.hit,
        result: starHits[3]!.hit,
        notes:
          missingStar.length === 0
            ? "All four STAR parts are present."
            : `Missing: ${missingStar.map((p) => p.name).join(", ")}`,
      }
    : null;
  const words = answer.trim().split(/\s+/).filter(Boolean).length;
  const sentences = answer.split(/[.!?]+/).filter((s) => s.trim().length > 0).length;

  const covered = concepts.filter((c) => conceptCovered(c, answer));
  const missing = concepts.filter((c) => !conceptCovered(c, answer));
  const overallCoverage = concepts.length === 0 ? 0.5 : covered.length / concepts.length;

  const confidence = round2(0.55 + 0.25 * Math.min(1, words / 80));

  // per-skill coverage → scores
  const bySkill = new Map<string, { total: number; covered: number; names: string[]; missed: string[] }>();
  for (const c of concepts) {
    const s = bySkill.get(c.skillId) ?? { total: 0, covered: 0, names: [], missed: [] };
    s.total += 1;
    if (conceptCovered(c, answer)) {
      s.covered += 1;
      s.names.push(c.concept);
    } else {
      s.missed.push(c.concept);
    }
    bySkill.set(c.skillId, s);
  }
  bySkill.set(question.skillId, bySkill.get(question.skillId) ?? { total: 0, covered: 0, names: [], missed: [] });

  // STAR coverage feeds the communication score for behavioral/hr answers.
  if (starRelevant) {
    const comm = bySkill.get("communication") ?? { total: 0, covered: 0, names: [], missed: [] };
    for (const p of starHits) {
      comm.total += 1;
      if (p.hit) comm.covered += 1;
      else comm.missed.push(`STAR ${p.name}`);
    }
    bySkill.set("communication", comm);
  }

  const scores = [...bySkill.entries()].map(([skillId, s]) => ({
    skill: skillId,
    score:
      skillId === question.skillId
        ? round2(0.15 + 0.8 * overallCoverage)
        : round2(0.15 + 0.8 * (s.total === 0 ? overallCoverage : s.covered / s.total)),
    confidence,
  }));

  const strengths = [...bySkill.entries()]
    .filter(([, s]) => s.total > 0 && s.covered / s.total >= 0.75)
    .map(([skill, s]) => ({ skill, evidence: `Explained ${s.names.join(", ")}` }));
  const weaknesses = [...bySkill.entries()]
    .filter(([skill, s]) => s.total > 0 && s.covered / s.total < 0.5 && !(starRelevant && skill === "communication"))
    .map(([skill, s]) => ({
      skill,
      severity: s.covered / s.total < 0.25 ? ("high" as const) : ("medium" as const),
      evidence: `Did not address: ${s.missed.join(", ")}`,
    }));
  if (missingStar.length > 0) {
    weaknesses.push({
      skill: "communication",
      severity: "medium",
      evidence: `Answer lacked a clear ${missingStar.map((p) => p.name).join(", ")}`,
    });
  }

  const dim = (base: number) => ({
    score: round2(Math.min(1, Math.max(0, base))),
    rationale: "deterministic mock evaluation",
  });
  return {
    summary: `Covered ${covered.length} of ${concepts.length} expected concepts (${Math.round(overallCoverage * 100)}%).`,
    dimensions: {
      correctness: dim(0.3 + 0.6 * overallCoverage),
      technicalDepth: dim(0.2 + 0.7 * overallCoverage),
      reasoning: dim(0.25 + 0.5 * overallCoverage + Math.min(0.15, sentences * 0.03)),
      structure: dim(Math.min(0.9, 0.3 + sentences * 0.1)),
      communication: dim(Math.min(0.9, 0.3 + words / 120)),
      evidence: dim(0.2 + 0.6 * overallCoverage),
      roleRelevance: dim(0.4 + 0.4 * overallCoverage),
    },
    strengths,
    weaknesses,
    scores,
    missingConcepts: [
      ...missing.map((c) => c.concept),
      ...missingStar.map((p) => `STAR ${p.name}`),
    ],
    star,
    betterApproach:
      missing.length === 0
        ? "The answer covered the expected ground."
        : `A stronger answer would cover: ${missing.map((c) => c.concept).join(", ")}.`,
    followUpTopics: missing.map((c) => c.concept),
  };
}
