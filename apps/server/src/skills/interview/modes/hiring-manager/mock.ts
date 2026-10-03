import {
  CONCEPT,
  coverageOf,
  keywordsHit,
  pickQuestion,
  round2,
  STAR_PARTS,
  type ConceptTemplate,
  type ExpectedConcept,
} from "../mock-shared.js";

const HM_TEMPLATES: ConceptTemplate[] = [
  {
    text: "Tell me about the most impactful project you've owned end-to-end — what was the scope and the measurable outcome?",
    topic: "Scope and impact",
    subSkills: ["hiring-manager.scope-impact"],
    expectedConcepts: [
      CONCEPT("Scope described", "hiring-manager.scope-impact", ["scope", "team", "owned", "led"]),
      CONCEPT("Measurable impact", "hiring-manager.scope-impact", ["%", "users", "reduced", "increased", "result"]),
    ],
    difficulty: "medium",
  },
  {
    text: "Tell me about a time you had to cut scope or deprioritize work you believed in — how did you decide?",
    topic: "Prioritization trade-off",
    subSkills: ["hiring-manager.prioritization"],
    expectedConcepts: [
      CONCEPT("Trade-off explicit", "hiring-manager.prioritization", ["trade-off", "depriorit", "cut", "chose"]),
      CONCEPT("Decision rationale", "hiring-manager.prioritization", ["because", "rationale", "impact", "risk"]),
    ],
    difficulty: "medium",
  },
  {
    text: "Tell me about a time you had to lead people through significant ambiguity or a change of direction.",
    topic: "Leading through ambiguity",
    subSkills: ["hiring-manager.leadership-style", "behavioral.leadership"],
    expectedConcepts: [
      CONCEPT("Ambiguous context", "hiring-manager.leadership-style", ["ambigu", "unclear", "change", "pivot"]),
      CONCEPT("Leadership action", "behavioral.leadership", ["i led", "i organized", "i decided", "i aligned"]),
    ],
    difficulty: "hard",
  },
  {
    text: "Why this team? What about this role matches where you want to go next?",
    topic: "Why this team",
    subSkills: ["hiring-manager.role-fit"],
    expectedConcepts: [
      CONCEPT("Specific motivation", "hiring-manager.role-fit", ["because", "excited", "want to", "interested"]),
      CONCEPT("Career direction", "hiring-manager.role-fit", ["grow", "learn", "goal", "next"]),
    ],
    difficulty: "easy",
  },
];

const HM_TABLE = {
  "hiring-manager": HM_TEMPLATES,
  "hiring-manager.role-fit": HM_TEMPLATES,
  "hiring-manager.scope-impact": HM_TEMPLATES,
  "hiring-manager.prioritization": HM_TEMPLATES,
  "hiring-manager.leadership-style": HM_TEMPLATES,
  "behavioral.leadership": HM_TEMPLATES,
  communication: HM_TEMPLATES,
};

export function hiringManagerInterviewerMock(input: unknown): unknown {
  const { skillId, label, previousQuestions, followUp } = input as {
    skillId: string;
    label: string;
    previousQuestions: string[];
    followUp?: { parentQuestion: string; focus: string } | null;
  };
  if (followUp) {
    return {
      question: `Let's go deeper on ${followUp.focus}: tell me more — what was your specific role and reasoning?`,
      topic: `Follow-up: ${followUp.focus}`,
      skillId,
      subSkills: [],
      expectedConcepts: [CONCEPT(followUp.focus, skillId, followUp.focus.split(" "))],
      difficulty: "medium",
      problem: null,
      focusDimension: null,
    };
  }
  const picked = pickQuestion(HM_TABLE, skillId, label, previousQuestions);
  return {
    question: picked.renderedText,
    topic: picked.topic,
    skillId,
    subSkills: picked.subSkills,
    expectedConcepts: picked.expectedConcepts,
    difficulty: picked.difficulty,
    problem: null,
    focusDimension: null,
  };
}

