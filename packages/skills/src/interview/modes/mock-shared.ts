import type { SkillId } from "@interview-os/core";
import { taxonomy } from "@interview-os/core";

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** §8.4 STAR detection heuristics reused by the behavioral/hr mode mocks. */
export const STAR_PARTS: Array<{
  name: string;
  key: "situation" | "task" | "action" | "result";
  re: RegExp;
}> = [
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

export interface ExpectedConcept {
  concept: string;
  skillId: string;
  keywords?: string[];
}

export interface ConceptTemplate {
  text: string;
  topic: string;
  subSkills: string[];
  expectedConcepts: ExpectedConcept[];
  difficulty: "easy" | "medium" | "hard";
}

export const CONCEPT = (concept: string, skillId: string, keywords: string[]) => ({
  concept,
  skillId,
  keywords,
});

export function conceptCovered(concept: ExpectedConcept, answer: string): boolean {
  const keys = concept.keywords?.length ? concept.keywords : [concept.concept];
  const lower = answer.toLowerCase();
  return keys.some((k) => lower.includes(k.toLowerCase()));
}

export interface Coverage {
  covered: ExpectedConcept[];
  missing: ExpectedConcept[];
  ratio: number;
}

export function coverageOf(concepts: ExpectedConcept[], answer: string): Coverage {
  const covered = concepts.filter((c) => conceptCovered(c, answer));
  const missing = concepts.filter((c) => !conceptCovered(c, answer));
  return {
    covered,
    missing,
    ratio: concepts.length === 0 ? 0.5 : covered.length / concepts.length,
  };
}

export function keywordsHit(answer: string, keywords: string[]): number {
  const lower = answer.toLowerCase();
  return keywords.filter((k) => lower.includes(k.toLowerCase())).length;
}

/** Well-formed generic prompts when a skill has no dedicated template. */
export const GENERIC_PROMPTS: ((label: string) => string)[] = [
  (l) =>
    `Walk me through a real project where you applied ${l}. What trade-offs did you make?`,
  (l) =>
    `Tell me about a time ${l} mattered in your work — what was hard about it?`,
  (l) =>
    `Looking back at your experience with ${l}, what would you do differently today?`,
];

/**
 * Pick the first unasked template for a skill (falling back to the skill's
 * parent or generic prompts), adding a "(variant N)" suffix when exhausted.
 */
export function pickQuestion(
  templates: Record<string, ConceptTemplate[]>,
  skillId: string,
  label: string,
  previousQuestions: string[],
  genericPrompts: ((label: string) => string)[] = GENERIC_PROMPTS,
): ConceptTemplate & { renderedText: string } {
  const asked = new Set(previousQuestions);
  const options =
    templates[skillId] ??
    templates[taxonomy.parentOf(skillId as SkillId) ?? ""] ??
    genericPrompts.map((prompt) => ({
      text: prompt(label),
      topic: label,
      subSkills: [] as string[],
      expectedConcepts: (taxonomy.getNode(skillId as SkillId)?.keywords ?? [])
        .slice(0, 3)
        .map((k) => CONCEPT(k, skillId, [k.split(" ")[0]!])),
      difficulty: "medium" as const,
    }));

  const chosen = options.find((t) => !asked.has(t.text));
  const template = chosen ?? options[0]!;
  if (chosen) return { ...template, renderedText: template.text };
  let n = 2;
  while (asked.has(`${template.text} (variant ${n})`)) n++;
  return { ...template, renderedText: `${template.text} (variant ${n})` };
}

/** §9.1 mock follow-up: a deeper probe on the parent's focus, same skill. */
export function followUpMockOutput(
  skillId: string,
  focus: string,
  mode: "technical" | "behavioral" | "hr",
): unknown {
  const phrasing =
    mode === "behavioral"
      ? `Let's stay with that story — ${focus}: tell me more about that part.`
      : mode === "hr"
        ? `I'd like to dig into ${focus} a bit more — can you expand?`
        : `Let's go deeper on ${focus}: walk me through the specifics and the trade-offs.`;
  return {
    question: phrasing,
    topic: `Follow-up: ${focus}`,
    skillId,
    subSkills: [],
    expectedConcepts: [CONCEPT(focus, skillId, focus.split(" "))],
    difficulty: "medium",
    problem: null,
    focusDimension: null,
  };
}

/** Derive the {situation,task,action,result} STAR object used by mode evaluator mocks. */
export function starFrom(answer: string) {
  const [s, t, a, r] = STAR_PARTS;
  return {
    situation: s!.re.test(answer),
    task: t!.re.test(answer),
    action: a!.re.test(answer),
    result: r!.re.test(answer),
    notes: "",
  };
}