const HM_DIM_KEYWORDS: Record<string, string[]> = {
  roleFit: ["role", "team", "excited", "fit", "match", "want to"],
  scopeImpact: ["scope", "impact", "users", "%", "led", "owned", "result"],
  prioritization: ["priorit", "trade-off", "depriorit", "chose", "cut", "roadmap"],
  leadership: ["led", "influence", "aligned", "decided", "mentor", "ambigu"],
  collaboration: ["stakeholder", "partner", "conflict", "team", "cross-functional", "aligned"],
  motivation: ["because", "excited", "want to", "passionate", "goal", "grow", "learn"],
};

const HM_LABELS: Record<string, string> = {
  roleFit: "Role fit",
  scopeImpact: "Scope & impact",
  prioritization: "Prioritization",
  leadership: "Leadership",
  collaboration: "Collaboration",
  motivation: "Motivation",
};

export function hiringManagerEvaluatorMock(input: unknown): unknown {
  const { question, answer } = input as {
    question: { text: string; skillId: string; expectedConcepts?: ExpectedConcept[] };
    answer: string;
  };
  const concepts = question.expectedConcepts ?? [];
  const { ratio } = coverageOf(concepts, answer);
  const words = answer.trim().split(/\s+/).filter(Boolean).length;
  const score = (v: number) => round2(Math.min(1, Math.max(0, v)));

  const rubric = Object.entries(HM_DIM_KEYWORDS).map(([id, kws]) => {
    const hits = keywordsHit(answer, kws);
    return {
      id,
      label: HM_LABELS[id]!,
      score: score(hits === 0 ? 0.2 : 0.4 + 0.15 * hits),
      rationale: hits === 0 ? "Not evidenced in the answer." : `${hits} relevant term(s).`,
    };
  });

  const isNarrative = STAR_PARTS[0]!.re.test(answer) || STAR_PARTS[2]!.re.test(answer);
  const star = isNarrative
    ? {
        situation: STAR_PARTS[0]!.re.test(answer),
        task: STAR_PARTS[1]!.re.test(answer),
        action: STAR_PARTS[2]!.re.test(answer),
        result: STAR_PARTS[3]!.re.test(answer),
        notes: "STAR parts detected by deterministic heuristics.",
      }
    : null;

  return {
    summary: `Hiring-manager answer evaluated; ${coverageOf(concepts, answer).covered.length}/${concepts.length} expected signals covered.`,
    dimensions: {
      correctness: { score: score(0.3 + 0.5 * ratio), rationale: "deterministic mock evaluation" },
      technicalDepth: { score: score(0.2 + 0.6 * ratio), rationale: "deterministic mock evaluation" },
      reasoning: { score: score(0.25 + 0.5 * ratio), rationale: "deterministic mock evaluation" },
      structure: { score: score(Math.min(0.9, 0.3 + words / 200)), rationale: "deterministic mock evaluation" },
      communication: { score: score(Math.min(0.9, 0.3 + words / 120)), rationale: "deterministic mock evaluation" },
      evidence: { score: score(0.2 + 0.6 * ratio), rationale: "deterministic mock evaluation" },
      roleRelevance: { score: rubric.find((r) => r.id === "roleFit")!.score, rationale: "deterministic mock evaluation" },
    },
    strengths: [],
    weaknesses:
      star && !star.result
        ? [{ skill: "communication", severity: "medium" as const, evidence: "Answer lacked a clear Result" }]
        : [],
    scores: [
      { skill: question.skillId, score: score(0.15 + 0.8 * ratio), confidence: 0.7 },
      { skill: "communication", score: rubric[5]!.score, confidence: 0.7 },
    ],
    missingConcepts: coverageOf(concepts, answer).missing.map((c) => c.concept),
    star,
    rubric,
    designUpdates: null,
    betterApproach: "Be more specific about scope, impact, and your personal rationale.",
    followUpTopics: rubric.filter((r) => r.score < 0.4).map((r) => r.id),
  };
}
